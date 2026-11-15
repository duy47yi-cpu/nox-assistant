# Red-team аудит Electron-оболочки Nox Assistant — 2026-11-14

**Зона:** `apps/jarvis-desktop` — `main.js` (окна, `webPreferences`, `ipcMain.handle`, `settings:set`, `mcp:add`, `source:open`, `shell.openExternal`), `preload.js`, `renderer/*.html` (CSP), `renderer/app.js`, `renderer/aether/**`, `renderer/dev-stub.js`.
**Задача:** найти **новое** относительно `reports/SECURITY-AUDIT-2026-11-14.md`; его находки (SEC-01…SEC-22) не повторяются.
**Ограничения:** настоящие `.env` и `data/` не читались; код продукта не менялся; пакеты не ставились; всё проверялось на копиях/временных данных в `.tmp/red-team/electron-ipc2/`.
**Важно про строки:** `main.js` правится параллельно другими исполнителями, поэтому номера строк — на момент проверки (2026-11-14, ~21:50). Ищите по именам каналов/функций.

---

## 1. Итоговая таблица

| ID | Severity | Область | Суть | Место |
|---|---|---|---|---|
| RT-IPC-01 | **HIGH** | MCP | `mcp:add` запускает **произвольную команду ОС** без подтверждения, пишет её в `settings.json` (`mcpServers`) и она же исполняется при каждом старте | `main.js:4648`, `main.js:734-737`, `main.js:4864`; `src/mcp/client.js:812,245,142,385` |
| RT-IPC-02 | **HIGH** | команды | `commands:save` + `commands:triggers-update` + `commands:run`: окно создаёт команду с шагами `app_open` (любой exe), `ui_keys`, `downloads_remove` и включает расписание/хоткей; шаги белым списком не проверяются | `main.js:2821,2979,3349`; `src/commands/store.js:85,87,323-342,971` |
| RT-IPC-03 | MEDIUM | календарь | `calendar:setSource` принимает **любой http(s)-адрес** (включая `http://127.0.0.1:…`) и **любой локальный .ics/.json**, без диалога выбора | `main.js:3918`; `src/calendar/index.js:1838-1862,1227` |
| RT-IPC-04 | MEDIUM | настройки | `settings:set` действительно закрыт белым списком, но `settings.json` — общий канал: минимум 7 других обработчиков пишут в него свои ключи в обход белого списка | `main.js:3450,3489,4597,3781,2728-2745,2621` |
| RT-IPC-05 | LOW/MED | ссылки | `source:open` проверяет схему, но разрешает любой хост, без жеста пользователя и без подтверждения → тихое открытие вкладок браузера, CSRF к локальным сервисам, egress-канал | `main.js:1876-1889` |
| RT-IPC-06 | MEDIUM | окна/CSP | `will-navigate` пропускает **любой `file://`** (включая UNC и чужой HTML), у печатного окна guard не навешен, нет `setPermissionRequestHandler`, CSP Aether без `object-src/base-uri/form-action` | `src/control/stop.js:121-134`; `main.js:542,4677-4701`; `renderer/aether/index.html:5` |

Отдельно: **XSS/DOM-инъекция при текущем CSP не воспроизводится** — см. §4, там же остаточные риски.

---

## 2. Подробно

### RT-IPC-01. HIGH. `mcp:add`: произвольная команда ОС без подтверждения + автозапуск при старте

**Где**

- `main.js:4648` — `ipcMain.handle('mcp:add', (event, name, target, args) => fromWindow(event) ? mcpManager.add(name, target, args) : …)`. **Никакого диалога/подтверждения/жеста** — только проверка отправителя.
- `main.js:734-737` — менеджер сохраняет конфиг в настройки: `save: (servers) => saveSettings({ mcpServers: servers })`.
- `main.js:4864` — при старте приложения: `mcpManager.startAll()`, то есть всё, что лежит в `mcpServers`, запускается само.
- `src/mcp/client.js:812-829` — `add()`: `configFromForm(target,args)` → `_persist()` → `start(key)`.
- `src/mcp/client.js:245-253` — «адрес или команда»: если не `http(s)`, то `normalizeServerConfig({command: value, args})`.
- `src/mcp/client.js:142-149` — `validateCommand`: длина ≤ 400, нет управляющих символов и `[&|<>;`$%"'\r\n]`. **Любой исполняемый файл разрешён** (`cmd.exe`, `powershell.exe`, `node.exe`, путь к любому exe).
- `src/mcp/client.js:113-140` — аргументы: ≤ 40 шт., ≤ 1000 знаков, без тех же метасимволов. Base64/paths проходят.
- `src/mcp/client.js:385` — `spawn(this.command, this.args, …)`.

**Сценарий.** Скомпрометированный renderer (XSS/расширение/код в DevTools/подмена `renderer/*.js`, не важно) одним вызовом делает:

```js
window.jarvis.mcpAdd('pwn', 'powershell.exe',
  "-NoProfile -NonInteractive -EncodedCommand " + btoa(String.fromCharCode(...new TextEncoder().encode('…')))); // UTF-16LE base64
```

Команда исполняется сразу, конфиг остаётся в `settings.json`, и после перезапуска приложения (и при следующем входе в Windows с автозапуском) выполняется снова — без окна и без спроса. Пользователь видит только новую строку «Подключения → pwn» (и то не обязательно: MCP-сервер может отвечать валидным JSON-RPC).

**PoC (реальный запуск, временная папка).**

Скрипт: `.tmp/red-team/electron-ipc2/poc-mcp-add.js` — воспроизводит ровно то, что делает обработчик: `McpManager.add('pwn','powershell.exe', args)` → затем «перезапуск» (новый `McpManager` на тех же настройках) → `startAll()`.

```powershell
PS D:\nox-release> node .tmp/red-team/electron-ipc2/poc-mcp-add.js
add() response ok = true | error = сервис завершился (код 0); вывод сервиса: …
marker1 created = true
settings.json now = { "mcpServers": { "pwn": { "command": "powershell.exe",
  "args": ["-NoProfile","-NonInteractive","-EncodedCommand","TgBlAHcALQBJAHQAZQBtAC4A…"],
  "env": {}, "disabled": false } } }
config runs at startup: marker recreated = true
```

Файл-`маркер` создан командой PowerShell; после «перезапуска» создан снова — конфиг из `settings.json` действительно исполняется при старте. Ни одного диалога в цепочке нет.

**Почему это new, а не SEC-05.** Старый аудит отметил, что дочерние MCP-серверы получают все секреты процесса. Здесь другое: **сам канал IPC позволяет любому коду окна запустить любую программу и закрепиться в настройках**, без участия владельца и без проверки, что «сервис» — действительно MCP.

**Как чинить**

1. Подтверждение владельца для `mcp:add` (диалог с командой и аргументами; кнопка «Добавить» на экране «Подключения» — это и есть жест, но IPC этого не проверяет).
2. Белый список исполняемых файлов (или `cwd` + `node/npx/uvx/python`), запрет `cmd.exe/powershell.exe` как «MCP-сервера» и/или обязательный `--mcp`-режим.
3. Показывать в окне полную команду с аргументами (сейчас `publicTarget` режет аргументы) и требовать подтверждения при первом запуске нового конфига.
4. Хранить `mcpServers` отдельным файлом с валидацией при загрузке (см. RT-IPC-04).

---

### RT-IPC-02. HIGH. `commands:save` + `commands:triggers-update` + `commands:run`: тихое создание и планирование действий

**Где**

- `main.js:2821-2834` — `commands:save`: единственная проверка шагов — `DANGEROUS_TOOLS.has(step.tool)` (8 имён). Всё остальное сохраняется «как есть».
- `src/commands/store.js:323-342` — `checkSteps`: имя инструмента — произвольная строка 1…N («лишь бы не dangerous, не `mission_*`/`command_*`»), `args` — произвольный JSON с лимитами глубины/длины.
- `src/commands/store.js:85-87` — `EDITOR_STEP_TOOLS = ['app_open','ui_keys','wait','speak','volume_set']` — это **только каталог для UI** (`tools:catalog`, `main.js:3370`), а не ограничение сохранения. `DANGEROUS_TOOLS` не содержит, например, `downloads_remove`, `ui_type`, `browser_open`, `url_open`, `desktop_type`.
- `main.js:2979-2981` — `commands:triggers-update`: включает расписание/хоткей без подтверждения.
- `main.js:3349-3360` — `commands:run`: запускает сохранённую команду с `ownerCommand: true` (обходит подтверждения, что для команд и задумано).
- `src/commands/store.js:971-988` — `updateTriggers` пишет расписание/хоткей в `commands.json`.

**Сценарий.** Окно (скомпрометированный renderer) за два IPC-вызова создаёт команду и планирует её:

```js
await window.jarvis.saveCommand({
  name: 'pwn', phrase: 'служебная',
  steps: [
    { tool: 'app_open', args: { name: 'C:\\\\Windows\\\\System32\\\\calc.exe' } },   // любой exe
    { tool: 'ui_keys', args: { keys: 'ctrl+shift+delete' } },                    // нажатия в активное окно
    { tool: 'downloads_remove', args: { confirm: true, paths: ['C:\\\\Users\\\\Public'] } }  // удаление файлов
  ]
});
await window.jarvis.updateCommandTriggers(id, { schedule: { enabled: true, type: 'interval', minutes: 1 } });
// и/или: await window.jarvis.runCommand(id);
```

Команда остаётся в `commands.json` и исполняется планировщиком/по хоткею без окна; шаги `app_open`/`ui_keys`/`downloads_remove` проходят как «разрешённые» (в UI их даже нет в каталоге, но сохранение их не проверяет). Дополнительно: имя несуществующего инструмента тоже принимается — команда падает уже в фоне.

**PoC (реальный запуск).** `.tmp/red-team/electron-ipc2/poc-ipc.js` (блок 1):

```powershell
PS D:\nox-release> node .tmp/red-team/electron-ipc2/poc-ipc.js
commands:save accepted tools = app_open, ui_keys, downloads_remove, no_such_tool_at_all
schedule enabled = true interval 1min
after triggers-update hotkey = Control+Alt+K | enabled = true
shell_run rejected = шаг 1: «shell_run» нельзя сохранить в команде
commands.json bytes = 2018
```

То есть единственное, что реально нельзя, — 8 имён из `DANGEROUS_TOOLS`; всё остальное (включая удаление файлов и запуск программ и нажатия клавиш) сохраняется и планируется.

**Как чинить**

1. В `commands:save` проверять `step.tool` по `EDITOR_STEP_TOOLS` (или расширить белый список явно) и валидировать `args` по JSON-схеме инструмента из реестра.
2. `commands:triggers-update` — показывать подтверждение при включении расписания/хоткея из окна (как «владелец включил»), либо ограничить частоту.
3. Для `downloads_remove`/`ui_keys`/`app_open` в сохранённой команде — отдельный флаг «команда содержит опасные шаги» и подтверждение при запуске.

---

### RT-IPC-03. MEDIUM. `calendar:setSource`: SSRF из главного процесса и чтение произвольного локального .json/.ics

**Где**

- `main.js:3918-3927` — `calendar:setSource` принимает объект от окна, `normalizeCalendarSetting(payload)` → `saveSettings({calendar})` → сразу читает источник.
- `src/calendar/index.js:1838-1848` — `type:'file'`: нужен абсолютный путь; запрещены только имена с `.env` и расширения `.bin/.key/.pem`; всё остальное `.ics/.json` — можно.
- `src/calendar/index.js:1850-1862` — `type:'url'`: проверяется только схема `http/https`; **никаких ограничений на хост/порт/приватные адреса**.
- `src/calendar/index.js:1227` — файл читается напрямую `fs.readFileSync(file,'utf8')`; в снапшот попадает распарсенное содержимое.
- `src/calendar/index.js:889-893` — по URL главный процесс делает `http/https.get`.

**Сценарий.** Окно может (а) прочитать любой локальный `.ics/.json` в обход диалога `calendar:pickFile` (например, `C:\\\\Users\\\\<user>\\\\AppData\\\\…\\\\*.json`) и увидеть содержимое как события; (б) заставить **главный процесс** сходить GET-ом на `http://127.0.0.1:<port>/…` — это SSRF к локальным сервисам (порт-скан, запросы к localhost-админкам, DevTools-портам, роутеру), причём с настройкой, которая сохранится в `settings.json` и будет обновляться в фоне (виджет календаря/утренняя сводка).

**PoC (реальный запуск).** `poc-ipc.js` (блок 2) + `poc-calendar-ssrf.js`:

```powershell
PS D:\nox-release> node .tmp/red-team/electron-ipc2/poc-calendar-ssrf.js
accepted setting = {"type":"url","url":"http://127.0.0.1:64386/private.ics","label":"Календарь (127.0.0.1)"}
requests seen by local service = ["/private.ics"]     # главный процесс сам сходил на localhost
snapshot keys = ok,connected,state,stateLabel,source,sourceLabel,sources,timeZone,items,conflicts,total,fetchedAt,stale,reason
```

и чтение файла (файл `personal.ics` вне data-папки):

```powershell
PS D:\nox-release> node -e "…fetchCalendar({type:'file',filePath:'.tmp/red-team/electron-ipc2/personal.ics'})…"
state ok items [{"uid":"1","title":"Секрет из файла", … ,"description":null,"source":"Файл: personal.ics"}]
```

(у файла, разумеется, не должно быть расширения `.env/.key/.pem`; JSON/ICS-файлы продукта этому условию удовлетворяют).

**Как чинить**

1. Для `type:'url'` — только публичные `https` (или белый список доменов), запрет loopback/приватных IP/портов, DNS-проверка после резолва (как в WebFetch), лимит редиректов.
2. Для `type:'file'` — разрешить только папку данных календаря или пути, выбранные диалогом (`calendar:pickFile` уже возвращает путь — сохранять «провенанс» выбора).
3. Ограничить размер читаемого файла (сейчас `readFileSync` любого размера — DoS главного процесса).

---

### RT-IPC-04. MEDIUM. `settings:set` закрыт белым списком, но `settings.json` — общий канал (белый список не граница)

**Где**

- `main.js:3450` — `SETTING_KEYS` (13 булевых ключей).
- `main.js:3489-3529` — `settings:set`: спец-ветки `restInterval`, `notificationVoice`, `voiceVolume/voiceRate`, `voiceSpeaker`, `voicePersona`, `keepAwake`, `calendar`, `uiShell`; дальше `main.js:3557`: `if (!SETTING_KEYS.has(key) || typeof value !== 'boolean') return {ok:false}`.
- Итог: **произвольные ключи через `settings:set` записать нельзя** (`mcpServers`, `connectedFolders` — вернут `{ok:false}`); эта часть гипотезы **не подтвердилась** — и это хорошо.

**Но** тот же файл `settings.json` пишут другие IPC-каналы, каждый со своей (местами никакой) проверкой:

| Канал | Ключ | Проверка значения |
|---|---|---|
| `mcp:add` (`main.js:4648`) | `mcpServers` | структура MCP (см. RT-IPC-01) — **исполняется при старте** |
| `calendar:setSource` (`main.js:3918`) | `calendar` | путь/URL без ограничения хоста/папки (RT-IPC-03) |
| `window:setBackground` (`main.js:4597`) | `windowBg` | regex `^#[0-9a-f]{6}$` — ок |
| `widgets:setCity` (`main.js:3781`) | `city` | `String().trim().slice(0,100)` — любая строка |
| `folders:remove` (`main.js:2745`) | `connectedFolders` | любая строка, только удаление из списка |
| `music:setService` (`main.js:2621`) | `musicService` | только известные id |
| `quick:setHotkey` (`main.js:1920-1928`) | `quickHotkey` | `normalizeQuickHotkey` |

**Сценарий.** «Белый список настроек» защищает только один вход; любой другой обработчик — это ещё один доверенный писатель в `settings.json`. Компрометированное окно комбинирует каналы: `mcp:add` + `calendar:setSource` + `widgets:setCity` → в `settings.json` оказываются произвольная команда (исполняется при старте), произвольный URL (фоновые GET-ы) и произвольная строка (уходит в виджет/сводку). Проверять «схему настроек» централизованно негде.

**Как чинить.** Один слой записи настроек (`updateSettingsSchema(patch)`) с валидаторами на каждый ключ и правом записи только из main-процесса; `mcpServers`/число/город/папки — отдельные файлы или под-схемы. IPC-каналы не должны напрямую делать `saveSettings({...})` с необработанными значениями.

---

### RT-IPC-05. LOW/MEDIUM. `source:open`: любая http(s)-ссылка без жеста и без ограничения хоста — тихий egress и CSRF

**Где.** `main.js:1876-1889`:

```js
if (typeof value !== 'string' || value.length > 2048) return {ok:false,…};
const url = new URL(value);
if (!['https:','http:'].includes(url.protocol) || url.username || url.password) return {ok:false,…};
await shell.openExternal(url.href);
```

Схемы проверены (что и закрывает классику `file:`/`javascript:`/`smb:`), вход с логином/паролем отсечён. Но:
- нет привязки к жесту пользователя (любой код окна может вызвать без клика);
- нет ограничений на хост/порт — `http://127.0.0.1:…`, `http://192.168.…`, `http://<роутер>` разрешены;
- нет ограничения частоты (можно открыть десятки вкладок);
- для renderer'а с `connect-src 'none'` в CSP `source:open` — единственный «легальный» сетевой выход (данные уходят в URL на чужой сайт), плюс возможность фишинга/auth-промптов.

**PoC (та же проверка, что в обработчике).** `poc-ipc.js` (блок 3):

```text
source:open "javascript:alert(1)"            => rejected
source:open "file:///C:/Windows/win.ini"      => rejected
source:open "https://user:pw@example.com/"    => rejected
source:open "http://127.0.0.1:9222/json"      => openExternal -> http://127.0.0.1:9222/json
```

**Как чинить.** Требовать жест (например, `event.senderFrame` + проверка `webContents.isFocused()`/недавнего клика в окне), ограничить `source:open` только настоящими источниками из ответа (список `sources` в main-процессе), разрешать только `https`, опционально — подтверждение для незнакомого домена; для локальных адресов — отдельный канал с явным подтверждением.

---

### RT-IPC-06. MEDIUM. Окна: `will-navigate` пропускает любой `file://`, печатное окно без guard, нет permission-обработчиков, CSP Aether неполный

**Где**

- `src/control/stop.js:121-134` — guard: `setWindowOpenHandler → deny` (ок), а `will-navigate` блокирует только **не-file**: `if (!target.startsWith('file://')) preventDefault()`. Значит разрешены `file:///C:/Windows/win.ini`, `file:///D:/…/evil.html`, `file://attacker.example/share/pwn.html` (UNC). Навигация на такой документ **сохраняет preload-мост** этого окна (у main-окна — все 128 методов `window.jarvis`).
- `main.js:542` — печатное `BrowserWindow` создаётся **без** `attachWindowGuards` (javascript:false, но навигация не ограничена).
- Ни на одном из 5 окон (`main.js:582,1641,2043,4473,4678`) нет `session.setPermissionRequestHandler` / `setPermissionCheckHandler` — запросы камеры/микрофона/уведомлений/буфера по умолчанию разрешаются по политике Chromium; в браузерном окне (`src/tools/browser.js:564-565`) они есть — то есть в оболочке это просто забыто.
- `renderer/aether/index.html:5` — CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'` — **нет** `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` (в legacy `index.html:7` они есть). `object-src` падает в `default-src 'self'` → разрешены `<object>/<embed>` с `file:`-содержимым; `base-uri` не ограничен.
- `renderer/aether/index.html:18` — `dev-stub.js` подключён в Aether **безусловно** (в legacy его грузит `shared.js` только без `window.jarvis`). Это не дыра сама по себе (`dev-stub.js:28` выходит при `window.jarvis`), но при сбое preload окно молча живёт на заглушке.

**PoC (реальный запуск guard-а).** `poc-ipc.js` (блок 4):

```text
will-navigate file:///D:/nox-release/renderer/index.html => ALLOWED
will-navigate file:///C:/Windows/win.ini                => ALLOWED
will-navigate file://attacker.example/share/pwn.html    => ALLOWED
will-navigate https://evil.example/                     => blocked
```

**Сценарий.** Любой локальный HTML (скачанный файл, вложение из чата, файл в подключённой папке, сетевая шара) при переходе на него получает preload-мост и может звать все IPC-методы — то есть «локальный файл» становится доверенным кодом окна. Вместе с RT-IPC-01/02 это превращает клик по «открыть локальный отчёт/ссылку» (или инъекцию `meta refresh`, если она когда-нибудь появится) в запуск команд.

**Как чинить**

1. Белый список навигации: только `file://<app>/renderer/**` (и нужные html) — сравнивать `path.resolve(fileURLToPath(url))` с каталогом приложения; всё остальное — `preventDefault` (или открывать `shell.openExternal` для http).
2. Навесить `attachWindowGuards` на печатное окно (и на все будущие).
3. `session.defaultSession.setPermissionRequestHandler((wc,p,cb)=>cb(false))` (и check-handler) + `setPermissionRequestHandler` на окна с preload.
4. Привести CSP Aether к legacy: добавить `object-src 'none'; base-uri 'none'; form-action 'none'` (и `frame-ancestors 'none'` при желании).
5. `dev-stub.js` в Aether грузить так же, как в legacy (из `shared.js`, только без `window.jarvis`), а не тегом в HTML.

---

## 3. Сводка по вопросам задания

| Вопрос | Ответ |
|---|---|
| 1. Слабые `ipcMain.handle` | 124 обработчика, все проверяют отправителя (`fromWindow/fromMini`), но валидация аргументов неровная: `mcp:add`/команды/календарь — см. RT-01…03; `widgets:setCity`, `desks:*`, `memory:update`, `snippets:save` принимают произвольные строки/объекты и пишут их на диск (диск/размер не ограничены). |
| 2. `settings:set` — произвольные ключи? | **Нет**: белый список `SETTING_KEYS` + boolean (RT-IPC-04). Но `mcpServers` пишет `mcp:add`, а исполняется при старте — это и есть «запись → исполнение», только другим каналом. |
| 3. `mcp:add` — произвольная команда без подтверждения? | **Да**, RT-IPC-01, с закреплением в настройках и автозапуском. |
| 4. `source:open` — какие схемы? | Только `http/https`; `file:`, `javascript:`, userinfo отсечены. Остаётся любой хост/порт и отсутствие жеста — RT-IPC-05. |
| 5. XSS/DOM при текущем CSP? | Не воспроизводится; см. §4. |
| 6. Окна без sandbox/guards? | `sandbox:true` + `contextIsolation:true` + `nodeIntegration:false` у всех 5 окон; печатное окно без guards; навигация `file://` не ограничена — RT-IPC-06. |

---

## 4. XSS/DOM-инъекции: проверено, скрипт не исполняется

**Вердикт:** на текущем коде **HTML-инъекция из данных модели/пользователя не приводит к исполнению скрипта**. Обоснование (проверено чтением + сверкой всех синков):

1. CSP `script-src 'self'` **без** `'unsafe-inline'` (`renderer/index.html:7`, `renderer/aether/index.html:5`, `mini.html:6`, `dictate.html:6`) — блокирует inline-`<script>`, inline-обработчики (`onerror=`, `onclick=`) и `javascript:`-URL. Инъекция вида `<img src=x onerror=alert(1)>` не выполнится.
2. HTML-синков из данных почти нет: `innerHTML` встречается в 4 местах и везде с **константами**: `shared.js:99,105` (иконки из таблицы `P`), `nox-screen.js:329,335,356` (SVG-глифы), `app.js:5444` (`sel.innerHTML=''`).
3. Markdown Aether (`renderer/aether/markdown.js`) собран на DOM API: `createElement`/`createTextNode`/`textContent`, ссылки — `a.href='#'` с обработчиком, URL проверяется регуляркой `https?:\/\/` и открывается через `source:open` (см. RT-05). LaTeX (`renderer/math.js`) тоже строит узлы, а не HTML.
4. `style` в элементах ставится через CSSOM, а не атрибутом (`shared.js:117` — комментарий прямо про CSP).

**Остаточные риски (не находки, но важно):**
- CSP Aether неполный (RT-06): при появлении любого HTML-синка `<object data="file://…">`/подмена `<base>` станут возможны.
- `connect-src 'none'` защищает от `fetch`-эксфильтрации, но `source:open` её обходит (URL-канал), а `Object`/`img`/`form` не ограничены в Aether.
- Появление одного `innerHTML` с данными модели сразу даст HTML-инъекцию (не скрипт, но фишинг/подмену интерфейса) — стоит включить `require-trusted-types-for 'script'` или линт-правило «`innerHTML` только с константой».

---

## 5. Что проверено и закрыто (не дублирует старый аудит)

- Все 124 `ipcMain.handle` проверяют `event.sender` (`fromWindow`/`fromMini`/`dictateWin`); чужих каналов не найдено — согласуется с §«Что уже закрыто» старого аудита.
- Вложения чата: `buildMessage` (`main.js:963-981`) читает только пути из `pickedFiles` (белый список после диалога) — обойти из окна нельзя.
- `window:control` — строгий `switch` по трём действиям (`main.js:4611-4624`); `window:setBackground` — regex цвета.
- `tasks:openReport` — `taskId` проверяется `/^[A-Za-z0-9_-]{1,100}$/` и существованием задачи, путь собирает main (`main.js:3430-3437`; `src/tasks/runtime.js:616-624`).
- `source:open` схемы и userinfo — закрыты (RT-05 только про хост/жест).
- `preload.js` не даёт общего `invoke`: только 128 именованных методов — поверхность ограничена, но именно она и есть «API доверия» к renderer'у.
- Окна: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `setWindowOpenHandler→deny`, защита от цикла падений — на месте (кроме навигации `file://`, RT-06).

---

## 6. Порядок исправлений

1. **RT-IPC-01** (подтверждение `mcp:add` + белый список команд) — один вечер, снимает готовый RCE+persistence.
2. **RT-IPC-02** (проверять шаги команд по белому списку и схеме args; подтверждение расписания) — полдня.
3. **RT-IPC-06** (белый список `file://`-навигации, guards на печатное окно, permission-хендлеры, CSP Aether) — полдня.
4. **RT-IPC-03** (публичные https + папка данных для файла) и **RT-IPC-04** (единый слой настроек) — по дню.
5. **RT-IPC-05** (жест + https) — мелкая правка.

---

## Приложение. Как воспроизвести

Все PoC лежат в `.tmp/red-team/electron-ipc2/` (временная папка, продукт не менялся):

| Файл | Что доказывает |
|---|---|
| `poc-mcp-add.js` | `mcp:add` → запуск PowerShell-команды, запись в настройки, повторный запуск при старте |
| `poc-ipc.js` | шаги команд и расписание; чтение файла/URL календарём; матрица `source:open`; `will-navigate` |
| `poc-calendar-ssrf.js` | SSRF: главный процесс GET-ит `http://127.0.0.1:<port>` |

```powershell
PS D:\nox-release> node .tmp/red-team/electron-ipc2/poc-mcp-add.js
PS D:\nox-release> node .tmp/red-team/electron-ipc2/poc-ipc.js
PS D:\nox-release> node .tmp/red-team/electron-ipc2/poc-calendar-ssrf.js
```

Постоянного состояния не создаётся; файлы `settings.json`/`commands.json`/`*.ics`/`pwned*.txt` появляются только внутри `.tmp/red-team/electron-ipc2/`.
