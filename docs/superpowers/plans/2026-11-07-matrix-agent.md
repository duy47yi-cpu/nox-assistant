# Матрица этапа 1 — цикл агента, разрешения, стоп, проверка результата, журнал

**Зона:** agent-core (task-1). **Дата:** 2026-11-07. **Рабочая папка:** `D:/nox-release`.
**Что читал:** `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, `docs/superpowers/plans/2026-11-07-video-analysis.md`, `2026-11-07-nox-reference-implementation.md` (этапы 0–1), `2026-11-07-deep-implementation-spec.md` (этапы A, B, D-история).
**Границы:** правил только `apps/jarvis-desktop/src/agent/loop.js`, `apps/jarvis-desktop/tests/loop.test.js` (одна проверка события) и новый `apps/jarvis-desktop/tests/progress-contract.test.js`. `src/policy/`, `src/control/`, `src/journal/journal.js`, `main.js`, `preload.js`, `renderer/` не переписывал: по ним инвентаризация и контракт.

## Как проверял

1. Прочитал код зоны целиком: `src/agent/loop.js`, `effects.js`, `turnlog.js`; `src/policy/modes.js`, `approvals.js`, `taint.js`; `src/control/stop.js`, `esc-stop.js`; `src/journal/journal.js`; цепочку событий `emit` → `emitToWindow`/`sendToWindow` (`main.js:1032-1062`, `agent:event`) → `renderer/app.js` (`onEvent`, `StatusTracker`).
2. Прогнал целевые тесты **до правок**: `tests/loop.test.js tests/policy.test.js tests/approvals.test.js tests/effects.test.js tests/journal-failure.test.js tests/journal-mask.test.js tests/journal-v2.test.js tests/journal.test.js tests/p0-approval-args.test.js tests/p0-approval-rules.test.js tests/p0-boundaries.test.js tests/p0-stop.test.js tests/verify-status.test.js tests/verify-wave2.test.js` — **103 pass / 0 fail**.
3. Полный `node --test` до правок — **1506 pass / 0 fail** (базовая линия).
4. После правок: тот же целевой список + новый `tests/progress-contract.test.js` — **114 pass / 0 fail**; полный прогон — см. раздел «Тесты».
5. Живое окно (Electron) в этой задаче не проверял — это зона интегратора; интерфейсные выводы помечены «не проверено в окне».

## Матрица (зона этапа 1)

| # | Строка матрицы | Статус | Файл | Чем доказано / проверка |
|---|---|---|---|---|
| 1 | Цикл «модель → инструмент → модель», история `tool_call`/`tool` | работает | `src/agent/loop.js` (`run`, `_loop`, `_pushToolResult`) | `tests/loop.test.js` (события, журнал, история), прогон 114 pass |
| 2 | Лимит шагов, защита от зацикливания (`MAX_TOOL_STEPS=12`, `MAX_REPEATS=2`, живые чтения после перезапуска) | работает | `loop.js` | `tests/loop.test.js` («лимит шагов»), `tests/speed.test.js` |
| 3 | Потолок времени хода `turnDeadlineMs` (честный текст, а не молчание) | работает | `loop.js` (`_loop`) | `tests/turn-deadline.test.js` |
| 4 | Параллельные T0-чтения одним ответом модели, порядок ответов | работает | `loop.js` (ветка `_canRunWithoutAsk`) | `tests/parallel.test.js` |
| 5 | Ошибка мозга/инструмента, неизвестный инструмент не роняют цикл | работает | `loop.js` (`_runCall`, `_execute`, catch в `run`) | `tests/loop.test.js` («ошибка инструмента»), 114 pass |
| 6 | Стоп/аборт прерывает и модель, и инструмент; `done` один раз | работает (после правки) | `loop.js` (`stop`, `_runClosed`) | `tests/p0-stop.test.js`; `tests/progress-contract.test.js` («stop во время шага», «поздний stop») |
| 7 | Поздний ответ (модели/инструмента) не воскрешает отменённый ход | было **не работает**, исправлено | `loop.js` (`_emit` глушит события после итога; `_runCall` не превращает поздний ответ в успех) | `tests/progress-contract.test.js` (2 теста: поздний tool_result и поздний text) |
| 8 | Ремонт истории после оборванного вызова (`repairToolHistory`) | работает | `loop.js` | `tests/journal-failure.test.js` |
| 9 | Режимы `full` / `ask` / `auto`, неизвестный риск → `ask`, неизвестный режим → `ask` | работает | `src/policy/modes.js` (`decide`) | `tests/policy.test.js`, `tests/p0-boundaries.test.js` |
| 10 | Оплата запрещена всегда (`isPayment`: имя инструмента, PowerShell, кнопка окна, сайт) | работает, не ослаблял | `modes.js` | `tests/policy.test.js`, `tests/p0-approval-rules.test.js`, `tests/security-holes.test.js` |
| 11 | Удаление/установка/выключение/команда удаления: в «Полном доступе» только по прямой просьбе владельца, иначе вопрос | работает, не ослаблял | `modes.js` (`ownerAsked`, `ownerNamedTarget`, `ownerNamedShellDelete`, `isInstall`) | `tests/policy.test.js`, `tests/p0-approval-rules.test.js`, прогон install-тестов в полном наборе |
| 12 | Внешние источники (MCP/почта) и секрет в исходящем — вопрос | работает | `modes.js` (`EXTERNAL_SOURCES`, `hasSecretEgress`), `src/policy/taint.js` | `tests/taint.test.js` |
| 13 | Заражение контекста: после чужого текста исходящие и руки спрашиваются | работает | `taint.js`, `loop.js` (`_tainted`/`_foreign`) | `tests/taint.test.js` |
| 14 | Подтверждение привязано к вызову, «на сессию» — к имени+аргументам | работает | `src/policy/approvals.js`, `modes.js` (`allowKey`) | `tests/approvals.test.js`, `tests/p0-approval-args.test.js` |
| 15 | Отказ в подтверждении не выполняет действие | работает | `approvals.respond('reject')` → `loop.js` (`_denyText`) | `tests/loop.test.js` («отказ по approval»), `tests/progress-contract.test.js` |
| 16 | Тайм-аут: по умолчанию его нет, явный тайм-аут = отказ | работает | `approvals.js` (`DEFAULT_TIMEOUT_MS=null`) | `tests/p0-stop.test.js`, `tests/progress-contract.test.js` |
| 17 | Отмена запроса/`cancelAll`/поздний ответ на отменённый запрос | работает | `approvals.js` (`cancel`, `cancelPrefix`, `cancelAll`, `closedReason`) | `tests/approvals.test.js`, `tests/p0-approval-rules.test.js` |
| 18 | Закрытие диалога = отказ (Esc / `cancel`), не выполнение | работает по коду, **не проверено в живом окне** | `renderer/app.js:1569-1570` (`cancel` → `answerApproval('reject')`), `approval:respond` в `main.js:2473` | код + тесты отказа; живой путь — зона интегратора |
| 19 | Аварийный стоп: глобальный выключатель, отзыв «на сессию», стоп ожидания подтверждения | работает | `src/control/stop.js`, `loop.js` (`stopSwitch.onTrigger`, `sessionAllow.clear`) | `tests/p0-stop.test.js`, `tests/p0-approval-rules.test.js` |
| 20 | Стоп не запускает следующие шаги команды/миссии, прерванное не повторяется само | работает | `src/commands/runner.js`, `src/missions/scheduler.js` (внешние модули, проверены тестами) | `tests/p0-stop.test.js` (2 теста) |
| 21 | Esc останавливает ход, пока руки работают; фон Esc не занимает; свой Esc из `ui_keys` не стоп | работает | `src/control/esc-stop.js` | `tests/computer-use.test.js`; живой Esc — не проверял |
| 22 | Повторный стоп/стоп в простое не шлёт лишний `done` | было **не работает**, исправлено | `loop.js` (`stop` + `_runClosed`) | `tests/progress-contract.test.js` («поздний stop после конца хода») |
| 23 | Проверка результата: `confirmed` / `failed` / `unknown`, исключение в `verify` → `unknown` | работает | `src/agent/effects.js` (`checkEffect`) | `tests/effects.test.js` |
| 24 | `verify` конкретных инструментов (окно, процесс, файл, буфер, клавиши, хранилища) | работает | `src/tools/*.js` (`verify`) | `tests/verify-wave2.test.js`, `tests/journal-v2.test.js`, `tests/effects.test.js` |
| 25 | Непроверенный результат не выглядит успехом в окне | работает в UI-функции, **частично в ядре до правки** | `renderer/shared.js` (`statusOfResult`), `effects.js`, `loop.js` | `tests/verify-status.test.js`; после правки ядро отдаёт `done.status='unverified'` и `verifiedStatus` — `tests/progress-contract.test.js`; в окне пока не отрисовывается (патч интегратора) |
| 26 | Журнал: JSONL, `ts` ставит журнал, сбой записи не роняет ход и не оставляет `tool_call` без ответа | работает | `src/journal/journal.js`, `loop.js` (try/catch вокруг `append`) | `tests/journal.test.js`, `tests/journal-failure.test.js` |
| 27 | Маскировка набранного текста (`ui_type`, `clipboard_set`, `browser_type`), рекурсивно `command_create.steps` | работает | `journal.js` (`maskArgs`) | `tests/journal-mask.test.js` |
| 28 | `callId` + `verified` + `evidence` в записи журнала | работает | `journal.js`, `loop.js` (`append`) | `tests/journal-v2.test.js` |
| 29 | История связывает ход ↔ вызов ↔ проверку | было **частично** (только `callId` к `turns.jsonl`), дополнено | `loop.js` (в `append` передаются `runId`, `step`, `status`, `verifiedStatus`) | `tests/progress-contract.test.js` (сверка `journal.runId === turns.turn === done.runId`) |
| 30 | Секреты в истории | частично: набранный текст маскируется; прочие аргументы — зона memory-data (task-3) | `journal.js` (`maskSecrets` уже в дереве), `loop.js` передаёт поля | `tests/journal-mask.test.js`, `tests/journal-v2.test.js`; мои события прогресса не содержат секретов — `tests/progress-contract.test.js` |
| 31 | Событие прогресса `agent:event`: доставка в окно | работает (доставка), **контракт полей — новый** | `main.js:1032-1062` (только чтение), `loop.js` | `tests/progress-contract.test.js`; в `renderer/app.js` новые поля пока не читаются |
| 32 | Статусы планирования/выполнения/ожидания/проверки и честный финал запуска | было **не работает** (их не было), добавлено | `loop.js` (`PROGRESS_STATUSES`, `_runStatus`, `_endTurn`) | `tests/progress-contract.test.js` |
| 33 | Сквозной путь в настоящем окне: просьба → шаг → разрешение → проверка → история → стоп | **не проверено** этой задачей | — | требуется интегратором (его зона `renderer/app.js`, `main.js`) |

## Найденные дефекты и что с ними сделано

Все правки — в `src/agent/loop.js`, обратная совместимость сохранена (типы событий и `state` не переименованы; новые поля необязательные).

1. **Поздний результат инструмента после стопа выглядел новым шагом.** `stop()` слал `done`, а `_runCall` после возврата инструмента продолжал слать `tool_result` — окно могло «воскресить» отменённый ход. Теперь после итога запуска `_emit` глушит события, а `_runCall` превращает поздний ответ в `decision:'stop', ok:false` (журнал честно фиксирует остановку). Тест: «stop во время шага…».
2. **`agent.stop()` без идущего хода слал лишний `done` + `idle`.** Теперь `stop()` без активного контроллера молчит; повторный стоп не дублирует итог. Тест: «поздний stop после конца хода…».
3. **После остановки только агента (Esc) при уже полученном «разрешить» действие могло выполниться**, если глобальный `StopSwitch` не включён: проверялось только `_stopped()`. Теперь перед выполнением проверяются ещё `signal.aborted` и `_runClosed`; «на сессию» не сохраняется. Покрыто `tests/p0-approval-rules.test.js` + новый «отказ в подтверждении».
4. **Не было контракта прогресса**: окно не могло отличить проверку, непроверенный результат и отмену; `done` не нёс итога. Добавлены необязательные поля (см. контракт ниже) и нормализованные статусы. Тест: 11 проверок в `tests/progress-contract.test.js`.
5. **История не связывала ход и проверку**: был только `callId` к `turns.jsonl`. В запись журнала добавлены `runId` (= `turn.id`) и `step`; `done.history` даёт безопасные ссылки на вызовы. Тест: сверка `journal.runId`/`turn.turn`/`done.runId`.
6. **`reason` подтверждения мог содержать «undefined»** (пустые `risk`/`explain`). Теперь причина собирается из непустых частей, «undefined» не появляется. Тест: проверка `approval_request.reason`.
7. **`run()` возвращал `ok:true` при непроверенных действиях.** Возврат `run()` не менял (на него завязаны вызовы и тесты: «ok = модель ответила»), но честный итог теперь в `done.status`/`done.verification`; вызывающий код и окно могут не считать `unverified` успехом.
8. **Не исправлено (чужая зона):** `renderer/app.js` не читает новые поля — «Ответ готов» после стопа, `unverified` без галочки, прогресс по шагам требуют патча интегратора (контракт ниже). `journal.js` принадлежит memory-data: маскировка секретов до записи уже в дереве, мои поля (`runId`, `step`, `verifiedStatus`) сохраняются.

## Контракт события прогресса (для интегратора: `main.js` / `renderer/app.js`)

Тип события и `state` остались прежними (`status`, `tool_start`, `tool_result`, `approval_request`, `text`, `error`, `done`). Новые поля необязательные; старый рендерер их игнорирует. Всё, что ниже, покрыто `tests/progress-contract.test.js`.

- Любое событие хода: `runId` — строка, один id на ход, совпадает с `turns.jsonl:turns.turn` и `journal.runId`. По нему окно отбрасывает события чужого/старого запуска.
- `status`: `{type:'status', state, runId, step, status, label, startedAt, target?}`.
  - `state` — как раньше (`thinking`, `acting`, `waiting_approval`, `error`, `idle`).
  - `status` — нормализованный статус из набора: `planning`, `running`, `awaiting_approval`, `verifying`, `succeeded`, `unverified`, `failed`, `cancelled`.
  - `step` — номер вызова инструмента (1-based); `0` у планирования.
  - `label` — короткий безопасный текст (без аргументов, мыслей и секретов), например «проверяю результат».
  - `startedAt` — ISO-время шага/запуска.
  - **Важно:** новые значения `state` (`verifying`/`cancelled`) не отправляю, пока `StatusTracker` (`renderer/shared.js:462-463`) не знает их: неизвестный `state` он превращает в `idle` и гасит шар. В рендерере достаточно `ev.status || ev.state`; после патча могу досылать `state` без второго протокола.
- `tool_start`: + `runId`, `step`, `status:'running'`, `label`, `target`.
- `tool_result`: + `runId`, `step`, `status` (`succeeded|unverified|failed`), `verifiedStatus` (`confirmed|unverified|failed|null`), `decision` (`allow|once|session|reject|deny|stop`), `target`, `startedAt`. Действующее `verified` (`confirmed|unknown|failed`) и `evidence` сохранены для совместимости.
- `approval_request`: + `runId`, `step`, `status:'awaiting_approval'`, `label`, `target`. `reason` человекочитаемая, без «undefined»; `allowSession` как раньше. `args` остаются полными: владелец должен видеть конкретное действие и адресата (это требование этапа 1), секреты маскирует журнал.
- `done`: `{type:'done', runId, outcome, status, cancelled?, startedAt, verification, steps, history}`.
  - `outcome`: `answer|error|timeout|limit|loop|needs_human|stopped`;
  - `status`: `succeeded` только если модель ответила, провалов нет и непроверенных действий нет; `unverified` — есть действие без подтверждения; `failed` — отказ/провал/ошибка/лимит; `cancelled` + `cancelled:true` — стоп/аборт;
  - `verification`: `{confirmed, unverified, failed, reads, total}`;
  - `history`: `[{callId, step, tool, risk, status, verified, decision}]` — безопасные ссылки в журнал (полная запись ищется по `runId`+`step`/`callId`).
- `target` (белый список): только `path`, `url`, `file`, `name`, `window`, `app`, `query`, `id`, `to`, `minutes`; строки обрезаются до 120 символов. `text`, `command`, `content`, `password` в него не попадают. Помощник `safeTarget` экспортируется из `loop.js` для тестов/интеграции.
- `main.js` менять для доставки не нужно: `emitToWindow` уже пересылает события без фильтрации. `preload.js` не меняется (нет нового IPC).

Что предлагаю в `renderer/app.js` (зона интегратора): в `onEvent` запоминать текущий `runId` с первого события нового хода и игнорировать `text`/`tool_*`/`done` с чужим `runId`; на `done.cancelled` не показывать «Ответ готов», а честно «Остановлено»; на `done.status==='unverified'` — нейтральный итог, не зелёная галочка; цепочку шагов строить по `tool_start.step`/`status` (ожидание/проверка/итог), а не только по `tool_result.ok`.

## Тесты

- Целевой список (как в задаче + новый файл): **114 pass / 0 fail**, 4 suite, ~2.2 с. В том числе 11 новых проверок в `tests/progress-contract.test.js`.
- Смежные тесты цикла (стоп, заражение, скорость, параллельность, дела, поток): 137 pass / 0 fail.
- Полный `node --test` в `apps/jarvis-desktop` после моих правок (финальный прогон): **1589 tests, 1587 pass, 2 fail**. Падения не в моей зоне — незавершённые правки других исполнителей/среда:
  - `tests/second-hands.test.js:548` «поиск находит русские падежи» — зона memory-data (меняют `stem`/поиск памяти, WIP);
  - `tests/code-test.test.js:90` «таймаут и стоп снимают процесс вместе с потомками» — зона code-инструментов/среда (живой процесс), к `src/agent/` не относится.
  Промежуточный прогон по ходу работы давал 5 падений (в т.ч. `tests/commands.test.js` ×3 и `tests/humanize.test.js` — зона commands, WIP); к финальному прогону они исчезли. Флейк `GetLastInputInfo` (живой PowerShell) отдельно проходит 28/28.
- `tests/project-map.test.js` проходит: новых файлов в `src/` нет, карту `AGENTS.md` не трогал.

## Изменённые файлы

- `apps/jarvis-desktop/src/agent/loop.js` — контракт прогресса, защита от поздних событий/двойного `done`, нормализованные статусы, `verifiedStatus`, связь журнала с ходом (`runId`, `step`), безопасный `reason`/`target`.
- `apps/jarvis-desktop/tests/loop.test.js` — одна проверка `tool_result` расширена с точного объекта на явные поля (старые поля не удалены, добавлена проверка `step/status/runId`).
- `apps/jarvis-desktop/tests/progress-contract.test.js` — новый файл, 11 проверок (успех/непроверено/провал/отказ/тайм-аут/стоп/поздние ответы/ошибка/секреты/safeTarget/набор статусов).
- `src/policy/*`, `src/control/*`, `src/journal/journal.js`, `main.js`, `preload.js`, `renderer/*`, `AGENTS.md` — **не менял**.

## Осталось / открытые риски (честно)

1. **Живое окно не проверял**: «Ответ готов» после стопа, отображение `unverified`, связка шагов и истории в UI — нужен патч `renderer/app.js` от интегратора (контракт выше) и проверка настоящим окном.
2. **`state:'verifying'`/`'cancelled'`** сейчас выражены полем `status`; добавлю в `state`, когда рендерер будет знать новые состояния (иначе шар падает в `idle`).
3. **Секреты в необязательных аргументах** (пароль в теле письма, ключ в команде) маскирует `journal.js` зоны memory-data — согласовано, но с моей стороны не проверялось отдельным тестом.
4. **Неотменяемый внешний вызов**: если инструмент игнорирует `signal`, `run()` ждёт его ответа, хотя окно уже получило `done` (старое поведение; поздний результат теперь не эмитится и записывается как остановка). Честный текст для окна «вызов ещё завершается» — задача интегратора/инструментов.
5. **`run()` по-прежнему возвращает `ok:true`, если модель ответила** (даже при непроверенных действиях) — так задумано для совместимости; честный итог в `done.status`. Если владелец хочет, чтобы и `run()` возвращал «непроверено», это меняет контракт для дел/миссий — отдельное решение.
6. Тест `GetLastInputInfo` в полном прогоне флейкует под нагрузкой (не моя зона).
