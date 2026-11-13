# AETHER / PROGRESS JOURNALS, CHECKPOINTS AND SUCCESSOR HANDOFF

**Владелец отдельно потребовал:** агенты должны **сохранять собственный прогресс и свои действия**, чтобы если лимит модели/контекста закончится, другой агент мог продолжить без повторной реконструкции работы. Передача другому агенту — запасной вариант, не основной процесс.

## 1. Где хранить

Создать в рабочем проекте отдельную папку (после проверки отсутствия конфликта):

`docs/design/nox-aether/`

Там должны быть:

- `TASKS.md` — единая доска задач; **редактирует только Opus**.
- `OPUS_PROGRESS.md` — фактически выполненные действия Opus и решение о гейтах.
- `FABLE_PROGRESS.md` — действия Fable; только Fable редактирует свой файл.
- `HAIKU_QA.md` — проверенные результаты Haiku; только Haiku редактирует свой файл.
- `OPUS_DECISIONS.md` — архитектурные/визуальные решения с причинами.
- `FILE_OWNERSHIP.md` — границы файлов и явные пересечения.
- `HANDOFF.md` — **главная точка восстановления при смене модели**, поддерживает Opus; при отсутствующем Opus последний действующий исполнитель может создать `HANDOFF_PENDING.md`, не перезаписывая чужие решения.
- `VISUAL_BASELINE.md` — фото оригиналов, точное сопоставление 2 сфер с кодом/вариантами, размеры исходного интерфейса.
- `QA_MATRIX.md` — последняя проверка acceptance tests со ссылками на снимки и commands.

Файлы Markdown — обычный текст, не секреты. Никогда не добавлять в них tokens, cookies, приватные чаты, данные из `.env`, ключи провайдеров или содержимое личных файлов.

## 2. Как часто фиксировать

Постоянно, но без гигантского лога:

1. **Перед началом:** дата, текущий ticket, git status (кратко), свободные и занятые файлы, baseline тестов.
2. **После каждого существенного блока** (компонент, экран, успешный тест, неудачный опыт): append 5–12 строк в **свой** progress-файл.
3. **При изменении принятого решения:** запись в `OPUS_DECISIONS.md`.
4. **При обнаружении блокера:** актуализировать `TASKS.md` и `HANDOFF.md`, блокер не маскировать.
5. **Перед завершением, ручной остановкой или заметным сокращением доступного контекста:** сначала запись checkpoint, затем продолжение/закрытие.

Агенты не могут гарантировать точное предсказание лимита API; поэтому нельзя откладывать журнал на самый конец. **Checkpoint должен быть полезен даже если модель внезапно остановилась.**

## 3. Минимальный формат записи в личный журнал

```md
### 2026-11-13 — Agent: Fable — Ticket D1 — checkpoint 04
State: IN_PROGRESS
Goal: Concept B, condensed 864x520 layout
Files changed:
- docs/design/nox-aether/prototypes/b/index.html (new)
- docs/design/nox-aether/prototypes/b/styles.css (modified)
Actions performed:
- Implemented right-side sphere layout (mock only)
- Added long-dialogue overflow treatment
Tests/visual checks:
- 1200x720: PASS (screenshot: screenshots/b-1200.png)
- 864x520: FAIL (composer clipped by 12px)
Known blockers: composer overflow
Next exact action: fix max-width/height on b input, rerender 864x520, send to Haiku
Do not touch: renderer/app.js; src/link; existing orb modules
```

Все поля должны отражать **реальные действия**. Если не было проверки, так и написать `NOT RUN`.

## 4. Формат доски TASKS.md

```md
| ID | Owner | State | Files owned | Deliverable | QA / Blocker |
|----|-------|-------|-------------|-------------|--------------|
| D0 | Opus | DONE | read-only | baseline.md | verified |
| D1 | Fable | IN_PROGRESS | prototypes/* | 3 concepts | pending |
| Q1 | Haiku | BLOCKED | read-only | qa.md | waits D1 |
```

Разрешённые states: `TODO`, `IN_PROGRESS`, `BLOCKED`, `REVIEW`, `DONE`, `CANCELLED`. `DONE` требует ссылку на результат и проверку. Не ставить DONE потому что «код написан».

## 5. HANDOFF.md — точный протокол передачи

На каждом gate и перед сменой модели поддерживать **одну короткую актуальную версию**:

```md
# NOX AETHER — HANDOFF CHECKPOINT
Updated: YYYY-MM-DD hh:mm TZ
Current gate: 0 / 1 / 2 / 3
Approved visual concept by owner: NONE / A / B / C
Worktree: D:\nox-release
Git status: [summary only; DO NOT RESET]

## What is verified DONE
- [ID] [fact] [artifact path] [proof/test/screenshot]

## What is currently IN PROGRESS
- [ID] [owner] [exact current component/path]

## What remains / ranked next steps
1. ... exact command or file + acceptance
2. ...

## Files that MUST NOT be touched
- ... owned by other agents
- ... two original sphere sources

## Decisions already made
- design choice ...
- UI migration policy ...

## Open risks and test failures
- tests: actual commands + exit statuses
- screenshots: actual paths
- blockers: owner action needed

## Most recent changes
- path: summary why changed

## Successor first 5 actions
1. Read README, MASTER, HANDOFF, TASKS, agent log.
2. Run `git status` and inspect relevant diff.
3. Verify current branch/worktree and the existing two orb baselines.
4. Reproduce the outstanding blocker/test.
5. Continue assigned ticket only; do not redo completed work.
```

## 6. При окончании лимита модели

Если возможно, текущий агент обязан:
- Закончить на безопасной границе без полубитого импортируемого модуля.
- Записать `HANDOFF.md`/`HANDOFF_PENDING.md` **своими словами и проверенными фактами**.
- Указать точные изменённые файлы, diff, незапущенные команды и риски.
- Указать короткий **READY-TO-PASTE** prompt для преемника.
- Обозначить, какие задачи нельзя повторять и какие файлы нельзя трогать.

**Нельзя:** совершать commit/push только «чтобы сохранить»; `git reset --hard`; удалять неизвестные изменения; выдавать неуспевший тест за зелёный; говорить, что работа продолжится асинхронно сама собой.

## 7. Промпт для преемника (готовый шаблон)

```text
Продолжи NOX AETHER в D:\nox-release после завершения лимита другого агента.
Ничего не начинай с нуля. Сначала прочитай:
- docs/design/nox-aether/HANDOFF.md
- docs/design/nox-aether/TASKS.md
- журнал предыдущего агента (FABLE_PROGRESS.md / OPUS_PROGRESS.md / HAIKU_QA.md)
- docs/design/nox-aether/OPUS_DECISIONS.md
- AGENTS.md
Сначала проверь git status/diff. Сохрани все чужие незакоммиченные изменения.
Выполняй только ticket, указанный в HANDOFF, с его acceptance. Не меняй две исходные сферы, C5/C6/C7 и политику безопасности.
Продолжай записывать собственный прогресс и обнови HANDOFF после каждого значимого этапа.
Никаких commits/push, новых пакетов без согласия, реальных .env/data.
```

## 8. Вспомогательные артефакты, которые экономят контекст

- Снимки экранов называются `conceptA_state1_1200x720.png`, а не случайно.
- В тестах сохранять команду, код завершения, короткую ошибку и путь к полному логу во временной папке; **не копировать гигантские логи в контекст**.
- В `VISUAL_BASELINE.md` ссылаться на точный модуль и снимок каждой исходной сферы.
- Если есть расхождение между старым отчётом и реальным кодом, приоритет у текущего кода. Обозначить несоответствие явно.
