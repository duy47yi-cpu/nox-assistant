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
| Свои провайдеры владельца (локальные ИИ) | `src/brain/providers.js`, флаг `src/config/build.js`, сборка `scripts/build-owner.js`, блок `#ownerProviders` в Настройках, вызов `owner:providers` в `main.js` |
| Изменить цены и лимиты подписок | `apps/nox-server/plans.js`, расчёты в `docs/business/plan.md` |
| Уровни мышления | `src/brain/tiers.js`, `THINKING_WEIGHT` и `levels` в `apps/nox-server/models.js`, выбор в `renderer/model-pick.js` |
| Вид чата, цвета, стекло | последние правила в `renderer/themes.css` важнее `renderer/home.css` и `renderer/styles.css` |
| Добавить тему | `renderer/themes.css`, `IDS` в `renderer/theme-boot.js`, кнопка в `renderer/index.html` |
| Сообщения и шаги в чате | `renderer/app.js`, разделы «Диалог» и «Строка действий хода» |
| Новый вызов окно → ядро | `ipcMain.handle` в `main.js` и метод в `preload.js`; для браузерной проверки ещё `renderer/dev-stub.js` |
| Проверка результата действия | `verify` у инструмента, `src/agent/effects.js` |
| Память | `src/memory/store.js`, авто-память `src/memory/learn.js`, инструменты в `src/tools/memory.js` |
| Поиск по подключённым папкам | индекс в `src/rag/index.js`, чтение по режиму в `workspace_read` (`src/tools/workspace.js`), список `connectedFolders` в настройках, `folders:add` и `folders:remove` в `main.js` |
| Долгая работа без владельца | `src/missions/long.js` |
| Задачи по расписанию | `src/missions/` |
| Что Джарвис сообщает сам, тишина, лимит в час | `src/notify/watch.js`; настройки `watchWindow`, `watchTelegram`, `watchPerHour` в `settings.json` |
| Очередь действий на рабочем столе | `src/control/desktop-lock.js` |
| Рабочий стол и виджеты | `src/desks/store.js`, `src/desks/templates.js`, `src/desks/data.js`, `renderer/desks.js`, каналы `desks:*` в `main.js` |
| Расширения (буфер, вставки, загрузки) | `src/extensions/`, `renderer/extensions.js`, каналы `clipboard-history:*`, `snippets:*`, `downloads:*` в `main.js` |
| Паки команд в один клик (Монтаж, Игры, Браузер) | `src/commands/packs.js`; канал `packs:install` в `main.js`, `installPack` в `preload.js`; блок «Паки» в «Командах» — `renderPacks` в `renderer/app.js`; ставятся только по кнопке, при старте не ставятся |
| Голос: громкость, скорость, характер, выбор голоса | `src/voice/tts.js` (`setOptions`), `src/voice/personas.js` (`personaVoiceOptions` — только темп и громкость), `renderer/app.js` (`initVoiceOptions`), настройки `voiceVolume`/`voiceRate`/`voiceSpeaker`/`voicePersona` |
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
| `scripts/` | Проверки: `check-brain.js`, `check-tools.js`, `check-manifest.js`, `check-voice.js` (голос: синтез и проигрывание без окна), `check-notification.js` (системное уведомление во временном профиле), `check-app-startup.js` (запуск Electron с временным профилем и заглушкой), `check-browser-payment-fixture.js` (стенд с платёжной кнопкой), `task-dry-run.js`, `turns-report.js`; сборка владельца `build-owner.js` (кладёт `build-info.json`, `--keep` оставляет его для `npm start`) |
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
| `renderer/app.js` | Логика окна, разделы отмечены `// ──`; панели импорта/экспорта и записи команд, память и напоминания в Настройках, чтение полей прогресса хода |
| `renderer/shared.js` | Общее: подписи инструментов, `humanize`, статусы, состояние шара (включая `verifying`, `success`, `cancelled` и честное «Остановлено») |
| `renderer/cmd-steps.js` | Шаги редактора команд без DOM: перестановка вверх и вниз, текст для «Проверить» |
| `renderer/tools-extra.css` | Дополнительные блоки: список памяти и напоминаний, импорт команд, строки папок и горячих клавиш, сетка рабочего стола и расширения; цвета только из токенов темы |
| `renderer/desks.js` | Рабочий стол: вкладки столов, сетка виджетов, шаблоны, перемещение/размер мышью и клавиатурой, удаление; данные из `desks:state` |
| `renderer/extensions.js` | Настройки → «Расширения»: история буфера, быстрые вставки, уборка загрузок (анализ и подтверждаемое удаление) |
| `renderer/account.js` | Вход, лимиты в Настройках, сообщение о паузе |
| `renderer/model-pick.js` | Выбор модели и мышления у поля ввода |
| `renderer/orb.js`, `renderer/orb-variants.js` | Шар и его виды: `orb.js` — цикл, состояния, голос (`setVoice`), настройки (`setTune`) и Точечная сфера; `orb-variants.js` — Ядро (по умолчанию) и Диафрагма |
| `renderer/orb-tune.js` | Настройки → Вид: свои настройки выбранного вида шара (свечение, скорость, движение, объём, голос, плотность точек) в `jarvis.orbTune`, событие `jarvis:orbtune` |
| `renderer/contour.js` | Контурный фон |
| `renderer/presence.css` | Вид настольного ассистента: рейка с подписями, крошки в шапке, мягкие панели, чат и сцена с шаром, команды и настройки с правой колонкой; последний слой, цвета из тем |
| `renderer/accent.js` | Настройки → Вид: строка «Цвет акцента» (7 кружков и поле HEX), цвет поверх темы через `theme-boot.js`; если контраст ниже 4,5:1, цвет сдвигается и строка под названием говорит, какой взят |
| `renderer/look.js` | Настройки → Вид: шрифты, размер текста, скругление, панели, размер шара, свет за окном, размытие стекла, фон окна; кнопка «Сбросить к теме» (`resetToTheme`: ручки и свой акцент); значения хранит `theme-boot.js` (`jarvis.look`) |
| `renderer/connections.js` | Раздел «Подключения»: сервисы MCP из `mcpServers`, добавление, выключение, удаление; вызовы `mcp:state`, `mcp:add`, `mcp:toggle`, `mcp:remove` в `main.js` |
| `renderer/settings-nav.js` | Настройки: список разделов справа, строится из заголовков карточек |
| `renderer/theme-boot.js` | Тема и свой цвет акцента (`jarvis.accent`: id палитры или `#RRGGBB`) до первой отрисовки; убранные темы тихо открывают «Ночь» |
| `renderer/styles.css` → `renderer/home.css` → `renderer/themes.css` | Стили, каждый следующий важнее |
| `renderer/fonts/` | Шрифты Inter и IBM Plex Serif с лицензиями OFL; семейства, размеры и веса — в начале `renderer/themes.css` |
| `renderer/mini.html`, `renderer/mini.js` | Мини-окно |
| `renderer/dev-stub.js` | Подмена ядра для проверки в браузере |
| `renderer/region.html`, `renderer/region.js` | Рамка «Объясни, что я обвёл» поверх основного экрана: выделение мышью, Esc — отмена; итог уходит заголовком страницы в `region:pick` (`main.js`) |
| `renderer/hands.html`, `renderer/hands.css` | Надпись «Nox работает на вашем ПК · Esc — остановить»: плашка поверх окон и `#handsBanner` в главном окне, включает `showHands` в `main.js` |

### Ядро: `src/`

| Папка | Файлы |
|---|---|
| `src/agent/` | `src/agent/loop.js` цикл; событие прогресса хода (`runId`, `step`, `status`, `label`, `target`, `verification`, `cancelled`) без переименования прежних типов и защита от поздних событий после стопа; поддержка `turnDeadlineMs` — потолок времени хода чата (между шагами, с честным текстом); `src/agent/effects.js` проверка результата; `src/agent/prompt.js` время в промпте; `src/agent/turnlog.js` журнал скорости |
| `src/brain/` | `src/brain/deepseek.js` клиент моделей и поток; `src/brain/tiers.js` выбор модели и мышления; `src/brain/stub.js` заглушка без ключа; `src/brain/providers.js` провайдеры владельца в `providers.json`, ключ зашифрован, только сборка владельца |
| `src/account/` | `src/account/session.js` вход (таймаут запроса к серверу); `src/account/limit-wait.js` ожидание лимита |
| `src/policy/` | `src/policy/modes.js` режимы и запреты; `src/policy/approvals.js` подтверждения; `src/policy/taint.js` заражение контекста: после чужого текста исходящие действия и руки (клики, ввод) спрашиваются, свой снимок экрана руки не останавливает |
| `src/control/` | `src/control/stop.js` аварийный стоп и горячие клавиши; `src/control/desktop-lock.js` очередь рук; `src/control/esc-stop.js` Esc останавливает ход, пока руки работают на столе |
| `src/cost/` | `src/cost/guard.js` страж бюджета; `src/cost/response-cache.js` короткий кеш безопасных точных ответов; `src/cost/meter.js` учёт; `src/cost/prices.js` цены; `src/cost/summary.js` сводка |
| `src/currency/` | `src/currency/rates.js` курс валют ЦБ (cbr-xml-daily.ru): кэш 15 минут, разбор просьбы «какой курс доллара», текст ответа; только чтение |
| `src/journal/` | `src/journal/journal.js` журнал: маскирование секретов до записи, `readJournal`/`searchJournal` с фильтрами (текст, статус, тип, пространство, задание, даты), `historyStatus` не выдаёт непроверенное за выполненное |
| `src/chats/` | `src/chats/book.js` вкладки чатов |
| `src/workspaces/` | `src/workspaces/book.js` реестр пространств и их папок, памяти и целей; `src/workspaces/chat.js` отдельный цикл чата пространства: файлы, память, цели, интернет, картинки, наблюдение и действия на компьютере (руки, установка, почта, PowerShell, браузер); файловые границы, память и цели у пространства свои; авто-память и навыки внутри пространства; `src/workspaces/commands.js` отдельные сценарии команд; `src/workspaces/hub.js` переключение чатов; `src/workspaces/deals.js` отдельные журналы дел и сверка своих поручений; создание и выбор — в главном окне |
| `src/config/` | `src/config/env.js` чтение настроек; `src/config/atomic.js` запись без порчи; `src/config/sandbox.js` рабочая папка; `src/config/paths.js` корень данных (в установленном приложении — папка пользователя) и путь к распакованным скриптам; `src/config/build.js` флаг `OWNER_BUILD` из `build-info.json` (не из окружения) |
| `src/memory/` | `src/memory/store.js` память: список с флагами, правка, удаление, очистка пространства, контекст по явным связям до двух переходов без раскрытия скрытых записей, проверяемая ссылка `source` на файл-источник (хранится, но не читается store); `src/memory/learn.js` авто-память после хода: профиль, привычки и договорённости из слов владельца, без секретов и чувствительного (платежи, коды, отправка, здоровье) |
| `src/goals/` | `src/goals/store.js` цели на несколько ходов: шаги, доказательства, закрытие; `src/goals/tools.js` инструменты `goal_*` |
| `src/deals/` | `src/deals/deals.js` дела и «что повисло» |
| `src/missions/` | `src/missions/long.js` долгие поручения; `src/missions/runner.js` запуск задачи; `src/missions/scheduler.js` расписание; `src/missions/store.js` хранилище миссий с `workspaceId`; `src/tools/missions.js` ограничивает список и отмену текущим пространством |
| `src/schedule/` | `src/schedule/scheduler.js`, `src/schedule/store.js` напоминания: список по пространству, правка/перенос, отмена, ежедневный повтор |
| `src/shortcuts/` | `src/shortcuts/offline.js` короткие фразы без модели: громкость, свернуть окна, таймер, открыть сайт или программу |
| `src/tasks/` | Исполнитель с мандатом: `src/tasks/executor.js` (отчёт: доказательства, изменения в файлах, тесты, оставшиеся проблемы), `src/tasks/runtime.js` сборка, `src/tasks/mandate.js` границы, `src/tasks/model.js`, `src/tasks/queue.js`, `src/tasks/store.js`, `src/tasks/tools.js`, `src/tasks/verify.js`, `src/tasks/criteria.js`, `src/tasks/attention.js`, `src/tasks/link.js`, `src/tasks/board.js` доска «Центр управления миссиями»: строки задач, сводка и порядок (чистые функции) |
| `src/commands/` | `src/commands/runner.js` шаги через политику и проверку результата (`commandLabel` без «undefined», выключенная команда не запускается), `CommandRecorder` для записи действий с предупреждениями; `src/commands/store.js` схема команды v2 (папка, коллекции, горячая клавиша, происхождение), экспорт без секретов, импорт с предпросмотром/diff и подтверждением, лимиты; `src/commands/samples.js` готовые примеры (10: «Работа», «Игра», «Отбой» и группа «Windows» из 7 команд); `src/commands/builder.js` сборка сценария из описания словами (модель внедряется, опасные инструменты запрещены, план без сохранения); `src/commands/packs.js` паки команд (монтаж, игры, браузер) и `seedPackCommands` |
| `src/library/` | `src/library/index.js`, `src/library/access.js`, `src/library/validator.js` библиотека Python-команд |
| `src/desks/` | `src/desks/store.js` рабочие столы: раскладка виджетов на пространство в `desks.json`, сетка 12×12, лимиты и атомарная запись; `src/desks/templates.js` 16 типов виджетов (задачи, сегодня, музыка, погода, курсы, компьютер, программы, аватар, команды, цели, миссии, напоминания, заметки, загрузки, MCP, питомец) и 9 шаблонов (пустой, работа, учёба, игры, медиа, аватар, ночь, разработка, стрим; без выдуманных источников, питомец — только анимация); `src/desks/data.js` чистые состояния виджетов из внедрённых источников (`ok`/`empty`/`error`/`stale`) |
| `src/extensions/` | `src/extensions/clipboard-history.js` история буфера: пароли, коды и карты не сохраняются, срок хранения, пауза, очистка; `src/extensions/snippets.js` быстрые вставки: уникальные триггеры и текст, вставка только по явному подтверждению; `src/extensions/downloads-cleanup.js` уборка загрузок: анализ и предпросмотр только чтением, удаление только с `confirm` и только внутри папки |
| `src/inventory/` | `src/inventory/apps.js`, `src/inventory/usage.js`, `src/inventory/consent.js` программы владельца |
| `src/music/` | `src/music/intent.js`, `src/music/play.js` поиск видео на YouTube, `src/music/match.js` сверка названия с просьбой: открыть сразу или спросить номер |
| `src/rag/` | `src/rag/index.js` поиск по рабочей и подключённым папкам, границы путей |
| `src/research/` | `src/research/claims.js` проверка утверждений исследования по собранным источникам: наборы источников живут только в памяти процесса (TTL, лимиты), дословная цитата сверяется с текстом источника |
| `src/skills/` | `src/skills/index.js` навыки; `src/skills/experience.js` опыт: после хода с подтверждёнными действиями сохраняет последовательность инструментов и названные в просьбе цели `app_open`/`ui_click`/`desktop_click`; отдельно текст ввода и данные окон не сохраняет. Точный повтор получает подсказку в контексте, без дополнительного вызова модели; навыки отдельных пространств хранятся отдельно |
| `src/telegram/` | `src/telegram/bridge.js` мост (текст, голосовые, фото, видео и файлы от владельца: скачивание во временную папку, расшифровка голосовых, если передан расшифровщик; ответы «печатает» с делением длинных сообщений; отправка фото и видео владельцу `sendPhoto`/`sendVideo`, `notify` для инициативных сообщений); `src/telegram/policy.js` что можно удалённо и кому можно писать (`mayWriteTo`) |
| `src/notify/` | `src/notify/watch.js` поводы, о которых Джарвис говорит сам: новые файлы в `workspace/inbox`, зависшие приложения Windows, задачи и миссии, срок напоминания, расход у дневного лимита; тишина ночью и лимит в час |
| `src/validate/` | `src/validate/connections.js` проверка связей |
| `src/screen/` | `src/screen/region.js` область, обведённая владельцем: проверка рамки (целые координаты, границы экрана, минимум 8×8), приведение к границам, перевод в пиксели снимка, описание словами; `src/screen/agent.js` агент экрана: «сделай на экране: …», снимок → один шаг → проверка, до 40 шагов; опасные шаги (отправить/оплатить/удалить/установить, Enter после ввода) выполняются только после подтверждения владельца, при отказе — `needs_human` без повтора |
| `src/perception/` | `src/perception/scene.js` единый снимок сцены: окно, элементы с устойчивыми id, фокус, дельта между шагами; чистые функции без ввода-вывода |
| `src/voice/` | `src/voice/beep.js` звук «дзинь» после успешной команды окна (WAV через PowerShell, без ожидания ответа; громкость и тихий режим); `src/voice/tts.js` локальный голос Silero, повтор проигрывания и остановка; `src/voice/fish.js` голос Fish Audio по HTTP (mp3, ключ `FISH_API_KEY` в `.env`, проигрывание WPF MediaPlayer); `src/voice/personas.js` характеры речи: пресеты темпа и громкости («Как есть», «Дворецкий», «Помощница», «Инженер»), голос не меняют, неизвестный id открывает «Как есть»; `src/voice/dictation.js` диктовка: распознанная речь останавливает текущий ход и остаётся в поле ввода; `src/voice/wake.js` обращение «Джарвис» в начале сказанного: команда сразу уходит в чат, кулдаун, без дубля в поле ввода |
| `src/mcp/` | `src/mcp/client.js` свой клиент MCP (stdio и http), инструменты серверов из `mcpServers` в настройках, без вопроса только имена из `mcpAllow`; `src/mcp/catalog.js` курируемый каталог MCP-серверов (36 записей, 11 категорий, без сети; `verified:false` — не проверено) |
| `src/mail/` | `src/mail/gmail.js` зашифрованный доступ и Gmail API; `src/mail/oauth-loopback.js` — вход через системный браузер и локальный callback; учётные данные `NOX_GMAIL_CLIENT_ID`, `NOX_GMAIL_CLIENT_SECRET` |
| `src/weather/` | `src/weather/open-meteo.js` погода open-meteo без ключей, кэш 30 минут |

### Инструменты: `src/tools/`

| Файл | Инструменты |
|---|---|
| `src/tools/registry.js` | Реестр |
| `src/tools/agents.js` | Ролевые агенты: исследование и анализ параллельно, редактор файлов после читателей; общий вывод сводит главный агент |
| `src/tools/profiles.js` | Что доступно в фоне |
| `src/tools/system.js` | `volume_set`, `app_open`, `url_open`, `shell_run` |
| `src/tools/ui.js` | `ui_*`: окна, нажатия, ввод, клавиши; `ui_elements` отдаёт ещё и координаты элементов |
| `src/tools/observe.js` | `desktop_observe`: один снимок рабочего стола (окно, фокус, элементы с id и координатами, дельта с прошлого вызова); `desktop_click` и `desktop_type`: нажатие и ввод по id с перечитыванием окна и снимком изменений; нажатие мышью по центру координат — только если у элемента нет подписи или `ui_click` недоступен; после отказа или неизвестности вложенного нажатия мышью не повторяет; успех не подменяется сменой окна |
| `src/tools/install.js` | `app_search`, `app_install`: поиск и установка программ через winget; установка всегда с вопросом (`isInstall` в `src/policy/modes.js`), только в чате |
| `src/tools/ps-host.js` | Один живой PowerShell для `ui_*`: запрос ~10 мс вместо ~0,4 с на новый процесс |
| `src/tools/mouse.js` | `mouse_click`, `mouse_scroll`; `units=physical` — настоящие пиксели (так нажимает `desktop_click`), иначе точки снимка |
| `src/tools/windows.js` | `windows_list`, `windows_focus`, `windows_snap`: прикрепить окно к половине экрана, развернуть или свернуть по названию (title); окна Nox не трогает |
| `src/tools/windows-close.js` | `windows_close_all`: закрыть окна программ как по крестику, кроме окон Джарвиса и оболочки Windows; только в чате |
| `src/tools/youtube.js` | `youtube_play`: первое видео по запросу, `start` — с какой секунды (`t=16s`); только в чате |
| `src/tools/disk.js` | `disk_free_space`, `disk_cleanup_suggest` |
| `src/tools/desktop.js` | `wait`, `app_close`, `speak`, свернуть окна, выключить монитор |
| `src/tools/wait.js` | `wait_for` |
| `src/tools/screen.js` | `screen_look`; `screen_region_look`: область, которую владелец обвёл кнопкой у поля ввода, только в чате окна, снимок только в памяти |
| `src/tools/clipboard.js` | Буфер обмена |
| `src/tools/media.js` | `media_control`: плеер Windows (играть, пауза, следующий) |
| `src/tools/ocr.js` | `image_read_text`: текст с картинки в рабочей папке (встроенное распознавание Windows); `image_look`: картинка целиком уходит модели — фото, схемы, графики, ошибки на экране (PNG, JPG, WebP, GIF; BMP/TIFF переводятся в JPEG) |
| `src/tools/browser.js` | `browser_*`: скрытый Chromium с постоянными входами |
| `src/tools/web.js` | `web_search`, `web_wiki`, `web_fetch`, `web_research` (несколько запросов и чтение найденных страниц), `web_check_claims`: сверка утверждений с дословными цитатами по собранным источникам (не доказывает истинность, только совпадение), защита от локальных адресов |
| `src/tools/workspace.js` | `workspace_*`: чтение, запись, поиск, перенос, копия, папки; перед перезаписью файла кладёт прежнюю версию в `backups/` (до 50 копий всего, не больше 20 на файл; ссылки и junction отклоняются), вернуть её — `workspace_restore` (`list: true` показывает копии, восстановление сначала сохраняет текущую версию); `backups/` не показывается в списке |
| `src/tools/project.js` | `project_brief`: разбор папки проекта, типов файлов, недавних изменений и подсказка про тесты; `project_commands`: какие команды сборки и тестов ждать по файлам проекта; `project_run`: запуск одной из найденных команд в папке проекта с кодом выхода и хвостом вывода (T2, только в чате; в фоне, миссиях и мандате не даётся); `project_diagnostics`: ошибки из указанного журнала .log/.txt, без запуска сборки; в обычных режимах — внутри рабочей папки, в «Полном доступе» можно указать другую папку |
| `src/tools/documents.js`, `src/tools/zip.js` | `document_read`, `document_write`: Word, Excel, CSV, PDF, презентация pptx |
| `src/tools/docx-fill.js` | Шаблон Word с ключами `{{ключ}}`: подстановка значений (диплом, справка по образцу), `document_fill` в `documents.js` |
| `src/tools/pptx.js` | Презентация .pptx без установки программ: тёмные слайды с акцентом, обложка и маркированные списки; проверка по числу слайдов (`document_write` с format `pptx`) |
| `src/tools/code.js` | `code_*`, `code_test`: только для исполнителя с мандатом |
| `src/tools/memory.js` | `remember` (с необязательными `source` и `quote` — проверяемая ссылка на файл-источник), `recall` и `memory_about` (показывают источник и его состояние: не менялся, изменился, файла нет), `forget` |
| `src/tools/reminders.js` | Напоминания |
| `src/tools/missions.js` | `mission_*`, список, добавление и отмена в пределах текущего пространства |
| `src/tools/commands.js` | `command_*`: создание из текста с `dryRun: true` (план без сохранения и запуска), сборка сценария по описанию словами `command_build` (план или сохранение), каталог настоящих действий `command_list({withParameters:true})` |
| `src/tools/deals.js` | `deals_hanging`, `deal_add`, `deal_clear` |
| `src/tools/inventory.js` | `apps_*` |
| `src/tools/skills.js` | `skills_list`, `skill_read` |
| `src/tools/mail.js` | `mail_send`: отправка; `mail_unread`: заголовки и фрагменты непрочитанных писем при отдельном разрешении |
| `src/tools/weather.js` | `weather_now`: текущая погода по open-meteo; город из аргумента или настроек |
| `src/tools/currency.js` | `currency_rate`: курс валют ЦБ к рублю (USD, EUR, CNY и другие), кэш 15 минут; короткая просьба про курс отвечается без модели и браузера |
| `src/missions/long.js` | `long_task_*` |
| `src/tasks/tools.js` | `task_*` |

### Данные: `NOX_DATA_DIR`, по умолчанию `data/` в корне

`settings.json`, `gmail.bin`, `conversation.json`, `journal.jsonl`, `turns.jsonl`, `budget.json`, `memory.json`, `goals.json`, `reminders.json` (в старых и общих записях пространство не указано; новые записи могут содержать `workspaceId`), `missions.json`, `long-tasks.json`, `tasks.json`, `commands.json` (команды «Общего»), `workspaces/<id>/commands.json` (команды отдельного пространства), `deals.jsonl`, `deals.json`, `apps.json`, `app-usage.json`, `music-history.json`, `attention-hidden.json`, `desks.json` (столы и виджеты по пространствам), `clipboard-history.json`, `snippets.json`, `account.bin`, `providers.json` (только сборка владельца), `skills/`.

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
| `docs/superpowers/plans/2026-11-07-matrix-*.md` | Отчёты по зонам (агент, команды, память, интерфейс, MCP/голос, сервер): что работает, что изменено, контракты IPC |

Имена «JARVIS-*» и «NOX-*» в `docs/` старше кода: при расхождении верь коду.

## Старое: только в рабочем репозитории

Ранний этап проекта и старые документы корня живут в рабочем репозитории разработки и в эту папку релиза не входят. В релизной копии это не нужно и не создаётся.
