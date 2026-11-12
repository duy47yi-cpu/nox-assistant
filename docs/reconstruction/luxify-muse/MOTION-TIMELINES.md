# Nox — Анимации и таймлайны (Phase R2)

Все длительности в мс, кривые — CSS `cubic-bezier`. Уважаем `prefers-reduced-motion: reduce` и `html[data-motion="off"]`.

## 1. Токены движения

| Токен | Длительность | Кривая | Назначение | Происхождение |
|---|---|---|---|---|
| `--dur-fast` | 120 | ease-default 0.2,0,0,1 | hover, focus, mic | [В] Nox |
| `--dur-normal` | 200 | ease-out 0.16,1,0.3,1 | `nox-rise`, смена состояния сферы, смена раздела | [В] Nox, Luxify 170–270 [О] |
| `--dur-slow` | 280 | ease-out 0.16,1,0.3,1 | модалки, approval, цвет | [В] Nox, Luxify approval 170 [О] |
| `orb-breath` | 2100 | ease-in-out | дыхание idle | [О] Luxify 2.1s |

## 2. Сфера

| Переход | Длительность | Кривая | Что происходит |
|---|---|---|---|
| idle дыхание | 2100 loop | ease-in-out | R 100% →102%→100%→98%→100%, ядро lag 150ms [П] |
| idle → listening | 120 | linear | bright 1.0→1.1, рябь вкл |
| listening voice ripple | 1 frame (16ms) | — | deform += voice*2% |
| thinking пульс | 900 loop | ease-in-out | R ±8%, bright 1.35, halo 22% |
| speaking voice | 16ms | — | deform = voice*6%, belt 0.45 |
| waiting | 2400 loop | ease-in-out | R ±3%, янтарь, spin 0.02 |
| success вспышка | 220 | ease-out | bright 1.2→1.0, scale 1.04→1.0, ok |
| error дрожь | 400 | ease-out expo | shake 1.5%→0, err, затем статика |
| Цвет accent→warn | 280 | linear | палитра lerp |
| Любой переход состояния | 280 | ease-out | MIX_KEYS lerp 280ms, phase не сбрасывается [П] |

Фоновая пауза: `document.hidden` или canvas вне экрана — rAF стоп [В orb-nox.js].

## 3. Навигация и смена разделов

| Элемент | Длительность | Кривая | Детали |
|---|---|---|---|
| Рейка активная черта | 200 | ease-out | left -9px, height 4×22, accent |
| Смена раздела (чат↔команды↔настройки) | 200 | ease-out | старый `opacity 1→0` 80ms + новый `opacity 0→1` + `translateY(6→0)` 200ms — как `viewIn` 320ms, но мягче Luxify мгновенно [В] M02 |
| История → новая строка чата | 200 | ease-out | `nox-rise` opacity 0 + translateY 8→0 |
| Пустое → лента | 200 | ease-out | cross-fade, без сдвига |

Опция «мгновенно как Luxify V08» — `prefers-reduced-motion: reduce` уже даёт 0.01ms.

## 4. Карточка агента и плашки

| Элемент | Длительность | Кривая | Детали |
|---|---|---|---|
| Появление карточки агента | 200 | ease-out | `nox-rise` |
| Смена action текста | 120 | ease-out | cross-fade |
| Approval раскрытие | 170 | ease-out | height 80→200, opacity 0→1 — как Luxify M08 [О] 100+70=170 |
| Approval → Done | 200 | ease-out | точка синяя→зелёная 120ms + текст «✓ Готово» fade 200ms — Luxify M09 [О] |
| Плашка шага в чате | 200 | ease-out | `nox-rise` по центру |
| Кнопка Стоп → idle | 120 | ease-default | shake стоп |

## 5. Модалки и меню

| Элемент | Длительность | Кривая | Детали |
|---|---|---|---|
| Scrim затемнение | 240 | ease | #00000066 → opacity 1 |
| Dialog панель | 240 | ease-out | opacity 0→1 + translateY 10→0 + scale 0.97→1 — как `dialogRise` [В] |
| Контекстное меню | 67 | ease-out | opacity 0→1 — как Luxify M05 [О] 4 кадра |
| Дерево раскрыть | 33 | — | вставка строк, без раздвижения — Luxify M06 [О] ≤33ms |
| Палитра предпросмотр | 0 | — | мгновенно в том же кадре — Luxify M07 [В] |

## 6. Поле ввода и голосовая волна

| Элемент | Длительность | Кривая | Детали |
|---|---|---|---|
| Focus капсулы | 200 | ease-out | border accent + двойной outline 30% |
| Voice волна столбики | 900 loop alternate | ease-in-out | height 4→16px, accent vs #3A3A3E |
| Живой текст ввод | 16ms per char | — | append, как распознавание [О] 5–9 зн/с |
| Mic красный | 120 | ease-out | border err 52% + bg 14% |

## 7. Настройки и команды

| Элемент | Длительность | Кривая | Детали |
|---|---|---|---|
| Поиск фильтр | 120 | ease-out | список cross-fade |
| Переключатель | 120 | ease-default | thumb translate, bg accent |
| Ползунок ручка | 0 (drag) | — | мгновенно |
| Цвет HEX → сфера | 0 | — | мгновенно [В] M07, затем 280ms lerp для мягкости [П] |
| Toast «Сохранено» | 180 in / 180 out + 3000 hold | ease-out | `toastIn` |

## 8. График дыхание сферы (текстом)

```
idle (2.1s):
R% 102 ┤   ╭───╮
     101 ┤  ╱   ╲
     100 ┤─╱     ╲─────╲     ╱─
      99 ┤             ╲   ╱
      98 ┤              ╰─╯
          0    0.5   1.0   1.5  2.1s
              вдох      выдох

Ядро (lag 0.15s): та же кривая, сдвиг вправо 0.15s — волна внутрь [П] (Luxify 0.33s/кольцо [О])
```

## 9. Запреты

- Не копируем монтаж Luxify: наезды, наплывы, подсветка курсора белым кругом (M30) — это запись экрана, не анимация [В].
- Не делаем «барабаны» счётчиков — монтаж [В] M28.
- Не анимируем смену темы склейкой — тема меняется мгновенно, как Luxify цвет [В] M07.

## 10. Производительность

- Сфера — 1 rAF, не чаще 60fps, пауза в фоне — уже [В].
- Панели — только transform/opacity, не layout.
- Частицы/волны фона — только если тема liquid/starry — уже с паузой при reduce.
