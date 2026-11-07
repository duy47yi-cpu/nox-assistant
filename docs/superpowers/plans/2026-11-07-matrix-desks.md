# Этап 7: «Рабочие столы и виджеты» — матрица и отчёт

Зона: `apps/jarvis-desktop/src/desks/store.js`, `src/desks/templates.js`, `src/desks/data.js`,
`tests/desks.test.js`. Этот отчёт — `docs/superpowers/plans/2026-11-07-matrix-desks.md`.

**Общие файлы не менялись.** `main.js`, `preload.js`, `renderer/app.js`, `renderer/index.html`,
`AGENTS.md` и чужие `src/`-модули остаются за интегратором; готовый контракт IPC — в разделе
«Контракт для интегратора» ниже. `src/workspaces/` тоже не менялся: столы — это раскладка
виджетов внутри пространства, а не второй контекст.

**Как проверялось.** Целевые тесты: `node --test tests/desks.test.js` — **32 pass, 0 fail**.
Полный прогон `node --test` в `apps/jarvis-desktop` — **1716 pass, 1 fail (1717 тестов)**.
Единственное падение — `tests/project-map.test.js`: карта `AGENTS.md` ещё не знает новые файлы
(мои `src/desks/*.js` и параллельно добавленные `src/extensions/*.js` чужой зоны). Это
ожидаемое состояние до правки карты интегратором; точные строки — в разделе «AGENTS.md».
До начала работы базовая линия была 1646 pass / 0 fail; прирост тестов дали моя зона (32) и
параллельные зоны.

---

## Матрица: было / стало

| Что | До (этап 0, `capability-matrix.md` G1/H1) | После | Доказательство / способ проверки |
|---|---|---|---|
| Столы как отдельная сущность | не вводились; пространства — существующий аналог | **сделано**: столы внутри пространства, `desks.json` | `tests/desks.test.js`: создание/переключение/переименование/удаление/порядок; повторное чтение новым экземпляром |
| Восстановление нескольких столов после перезапуска | не было | **сделано** | тест «создание… восстановление после перезапуска»; повторное открытие папки данных |
| Пространства не перемешивают контекст | пространства разделяли файлы/память/команды | **сохранено**: у каждого `workspaceId` свои столы и активный стол | тест «пространства не перемешивают столы» |
| Шаблоны столов | не было | **сделано**: `empty`, `work`, `study`, `games`, `media`, `avatar` | `TEMPLATES` в `src/desks/templates.js`; тест «шесть шаблонов»; в работе 6 виджетов, в аватаре — `orb` |
| Сетка: добавить/переместить/размер/удалить | не было | **сделано**: 12×12, отказ при выходе за край и наложении, авто-место | тесты «сетка…», «виджет: добавление…», «setWidgets…» |
| Клавиатура/мышь в сетке | нет | **нет**: рендерер не входил в зону; контракт готов | остаток п. 1 |
| Лимиты данных | не было | **сделано**: ≤12 столов, ≤24 виджетов, имя ≤40, безопасные id | тесты «лимиты…», «лимит виджетов…», «небезопасные id…» |
| Битый файл | — | **сделано**: пустое состояние + копия `desks.json.corrupt` | тест «битый JSON…» |
| Версия схемы и миграция | — | **сделано**: `version: 1`; старый/плоский формат мигрирует, будущая версия — отказ | тесты «миграция…», «плоский…», «неизвестная версия…» |
| Атомарная запись | `src/config/atomic.js` был | **использован**, временных файлов не остаётся | тест «сохранение атомарное» |
| Виджеты из настоящих источников | погода/музыка/дела в скрытой сцене главной; `widgetsData` IPC | **сделаны данные**: tasks, today, music, weather, currency, system, apps, orb, commands; `ok/empty/error/stale` | `src/desks/data.js`; тесты по каждому источнику |
| «Финансы / умный дом / питомец» | в референсе есть | **не делаем**: нет настоящих источников | тест «нет выдуманных типов» |
| Экран столов в окне | нет | **нет**: `renderer/`, `main.js`, `preload.js` — зона интегратора | контракт ниже |

---

## Решения, которые важно знать

1. **Стол не равен пространству.** Пространство (`src/workspaces/book.js`) — контекст: папка,
   память, цели, команды. Стол — только раскладка виджетов внутри пространства. В `desks.json`
   нет ни файлов, ни памяти, ни команд; ключ верхнего уровня — `workspaceId`. Поэтому создание
   стола не создаёт папку и не меняет выбранное пространство.
2. **Схема файла** `NOX_DATA_DIR/desks.json`, версия 1:

   ```json
   {
     "version": 1,
     "spaces": {
       "default": {
         "activeId": "<uuid стола>",
         "desks": [{
           "id": "<uuid>", "name": "Работа", "template": "work", "version": 1,
           "widgets": [{ "id": "<uuid>", "type": "tasks", "version": 1,
                         "x": 1, "y": 1, "w": 4, "h": 5, "config": { "filter": "active" } }]
         }]
       }
     }
   }
   ```

   Порядок столов — порядок массива `desks` (он же порядок вкладок); отдельного поля `order` нет,
   чтобы не было двух источников правды.
3. **Сетка 12×12, координаты 1-based.** `x`, `y` — 1..12; `w` — 1..12; `h` — 1..6;
   `x + w - 1 <= 12`, `y + h - 1 <= 12`. Наложение виджетов **запрещено** (отказ до записи):
   раскладка остаётся предсказуемой, а рендереру не нужно решать, кто выше. Виджет без `x`/`y`
   (добавление из сетки, шаблон) ставится в первое свободное место сверху вниз, слева направо.
4. **Лимиты:** ≤12 столов на пространство, ≤24 виджетов на стол, имя 1..40 кодовых точек,
   название стола уникально в пространстве без учёта регистра. Удалить последний стол нельзя.
5. **Безопасные id:** стол и виджет — только UUID v4; `workspaceId` — `default` или UUID v4.
   Всё остальное отклоняется до чтения/записи. `config` виджета — только известные типу ключи
   (неизвестный ключ — ошибка, а не «сохраним как есть»).
6. **Битый файл.** Невалидный JSON или структура → пустое состояние (не падение), исходные байты
   один раз копируются в `desks.json.corrupt`. Так владелец не теряет данные молча.
7. **Версия.** `version: 1`; файл без `version` или с `version: 0` (в т.ч. старый плоский
   `{ workspaceId: {activeId, desks} }`) мигрирует в памяти и записывается в новом виде при первой
   мутации. Версия больше текущей → ошибка «обновите приложение», файл не трогается.
8. **Удаление виджета не удаляет данные.** В `desks.json` лежит только раскладка; задачи,
   напоминания, музыка и т. п. остаются в своих хранилищах.
9. **`state` данных:** `ok` — настоящие данные; `empty` — источник пуст/не настроен (например,
   город не задан: `error: 'no_city'`); `error` — сбой источника с кодом причины (`network`,
   `bad_data`, `no_data`); `stale` — данные есть, но кэш старше срока (погода >45 мин, курс >20 мин).

## Шаблоны

| id | Название | Виджеты (тип, место) |
|---|---|---|
| `empty` | Пустой | — |
| `work` | Работа | `tasks` 1,1 4×5 · `today` 5,1 4×5 · `weather` 9,1 4×2 · `currency` 9,3 4×3 · `commands` 1,6 8×3 · `system` 9,6 4×3 |
| `study` | Учёба | `tasks` 1,1 6×4 · `today` 7,1 6×4 · `music` 1,5 6×4 · `apps` 7,5 6×4 |
| `games` | Игры | `system` 1,1 6×3 · `apps` 7,1 6×3 · `music` 1,4 6×4 |
| `media` | Медиа | `music` 1,1 8×5 · `apps` 9,1 4×3 · `system` 9,4 4×2 |
| `avatar` | Только аватар | `orb` 1,1 12×6 |

Типы виджетов и настоящие источники: `tasks` — `runtime.queue.list()`; `today` — `reminders.list()`
+ `missions.list()`; `music` — `readMusicHistory()`; `weather` — `getCurrentWeather(city)` (open-meteo,
кэш 30 мин); `currency` — `getRates(codes)` (ЦБ, кэш 15 мин); `system` — снимок `require('os')`;
`apps` — `appsUsage` (`src/inventory/usage.js`); `orb` — состояние шара из `renderer/orb.js`;
`commands` — список своих команд (`src/commands/store.js`).

---

## Контракт для интегратора (IPC)

Все каналы — `ipcMain.handle`, как остальные данные окна: сначала `fromWindow(event)`, иначе
`{ ok: false, error: 'forbidden' }`; ошибки валидации — `{ ok: false, error: '<короткий русский текст>' }`;
никаких секретов и путей в ответах. `workspaceId` необязателен: если не передан, `main.js` берёт
текущее пространство (`workspaceHub.current().id`). Валидировать `workspaceId` в main не нужно —
это делает `DesksStore` (бросит «workspaceId: неверное пространство»).

| Канал | Аргумент | Ответ (успех) |
|---|---|---|
| `desks:state` | `{ workspaceId? }` | `{ ok: true, workspaceId, activeId, desks, data, templates, widgetTypes }`. `data` — `buildDeskData(activeDesk, sources)`; `templates` — `templateList()`; `widgetTypes` — `WIDGET_TYPES` |
| `desks:create` | `{ workspaceId?, name?, template }` | `{ ok: true, desk, activeId }` (новый стол становится активным) |
| `desks:rename` | `{ workspaceId?, id, name }` | `{ ok: true, desk }` |
| `desks:remove` | `{ workspaceId?, id }` | `{ ok: true, removed: true, activeId }` |
| `desks:select` | `{ workspaceId?, id }` | `{ ok: true, desk, activeId }` |
| `desks:reorder` | `{ workspaceId?, id, index }` | `{ ok: true, desks }` |
| `desks:widget-add` | `{ workspaceId?, deskId, widget: {type, x?, y?, w?, h?, config?} }` | `{ ok: true, desk, widget }` (без `x`/`y` место подбирается) |
| `desks:widget-move` | `{ workspaceId?, deskId, widgetId, x, y }` | `{ ok: true, desk, widget }` |
| `desks:widget-resize` | `{ workspaceId?, deskId, widgetId, w, h }` | `{ ok: true, desk, widget }` |
| `desks:widget-update` | `{ workspaceId?, deskId, widgetId, patch: {x?, y?, w?, h?, config?} }` | `{ ok: true, desk, widget }` (`type`/`id` менять нельзя) |
| `desks:widget-remove` | `{ workspaceId?, deskId, widgetId }` | `{ ok: true, desk, removedId }` |
| `desks:widgets-set` | `{ workspaceId?, deskId, widgets: [] }` | `{ ok: true, desk }` — полная замена (undo/восстановление раскладки) |

Формат `data` (то, что рендерер рисует):

```js
data[widgetId] = { type, state: 'ok'|'empty'|'error'|'stale', value, error: null|string }
```

Примеры ошибок: `{ ok:false, error: 'стол не найден' }`, `'место занято: виджеты накладываются'`,
`'виджет выходит за правый край сетки'`, `'в сетке стола нет свободного места для виджета такого размера'`,
`'нельзя удалить единственный стол'`, `'стол с таким названием уже есть'` (эти тексты показывать владельцу).

### `preload.js` (добавить)

```js
desksState: (payload = {}) => ipcRenderer.invoke('desks:state', payload),
desksCreate: (payload) => ipcRenderer.invoke('desks:create', payload),
desksRename: (payload) => ipcRenderer.invoke('desks:rename', payload),
desksRemove: (payload) => ipcRenderer.invoke('desks:remove', payload),
desksSelect: (payload) => ipcRenderer.invoke('desks:select', payload),
desksReorder: (payload) => ipcRenderer.invoke('desks:reorder', payload),
deskWidgetAdd: (payload) => ipcRenderer.invoke('desks:widget-add', payload),
deskWidgetMove: (payload) => ipcRenderer.invoke('desks:widget-move', payload),
deskWidgetResize: (payload) => ipcRenderer.invoke('desks:widget-resize', payload),
deskWidgetUpdate: (payload) => ipcRenderer.invoke('desks:widget-update', payload),
deskWidgetRemove: (payload) => ipcRenderer.invoke('desks:widget-remove', payload),
deskWidgetsSet: (payload) => ipcRenderer.invoke('desks:widgets-set', payload),
```

И такие же заглушки в `renderer/dev-stub.js` (для проверки в браузере), по образцу `widgetsData`.

### `main.js` (добавить)

```js
const os = require('os');                                       // уже есть в приложении
const { DesksStore } = require('./src/desks/store');
const { templateList, WIDGET_TYPES } = require('./src/desks/templates');
const { buildDeskData } = require('./src/desks/data');

const desks = new DesksStore({ dataDir: DATA_DIR });
// sources собираются при каждом desks:state (они уже посчитаны/закэшированы приложением):
//   os: { cpus: os.cpus(), totalmem: os.totalmem(), freemem: os.freemem(),
//         platform: os.platform(), arch: os.arch(), uptime: os.uptime() },
//   tasks: runtime.queue.list(),
//   reminders: reminders.list({ workspaceId }),
//   missions: missions.list(),
//   music: readMusicHistory(),
//   weather: <результат getCurrentWeather(city) + fetchedAt>,
//   currency: <результат getRates(codes) + fetchedAt>,
//   apps: appsUsage,
//   orb: <последнее состояние шара из agent:event / renderer>,
//   commands: <commands list текущего пространства>.
// Погоду/курс main берёт из существующих кэшей (getCurrentWeather / getRates) — data.js сам
// в сеть не ходит. fetchedAt можно ставить временем последнего ответа источника.
```

`desks:state`: `desks.ensure(workspaceId)` (первый пустой стол при первом открытии), затем
`buildDeskData(desks.active(workspaceId), sources)`. В ответ включить `templates: templateList()`
и `widgetTypes: WIDGET_TYPES`, чтобы мастер стола не дублировал каталог в рендерере.
Мутации: `desks.create/rename/remove/select/reorder/addWidget/moveWidget/resizeWidget/updateWidget/removeWidget/setWidgets`
внутри `try/catch` → `{ ok:false, error: err.message }`. `ensure` пишет файл только при первом
создании — обычное открытие остаётся чтением.

### `AGENTS.md` (нужно интегратору; я этот файл не менял)

`tests/project-map.test.js` падает, пока карта не знает `src/desks/*.js`. Достаточно одного ряда
в таблице «Ядро: `src/`» (проверяются точные пути в обратных кавычках):

```md
| `src/desks/` | `src/desks/store.js` раскладки столов в `desks.json` (≤12 столов/пространство, ≤24 виджетов, сетка 12×12, атомарная запись, миграция, битый файл → пусто); `src/desks/templates.js` каталог виджетов и шесть шаблонов; `src/desks/data.js` чистые данные виджетов из внедрённых источников (`ok`/`empty`/`error`/`stale`) |
```

(Рядом в том же падении — `src/extensions/*.js` другой зоны; их строки добавляет владелец
расширений/интегратор. Пока карта не обновлена, `project-map.test.js` красный — это
единственное падение полного прогона.)

---

## Тесты

- `node --test tests/desks.test.js` — **32 pass, 0 fail** (хранилище и файл 21: базовые операции 4,
  лимиты/id 3, шаблоны 2, схема/сетка 3, виджеты 2, файл/версия/миграция/конструктор 7;
  данные источников 11: по каждому источнику, `buildWidget`, `buildDeskData`).
- `node --test` (полный) — **1716 pass, 1 fail**; падение только `tests/project-map.test.js`
  из-за строк карты выше (в том же падении — `src/extensions/*.js` чужой зоны). До начала
  работы: 1646 pass / 0 fail. Один промежуточный полный прогон дал разовый сбой
  `tests/code-test.test.js` «таймаут и стоп снимают процесс вместе с потомками» (2733 мс под
  параллельной нагрузкой); изолированно этот файл проходит 8/8, повторный полный прогон —
  снова только `project-map.test.js`. Это не относится к столам.
- Покрыто: создание/переименование/удаление/переключение/порядок; изоляция пространств;
  лимиты; безопасные id; 6 шаблонов и запрет выдуманных типов; координаты/наложение/авто-место;
  config; добавление/перенос/размер/правка/удаление виджета; полная замена раскладки;
  повторное чтение; атомарность (нет `.tmp`); битый JSON + `desks.json.corrupt`; будущая версия
  (файл не тронут); миграция версии и плоского формата; `data.js` — `ok`/`empty`/`error`/`stale`
  по каждому источнику, `buildDeskData`, неизменность источников.
- Не покрыто: живое окно и мышь/клавиатура — рендерера в этой зоне нет.

## Остаток / что дальше

1. Экран «Столы» в рендерере: вкладки, мастер по `templates`, сетка с перетаскиванием и
   клавиатурой (стрелки — перенос, `+`/`−` — размер), состояния `empty`/`error`/`stale`,
   кнопки «Обновить», «Убрать виджет». Нужен интегратор (`renderer/app.js`, `index.html`, CSS).
2. Проводка IPC в `main.js`/`preload.js` по контракту выше; `fetchedAt` для погоды/курса —
   из кэшей источников (сейчас в `widgets:data` он не отдаётся: `src/weather/open-meteo.js`,
   `src/currency/rates.js` кэшируют внутри, при проводке достаточно времени ответа).
3. `AGENTS.md`: добавить ряд `src/desks/` (точный текст выше) — без него полный прогон
   остаётся красным на `project-map.test.js`.
4. Живая проверка: открыть окно, создать 2–3 стола из шаблонов, переставить/удалить виджет,
   перезапустить приложение и убедиться, что раскладка и активный стол восстановились,
   а недоступный источник (без города/сети) показывает `empty`/`error`, а не цифры.
5. Общего файла `desks.json` в настоящей `data/` не создавалось: тесты работают в `%TEMP%`
   (`NOX_DATA_DIR`-совместимая папка через `fs.mkdtempSync`), требования AGENTS.md соблюдены.
