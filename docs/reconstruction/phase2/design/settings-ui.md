# Настройки — визуальная спецификация

> Видео V1 00:35 [В] — группы параметров аватара (размер, прозрачность, свечение) + превью справа. Общая структура всех настроек в роликах не установлена — весь экран [П]. Источники: `renderer/index.html` (существующие карточки), `renderer/settings-nav.js`, `renderer/app.js`, `renderer/look.js`, `renderer/accent.js`, `renderer/theme-boot.js`, `renderer/extensions.js`.

---

## 1. Лейаут

### 1.1 Эталон 1200×720

```
.nox-workspace  x80 y72 w1092 h632 gap 12
┌───────────────────────┬─────────────────────────────────┐
│ .nox-nav  252×h632    │ .nox-main  828×h632             │
│ bg surface r12 border│ bg surface r12 border pad 20    │
│ pad 12 gap 12        │ overflow-y auto  gap 12         │
│ ┌─────────────────┐  │ ┌─────────────────────────────┐ │
│ │ Search 228×40 r8│  │ │ Card pad 20 r12 bg surface│ │
│ │ 🔍 Поиск… 13/t2  │  │ │  Header 16/600 + desc     │ │
│ └─────────────────┘  │ │  Rows min56 flex rows     │ │
│ Chips h32 r pill     │ │  gap 12 между картами     │ │
│ [Все][ИИ][Вид][Голос]│ │ └─────────────────────────────┘ │
│ Nav h40 r8 gap 4     │ │  + Sphere future card 828×h  │
│  • Общие 14/500      │ │  + Appearance card          │
│  • ИИ и провайдеры   │ └─────────────────────────────────┘
│  • Голос и память    │
│  • Внешний вид       │
│  • Сфера Nox (new)   │
│  • Безопасность      │
└───────────────────────┴─────────────────────────────────┘
```

- Nav `w252` + Main `w828` + gap 12 = 1092 [П по settings-spec]. Nav `pad 12`, search `h40`, category chips `h32 r pill`, nav item `h40 r8` [П].
- Card `pad 20 r12 bg surface border`; header `16/600 text-1 + desc 12/text-2`; строки внутри `min 56 flex row space-between align center gap 16` — слева `label 14/500 + hint 12/text-2`, справа контрол [П].
- Gap между картами 12px [П].
- При ≤1000px: nav → горизонтальная полоса 40px над main, `overflow-x auto`, main full width [П].

### 1.2 Навигация по категориям

```
Nav item  h40 pad 12 r8 gap 8  icon 16 text-3 → active accent-soft + accent
  [icon] Общие
  [icon] ИИ и провайдеры
  [icon] Голос и память
  [icon] Внешний вид
  [icon] Настройка сферы
  [icon] Безопасность
  Количество внутри карточки — 7–9 секций; клик скроллит к карточке (settings-nav.js anchor), не копии данных [П].
```

### 1.3 Поиск по настройкам

```
Search  h40 r8 bg surface-3 border  icon search 16 pad 12  placeholder "Поиск настроек…" 13/text-2
```

- Фильтрует видимые категории и подписи `live`, не удаляет контролы и не меняет значения [П].
- `No matches → «Ничего не найдено» 14/text-2 center pad 24` [П].
- Условно скрытые поля (напр. Gmail без `NOX_GMAIL_CLIENT_ID`) не раскрываются поиском [П].

---

## 2. Секции и контролы

### 2.1 Общие контролы

| Контрол | Размер | Визуал |
|---------|--------|--------|
| Switch | 32×20 track surface-3 border thumb 16 r 50% — on `bg accent thumb white` |  [П] |
| Select | 160–220×40 r8 bg surface-3 border text-1 13/500 chevron 12 | [П] |
| Input text | 200–260×40 r8 bg surface-3 border pad 12 text-1 13 | [П] |
| Button secondary | 120×36 r8 bg surface-3 border text-2 13/500 | [П] |
| Button danger | ghost err: `bg transparent border err/42 text err → hover err/14` | [П] |

Сохранение — существующие `settings:get/set` handlers; при ошибке banner err 36 + toast «Не удалось сохранить» + восстановленное значение [П].

### 2.2 Настройки ИИ и провайдеров

```
Card "ИИ и провайдеры"  pad 20 r12
  Row: Модель → Select [Быстрая / Умная] 200×40  (пользователь не видит названий моделей/провайдеров, только эти два) [П]
  Row: Мышление → Select [Авто / Вдумчиво] 200×40  (tiers.js) [П]
  Row: Провайдеры владельца (условная — только Owner build) → List providers.json  gap 8  each h48 pad12 r8 border
       Name 14/600 + Url 12/mono text-2 + [Удалить] 24 icon  +  Key •••• hidden badge 11/mono ghost
  Note 12/text-2 «Ключ зашифрован, виден только владельцу сборки»
```

- Настоящие названия моделей/поставщиков — только в `apps/nox-server/models.js` и `src/brain/tiers.js`, не в UI [П].
- Флаг `OWNER_BUILD` из `build-info.json` — показать секцию провайдеров; иначе скрыта [П].

### 2.3 Голос и память

```
Card "Голос"  — перенесены существующие контролы [В]:
  voiceVolume slider 0–100 + value 12/mono
  voiceRate   slider 0.8–1.6 + value
  voicePersona select [Как есть/Дворецкий/Помощница/Инженер] 200×40
  voiceSpeaker select list локальной модели  220×40  (применяется сразу, хранится в settings)

Card "Память"  — list фактов gap 8  each row h56 pad12 r8 bg surface-3 border
  Fact text 13/400 text-1 clamp 2 + Date 11/text-2 + About 12/text-2
  Actions: [Исправить] 28 ghost + [Удалить] 28 ghost err
  Footer: [Очистить память этого пространства] 36 ghost err + confirm dialog «Очистить? Это нельзя отменить.»

Card "Напоминания" — next reminders текущего пространства gap 8
  Row h48 pad12 r8 bg surface-3 border: Text 13/500 + Time 12/text-2 local + [Отменить] 28 ghost

Card "Расширения" — 3 подкарты:
  Буфер: toggle + срок + [Очистить] + [Пауза]
  Вставки: triggers list + [Добавить]
  Загрузки: [Анализ] → preview + [Удалить] с confirm только внутри папки
```

- Создание памяти/напоминаний — словами в чате, не форма в настройках [П].
- Цвета только токенами темы `tools-extra.css` [В].

### 2.4 Внешний вид

```
Card "Внешний вид"  — существующие ручки look.js / accent.js / theme-boot.js [В]:
  Тема select 200×40  [Ночь/День/Графит… + Как в системе]
  Цвет акцента: 7 кружков 24px r50% + [как в теме] + HEX input 80×36 r8  + hint 11/text-3 «…читался бы плохо, поэтому взят #…»
  Шрифт интерфейса / заголовков / ответов  select 180×40
  Размер текста  slider 0.92–1.16  ( Inter в Nox остаётся Inter независимо — см. Phase-1.1)
  Скругление / Плотность / Размер шара / Свет / Размытие — sliders
  [Сбросить к теме] 36 ghost  → очищает ручки + accent, тема/вид шара остаются [В]
```

- Прозрачность окна `0–60% step 5` и радиус `0/8/14/22/28` — как в DESIGN.md § «Окно» [В].
- Ручки «Как в теме» ничего не пишут на `:root` [В].

### 2.5 Настройка сферы (новая — future)

> Состояние: не активна до отдельного backend-контракта. Показать как **документальный превью-блок**, не как работающие контролы, или disabled с бейджем «Скоро» [П].

```
Card "Сфера Nox"  x344 w560 pad 20 r12 bg surface border  +  Preview x916 w256 h240 r12 bg surface-1 border
  Preview: canvas wire/nox 180px + label состояния 11/text-2 + [Вернуть текущее] 28 ghost
  Segment: [Wire ○] [Nox Points ●]  h32 r pill  — wire = проволочная сетка, nox = точки с ядром (orb-nox.js) [В]
  Rows: (each row min56 flex space-between + slider 160×20 + value 12/mono 32px)
    Цвет: [Тема / Свой] select 160×40  (свой → HEX 80×36)
    Размер: slider 70–120% step 5  value 12/mono + hint 11/text-2
    Яркость ядра: slider 0–160% step 5  (для Wire disabled + hint «Недоступно для Wire» 11/text-3) [П]
    Свечение: slider 0–160% step 5
    Скорость: slider 0–200% step 5
  Footer: [Сбросить настройки сферы] 36 ghost + confirm «Сбросить только выбранный вариант?» + [Применить] 40 accent / [Отмена] 36

При 864: превью над настройками full width h180  [П]
```

- Диапазоны [П]: `size 70–120%`, `core 0–160%`, `glow 0–160%`, `speed 0–200%`, 100% = нынешний вид.
- Свой цвет применяется к базовой палитре; смысловые состояния (warn/err) сохраняют различимость [П].
- Ползунки меняют **только локальное превью**; `Применить` сохраняет в версионированный ключ (не `noxOrb`), `Отмена` восстанавливает snapshot; сфера чата не пересоздаётся [П].
- `nox-screen.js setVariant wire/nox + localStorage noxOrb` остаётся источником; `orb-tune.js jarvis.orbTune` не переносить молча [П].
- При `prefers-reduced-motion` превью статично [П].

```
Future key: `noxSphere:{variant}` v1  {size,gow,glow,speed,color: theme|#RRGGBB}  — читать без миграции старого noxOrb [П]
```

### 2.6 Безопасность

```
Card "Безопасность"  pad 20 r12
  Row: Режим доступа → Select [Полный/Спросить/Ограниченный] 200×40 + hint 12/text-2 «Режим решает, что без вопроса» (decide/hardDeny policy) [В]
  Row: Gmail (условная) → Status pill [Подключён/Не подключён] + [Подключить] 36 accent / [Отключить] 36 ghost err
  Row: Уведомления → watchWindow/watchTelegram/watchPerHour  toggles + inputs
  Row: Очистка данных → [Очистить …] dialogs
```

---

## 3. Состояния и валидация

- Каждая карта — `loading → content | empty → error` локально; глобальный спиннер не блокирует другие карты [П].
- Ошибка сохранения: banner err 36h + восстановленное значение + toast [П].
- Условные блоки (Gmail, провайдеры владельца) — `display:none` когда флаг отсутствует, не skeleton [П].

---

## 4. Текстовые схемы

### S1 — Настройки общий вид 1200

```
Nav 252: Search 228×40 + chips [Все][ИИ][Вид]… + items Общие/ИИ/Голос/Вид/Сфера/Безопасность (актив accent-soft)  — Main 828 scroll: Card «ИИ и провайдеры» rows 56 Модель/Мышление/Провайдеры — Card «Голос» sliders + selects — Card «Память» list h56 rows + footer — gap 12
```

### S2 — Сфера Nox preview

```
Head: Настройки / Сфера Nox  — Card 560: Segment Wire/Nox — Sliders Размер/Яркость/Свечение/Скорость each row + value mono — Preview 256×240 canvas wire + label «idle» — Footer Сбросить | Применить
```

---

## 5. Чек-лист приёмки

- [ ] Nav 252 + Main 828 = 1092, gap 12, card pad 20, headers 16/600, rows 56, radius 12/16.
- [ ] Search фильтрует подписи, не удаляет контролы; No matches center.
- [ ] Все существующие секции перенесены без потери значений; условные (Gmail/провайдеры) скрыты когда нет флага.
- [ ] Сфера — preview only, не меняет живую сферу, сброс только варианта.
- [ ] Адаптив ≤1000: nav → horizontal chips, rows переносят контрол вниз.
