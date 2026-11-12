# Движение Nox — анимации и переходы

> В референсе монтаж искажает длительности [О]; здесь зафиксирован **единый язык движения** для всех новых разделов, совместимый с уже реализованной сферой (`orb-nox.js` 180 FPS) и `presence.css` motion. Маркеры [В]/[О]/[П].

---

## 1. Токены движения

```css
--ease-default: cubic-bezier(0.2, 0, 0, 1);     /* стандарт входа/цвета */ [П]
--ease-out:     cubic-bezier(0.16, 1, 0.3, 1);  /* появление панелей/диалогов */ [П]
--ease-in-out:  cubic-bezier(0.4, 0, 0.2, 1);  /* сфера дыхание */ [П]
--ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1); /* не использовать — без пружин */ [П запрет]

--dur-fast:   120ms;  /* hover, цвет, pill */ [П]
--dur-normal: 200ms;  /* открытие панели, диалог, select */ [П]
--dur-slow:   280ms;  /* большой переход, expansion */ [П]
--dur-sphere: 1800ms; /* дыхание idle — orb-spec */ [О]
```

- Все интерактивные переходы `dur-fast 120ms`; появления `dur-normal 200ms` + `ease-out` [П].
- Никаких `spring`/`bounce` — плавно, непрерывно, как в сферах 9–12с референса [О].

---

## 2. Правила уважения движения

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
html[data-motion="off"] #sphereCanvas { animation: none !important; } /* Настройки → Вид → Анимация шара */
```

- `prefers-reduced-motion` — все длительности → 0, оставить только `opacity` fade [П].
- `html[data-motion="off"]` — статичная сфера + контур, но цветовые переходы остаются [П по DESIGN.md].
- Сфера паузит когда `document.hidden` или out-of-viewport (`orb-nox.js` уже делает) [В].

---

## 3. Hover / Focus — микро-анимации

| Элемент | Свойство | Из → В | Dur/Ease |
|---------|----------|--------|----------|
| Button | bg, color, border, y | `surface-3 → surface-hover`, `y 0 → -1px` (primary only) | 120 ease-default |
| Row/Card | bg, border | `surface → surface-hover`, `border → border-strong` | 120 ease-default |
| Icon | color | `text-3 → text-1` | 120 ease-default |
| Pill/Chip active | bg, border | `surface-3 → accent-soft`, `border → accent/24` | 120 ease-default |
| Input focus | border, shadow | `border → accent + focus-ring` | 120 ease-default |
| Switch thumb | x, bg | `0 → 12px`, `text-2 → white` | thumb 200 ease-out, track 120 |
| Disclosure | rotate, height | `▾ 0→180deg`, `height 0→auto` | 200 ease-out |

- Не анимировать `width/height` кроме disclosure/slider; использовать `transform` и `opacity` где возможно [П].

---

## 4. Появления

### 4.1 Панели и списки

```
rise:  from { opacity:0, transform: translateY(8px) } to { opacity:1, y 0 }  200ms ease-out  [П]
stagger: each row +30ms delay (max 6 rows) — feed, commands list, journal rows  [П]
```

- Применяется к: появлению секции при навигации, expansion шагов, diff rows импорта, popular cards [П].

### 4.2 Dialog

```
Overlay fade: opacity 0→1  120ms ease-default
Dialog rise:  opacity 0→1 + y 8→0 + scale 0.98→1  200ms ease-out
  Header+Footer fixed, body scroll — не анимировать body scroll
Dismiss: reverse 120ms ease-default
```

- Escape/× — тот же reverse; фокус возврат к триггеру 0ms [П].

### 4.3 Drawer (узкое окно history/nav)

```
Slide: x -100% → 0  200ms ease-out  +  Backdrop fade 120ms
```

### 4.4 Disclosure / Expand

```
Chevron: rotate 0→180 200ms ease-default
Content: grid-row 0fr→1fr  (height auto via grid) 200ms ease-out  + fade 120ms
```

---

## 5. Переходы между разделами

```
View switch (rail click / Ctrl+1..5):
  Old content fade-out 80ms ease-default
  New content rise 200ms ease-out  (перекрытие 40ms — cross-fade, не белый flash)
  Left bar slide: 4×22 pill y 0→target 200ms ease-out
  No page reload, scrollTop сохранён, focus на заголовке раздела
```

- Search/filter — немедленно, debounce 150ms, без анимации списка кроме stagger новых rows [П].
- Table → Card на breakpoint — без анимации, immediate layout shift (анимировать ломает скролл) [П].

---

## 6. Специальные движения

### 6.1 Steps в редакторе

```
Add step:  card rise 200 ease-out + highlight border accent 400ms → fade to border
Reorder (↑↓):  cards move y via FLIP 200 ease-out (transform, не layout) — если DnD, иначе swap без анимации
Remove:  card scale 1→0.98 + opacity 1→0 120ms, соседние сдвиг 200 ease-out
```

### 6.2 Recording

```
Panel slideDown 200 ease-out
Steps stagger 40ms each new captured tool
Pulse на "● Запись" 800ms ease-in-out infinite alternate opacity 1→0.6 (только idle indicator, не весь UI)
```

### 6.3 Import summary chips

```
Chips fade 120ms ease-default + rows stagger 30ms
Conflict shake: x ±2px 300ms ease-default 2 cycles — только при попытке импорта с конфликтом, не при открытии
```

### 6.4 Approval timer

```
Timer bar progress linear 1s steps (width 100%→0 over remaining seconds)
Value tabular-nums, no jitter
Dialog появлением не требует действия — focus сразу на [Разрешить]
```

### 6.5 Toast / Confirmation

```
Toast  rise 200 ease-out  stay 3000ms  fade 120ms  (если используется)
Inline confirm pill: fade 120 + scale 0.96→1 200 ease-out
```

---

## 7. Сфера — интеграция с разделами [О+П]

- Состояния сферы (`idle, attentive, listening, thinking, speaking, waiting_approval, error, success`) — как в `orb-spec.md` §5; настройки через `orb-nox.js` state machine [П].
- При открытии диалога подтверждения: сфера `thinking → waiting_approval` янтарный `hue+32°` 400ms [П].
- При ошибке хода: сфера `error` красный 400ms shake 1.5% → затухание — без тряски UI [П].
- `data-motion="off"` — сфера статична, но pill timer и dialog всё ещё анимируются (кольцо шагов — нет) [П].

---

## 8. Тайминги сводкой

| Контекст | Dur | Ease | Откуда |
|----------|-----|------|--------|
| Hover цвет/border | 120 | ease-default | design-system |
| Focus ring | 120 | ease-default | — |
| Panel rise / dialog | 200 | ease-out | motion-spec |
| Expansion / disclosure | 200 | ease-out | — |
| Drawer slide | 200 | ease-out | — |
| View switch | 200 | ease-out | — |
| Spinner | 600 | linear | — |
| Sphere breath | 1800 | ease-in-out | orb-spec |
| Reduced | 0 | — | — |

---

## 9. Чек-лист приёмки движения

- [ ] Все hover 120 ease-default, панели 200 ease-out, без spring/bounce.
- [ ] Dialog overlay 120 fade + rise 200, dismiss reverse 120.
- [ ] View switch 200 rise + left bar slide, no flash.
- [ ] Reduced-motion: панели без translate, только fade; сфера статична.
- [ ] Drawer slide 200 + backdrop 120; approval timer linear 1s ticks.
