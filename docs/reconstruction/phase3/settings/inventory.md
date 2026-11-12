# Инвентаризация «Настроек» — Phase 3.3, phase 1 (read-only)

Дата: 10.11.2026, ~19:40. Только чтение исходников; Electron не запускался, тесты не менялись.
Проверено по: `renderer/index.html:585-901`, `renderer/app.js`, `renderer/look.js`,
`renderer/accent.js`, `renderer/orb-tune.js`, `renderer/extensions.js`, `renderer/settings-nav.js`,
`renderer/account.js`, `renderer/model-pick.js`, `renderer/theme-boot.js`, `renderer/nox-screen.js`,
`renderer/orb-nox.js`, `renderer/orb.js`, `preload.js`, `main.js`.

## 0. Сводка цифр

| Что | Сколько | Где |
|---|---|---|
| `.set-section` внутри `.view.view-settings` | **12 на момент phase 1**; после редизайна phase 2 — **14** (см. §10) | `index.html` |
| Статических `id=` в области настроек | **94** | `index.html:586-900` |
| Статических `<button>` | **46** (23 — темы, 3 — вид шара, 20 — прочие) | там же |
| `role="switch"` (статических) | **14** | там же |
| `data-setting="…"` | **11** | см. §2 |
| `data-local="…"` | **1** (`orbAnim`) | `index.html:839` |
| `<select id=…>` | **4** (`voiceSpeaker`, `voicePersona`, `setKeepAwake`, `clipTtl`) | 645, 651, 705, 757 |
| `<input type="range">` | **2** (`voiceVolume`, `voiceRate`) | 636, 640 |
| radio `name="mode"` | **3** (`full`, `ask`, `auto`) | 594/598/602 |
| `data-theme-opt` | **23** | 804-826 |
| `data-orb-opt` | **3** (`core`, `iris`, `sphere`) | 832-834 |
| Динамические контролы | look: **12** строк + «Сбросить к теме»; accent: **8** кружков + HEX; orb-tune: **6-7** строк на вид; settings-nav: список из видимых разделов (сейчас 10 из 12, скрытые `#mailSettings`/`#ownerProviders` пропускаются); списки памяти/напоминаний/буфера/вставок/загрузок; строки папок/провайдеров | `look.js`, `accent.js`, `orb-tune.js`, `settings-nav.js`, `app.js`, `extensions.js` |
| Id, которые не читает ни один JS (заголовки/подписи/якоря) | 17: `mailTitle, memorySettings, orbPickLabel, remindersSettings, setAnswersTitle, setChatTitle, setDictation, setExtensionsTitle, setFolderTitle, setMemoryTitle, setModelTitle, setModeTitle, setNav, setOwnerTitle, setRemindersTitle, setWindowTitle, themeLabel` | — |

## 1. Разделы (`.set-section`) сверху вниз

| № | id | Заголовок (id) | Строки | Условность |
|---|---|---|---|---|
| 1 | `settings-mode` | «Режим доступа» (`setModeTitle`) | 590-606 | всегда |
| 2 | `mailSettings` | «Почта Gmail» (`mailTitle`) | 608-622 | **hidden**, показывается `app.js initMailSettings` при наличии методов моста |
| 3 | — | «Ответы» (`setAnswersTitle`) | 624-671 | всегда |
| 4 | — | «Окно и уведомления» (`setWindowTitle`) | 673-711 | всегда |
| 5 | `memorySettings` | «Память» (`setMemoryTitle`) | 713-727 | всегда; содержимое зависит от `has('memoryList')` |
| 6 | `remindersSettings` | «Напоминания» (`setRemindersTitle`) | 729-741 | всегда; зависит от `has('remindersList')` |
| 7 | `extensionsSettings` | «Расширения» (`setExtensionsTitle`) | 743-797 | всегда; блоки деградируют по `has(...)` |
| 8 | — | «Вид» (`setLookTitle`) | 799-845 | всегда + в него инжектятся строки `accent.js`, `look.js`, `orb-tune.js` |
| 9 | — | «Рабочая папка» (`setFolderTitle`) | 847-858 | всегда |
| 10 | `settings-model` | «Модель и связь» (`setModelTitle`), `tabindex="-1"` | 860-875 | всегда; **это статус, а не выбор модели** |
| 11 | `ownerProviders` | «Провайдеры владельца» (`setOwnerTitle`) | 877-891 | **hidden**, показывается только в owner-сборке |
| 12 | — | «Разговор» (`setChatTitle`) | 893-899 | всегда |

Вне `.page.settings`: `nav#setNav` (587) с пустым `ul#setNavList` — его строит `settings-nav.js`.
`#settingsDot` (в рейле, `index.html:62`) — индикатор «нет ключа/нет связи», управляется `app.js renderLink`.

## 2. Статические контролы по разделам

### 2.1 Режим доступа (590-606)
| Контрол | Тип | Что пишет | Читается |
|---|---|---|---|
| 3 radio `name="mode"` values `full/ask/auto` | radio | `setMode` → main `mode:set` (`main.js:2677`) → `saveSettings({mode})` (`main.js:1433`) | `state:get` → `{mode}` (`main.js:2617`), `app.js loadState/renderMode` (`1009-1067`) |

### 2.2 Почта Gmail (608-622, `#mailSettings` скрыт)
| id | Тип | Что пишет | Читается |
|---|---|---|---|
| `mailStatus` | статус-текст | — | `mailState` (`main.js:3616`), `refreshMail` (`app.js:1339`) |
| `mailConnect` | button | `mailConnect(read)` (`preload.js:24`; channel `mail:connect`) | — |
| `mailRead` | switch | передаётся как `read` в `mailConnect`; сам не сохраняется | `mailState.readable` (`gmail.canRead()`) |
| `mailDisconnectRow` (div, hidden) | условный ряд | — | `hidden = !connected` |
| `mailDisconnect` | button | `mailDisconnect` (`preload.js:25`) | — |

### 2.3 Ответы (624-671)
| id / атрибут | Тип | Что пишет | Читается |
|---|---|---|---|
| `data-setting="voice"` | switch | `setSetting voice` (`settings:set`) → `settings.json.voice` | `settings:get.voice` |
| `voiceTest` | button | `voiceTest` (`voice:test`, `main.js:1065`) | — |
| `voiceVolume` (range 0-100 шаг 5) | range | `setSetting voiceVolume` (0..1, проверка в `settings:set` `main.js:2716`), `applyVoiceOptions` | `settings:get.voiceVolume` |
| `voiceVolumeHint` | текст «N %» | — | — |
| `voiceRate` (range 0.5-2 шаг 0.1) | range | `setSetting voiceRate` (0.5..2) | `settings:get.voiceRate` |
| `voiceRateHint` | текст | — | — |
| `voiceSpeaker` (select) | select | `setSetting voiceSpeaker` (string\|null, ≤80) | `settings:get.voiceSpeaker`; список — `voiceVoices` (`main.js:1106`) |
| `voiceList` | button | — (загружает голоса в select) | `voiceVoices` |
| `voicePickHint` / `voicePersonaHint` | подсказки | — | `voiceState` (`main.js:1085`) |
| `voicePersona` (select: neutral/butler/assistant/engineer) | select | `setSetting voicePersona` (id\|null) | `settings:get.voicePersona` (`resolvePersona`) |
| `voiceOptionsNote` (p hidden) | заметка об ошибке/старом ядре | — | `has('voiceState')` |
| `data-setting="terseReplies"` | switch | **сейчас НЕ пишет**: `app.js:26 SETTING_KEYS` не содержит `terseReplies`, `changeSetting` выходит (`app.js:760`). Ядро ключ поддерживает (`main.js:2683`) — реальный баг, см. §10 | `settings:get.terseReplies` (main), но в `S.settings` не попадает |
| `data-setting="dictation"` (`id="setDictation"` — id не используется) | switch | `settings:set dictation` | `settings:get.dictation`; видимость — `syncDictationVisible` (`app.js:2496`) |
| `data-setting="alwaysListen"` | switch | `settings:set alwaysListen` → `startDictation/stopDictation` | `settings:get.alwaysListen`; `startDictation` при старте (`main.js`) |

### 2.4 Окно и уведомления (673-711)
Все — `data-setting`, булевы ключи `settings.json` через `settings:set`; чтение `settings:get`:

| data-setting | side-effect в main |
|---|---|
| `quiet` | без уведомлений/звуков |
| `motion` | `applyMotion(win.webContents)` |
| `alwaysOnTop` | `win.setAlwaysOnTop(value)` |
| `desktopOverlay` | `openMini()/closeMini()` (мини-шар на столе) |
| `autoStart` | `app.setLoginItemSettings({openAtLogin})` (читается из системы, не из settings.json) |
| `screenAuto` | в настройках |
| `memoryAuto` | авто-память |
| `setKeepAwake` (select off/while-working/always) | `setSetting keepAwake` (`main.js:2743`) → `saveSettings({keepAwake})` + `keepAwake.setMode` |

### 2.5 Память (713-727)
| id | Тип | Данные |
|---|---|---|
| `memoryCount` | counter | `memoryList` |
| `memoryList` | ul (динамика) | `memoryList` (`main.js:2848`); правка/удаление — `memoryUpdate`/`memoryRemove` (`main.js:2862/2873`), диалог `#memoryDialog` — **вне** настроек |
| `memoryEmpty`, `memoryNote` | note (hidden) | — |
| `memoryReload` | button | `memoryList` |
| `memoryClear` | button (двойное подтверждение? нет — сразу `memoryClear true`) | `memoryClear` (`main.js:2882`) |

### 2.6 Напоминания (729-741)
`remindersCount`, `remindersList`, `remindersEmpty`, `remindersNote`, `remindersReload` → `remindersList` (`main.js:2897`); отмена — `remindersCancel` (`main.js:2918`).

### 2.7 Расширения (743-797)
| id | Тип | Данные |
|---|---|---|
| `clipCount`/`clipList`/`clipEmpty`/`clipNote` | список буфера | `clipboardHistoryList` (`main.js`, канал `clipboard-history:list`) |
| `clipEnabled` | switch | `setSetting clipboardHistory` (main SETTING_KEYS) — вкл/выкл слежение |
| `clipTtl` (select 15м/1ч/1д/бессрочно) | select | `clipboardHistoryTtl` → `clipboardHistory.setTtl`, хранится в файле истории буфера (`src/extensions/clipboard-history.js`), **не** в settings.json |
| `clipPause` | button | `clipboardHistoryPause/Resume` (`paused` в файле истории) |
| `clipReload`/`clipClear` | buttons | `clipboardHistoryList/Clear` |
| `snipCount`, `snipList`, `snipEmpty`, `snipError` | список | `snippetsList/Save/Remove/Preview/Insert` (`snippets.json`) |
| `snipForm` (`snipTrigger`, `snipText`, `snipSave` submit) | form | `snippetsSave` |
| `dlAnalyze`, `dlRemove`, `dlNote`, `dlList` | buttons/list | `downloadsAnalyze/Remove` (`downloads:analyze/remove`) |

### 2.8 Вид (799-845)
| Контрол | Тип | Что пишет | Где хранится/кто читает |
|---|---|---|---|
| `themeSeg` + 23 × `data-theme-opt` (804-826) | radio-кнопки | `app.js setTheme` (`1175-1188`) | `localStorage jarvis.theme`; `theme-boot.js:233`; применение `JarvisTheme.apply` |
| `orbPick` + 3 × `data-orb-opt` (832-834) | radio-кнопки | `app.js setOrbVariant` (`553-563`) | `localStorage jarvis.orbVariant` (через `store`, `app.js:32-44`); шар — `window.JarvisOrb` (`orb.js`) |
| `data-local="orbAnim"` (839) | switch | `app.js:685-691` | `localStorage jarvis.orbAnim`; пишет `html[data-motion]` (`app.js:571-579`); читают оба шара (`orb-nox.js:304-314`) и `mini.js:61` |
| `orbAnimHint` | подсказка | — | — |
| `openClassic` | button | — | `nox-screen.js:456-460` → `window.JarvisNox.show('dialog')` (`app.js:4881`) |

Инжектится в этот раздел:
- `accent.js` — ряд `.accent-row` после первого `.orb-pick-row` (`accent.js:10-14,122`): 8 кружков + HEX; пишет `localStorage jarvis.accent` (`theme-boot.js:104-106`), читает `getAccentInfo`; события `jarvis:accent`.
- `look.js` — **12 строк** `.look-row` после `.accent-row`/`.orb-pick-row` (`look.js:10,77-98`): `data-look-key` = `ui, head, reply, size, round, panel, blur, bg, winAlpha, winRadius, orb, glow`; + кнопка `#lookResetTheme` («Сбросить к теме» → `resetToTheme`); пишет `localStorage jarvis.look` (`theme-boot.js:212-228`); значения `FONTS/SIZES/ROUNDS/PANELS/BLURS/BGS/WIN_ALPHAS/WIN_RADII/ORBS` (`theme-boot.js:117-151`).
- `orb-tune.js` — блок `.orb-tune` после `.set-row`, содержащего `#orbPick` (`orb-tune.js:51-56`): на каждый вид (`core`,`iris`,`sphere`) свои `data-tune` = `glow, speed, motion, depth, voice(Gain)` + у sphere `density`; кнопка «Как было»; пишет `localStorage jarvis.orbTune` (`orb-tune.js:7,38-46`), событие `jarvis:orbtune`; читает **только классический** `orb.js` (`orb.js:109,223,248`).

### 2.9 Рабочая папка (847-858)
| id | Тип | Данные |
|---|---|---|
| `workspacePath` | текст пути | `settings:get.workspace` (`workspaceHub.chat().root()`) |
| `workspaceOpen` | button | `openWorkspace` (`workspace:open`, `main.js:2081`) |
| `folderAdd` | button | `addFolder` (`folders:add`, `main.js:2117`) → диалог выбора; сохраняется `saveSettings({connectedFolders})` (`main.js:2112`) |
| `folderList` | div (динамика) | `settings:get.connectedFolders`; «Отключить» → `removeFolder` (`folders:remove`, `main.js:2128`) |

### 2.10 Модель и связь (860-875) — статус, не выбор
| id | Тип | Данные |
|---|---|---|
| `brainState` (`data-ok`), `brainStateText`, `brainModel` | статус | `state:get` → `{mode, model:'', hasKey}` (`main.js:2617`); `app.js renderLink` (`1088-1120`) |
| `coreState` | текст «ядро: на связи/…» | `app.js renderLink` |
| `brainRecheck` | button | повтор `loadState` (`app.js:1391-1397`) |
| `brainHint`, `brainHintOwner` | подсказки | `brainHint.hidden = hasKey !== false`; owner-подсказка только в owner-сборке |

**Выбора «Быстрая/Умная» и уровня обдумывания в Настройках нет** (см. §6).

### 2.11 Провайдеры владельца (877-891, `#ownerProviders` скрыт)
`ownerProvNone` (button «Без провайдера»), `ownerProvList` (динамика: «Выбрать»/«Удалить»),
`ownerProvForm` (input name/baseUrl/model/key + submit) → всё через `ownerProviders` (`owner:providers`,
`main.js:2780`; данные — `providers.json`, только owner-сборка). Показывается `renderOwner`
(`app.js:1295-1307`).

### 2.12 Разговор (893-899)
`chatClear` (+`chatClearText`) — двойное нажатие (`app.js clearChat 1309-1337`) → `clearChat`
(`chat:clear`, `main.js:2049`).

## 3. Что читают модули (id-контракты, нельзя терять)

| Модуль | Id/селекторы внутри настроек |
|---|---|
| `app.js` (52 id) | `settings-mode`, `settings-model`, `modeOptions` (+`input[name="mode"]`), `mailSettings, mailStatus, mailRead, mailConnect, mailDisconnectRow, mailDisconnect`, `voiceTest, voiceVolume, voiceVolumeHint, voiceRate, voiceRateHint, voiceSpeaker, voicePickHint, voicePersona, voicePersonaHint, voiceOptionsNote, voiceList`, `setKeepAwake`, `themeSeg` (+`[data-theme-opt]`), `orbPick` (+`[data-orb-opt]`, `.theme-mini canvas`), `orbAnimHint`, `memoryList, memoryCount, memoryEmpty, memoryNote, memoryReload, memoryClear`, `remindersList, remindersCount, remindersEmpty, remindersNote, remindersReload`, `workspacePath, workspaceOpen, folderAdd, folderList`, `brainState, brainStateText, brainModel, brainHint, brainHintOwner, brainRecheck, coreState`, `ownerProviders, ownerProvNone, ownerProvList, ownerProvForm`, `chatClear, chatClearText`; плюс `#settingsDot` в рейле |
| `extensions.js` (22 id) | `extensionsSettings`, `clipEnabled, clipTtl, clipPause, clipReload, clipClear, clipList, clipNote, clipCount, clipEmpty`, `snipForm, snipTrigger, snipText, snipSave, snipList, snipCount, snipEmpty, snipError`, `dlAnalyze, dlRemove, dlNote, dlList` |
| `look.js` | `setLookTitle`; `#setLookTitle.closest('.set-section')`; первый `.accent-row` или `.orb-pick-row` как якорь вставки; селекторы `select[data-look-key]`, `.look-seg`, `input[data-look-key]` |
| `accent.js` | `setLookTitle`; первый `.orb-pick-row` в этом разделе — якорь вставки; `#accentLabel` создаёт сам |
| `orb-tune.js` | `orbPick`; `#orbPick.closest('.set-row')` — якорь; `#orbPick [aria-checked="true"]`; свой `.orb-tune` |
| `settings-nav.js` | (контракт phase 1) `document.querySelector('.view-settings')`, `#setNavList`; **прямые дети** `.page.settings` с `querySelectorAll('.page.settings > .set-section')` и `.set-title`. В phase 2 модуль переписан — актуальные контракты в §10 |
| `account.js` | `#accountPage` (вид «Аккаунт»); **fallback**: если `#accountPage` нет — вставляет свою `.set-section` перед первым `[data-view="settings"] .set-section` (`account.js:133-140`). Т.е. при переносе `#accountPage` панель аккаунта окажется в Настройках |
| `nox-screen.js` | `openClassic`, `setLookTitle` (прокрутка к «Вид») |
| `theme-boot.js` / `shared.js` | вне настроек, но на них всё завязано (`JarvisTheme`, `JarvisUI`) |

Порядок скриптов (`index.html:22-45`): `theme-boot` (без defer) → `shared` → `orb` → `orb-variants` → **`orb-tune`** → `contour` → `cmd-steps` → `desks` → `extensions` → `app` → `account` → `model-pick` → **`accent`** → **`look`** → `connections` → `settings-nav` → `orb-nox` → `nox-screen` → `nox-commands` → `nox-connections`. `accent.js` обязан быть до `look.js` (look ищет `.accent-row`), `orb-tune.js` — до `app.js` (app читает `window.JarvisOrbTune`… фактически шар читает; порядок важен для `#orbPick` на момент выполнения).

## 4. Куда пишутся настройки (сводно)

| Хранилище | Ключи | Контролы |
|---|---|---|
| `settings.json` (main `readSettings/saveSettings`, `SETTINGS_FILE`) | `mode` | режим доступа (setMode) |
| | `voice, quiet, alwaysOnTop, autoStart, screenAuto, memoryAuto, motion, dictation, clipboardHistory, desktopOverlay, alwaysListen, terseReplies` (`main.js:2683`) | соответствующие `data-setting` + `clipEnabled` |
| | `keepAwake` (`off/while-working/always`) | `#setKeepAwake` |
| | `voiceVolume` (0..1), `voiceRate` (0.5..2), `voiceSpeaker` (string\|null), `voicePersona` (id\|null) | слайдеры/селекты «Ответы» |
| | `modelTier` (`fast/smart`), `thinking` (`low/medium/high`) | `settings:setModelTier`/`setThinking` (UI — вне Настроек, §6) |
| | `connectedFolders` | `folderAdd`/`folderList` |
| `localStorage` (окно, только этот компьютер) | `jarvis.theme` (id темы) | `themeSeg` |
| | `jarvis.accent` (`theme`\|id\|`#RRGGBB`) | `accent.js` |
| | `jarvis.look` (12 ключей look) | `look.js` (+`resetToTheme`) |
| | `jarvis.orbVariant` (`core/iris/sphere`) | `orbPick` |
| | `jarvis.orbAnim` (bool) | `orbAnim` |
| | `jarvis.orbTune` (`{core,iris,sphere}:{glow,speed,motion,depth,density,voice,voiceGain}`) | `orb-tune.js` (только классический шар) |
| | `noxOrb` (`nox/wire`) | **только dev-API** `NoxScreen.setVariant`/`#orb=wire`; в UI нет |
| Файлы данных через IPC | `clipboard-history.json` (items/paused/ttlMs) | `clipEnabled`, `clipTtl`, `clipPause`, `clipClear` |
| | `snippets.json` | `snipForm` и кнопки списка |
| | `memory.json` / `reminders.json` | списки памяти/напоминаний |
| | `providers.json` (owner) | `ownerProvForm`/список |
| | `gmail.bin` | `mailConnect`/`mailDisconnect` |
| | аккаунт (сервер/сессия, `account.bin`) | панель «Аккаунт» (`account.js`), баннер лимита |
| Только отображение | `mailStatus`, `brainState/brainStateText/brainModel/coreState`, `workspacePath` (текст), счётчики и пустые состояния списков, `voice*Hint`, `orbAnimHint`, `themeLabel`, `orbPickLabel`, образцы тем/шара (canvas) | — |

Условные/скрытые: `#mailSettings` (методы моста), `#ownerProviders` (owner-сборка), `#mailDisconnectRow` (connected),
`#brainHint` (нет ключа), `#brainHintOwner` (owner), `voiceOptionsNote`, `memoryEmpty/memoryNote`,
`remindersEmpty/remindersNote`, `clipNote/clipEmpty`, `snipError/snipEmpty`, `dlNote`/`dlRemove.disabled`,
`#settingsDot` (рейл), гейт входа и баннер лимита (`account.js`, вне настроек).

## 5. tests: что читает настройки/влияет на редизайн

Полный список тестов, которые читают `index.html`/`app.js`/модули настроек как текст или гоняют их в песочнице.
Вердикты — при условии: оборачиваем/перегруппировываем **только** `.view-settings`, добавляем поиск/чипы и
`renderer/nox-settings.css/js`; id/строки из таблицы сохраняем.

### WILL BREAK (если не сделать заранее)
| Файл:строки | Что проверяет | Вердикт/причина |
|---|---|---|
| `tests/project-map.test.js:17-28` | каждый файл `renderer/**` c `.js/.html/.css` (кроме `*.test.js`) — в корневом `AGENTS.md` в бэктиках; каждый бэктик-путь существует | **WILL BREAK** при создании `renderer/nox-settings.css` и `renderer/nox-settings.js`: добавить `` `renderer/nox-settings.css` `` и `` `renderer/nox-settings.js` `` в `AGENTS.md` **после** создания файлов. Любой новый renderer-файл — так же. Правило и текущие строки — см. `docs/reconstruction/phase3/commands-ui-audit.md §4`. |

### RISK (сломается при переформатировании/переименовании)
| Файл:строки | Точная зависимость | Что нельзя делать |
|---|---|---|
| `renderer/themes.test.js:34-44,94,102-106` | `index.html`: кнопки тем **одной строкой** `data-theme-opt="<id>" ... </span><Имя></button>`; `<div class="theme-fx" aria-hidden="true"></div>`; у каждой темы есть кнопка; нет `archive/tablet/acrylic` | Переформатировать 23 кнопки тем (перенос строк внутри), убрать/переименовать `data-theme-opt`, переносить `theme-fx`. Перегруппировка разделов безопасна, если строки кнопок не трогать |
| `tests/orb-styles.test.js:60-68` | `index.html`: `data-orb-opt="([a-z]+)"[^>]*><canvas[^>]*></canvas>([^<]+)<`; порядок `orb-variants.js < orb-tune.js < app.js`; `app.js` дословно `function defaultOrb() { return 'core'; }` и `raw === 'reactor' ? 'core' : raw`; в html нет «Реактор» | Менять разметку кнопок вида шара, порядок скриптов, эти строки в `app.js` |
| `tests/orb-styles.test.js:114-135,236-239` | `orb-tune.js`: `window.JarvisOrbTune` (get/set/normalize), `localStorage jarvis.orbTune`, ключи core/iris/sphere | Переписывать/переносить логику orb-tune в новую модуль без сохранения API (модуль исполняется в песочнице) |
| `tests/look.test.js:12-14,79-150` | `look.js` дословно содержит `row('Прозрачность окна'`, `seg('winAlpha', T.WIN_ALPHAS`, `row('Радиус окна'`, `seg('winRadius', T.WIN_RADII`, `resetToTheme`, фразу «прозрачность и радиус окна»; `theme-boot.js` + `presence.css` переменные | Переписывать `look.js`/менять подписи этих строк без правки теста. Новые строки look добавлять можно |
| `tests/appearance.test.js:12-13,79-224` | `theme-boot.js` + `themes.css`: темы, `jarvis.look`, `jarvis.accent`, `resetToTheme`, контраст | Трогать `theme-boot.js`/`themes.css` (в объём редизайна не входят) |
| `tests/keep-awake.test.js:96-103` | `index.html` `id="setKeepAwake"` и `value="while-working"`; `app.js` строки `setKeepAwake`, `setSetting', 'keepAwake'` | Переименовать/заменить select keep-awake или унести его wiring в новый модуль без сохранения строк в `app.js` |
| `tests/overlay-listen.test.js:26,37-38,47-49` | `index.html` `data-setting="desktopOverlay"`, `data-setting="alwaysListen"`; `app.js` `'alwaysListen'`; `app.js` `Напомнить: `, `if (has('remindersList')) loadReminders()` | Менять data-setting-имена, убирать/переносить эти строки из `app.js` |
| `tests/memory-learn.test.js:140-141` | `index.html` `data-setting="memoryAuto"` | Переименовывать/переносить тумблер |
| `tests/home-taste.test.js:9-11,32-45,85-98` | `index.html`: `<ol class="scene-list">` с 3 `data-scene-draft`, `01/02/03`, `<p class="scene-name">Джарвис</p>`, нет `scene-chips`; `presence.css` правила | Глобально переформатировать/перестраивать `index.html` (чат/главную) или `presence.css` |
| `tests/computer-use.test.js:286-298` | `index.html`: `<div class="hands-banner" id="handsBanner" hidden>…</div></div>`, `href="hands.css"`; `app.js` `case 'hands':…banner.hidden` | Трогать баннер/подключение hands.css/ветку `case 'hands'` |
| `tests/orb-life.test.js:160-163` | `app.js` режется по `'  function initChat() {'` и `'\n  // Готовые фразы'` | Перемещать `initChat`, переформатировать `app.js` целиком |
| `tests/tiers.test.js:59-63` | в `index.html`, `app.js`, `account.js`, `model-pick.js`, `mini.html` нет `/deepseek|minimax|deepinfra|digitalocean/i` | Упоминать провайдеров/модели в новой разметке/`app.js` (правило продукта) |
| `tests/validate-connections.test.js:25-27` (+`src/validate/connections.js:106-114`) | В `index.html` должны остаться id, которые использует `renderer/connections.js` (литералы: `mcpList`, `mcpEmpty`, `mcpForm`, `mcpFormNote`) и `data-view="mcp"`; все `api.*` методы — в `preload.js` | Ломать раздел «Подключения» или переименовывать его id при перестройке `index.html` |
| `tests/second-hands.test.js:379-380,392-397` | `app.js`: `side.reply`, `setWindowBackground`, `'#00000000'`, `winAlpha`, `winRadius` | Удалять/переписывать эти строки в `app.js` |

### SAFE (настройки напрямую не проверяют)
- `tests/appearance.test.js` — только `theme-boot.js`/`themes.css` (SAFE, пока их не трогаем).
- `tests/look.test.js` — `theme-boot.js`, `look.js`, `presence.css`; чистый CSS/песочница.
- `tests/orb-a11y.test.js`, `tests/orb-life.test.js` (кроме app.js-маркера), `tests/orb-styles.test.js` (кроме строк выше) — `orb.js`/`orb-nox` не в объёме.
- `tests/humanize.test.js`, `tests/verify-status.test.js` — `renderer/shared.js` в vm.
- `tests/settings-atomic.test.js` — `src/config/atomic.js`, не UI.
- `tests/delivery.test.js:40-41`, `tests/personas.test.js:68-76`, `tests/owner-providers.test.js:84-85`, `tests/memory-learn` (main-часть) — читают `main.js`, а он не меняется.
- `tests/mcp-catalog.test.js`, `tests/connections-view.test.js` — раздел «Подключения».
- Тесты данных памяти/напоминаний/буфера/вставок/загрузок (`memory.test.js`, `reminders.test.js`,
  `extensions-*.test.js`) — backend `src/`, renderer не читают.
- `tests/project-map.test.js` — кроме новых файлов (§ выше), весь остальной список уже на карте.

**Хорошая новость:** ни один тест не проверяет текст/структуру `.view-settings` (заголовки, порядок разделов,
состав контролов). Свободно: обёртки, заголовок с поиском/чипами, 6 категорий через `data-*`, порядок
разделов, новые классы — при сохранении id/data-setting/строк из RISK выше.

## 6. Модель и обдумывание — где реально живёт выбор

Сейчас **в Настройках выбора нет**. Раздел «Модель и связь» (`#settings-model`) — только статус связи
(`brainState`, `coreState`, `brainRecheck`). Реальный выбор — у поля ввода, его строит
`renderer/model-pick.js`:

| Что | Где | Как |
|---|---|---|
| UI «Модель: Быстрая/Умная» | `model-pick.js:60,97-105` | fieldset-радио `name="pick-model"` values `fast/smart`; панель `#pickPanel`, триггер `#pickTrigger` |
| UI «Обдумывание: Кратко/Обычно/Глубоко» | `model-pick.js:61` | `name="pick-level"` values `low/medium/high` |
| Запись | `preload.js:36-37` `setModelTier`/`setThinking` → `main.js:2771` `settings:setModelTier` / `main.js:2789` `settings:setThinking` → `saveSettings({modelTier})` (`2774`) / `saveSettings({thinking})` (`2791`) | **`settings.json`** |
| Чтение | `settings:get` (`main.js:2685`) возвращает `modelTier` и `thinking`; `model-pick.js mount()` делает `api.getSettings()` (`102-104`); `app.js loadSettings` тоже читает `modelTier` → `S.tier` (`1036`), но только для легаси-UI | `settings.json` |
| Легаси-UI в Настройках | `app.js renderTier/initTier/changeTier` (`1124-1251`) ждёт `[data-tier]`/`#tierSeg` — **в `index.html` их нет**, поэтому это no-op | мёртвый код |

Для редизайна: «Модель» и «Обдумывание» **можно сделать настоящими** без нового IPC — читать
`getSettings()` (`modelTier`, `thinking`), писать `setModelTier('fast'|'smart')` и
`setThinking('low'|'medium'|'high')`. Подсказки о расходе лимита уже есть в `model-pick.js:12` (`COST`).
`state:get` этих полей не отдаёт — только `settings:get`.

## 7. Сфера Nox и «Вид шара» — что реально работает

### 7.1 Экран Nox (по умолчанию, `body[data-view="nox"]`, `#noxOrb`/`#noxSphere`)
`window.NoxOrb` (`renderer/orb-nox.js`):
| Возможность | Есть? | Механизм |
|---|---|---|
| Вариант | **2**: `'nox'` (точки с ядром) и `'wire'` (проволока) | `new NoxOrb(canvas,{variant})`, `setVariant/getVariant` (`orb-nox.js:200-211`); `window.NoxScreen.setVariant/getVariant` (`nox-screen.js:333-350,581-588`); хранится `localStorage noxOrb`, hash `#orb=wire`; в UI переключателя нет (dev/hotkey `Ctrl+Alt+O`, `nox-screen.js:464`) |
| Анимация | **есть** | `animated`; `html[data-motion="off"]` — настройка `orbAnim`; `NoxOrb` наблюдает `data-motion` (`orb-nox.js:304-314`), `ignoreSystemMotion=true` (`nox-screen.js:310`) — системное «уменьшить движение» игнорируется |
| Состояние | есть | `setState` (8 состояний), `setVoice`, `pulse` |
| Размер | **нет пользовательской настройки** | жёстко `scale: 0.86` в `nox-screen.js:312`; API принимает `scale` (0.05..6) в конструкторе, но из настроек не читается |
| Яркость/свечение/скорость/плотность точек | **API нет** | внутренние `MOTION[state]`/`PALETTE[state]` (`orb-nox.js:59-68`), никаких сеттеров |
| `jarvis.orbTune` | **не влияет** на Nox-сферу | `nox-screen.js:322` на `jarvis:orbtune` делает только `orb.setAnimated(motionOn())`; значения `JarvisOrbTune.get()` не читает |

Итог: в новых Настройках для сферы Nox **честно реальны** только «Вариант» (2 шт., через
`NoxScreen.setVariant`, сохранять в `noxOrb`) и «Анимация» (общий `orbAnim`). Слайдеры
размера/свечения/скорости/плотности для Nox-сферы будут **только предпросмотром** (fake), пока не расширен
`orb-nox.js`.

### 7.2 Классический экран (`data-view="dialog"`, `#orb`/`#stageOrb`)
`window.JarvisOrb` (`orb.js`): 3 вида `core/iris/sphere` (`#orbPick`, `localStorage jarvis.orbVariant`),
размер `--orb-scale` из `jarvis.look.orb` (`theme-boot.js:193`), и **настройки вида**
`jarvis.orbTune` (glow/speed/motion/depth/voice/voiceGain, у sphere density) через
`window.JarvisOrbTune` (`orb-tune.js:48`) и событие `jarvis:orbtune` (`orb.js:223`). Это реально — но
**только для классического экрана**, не для Nox.

`orbAnim` (data-motion) реально влияет на оба шара. `openClassic` открывает классический экран
(`nox-screen.js:456-460` → `window.JarvisNox.show('dialog')`).

## 8. Ловушки/уже существующие баги, которые полезно знать до редизайна

1. **`terseReplies` не сохраняется из окна:** в разметке есть `data-setting="terseReplies"`
   (`index.html:661`), main ключ поддерживает (`main.js:2683`), но `app.js SETTING_KEYS` (`app.js:26`)
   его не содержит → `changeSetting` выходит (`app.js:760`), тумблер не работает и всегда выключен
   (`syncToggles`). Редизайн может починить (добавить ключ в список или отдельный обработчик).
2. **`keepAwake` пишется, но не восстанавливается:** `settings:set keepAwake` сохраняет
   (`main.js:2743-2747`), но `settings:get` (`main.js:2685-2714`) **не возвращает** `keepAwake` →
   после перезапуска `#setKeepAwake` показывает «Пока работает» по умолчанию. Чинится добавлением поля
   в `settings:get` (main.js, вне моего объёма) либо отдельным чтением.
3. **`#tierSeg`/`[data-tier]`** — мёртвый легаси-UI в `app.js`; не искать его в разметке.
4. **`orb-tune.js` пишет `jarvis.orbTune`, но Nox-сфера его не читает** (см. §7) — не выдавать
   настройки orb-tune за настройки Nox-сферы.
5. **`#accountPage`:** `account.js` при его отсутствии вставит панель аккаунта в Настройки перед первым
   `.set-section` (`account.js:135-140`). Если при редизайне аккаунт переносится в Настройки — согласовать
   с `account.js` и `settings-nav.js`.

## 9. Чек-лист редизайна (to not break)

1. Сохранить все `id`, `data-setting`, `data-local`, `data-theme-opt`, `data-orb-opt`, `data-look-key`
   (динамические), `name="mode"`, `[data-tier]` не нужен.
2. ~~Сохранить у каждого `.set-section` **прямого ребёнка** `.page.settings` класс `.set-title`~~
   (устарело после phase 2: новый `settings-nav.js` ищет `:scope > .set-section` внутри `#settingsPage`,
   у каждой карточки `data-cat` + `.set-title`; актуальные контракты — §10).
3. Сохранить в разделе «Вид»: `#setLookTitle` в `.set-section`, первый `.orb-pick-row` (для accent),
   `.orb-pick-row`/`.accent-row` как якоря look/accent, `#orbPick` внутри `.set-row` (orb-tune).
   Либо переписать эти модули вместе (тесты look.js/orb-tune требуют API/строк — см. RISK).
4. `#settings-mode` и `#settings-model` остаются scroll-таргетами (`app.js:442,456`).
5. 23 кнопки тем — оставить однострочными, с теми же `data-theme-opt` и подписями (themes.test).
6. Новые файлы `renderer/nox-settings.css`/`js` — сразу строки в корневом `AGENTS.md`.
7. Не переформатировать блоки чата/главной/баннера рук/`hands.css`, `theme-fx`, `scene-list`,
   `data-view="mcp"` id, `preload`-методы.
8. Не упоминать модели/провайдеров в UI (только «Быстрая»/«Умная»).

---

## 10. Phase 2 (после «renderer ready»): что стало и что закреплено тестами

Редизайн внесён лидом: `renderer/settings-nav.js` переписан, добавлены `renderer/nox-settings.js`,
`renderer/nox-settings.css` и новая разметка `.view-settings`; правки ядра — `renderer/app.js`,
`main.js`, `renderer/model-pick.js`; строки `AGENTS.md` для `nox-settings.*` добавлены.

### 10.1 Новая структура (index.html)
- Панель: `#setPanel` → `#setHead` (заголовок, `#setStatus`, `.nox-win-controls`) → `#setBody`
  (`aside#setNav` с `#setSearch`, `#setChips`, `#setNavHead`, `#setNavList`) → `main#setMain`
  (`#setError`/`#setErrorText`, `#settingsPage`, `#setNoMatches`).
- **14** карточек `.set-section` с `data-cat`; распределение: `general` 3, `ai` 3, `voice` 3,
  `look` 1, `sphere` 1, `security` 3. Новые: `#settings-ai` (модель/мышление), `#settings-sphere`
  (вариант + честное превью). Все прежние id/`data-setting` сохранены (регрессионный страж в тесте).
- Новые id: `setPanel, setHead, setBody, setStatus, setError, setErrorText, setSearch, setChips,
  setNavHead, setNavList, setMain, settingsPage, setNoMatches, settings-ai, setModelTier, setThinking,
  setModelHint, setThinkingHint, settings-sphere, sphereVariant, sphereSize, sphereGlow, sphereSizeValue,
  sphereGlowValue, sphereReset, sphereApply, spherePreview`; 3 элемента `data-preview-only="true"`;
  `#sphereApply` `disabled`; 23 `data-theme-opt`, 3 `data-orb-opt`, 11 `data-setting` на месте.

### 10.2 Контракты `settings-nav.js` (его тестов раньше не было)
- Вход: `document.querySelector('.view-settings')` + id `setNav, setNavList, setMain, settingsPage`;
  опционально `setSearch, setChips, setNoMatches, setNavNote`.
- Секции: `page.querySelectorAll(':scope > .set-section')`; категория — `section.dataset.cat`
  (неизвестная → `general`), порядок карточек = порядок категорий `general, ai, voice, look, sphere, security`.
- Категории (кнопки `#setNavList .set-nav-item`, `dataset.cat`): `general/ai/voice/look/sphere/security`;
  активная — `aria-current="true"`.
- Чипы `[data-set-chip]` (`#setChips`): `all: null`, `ai: ['ai']`, `look: ['look','sphere']`, `voice: ['voice']`;
  `aria-pressed` синхронизируется.
- Классы фильтрации: карточка — `set-cat-hidden`, строка — `set-filtered`, пустое состояние —
  `is-hidden` на `#setNoMatches`. Атрибут `hidden` не трогается (его использует ядро для почты/провайдеров).
- Поиск: по `headText` карточки (`:scope > .set-title/.set-subtitle/.set-sub/.set-hint/.set-title-row/.hint`
  + кнопки `.editor-foot`/`.set-sphere-foot`) и по статическим подписям строк (`.set-name/.set-subtitle/.set-hint`);
  личные списки (память/буфер/папки/провайдеры) не читаются. Escape очищает поиск (с `preventDefault/stopPropagation`).
- Публичный API: `window.NoxSettingsNav.{refresh, setCategory, getState}`.

### 10.3 Контракты `nox-settings.js`
- `window.jarvis`: `getSettings` (первичное заполнение), `setModelTier('fast'|'smart')`,
  `setThinking('low'|'medium'|'high')`, `windowControl(action)`.
- Карточка ИИ: значения из `getSettings()` → `#setModelTier/#setThinking` + подсказки;
  после сохранения — событие `document.dispatchEvent(new CustomEvent('jarvis:tier', {detail:{tier,level}}))`,
  его слушает `renderer/model-pick.js` (пикер у поля ввода следует за Настройками).
- Карточка сферы: вариант `wire|nox` — реальный: `window.NoxScreen.setVariant` (fallback —
  `localStorage noxOrb`); размер/свечение — только превью (`data-preview-only`, `localStorage
  jarvis.spherePreview`, canvas `#spherePreview`), `#sphereApply` всегда `disabled`.
- Оболочка: `.nox-win-controls [data-act]` → `windowControl`; `#setStatus` (загрузка/ошибка чтения),
  `#setError/#setErrorText` (ошибки сохранения и тосты `kind==='error'` в разделе настроек, автоскрытие 8 с).

### 10.4 Правки, которые закрыли прежние дыры бага
- `terseReplies` теперь в `app.js SETTING_KEYS` и в дефолте `true` — тумблер «Тише озвучивать очевидное»
  реально сохраняется/восстанавливается.
- `main.js settings:get` теперь возвращает `keepAwake` — `#setKeepAwake` не сбрасывается после перезапуска.
- `model-pick.js` слушает `jarvis:tier` — выбор модели/мышления в Настройках и у поля ввода согласован.
- Осталось как было: легаси `#tierSeg`/`[data-tier]` в `app.js` мёртв (разметки нет); `orb-tune.js`
  по-прежнему настраивает только классический шар, Nox-сфера читает лишь вариант + `data-motion`.

### 10.5 Тесты
- Новый `tests/settings-view.test.js` — **14 тестов**:
  - `settings-nav.js` в песочнице: 6 категорий в порядке и первая активна; раскладка карточек по
    категориям; поиск фильтрует карточки/строки и показывает `#setNoMatches`; чипы ИИ/Вид(вид+сфера)/
    Голос/Все; Escape очищает поиск; клик по категории сбрасывает фильтр.
  - `nox-settings.js` в песочнице: `getSettings` заполняет selects; модель → `setModelTier('smart')`
    и подсказка/`jarvis:tier`; мышление → `setThinking('high')`; отказ ядра → строка ошибки, поле снова активно;
    вариант сферы → `NoxScreen.setVariant('wire')` (+ fallback `localStorage noxOrb`); ползунки только
    превью (`#sphereApply` disabled, `jarvis.spherePreview`), сброс 100/100; кнопки окна → `windowControl`;
    ошибка чтения настроек видна строкой.
  - Статические контракты: `terseReplies` в `app.js`; `keepAwake` в `settings:get`; `model-pick` ↔
    `jarvis:tier`; 14 карточек/категории/все прежние id/11 `data-setting`/23 темы/3 вида шара/превью-пометки.
- Прогоны: полный `node --test` до редизайна — 2126 тестов / 41 suite / 0 fail;
  целевой набор (`settings-view` + `project-map` + `themes` + `orb-styles` + `look` + `keep-awake` +
  `overlay-listen` + `memory-learn` + `connections-view` + `mcp-catalog` + `validate-connections`) —
  133/133 pass; полный после — **2140 тестов / 41 suite / 0 fail** (+14 новых).
- Ограничение фейкового DOM в тесте: свой мини-движок селекторов поддерживает нужные модулям
  конструкции (`.class`, `#id`, `[attr]`, `[attr="v"]`, потомки, `:scope >`, списки через запятую);
  production-селекторы ради теста не менялись.
