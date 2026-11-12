# История и агент — визуальная спецификация

> Рекламные плашки V2 00:09–14 и V3 00:06–20 [В] — постановка шага/разрешения/ошибки, не доказательство полного плана Nox. Экран [П] в каркасе `navigation-layout.md`. Источники: `journal:recent/search` + `src/journal/journal.js` + `renderJournal`, `agent:event` + `src/agent/loop.js` + `renderer/app.js` + `shared.js` + `nox-screen.js`.

---

## 1. Журнал действий (History Log)

### 1.1 Лейаут 1200×720

```
Head h56 pad 20 border-bottom subtle: "История" 24/600 + [↻ Обновить] 36 ghost icon 14
Toolbar y128 h40 gap 12: Search 360×40 r8 🔍 «Поиск по действиям…» 13/text-2 | counter «Показано N из M» 12/text-2
Filters y180 h40 gap 8: [Все] [Подтверждено] [Не проверено] [Провалено] [Ошибки] [Отклонённые]  chips h32 r pill  active accent-soft
Table x80 y232 w1092  bg surface r12 border  overflow hidden  header h40 bg surface-3 border-bottom
  Cols: Time 120 | Action 300 | Risk 90 | Status 150 | Result flex 1 min 120
  Row min 56 pad 12 border-bottom subtle  gap 8  hover surface-hover
  Pagination footer h40 pad 12 border-top subtle "Показано N из M" 12/text-2
```

- Search — по загруженным последним записям (как `reloadJournal/renderJournal`), не по всей истории; `journalSearch` в preload есть, но экран его не вызывает [П].
- Counter «Показано N из M» 12/text-2 справа от поиска [П].
- Filters — локально к загруженным, активное `accent-soft + accent` [П].

### 1.2 Колонки

| Колонка | Ширина | Содержимое | Типографика |
|---------|--------|------------|-------------|
| Time | 120 | `12.11 14:02:11` — локальное время | 12/mono text-2 |
| Action | 300 | `tool name` + `target` | 13/500 text-1 + 12/text-2 mono |
| Risk | 90 | `T0–T3` pill 20×? r pill | neutral/accent/text/err 11/500 |
| Status | 150 | `Подтверждено / Не проверено / Провалено / Ошибка / Отклонено` | pill 20 r pill 11/500 |
| Result | flex | `Краткий итог / evidence` | 13/400 text-2 ellipsis 1 line |

- Header `12/500 text-2 uppercase tracking 0.02em` bg surface-3 [П].
- Row `min 56` расширяется при переносе (`height auto`), не обрезается [П].
- Risk pills: `T0 ghost - neutral`, `T1 accent`, `T2 text`, `T3 err` [В по DESIGN.md].
- Status pills: `confirmed/ok green`, `unverified neutral`, `failed/err red`, `pending warn`, `refused neutral` [П по shared.js historyStatus].

### 1.3 Адаптив

- При 864×520: filters — горизонтальный скролл `overflow-x auto nowrap`; rows → вертикальные карточки [П]:

```
Card  pad 16 r12 bg surface border gap 12
  Row 1: Time 12/mono text-2 + Risk pill + Status pill
  Row 2: Action 14/600 text-1
  Row 3: Result 13/text-2 clamp 2
  [Детали →] 12/accent link
```

### 1.4 Состояния журнала

| Состояние | Визуал |
|-----------|--------|
| Loading | Спиннер 16 accent + «Загрузка журнала…» center pad 32 |
| Empty | Icon `history` 24 ghost + «Журнал пуст» 16/600 + «Действия появятся здесь» 14/text-2 |
| No matches | «Ничего не найдено» 14/text-2 + [Сбросить фильтры] link accent |
| Error | Banner err 36h + причина 12/mono err + [Повторить] 32 |
| Partial stale | Badge `warn 14%` + «Данные могут устареть» 11/text-2 |

---

## 2. Фильтры и поиск

- Chips `h32 r pill pad 12 gap 6 text 13/500 border` — default `surface-3 border text-2`, hover `text-1`, active `accent-soft text accent border accent/24` [П].
- Search `w360 h40 r8 bg surface-3 border icon 16 text-3 pad 12` focus `accent ring` [П].
- Debounce 150ms, count обновляется live [П].
- История чатов — отдельная панель существующего чата; не смешивать с журналом действий [П].

### 2.1 Поиск по всей истории (future)

- Контракт `journal:search` есть; UI для него требует отдельной разработки: не обещать полнотекстовый поиск по всем датам [П].

---

## 3. Просмотр подробностей

### 3.1 Диалог деталей

```
Overlay 0.48  Dialog 560×480 r16 bg surface border shadow-popover  (480 на 864)
┌──────────────────────────────────────────┐ h60 pad 16 border-bottom Title 16/600 "Детали действия" [×] 20
│ Time 12/mono text-2  12.11.2026 14:02:11 │ pad 20 gap 16 scroll
│ Action 14/600 text-1  «app_open Spotify»│
│ Args  card pad 12 r8 bg surface-3 border mono 12/text-1  + [Копировать] 20 icon — очищенные args, секреты замаскированы│
│ Risk pill + Status pill  h20 gap 8      │
│ Result 13/400 text-2                    │
│ Evidence  card 12/mono text-2 bg surface-1 pad 12 r8 border  (если verifiedStatus/evidence есть) │
├──────────────────────────────────────────┤ footer h64 pad 16 border-top flex-end
│ [Закрыть] 36 secondary                   │
└──────────────────────────────────────────┘
```

- Только данные загруженной записи; отсутствие → «Нет данных» 12/text-2, не выдумывать логи/стек [П].
- `recordToEntry` сейчас отбрасывает `decision` — показ решения требует сохранения поля если есть в ответе, иначе «Нет данных» [П].
- Маскирование остаётся на стороне журнала (`src/journal/journal.js`) — UI не маскирует вторично [П].
- Чужое пространство изолировано; не показывать записи другого workspace [П].

---

## 4. Ход выполнения задачи

### 4.1 Строка хода в чате (сохранить)

```
Feed gap 20 pad 16 20
Working row  h20 flex row gap 8 align center  text 12/text-2  border none bg none
  Icon ▸ 10px text-3  +  Label "Ход работы · Выполняется 10.4 с" 12/text-2 tabular-nums  +  [■ Остановить] 28×20 r8 ghost err
  При наличии:  # шаг 2/5  12/500 text-1 +  цель «Найти билеты…» 12/text-2 +  проверка 12/mono text-3
```

- Неопределённая длительность — индикатор без процентов [П].
- Полный план и процент **не показывать** без достоверных данных [П].
- Список шагов выводить только если реально получен из `agent:event` [П].
- Источники: `runId, step, status, label, target, verification, cancelled` из `agent:event` [П].

### 4.2 Остановка

- `window.jarvis.stop → agent:stop` → строка `«Останавливаю…» 12/text-2` + спиннер 12 → `«Остановлено»` по фактическому состоянию `historyStatus` [П].
- Поздние события после стопа отбрасываются (защита в `renderer/app.js`) [П].

---

## 5. Подтверждение действий

### 5.1 Диалог разрешения

```
Overlay 0.48  Dialog 560 r16 bg surface border shadow
┌──────────────────────────────────────────┐ h? pad 20 gap 16
│ Icon ⚠ 20 warn  + Title 16/600 "Подтверждение действия" │ [×] 20
│ Action name 14/600 text-1  «Отправить письмо»            │
│ Risk pill T2/T3  11/500  +  Cause 13/400 text-2          │
│ Question 14/400 text-1  «Разрешить отправку на …?»      │
│ Disclosure [Показать аргументы ▾] 12/accent  →  card mono 12 r8 bg surface-3 border pad 12 + [Предпросмотр] 28 │
│ Timer bar  h32  bg warn/14 border warn/42 r8 pad 12  12/500 warn tabular-nums «Автоотмена через 24 с» │
├──────────────────────────────────────────┤ footer h64 pad 16 border-top gap 8 flex-end
│ [Отклонить] 36 ghost  [На сессию] 36 ghost (только когда разрешено)  [Разрешить] 40 accent │
└──────────────────────────────────────────┘
```

- Ширина 560 [П по agent-workflow-spec]; `На сессию` только когда разрешено логикой `src/policy/approvals.js` [П].
- Вызов `respondApproval(id, decision)`; во время ответа кнопки disabled + спиннер 12 [П].
- Очередь и автоотмена 30с (`autoCancelMs`) сохраняются; не подменять режимы [П].
- Режимы не смешивать с `mcpApprove` [П].

---

## 6. Ошибки и завершение

### 6.1 Итог хода

```
Result card  pad 16 r12 bg surface border flex col gap 12
  Header: State pill h24 r pill  — ok green / err red / warn amber / ghost neutral  +  Duration 12/mono text-2  «0.4 с»
  Body: Message 14/400 text-1  (фактический ответ агента/задачи, не шаблон)
  Steps: list gap 8 each h32 pad 8 r8 bg surface-3 border
    Step n  13/500 text-1 + status icon 12 (✓ ok / ✗ err / ◐ warn / – ghost) + verification 12/mono text-2 + evidence 12/text-2 ellipsis
  Footer (если executor report есть): Report card pad 12 r8 bg surface-1 border
    "Изменения в файлах" 12/mono + "Тесты" + "Оставшиеся проблемы" 13/text-2 — только если из src/tasks/executor.js [П]
```

- Подтверждение только при `verify/checkEffect`; непроверенный — `unverified neutral` + hint `Не проверено` [П].
- Не считать запись в журнале гарантией проверенного эффекта — использовать `historyStatus/shared.js` [П].
- Единого отчёта для каждого хода не предполагать; поля отчёта — только если поступили [П].

### 6.2 Баннеры ошибок

```
Error inline  h36 pad 12 r8 bg err/14 border err/42 gap 8
  Icon alert 14 err + Message 12/400 err + [Повторить] 32 ghost + [Детали] 28 link
Warn inline  h36 pad 12 r8 bg warn/14 border warn/42  аналогично, только для «ждёт вас»
```

---

## 7. Текстовые схемы

### S1 — Журнал заполнен (таблица)

```
Head: История + Обновить — Toolbar: Search 360 «Поиск…» + Показано 42 из 128 — Filters: Все(актив) Подтверждено Не проверено Провалено Ошибки Отклонённые — Table header Time/Action/Risk/Status/Result 40h — Row1 56h: 12.11 14:02 app_open Spotify T1 Подтверждено Отправлено — Row2: 14:01 ui_keys … T0 Не проверено — …
```

### S2 — Диалог деталей

```
Overlay — Dialog 560×480 — Header Детали действия × — Body: Time 12mon Action 14/600 Args card mono 12 Risk+Status pills Result Evidence card — Footer Закрыть
```

### S3 — Ход + подтверждение

```
Feed: Working row «Ход работы · Шаг 2/5 · пишется письмо…» + [Остановить] — Dialog 560: ⚠ Подтверждение — «Отправить письмо?» Risk T2 — Args disclosure — Timer 24с — Footer Отклонить | На сессию | Разрешить
```

---

## 8. Чек-лист приёмки

- [ ] Header 56, search 360×40, filters chips 32, table cols 120/300/90/150/flex, rows 56, radius 12/16.
- [ ] На 864 фильтры скролл, rows → карточки с теми же подписями.
- [ ] Empty / No matches / Error три разных состояния.
- [ ] Детали — только загруженные поля, «Нет данных» иначе, маскирование на бэке.
- [ ] Ход — без процентов/плана без данных; стоп честно по состоянию, не immediate success.
- [ ] Подтверждение 560, таймер автоотмены, очередь сохраняется.
- [ ] Итог различает verified/unverified/failed/cancelled; historyStatus truthy.
