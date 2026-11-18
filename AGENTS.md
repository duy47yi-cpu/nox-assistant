# Карта Nox Assistant

Прочитай это первым. Здесь сказано, что где лежит, чтобы не искать. Тест `apps/jarvis-desktop/tests/project-map.test.js` падает, если файл из `src/` или `renderer/` не упомянут здесь или путь в карте больше не существует. Добавил файл — добавь строку.

Живой продукт — две папки: `apps/jarvis-desktop` (приложение) и `apps/nox-server` (сервер). Если не сказано иначе, работа идёт там.

Nox Assistant — продукт. Джарвис — имя помощника внутри него. Windows, Electron, Node.

## Правила

- `.env` и настоящую папку `data/` не читать и не показывать. Для проверок: временные данные через `NOX_DATA_DIR`.
- Коммит и `push` только по просьбе владельца. Программы и пакеты не ставить без его согласия.
- Пользователь не видит названий моделей, поставщиков и инструментов: только «Быстрая» и «Умная». Настоящие названия допустимы только в коде сервера и настройке.
- Оплата запрещена всегда. В «Полном доступе» владелец решает сам: прямая просьба «установи/удали/выключи» в его сообщении этого хода выполняется без вопроса (программа или файл должны совпасть с названными). Прямая просьба «отправь/напиши/ответь» на названного адресата или в мессенджер выполняется без вопроса, даже после чтения страниц. Секрет (пароль, ключ) в исходящем всё равно спрашивается. Остальное по режиму: без просьбы владельца удаление и установка спрашиваются. Точные правила — `src/policy/modes.js`, история решения — `replica/HANDOFF-2026-11-06.md`.
- Код не должен считать дело сделанным со слов модели: результат подтверждает `verify` инструмента.
- Решение владельца 08.11.2026: «Полный доступ» не сужается отдельным списком запретов катастрофических команд — владелец сам решает, что выполнять. Windows Hello не добавлять без отдельной просьбы.
- Перед ответом о готовности: `node --test` в обеих папках приложений. Интерфейс проверять настоящим окном.
- С владельцем говорить простым русским, без жаргона. Подробнее о продукте: `PRODUCT.md`, о дизайне: `DESIGN.md`.

## Команды

| Что | Команда, из папки |
|---|---|
| Запустить приложение | `npm start` в `apps/jarvis-desktop` |
| Тесты приложения | `node --test` в `apps/jarvis-desktop` |
| Тесты сервера | `node --test` в `apps/nox-server` |
| Запустить сервер | `node index.js` в `apps/nox-server`, настройки в `apps/nox-server/README.md` |
| Git на этой машине | `git -c safe.directory=D:/nox-assistant ...` |

Переменные приложения: `NOX_DATA_DIR` (папка данных), `NOX_SERVER_URL` (включает аккаунты), `NOX_BRAIN_KEY` и `NOX_SMART_KEY` (своя сборка с ключами). Без `NOX_SERVER_URL` приложение работает со своими ключами.

## Куда идти, если нужно…

| Задача | Файл |
|---|---|
| Добавить инструмент Джарвису | новый файл в `src/tools/`, регистрация в `baseTools` в `main.js`, подпись в `TOOL_TITLES` в `renderer/shared.js`, слово в `TOOL_WORDS` в `src/deals/deals.js`, правило выбора в `SYSTEM_PROMPT` в `main.js` |
| Изменить, что разрешено без вопроса | `src/policy/modes.js`, функции `decide` и `hardDeny` |
| Решить, что доступно в фоне | `src/tools/profiles.js`, `longPolicy` в `src/missions/long.js`, `ALLOWED_TOOLS` в `src/tasks/mandate.js`, `src/telegram/policy.js` |
| Изменить характер и правила Джарвиса | `SYSTEM_PROMPT` в `main.js` |
| Цикл «модель, инструмент, модель» | `src/agent/loop.js` |
| Сменить модель или провайдера | `apps/nox-server/models.js`; в сборке со своими ключами `src/brain/tiers.js` и начало `main.js` |
| Изменить цены и лимиты подписок | `apps/nox-server/plans.js`, расчёты в `docs/business/plan.md` |
| Уровни мышления | `src/brain/tiers.js`, `THINKING_WEIGHT` и `levels` в `apps/nox-server/models.js`, выбор в `renderer/model-pick.js` |
| Вид чата, цвета, стекло | последние правила в `renderer/themes.css` важнее `renderer/home.css` и `renderer/styles.css` |
| Первый экран Nox: рейка, история, чат, сфера, окно без рамки | `renderer/nox-screen.css`, `renderer/nox-screen.js`, `renderer/orb-nox.js`; размер окна и кнопки окна — `createWindow` и `window:control` в `main.js`; классический экран — `renderer/index.html` (`data-view="dialog"`) и кнопка в Настройках → Вид |
| Первый экран по ролику Jarvis Pro в основной оболочке | `renderer/aether/aether.css`, `renderer/aether/components/topbar.js` (верхняя навигация и быстрые настройки), `chat-view.js` и `composer.js` там же (приветствие по ситуации, поле ввода у нижнего края, панель хода со стопом и итог проверки), `renderer/aether/orb-library.js` и `renderer/orb-nox.js` (зелёная сетка), `scripts/aether-qa.js` (живое окно и разрешения) |
| Служебная рейка, история, сфера, лимиты и аккаунт | `renderer/aether/aether.js` (рейка и сворачивание сцены), `renderer/aether/nox-luxify.css` (геометрия и состояния кнопок), `renderer/aether/components/history-drawer.js` (история чатов), `renderer/aether/components/account-panel.js` (поповеры справа от рейки), `apps/nox-server/plans.js` и `apps/nox-server/server.js` (лимиты и время сброса) |
| Общая шапка и каркас разделов, Журнал/Аккаунт/Дела в системе Nox, сворачивание истории | `renderer/nox-shell.css`, `renderer/nox-shell.js`, `#noxTopbar` в `renderer/index.html`; описание — `docs/reconstruction/ui-screen-architecture/` |
| Добавить тему или шрифт | `renderer/themes.css`, `IDS` и `FONTS` в `renderer/theme-boot.js`, кнопка темы в `renderer/index.html`, имя и образцы в `renderer/aether/components/settings-view.js` |
| Сообщения и шаги в чате | `renderer/app.js`, разделы «Диалог» и «Строка действий хода» |
| Компактный поиск и источники в чате | `renderer/app.js` (`renderResearchActs`, `searchingLabel`, `sourceRows`), стили `.is-research` в `renderer/nox-screen.css`; событие `tool_result` несёт только карточки `sources` из `src/agent/loop.js`; открытие по клику — `source:open` в `main.js`; живой снимок — `scripts/research-shot.js` |
| Кнопка «Источники» под ответом в основном чате | `renderer/aether/components/sources-popover.js`, стили в `renderer/aether/aether.css`; `src/agent/sources.js` собирает ссылки из результатов поиска, `src/agent/loop.js` сохраняет их с ответом и передаёт через `done`, повторное открытие — через `chat:history`, переход по ссылке — через `source:open` |
| Артефакты, уточнения и частичный результат | `src/agent/chat-reply.js` собирает данные из результатов инструментов, `renderer/aether/store.js` получает их с ходом и историей, `renderer/aether/components/chat-view.js` показывает карточки и варианты; `artifact:action` в `main.js` открывает проверенный файл или показывает его в папке |
| Новый вызов окно → ядро | `ipcMain.handle` в `main.js` и метод в `preload.js`; для браузерной проверки ещё `renderer/dev-stub.js` |
| Проверка результата действия | `verify` у инструмента, `src/agent/effects.js` |
| Память | `src/memory/store.js`, авто-память `src/memory/learn.js`, инструменты в `src/tools/memory.js` |
| Поиск по подключённым папкам | индекс в `src/rag/index.js`, чтение по режиму в `workspace_read` (`src/tools/workspace.js`), список `connectedFolders` в настройках, `folders:add` и `folders:remove` в `main.js` |
| Учёба по своим материалам | Поиск PDF и DOCX через `workspace_search` (`src/tools/workspace.js`, `src/rag/index.js`, `src/tools/documents.js`). `src/tools/study.js` хранит задачи, попытки и подсказки в `study.json`, считает прогресс по темам и выбирает следующее упражнение. `src/telegram/study.js` открывает занятие по теме, переносит фото с подписью «На учёбу» и ставит учебные напоминания через общий планировщик; `telegram-study.json` связывает ответ с показанной задачей. `src/agent/chat-reply.js` добавляет в чат карточку сохранённого фото |
| Долгая работа без владельца | `src/missions/long.js` |
| Задачи по расписанию | `src/missions/` |
| Что Джарвис сообщает сам, тишина, лимит в час | `src/notify/watch.js`; настройки `watchWindow`, `watchTelegram`, `watchPerHour` в `settings.json` |
| Очередь действий на рабочем столе | `src/control/desktop-lock.js` |
| Рабочий стол и виджеты | `src/desks/store.js`, `src/desks/templates.js`, `src/desks/data.js`, `renderer/desks.js`, каналы `desks:*` в `main.js` |
| Расширения (буфер, вставки, загрузки) | `src/extensions/`, `renderer/extensions.js`, каналы `clipboard-history:*`, `snippets:*`, `downloads:*` в `main.js` |
| Вид раздела «Команды» (каталог, вкладки, запуски, паки, редактор, шаги, выбор действия, запись) | `renderer/nox-commands.css` (токены и каркас Nox для `body[data-view="commands"]`), `renderer/index.html` (`#commands`, `#panelLaunches`, `#cmdEditor`, `#cmdTriggersSection`, `#cmdActionDialog`), `renderer/app.js` (`setCmdTab`, `renderCmdList`, `renderEditor`, `renderTriggerFields`, `renderLaunchPanel`, `renderSteps`, `renderEditorSide`, `pickerMarkup`, `startRecording`), `renderer/cmd-steps.js`; IPC — `commands:list/save/delete/run/triggers-update/launch-overview/trigger/fire-event/launch-clear`, `tools:catalog`, `packs:install` |
| Паки команд в один клик (Монтаж, Игры, Браузер, Окна, Проводник, Текст, Музыка и звук, Сайты, Программы) | `src/commands/packs.js` (данные и `describePacks` для карточек); канал `packs:install` в `main.js`, `installPack` в `preload.js`; карточки «Готовые паки» в «Командах» — `renderPacks` и `packCard` в `renderer/app.js`, оформление — `renderer/nox-commands.css`; ставятся только по кнопке, при старте не ставятся |
| Вид раздела «Подключения» (список, 7 состояний, поиск/фильтры, популярные, диалоги) | `renderer/nox-connections.css` (токены и каркас Nox для `body[data-view="mcp"]`), `renderer/index.html` (`#mcpPage`, `#mcpList`, `#mcpPopular`, диалоги `#mcpAddDialog`/`#mcpDetailsDialog`/`#mcpDeleteDialog`/`#mcpDriftDialog`/`#mcpErrorDialog`), `renderer/connections.js` (отрисовка и действия); данные и IPC прежние — `mcp:state/add/toggle/remove/approve`, подтверждение набора действий сервиса (`mcpApprove`) не смешивать с `approval:respond` |
| Озвучка: выключена по умолчанию, по выбору только облачная | `src/voice/output.js`, `src/voice/tts.js` (проигрывание полученного WAV), `renderer/aether/components/settings-view.js`, каналы `voice:state`/`voice:test` в `main.js` |
| Чтение вслух: выделенное, документ, пауза и продолжение | `read_clipboard_aloud` в `src/tools/desktop.js` (источники `clipboard`/`selection`/`file`, действия `start`/`pause`/`resume`/`stop`/`status`), `src/voice/reader.js` (куски, пауза, продолжение, стоп), `src/shortcuts/offline.js` (`пауза`, `продолжай читать`, `хватит читать`), чтение файлов — `readDocumentText` (txt, md, html, docx; `.env`, pdf и прочее — отказ) |
| Склейка команд и необязательные глаголы | `src/commands/match.js` (`matchSequence`, `normalizePhrase`), вызовы в `main.js` (чат пространства, общий чат, Telegram) |
| Голосовой ввод: «Слушаю» / «Только имя» / «Микрофон выкл», обращения, VAD и отключение голосом | `src/voice/modes.js`, `src/voice/input.js`, захват PCM в `preload.js`, каналы `dictation:mode`/`dictation:state` и трей в `main.js` |
| Диктовка в поле другой программы (Ctrl+Alt+D, выключатель в трее) | `src/voice/field-dictation.js` (сеанс, запоминание поля, проверки перед вставкой, отказ для пароля); окно-подсказка без фокуса — `renderer/dictate.html`; клавиша, Esc, раннер и канал `field-dictation:act` — раздел «Диктовка в поле другой программы» в `main.js`; настройка `fieldDictation`; живая проверка — `scripts/field-dictation-qa.js` |
| Подтверждение и отмена фразой, авто-отмена 30 с | `src/policy/approvals.js` (`parseApprovalAnswer`, `autoCancelMs`), разбор речи в `main.js`, отсчёт в `renderer/app.js` |
| Свои звуковые паки (без чужих MP3) | `src/voice/packs.js`, `scripts/make-sound-pack.js`, `SOUND_PACKS_DIR` в `main.js`, папка `data/sound-packs/` |
| Новости RSS на столах | `src/news/rss.js`, виджет `news` в `src/desks/`, источник `news` в `buildDeskSources` (`main.js`) |
| Фон окна: своя картинка и эффект поверх любой темы | выбор и хранение настроек — `renderer/theme-boot.js` (`look.bg`, `look.bgDim`, `look.bgBlur`, `look.fx`, `FXS`, `THEME_FX`, `html[data-fx]`); рисунки эффектов — раздел «Эффекты фона» в `renderer/themes.css`; картинка в IndexedDB окна — `renderer/backdrop.js`; слои и полупрозрачные панели Nox — `renderer/backdrop.css`; строки в Настройках → Вид — `renderer/look.js` |
| Прозрачность и радиус окна | `renderer/look.js`, `renderer/theme-boot.js`, `--win-alpha`/`--win-radius` в `renderer/presence.css`, `window:setBackground` в `main.js` |
| Сравнить цены и замеры | `docs/business/plan.md` |

## Как идёт сообщение

1. Окно: `renderer/app.js` → `window.jarvis.send` из `preload.js` → `chat:send` в `main.js`.
2. Ответы без модели: «что повисло», музыка, программы, команды по фразе.
3. Иначе `Agent.run` в `src/agent/loop.js`: `_messages` → `brain.chat` → инструменты.
4. Путь к модели: `runtime.guardedBrain` (`src/cost/guard.js`) → `waitOnLimit` в режиме аккаунтов (`src/account/limit-wait.js`) → `createRouter` (`src/brain/tiers.js`) → `DeepSeekClient` (`src/brain/deepseek.js`, общий клиент любой совместимой модели) → провайдер или сервер Nox.
5. Каждый вызов инструмента: `decide` (`src/policy/modes.js`) → при необходимости подтверждение (`src/policy/approvals.js`) → `tool.run` → `checkEffect` (`src/agent/effects.js`) → журнал (`src/journal/journal.js`).
6. События идут в окно каналом `agent:event`, обрабатывает их раздел «События ядра» в `renderer/app.js`.

## Приложение: корень `apps/jarvis-desktop`

| Файл | Что внутри |
|---|---|
| `main.js` | Сборка всего: промпт, инструменты, агенты, IPC, окно, трей |
| `preload.js` | Единственный мост окно → ядро |
| `icon.js` | Иконки трея и окна |
| `skills/` | Инструкции навыков: `briefing`, `files`, `research` |
| `scripts/commands/` | Python-библиотека готовых команд и манифесты |
| `scripts/tts/` | Сервер голоса |
| `scripts/tts/gigaam-worker.py` | Локальное распознавание PCM 16 кГц через ONNX, отдельный процесс |
| `scripts/voice-bench.js` | Замеры на 30 фразах SAPI и реальном отрывке из материалов фазы 3 |
| `scripts/voice-qa.js` | Настоящее окно Electron: локальное распознавание WAV, тестовый облачный ответ, откат при сбое и чтение вслух во временном профиле |
| `scripts/aether-qa.js` | Настоящее окно Electron с временным профилем; `--chat-redesign` проверяет рейку, сцену, карточки чата и настройки озвучки на 1200×720 и 864×520 |
| `scripts/screen-agent-qa.js` | Настоящее окно Electron с временным `NOX_DATA_DIR`, локальным SSE-стабом модели и внешним окном WPF: живые проверки DEMO 6–7, прогресса «Шаг N из M», F-3 и стопа на 1200×720 и 864×520 |
| `tests/voice-phase3.test.js` | Режим префикса, ответы на подтверждение, VAD, автовыбор и отказ движков |
| `scripts/make-sound-pack.js` | Генерация своего звукового пака `sound-packs/nox` в папку данных (`NOX_DATA_DIR` или `data/`) для проверки |
| `scripts/` | Проверки: `check-brain.js`, `check-tools.js`, `check-manifest.js`, `check-voice.js` (распознавание WAV и отсутствие локального синтеза), `read-aloud-check.js` (чтение вслух: тестовый WAV, воспроизведение в Windows, пауза, продолжение с того же куска, стоп), `check-notification.js` (системное уведомление во временном профиле), `check-app-startup.js` (запуск Electron с временным профилем и заглушкой), `check-browser-payment-fixture.js` (стенд с платёжной кнопкой), `motion-qa.js` (уменьшение движения в настоящем окне: четыре сочетания «Анимации» × Windows на 1200×720 и 864×520, все девять эффектов фона), `task-dry-run.js`, `full-qa.js` (единый прогон девяти живых стендов; `--only/--skip/--retry/--with-model`), `orbs-qa.js` (восемь сфер: состояния, темы, пауза, уменьшение движения), `aether-a11y-qa.js` (клавиатура и фокус Aether и классики, `--legacy`), `check-mcp-registry.js` (сверка 80 MCP-сервисов с npm/PyPI без установки), `fetch-mcp-logos.js` (значки MCP из открытого набора), `turns-report.js`, `plan-resume-qa.js` (живой стенд: план переживает перезапуск; два запуска Electron с одним временным профилем, модель — заглушка или наш шлюз); набор замеров `scripts/eval/tasks.js` (48 поручений четырёх классов, включая сложные многошаговые, с проверкой итога кодом) и `scripts/eval/run.js` (`npm run eval`: настоящий цикл агента и инструменты во временной папке, фиктивная эталонная модель, с `--real --budget` — платный прогон на «Умной» с потолком расхода; таблица: успех, ложное «готово», небезопасные исполнения, шаги); экран Nox: `nox-shot.js` (снимок настоящего окна 1200×720/864×520, полный/пустой чат, wire/nox, геометрия), `nox-compare.js` (сравнения «оригинал | реализация», crop/diff), `nox-qa-verify.js` (проверка экрана Nox в изолированном профиле: чаты, отправка, отмена на локальном потоке, прокрутка, resize, копирование, FPS); раздел «Команды»: `nox-commands-shot.js` (снимки каталога/редактора/выбора действия/записи 1200 и 864 в временном профиле и режим `--mode qa` — 15 живых проверок раздела на настоящем окне); раздел «Подключения»: `nox-connections-shot.js` (снимки списка/деталей/добавления/удаления/drift/ошибки и режим `--mode qa` с живым MCP-сервером на `node` во временном профиле); быстрый чат: `quick-chat-qa.js` (живые проверки окна быстрого чата во временном профиле с локальной заглушкой модели: вызов, ход, разрешение, автоотмена, стоп, занятая клавиша; `--busy` — клавиша занята при запуске; снимки светлой и тёмной темы); диктовка в поле: `field-dictation-qa.js` (живые проверки на настоящих окнах Блокнота и Edge во временном профиле, распознанный текст подставляется вместо микрофона; `--busy` — клавиша занята при запуске); `nox-screens-shot.js` (все разделы на трёх размерах и 16 живых проверок навигации во временном профиле); чат Aether: `chat-p1-shot.js` (11 живых проверок колонки истории и времени реплик на 1200×720 и 864×520 во временном профиле; `--state-dir` сохраняет профиль и данные между запусками, `--restart` сверяет время и колонку после перезапуска, `--theme <id>` снимает проверки на выбранной теме; повторная запись требует чистого профиля) |
| `tests/` | Тесты `node:test`, отдельно `renderer/themes.test.js` |

### `main.js`: где что

Искать по имени, строки меняются.

| Имя | Что |
|---|---|
| `SYSTEM_PROMPT` | Правила модели |
| `readSettings`, `saveSettings` | Настройки |
| `saveConversation`, `loadChats` | Разговоры |
| `modelClient`, `smartClient`, `routedClient`, `account` | Модели и аккаунт |
| `baseTools`, `tools`, `backgroundTools`, `commandTools`, `remoteTools`, `longRegistry` | Наборы инструментов |
| `agent`, `buildRemoteAgent`, `longTasks`, `missionScheduler`, `runtime` | Кто работает |
| `ipcMain.handle('chat:send'` | Приём сообщения |
| `ipcMain.handle('settings:` | Настройки из окна |
| `createWindow`, `applyMotion`, `buildTrayMenu` | Окно, анимации, трей |

### Интерфейс: `renderer/`

| Файл | Что |
|---|---|
| `renderer/index.html` | Разметка главного окна |
| `renderer/app.js` | Логика окна, разделы отмечены `// ──`; панели импорта/экспорта и записи команд, память и напоминания в Настройках, чтение полей прогресса хода, индикатор режима микрофона и отсчёт автоотмены подтверждения |
| `renderer/shared.js` | Общее: подписи инструментов, `humanize`, статусы, состояние шара (включая `verifying`, `success`, `cancelled` и честное «Остановлено») |
| `renderer/cmd-steps.js` | Шаги редактора команд и единая модель запусков без DOM: перестановка шагов, текст для «Проверить», триггеры (`hotkey`, `schedule`, `event`), валидация, форматирование и фильтрация журнала запусков |
| `renderer/tools-extra.css` | Дополнительные блоки: список памяти и напоминаний, импорт команд, строки папок и горячих клавиш, сетка рабочего стола и расширения; цвета только из токенов темы |
| `demo/orb-lab/` | Автономное демо трёх новых сфер: Поток, Мембрана, Резонанс; локальный HTML/CSS/JS, не подключается к основному экрану; `scripts/orb-lab-qa.js` — проверка в настоящем окне |
| `renderer/desks.js` | Рабочий стол: вкладки столов, сетка виджетов, шаблоны, перемещение/размер мышью и клавиатурой, удаление; данные из `desks:state` |
| `renderer/extensions.js` | Настройки → «Расширения»: история буфера, быстрые вставки, уборка загрузок (анализ и подтверждаемое удаление) |
| `renderer/account.js` | Вход, лимиты в Настройках, сообщение о паузе |
| `renderer/model-pick.js` | Выбор модели и мышления у поля ввода |
| `renderer/orb.js`, `renderer/orb-variants.js` | Шар и его виды: `orb.js` — цикл, состояния, голос (`setVoice`), настройки (`setTune`) и Точечная сфера; `orb-variants.js` — Ядро (по умолчанию) и Диафрагма |
| `renderer/orb-tune.js` | Настройки → Вид: свои настройки выбранного вида шара (свечение, скорость, движение, объём, голос, плотность точек) в `jarvis.orbTune`, событие `jarvis:orbtune` |
| `renderer/contour.js` | Контурный фон |
| `renderer/math.js` | Формулы в ответах: своё подмножество LaTeX (дроби, корни, степени, индексы, символы) без внешних библиотек; `appendMath` в `renderer/app.js` находит `$…$` и `$$…$$`, стили `.math` в `renderer/nox-screen.css` |
| `renderer/nox-screen.css` | Экран Nox: токены реконструкции, сетка окна 1200×720 (рейка 52 / история 244 / чат 1fr / сфера 360 / зазор 8), панели, лента, поле ввода, сфера. Подключается последним и ограничен `body[data-view="nox"]` / `.view-nox` |
| `renderer/nox-screen.js` | Экран Nox: список чатов «Сегодня/Ранее», перенос беседы и поля ввода между экраном Nox и классическим, живая строка «Ход работы», кнопки окна, сфера и её вариант (`window.NoxScreen.setVariant`, `localStorage noxOrb`, `#orb=wire`; в интерфейсе переключателя нет) |
| `renderer/orb-nox.js` | Сфера экрана Nox: вариант «проволока» (как в референсе) и «точки с ядром» (Nox Identity), состояния, дыхание, деформация, DPR, пауза в фоне |
| `renderer/nox-signature.css` | Фирменный слой «Затвор»: вкладки в шапке вместо левой рейки, колонки без карточек, лента-журнал со строкой команды и линией времени, прибор справа (затвор, слово состояния, режим), командная строка; последний слой, цвета из токенов темы `signal` |
| `renderer/orb-shutter.js` | Вид шара «Затвор» для `NoxOrb` (девять лепестков в оправе со шкалой, свет за отверстием; раскрытие и ход шагами по состояниям); подключается после `orb-nox.js`, вид по умолчанию на экране Nox |
| `renderer/nox-commands.css` | Раздел «Команды» в системе Nox: токены и каркас окна для `body[data-view="commands"]`, каталог (шапка, вкладки, поиск, строки 64, панель паков, запись), редактор (поля, шаги, «Результат проверки», нижняя панель), диалоги выбора действия и импорта; последний слой, чат и другие разделы не трогает |
| `renderer/presence.css` | Вид настольного ассистента: рейка с подписями, крошки в шапке, мягкие панели, чат и сцена с шаром, команды и настройки с правой колонкой; последний слой, цвета из тем |
| `renderer/accent.js` | Настройки → Вид: строка «Цвет акцента» (7 кружков и поле HEX), цвет поверх темы через `theme-boot.js`; если контраст ниже 4,5:1, цвет сдвигается и строка под названием говорит, какой взят |
| `renderer/look.js` | Настройки → Вид: шрифты, размер текста, скругление, панели, размер шара, свет за окном, размытие стекла, фон окна; кнопка «Сбросить к теме» (`resetToTheme`: ручки и свой акцент); значения хранит `theme-boot.js` (`jarvis.look`) |
| `renderer/backdrop.js` | Своя картинка на фоне окна: файл в IndexedDB окна (до 25 МБ, только картинки), `window.NoxBackdrop.set/clear/has`, ставит `--own-bg` и `html[data-own-bg]`, событие `nox:backdrop`; ядро не трогает |
| `renderer/backdrop.css` | Последний слой: `.theme-bg` (картинка с затемнением и размытием), показ `.theme-fx` в разделах Nox, полупрозрачные панели Nox, пока включена картинка или эффект; без них ничего не меняет |
| `renderer/connections.js` | Раздел «Подключения»: сервисы MCP из `mcpServers`, семь состояний (connected/connecting/disabled/idle/legacy/error/drift), поиск и фильтры, панель популярных, диалоги добавления/деталей/удаления/подтверждения изменений/ошибки; вызовы `mcp:state`, `mcp:add`, `mcp:toggle`, `mcp:remove`, `mcp:approve` в `main.js` |
| `renderer/nox-connections.css` | Раздел «Подключения» в системе Nox: токены и каркас окна для `body[data-view="mcp"]`, шапка, поиск и чипы-фильтры, карточки сервисов и состояния, панель популярных, диалоги; последний слой, чат и другие разделы не трогает |
| `renderer/nox-settings.css` | Раздел «Настройки» в системе Nox: токены и каркас окна для `body[data-view="settings"]`, панель раздела, nav 252 + main, карточки параметров, переключатели/списки/ползунки/сегменты, темы и акцент, карточка сферы, состояния загрузки/ошибки; последний слой, чат и другие разделы не трогает |
| `renderer/nox-settings.js` | Раздел «Настройки»: состояние загрузки/ошибки, карточка «ИИ и провайдеры» (`settings:setModelTier`/`setThinking`, оформление ответов `settings:setReplyStyle` → `body[data-reply-style]`), карточка «Сфера Nox» (вариант Wire/Nox Points через `window.NoxScreen.setVariant`, размер и свечение — честное превью) |
| `renderer/nox-shell.css` | Общая оболочка всех разделов Nox (кроме классического экрана): шапка 40 px во всю ширину (бренд, настройки, профиль, кнопки окна), рейка только с разделами, свои страницы «Журнал», «Аккаунт», «Дела», сворачивание и выезжающая история чата, компактные шапки на низком окне; последний слой |
| `renderer/nox-shell.js` | Общая оболочка: кнопки окна в шапке (`#noxTopbar [data-act]` → `window:control`), точка у «Настроек» повторяет `#settingsDot`, история чата: свернуть/показать (`localStorage noxHistCollapsed`), на ширине до 1000 px выезжает поверх и закрывается Esc, щелчком мимо или выбором чата; переходы — по-прежнему `show()` в `app.js` |
| `renderer/settings-nav.js` | Настройки: шесть категорий по `data-cat`, поиск по статическим подписям (не по личным записям), чипы «Все/ИИ/Вид/Голос», порядок карточек и подсветка текущей категории; контролы не пересоздаёт и значения не меняет |
| `renderer/theme-boot.js` | Тема и свой цвет акцента (`jarvis.accent`: id палитры или `#RRGGBB`) до первой отрисовки; убранные темы тихо открывают «Ночь» |
| `renderer/styles.css` → `renderer/home.css` → `renderer/themes.css` | Стили, каждый следующий важнее |
| `renderer/fonts/` | Шрифты Inter и IBM Plex Serif с лицензиями OFL; семейства, размеры и веса — в начале `renderer/themes.css` |
| `renderer/mini.html`, `renderer/mini.js`, `renderer/mini.css` | Быстрый чат поверх окон: точечное ядро Nox (`orb-nox.js`), ввод, ход, остановка и запросы подтверждения |
| `renderer/dictate.html`, `renderer/dictate.js`, `renderer/dictate.css` | Окно диктовки в поле другой программы поверх всех окон, без фокуса: состояние микрофона, куда уйдёт текст, сам текст, «Вставить» / «Отмена» / «Скопировать»; действия идут в `field-dictation:act` |
| `renderer/dev-stub.js` | Подмена ядра для проверки в браузере |
| `renderer/region.html`, `renderer/region.js` | Рамка «Объясни, что я обвёл» поверх основного экрана: выделение мышью, Esc — отмена; итог уходит заголовком страницы в `region:pick` (`main.js`) |
| `renderer/hands.html`, `renderer/hands.css` | Надпись «Nox работает на вашем ПК · Esc — остановить»: плашка поверх окон и `#handsBanner` в главном окне, включает `showHands` в `main.js` |
| `renderer/aether/index.html`, `renderer/aether/aether.css`, `renderer/aether/nox-luxify.css`, `renderer/aether/nox-commands-aether.css`, `renderer/aether/aether.js`, `renderer/aether/aether-boot.js` | Оболочка Nox Aether (Концепция B): чистая точка входа, стили, слой облика `--lx-*`, стили редактора команд Фазы 2, предзагрузка темы/подписи и связка маршрутов |
| `renderer/aether/orb-library.js`, `renderer/aether/icons.js`, `renderer/aether/markdown.js`, `renderer/aether/bridge.js`, `renderer/aether/store.js` | Единая библиотека обеих систем сфер, векторные иконки без эмодзи, безопасный Markdown+Math, мост IPC и реактивное состояние (черновики чатов, R3-01 подтверждения, колонка истории и отметки времени ходов) |
| `renderer/aether/time.js` | Время в чате Aether без правки ядра: `formatClock` (ЧЧ:ММ у реплики), `formatChatStamp` (время/«вчера»/дата в списке чатов), `splitChats` («Сегодня»/«Ранее»), `fingerprint` и `withTurnTimes` — сопоставление сохранённой истории с отметками, которые окно видело живьём (в `localStorage` только отпечатки, не текст); несовпавшая реплика остаётся без времени |
| `renderer/aether/widgets-model.js`, `renderer/aether/components/day-widgets.js`, `src/widgets/day.js` | Часы, ближайшее напоминание и история музыки в чате Aether. Канал `widgets:data` с `view: 'day'` читает локальные данные, `widgets:openMusic` открывает поиск по сохранённой записи. Видимость настраивается в Настройки → Окно и чат |
| `renderer/aether/calm.css` | Спокойный проход Aether: тише шапка и рейка, воздушнее история, крупнее чтение, пилюля ввода, тихая сцена; только токены тем, подключается последним |
| `renderer/aether/rail-v2.css` | Левая служебная рейка Aether: вставная панель с отступом и скруглением, знак Nox сверху, группы «Nox AI/сфера», «История», внизу озвучка и аккаунт; подписи-пилюли при наведении и фокусе, компакт на окне ≤980 px; подключается последним. Проверки — `tests/rail-v2.test.js`, живое окно — `scripts/aether-qa.js` |
| `renderer/aether/orbs-extra.js` | Шесть авторских сфер (Поток, Мембрана, Резонанс, Кристалл, Плазма, Соты): canvas-движок, все состояния, голос, пауза в скрытом окне, уменьшение движения; карточки и пресеты — через `orb-library.js`; проверки — `tests/orbs-extra.test.js`, `scripts/orbs-qa.js` |
| `renderer/aether/mcp-logos.js` | Значки MCP-сервисов для раздела «Дополнения»: 59 снимков открытого набора Simple Icons (CC0) и 22 наших векторных монограммы; в рантайме без сети; генератор — `scripts/fetch-mcp-logos.js` |
| `tests/day-widgets.test.js` | Проверки истории музыки, времени и напоминаний. Живое окно и снимки панели проверяет `scripts/aether-qa.js --widgets-only` или полный прогон `--chat-redesign` |
| `renderer/aether/components/topbar.js`, `renderer/aether/components/history-drawer.js`, `renderer/aether/components/orb-stage.js`, `renderer/aether/components/approval-card.js`, `renderer/aether/components/composer.js`, `renderer/aether/components/chat-view.js`, `renderer/aether/components/ai-modal.js` | Шапка на 5 разделов, колонка истории 256 px с «+ Новый чат», сворачиванием и группами «Сегодня/Ранее» (на окне уже 980 px выезжает поверх бесцветным матовым стеклом: размытая вуаль и полупрозрачная пластина, цвет только из токенов темы; «Стекло выкл» делает панель плотной), живая сцена сферы с «The Nox», защищённая карточка подтверждения, композер, экран чата со временем у реплик и модалка настроек Nox AI |
| `renderer/aether/components/commands-view.js`, `renderer/aether/components/mcp-view.js`, `renderer/aether/components/personal-view.js`, `renderer/aether/components/settings-view.js` | Вторичные разделы Aether: команды и паки, MCP-подключения (7 состояний + drift), личное пространство (столы, память, почта, календарь и журнал) и Настройки с Мастерской Nox |

### Ядро: `src/`

| Папка | Файлы |
|---|---|
| `src/agent/` | `src/agent/loop.js` цикл; `src/agent/plan.js` план хода: шаги модели (`plan_set`/`plan_done`), черновик незакрытого плана хранится на диске (`plans.json`, ключ «чат + пространство»), «продолжай/где остановились» поднимает его после перезапуска и называет сделанное, файлы и следующий шаг; шаг с наблюдаемым результатом закрывается только подтверждённым инструментом (`verified: confirmed`) или существующим непустым файлом — фразам модель не верим; код дописывает «Не закрыто» и меняет итог на «не уверен»; три вида остановки (`impossible`, `needs_human`, `unsure`); `src/agent/tool-context.js` единый неизменяемый контекст вызова инструмента (режим, заражение, фон, ход, шаг); событие прогресса хода (`runId`, `step`, `status`, `label`, `target`, `verification`, `cancelled`) без переименования прежних типов и защита от поздних событий после стопа; действие, завершившееся уже после стопа, приходит окну и в журнал с пометкой `afterStop` и настоящим итогом; действие, не ответившее за `stopGraceMs` (5 с) после стопа, закрывается как «исход неизвестен» (`hung`) и не держит агента, его поздний итог дописывается (`late`); поддержка `turnDeadlineMs` — потолок времени хода чата (между шагами, с честным текстом); `src/agent/effects.js` проверка результата; `src/agent/prompt.js` время в промпте; `src/agent/reply-style.js` оформление ответов в чате (настройка `replyStyle`: простой, выразительный, конспект — правила дописываются к промпту в `main.js`; `forSpeech` убирает разметку и формулы из текста для голоса); `src/agent/turnlog.js` журнал скорости |
| `src/brain/` | `src/brain/deepseek.js` клиент моделей и поток; `src/brain/tiers.js` выбор модели и мышления; `src/brain/stub.js` заглушка без ключа |
| `src/appearance/` | `src/appearance/motion.js` уменьшение движения: «Анимации» в Настройках и «Уменьшение движения» в Windows. Окну не навязывается no-preference: выключенные анимации всегда дают reduce, включённые — решает Windows (`applyMotion` в `main.js`, `emulatedMotionFeatures`) |
| `src/account/` | `src/account/session.js` вход (таймаут запроса к серверу); `src/account/limit-wait.js` ожидание лимита |
| `src/policy/` | `src/policy/modes.js` режимы и запреты; `src/policy/approvals.js` подтверждения; «Разрешить» из окна принимается только с токеном показа (`markShown`/`isShown`, канал `approval:shown` в `main.js`), диалог окна не подставляет следующий запрос сам (`showApprovalView`/`showApprovalGate` в `renderer/app.js`); `src/policy/taint.js` заражение контекста: после чужого текста исходящие действия и руки (клики, ввод) спрашиваются, свой снимок экрана руки не останавливает |
| `src/control/` | `src/control/stop.js` аварийный стоп и горячие клавиши; `src/control/desktop-lock.js` очередь рук; `src/control/esc-stop.js` Esc останавливает ход, пока руки работают на столе; `src/control/quick-hotkey.js` безопасная замена сочетания быстрого чата; `src/control/keep-awake.js` не даёт компьютеру заснуть во время хода/миссии (режимы off/while-working/always, экран гаснет как обычно) |
| `src/cost/` | `src/cost/guard.js` страж бюджета; `src/cost/response-cache.js` короткий кеш безопасных точных ответов; `src/cost/meter.js` учёт; `src/cost/prices.js` цены; `src/cost/summary.js` сводка |
| `src/currency/` | `src/currency/rates.js` курс валют ЦБ (cbr-xml-daily.ru): кэш 15 минут, разбор просьбы «какой курс доллара», текст ответа; только чтение |
| `src/journal/` | `src/journal/journal.js` журнал: маскирование секретов до записи, `maskEventForWindow` — та же маскировка для аргументов в событиях окна (`sendToWindow`, `approval:list` в `main.js`), `readJournal`/`searchJournal` с фильтрами (текст, статус, тип, пространство, задание, даты), `historyStatus` не выдаёт непроверенное за выполненное |
| `src/chats/` | `src/chats/book.js` вкладки чатов; `markCutTurn` при загрузке дописывает пометку «ход прерван» к реплике, оставшейся без ответа (реплика сохраняется до ответа модели — `saveConversation` сразу после `agent.run` в `main.js`) |
| `src/workspaces/` | `src/workspaces/book.js` реестр пространств и их папок, памяти и целей; `src/workspaces/chat.js` отдельный цикл чата пространства: файлы, память, цели, интернет, картинки, наблюдение и действия на компьютере (руки, установка, почта, PowerShell, браузер); файловые границы, память и цели у пространства свои; авто-память и навыки внутри пространства; `src/workspaces/commands.js` отдельные сценарии команд; `src/workspaces/hub.js` переключение чатов; `src/workspaces/deals.js` отдельные журналы дел и сверка своих поручений; создание и выбор — в главном окне |
| `src/config/` | `src/config/env.js` чтение настроек; `src/config/atomic.js` запись без порчи; `src/config/sandbox.js` рабочая папка; `src/config/paths.js` корень данных (в установленном приложении — папка пользователя) и путь к распакованным скриптам; `src/config/shell.js` одна оболочка окна — Aether, классический экран только при `NOX_UI=legacy` для отладки (переключателя в интерфейсе нет) |
| `src/memory/` | `src/memory/store.js` память: список с флагами, правка, удаление, очистка пространства, контекст по явным связям до двух переходов без раскрытия скрытых записей, проверяемая ссылка `source` на файл-источник (хранится, но не читается store); `src/memory/learn.js` авто-память после хода: профиль, привычки и договорённости из слов владельца, без секретов и чувствительного (платежи, коды, отправка, здоровье) |
| `src/goals/` | `src/goals/store.js` цели на несколько ходов: шаги, доказательства, закрытие; `src/goals/tools.js` инструменты `goal_*` |
| `src/deals/` | `src/deals/deals.js` дела и «что повисло» |
| `src/missions/` | `src/missions/long.js` долгие поручения; `src/missions/runner.js` запуск задачи; `src/missions/scheduler.js` расписание фоновых миссий и пользовательских команд (`commandLauncher`, `missionsEnabled`); `src/missions/store.js` хранилище миссий с `workspaceId`; `src/tools/missions.js` ограничивает список и отмену текущим пространством |
| `src/schedule/` | `src/schedule/scheduler.js`, `src/schedule/store.js` напоминания: список по пространству, правка/перенос, отмена, ежедневный и календарный повтор |
| `src/calendar/` | `src/calendar/index.js` календарь и встречи: разбор `.ics` и подключённых источников, часовые пояса IANA и переходы DST, обнаружение пересечений, утренняя сводка на сегодня, подпись источника, состояния (`ok`/`empty`/`not_connected`/`error`/`stale`), дедупликация событий и защита от повторных уведомлений |
| `src/shortcuts/` | `src/shortcuts/offline.js` короткие фразы без модели: громкость, свернуть окна, таймер, открыть сайт или программу; `src/shortcuts/hints.js` бытовые намёки, полуслова и очевидный сарказм; `src/shortcuts/scenarios.js` разбор жизненных сценариев, составных фраз, ситуативной музыки, намёков и режима работы без модели |
| `src/tasks/` | Исполнитель с мандатом: `src/tasks/executor.js` (отчёт: доказательства, изменения в файлах, тесты, оставшиеся проблемы; после стопа ждёт инструмент не дольше `stopGraceMs` — 5 с, дальше пауза «результат неизвестен», поздний итог пишется в журнал), `src/tasks/runtime.js` сборка, `src/tasks/mandate.js` границы, `src/tasks/model.js`, `src/tasks/queue.js`, `src/tasks/store.js`, `src/tasks/tools.js`, `src/tasks/verify.js`, `src/tasks/criteria.js`, `src/tasks/attention.js`, `src/tasks/link.js`, `src/tasks/board.js` доска «Центр управления миссиями»: строки задач, сводка и порядок (чистые функции) |
| `src/commands/` | `src/commands/runner.js` единый запуск команд `UnifiedCommandLauncher` (клавиша, расписание, событие, вручную/фраза; дедупликация, причины пропусков, запрет обхода подтверждений автозапуском) и `CommandRecorder`; `src/commands/store.js` схема команды с блоком `triggers`/`triggerState`, журнал запусков `CommandRunLog`, каталог событий `EVENT_CATALOG`, экспорт/импорт и лимиты; `src/commands/samples.js` готовые примеры; `src/commands/builder.js` сборка сценария из описания словами; `src/commands/packs.js` паки команд (`seedPackCommands`, `describePacks`); `src/commands/match.js` умное сопоставление фраз |
| `src/library/` | `src/library/index.js`, `src/library/access.js`, `src/library/validator.js` библиотека Python-команд |
| `src/desks/` | `src/desks/store.js` рабочие столы: раскладка виджетов на пространство в `desks.json`, сетка 12×12, лимиты и атомарная запись; `src/desks/templates.js` 17 типов виджетов (задачи, сегодня, музыка, погода, курсы, компьютер, программы, аватар, команды, цели, миссии, напоминания, заметки, загрузки, MCP, новости RSS, питомец) и 9 шаблонов (пустой, работа, учёба, игры, медиа, аватар, ночь, разработка, стрим; без выдуманных источников, питомец — только анимация); `src/desks/data.js` чистые состояния виджетов из внедрённых источников (`ok`/`empty`/`error`/`stale`) |
| `src/extensions/` | `src/extensions/clipboard-history.js` история буфера: пароли, коды и карты не сохраняются, срок хранения, пауза, очистка; `src/extensions/snippets.js` быстрые вставки: уникальные триггеры и текст, вставка только по явному подтверждению; `src/extensions/downloads-cleanup.js` уборка загрузок: анализ и предпросмотр только чтением, удаление только с `confirm` и только внутри папки |
| `src/inventory/` | `src/inventory/apps.js`, `src/inventory/usage.js`, `src/inventory/consent.js` программы владельца |
| `src/music/` | `src/music/intent.js`, `src/music/context.js` ситуативный подбор музыки по настроению, истории, открытым окнам и времени суток, `src/music/play.js` поиск видео на YouTube, `src/music/match.js` сверка названия с просьбой: открыть сразу или спросить номер |
| `src/rag/` | `src/rag/index.js` поиск по рабочей и подключённым папкам, границы путей |
| `src/research/` | `src/research/claims.js` проверка утверждений исследования по собранным источникам: наборы источников живут только в памяти процесса (TTL, лимиты), дословная цитата сверяется с текстом источника |
| `src/skills/` | `src/skills/index.js` навыки; `src/skills/experience.js` опыт: после хода с подтверждёнными действиями сохраняет последовательность инструментов и названные в просьбе цели `app_open`/`ui_click`/`desktop_click`; отдельно текст ввода и данные окон не сохраняет. Точный повтор получает подсказку в контексте, без дополнительного вызова модели; навыки отдельных пространств хранятся отдельно |
| `src/telegram/` | `src/telegram/bridge.js` мост (текст, голосовые, фото, видео и файлы от владельца: скачивание во временную папку, расшифровка голосовых, если передан расшифровщик; ответы «печатает» с делением длинных сообщений; отправка фото и видео владельцу `sendPhoto`/`sendVideo`, `notify` для инициативных сообщений); `src/telegram/policy.js` что можно удалённо и кому можно писать (`mayWriteTo`) |
| `src/notify/` | `src/notify/watch.js` поводы, о которых Джарвис говорит сам (`onFresh` пробрасывает `inbox` и зависшие окна Windows в единый запуск команд): новые файлы в `workspace/inbox`, зависшие приложения Windows, задачи и миссии, срок напоминания, расход у дневного лимита; тишина ночью и лимит в час |
| `src/validate/` | `src/validate/connections.js` проверка связей |
| `src/screen/` | `src/screen/region.js` область, обведённая владельцем: проверка рамки (целые координаты, границы экрана, минимум 8×8), приведение к границам, перевод в пиксели снимка, описание словами; `src/screen/agent.js` агент экрана: «сделай на экране: …», снимок → один шаг → проверка, до 40 шагов; опасные шаги (отправить/оплатить/удалить/установить, Enter после ввода) выполняются только после подтверждения владельца, при отказе — `needs_human` без повтора |
| `src/screen/agent-loop.js` | Модуль фазы 4: наблюдение, план, выполнение и проверка шагов на экране |
| `src/perception/` | `src/perception/scene.js` единый снимок сцены: окно, элементы с устойчивыми id, фокус, дельта между шагами; чистые функции без ввода-вывода |
| `src/voice/stt.js` | Локальный и облачный движки, выбор с разрешением, загрузка модели и отмена |
| `src/voice/input.js` | Распознавание конца фразы, обращения и настройки голосового ввода |
| `src/voice/output.js` | Разрешение на облачную озвучку; отсутствие ключа, выключенная озвучка и тихий режим останавливают вывод |
| `src/voice/` | `src/voice/beep.js` звук «дзинь» после успешной команды окна (WAV через PowerShell, без ожидания ответа; громкость и тихий режим); `src/voice/tts.js` проигрывание готового WAV облачной озвучки и остановка; `src/voice/fish.js` голос Fish Audio по HTTP (mp3, ключ `FISH_API_KEY` в `.env`, проигрывание WPF MediaPlayer); `src/voice/personas.js` характеры речи: пресеты темпа и громкости («Как есть», «Дворецкий», «Помощница», «Инженер»), голос не меняют, неизвестный id открывает «Как есть»; `src/voice/dictation.js` диктовка: распознанная речь останавливает текущий ход и остаётся в поле ввода; `src/voice/field-dictation.js` диктовка в поле другой программы: запоминает окно и поле с фокусом, отказывает для поля пароля и «не поля», перед вводом заново сверяет окно и поле (ушёл фокус — текст остаётся для копирования), печатает через тот же SendKeys, что `ui_type`, и читает поле заново; буфер обмена не трогает; распознавание — тот же раннер; `src/voice/wake.js` обращение «Джарвис» в начале сказанного: команда сразу уходит в чат, кулдаун, без дубля в поле ввода; `src/voice/modes.js` режимы микрофона: «Слушаю» / «Только имя» / «Микрофон выкл», фразы «тихий режим», «слушай меня», «хватит слушать», нормализация и статус словами; `src/voice/agc.js` AGC микрофона: нормализация PCM16 (задел под свой захват, пока не вызывается — Windows-распознавание PCM не отдаёт); `src/voice/reader.js` чтение вслух длинного текста с управлением: текст режется на предложения (кусок не длиннее 300 символов), пауза обрывает звук и запоминает кусок, продолжение начинает его же (прочитанное не повторяется, остальное не пропускается), стоп и аварийный стоп прекращают чтение, сбой синтеза — одна повторная попытка и честная остановка с местом; сеанс идёт в фоне, поэтому ход не занят; `src/voice/packs.js` свои звуковые паки: тональные мотивы кодом (`start/done/error/waiting/cancel`), генерация в `sound-packs/nox`, чтение папки владельца, честный отказ для mp3; `src/voice/delivery.js` доставка ответа: при настройке «тише» видимый успех остаётся строкой в окне без голоса, ошибка звучит всегда; `src/voice/normalize.js` пост-коррекция распознанной речи для команд: база → филлеры → предохранитель (отрицания, опасные фразы, секреты, перевод денег выключают словарь) → склейки → числа по контексту → имена; `buildHotwords()` и `clipPrompt()` — подсказка распознавателю (поле `prompt`), подключается в `normalizePhrase` (`src/commands/match.js`) и в облачный движок; тест — `tests/voice-normalize.test.js` |
| `src/mcp/` | `src/mcp/client.js` свой клиент MCP (stdio и http), инструменты серверов из `mcpServers` в настройках, без вопроса только имена из `mcpAllow`; `src/mcp/catalog.js` каталог и список внешних сервисов для вкладки «Подключения»; `src/mcp/drift.js` отпечаток набора инструментов MCP: подмена описаний замечена, действия сервиса ждут подтверждения владельца |
| `src/mail/` | `src/mail/gmail.js` зашифрованный доступ и Gmail API; `src/mail/oauth-loopback.js` — вход через системный браузер и локальный callback; `src/mail/drafts.js` локальные черновики писем, русские шаблоны и подсказки получателей без отправки; учётные данные `NOX_GMAIL_CLIENT_ID`, `NOX_GMAIL_CLIENT_SECRET` |
| `src/weather/` | `src/weather/open-meteo.js` погода open-meteo без ключей, кэш 30 минут |
| `src/news/` | `src/news/rss.js` лента RSS для виджета «Новости»: разбор без внешних пакетов, таймаут, кэш 30 минут, честные ошибки |
| `src/browser-bridge/` | `src/browser-bridge/service.js` безопасная интеграция с расширением Chrome через локальный мост `nox-bridge-2` (выключена по умолчанию, секреты только в main process, метаданные вкладки без текста страницы) |

### Инструменты: `src/tools/`

| Файл | Инструменты |
|---|---|
| `src/tools/registry.js` | Реестр |
| `src/tools/plan.js` | `plan_set` (шаги хода словами), `plan_done` (закрыть шаг только с доказательством), `turn_stop` (честная остановка: `impossible`, `needs_human`, `unsure`); план живёт в `src/agent/plan.js`, в фоне и миссиях не подключается |
| `src/tools/groups.js` | Подбор инструментов под задачу: ядро видно всегда, группы (руки, браузер, документы, проект, команды, миссии, почта, программы, раскладка окон) открываются по словам владельца и по уже вызванным действиям; `toolView` в `src/agent/loop.js`; включается настройкой `leanTools` (по умолчанию выключено, ждёт замера на настоящей модели) |
| `src/tools/agents.js` | Ролевые агенты: исследование и анализ параллельно, редактор файлов после читателей; общий вывод сводит главный агент |
| `src/tools/profiles.js` | Что доступно в фоне |
| `src/tools/system.js` | `volume_set`, `app_open`, `url_open`, `shell_run` |
| `src/tools/ui.js` | `ui_*`: окна, нажатия, ввод, клавиши; `ui_elements` отдаёт ещё и координаты элементов |
| `src/tools/observe.js` | `desktop_observe`: один снимок рабочего стола (окно, фокус, элементы с id и координатами, дельта с прошлого вызова); `desktop_click` и `desktop_type`: нажатие и ввод по id с перечитыванием окна и снимком изменений; нажатие мышью по центру координат — только если у элемента нет подписи или `ui_click` недоступен; после отказа или неизвестности вложенного нажатия мышью не повторяет; успех не подменяется сменой окна |
| `src/tools/install.js` | `app_search`, `app_install`: поиск и установка программ через winget; установка всегда с вопросом (`isInstall` в `src/policy/modes.js`), только в чате |
| `src/tools/ps-host.js` | Один живой PowerShell для `ui_*`: запрос ~10 мс вместо ~0,4 с на новый процесс |
| `src/tools/mouse.js` | `mouse_click`, `mouse_scroll`; `units=physical` — настоящие пиксели (так нажимает `desktop_click`), иначе точки снимка |
| `src/tools/windows.js` | `windows_list`, `windows_focus`, `windows_snap`: прикрепить окно к половине экрана, развернуть или свернуть по названию (title); окна Nox не трогает |
| `src/tools/windows-close.js` | `windows_close_all`: закрыть окна программ как по крестику, кроме окон Джарвиса и оболочки Windows; `window_close_active`: закрыть окно сверху (то же правило, диалоги не трогает); фразы «закрой окна», «закрой окно» без модели |
| `src/tools/display.js` | `screen_brightness`: яркость встроенного экрана через WMI (установить или изменить на шаг), только ноутбучные экраны; фразы «яркость 50», «ярче», «темнее» без модели |
| `src/tools/youtube.js` | `youtube_play`: первое видео по запросу, `start` — с какой секунды (`t=16s`); только в чате |
| `src/tools/disk.js` | `disk_free_space`, `disk_cleanup_suggest` |
| `src/tools/desktop.js` | `wait`, `app_close`, `speak`, свернуть окна, выключить монитор; `read_clipboard_aloud`: прочитать вслух буфер обмена кусками по предложениям (до 1500 символов) |
| `src/tools/wait.js` | `wait_for` |
| `src/tools/screen.js` | `screen_look`; `screen_region_look`: область, которую владелец обвёл кнопкой у поля ввода, только в чате окна, снимок только в памяти |
| `src/tools/clipboard.js` | Буфер обмена |
| `src/tools/media.js` | `media_control`: плеер Windows (играть, пауза, следующий) |
| `src/tools/ocr.js` | `image_read_text`: текст с картинки в рабочей папке (встроенное распознавание Windows); `image_look`: картинка целиком уходит модели — фото, схемы, графики, ошибки на экране (PNG, JPG, WebP, GIF; BMP/TIFF переводятся в JPEG); `ocrPdfFile` для сканов PDF |
| `src/tools/browser.js` | `browser_*`: скрытый Chromium с постоянными входами, определение экранов авторизации и `browser_bookmarks` для закладок |
| `src/tools/browser-bridge.js` | `browser_tab_read`: чтение только разрешённой владельцем вкладки через расширение Chrome (за feature flag, только T1 с вопросом) |
| `src/tools/web.js` | `web_search`, `web_wiki`, `web_fetch`, `web_research` (несколько запросов и чтение найденных страниц), `web_check_claims`: сверка утверждений с дословными цитатами по собранным источникам (не доказывает истинность, только совпадение), защита от локальных адресов |
| `src/tools/workspace.js` | `workspace_*`: чтение, запись, поиск, перенос, копия, папки; перед перезаписью файла кладёт прежнюю версию в `backups/` (до 50 копий всего, не больше 20 на файл; ссылки и junction отклоняются), вернуть её — `workspace_restore` (`list: true` показывает копии, восстановление сначала сохраняет текущую версию); `backups/` не показывается в списке |
| `src/tools/project.js` | `project_brief`: разбор папки проекта, типов файлов, недавних изменений и подсказка про тесты; `project_commands`: какие команды сборки и тестов ждать по файлам проекта; `project_run`: запуск одной из найденных команд в папке проекта с кодом выхода и хвостом вывода (T2, только в чате; в фоне, миссиях и мандате не даётся); `project_diagnostics`: ошибки из указанного журнала .log/.txt, без запуска сборки; в обычных режимах — внутри рабочей папки, в «Полном доступе» можно указать другую папку |
| `src/tools/documents.js`, `src/tools/zip.js` | `document_read` (с OCR для PDF-сканов и статусом слоя текста), `document_batch` (пакетная обработка подборки документов), `document_write`: Word, Excel, CSV, PDF, презентация pptx; `presentation_open` открывает pptx внутри рабочего пространства и подтверждает открытие по точному пути в PowerPoint |
| `src/tools/docx-fill.js` | Шаблон Word с ключами `{{ключ}}`: подстановка значений (диплом, справка по образцу), `document_fill` в `documents.js` |
| `src/tools/pptx.js` | Презентация .pptx без установки программ: обложка, нумерованное содержание, списки и карточки на тёмном фоне; проверка по числу слайдов (`document_write` с format `pptx`) |
| `src/tools/code.js` | `code_*`, `code_test`: только для исполнителя с мандатом |
| `src/tools/memory.js` | `remember` (с необязательными `source` и `quote` — проверяемая ссылка на файл-источник), `recall` и `memory_about` (показывают источник и его состояние: не менялся, изменился, файла нет), `forget` |
| `src/tools/reminders.js` | Напоминания |
| `src/tools/calendar.js` | `calendar_upcoming` (с группировкой по дням на неделю), `calendar_briefing`, `calendar_prep`: предстоящие встречи, утренняя сводка и подготовка к встрече по заметкам и чек-листу из подключённого календаря |
| `src/tools/missions.js` | `mission_*`, список, добавление и отмена в пределах текущего пространства |
| `src/tools/commands.js` | `command_*`: создание из текста с `dryRun: true` (план без сохранения и запуска), сборка сценария по описанию словами `command_build` (план или сохранение), каталог настоящих действий `command_list({withParameters:true})` |
| `src/tools/deals.js` | `deals_hanging`, `deal_add`, `deal_clear` |
| `src/tools/inventory.js` | `apps_*` |
| `src/tools/skills.js` | `skills_list`, `skill_read` |
| `src/tools/mail.js` | `mail_send`: отправка; `mail_unread`: заголовки и фрагменты непрочитанных писем при отдельном разрешении; `mail_draft`: локальные черновики, шаблоны и подсказки получателей без отправки |
| `src/tools/weather.js` | `weather_now`: текущая погода по open-meteo; город из аргумента или настроек |
| `src/tools/currency.js` | `currency_rate`: курс валют ЦБ к рублю (USD, EUR, CNY и другие), кэш 15 минут; короткая просьба про курс отвечается без модели и браузера |
| `src/missions/long.js` | `long_task_*` |
| `src/tasks/tools.js` | `task_*` |
| `src/link/errors.js` | Ошибки, валидация UUIDv4 и имён, санитизация секретов и атомарная запись Nox Link |
| `src/link/pki.js` | Двухуровневый PKI Nox Link (Device Root CA + Leaf ECDSA P-256 на `pkijs` / `asn1js`), проверка SAN/KU/EKU/NameConstraints и подпись PoP |
| `src/link/identity.js` | Удостоверение устройства Nox Link и fail-closed хранение приватных ключей через Electron `safeStorage` |
| `src/link/peers.js` | Доверенные устройства Nox Link: пиннинг CA+Leaf, отзыв (tombstone) и явная замена сертификата |
| `src/link/tls.js` | Взаимный TLS 1.3 Nox Link: пиннинг, проверка `deviceId`, таймауты, half-open сокеты и чистое завершение |
| `src/link/pairing.js` | Сопряжение Nox Link: Commit-then-Reveal + mTLS 1.3 + PoP + транскрипт-привязанный SAS с обязательным подтверждением обоих владельцев |
| `src/link/index.js` | Точка входа изолированного криптографического ядра Nox Link |

### Данные: `NOX_DATA_DIR`, по умолчанию `data/` в корне

`settings.json`, `gmail.bin`, `conversation.json`, `journal.jsonl`, `turns.jsonl`, `budget.json`, `memory.json`, `goals.json`, `reminders.json` (в старых и общих записях пространство не указано; новые записи могут содержать `workspaceId`), `missions.json`, `long-tasks.json`, `tasks.json`, `commands.json` (команды «Общего»), `workspaces/<id>/commands.json` (команды отдельного пространства), `deals.jsonl`, `deals.json`, `apps.json`, `app-usage.json`, `music-history.json`, `attention-hidden.json`, `desks.json` (столы и виджеты по пространствам), `clipboard-history.json`, `snippets.json`, `account.bin`, `skills/`.

Рабочая папка Джарвиса: `workspace/` в корне, отчёты в `workspace/reports/`.

## Сервер: `apps/nox-server`

| Файл | Что |
|---|---|
| `apps/nox-server/index.js` | Запуск и настройки окружения |
| `apps/nox-server/server.js` | Адреса: вход, расход, пересылка к модели, предохранитель |
| `apps/nox-server/store.js` | База SQLite: аккаунты, пропуска, окна лимитов, расход. Текста переписки нет |
| `apps/nox-server/models.js` | Единственное место с провайдерами, моделями, ценами и уровнями мышления |
| `apps/nox-server/plans.js` | Тарифы и лимиты |
| `apps/nox-server/backup.js` | Копия базы через `VACUUM INTO` (`npm run backup`); порядок восстановления в README |
| `apps/nox-server/.env.example` | Только имена переменных окружения, без значений |
| `apps/nox-server/server.test.js` | Тесты сервера |
| `apps/nox-server/server-account.test.js` | Тесты аккаунтов: сессии, лимиты входа, изоляция пользователей, коды ошибок |

Сервер пока только локальный: нет размещения, оплаты, подтверждения почты и сброса пароля.

## Документы

| Файл | Зачем |
|---|---|
| `PRODUCT.md` | Что за продукт и для кого |
| `DESIGN.md` | Дизайн окна по фактам из кода |
| `docs/research/autonomy-2026-11/STATUS.md` | Журнал автономных заходов: что проверено живьём и чем |
| `docs/research/autonomy-2026-11/FEATURES-18.md` | 18 возможностей и 7 функций со скриншотов: что есть, что частично, чего нет, с файлами |
| `docs/business/plan.md` | Замеры, тарифы, что осталось до продажи |
| `docs/research/jarvis-gaps-minimax-2026-11-01.md` | Самооценка модели. Часть утверждений неверна, сверять с кодом |
| `docs/research/jarvis-rebuild/concepts/architecture-review.md` | Проверка архитектуры, местами уже исправлено |
| `docs/JARVIS-DESIGN-BRIEF.md` | Бриф интерфейса |
| `docs/superpowers/plans/2026-11-07-capability-matrix.md` | Матрица фактического состояния по видеореференсам: статус, доказательство, способ проверки; дефекты этапа 0 |
| `docs/reconstruction/phase3/COMMANDS-PHASE-3.1.md` | Раздел «Команды» после переделки в системе Nox: что сделано, файлы, 15 живых проверок, скриншоты в `docs/reconstruction/phase3/commands/`, ограничения |
| `docs/reconstruction/phase3/connections/REPORT.md` | Раздел «Подключения» после переделки в системе Nox: 7 состояний, поиск/фильтры, популярные, диалоги; 18 живых проверок, скриншоты и baseline в `docs/reconstruction/phase3/connections/`, ограничения |
| `docs/reconstruction/phase3/settings/REPORT.md` | Раздел «Настройки» после переделки в системе Nox: 6 категорий, поиск/чипы, карточки параметров, ИИ и сфера; 18 живых проверок, инвентаризация, скриншоты и baseline в `docs/reconstruction/phase3/settings/`, ограничения |
| `docs/superpowers/plans/2026-11-07-matrix-*.md` | Отчёты по зонам (агент, команды, память, интерфейс, MCP/голос, сервер): что работает, что изменено, контракты IPC |

Имена «JARVIS-*» и «NOX-*» в `docs/` старше кода: при расхождении верь коду.

## Старое: только в рабочем репозитории

Ранний этап проекта и старые документы корня живут в рабочем репозитории разработки и в эту папку релиза не входят. В релизной копии это не нужно и не создаётся.

