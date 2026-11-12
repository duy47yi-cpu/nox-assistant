# Nox — Animation Timeline | Таймлайн анимаций

> Время видео ≠ время UI. Все длительности ниже — **целевые для реализации**, выведены из наблюдаемых кадров с поправкой на монтаж. Подтверждённые интервалы помечены **[В] подтверждено видео**, **[О] оценено по кадрам**, **[П] придумано для фронта**.  
> Источник: оригинальные MP4 `IMG_22660/39258/47650` (FFmpeg @10fps, `verify_frames/`), дополнено `detail/IMG_22660_009-013/` и Codex-кадрами. Верификация — `verification-2026-11-09.md`.

Общие токены:

```css
--ease-default: cubic-bezier(0.2,0,0,1);
--ease-out: cubic-bezier(0.16,1,0.3,1);
--ease-in-out: cubic-bezier(0.4,0,0.2,1);
--dur-fast: 120ms; --dur-normal: 200ms; --dur-slow: 280ms; --dur-sphere: 1800ms;
```

Прерывание: любой новый ввод → `cancel` текущего transition, старт нового от текущего значения (FLIP), не от начала.

---

## 1. Orb — Idle дыхание (постоянно)

| Фаза | Описание |
|------|----------|
| **Initial** | Сфера R=128, точки на местах, ядро alpha 0.18 |
| **Trigger** | `state === 'idle'` >1.2с без ввода/хода |
| **Sequence** | `deform = sin(y*3 + t*0.6)*0.06 + sin(x*4 - t*0.4)*0.03`, `core scale 1.0→1.06`, `rotation.y += 0.08 rad/s` |
| **Duration** | `1800ms` цикл [Р], затухание нет, loops infinite |
| **Easing** | `ease-in-out (sine)` — в коде `Math.sin` |
| **Final** | Возврат к исходной форме, seamless loop |
| **Interrupt** | При `focus/keydown` → переход в attentive за 300ms ease-out |

**Видео-доказательство:** `05-sphere-9-11s.jpg` 9.6→12.8с центр стоит, контур меняется [В]; период не установлен — берём 1.8с как спокойный.

---

## 2. Orb — Belt pulse (глубокий вдох)

| Фаза | Описание |
|------|----------|
| Initial | Без пояса |
| Trigger | Таймер каждые 7с в idle, не во время thinking |
| Sequence | `belt opacity 0→0.9 (120ms) → hold 360ms → 0 (300ms)`, y=-0.6*R, width 0.12*R, color #E0F4FF |
| Duration | `780ms` total [Р] |
| Easing | `ease-out` in, `ease-in` out |
| Interrupt | При любом действии — fade out 120ms |

В референсе belt виден 9.0–9.5с как светлый обод [В], затем исчезает.

---

## 3. Composer — Focus

| | |
|---|---|
| Initial | `border #2A2A2E`, bg #1C1C1F |
| Trigger | `textarea focus` |
| Sequence | `border → accent #2E9AC1 1px`, `shadow focus-ring 0 0 0 2px bg + 0 0 0 4px accent/30%`, orb tilt 2° к composer |
| Duration | `200ms ease-out` [Р] |
| Final | Accent border держится пока focus |
| Interrupt | `blur` → reverse 120ms |

---

## 4. Composer — Typing (печать)

| | |
|---|---|
| Initial | Idle дыхание |
| Trigger | `keydown` (символ, не модификатор) |
| Sequence | `orb scale 1.0→1.02 (80ms) →1.0 (160ms)`, каждая 4-я буква — `deform +0.01` micro-pulse |
| Duration | `240ms` micro-bounce [Р] |
| Easing | `ease-out (0.16,1,0.3,1)` |
| Final | Возврат, не накапливать очередь при быстром наборе — только последний pulse |

Быстрый набор (>5 char/s) → orb слегка ускоряет дыхание `speed 0.7` вместо каждого pulse.

---

## 5. Attachment — появление карточки "Diplom...docx"

| | |
|---|---|
| Initial | Нет карточки, textarea 24px |
| Trigger | `drop file` или `click attach → file picker → select` |
| Sequence | `card height 0→56px clipPath, opacity 0→1`, `textarea shift down`, `border highlight accent 120ms` |
| Duration | `200ms ease-out` [Р] |
| Final | Карточка 56px, bg #232326, close btn visible |
| Interrupt | Повторный drop — заменить карточку cross-fade 120ms |

**Видео:** `04-attachment-original.png` + `detail/IMG_47650_002-010` 2.9–3.6с показывает наплыв диалога → карточка к 3.6с [В], но клик не виден — анимация наплыва монтажная, не копировать.

---

## 6. Send — отправка сообщения

| | |
|---|---|
| Initial | Composer с текстом (+ attachment), feed без нового пузыря |
| Trigger | `Enter` или `click send` (только если text.trim() или attachment) |
| Sequence | 1. `send btn scale 0.96 80ms` + `orb pulse scale 1.04 180ms` (собранный импульс) <br>2. `composer opacity 1→0.6 y+4px 120ms` (уход) <br>3. `user bubble in: y 8px→0, opacity 0→1, scale 0.98→1 200ms ease-out` <br>4. `composer reset: height→24px, clear text, opacity 0.6→1 160ms` 5. Через 220ms — `working row in` |
| Duration | Суммарно `~520ms` до working [Р] |
| Final | Bubble справа, composer пуст в focus, working строка видна |
| Interrupt | Повторный Enter игнор если уже `sending`, повтор через 400ms debounce |

**Видео:** `detail/IMG_47650 6.9→7.0с` — за 0.1с пузырь уже есть, промежуточные кадры пропущены [В], поэтому точная длительность не измерена — берём 200ms для пузыря.

---

## 7. Working — «Ход работы · Выполняется 10.4с»

| | |
|---|---|
| Initial | Только что отправленный user bubble |
| Trigger | `Agent.run` start, `runId` создан |
| Sequence | `row slideDown 8px + opacity 0→1 180ms`, `timer 0.1s tick: tabular-nums`, `orb state=thinking` (speed 1.0, brightness +0.2) |
| Duration | `∞` пока работает, tick `100ms` |
| Final | Строка остаётся до первого assistant chunk |
| Interrupt | `Esc` или `stop` → row → error 160ms (см. §10) |

---

## 8. Assistant streaming — поток ответа

| | |
|---|---|
| Initial | Working row видна |
| Trigger | Первый token от модели |
| Sequence | `working row fade 120ms`, `assistant block fade in 160ms`, `text revealed char-by-char (не typewriter — просто append, без каретки)`, `orb state=speaking` если TTS, иначе `thinking` → `idle` |
| Duration | `120ms` для блока, tokens as-is |
| Final | Full message, label "NOX" 11px uppercase |
| Interrupt | `stop` — оборвать append, показать `cancelled` label |

Не делать каретку `|` — в референсе её нет.

---

## 9. Waveform — голосовой ввод (в composer)

| | |
|---|---|
| Initial | Bars h 4px idle |
| Trigger | `mic active` |
| Sequence | `bars height = 4 + voiceLevel*12 * sin(t*6 + i*0.8)` — живая волна, 24 bars, gap 2px, color text-3 → accent when level>0.3 |
| Duration | `60ms` update (16fps достаточно), CSS `height 60ms linear` |
| Final | При `mic off` → heights →4px 120ms |
| Interrupt | — |

---

## 10. Error / Waiting approval

| State | Orb | UI | Duration |
|-------|-----|----|----------|
| `waiting_approval` | `speed 0.3, amber hue #F5A524, halo amber 14%, deform 0.03` | Banner `bg warn/14%, border warn/42%, h 36px, slideDown 160ms`, composer disabled | hold forever |
| `error` | `shake 1.5% 400ms →0, red #FF5C5C` | Banner err аналогично, orb red 800ms → idle | shake `400ms ease-out` [Р] |

Тряски как в старых дизайнах нет — только micro-shake 2px, быстро затухает.

---

## 11. History drawer (узкое окно)

| | |
|---|---|
| Initial | Скрыта (0px) |
| Trigger | `click history icon` или swipe |
| Sequence | `overlay scrim 0→0.48 160ms`, `panel x -100%→0 260ms ease-out (0.16,1,0.3,1)`, `chat/sphere dim` |
| Final | Panel 300px overlay, scrim clickable |
| Interrupt | `Esc` или `click scrim` → reverse 180ms |

---

## 12. Window controls hover

| | |
|---|---|
| Initial | Transparent |
| Trigger | `hover` 40ms delay |
| Sequence | `bg surface-hover 80ms`, icon text-3→text-1 |
| Close hover | `bg rgba(255,92,92,0.12) → #FF5C5C 120ms`, icon white |

---

## 13. Global reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  .orb-nox canvas { animation: none !important; }
}
html[data-motion="off"] .orb-nox { --sphere-speed: 0; --sphere-deform: 0; }
```

Смена состояния и цвета остаются, только движение →0.

---

## 14. Таймлайн сводная таблица (для разработчика)

| # | Событие | От | К | Длительность | Easing | Прерывание |
|---|---------|----|---|--------------|--------|------------|
| 1 | Idle breathe | 1.0 | 1.06 scale | 1800ms loop | sine | → attentive 300ms |
| 2 | Focus composer | 0 | accent border | 200ms | ease-out | blur 120ms |
| 3 | Key pulse | 1.0 | 1.02 →1.0 | 240ms | ease-out | debounce 4-й |
| 4 | Attachment in | 0h | 56h | 200ms | ease-out | cross-fade |
| 5 | Bubble in | 8px/0op | 0/1 | 200ms | ease-out | игнор дубля |
| 6 | Working in | -8px/0op | 0/1 | 180ms | ease-out | → error 160ms |
| 7 | Streaming block | 0op | 1 | 160ms | ease-default | stop → cancelled |
| 8 | Waveform bar | 4px | ~16px | 60ms | linear | — |
| 9 | Error shake | 0 | 2px→0 | 400ms | ease-out | auto 800ms→idle |
| 10| Drawer | -100% | 0 | 260ms | ease-out 0.16,1,0.3,1 | Esc 180ms |

Все timestamps — время UI, не видео. Если есть запись без монтажа — уточнить период дыхания и belt.

