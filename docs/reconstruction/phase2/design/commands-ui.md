# Команды — визуальная спецификация

> Опоры: V1 00:13–21 (дерево, выбор действия, запись, описание) — `video-analysis.md`; функциональный контракт — `commands-spec.md`.  
> Каркас и токены — `design-system.md` + `navigation-layout.md`.  
> Все размеры CSS px эталона 1200×720, если не указано иное. Маркеры [В]/[О]/[П].

---

## 1. Каталог команд (Commands / Мои)

### 1.1 Лейаут

```
.nox-workspace  x80 y72 w1092 h632  gap 12px
┌────────────────────────────────────────────┐  ─ nox-main-head  h56  pad 20  border-bottom subtle
│ Head: "Команды" 24/600 + [ + Новая ] 40px │    [П]
├────────────────────────────────────────────┤
│ Tabs + Toolbar  y128 h40  gap 12           │    [П]
│ [Мои · 12] [Библиотека · 36] | Search 260 │    [О] таб h40, поиск как в чате
│ | [◉ Записать 36] [↓ Импорт 36] [↑ Экспорт]│    [В] V1 00:13 справа 3 кнопки
├───────┬────────────────────────────────────┤
│main   │ Packs                              │
│800px  │ 280px  gap 12  pad 16  bg surface-1│  [П] 1200: справа; ≤1000: под списком
│pad16  │ card gap 12                        │
│list   │                                    │
│rows 64│                                    │
│gap 8  │                                    │
└───────┴────────────────────────────────────┘
```

- Полезная область `x80 w1092` внутри `.main` [П]. Основная `w800` + паки `w280` + gap 12 [П].
- Заголовок: слева `Команды` 24/600/text-1, справа кнопка `Новая` 112×40 r8 bg accent text ink 14/600 [П].
- Вкладки: `h40 r8 pad 12 text 13/500`, active `bg accent-soft text accent border accent/24`, inactive `text-2 border` [П].
- Поиск: `w260 h40 r8 bg surface-3 border icon search 16px text-3` placeholder `text-2 13px` [П].
- Кнопки тулбара справа: `h36 r8 bg surface-3 border text-2 13/500 icon 14px gap 6` hover `surface-hover text-1` [П].

### 1.2 Строка команды

```
Row: min 64px  pad 12  r12  bg surface  border 1px  flex row gap 12  align center
┌──┬──────────────────────────────────────┬────────────────┐
│› │ Name 14/600 text-1 + фразы 12/400    │ [▶ Запустить]  │
│  │ folder·hotkey·origin 12/text-2 + Nшаг│ [ ◐ toggle ]   │
└──┴──────────────────────────────────────┴────────────────┘
  20px  flex 1 min 0               96+44px
```

- Слева шеврон `›` 20×20 r6 `text-3 → text-1 hover` — раскрывает шаги без перехода в редактор [В V1 00:13 дерево с шевронами].
- Имя 14/600/text-1; фразы-чипы `h20 r pill pad 6 bg surface-3 border text-2 11/500` до 3 видимых + `+N` [П].
- Мета: `folder · hotkey · origin` 12/400/text-2, шаги `N шагов` 12/500/text-2 [П].
- Справа: `Запустить` 96×32 r8 bg surface-3 border text-2 13/500 → hover `accent-soft + accent` ; выключенная строка — `Запустить disabled ghost` [П].
- Toggle: `32×20 switch track surface-3 border thumb 16px`; on `bg accent thumb white` [П по существующему toggle в commands].
- Выбранная строка: `border accent 1px + shadow accent 6% ` [П].
- Выключенная команда: `opacity 0.92 + имя text-3 + Запустить disabled` — переключатель остаётся доступен [П по commands-spec].
- Hover строки: `bg surface-hover + border-strong` 120ms [П].

**Экспанд (шеврон открыт):**

```
Row expanded  bg surface-raised  border-strong
 └─ Steps preview: gap 8  pad 12 16 12 8 (отступ под строку)
    Step 1 — app_open  «Открыть Spotify»  args: name Spotify
    Step 2 — wait       ms 1200
    ... до 20, каждый h28  text 13 mono text-2 + icon 12
```

- Превью только чтение; управление внутри не открывает редактор [П].
- Поиск «Мои» — по `name + folder + phrases` (не description) [П].

### 1.3 Библиотека (таб «Библиотека»)

```
Category header h44  pad 12  bg transparent  border-bottom subtle
  Title 14/600 text-1  + count 12/text-2
Row library min 64  pad 12 r12 bg surface border  flex col gap 6
  Name 14/600 + risk pill (T0 neutral / T1 accent / T2 text / T3 err)
  Desc 13/400 text-2  (1 line clamp)
  Phrases 12/400 text-2 + args `mono 12`
  [ Запустить ] 36px справа
```

- Search библиотеки — по `name + category + desc + phrases` [П].
- Запуск — `libraryRun` с полями аргументов (обязательные — с валидацией), иначе disabled [П].
- Это **библиотека готовых команд**, не список типов шагов [П].

### 1.4 Панель паков

```
Pack card  pad 16  r12  bg surface  border  flex col gap 12
  Head: Name 14/600 text-1 + «N команд» 12/text-2
  Meta: «Нужно: окно редактора…» 13/400 text-2  (если есть)
  State: «Не установлено / Установлено N из M / Все установлено» + badge
  Btn: [Установить|Дополнить|✓ Установлено] h36 r8  (последняя disabled ghost)
  Details: «Что внутри» disclosure → list команд 13/400 + фразы 12/text-2
```

- Цвета `.pack-*` через `tools-extra.css` токенами темы, не хардкод [В].
- Установка только по клику `packs:install` — при старте не ставится [В].

### 1.5 Состояния каталога

| Состояние | Визуал |
|-----------|--------|
| Loading | Спиннер 16px accent + «Загрузка команд…» 14/text-2 center pad 32 |
| Пустой список | Icon `spark` 24 ghost + «Пока нет команд» 16/600 + «Создайте первую» 14/text-2 + [Создать команду] 36 accent |
| Нет совпадений | «Ничего не нашлось» 14/text-2 + [Сбросить] link accent |
| Ошибка загрузки | Banner err 36h + причина mono 12 + [Повторить] 32 |
| Во время вызова | Кнопки `Новая/Импорт/Экспорт/Записать` disabled ghost + спиннер 12 |

---

## 2. Создание и редактирование

### 2.1 Лейаут редактора

```
Header: .nox-main-head  h56  "Команды / Имя" 14/500 text-2 → 14/600 text-1  + [← Назад] 32px icon
Content: flex row gap 12  pad 20
┌──────────────────────────────┐ ┌──────────────────┐
│ Main card 724px pad 20 r12   │ │ Result 356px pad │  [П] x80 y72 w724 + x816 w356 gap12
│ bg surface border gap 16     │ │ 16 r12 sticky    │
│  Name field                  │ │  Результат       │
│  Phrases chips + add + 0/5   │ │  Steps statuses  │
│  Folder | Hotkey             │ │  ok/unverified/  │
│  Origin + warnings           │ │  failed/err      │
│  Steps N/20 + Add action     │ │  + evidence      │
│  Steps list                  │ │                  │
└──────────────────────────────┘ └──────────────────┘
Footer: h64  border-top subtle  pad 16  flex space-between  bg surface  sticky bottom
  Left: [Удалить] ghost err (только сохранённая)
  Right: [Проверить] 36 ghost + [Запустить сейчас] 36 ghost + [Отмена] 36 + [Сохранить] 40 accent
```

- Редактор **заменяет** список (не overlay) [В V1 00:14 — центр ~305,95,790,575 обрезан].
- При 864×520: result под полями, кнопки в 2 строки wrap [П].
- Новая команда — 1 пустой шаг, фокус в имени [П].

### 2.2 Поля

| Поле | Контрол | Валидация | Типографика |
|------|---------|-----------|-------------|
| Имя | Input h40 r8 bg surface-3 border pad 12 | 1–60 симв, обязательно | 14/500 text-1 |
| Фразы | Чипы `h24 r pill bg surface-3 border` + input h32 `Добавить фразу` + счётчик `0/5` 12/text-2 | 1–5, каждая 1–80, уникальные lower-case | чип 12/500 text-1 `×` 12 |
| Папка | Input h36 r8 200px | 0–60 симв | 13/text-1 |
| Горячая клавиша | Input h36 r8 160px + hint `Ctrl+…` 11/text-3 | 0–40 | 12/mono |
| Происхождение | Text 12/text-2 + icon 12 `info` | readOnly | — |
| Предупреждения записи | Banner `warn 14% bg border 42% h32 pad12 icon 14` | — | 12/500 warn + 12/400 warn text |

### 2.3 Нижняя панель и валидация

- `Сохранить` доступен при наличии API `saveCommand`; недоступен — `disabled + tooltip «Нет доступа к сохранению»` [П].
- При клике `Сохранить`: проверить `name + ≥1 phrase + ≥1 step + required args + ranges`; показать все ошибки баннером `err` + подсветкой полей `border err`, фокус на первой ошибке [П].
- Дубли фраз не добавлять — inline ошибка `Фраза уже есть` 12/err под полем [П].
- `Запустить новой/изменённой` — disabled до сохранения [П].
- `Проверить` — только текст шагов (см. `cmd-steps.js`), запуск не производится [П].
- `Удалить` — двойное нажатие 4с: `1-й клик → «Нажмите ещё раз для удаления» warn pill + таймер 4с → 2-й клик удаляет` [П].
- Уход с dirty: диалог `«Изменения не сохранены» / «Выйти без сохранения?»` → `[Выйти]` err + `[Остаться]` + `[Отмена]` [П].

---

## 3. Редактор последовательности действий (Steps)

### 3.1 Карточка шага

```
Step card  pad 12  r12  bg surface-3  border  gap 12  flex col
┌─────────────────────────────────────────────┐
│ #1  [app_open ▾]  «Открыть приложение» 12/600│  row gap 8 h32
│     risk pill T1 neutral/accent если есть  │  mono 11
│     [↑] [↓] [×]  24×24 r6  icon 12 text-3  │
├─────────────────────────────────────────────┤
│ Desc 13/400 text-2  «Открывает программу…»  │
│ Fields: label 12/500 text-2 + input h36    │
└─────────────────────────────────────────────┘
```

- `#` — `12/600 mono text-3 w20 center` [П].
- Selector — `select h32 r8 bg surface-2 border text-1 13/500 chevron 12` [П].
- Move up/down — `24px square r6`; `#1` — `↑ disabled ghost`, last — `↓ disabled`; hover `surface-hover text-1` [П].
- Delete `×` — `24px r6 text-3 → hover err bg err/14` [П].
- При 20 шагах `Добавить действие` disabled + hint `Достигнут лимит 20` 12/text-3 [П].
- Drag reorder (если реализован) — ручка `⋮⋮` 12px text-ghost + `grab cursor` [П].

### 3.2 Поля аргументов (из `tools:catalog`)

- Рендер по `parameters.properties/required`: number `min/max/step` → `input type=number h36`; boolean → `switch 32×20`; enum → `select h36`; long text → `textarea h72`; остальное `input text h36` [П].
- Hint и диапазон рядом `12/text-2` [П].
- При смене типа шага — сохранить общие параметры; если теряются непустые — **предупредить** диалог `«Смена типа удалит N полей»` [П].
- Неизвестный тип старого шага — показать исходные `params` + badge `«инструмент недоступен»` 11/500 err, не отбрасывать [П].
- Фактические лимиты: `app_open.name 1–260 обяз`, `ui_keys.keys обяз + window опц`, `wait.ms 0–10000 int`, `speak.text 1–300`, `volume_set.percent 0–100 int` [П]; схема сервера — источник истины.

---

## 4. Выбор действия (Action Picker)

### 4.1 Лейаут диалога

```
Overlay rgba(0,0,0,0.48)  dialog 640×520 r16 bg surface border shadow-popover
┌─────────────────────────────────────────┐  ─ header h60  pad 16  border-bottom subtle
│ Выбор действия              [×] 20px    │    Title 16/600 text-1
├─────────────────────────────────────────┤
│ Search h40 r8 bg surface-3 border       │    Icon search 16 text-3 pad 12
│ 🔍 Поиск действий… 13/text-2           │
├──────────────┬──────────────────────────┤
│ Categories   │ List                     │  body flex row  gap 0  overflow hidden
│ 150px        │ 1fr  overflow auto      │
│ pad 12       │ pad 8                   │
│ [Все]        │ Row h40 pad 12 r8 gap 8│
│  Программы   │  Icon 16 text-3         │
│  Клавиши     │  Name 13/500 text-1     │
│  Время       │  Desc 12/text-2         │
│  Голос/Звук  │  Selected bg accent-soft│
└──────────────┴──────────────────────────┘
┌─────────────────────────────────────────┐  ─ footer h64  pad 16  border-top subtle  flex flex-end gap 8
│              [Отмена] 36   [Добавить] 40│    Добавить disabled пока нет выбора
└─────────────────────────────────────────┘
```

- Геометрия [О] V1 00:15: диалог ~370,200,550,440; поиск ~390,270,505,35; категории 135px; список остаток [В].
- Категории [П]: `Все`, `Программы`, `Клавиши`, `Время`, `Голос`, `Звук` — локальные группы `EDITOR_STEP_TOOLS` (`app_open`, `ui_keys`, `wait`, `speak`, `volume_set`) [П].
- Источник списка — `tools:catalog` + фильтр редактора; не предлагать `mouse_click/ui_click/mail_send` если их нет в каталоге [П].
- Поиск — по `name + desc`, debounce 150ms, пусто → «Ничего не нашлось» 14/text-2 center + [Сбросить] [П].

### 4.2 Интерактив

- Один клик — select `bg accent-soft border accent text-1`; двойной клик / Enter — add + close [В подпись «двойной щелчок»].
- `Добавить` — вставляет шаг в editor и фокусит первое обязательное поле [П].
- `Escape` / `×` — отмена, фокус возврат к `[Добавить действие]` [П].
- Без выбора — `Добавить disabled ghost` [П].
- Клавиатура: `↑↓` навигация, `Enter` add, `Escape` close [П].

---

## 5. Запись действий

### 5.1 Панель записи

```
.nox-main  x80 y180 w800  pad 20 r12 bg surface border
┌─────────────────────────────────────────┐
│ Запись действий  16/600 text-1          │
│ Объяснение 13/400 text-2 (2 строки)     │  [П] «Запись фиксирует только поддерживаемые действия…»
│ Banner warn 32h  «Координаты могут…»  │  icon 14 warn 12/500
│ Steps list  gap 8  pad 12               │  [О] V1 00:17 диалог ~450,210,375,410
│  • 10:02 app_open Spotify  chip 11/mono│  record:step
│  • 10:03 wait 800ms                    │
│ Error? → banner err 36h                │
├─────────────────────────────────────────┤
│ [Отменить запись] 36 ghost  [Остановить│  footer gap 8 flex-end
│                           и открыть черновик] 36 accent
└─────────────────────────────────────────┘
```

- Старт: `recordStart` — панель заменяет список команд [В V1 00:17–18 индикатор + таймер + пойманный запуск].
- Источник — `tool_start` от инструментов (`captureRecordedTool`), **не** системный хук всех физических кликов [П].
- Не обещать запись всего ввода; секреты и набранный текст не записываются [П по commands-spec].
- `Отменить` → `recordCancel` → возврат к списку.
- `Остановить` → `recordStop` → черновик редактора с `warnings` записи [П].
- Если запись не поддерживается — banner err + [Закрыть] [П].

### 5.2 Черновик записи

- Откроется редактор как новая команда, шаги предзаполнены, поле имени пустое фокус, баннер `warn` с координатами [П].
- Пользователь правит и сохраняет обычным flow [П].

---

## 6. Импорт и экспорт

### 6.1 Экспорт

- Кнопка `Экспорт` 36 h + icon `↑` → `exportCommands` → системный save dialog [П].
- Отмена диалога — не показывать успех [П].

### 6.2 Импорт — выбор + предпросмотр

```
Step 1: Системный open dialog → pickCommandsImport → path + payload в памяти  [П]
Step 2: Dialog 640×520 r16 bg surface border shadow  ── [О] V1 не показывает, контракт [П]
┌─────────────────────────────────────────┐
│ Импорт команд              [×]          │ h60 16/600
├─────────────────────────────────────────┤
│ File: pack-2026-11-09.json 12/mono     │ pad 16 gap 12
│ Count: 12 команд  14/500 text-1         │
│ Summary chips h24 r pill gap 8:        │
│  [+] Добавить 3  accent                 │
│  [↻ Обновить 5] surface-hover          │
│  [— Без изменений 2] ghost             │
│  [⚠ Конфликт 2] err bg 14%             │
├─────────────────────────────────────────┤  body scroll
│ Diff list gap 8 pad 12                 │
│ Row h56 pad 12 r8 border gap 12        │
│  Name 14/600 + phrases 12/text-2       │
│  Status chip 11/500 + warning 12/400   │
├─────────────────────────────────────────┤
│ [Отмена] 36  [Импортировать] 40 accent │ footer h64. Конфликт → Импортировать disabled + tooltip
└─────────────────────────────────────────┘
```

- При конфликте импорт выключен, показать причину `conflict: duplicate trigger` 12/err [П].
- `Отмена` — без записи.
- `Импортировать` → `applyCommandsImport(token,true)` → toast `Импортировано N` + обновление списка [П].
- Ошибки файла — banner err + [Выбрать другой] [П].

---

## 7. Переходы

| Переход | Анимация |
|---------|----------|
| Список → Редактор | `fade 120ms + slide 200ms ease-out 8px`; header морфит «Команды / имя» |
| Редактор → Выбор | Dialog rise 200ms; overlay fade 120ms |
| Запись старт/стоп | Панель slideDown 200ms; steps stagger 40ms |
| Импорт diff | Chips fade 120ms; rows stagger 30ms |
| Уход с dirty | Dialog rise; focus trap |

---

## 8. Текстовые схемы экранов (для приёмки)

### S1 — Каталог «Мои» (пустой)

```
[Рейка 52] | [Истории нет] | Head: Команды — tabs Мои(0) Библиотека(36) — Search 260 — Записать | Импорт | Экспорт — body: icon spark 24 ghost center «Пока нет команд» 16/600 + «Создайте первую» 14/text-2 + [Новая] 40 accent — Packs справа: 3 пака «Монтаж/Игры/Браузер» each card 16pad
```

### S2 — Каталог с командами (заполнен)

```
Row1: › Spotify  фразы «включи спотифай»  folder Музыка  origin Готовый пример  3 шага  [Запустить] ◐
Row2 expanded: › Разобрать входящие ... 3 шага preview шагов mono 12
```

### S3 — Редактор новой команды

```
Head: Команды / Новая команда  + ←Назад — Main 724: Имя [________] Фразы chips [включи спотифай ×] + [Добавить фразу] 0/5 — Папка [Музыка] | Горячая [Ctrl+Shift+S] — Происхождение readOnly — Шаги 1/20 + [Добавить] — Step1 app_open fields: Приложение [Spotify] — Footer: Удалить hidden | Проверить Запустить( disabled ) Отмена Сохранить accent
```

### S4 — Диалог выбора

```
Overlay — Dialog 640×520 — Header Выбор действия × — Search — Left 150 Categories Все/Программы/… — Right list rows h40 icon+name+desc selected accent-soft — Footer Отмена Добавить(disabled)
```

---

## 9. Чек-лист приёмки Команд

- [ ] Каталог: header 56, tabs 40, поиск 260, кнопки 36, строки 64, gap 8, radius 12/16.
- [ ] Шеврон раскрывает preview без навигации; controls внутри не открывают редактор.
- [ ] Выключенная строка бледнее, Запустить disabled, toggle жив.
- [ ] Библиотека: поиск по 4 полям, запуск с валидацией обязательных.
- [ ] Редактор: 724+356 колонки, footer 64 sticky, валидация при Сохранить показывает все ошибки + фокус на первой.
- [ ] Steps: move up/down края disabled, 20 лимит, неизвестный тип не отбрасывается.
- [ ] Выбор: single select + double add, Escape возврат фокуса.
- [ ] Запись: не обещает все клики, показывает captured tools + warning координат.
- [ ] Импорт: summary add/update/unchanged/conflict, конфликт блокирует Импорт.
- [ ] Адаптив 864: паки внизу, кнопки wrap, dialog win-32px.
