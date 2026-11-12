# Компоненты Nox — спецификация

> Все компоненты наследуют `design-system.md`. Здесь — их размеры, состояния и варианты.  
> Не создавать новых визуальных стилей вне этого каталога [П].

---

## 1. Кнопки

### 1.1 Primary

```
h 40 r 8 bg accent #2E9AC1 text ink #061217 14/600 pad 16 icon 14 gap 6 border none
  hover bg accent-hover  y -1px 120ms
  active bg accent-active y 0 scale 0.98
  disabled bg ghost #3A3A3E text text-ghost cursor not-allowed
  focus focus-ring
  loading spinner 14 white + text muted
```

- Использование: `[Новая]`, `[Сохранить]`, `[Добавить]`, `[Разрешить]`, `[Импортировать]`, `[Установить]` [П].

### 1.2 Secondary / Ghost

```
h 36 r 8 bg surface-3 #1C1C1F border 1px #2A2A2E text text-2 13/500 pad 14 gap 6
  hover bg surface-hover text-1 border-strong
  active surface-active scale 0.98
  disabled ghost
  focus focus-ring
```

- Использование: `[Отмена]`, `[Записать]`, `[Импорт]`, `[Экспорт]`, `[Проверить]` [П].

### 1.3 Destructive

```
h 36 r 8 bg transparent border err/42 text err 13/500
  hover bg err/14
  active bg err/24 scale 0.98
```

- Только для `[Удалить]` (двойной клик 4с) и `[Удалить сервис]` с подтверждением имени [П].

### 1.4 Icon Button

```
32×32 r 8 (рейка 36×36 r10)  bg transparent text text-3  icon 14–18
  hover bg surface-hover text-1
  active surface-active
  active-selected bg accent-soft text accent + left bar (рейка only)
```

### 1.5 Размеры

| Вариант | h | pad | font | icon |
|---------|---|-----|------|------|
| `xs` | 28 | 10 | 12/500 | 12 |
| `sm` | 32 | 12 | 13/500 | 14 |
| `md` (default) | 36 | 14 | 13/500 | 14 |
| `lg` (primary) | 40 | 16 | 14/600 | 14 |

---

## 2. Поля ввода

### 2.1 Text / Number / Textarea / Select

```
h 40 (select 40, textarea 72 min)  r 8  bg surface-3 border 1px #2A2A2E
  pad 12  text 13/400 text-1  placeholder text-2 13/400
  hover border-strong
  focus border accent + focus-ring (без border-color только ring — ring уже с bg gap 2px)
  error border err + bg err/6% + message 12/400 err gap 4
  disabled bg surface text-ghost border
```

- Select — `chevron 12 text-3` справа, `appearance none`, dropdown — см. §7 [П].
- Textarea — `resize none`, `min 72 max 120` (composer 24–120) [П].

### 2.2 Search

```
w 260–360 h 40 r 8 bg surface-3 border icon search 16 text-3 pad 12 gap 8
  .search-clear 20×20 r50% icon x 12 text-3 → hover text-1 bg surface-hover (когда есть текст)
```

---

## 3. Пилюли и чипсы

### 3.1 Pill (status/risk)

```
h 20 r 999px pad 6  font 11/500 text
  Variants:
    neutral  bg surface-3 border text-2
    accent   bg accent/14 border accent/42 text accent
    ok       bg ok/14 border ok/42 text ok
    warn     bg warn/14 border warn/42 text warn
    err      bg err/14 border err/42 text err
    ghost    bg surface-3 border text-ghost
```

- Risk: `T0 neutral` [П], `T1 accent` [П], `T2 text` [П], `T3 err` [П] — как в DESIGN.md моно [П].
- Status: `confirmed ok`, `unverified neutral`, `failed err`, `pending warn`, `refused neutral` [П].

### 3.2 Chip (filter/tab/phrase)

```
h 24–32 r 999px pad 12 gap 6  font 12/500 (filter 13/500)
  default bg surface-3 border text-2
  hover text-1 border-strong
  active bg accent-soft text accent border accent/24
  count "· N" 12/400 text-2 → active text accent/70%
```

- Фразы-чипы команд: `h20 r pill pad 6 bg surface-3 border text-2 11/500 + × 12` [П].

---

## 4. Переключатели

### 4.1 Switch (toggle)

```
32×20 track r 999px bg surface-3 border 1px thumb 16×16 r 50% bg text-2 (off)
  on: bg accent border accent thumb white translate 12px
  hover off thumb text-1, on thumb white
  disabled opacity 0.5 + cursor not-allowed
  focus focus-ring
  transition track 120ms ease-default, thumb 200ms ease-out
```

### 4.2 Checkbox (если нужен — settings lists)

```
16×16 r 4 bg surface-3 border 1px icon check 12
  checked bg accent border accent icon white
```

---

## 5. Карточки и панели

### 5.1 Panel (крупная)

```
r 16 bg surface #18181B border 1px #2A2A2E  pad 16–20
  header h56 pad 20 border-bottom subtle (optional)
  gap 12 между картами
  hover (если кликабельна) border-strong
  selected border accent + accent-soft bg
```

### 5.2 Card (средняя)

```
r 12 bg surface border pad 12–16 gap 12
  hover border-strong
```

### 5.3 Row (строка списка)

```
min 56 (команды 64, настройки 56)  pad 12 r 8–12 bg surface border (или transparent в таблице)
  hover bg surface-hover border-strong
  selected bg accent-soft border accent
  expanded bg surface-raised
```

---

## 6. Таблицы (журнал)

```
Header h40 bg surface-3 border-bottom  text 12/500 text-2 uppercase tracking 0.02em
Row min 56 pad 12 border-bottom subtle  hover surface-hover
Empty row: "—" 12 text-ghost
```

- На 864: rows → cards автоматика в коде раздела — не отдельный компонент [П].

---

## 7. Навигационные элементы

### 7.1 Tabs

```
h 40 r 8 pad 12 gap 8  font 13/500 border 1px
  inactive text-2 bg surface-3
  active text accent bg accent-soft border accent/24
```

### 7.2 Nav Item (settings left)

```
h 40 pad 12 r 8 gap 8 icon 16 text-3 text 14/500
  hover bg surface-hover text-1
  active bg accent-soft text accent icon accent
  focus focus-ring
```

---

## 8. Диалоги

### 8.1 Backdrop + Dialog

```
Backdrop  fixed inset 0 bg rgba(0,0,0,0.48) fade 120ms
Dialog  center min(640px, win-32px) × max(win-32px)  r 16 bg surface border shadow-popover
  Header h60 pad 16 border-bottom subtle  16/600 + [×] 20 r8
  Body pad 20 gap 16 overflow-y auto  (scrollbar thin)
  Footer h64 pad 16 border-top subtle flex flex-end gap 8  bg surface (sticky)
```

- Малый диалог: `480px` (удаление, подтверждение, добавление подключения) [П].
- Escape / × = Cancel; фокус trap + возврат к триггеру [П].
- Dirty guard: отдельный dialog `«Изменения не сохранены»` 480px с `[Выйти] err + [Остаться] + [Отмена]` [П].

### 8.2 Disclosure

```
Trigger 12/accent  "Показать … ▾"  icon chevron 12 transition rotate 180 active
Content  card r8 bg surface-3 border pad 12  slideDown 200ms ease-out
```

---

## 9. Сладеры

```
Track h 4 r 2 bg surface-3
  Fill bg accent h 4
  Thumb 16×16 r 50% bg accent border 2px white shadow 0 1px 4px rgba(0,0,0,0.4)
    hover scale 1.1, active scale 1.15 + glow-accent
  Value 12/mono text-1 w 36 text right
  Hint 11/text-3 below
  Disabled thumb ghost + track ghost + value ghost
```

- Ranges сферы: 70–120% / 0–160% / 0–200% step 5 — value + badge `100%` pill 16h [П].

---

## 10. Прогресс и индикаторы

### 10.1 Progress Bar (если future plan)

```
h 4 r 2 bg surface-3  fill bg accent  transition width 400ms ease-default
  indeterminate: shimmer sweep 1200ms linear infinite
```

### 10.2 Spinner

```
16×16 border 2px accent/24 border-top accent  spin 600ms linear
  12px variant для inline в кнопке
```

### 10.3 Timer Bar (approval)

```
h 32 r 8 bg warn/14 border warn/42 pad 12 gap 8  text 12/500 warn tabular-nums icon clock 12
  inner progress h 2 bottom r 0 0 8 8 bg warn  width transition linear 1s
```

---

## 11. Баннеры

```
h 36 (error/warn) до auto r 8 pad 12 gap 8 border
  err  bg err/14 border err/42 text err icon alert 14
  warn bg warn/14 border warn/42 text warn
  info bg surface-3 border text-2 icon info 14
  Actions right: [Повторить] 32 ghost + [×] 20
```

---

## 12. Скролл

```
scrollbar-width thin  scrollbar-color text-ghost transparent  hover thumb text-3 (#6B6B70)
  width 6px, track transparent, thumb r 3px
  auto-hide until hover — opacity 0 → 1 120ms [П]
```

---

## 13. Чек-лист приёмки компонентов

- [ ] Все кнопки 36/40h, фокус ring 2px+2px, hover не «синий фон».
- [ ] Inputs 40h, focus ring, error border+message.
- [ ] Pills 20h r pill 11/500, chips 24–32h r pill.
- [ ] Switch 32×20, thumb 16, transition 120/200ms.
- [ ] Panel r16 pad 16–20, row min 56 r8 hover surface-hover.
- [ ] Dialog 640/480 r16 shadow-popover, footer sticky 64h.
- [ ] Slider thumb 16 r50% + value mono 12.
- [ ] Spinner 16 border 2 spin 600ms, banner 36h.
