# Phase 3.4 — текущее состояние: журнал, ход агента, подтверждения

Статус: подготовка, только чтение. Исходный код, данные, настройки, разрешения и IPC не менялись. Приложение не запускалось, тесты не запускались, коммитов нет.

Снимок: рабочая копия `D:/nox-release`, приложение `apps/jarvis-desktop`. В копии есть незакоммиченные правки Phase 3.3 (DeepSeek), поэтому номера строк ориентировочные. Ориентироваться на имена функций.

---

## 1. Что читалось

- Документы: `docs/reconstruction/phase2/design/history-agent-ui.md`, `design/implementation-handoff.md`, `agent-workflow-spec.md`, `AGENTS.md`.
- Ядро: `src/journal/journal.js`, `src/agent/loop.js` (`run`, `stop`, `_runCall`, `_askApproval`, `_execute`, `_endTurn`, эмиссия событий, запись журнала ~строка 724), `src/policy/approvals.js`, `src/policy/modes.js` (`decide`), `src/commands/runner.js`, `src/screen/agent.js`, `src/tasks/runtime.js` (вызовы брокера).
- Главный процесс: `main.js` (`agent:stop`, `stopCurrentTurn`, `approval:respond`, `journal:recent`, `journal:search`, `readRecentJournal`, `emitToWindow`, брокер подтверждений ~657, аварийный стоп ~771–782, голосовой ответ ~3382, запись `resume` ~141).
- Окно: `preload.js`, `renderer/app.js` (журнал ~1417–1505, подтверждения ~1507–1736, `onEvent`, `chatTool`, `endTurn`, `stopTurn`, `chatError`), `renderer/shared.js` (`statusOfRecord`, `okStatus`, `REFUSED_SUMMARY`, `argsPretty`, `call`), `renderer/nox-screen.js` (`initEvents`), `renderer/index.html` (фильтры журнала, карточка подтверждения).
- Тесты: только список имён в `apps/jarvis-desktop/tests/`.
- Не читались: `.env` и настоящая папка `data/` (правило AGENTS).

---

## 2. Что уже есть

| Область | Где | Что делает | Состояние |
|---|---|---|---|
| Запись журнала | `src/journal/journal.js` `Journal.append` | Маскирует секреты (`maskSecrets`, поля-текст `ui_type`, `clipboard_set`, `browser_type` → «[скрыто, N симв.]»), пишет `journal.jsonl`, ротация при 10 МБ | Работает |
| Итог шага | `src/agent/loop.js` ~700–735 | Пишет `status` (`failed`/`unverified`/…), `verified`, `verifiedStatus`, `decision`, `callId`, `runId`, `step`, `evidence` | Работает; эти поля окно не читает |
| Поиск журнала | `journal.js` `searchJournal`, `readJournal` | Фильтры: текст, статус, инструмент, пространство, задача, даты, лимит ≤200, смещение; статус считает `historyStatus` | Работает; читает всю цепочку ротации синхронно |
| IPC журнала | `main.js` `journal:recent`, `journal:search` | `recent` — последние N строк живого файла, сырые записи; `search` — через `searchJournal`, только из главного окна | Работает; два пути дают разные данные |
| Мост | `preload.js` `recentJournal`, `journalSearch`, `respondApproval`, `stop`, `onEvent` | Вызовы окно → ядро | `journalSearch` в окне не используется |
| Экран журнала | `renderer/app.js` ~1417–1505, `index.html` (`#statusFilter`, `#histSearch`, `#histReload`, `#histCount`, `#histEmpty…`) | Таблица: время, действие, риск, статус, итог; фильтр по статусу; поиск по загруженному | Работает частично (см. раздел 6) |
| Статус для окна | `renderer/shared.js` `statusOfRecord`, `statusOfResult` | Свой расчёт статуса из `decision`/`verified`/`ok`/`summary` | Расходится с бэкендом (раздел 5) |
| Событие хода | `loop.js` `_emit`, `_emitRaw` | `status`, `tool_start`, `tool_result`, `approval_request`, `done`, `error`, `text` | Работает; после остановки часть событий глушится |
| Строка действий в чате | `app.js` `chatTool`, `ensureActs`, `renderActs`, `endTurn` | Строки шагов, сводка «N действий · выполнено», прогресс | Работает; строки «выполняется» после стопа не закрываются |
| Живой статус Nox | `renderer/nox-screen.js` `initEvents` | `text`/`tool_start`/`tool_result`/`approval_request` → «работает»; `done` → «Готово» или «Остановлено» | Работает; подробного списка шагов в экране Nox нет |
| Подтверждения | `src/policy/approvals.js` `ApprovalBroker` | `request`, `respond`, `cancel`, `cancelAll`, `cancelPrefix`, `closedReason`, `remaining`; автоотмена 30 с | Работает; состояние только в памяти |
| Правила решения | `src/policy/modes.js` `decide` | `deny` (оплата всегда; опасные действия), `ask`, `allow`; секрет в исходящем — `ask` в любом режиме | Работает (детали не разбирались полностью) |
| Карточка подтверждения | `app.js` ~1507–1736, `index.html` `#approvalDialog` | Вопрос, таймер, «Отклонить / На сессию / Разрешить», `Esc` = отказ, `#apArgs` (JSON аргументов), `#apPreview` (diff) | Работает; аргументы без маскировки |
| Отмена хода | `main.js` `agent:stop` → `stopCurrentTurn` | Останавливает `commandAbort`, `screenAgent`, `agent`, чат пространства, речь | Работает; отвечает `{ok:true}` сразу |
| Аварийный стоп | `main.js` ~771–782, `src/control/stop.js` | `approvals.cancelAll`, пауза задач, запись `decision:'stop'` в журнал | Работает; запись выглядит как успех |
| Повтор после ошибки | `app.js` `chatError` (~2133–2160) | Кнопка «Повторить» повторяет последнюю фразу (`C.lastSent`) | Есть; повторяет всё целиком |
| Тесты | `tests/approvals.test.js`, `p0-approval-args.test.js`, `p0-stop.test.js`, `journal*.test.js` (mask, rotation, search, v2, failure), `verify-status.test.js`, `effects.test.js`, `loop*.test.js` | Бэкенд | Есть для ядра; для окна журнала и подтверждений тестов нет (в `renderer/` только `themes.test.js`) |

---

## 3. Контракты

### 3.1. Событие `agent:event` (из `loop.js`)

| Тип | Поля (ключевые) | Кто шлёт |
|---|---|---|
| `status` | `state` (`thinking`, `planning`, `acting`, `searching`, `verifying`, `speaking`, `waiting_approval`, `error`, `stopped`, `success`, `cancelled`, idle), `runId` | `loop.js` |
| `tool_start` | `id`, `name`, `args` (**сырые**), `risk`, `step`, `runId`, `status:'running'`, `label`, `target`, `startedAt` | `loop.js` |
| `tool_result` | `id`, `ok`, `summary`, `verified`, `evidence`, `decision`, `step`, `status`, `label`, `target` | `loop.js` (после стопа не уходит, см. 4) |
| `approval_request` | `id` (= `call.id`), `name`, `args` (**сырые**), `risk`, `reason`, `preview`, `allowSession`, `autoCancelAt`, `step`, `target` | `loop.js` через брокер |
| `approval_closed` | `id`, `decision:'reject'`, `cancelled:true`, `reason` | `main.js` (`onAutoCancel`) |
| `done` | `runId`, `outcome`, `status`, `cancelled`, `startedAt`, `verification` (`confirmed`, `unverified`, `failed`, `reads`, `total`), `steps`, `history` | `loop.js` `_endTurn` (идёт мимо `_emit`) |
| `error` | `message`, `status` | `loop.js` |
| `text` | дельта текста | `loop.js` |

### 3.2. Каналы

| Канал | Preload | Главный процесс | Ответ | Замечание |
|---|---|---|---|---|
| `agent:stop` | `stop()` | `stopCurrentTurn()`; `{ok:true}` сразу | `{ok:true}` | Не ждёт остановки; `{ok:false}` только для чужого окна |
| `approval:respond` | `respondApproval(id, decision)` | `approvals.respond`; при провале `{ok:false, reason}` (причина из `closedReason`) | `{ok, reason?}` | При исключении `{ok:false}` без причины |
| `journal:recent` | `recentJournal(limit)` | `readRecentJournal`: читает весь живой `journal.jsonl`, берёт последние N строк (1–200) | массив сырых записей | Не учитывает ротацию, пространство, статусы |
| `journal:search` | `journalSearch(filters)` | `searchJournal` (цепочка ротации) | `{ok, items (со статусом), …}` | Из `filters` не передаётся `source` |

### 3.3. Запись журнала (поля, которые пишет `loop.js`)

`tool`, `args` (маскируются при записи), `risk`, `mode`, `decision` (`once`, `session`, `reject`, `deny`, `stop`, …), `ok`, `summary`, `callId`, `runId`, `step`, `status` (`confirmed`, `unverified`, `failed`), `verified` (`confirmed`, `unknown`, `failed`, `null`), `verifiedStatus`, `evidence`. Добавляются `source` (`task`, `mission`, `long`, `command`, `telegram`), `workspaceId`, `taskId`, `mission`, `long`, `command`, где они есть.

---

## 4. Жизненный цикл вызова инструмента (как работает сейчас)

1. Модель просит инструмент. `loop.js` `_runCall`: решение `decide` (`deny` / `ask` / `allow`), стоп-проверка, при `ask` — `_askApproval`.
2. `_askApproval`: `approval_request` уходит в окно с сырыми аргументами; ход ждёт `approvals.request(id = call.id)`. Отмена хода (`stop`) вызывает `approvals.respond(id, 'reject')`.
3. Инструмент: `_execute` → `await tool.run(args, ctx)`. Сигнал `signal` передаётся, но цикл **не прерывает** уже запущенный инструмент: ждёт его завершения.
4. `checkEffect` (`src/agent/effects.js`) проверяет результат → `verified`.
5. Журнал: `journal.append` с `status`, `verified`, `decision`.
6. `tool_result` → окно (если ход ещё открыт).
7. Итог хода: `_endTurn` → `done`.

**Гонка при остановке (ключевой риск):**
- `stop()` ставит флаг, прерывает контроллер и **сразу** вызывает `_endTurn()`. `done` с `cancelled:true` уходит в окно, пока инструмент может ещё работать.
- После `_runClosed` `_emit` глушит всё, кроме `done`/`idle`. Поэтому `tool_result` выполнявшегося шага в окно не приходит.
- Когда инструмент завершается, цикл пишет шаг в журнал с `resolution:'stop'` и `summary` вида «остановлено: …». Результат действия (даже успешного) в журнале выглядит как отказ/ошибка.
- В окне строка выполнявшегося действия остаётся в состоянии «выполняется»: `endTurn` перерисовывает строки, но не закрывает их.
- Инструменты, которые не читают `signal` (по grep: 19 из 39 файлов в `src/tools/`, включая `workspace.js`, `observe.js`, `mail.js`, `missions.js`, `reminders.js`), стоп не прерывает вообще.

---

## 5. Статусы: три места, которые расходятся

Статус считается в трёх местах: `journal.js` `historyStatus` (бэкенд, используется в `journal:search`), `shared.js` `statusOfRecord` (окно, используется в журнале из `journal:recent`) и `loop.js` `callStatus` (поле `status` в записи, окно его не читает).

| Случай | `loop.js` `status` | `historyStatus` (поиск) | `statusOfRecord` (окно) | Что видит владелец | Должно быть |
|---|---|---|---|---|---|
| Рискованный инструмент (не T0) без проверки, `ok:true` | `unverified` | `done` («Выполнено») | `done` | «Выполнено» без подтверждения | «Не проверено» |
| Запись без поля `ok` | — | `unverified` | `done` | поиск и «последние» показывают разное | одинаково |
| Шаг остановлен пользователем (`resolution:'stop'`, `ok:false`, `summary` с хвостом) | `failed` | `error` (regex требует точного совпадения) | `error` | «Ошибки», не «Остановлено» | отдельный статус «Остановлено» |
| Аварийный стоп (`decision:'stop'`, `ok:true`) | — | `done` | `done` | «Выполнено» | «Остановлено» |
| Возобновление после стопа (`decision:'resume'`, `ok:true`) | — | `done` | `done` | «Выполнено» | отдельный тип или скрыть |
| Отказ (`reject`/`deny`) | `failed`/`unverified` | `refused` | `refused` | «Отклонённые» | совпадает ✓ |
| Проверка не подтвердила (`verified:'failed'`) | `failed` | `failed` | `failed` | «Провалено» | совпадает ✓ |
| Проверка неизвестна (`unknown`) | `unverified` | `unverified` | `unverified` | «Не проверено» | совпадает ✓ |

Вывод: `status` из цикла уже правильный. Окно и поиск должны брать его, а не пересчитывать.

---

## 6. Сверка со спецификацией Phase 2 (`history-agent-ui.md`, `implementation-handoff.md`)

| Требование | Статус | Комментарий |
|---|---|---|
| Колонки: время, действие, риск, статус, итог | Есть | `renderJournal` |
| Фильтры: Все, Подтверждено, Не проверено, Провалено, Ошибки, Отклонённые | Есть (6 значений) | Нет фильтра «Выполнено» (`done`); записи `done` видны только в «Все» |
| Статус «ожидает решения» (`pending`) | Нет | В `historyStatus` нет; ожидание видно только в карточке |
| Статус «отменено/остановлено» отдельно | Нет | Смешано с «Ошибки» |
| Поиск | Частично | Локальный по загруженным (≤200), не через `journal:search`; не охватывает всю историю |
| Подробности записи (отдельное окно) | Нет | В `index.html` нет разметки, в `app.js` нет обработчика |
| Счётчик «Показано N из M» | Частично | M = загружено (≤200), не общее число записей |
| Пагинация / «Показать ещё» | Нет | Лимит 200, смещение в IPC есть, в окне не используется |
| Фильтр по пространству, дате, инструменту | Нет в окне | Есть в `searchJournal` |
| Пустое состояние | Есть | «Журнал пуст…» и «Ничего не нашлось…» |
| Ошибка загрузки | Частично | `loadError` показывается только если список пуст; старые строки остаются без предупреждения |
| Журнал в экране Nox | Нет | В `nox-screen.js` нет упоминаний журнала |
| Таймер подтверждения 30 с | Есть | `autoCancelAt`, обратный отсчёт в окне |
| Разрешить / на сессию / отклонить | Есть | «На сессию» только при `allowSession`; для одноразовых инструментов сессия понижается до «once» (`loop.js`) |
| Живой ход: текущий шаг | Есть | Строки действий в чате; в экране Nox — только общий статус |
| Отмена отдельного фонового задания из окна | Не найдено | Есть только общий стоп |
| Повтор отдельного шага | Нет | Есть «Повторить» для всей фразы |
| Честное состояние стопа | Частично | `done` приходит сразу; «Останавливаю» — по `{ok:true}` |

---

## 7. Итог

**Уже реализовано:** журнал с маскировкой и ротацией; поиск с фильтрами на бэкенде; цикл хода с событиями; строка действий и живой статус; карточка подтверждения с таймером, «Разрешить / На сессию / Отклонить» и Esc; отмена хода; аварийный стоп с отменой подтверждений; сверка результата через `verify`; пустые состояния журнала; повтор после ошибки.

**Не реализовано или неполно:** фильтр «Выполнено»; статус «Остановлено» и «Ожидает решения»; окно подробностей записи; поиск и пагинация через бэкенд; фильтры по дате, пространству, инструменту; журнал в экране Nox; честное закрытие строк и статуса при стопе; единый источник статуса; маскировка аргументов в подтверждении и строках хода; защита от повтора уже выполненных действий; таймаут для кнопок подтверждения; тесты окна.

---

## 8. Открытые вопросы владельцу

1. **Текст ввода в подтверждении.** Сейчас `ui_type`, `clipboard_set`, `browser_type` показываются открыто в `#apArgs`. Предлагаю: маскировать длину и показывать текст только по кнопке «Показать» на время решения, без сохранения в окне. Решение владельца нужно до этапа 4.
2. **Один источник статуса.** Предлагаю: окно и поиск берут `status` из записи; `historyStatus` и `statusOfRecord` заменяются одной функцией в общем модуле.
3. **Повтор после ошибки.** Сейчас «Повторить» повторяет фразу целиком, даже если часть действий уже выполнена. Предлагаю: не повторять автоматически, показать «Проверьте, что уже сделано» со ссылкой на журнал.
4. **Остановка как отдельный статус.** Предлагаю: «Остановлено» — отдельный статус, не «Отклонено» и не «Ошибка».
5. **Подтверждения фоновых задач при стопе.** Сейчас `agent:stop` не отменяет подтверждения задач сразу; они ждут до 30 с. Нужно решить: отменять сразу или оставлять.

---

## 9. Что не проверено

- Визуально не проверено (приложение не запускалось): раскладка журнала, карточка подтверждения, строка хода, экран Nox.
- Не проверено подробно: `src/agent/effects.js` (`checkEffect`), удалённые подтверждения через Telegram (`src/telegram/policy.js`), поведение фоновых миссий при `agent:stop` (`src/missions/long.js`, `src/tasks/runtime.js`), точный список инструментов без `signal` (grep по слову, не по коду).
- Тесты `node --test` не запускались: базовая линия неизвестна. Перед этапом 1 её нужно снять (см. `implementation-plan.md`, этап 0).
- Не проверено, сохраняются ли аргументы инструментов в файле разговора без маскировки (`saveConversation`).
- Не проверено, использует ли `renderer/nox-screen.js` журнал или подтверждения отдельно от `app.js` (найдено только `initEvents`).
