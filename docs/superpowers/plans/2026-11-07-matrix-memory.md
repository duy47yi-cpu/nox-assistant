# Матрица этапа 3: память, история, задачи и напоминания

> Рабочий документ исполнителя `memory-data`. Источник: `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, разбор видео (`2026-11-07-video-analysis.md`: видео 3, 00:28–00:34 — память, заметки, задачи, календарь; видео 1, 00:28–00:34 — будильник/напоминание и сохранение команды), план (`2026-11-07-nox-reference-implementation.md`, этап 3) и глубокая спецификация (`2026-11-07-deep-implementation-spec.md`, этап D).
>
> Метод: чтение исходников и тестов без запуска приложения; проверки только через `node --test` с временными каталогами. Настоящая папка `data/` и `.env` не читались. Никакие пакеты не устанавливались. `main.js`, `preload.js`, `renderer/app.js`, `renderer/index.html`, `AGENTS.md` не изменялись.
>
> Статусы: **работает** — есть код и проверка; **частично** — есть, но не покрывает требование целиком; **отсутствует** — кода/экрана нет; **не проверено** — в живом окне не смотрел (интерфейс не моя зона).
> Проверка кода/данных — это не проверка в настоящем Electron-окне; строки «UI» отмечены отдельно.

## 1. Итоговая матрица

| # | Возможность | Видео | Состояние | Доказательство (файл) | Как проверено |
|---|---|---|---|---|---|
| 1 | Авто-память после хода: профиль, привычки, договорённости без вызова модели | 3, 00:28–00:34 | работает | `src/memory/learn.js` (`RULES`, `learnFromTurn`); вызовы `main.js:1510–1515`, `src/workspaces/chat.js:185–188` | `tests/memory-learn.test.js`: извлечение, дубли, противоречия, выключение |
| 2 | Явное запоминание: `remember`, `recall`, `memory_about`, `forget` | 3, 00:28–00:34 | работает | `src/tools/memory.js` (`memoryTools`), `main.js:467,540,810` | `tests/memory.test.js`: CRUD, права T0/T2, verify, источник |
| 3 | Исключение чувствительного из авто-памяти: пароль, здоровье, платёж, код, отправка | 3, 00:28–00:34; deep-spec D | частично → **исправлено** | `src/memory/learn.js:11–23` (`SENSITIVE`, `SENSITIVE_VALUE`, `isSensitiveFact`), проверка в `learnFromTurn` | новые тесты в `tests/memory-learn.test.js`: 8 чувствительных входов + `isSensitiveFact`; обычная просьба всё ещё пишется |
| 4 | Чувствительное в памяти: пометка `sensitive`, скрыто от поиска/контекста, видно на явный вопрос | 3 | работает | `src/memory/store.js` (`visible`, `search(opts)`, `about`, `profile`) | `tests/memory.test.js`: sensitive-контекст, recall с флагом |
| 5 | Просмотр памяти списком | 3, 00:28–00:34 | частично | API: `MemoryStore.list(limit, opts)` (добавлены `includeSensitive`/`includeExpired`); IPC/экрана нет: в `main.js`/`preload.js` нет `memory:` обработчиков, в `renderer/` нет раздела «Память» | новые тесты `tests/memory.test.js` (`list`, `count`); контракт IPC — раздел 4 |
| 6 | Правка записи памяти | 3 | отсутствовало → **добавлено API** | `src/memory/store.js`: `update(id, patch)` — text/kind/about/links/until/sensitive, `id`/`createdAt` целы, `updatedAt` | новые тесты `tests/memory.test.js`: правка, перезапуск, отказ на пустом тексте/секрете/дате |
| 7 | Удаление записи памяти | 3 | работает | `MemoryStore.remove(id)`; инструмент `forget` (T2, `src/tools/memory.js`) | `tests/memory.test.js`: `remember → recall → forget`, verify |
| 8 | Очистка памяти по пространству | 3 | отсутствовало → **добавлено API** | `src/memory/store.js`: `clear()` + `count()`; у каждого пространства свой файл памяти (`src/workspaces/book.js:145–164`: `memory.json` в папке пространства) | новые тесты `tests/memory.test.js`: два файла-пространства, очистка одного не задевает другой; нет файла — 0; битый — не перезаписывается |
| 9 | Выключение обучения памяти | 3 | работает | настройка `memoryAuto` (`main.js:2232–2247`, `main.js:1144,1511`; чекбокс `data-setting="memoryAuto"` в `renderer/index.html`) | `tests/memory-learn.test.js`: `learnFromTurn({auto:false})`; проверка ключей `main.js`/html; `tests/workspace-chat.test.js`: выключатель памяти пространства и «ответ модели не учится» |
| 10 | Битый JSON / отсутствие файла памяти | — | работает в рамках принятого поведения | `MemoryStore._load`: нет файла — пусто; битый — исключение, файл не перезаписывается; вызывающие (промпт/фон/инструменты) ошибку гасят | `tests/memory.test.js`: «повреждённая память не ломает промпт и фон», «повреждённый файл не перезаписывается» |
| 11 | История действий: запись с датой, статусом, причиной, связью с заданием | 1, 00:04–00:15; 3 | работает | `src/journal/journal.js` (`Journal.append`); поля `ts, tool, args, decision, ok, summary, callId, verified, evidence` из `src/agent/loop.js:576–587`; `source/taskId/mission/long/command` из исполнителей (`src/tasks/executor.js:906–908`, `src/tasks/runtime.js:253–255`, `src/commands/runner.js:62`, `src/missions/runner.js:71`) | `tests/journal*.test.js`, `tests/journal-v2.test.js`, `tests/journal-failure.test.js` |
| 12 | Маскирование секретов до записи в журнал | 1, 00:04–00:15; deep-spec D | частично → **расширено** | было: только набранный текст (`maskArgs`); добавлено: `maskSecretText`/`maskSecrets` — секретные поля, «пароль: …», `sk-/ghp_/xox*`, приватные ключи, длинные токены; маскируются и `summary`/`evidence` | новые тесты `tests/journal-search.test.js` (6 тестов маскирования) + прежние `tests/journal-mask.test.js` без изменений |
| 13 | Поиск и фильтрация истории | 1, 00:04–00:15; deep-spec D | частично | экран: фильтр по статусу и поиск строкой по последним 200 записям (`renderer/app.js:1385–1428`, `renderer/index.html` `#statusFilter`, `JOURNAL_LIMIT=200`); добавлен API чтения: `readJournal`/`searchJournal` (query, status, tool, source, workspaceId, taskId, from/to, limit/offset) | новые тесты `tests/journal-search.test.js`: 11 тестов чтения/фильтров/дат/страниц/заданий/пространств; UI-фильтры типа/даты — контракт в разделе 4 |
| 14 | Честный статус истории: «не проверено» не выглядит выполненным | 1, deep-spec B/D | частично → **API выправлен** | `historyStatus`: `verified:'unknown' → unverified`; запись без `ok` (события хода) → `unverified`, а не `done`; отказ/провал различаются. Прежнее поведение экрана: `renderer/shared.js:360–373` (`statusOfRecord`) | новые тесты `tests/journal-search.test.js`: таблица статусов; прежние тесты `renderer` не трогались |
| 15 | Дела («что повисло») как единый вид задач/напоминаний/миссий/провалов | 3, 00:28–00:34 | работает | `src/deals/deals.js`: событийный журнал + снимок, `syncDeals`, группы `waiting/failed/overdue/stale/unverified`, `hangingText`; экран «Дела» — `renderer/app.js:126–210`, IPC `deals:list`/`deals:clear` (`main.js:2321–2338`) | `tests/deals.test.js` (13 тестов): перезапуск, отставший/битый снимок, сверка источников, просрочка, текст |
| 16 | Напоминания: создать (через N минут / на время), список, отмена | 1, 00:28–00:34 | работает | `src/tools/reminders.js` (`remind_in`, `remind_at`, `list_reminders`, `cancel_reminder`), `src/schedule/store.js`, `src/schedule/scheduler.js` | `tests/reminders.test.js`, `tests/scheduler-retry.test.js` |
| 17 | Часовой пояс напоминаний | 1, 00:28–00:34; deep-spec D | работает | `src/tools/reminders.js`: местное `YYYY-MM-DDTHH:mm` через `resolveLocalTime` (несуществующее/двойное время при переводе часов — отказ), ISO с поясом; в файл — UTC ISO; миссии daily считают местные `ЧЧ:ММ` (`src/missions/store.js:75–85`) | `tests/reminders.test.js`: подпроцесс `TZ=America/New_York` (дыра/повтор/норма), `+03:00` → UTC; новый тест «разные пояса, один момент» |
| 18 | Повтор напоминания | 1 | частично | хранилище умеет `repeat:'daily'`: `add`, `markFired` (сдвиг на сутки, пропущенные дни перешагиваются); инструменты `remind_in/remind_at` передают `repeat:null` — из чата ежедневное не поставить | `tests/reminders.test.js`: «markFired: ежедневное…», новые «daily переживает перезапуск»; инструменты — вне моей зоны (`src/tools`), контракт для lead — раздел 4 |
| 19 | Просрочка и честная доставка | 1 | работает | `ReminderStore.due`, `Scheduler`: `LATE_MS=5 мин`, флаг `late`, ошибка notify не закрывает напоминание, повтор с backoff, без дублей (`src/schedule/scheduler.js`) | `tests/reminders.test.js`, `tests/scheduler-retry.test.js` (13+ тестов); новый тест «просрочка после рестарта ждёт и доставляется с late=true» |
| 20 | Отмена и восстановление после рестарта | 1, deep-spec D | работает | файл `reminders.json` читается при каждой операции; `cancel`; `update`; нет файла — пусто, битый — исключение без перезаписи | `tests/reminders.test.js`: прежние + новые «отмена переживает перезапуск», «daily после рестарта не дублируется» |
| 21 | Изменение (перенос) напоминания | deep-spec D | отсутствовало → **добавлено API** | `src/schedule/store.js`: `update(id, {text,dueAt,repeat})`; перенос возвращает разовое в ожидание (`done=false`, `firedAt=null`); правит только свой файл/пространство | новые тесты `tests/reminders.test.js` (2 теста) |
| 22 | Задачи по расписанию | 3 | работает | `src/missions/store.js` (interval/daily, `skipStale` после сна, `markStart` до действия, `interrupted`/`closeInterrupted`), `src/missions/scheduler.js` (`reconcile`, вердикты, стоп) | `tests/missions.test.js`, `tests/missions-recovery.test.js`, `tests/missions-stale.test.js`, `tests/chats.test.js` (стоп планировщика) |
| 23 | Заметки отдельной сущностью | 3, 00:28–00:34 | отсутствует | отдельного хранилища заметок нет; «заметка» есть только как `kind:"note"` в памяти и как дело/цель. Не заводил новое хранилище (запрет «не плодить без нужды») | источник-инвентаризация: `src/` без notes-модуля; `AGENTS.md` «Данные» |
| 24 | Календарное представление | 3, 00:28–00:34 | отсутствует | календарного экрана нет; «Сегодня» показывает до двух поручений/дел со сроком на сегодня (`renderer/app.js:159–165`), полный список — «Дела»; напоминания/миссии по датам есть в данных | чтение `renderer/app.js`; раздел «Остаток» |
| 25 | Цели на несколько ходов | — | работает | `src/goals/store.js`, `src/goals/tools.js`, `goalsBrief` в промпте (`main.js:1075`, `src/workspaces/chat.js:122`) | `tests/goals.test.js` |
| 26 | Вкладки чатов и сохранение истории | 4 | работает | `src/chats/book.js` (старый формат → первая вкладка, пустой чат, select/close), сохранение с маскировкой `maskHistory` (`main.js:276–281`) | `tests/chats.test.js` |
| 27 | Разделение памяти/целей по пространствам | 3 | работает | `src/workspaces/book.js:145–164` — у каждого пространства свой `memory.json`/`goals.json`; `src/workspaces/chat.js:122–130` берёт память пространства | `tests/workspace-chat.test.js` (автопамять пространства не смешивается, выключатель); новые тесты памяти на два файла |
| 28 | История по пространствам | 3 | частично | журнал пишет `workspaceId` для чатов пространств (`main.js:1143`), но экран «История» его не фильтрует; добавлен фильтр `workspaceId` в `searchJournal` | новые тесты `tests/journal-search.test.js`; UI — контракт |

## 2. Что изменено (минимально, в своей зоне)

| Файл | Изменение | Зачем |
|---|---|---|
| `apps/jarvis-desktop/src/memory/store.js` | `list(limit, opts)` с явными флагами; `update(id, patch)`; `clear()`; `count()`; общий признак `looksSensitive` для авто-памяти | просмотр/правка/удаление/очистка памяти по пространству (файл = пространство), API для будущих IPC |
| `apps/jarvis-desktop/src/memory/learn.js` | проверка чувствительного вынесена в `store.looksSensitive` и расширена: платёж, перевод, коды, отправка, аллергия/диабет, номера карт; экспорт `isSensitiveFact` | авто-память не сохраняет пароль, здоровье, платёж, коды, отправку; одна точка правды |
| `apps/jarvis-desktop/src/journal/journal.js` | маскирование секретов до записи (`maskSecrets`, `maskSecretText`); `historyStatus`; `readJournal`; `searchJournal` | честная история: поиск/фильтры, секретов нет в файле, «не проверено» не выглядит выполненным; неизвестные поля (`runId`, `step`) сохраняются |
| `apps/jarvis-desktop/src/schedule/store.js` | `update(id, patch)` — правка/перенос напоминания | создание/изменение/отмена напоминаний без нового хранилища; перенос не оставляет разовое «выполненным» |
| `apps/jarvis-desktop/tests/memory.test.js` | +7 тестов API памяти | правка, очистка по пространствам, флаги просмотра, чувствительное |
| `apps/jarvis-desktop/tests/memory-learn.test.js` | +11 тестов (8 входов + бытовой + truth table) | тесты на чувствительных входах, как требует задание |
| `apps/jarvis-desktop/tests/journal-search.test.js` | новый файл, 17 тестов | маскирование до записи, чтение/поиск/фильтры, честные статусы, битые строки/нет файла |
| `apps/jarvis-desktop/tests/reminders.test.js` | +4 теста | правка/перенос, повтор и часовой пояс после рестарта, просрочка и отмена после рестарта |

Ничего не переписывал: чаты, дела, цели, миссии, планировщики оставлены как есть — их тесты проходят. Новых `src/`-файлов не появлялось, карту `AGENTS.md` менять не нужно.

## 3. Проверка

Команда (из `apps/jarvis-desktop`):

```
node --test tests/memory.test.js tests/memory-learn.test.js tests/chat-memory.test.js tests/journal.test.js tests/journal-mask.test.js tests/journal-failure.test.js tests/journal-v2.test.js tests/journal-search.test.js tests/reminders.test.js tests/scheduler-retry.test.js tests/deals.test.js tests/goals.test.js tests/chats.test.js tests/missions.test.js tests/missions-recovery.test.js tests/missions-stale.test.js tests/budget-timezone.test.js tests/clock.test.js
```

Результат целевой команды: **220 тестов, 220 pass, 0 fail** (включая 17 новых в `journal-search.test.js` и 22 добавленных в существующие файлы: 7 память, 11 авто-память, 4 напоминания).

Полный прогон (из `apps/jarvis-desktop`, после всех правок моей зоны и текущих правок других исполнителей): **1624 теста, 1624 pass, 0 fail** (число растёт по мере правок соседних зон; на момент финальной проверки — так). Тесты сервера (`apps/nox-server`): **31 тест, 31 pass, 0 fail**.

Замечания о прогонах: в промежуточном полном прогоне один раз падал живой PowerShell-тест `tests/computer-use.test.js` (GetLastInputInfo) — при повторе прошёл, это флейк окружения, не моя правка; также до правок соседней зоны падал `tests/humanize.test.js` на подписях `command_plan`/`command_actions` — к финальному прогону исправлен не мной.

Отдельно проверено вручную кодом:

- `MemoryStore.update` не меняет `id`/`createdAt`, отказывает на пустом тексте, секрете и плохой дате, файл после отказа не переписан.
- `MemoryStore.clear` на битом файле бросает и файл не трогает; на отсутствующем — 0 и не создаёт файл.
- `Journal.append` возвращает уже обезличенную запись, аргументы вызывающего не мутирует; JSONL остаётся «одна запись — одна строка», `ts` ставит журнал.
- `historyStatus`: `ok:true, verified:'unknown'` → `unverified`; `verified:'failed'` → `failed`; `decision:'deny'` → `refused`; запись без `ok` → `unverified`.
- `searchJournal` не падает на отсутствующем файле/битых строках, фильтры валидируют статус и даты, страницы ограничены 500.
- `ReminderStore.update` переносит время, сбрасывает `done/firedAt` только при смене времени; при ошибке файл не пишется.

## 4. Контракт IPC/интеграции (для lead — `main.js`/`preload.js`/`renderer`)

Ничего из этого не реализовано в интерфейсе; ниже точные вызовы, которые уже поддержаны моим кодом. Все чтения/записи — только для окна (`fromWindow`), как принято в `main.js`.

### Память (новые обработчики `main.js` + методы `preload.js` + экран)

Текущее пространство: `id === 'default' ? memory : workspaceHub.current().memory` (у `WorkspaceChat` это `session.space.memory`; в `main.js` для пространств память берётся через `book.open(id).memory`, см. `src/workspaces/book.js:164`).

| IPC | Аргументы | Возврат |
|---|---|---|
| `memory:list` | `{ limit?: 1..200, includeSensitive?: boolean, includeExpired?: boolean }` | `{ ok: true, items: Record[] }` (`list(limit, opts)`) |
| `memory:update` | `id: string, patch: { text?, kind?, about?, links?, until?, sensitive? }` | `{ ok: true, item }` или `{ ok: false, error }`; `null` → `{ ok: false, error: 'такой записи нет' }` |
| `memory:remove` | `id: string` | `{ ok, removed: boolean }` (`remove`); удаление памяти — по решению владельца, окно подтверждает само |
| `memory:clear` | `{ confirm: true }` — явное подтверждение | `{ ok: true, removed: number }` (`clear()`); чистит только память текущего пространства |
| `memory:learning` | — | существующая настройка: `settings:set('memoryAuto', boolean)` уже есть; отдельный канал не нужен |

`preload.js`: `memoryList(options)`, `memoryUpdate(id, patch)`, `memoryRemove(id)`, `memoryClear(confirm)`. В `renderer/dev-stub.js` — заглушки с пустым списком. Экран: список с датой `createdAt`/`updatedAt`, видом и пометкой «чувствительное», кнопки «Изменить/Удалить/Очистить», переключатель авто-памяти. Секреты показывать нельзя: `update` всё равно откажет на «пароль: …».

### История (расширение существующего экрана и канала)

Новый обработчик `journal:search` (в дополнение к `journal:recent`):

| IPC | Аргументы | Возврат |
|---|---|---|
| `journal:search` | `{ query?, status?: 'all'\|'confirmed'\|'unverified'\|'failed'\|'refused'\|'error'\|'done', tool?, source?, workspaceId?, taskId?, from?, to?, limit?: 1..200, offset? }` | `{ items, total, skipped, problem }`; `items[i]` — запись журнала + вычисленный `status` |

Вызов: `searchJournal(path.join(DATA_DIR, 'journal.jsonl'), filters)`. `problem` показывать текстом («Журнал не прочитан: …»), а не пустым экраном. Неверный статус или дата в фильтре бросают `Error` — обработчик IPC обязан поймать и вернуть `{ ok: false, error }` (как `deals:list`/`journal:recent` уже делают через try). Экран: добавить фильтр по типу (tool) и датам; статус брать из `items[i].status` (не пересчитывать своей копией); «не проверено» — нейтрально, «подтверждено» — только при `verified:'confirmed'`; раскрытие записи показывает `evidence`, `source`, `taskId`/`mission`/`long` (связанное задание). Секретов в `args/summary/evidence` уже нет — их маскирует `append`.

### Напоминания/задачи (экрана нет; если lead делает экран)

| IPC | Аргументы | Возврат |
|---|---|---|
| `reminders:list` | `{ includeDone?: boolean }` (пространство — текущее) | `{ ok, items }` (`ReminderStore.list({ workspaceId })`) |
| `reminders:update` | `id, { text?, dueAt?, repeat? }` | `{ ok, item }` или отказ; `dueAt` — ISO с поясом |
| `reminders:cancel` | `id` | `{ ok, removed }` |

Создание уже доступно модели инструментами `remind_in`/`remind_at`; в UI вести ввод времени в местном времени и показывать `dueAt` как местное (`new Date(dueAt)`), не строкой UTC. Ежедневный повтор хранилище поддерживает (`repeat:'daily'`), но инструменты его пока не передают — если нужно ставить из чата, правка в `src/tools/reminders.js` (не моя зона): добавить параметр `repeat: 'daily'`.

## 5. Дефекты и остаток

Найдено и исправлено (в моей зоне):

1. Авто-память пропускала платёж/перевод («перевести» не совпадало с `перевед`), коды, отправку, аллергию/диабет без слов «диагноз/болезнь» — расширена проверка, добавлены тесты на 8 входов.
2. Секреты в журнале маскировались только для `ui_type`/`clipboard_set`/`browser_type`; пароль в `args.password`, в `summary`/`evidence`, `sk-`-ключи и приватные ключи попадали в файл — теперь маскируются до записи, неизвестные поля (в т.ч. будущие `runId/step`) сохраняются.
3. У истории не было программного чтения/фильтров (только последние 200 без типа/даты/задания); добавлены `readJournal`/`searchJournal` с валидацией.
4. Запись журнала без `ok` (события хода/модели) на экране могла выглядеть «выполнено»; `historyStatus` на чтении возвращает `unverified` (экранный `statusOfRecord` не менял — чужой файл; если lead захочет, заменить в `renderer/shared.js` на вызов того же правила).
5. У памяти не было правки и очистки, у напоминаний — переноса/правки; добавлены `MemoryStore.update/clear`, `ReminderStore.update` с проверками и тестами.

Что попробовал и откатил (чтобы не сломать работающее): автоматически ставить `sensitive` в `MemoryStore.add` по одному упоминанию «пароль/платёж/код». Это ломало принятое поведение (`tests/second-hands.test.js`: заметка «пароль от роутера на наклейке» должна находиться поиском; `tests/memory.test.js`: «сама мысль о пароле без значения записывается»). Итог: чувствительное исключает авто-память (`learn.js`), а явная запись помечается флагом `sensitive` — решение владельца/модели, как и было в контракте `remember.sensitive`. Это осознанная граница, а не недоделка.

Остаток (осознанно не делал / не моя зона):

- Экрана памяти, заметок, календаря и напоминаний нет: нужен интегратор (`main.js`/`preload.js`/`renderer`), контракт выше. Это честно «отсутствует», а не «работает».
- Ежедневный повтор напоминания нельзя поставить из чата (инструменты в `src/tools` — не моя зона; хранилище готово).
- История по пространствам в UI не фильтруется (API готов).
- Чат/история: дефекты agent-core (прогресс, отмена) — не моя зона; `journal.append` их не ломает (неизвестные поля сохраняются).
- Живое окно не проверял: интерфейс не входил в мою зону и не менялся.

