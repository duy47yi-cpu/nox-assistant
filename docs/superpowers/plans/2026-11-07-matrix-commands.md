# Этап 2 — команды и повторение действий: матрица, правки, контракт

Исполнитель: `commands`. Зона: `apps/jarvis-desktop/src/commands/`, `src/library/`, `src/tools/commands.js`, `renderer/cmd-steps.js`, тесты в `apps/jarvis-desktop/tests/`, этот отчёт.
Источники требований: `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, `docs/superpowers/plans/2026-11-07-video-analysis.md` (видео 4, 00:09–00:32), `2026-11-07-nox-reference-implementation.md` (этап 2), `2026-11-07-deep-implementation-spec.md` (этап C).
Не менялись: `main.js`, `preload.js`, `renderer/app.js`, `renderer/index.html`, `AGENTS.md`, чужие модули. Коммитов нет. Пакеты не ставились. Настоящие `.env` и `data/` не читались: проверки идут на временных папках (`fs.mkdtempSync`), приложение — на `NOX_DATA_DIR`.

## 1. Как проверялось

- Код читался до правок; для каждого пункта ниже указан файл и функция-доказательство.
- Поведение проверено тестами `node:test` на временных файлах, без сети и без настоящих данных.
- Целевой прогон: `node --test tests/commands.test.js tests/command-editor.test.js tests/command-tools.test.js tests/runner.test.js tests/library.test.js tests/sample-protocols.test.js tests/manifest-validator.test.js` → **90 pass, 0 fail**.
- Полный `node --test` в `apps/jarvis-desktop` → **1611 pass, 0 fail** (финальный прогон после того, как соседняя зона памяти закончила правки).
- Живое окно Electron не проверялось: интерфейс редактора (`renderer/app.js`, `index.html`) в чужой зоне; контракт для интегратора — раздел 6.

## 2. Матрица «что реально есть» (видео 4, 00:09–00:32)

Статусы: **работает** — есть код и тест; **частично** — есть ядро/часть пути; **нет** — отсутствует; **не проверено** — код есть, живого пути нет.

| # | Возможность | Видео/время | Статус | Доказательство в коде | Проверка |
|---|---|---|---|---|---|
| 1 | Список команд, вкладки «Мои»/«Библиотека», выбор, раскрытие шагов | 00:09–00:16 | работает | `renderer/app.js` `renderCmdList` (3036), `loadCommands` (2997), `loadLibrary` (2808), `renderLibrary` (2829); `index.html` 252–273 | `command-editor.test.js`, `library.test.js` |
| 2 | Создание команды вручную (имя, фразы, шаги) | 00:16–00:22 | работает | `app.js` `newCommand`/`saveDraft` (3386), IPC `commands:save` (`main.js` 1878), `CommandStore.save` (`store.js` 468) | `commands.test.js`, `command-editor.test.js` |
| 3 | Редактирование выбранной команды, порядок шагов вверх/вниз, удаление шага | 00:09–00:16 | работает | `app.js` `stepNode`/`move`, `CmdSteps.moveStep` (`cmd-steps.js` 7) | `command-editor.test.js` |
| 4 | Удаление команды (двухшаговое подтверждение) | — | работает | `app.js` `deleteDraft` (3440), IPC `commands:delete` (1892) | `commands.test.js` (store.remove) |
| 5 | Включение/выключение команды | 00:09–00:16 | работает | `app.js` `toggleCommand` (3518); выключенная не находится по фразе (`findByPhrase`) и теперь не запускается даже в обход кнопки (`runner.js` 151) | `commands.test.js` «выключенная команда не выполняется» |
| 6 | Поиск по командам | 00:09–00:16 | частично | поиск есть только в библиотеке: `#libSearch` (`index.html` 259), `initLibrary` (`app.js`); у «Моих» поиска нет | `library.test.js` (загрузка/фильтр), UI «Мои» — нет |
| 7 | Фразы-триггеры, нормализация, уникальность | 00:09–00:16 | работает | `store.js` `normalize`/`checkPhrases`; `findByPhrase`; `command_create` | `commands.test.js` (нормализация, занятая фраза) |
| 8 | Горячие клавиши (запись, канон, занятые, регистрация) | 00:09–00:16 | частично | ядро: `store.js` `checkHotkey`, `RESERVED_HOTKEYS`; регистрация `main.js` `registerCommandHotkeys` (2090-х), `verify` в `command_set_hotkey` | `commands.test.js`, `remote-and-hotkeys.test.js`, `verify-wave2.test.js`; **в редакторе окна поля клавиши нет** — только модель/`command_set_hotkey` |
| 9 | Запуск команды (кнопка, фраза, горячая клавиша) | 00:09–00:16 | работает | IPC `commands:run` (2136), `runCommandNow` (1203), `runCommand` (`runner.js` 151): каждый шаг заново проходит `policy.decide`, затем `checkEffect`/`verify` | `commands.test.js` (policy ask/allow/reject, verify, стоп, ошибка) |
| 10 | Пробный просмотр «Проверить» без запуска | 00:16–00:22 | работает | `app.js` `validateDraft` (3341), `showPreview` (3369), `CmdSteps.describeSteps` (16) | `command-editor.test.js` |
| 11 | Папки и коллекции, дерево команд | 00:09–00:16 | частично | **добавлено в ядро**: `store.js` `folder`/`collections` в схеме, `checkFolder`/`checkCollections`; `cmd-steps.js` `foldersOf`/`groupCommands`; UI-дерева в `app.js`/`index.html` нет (чужая зона, контракт в разделе 6) | `commands.test.js` «папка и коллекции», `command-editor.test.js` «дерево команд» |
| 12 | Импорт с проверкой и предпросмотром | 00:09–00:16 | частично | **добавлено в ядро**: `store.js` `parseCommandPack` (626), `previewCommandImport` (765), `applyCommandImport` (856), `CommandStore.importCommands` (484); UI/IPC нет | `commands.test.js` (preview/конфликт/атомарность/лимиты/версии) |
| 13 | Экспорт без секретов | 00:09–00:16 | частично | **добавлено в ядро**: `store.js` `exportCommandPack`/`exportCommandJson` (711); UI/IPC нет | `commands.test.js` «экспорт: секреты … не выгружаются» |
| 14 | Запись действий: старт/стоп, обзор, предупреждения | 00:22–00:27 | частично | **добавлено в ядро**: `runner.js` `CommandRecorder` (213), `recordOverview` (199); `cmd-steps.js` `stepWarning`/`warningsForSteps`; UI-кнопок записи нет | `commands.test.js` (5 тестов записи) |
| 15 | Создание из текста: план, правка до сохранения, без автозапуска | 00:27–00:32 | частично | **добавлено**: `command_create` с `dryRun: true` (`src/tools/commands.js` 128–197) возвращает редактируемый план и ничего не сохраняет/не запускает; `checkPlanSteps` проверяет имена, обязательные поля, типы, лимиты; каталог действий — `command_list` с `withParameters` (201–236). UI-панели плана нет | `command-tools.test.js` |
| 16 | Библиотека готовых команд (`scripts/commands`) | 00:32–00:36 | работает | `src/library/index.js` `loadLibrary`/`validate`; `access.js` (только проверенные); `validator.js`; IPC `library:list`/`library:run` | `library.test.js`, `manifest-validator.test.js` |
| 17 | Каталог действий только реальных | — | работает | редактор: `tools:catalog` (`main.js` 2153) фильтрует `EDITOR_STEP_TOOLS` (`store.js` 38) по настоящему реестру; тест сверяет с `systemTools`/`desktopTools`/`uiTools` | `command-editor.test.js` «все действия редактора действительно есть…» |
| 18 | Безопасность повтора: policy и `verify` на каждом шаге, отказ виден, стоп, секреты | — | работает | `runner.js`: `decide` (88–113), `checkEffect` (137), отказ/стоп в результатах, журнал через `maskArgsForJournal` (85); журнал дополнительно маскирует секреты (`src/journal/journal.js` 94–106) | `commands.test.js`, `journal-mask.test.js` |

Наблюдаемые пределы (честно):
- Видео — проморолик: счётчики «команд/голосов» из роликов не переносились и не заявляются. В отчёте нет процентов паритета.
- Координатные шаги (`desktop_click`, `mouse_click`, `ui_click`) принципиально ненадёжны при смене окна; в редакторе/записи это предупреждение, а не обещание точного повтора.
- «Мои» без поиска, папки/коллекции/импорт/экспорт/запись/план пока только в ядре — им нужны экранные элементы и IPC (раздел 6), это зона интегратора.

## 3. Что изменено (только своя зона)

### `src/commands/store.js` (900+ строк)
- Схема команды с версией: `COMMAND_SCHEMA_VERSION = 2`, `schemaVersion` в записи, отказ для версии новее текущей **до записи**; старые записи без версии читаются и поднимаются при сохранении.
- Команда хранит `updatedAt`, `folder`, `collections`, `origin` (`manual|recorded|ai|imported|sample`).
- Валидация: имя/фразы/шаги/горячая клавиша (как было), плюс лимиты аргументов (длина строки 8000, вложенность 4, 40 полей, имя поля 60) и размера команды (64 КБ) — `checkSteps`/`walkArgValue`.
- Импорт/экспорт: формат `nox.commands` версии 1; `exportCommandPack`/`exportCommandJson` убирают секретные поля и значения (`apiKey`, `token`, `password`, `sk-…`, приватные ключи), не выгружают `lastRunAt` и согласия; `parseCommandPack` — лимиты файла 1 МБ, 500 команд, 4000 шагов, глубина JSON 8, строгая проверка типов, отказ на чужой формат/будущую версию; `previewCommandImport` — действия `add/update/unchanged/conflict`, diff по полям; `applyCommandImport` требует `confirm === true` и при любом отказе не меняет данные; `CommandStore.importCommands` пишет всё одной атомарной записью.
- `maskArgsForJournal` — копия аргументов для журнала: секретные поля/значения заменяются `[скрыто]`.

### `src/commands/runner.js`
- Причина разрешения больше не содержит `«undefined»` (дефект D1): `commandLabel(cmd, tool)` берёт `name → title → title инструмента → имя инструмента → «действие»`; секрет в названии не показывается (`safeLabel` + `looksSecretEgress`). Офлайн-ярлыки приходят как `{title, steps}`.
- Журнал получает аргументы через `maskArgsForJournal`.
- Выключенная команда (`enabled === false`) не выполняется даже при вызове в обход кнопки.
- `CommandRecorder`: явные `start()/capture()/stop()/cancel()/status()/draft()/overview()/toCommand()`. Ничего не сохраняет и не запускает; опасные и `mission_*`/`command_*` шаги отклоняются; текст, набранный в окне, и секретные поля не пишутся; координатные/оконные шаги получают предупреждение; лимит шагов.
- `recordOverview` и `commandLabel` экспортируются для окна/тестов.

### `src/tools/commands.js`
- `command_create` получил `dryRun: true` — создание из текста: проверенный план (инструменты, обязательные поля, типы, диапазоны, лимиты) без сохранения и запуска; `verify` честно сообщает «план показан, файл не менялся».
- `command_list` с `withParameters: true` — каталог настоящих действий реестра команд (опасные исключены, `editable` = доступно в редакторе окна); без флага поведение прежнее.
- `command_create` проверяет параметры и пишет `origin: 'ai'`, поддерживает `folder`.
- Новых имён инструментов не добавлялось (подписи в `renderer/shared.js` — чужая зона; см. примечание в разделе 7).

### `src/library/index.js`, `src/library/validator.js`
- Пределы библиотеки: манифест ≤ 1 МБ, скрипт ≤ 256 КБ, ≤ 512 записей (загрузчик пропускает лишнее без падения; валидатор сообщает проблемой).
- Логика загрузки/допуска не менялась.

### `src/commands/samples.js`
- Образцы сохраняются с `origin: 'sample'` (видно происхождение, не меняет поведение).

### `renderer/cmd-steps.js` (без DOM)
- Добавлены чистые помощники: `stepWarning`/`warningsForSteps` (координаты, ввод, клавиши), `foldersOf`/`groupCommands` (дерево), `diffLines`/`previewCountsLine`/`canApplyImport` (предпросмотр импорта). Существующие `moveStep`/`describeSteps` не тронуты.

### Тесты (в `apps/jarvis-desktop/tests/`)
- `commands.test.js`: схема/версия/лимиты, папки/коллекции, экспорт без секретов, предпросмотр и diff, отказ без подтверждения и при конфликте, повреждённый/чужой/огромный/глубокий/несовместимый файл, атомарность импорта, вырезание секретов, полный круг экспорт→импорт, выключенная команда, журнал без секретов, лимиты файла, **регресс D1** (офлайн-ярлык без `name/id`, fallback по инструменту, секрет в названии), 5 тестов записи действий.
- `command-editor.test.js`: реальность каталога (сверка с реестром), предупреждения записи, дерево/папки, строки diff и сводка.
- `command-tools.test.js`: план через `dryRun`, отказ на неизвестные/опасные шаги и неверные параметры, каталог действий, `origin: 'ai'`.
- `library.test.js`: огромный манифест/скрипт не загружаются.
- `manifest-validator.test.js`: огромный манифест — проблема, не падение.
- `sample-protocols.test.js`: `origin: 'sample'`, версия схемы, перенос образцов без потерь.

## 4. Дефекты

**D1 (исправлен).** При запуске офлайн-команды диалог разрешения показывал `reason: «команда «undefined»»`: `runner.js` строил причину из `cmd.name ?? cmd.id`, а офлайн-путь `runOfflineNow` передаёт `{title, steps}`. Исправление: `commandLabel` с безопасным fallback; регресс-тесты в `tests/commands.test.js` («офлайн-команда без name/id…», «команда без name и title…», «секрет в названии команды…»).

Найдено при инвентаризации, но не исправлялось (вне минимальных правок / чужая зона):
- «Мои команды» без поиска, редактор без поля горячей клавиши — нужен UI (интегратор).
- Импорт/экспорт/запись/план/дерево — ядро готово, экрана нет.
- `commandReply` и заголовки `runCommandNow` используют только `cmd.name`; офлайн-путь их не вызывает, но при желании интегратора стоит перевести на `commandLabel`.

## 5. Полный прогон

- Финальный `node --test` в `apps/jarvis-desktop`: **1611 тестов, 1611 pass, 0 fail** (20,1 с).
- Во время работы были временные падения в тестах памяти (`tests/memory.test.js`, `src/memory/store.js` правился исполнителем `memory-data` параллельно); после завершения его правок прогон зелёный. К зоне команд эти падения не относились, повторный прогон после слияния зон — за интегратором.
- Целевой прогон зоны команд: **90 pass, 0 fail**.

## 6. Контракт IPC для интегратора (main.js / preload.js / app.js)

Все обработчики — по образцу существующих: проверка `fromWindow(event)`, ошибки возвращаются `{ok:false, error}` (текст можно показывать владельцу), синхронные функции ядра оборачиваются try/catch.

### 6.1 Экспорт
- Канал: `commands:export`, `ipcMain.handle('commands:export', (event) => ...)`.
- Аргументы: нет. Берёт `currentCommandRuntime().store.list()`.
- Возврат: `{ok: true, json: string, fileName: string, warnings: string[]}`; `fileName` вида `commands-2026-11-07.json`.
- Ошибка: `{ok:false, error}` (повреждённый `commands.json` → отказ; файл не пишется на диск в ядре — диалог сохранения делает main.js).
- Секреты не попадут: `exportCommandJson` вырезает их; `warnings` показывать в окне.
- Рекомендуемые каналы `preload.js`: `exportCommands: () => ipcRenderer.invoke('commands:export')`.

### 6.2 Импорт: предпросмотр и применение
- `commands:import-preview`, аргумент `(text: string)` (содержимое выбранного файла; чтение файла — в main.js через `dialog.showOpenDialog`, с проверкой размера; ядро всё равно проверит 1 МБ).
- Возврат: `{ok:true, preview}` | `{ok:false, error}`. `preview` = `{format, version, schemaVersion, exportedAt, commandCount, items:[{name, action:'add'|'update'|'unchanged'|'conflict', localId, changes:[{field,label,before,after}], conflicts:[string]}], counts:{add,update,unchanged,conflict}, warnings, applicable}`.
- `commands:import-apply`, аргументы `(text: string, confirm: boolean)`.
  - **Обязательно** передавать `confirm === true` только после явного нажатия владельцем кнопки «Импортировать» в диалоге с diff; ядро откажет без подтверждения.
  - Возврат: `{ok:true, added, updated, unchanged, warnings}` | `{ok:false, error}`.
  - После успеха вызвать `registerCommandHotkeys()` (импорт мог добавить клавиши), затем обновить списки/дерево в окне.
- Между preview и apply файл перечитывается ядром заново; конфликты или изменения в это время → отказ, данные не меняются.

### 6.3 Запись действий
- Рекомендуется один экземпляр `new CommandRecorder()` в main.js (после `require('../src/commands/runner')`).
- `commands:record-start` — без аргументов → `{ok:true, recording:true, startedAt}` | `{ok:false, error}`.
- Источник шагов: main.js в момент `tool_start`/аналога, **только пока запись идёт**, вызывает `recorder.capture({tool, args})` и накапливает ответы (можно отдавать окну события `record:step`). Захват не должен сам сохранять команду.
- `commands:record-stop` → `{ok:true, draft}`; `draft = {id:null, name:'', phrases:[], steps, enabled:true, origin:'recorded', warnings:[string], overview:[string], saved:false}`. Сохранение — только через существующий `commands:save` после того, как владелец введёт имя/фразы и поправит шаги.
- `commands:record-cancel` → `{ok:true}`; `commands:record-state` → `{ok:true, ...recorder.status()}`.
- Предупреждения (`warnings`) показывать в редакторе; координатные шаги не запрещены, но помечены.

### 6.4 Создание из текста
- Канал `commands:plan` рекомендую не добавлять: путь через модель уже есть. Из чата модель вызывает `command_create` с `dryRun: true`, получает `data.plan`; окно показывает шаги/параметры, владелец правит, затем обычный `commands:save`. Автозапуска нет.
- Если нужна кнопка «Создать из текста» в окне: `ipcMain.handle('commands:plan', async (event, description) => ...)` запускает модель с промптом, где обязателен `command_create(dryRun:true)`, и возвращает `{ok:true, plan, warnings}`; сохранение — `commands:save`.

### 6.5 Прочее по схеме
- `commands:list` уже отдаёт новые поля (`schemaVersion`, `updatedAt`, `folder`, `collections`, `origin`); `renderer/app.js` `normCmd` их игнорирует — интегратору нужно добавить отображение дерева/происхождения/предупреждений.
- `commands:save` принимает `folder` (строка ≤ 60 или null) и `collections` (массив ≤ 5 строк ≤ 40) — можно показать в свойствах команды. `schemaVersion` окну передавать не нужно.
- `tools:catalog` можно не менять: редактор по-прежнему получает 5 проверенных действий из `EDITOR_STEP_TOOLS`. Модель получает полный каталог через `command_list({withParameters:true})`.
- **Важно для проверки параметров моделью:** в двух местах, где собираются `commandModelTools(...)` (`main.js` около строк 506 и 1141), добавьте третьим аргументом `toolDefs: () => commandRuntime.tools.list()` (для общего пространства — `() => commandTools.list()`). Тогда `command_create`/`command_list({withParameters:true})` сверяют типы, обязательные поля и диапазоны с настоящими схемами инструментов; без этого проверяются только имена (обратная совместимость сохранена).
- Импорт и запись не должны автоматически запускать команду; повтор — только существующими `commands:run`/фраза/клавиша, где каждый шаг заново проходит policy и verify.

## 7. Остаток и ограничения

1. **Экран**: панель импорта/экспорта с diff и подтверждением, кнопки записи со списком шагов и предупреждениями, план из текста, дерево папок/коллекций, поле горячей клавиши, поиск по «Моим» — это `renderer/app.js`/`index.html`, зона интегратора (см. контракт).
2. **Живое окно**: редактор команд и диалог разрешения в настоящем Electron не прогонялись (интерфейс в чужой зоне); после интеграции нужен прогон владельцем/интегратором: создать команду всеми тремя способами, сохранить, перезапустить, выполнить, отказать в разрешении, остановить, импортировать битый файл.
3. **Полный `node --test`**: на финальном прогоне 1611/1611 pass. Во время работы соседняя зона памяти временно ломала `tests/memory.test.js` — это не зона команд; интегратору всё равно стоит перепроверить полный прогон после сборки всех зон.
4. Новые файлы в `src/`/`renderer/` не создавались: `tests/project-map.test.js` требует упоминания в `AGENTS.md`, а `AGENTS.md` в этой задаче менять запрещено. Поэтому вся логика — в существующих модулях (`store.js`, `runner.js`, `tools/commands.js`, `cmd-steps.js`); при желании разделить их на `schema.js`/`transfer.js`/`record.js` интегратор добавит строки в карту.
5. Библиотека команд: пределы чтения добавлены, но её каталог/категории в окне не переделывались — вне минимальных правок.

## 8. Примечание о доказательствах

Видео 4 — проморолик: подтверждены подписи и показанные экраны, но не надёжность, не реальные числа команд и не поведение при смене окон. В матрице это отмечено как предел; проценты паритета не заявляются.
