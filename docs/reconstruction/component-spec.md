# Nox — Component Spec | Спецификация главного экрана

> Источник: `muse/00-geometry-annotated.png` + `01-chat-full.png` (IMG_22660 12с, 1092×576) и `03-empty-original.png` (пустой чат, 1604×1080). Верификация по оригинальным MP4 — `verification-2026-11-09.md` (IMG_22660 50 кадров @10fps, IMG_39258/47650).  
> Координаты — внутри окна 864×520 (A). Центр сферы (826,294) = 83.3% W / 50.8% H [В].  
> Окно Electron эталон: **1200×720**, минимум **960×640** [О]. Классификация: [В]/[О]/[П].

---

## 0. Иерархия экрана (слева → справа)

```
Window 12px radius, bg #0F0F10
└─ .app (flex row, gap 8px, pad 8px)
   ├─ [A] Rail 52px — узкая вертикаль
   ├─ [B] History 244px — список чатов
   ├─ [C] Chat 1fr — сообщения + composer
   └─ [D] Sphere 360px — сцена с орбом
```

Никаких дополнительных панелей, сайдбаров, карточек «Сегодня/Виджеты/Новости» — в референсе их нет. Всё, что в `presence.css` скрыто `.scene-today {display:none}` — **не возвращать**.

### Зоны видимости

| Состояние | Rail | History | Chat | Sphere |
|-----------|------|---------|------|--------|
| Пустой чат (`03-empty-original`) | ✓ | ✗ скрыта | ✓ приветствие | ✓ |
| Чат с историей (`01-chat-full`) | ✓ | ✓ 244px | ✓ | ✓ |
| Узкое окно <1000px | ✓ | overlay drawer (см. §5) | ✓ full | ✗ скрыта → вкладка «Сцена» |
| Focus composer | ✓ | ✓ dim 60% | ✓ highlight | ✓ dim 40% |

---

## 1. Window (A — внешняя оболочка)

| Параметр | Значение | Статус |
|----------|----------|--------|
| Внешний размер (эталон) | `1200×720` | [П] |
| Внутренняя область (content) | `1184×704` после `pad 8px` | [И] 864×520 в видео — кроп, не CSS |
| Background | `var(--nox-bg) #0F0F10`, без зерна, без `::before` пятна | [И] |
| Border | `1px solid color-mix(in srgb, var(--border) 60%, transparent)` на `BrowserWindow` с `frame:false, transparent:true` + CSS `border` | [П] |
| Radius | `12px` (`--r-window`) — `win.setBackgroundColor('#00000000')` + `.app {border-radius:12px; overflow:clip}` | [И] |
| Shadow | `none` в CSS, нативный `hasShadow:true` у Electron | [О] |
| TitleBar | `hiddenInset` macOS / `frame:false` Windows — кастомные контролы в D | [П] |

```js
// main.js — BrowserWindow
new BrowserWindow({
  width: 1200, height: 720, minWidth: 960, minHeight: 640,
  backgroundColor: '#00000000', transparent: true, frame: false,
  hasShadow: true, vibrancy: undefined, // никакого blur
})
```

---

## 2. Rail — узкая рейка слева (часть B, ~5.3%)

```
Width: 52px, padding 8px 6px
Bg: transparent (на фоне --nox-bg, не панель)
Border-right: 1px solid var(--border) — [О] в видео тонкая линия между A/B
```

**Структура (сверху вниз, gap 4px):**

| Элемент | Размер | Состояние | Иконка (outline 1.5px, 18px) |
|---------|--------|-----------|------------------------------|
| Logo/ Orb mini | 36×36, r 10px, border `1px solid var(--border)` | static | кольцо `○` 18px, `text-1` |
| Home | 36×36, r 10px | `active` — `bg: accent-soft`, `icon: accent`, `left-bar 4px` | `house` |
| Close/Clear | 36×36 | default `text-3` → hover `text-1` + `surface-hover` | `x` |
| Settings | 36×36 | — | `gear` |
| History toggle | 36×36 | active when history open | `clock-arrow` |
| Spacer | flex 1 | — | — |
| Avatar | 32×32, r 50%, border 1px solid border | — | `person` filled 14px |

Активный индикатор: `::before { 4px ×22px, r 0 3px 3px 0, bg var(--accent), left -6px }` [П по DESIGN.md].

```css
.rail { width: var(--rail-w); display:flex; flex-direction:column; gap:4px; padding:8px 6px; border-right:1px solid var(--border); }
.rail-btn { width:36px; height:36px; border-radius:10px; display:grid; place-items:center; color:var(--text-3); }
.rail-btn:hover { background:var(--surface-hover); color:var(--text); }
.rail-btn[aria-current="page"] { background:var(--accent-soft); color:var(--accent); }
```

---

## 3. History — панель B (244px)

| Параметр | Значение | Статус |
|----------|----------|--------|
| Width | `244px` (flex none) | [И] 20.4% ×864 ≈176px в видео → 244px для 1200px |
| Bg | `var(--surface) #18181B` | [И] |
| Border | `1px solid var(--border)` | [И] |
| Radius | `16px` | [И] |
| Padding | `16px 12px` | [О] |
| Gap между секциями | `12px` | [О] |

**Header:**

```
padding 4px 4px 12px
Title "История" — 16px / 600 / text-1, height 20px
Btn "+ Новый чат" — pill: h 32px, pad 12px, bg surface-3, border, text 12.5px/500/text-2, icon + 12px, hover text-1
```

**Секции:**

```
Section label "Сегодня"/"Ранее" — 11px / 500 / 0.02em / text-3 / uppercase, pad 8px 8px 4px
Item row: h 36px, pad 8px, r 10px, gap 8px
  Title — 13px / 400 / text-1, truncate ellipsis 1 line
  "..." — 14px / text-3, w 20px, hover text-1
  Active: bg surface-hover, text-1
  Hover: bg color-mix(text 6%, surface)
Divider между секциями: 1px solid border-subtle, margin 8px 0
```

`overflow-y: auto`, scrollbar `thin`, `scrollbar-color: text-3 transparent`, скрыть до hover.

---

## 4. Chat — центральная колонка C (1fr ~520px)

| Параметр | Значение | Статус |
|----------|----------|--------|
| Flex | `1 1 520px`, min 320px | [И] 35.8% |
| Bg | `var(--surface) #18181B` | [И] |
| Border | `1px solid var(--border)` | [И] |
| Radius | `16px` | [И] |
| Padding | `0` (header 16px, feed 16px 20px, composer 12px) | [О] |
| Gap | `8px` между зонами | |

### 4.1 Chat header (внутри C)

Только для режима thread — в пустом состоянии заголовка нет, центр — приветствие. Для чата с сообщениями заголовок — это сам feed, без отдельной шапки.

### 4.2 Empty state (03-empty-original)

```
Container: flex 1, center, gap 16px, pad 40px
Title "С чего начнём?" — 22px / 600 / text-1 / -0.02em, centered
Subtitle нет — минимализм, никаких подсказок-чипов под заголовком
Composer прижат к низу (см. 4.4)
```

Не добавлять сетку промптов/ карточек как в ChatGPT — в референсе их нет.

### 4.3 Feed — лента сообщений

```
feed: flex column, gap 20px, pad 16px 20px, overflow-y auto, scroll-behavior smooth
```

**User bubble (справа):**

```
align-self: flex-end, max-width 72%
bg: var(--surface-4) #232326 — [И] серый пузырь "что это за модель", не акцент
border: 1px solid var(--border) — [О]
radius: 16px 16px 4px 16px — [О] скругление с хвостиком
pad: 10px 14px, text 13.5px / 18px / text-1
```

**Assistant message (слева, без пузыря):**

```
max-width: 92%, pad 0, text 13.5px / 20px / text-1
Label "JARVIS" / "NOX": 11px / 600 / 0.04em / text-3 / uppercase, margin 0 0 6px, letter-spacing 0.04em
Paragraph: margin 0 0 8px, color text-1
Inline action "↘" — 16px icon btn, border 1px, r 6px, text-3 → hover text-1 — [О] в кадре иконка под сообщением
```

**Working row "Ход работы · Выполняется 10.4с":**

```
flex row, gap 8px, align center, h 20px, text 12px / text-2
Icon "▸" 10px / text-3, value 12px tabular-nums
Background: none, border none — просто строка, не карточка
```

### 4.4 Composer F — нижний блок ввода (76px)

```
Wrap: bg surface-3 #1C1C1F, border 1px solid border, radius 16px, pad 10px 12px
Layout: grid rows: attachment? / input / toolbar
```

| Подзон | Высота | Содержимое |
|--------|--------|------------|
| Attachment card (если есть) | `56px` | См. §4.5 |
| Textarea | `auto 120px max`, `min-height 24px` | `placeholder "введите текст..." 13px/text-3`, text 13.5px/text-1, resize none, border none, bg transparent |
| Toolbar | `32px` | `left: [attach 20px, mode 20px] — center: mode pill — right: [mic 28px, send 28px]` |

**Toolbar детали:**

- `Attach` — icon `paperclip` 18px, w 28px, text-3 → hover text-1, r 8px
- `Mode icon` — `spark` 16px, w 28px, r 8px, bg transparent, border 1px solid border
- `Select "Гибрид"` — pill r 999px, h 28px, pad 10px, bg surface-4, border, text 12px/500/text-2, chevron 12px
- `Mic` — circle 28px, bg surface-4, border, icon `mic-off` 16px/text-2 → `mic` accent when active
- `Send` — circle 28px, bg accent #2E9AC1, icon `arrow-up` 16px/white, hover accent-hover, disabled `text-ghost` bg `surface-3`

**Waveform (внутри composer, над toolbar, когда voice):**

```
h 24px, flex row gap 2px, align center
Bars: w 2px, r 1px, bg text-3 → accent when active, heights 4–16px
Animated only when recording — см. animation-timeline
```

---

## 5. Attachment Card (внутри composer)

```
h 56px, bg surface-4, border 1px solid border, r 12px, pad 8px 12px, flex row gap 12px
Icon box: 40×40, r 8px, bg surface-3, border, icon "DOCX" 10px/600/text-2 centered
Filename: 13px/500/text-1 truncate, subline 11px/text-3 "…"
Close: 20×20 r 50%, icon x 12px, hover bg surface-hover, color text-1
```

Появляется над textarea, c анимацией `slideDown 200ms ease-out`.

---

## 6. Sphere Panel D — 360px

| Параметр | Значение | Статус |
|----------|----------|--------|
| Width | `360px` flex none | [И] 32.2% ×864≈278px → 360px для 1200px |
| Bg | `var(--surface) #18181B` — тот же что чат, не градиент | [И] |
| Border | `1px solid var(--border)` | [И] |
| Radius | `16px` | [И] |
| Padding | `12px` | [О] |

**Header D:**

```
h 44px, flex row gap 4px, justify flex-end, pad 0 4px
Btns: 28×28 r 8px, icon 14px text-2→text-1 hover, gap 4px
Order: sun (theme) · minus (min) · expand (max) · x (close)
```

**Sphere stage:**

```
flex 1, center, position relative, overflow hidden
Sphere canvas: w 260px, h 260px (72.7% панели, 23.4% окна) — [И]
Top offset: центрирован, не прижат к верху — center 50.8% H окна [И]
Bg behind sphere: transparent (на surface панели)
Footer "BY AMBIONYS" — не воспроизводить — заменить на "NOX" 10px/500/text-ghost если нужен ватермарк, иначе скрыть
```

**Responsive:** при ширине окна <1000px панель D переходит в отдельный таб (кнопка `Sphere` в rail) — не overlay, а замена content C.

---

## 7. Состояния и интерактивность

| Элемент | Default | Hover | Active/Focus | Disabled |
|---------|---------|-------|--------------|----------|
| Rail btn | text-3 | bg surface-hover, text-1 | bg accent-soft, text accent, left bar | — |
| History item | text-2 | bg hover, text-1 | bg accent-soft, text-1, left accent dot 3px | — |
| "Новый чат" | surface-3, border | text-1, border-strong | press scale 0.98 | — |
| User bubble | surface-4, border | — | — | — |
| Composer | surface-3, border | border-strong | focus-ring (accent) | — |
| Mic | surface-4, border | bg surface-hover | recording: bg accent-soft, icon accent, pulse | — |
| Send | accent bg, white icon | accent-hover, y -1px 120ms | accent-active, y 0, scale 0.98 | surface-3, icon ghost, cursor not-allowed |
| Window ctrl close | transparent | bg rgba(255,92,92,0.12), text err | bg err, text white | — |

Focus ring: `box-shadow: 0 0 0 2px bg, 0 0 0 4px accent` — для всех интерактивов.

---

## 8. Скролл и переполнение

- History и feed: `scrollbar-width: thin`, `scrollbar-color: #3A3A3E transparent`, hover thumb `#6B6B70`.
- Автоскролл feed к низу при новом сообщении — `behavior: smooth` только если пользователь не скроллил вверх >80px (отменить автоскролл, показать `↓ Новые` pill).

---

## 9. Пустые и ошибочные состояния

- Пустая история: `text-2` 13px "Пока нет чатов", center, pad 24px.
- Ошибка сети: `inline banner r 8px, bg err/14%, border err/42%, text err, icon 14px, h 36px, pad 12px`.
- Нет ключа модели: banner `warn` аналогично, но не янтарный акцент сферы.

---

## 10. Реализация (React/Electron)

Структура файлов:

```
renderer/
  tokens-nox.css          — токены (design-tokens.md §10)
  layout-nox.css          — грид окна, панели, rail, responsive
  components/
    Rail.tsx              — 6 кнопок, activeId, onNavigate
    HistoryPanel.tsx      — title, newChat, sections, onSelect, onNewChat
    ChatPanel.tsx         — empty/feed states, working row, messages
    Composer.tsx          — textarea, attachment, waveform, toolbar
    SpherePanel.tsx       — header controls + <OrbCanvas />
    WindowChrome.tsx      — min/max/close handlers via ipcRenderer.invoke('window:control')
```

Лейаут без CSS Grid — `flex row`:

```tsx
<div className="app" data-theme="nox">
  <Rail active="chat" />
  <HistoryPanel items={chats} onSelect={...} />
  <ChatPanel messages={...} working={...} composer={<Composer />} />
  <SpherePanel state={orbState} />
</div>
```

```css
.app { display:flex; gap:8px; padding:8px; height:100vh; background:var(--bg); border-radius:var(--r-window); }
.history { width:244px; flex:none; }
.chat { flex:1 1 520px; min-width:320px; display:flex; flex-direction:column; }
.sphere { width:360px; flex:none; }
@media (max-width: 1000px) { .sphere { display:none; } .app[data-sphere-tab] .chat { display:none; } .app[data-sphere-tab] .sphere { display:flex; flex:1; } }
```

IPC для контролов окна — уже есть `preload.js: window.jarvis.*`, добавить `window:control` в `main.js` `ipcMain.handle`.

