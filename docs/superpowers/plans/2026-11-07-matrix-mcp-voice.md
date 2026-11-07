# Матрица MCP и голоса: состояние, изменения, контракт интеграции

Зона: этапы 5–6 плана (`2026-11-07-nox-reference-implementation.md`), этапы F и G(9) глубокой спецификации.
Источники требований: `2026-11-07-video-analysis.md` — видео 3, 00:20–00:28 (схема MCP-подключений) и видео 4, 00:36–00:46 (диктовка, настройки голоса, карточки голосов).
Владелец зоны: mcp-voice. Изменения не коммитились. `.env` и настоящая `data/` не читались; живые проверки шли с временным `NOX_DATA_DIR`.

## Как проверялось

- Код и тесты: `apps/jarvis-desktop/src/mcp/client.js`, `src/validate/connections.js`, `renderer/connections.js`, `src/voice/*`, `scripts/tts/`, `scripts/check-voice.js`, `main.js`/`preload.js` (только чтение).
- Целевые тесты: `node --test tests/mcp-manager.test.js tests/connections-view.test.js tests/validate-connections.test.js tests/voice-options.test.js tests/mcp-mail.test.js tests/dictation.test.js tests/tts.test.js tests/fish-tts.test.js` — 90/90 pass.
- Полный прогон `node --test` в `apps/jarvis-desktop` — см. раздел «Тесты».
- Настоящее окно (CDP `http://127.0.0.1:9333`, сборка с прежним `main.js`): перезагрузка страницы, новый `renderer/connections.js` не падает, старая форма ответа моста поддерживается, ошибки добавляются понятным текстом.
- Изолированная копия приложения (временная папка, patched `main.js` по контракту ниже, CDP `9355`, временный `NOX_DATA_DIR`): пройдена живая вертикаль MCP и диктовки. Скриншоты: `%TEMP%\nox-mvp-verify\01-mcp-connected.png`, `02-mcp-error-isolated.png`, `03-mcp-disabled.png`, `05-dictation-honest-error.png`. Настоящий `main.js` не менялся — патч применял временный скрипт только к копии.

## Матрица MCP

| # | Возможность (видео/этап) | Было | Стало в моей зоне | Доказательство | Проверка |
|---|---|---|---|---|---|
| M1 | Добавить сервис из окна | только запись в `settings.json`, подключение после перезапуска, статус «после перезапуска» | `McpManager.add()` подключает сразу, валидирует и сохраняет; при сбое сервис остаётся со статусом `error` и причиной | `src/mcp/client.js`; тест «добавление сервера без перезапуска…» | живая копия: `mcpAdd('echo', node, fixture)` → `status:'connected'`; окно показывает «подключён» |
| M2 | Показать имя сервиса и его возможности | имя, транспорт, адрес/команда, «подключён/нет» | + `serverInfo`, `protocolVersion`, `capabilities{tools,resources,prompts,logging}`, список действий `{title,description}`, `toolCount`, `status`, `error` | `serverView` внутри `McpManager.state()`; `renderer/connections.js` | живая копия: `Действия (5): Повтор, Сложить, Медленный ответ, Сломать сервер и ещё 1`; подпись `Протокол MCP 2025-06-18 · Сервер: echo-fixture 1.0.0` |
| M3 | Состояние без перезапуска | нет | действия возвращают новое состояние; окно дополнительно опрашивает `mcp:state` раз в 3 с, пока раздел виден | `renderer/connections.js`, `polling()` | живая копия: сервер выключен вызовом в обход кнопки — через 3,6 с список сам показал «выключен» |
| M4 | Остановка/запуск сервиса | только запись `disabled`, применялась при перезапуске | `toggle()` закрывает процесс и снимает инструменты, включение подключает заново | `McpManager.stop/toggle`; тест «отключение убирает инструменты…» | живая копия: `debug:tools` до/после — `echo_*` исчезли и вернулись; реестр настоящего приложения проверялся тем же путём в копии |
| M5 | Сбой сервера изолирован | сбой при старте пропускался, живой сервер мог умереть молча | падение после подключения переводит только этот сервер в `error`, снимает его инструменты; остальные живы; окно не падает | `McpClient.onClose` → `McpManager._onCrash`; тест «сбой одного сервера изолирован…» | живая копия: `broken` с несуществующей программой дал `error: программа не найдена…`, `echo` остался `connected` |
| M6 | Понятная ошибка и тайм-аут | текст ошибки `spawn … ENOENT` | причина на русском (`программа не найдена`, `нет прав`, `не ответил вовремя`, `вывод сервиса: …`); тайм-аут запроса задаётся `timeoutMs` сервера (1–300 с) | `friendlyConnectError`, `_stdioRequest`, `_onExit`; тесты «ошибка подключения сохраняет сервис…», «инструмент, который не отвечает…» | живая копия: `повторить` у строки ошибки; тайм-аут 1,2 с проверен тестом без гибели сервера |
| M7 | Отключение убирает инструменты | инструменты оставались до перезапуска | `unregister(name)` вызывается для каждого зарегистрированного инструмента; при включении регистрация повторяется | `McpManager._unregisterAll`/`stop` | живая копия: `debug:tools` пуст после выключения |
| M8 | Валидация адреса/команды/аргументов | проверялось только имя и непустой адрес | проверка: имя `[A-Za-z0-9_-]{1,40}`; URL только http/https, без логина/пароля, ≤400; команда ≤400 без управляющих символов и `&|<>;`$%"'`; аргументы строкой/списком, кавычки `"…"`/`'…'`, ≤40 шт., ≤1000 символов, без символов оболочки; `env` — объект с безопасными именами; `headers` — ≤32; `cwd`, `timeoutMs`; нельзя одновременно url и command | `validateName/validateUrl/validateCommand/validateArgs/validateEnv/validateHeaders/normalizeServerConfig/configFromForm`; тесты валидации | тесты 5 шт.; живая копия: `bad`-сервис с `&` отклонён текстом про символ оболочки |
| M9 | Секреты не в логах и не в окне | env/заголовки сервера могли попасть в stderr-хвост ошибки | `maskSecrets`: значения env и заголовков заменяются на `•••`, плюс шаблоны `Bearer …`, `api_key=…`, `token: …`; ошибка инструмента тоже проходит маскировку; в окне адрес показывается без строки запроса и якоря, аргументы не показываются | `maskSecrets`, `configSecrets`, `McpClient.redact`, `publicTarget`; тест «секреты из env и заголовков…», «сбой одного сервера…» | тест: сервер пишет секрет в stderr и выходит — ни в состоянии, ни в журнале секрета нет |
| M10 | Каждый tool проходит policy | было (source `mcp`, risk `T2`, `ownerAllowed` из `mcpAllow`) | сохранено: менеджер регистрирует те же инструменты, разрешения подключением не расширяются | `mcpTools`, `McpManager.start`; тесты «MCP вне белого списка спрашивает даже в «Полном доступе»», «вызов инструмента разрешён только по белому списку mcpAllow» | тест: вердикт `ask` в `full`/`auto`, `allow` только при имени в `mcpAllow` |
| M11 | HTTP-сервер | был клиент, статус только при старте | менеджер подключает http так же, ошибка «нет связи с сервисом», в окне адрес без query | тест «http-сервер: недоступность видна…» | тест |
| M12 | Локально проверяемый официальный сервер | не было | `tests/fixtures/mcp-echo-server.js` — свой stdio JSON-RPC 2.0 сервер без пакетов: `initialize` (capabilities, serverInfo), `tools/list` с продолжением, `tools/call` (`echo`, `add`, `slow`, `crash`, `secret`), режим сбоя через env, `ping`, ошибка неизвестного метода | файл фикстуры, тесты менеджера | 5 инструментов получены с двух страниц `tools/list`; `crash` роняет только свой сервер |

## Матрица голоса

| # | Возможность | Было | Стало в моей зоне | Доказательство | Проверка |
|---|---|---|---|---|---|
| V1 | Диктовка запускается и показывает состояние | **не работала**: в `main.js` строка `$engine.LoadGrammar(New-Object …)` — синтаксическая ошибка PowerShell; весь скрипт не выполнялся, в окно не приходило ни `listening`, ни ошибки (только «stopped» при закрытии) | исправленный скрипт вынесен в `src/voice/dictation.js` (`dictationScript()`), скобки исправлены, все события — JSON в stdout; ошибки видны | до: ручной запуск скрипта из `main.js` дал `ParserError`; после: `node`-тест + живая копия | живая копия: `dictationStart` → событие `{"type":"error","message":"Включите русский язык распознавания в Windows…"}` вместо тишины; скриншот `05-dictation-honest-error.png` |
| V2 | Честная причина: нет языка распознавания | `no_language` был, но из-за V1 не доходил | `NO_LANGUAGE_MESSAGE` с путём в настройки Windows | `describeError` | тест + живая копия |
| V3 | Честная причина: нет микрофона | код `no_audio` был, но `describeError` показывал «Распознавание не удалось» | `NO_AUDIO_MESSAGE` = «Микрофон не найден или занят другой программой» | `src/voice/dictation.js` | тест |
| V4 | Честная причина: движок не запустился | скрипт падал молча | внешний `try/catch` печатает `{"type":"error","code":"no_engine","message":…}`, `NO_ENGINE_MESSAGE` | тот же файл | тест; на этой машине нет русского распознавания — живой сценарий V1/V2 |
| V5 | Остановка речи | `ReplySpeech.stop()`, `SpeechClient.stop()`, `FishSpeech.stop()` + `AbortController` были | поведение сохранено; добавлен тест «остановка посреди фразы»: ожидание синтеза отклоняется причиной, процесс убивается | `src/voice/tts.js` | тест |
| V6 | Выбор голоса Silero | `speaker` уже передавался в синтез, но списка голосов не было | протокол сервера: запрос `{"id":"…","op":"voices"}` → `{"ok":true,"voices":[…]}`; `SpeechClient.listVoices()`; `setOptions({speaker})`; неизвестный голос — понятный отказ со списком доступных | `scripts/tts/silero_server.py` (`voices()`, проверка `speaker`), `src/voice/tts.js` | python-тест протокола без загрузки модели: `voices`, синтез выбранным, отказ на чужой |
| V7 | Громкость и скорость | `PLAY_SCRIPT` SoundPlayer, громкость 1 и скорость 1 зашиты; Fish — `Volume = 1.0` | `SpeechClient`: `volume` 0…1, `rate` 0,5…2, `setOptions/options`; при настройках по умолчанию играет прежний SoundPlayer, иначе WPF MediaPlayer (`Volume`, `SpeedRatio`, пауза по длине wav / rate); `FishSpeech`: те же пределы, в скрипт передаются `JARVIS_MP3_VOLUME`/`JARVIS_MP3_RATE`, `SpeedRatio`; временный mp3 по-прежнему удаляется | `src/voice/tts.js` (`playScriptFor`, `wavDurationMs`, `PLAY_WPF_SCRIPT`), `src/voice/fish.js` | тесты: `playScriptFor`, длительность wav, передача настроек в проигрывание, пределы, **реальная проверка синтаксиса PowerShell** для WPF-скриптов |
| V8 | Честно: нет модели голоса | `voice:test` говорил только про ключ `.env`, даже когда локальный голос не установлен | `availability()` у обоих провайдеров: `{available, provider, reason}` — «нет ключа голоса…», «нет файла синтеза Silero», «не найден Python», «локальный голос не отвечает» | `src/voice/tts.js`, `src/voice/fish.js` | тесты обеих причин |
| V9 | «Работает без сети» | локальный Silero требует загрузки модели через torch с сети при первом запросе; это уже было известно коду (`_disabledReason`, честное уведомление) | не меняю модель загрузки; добавил `availability()` и `listVoices()` с честными ошибками; в отчёте — ограничение | `main.js` (не мой) | не проверялось живым синтезом: модель Silero на машине не закэширована, скачивать её без согласия владельца нельзя |
| V10 | Выбор голоса/скорости в Настройках (интерфейс) | строк нет | в моей зоне нет `index.html`/`app.js`; контракт настроек ниже | — | не проверено; остаётся интегратору |

## Изменённые файлы (все — моя зона)

| Файл | Что изменено |
|---|---|
| `apps/jarvis-desktop/src/mcp/client.js` | добавлены `McpManager`, валидация настроек, маскировка секретов, `serverInfo/capabilities`, хвост stderr, `onClose`, `close(reason)`, маскировка ошибок в `mcpTools`; прежние экспорты сохранены |
| `apps/jarvis-desktop/renderer/connections.js` | показ статуса/причины/действий/возможностей/протокола, «Повторить» у ошибки, опрос состояния раз в 3 с, текст подсказки без «после перезапуска», поддержка старой и новой формы ответа |
| `apps/jarvis-desktop/src/validate/connections.js` | `checkRendererBridge`: методы моста в `preload.js`, id и разделы в `index.html` |
| `apps/jarvis-desktop/src/voice/dictation.js` | скрипт раннера `dictationScript()` с исправленным `LoadGrammar`, `try/catch`, коды `no_audio`/`no_engine`, тексты причин, `dictationCulture` |
| `apps/jarvis-desktop/src/voice/tts.js` | голос/громкость/скорость, `playScriptFor`, WPF-проигрыватель с `Volume`/`SpeedRatio`, `wavDurationMs`, `listVoices`, `availability`, `options/setOptions`; прежний путь SoundPlayer не изменён |
| `apps/jarvis-desktop/src/voice/fish.js` | громкость/скорость (`JARVIS_MP3_VOLUME/RATE`, `SpeedRatio`), `availability`, `options/setOptions`; ключ в заголовке и тело запроса не менялись |
| `apps/jarvis-desktop/scripts/tts/silero_server.py` | запрос `op:"voices"`, проверка `speaker`, список голосов в ответе; описание протокола |
| `apps/jarvis-desktop/tests/fixtures/mcp-echo-server.js` | новый локальный официальный stdio-сервер для проверки |
| `apps/jarvis-desktop/tests/mcp-manager.test.js` | 18 тестов менеджера, валидации, секретов, изоляции, policy |
| `apps/jarvis-desktop/tests/connections-view.test.js` | 6 тестов экрана на DOM-заглушке |
| `apps/jarvis-desktop/tests/validate-connections.test.js` | 3 теста проверки связей |
| `apps/jarvis-desktop/tests/voice-options.test.js` | 14 тестов голоса: пределы, протокол списка голосов, PowerShell-синтаксис, остановка, причины отказа |

## Контракт для интегратора (`main.js`, `preload.js`, `renderer/index.html`, `renderer/app.js`)

Ничего из этого мной не изменено. Ниже — минимум, без которого живая вертикаль MCP и исправленная диктовка не попадут в настоящее окно.

### 1. MCP: заменить стартовое подключение на живой менеджер

`main.js`, импорт (строка ~101):

```js
const { McpManager } = require('./src/mcp/client');   // вместо connectMcpServers
```

Блок «Подключения (MCP)» (сейчас `mcpView`, `mcpWrite`, четыре `ipcMain.handle`) заменить на:

```js
const mcpManager = new McpManager({
  load: () => readSettings().mcpServers || {},
  save: (servers) => saveSettings({ mcpServers: servers }),
  register: (tool) => tools.register(tool),
  unregister: (name) => {
    if (typeof tools.unregister === 'function') return tools.unregister(name);
    if (tools._tools && typeof tools._tools.delete === 'function') tools._tools.delete(name);
  },
  allowed: () => readSettings().mcpAllow,
});
ipcMain.handle('mcp:state', (event) => (fromWindow(event) ? mcpManager.state() : { servers: [] }));
ipcMain.handle('mcp:add', (event, name, target, args) => (fromWindow(event) ? mcpManager.add(name, target, args) : { ok: false }));
ipcMain.handle('mcp:toggle', (event, name, disabled) => (fromWindow(event) ? mcpManager.toggle(name, disabled) : { ok: false }));
ipcMain.handle('mcp:remove', (event, name) => (fromWindow(event) ? mcpManager.remove(name) : { ok: false }));
```

При запуске вместо `connectMcpServers(...).then(...)`:

```js
mcpManager.startAll().catch((err) => console.warn(`MCP: ${err && err.message}`));
```

При выходе вместо `for (const c of mcpClients) c.close();` — `mcpManager.close();` (переменную `mcpClients` можно убрать).

`src/tools/registry.js` (не моя зона): добавить метод, чтобы не полагаться на запасной путь:

```js
unregister(name) { return this._tools.delete(name); }
```

Каналы и формы ответа (`preload.js` уже вызывает эти каналы, менять его не нужно):

| Канал | Аргументы | Возврат | Ошибки |
|---|---|---|---|
| `mcp:state` | — | `{servers: ServerView[]}` | не бросает; вне окна `{servers: []}` |
| `mcp:add` | `name: string, target: string, args: string` (аргументы через пробел, кавычки `"…"`/`'…'` для путей с пробелом) | `{ok: true, servers, error?}` — сервис сохранён и подключён; `error` — сохранён, но не подключился; `{ok: false, error}` — не сохранён (валидация/имя занято/запись настроек) | текст в `error`, без throw |
| `mcp:toggle` | `name: string, disabled: boolean` | `{ok: true, servers, error?}`; `disabled:true` закрывает процесс и снимает инструменты, `false` — подключает | `{ok:false,error}` если сервиса нет/не сохранилось; `error` при неудачном подключении |
| `mcp:remove` | `name: string` | `{ok: true, servers}` | `{ok:false,error}` |

`ServerView`:

```ts
{
  name: string,
  transport: 'stdio' | 'http',
  target: string,            // команда без аргументов или адрес без query/hash
  disabled: boolean,
  status: 'disabled' | 'connecting' | 'connected' | 'idle' | 'error',
  error: string | null,      // причина на русском, без секретов
  protocolVersion: string | null,
  serverInfo: { name?: string, version?: string } | null,
  capabilities: { tools?: true, resources?: true, prompts?: true, logging?: true, completions?: true } | null,
  tools: Array<{ name: string, title: string, description: string }>, // title/description для владельца
  toolCount: number
}
```

Гарантии менеджера: каждый tool регистрируется как раньше (`source:'mcp'`, `risk:'T2'`, `ownerAllowed` из `mcpAllow`) и проходит `decide`; подключение не расширяет разрешения. Сбой/тайм-аут одного сервера не мешает остальным. Секреты из `env`/`headers` не попадают ни в журнал, ни в окно, ни в текст ошибки инструмента.

### 2. Диктовка: взять скрипт из `src/voice/dictation.js`

`main.js`, импорт (строка ~38):

```js
const { parseRunnerLine, describeError, createDictationRouter, dictationScript } = require('./src/voice/dictation');
```

Константу `DICTATION_SCRIPT = [ … ].join('\n');` (около строк 2378–2397) заменить на:

```js
const DICTATION_SCRIPT = dictationScript();
```

Остальное (`spawn powershell.exe … -EncodedCommand`, `parseRunnerLine`, `createDictationRouter`, `describeError`) менять не нужно: коды `no_language`/`no_audio`/`no_engine` уже превращаются в понятные сообщения, а `renderer/app.js` показывает их тостом. Без этой правки диктовка в настоящем окне остаётся сломанной (V1).

### 3. Голос: честная причина проверки и настройки выбора

`main.js`, `voice:test` — вместо проверки `provider.isInstalled()`:

```js
const provider = currentVoice();
const state = typeof provider.availability === 'function' ? provider.availability() : { available: provider.isInstalled(), reason: null };
if (!state.available) return { ok: false, error: state.reason || 'Голос не настроен' };
```

`main.js`, настройки (ключи добавить в `SETTING_KEYS` и в объект `settings:get`; имена можно свои):

- `voiceSpeaker: string | null` — голос Silero (список даёт `SpeechClient.listVoices()`);
- `voiceVolume: number` 0…1, по умолчанию 1;
- `voiceRate: number` 0,5…2, по умолчанию 1.

Применение — в `currentVoice()` перед возвратом провайдера:

```js
if (typeof provider.setOptions === 'function') {
  const s = readSettings();
  provider.setOptions({ ...(provider === localVoice ? { speaker: s.voiceSpeaker } : {}), volume: s.voiceVolume, rate: s.voiceRate });
}
```

UI (зона интерфейса): в Настройках → «Ответы» строки «Голос» (`select`, заполняется из `listVoices`, ошибка загрузки — честный текст), «Громкость» и «Скорость» (`input[type=range]` с подписями и сбросом). Значения сохранять существующим `settings:set`. Пока строк нет, настройки можно выставить через `settings.json`, модуль их применит.

`renderer/index.html`: текст `#mcpFormNote` («Изменения применятся после перезапуска…») можно обновить статически; `renderer/connections.js` уже заменяет его на «Сервис подключается сразу, перезапуск не нужен…».

## Живые проверки в настоящем окне

- Окно `9333` (сборка с прежним `main.js`, новый `renderer/connections.js`): `location.reload()` → раздел «Подключения» открывается, JS-ошибок нет, пустой список и подсказка корректны; `mcpAdd('legacy-check','npx.cmd',…)` записывает сервис (старая форма `connected:false` показывается как «подключится при запуске»), `mcpToggle`/`mcpRemove` работают; `mcpAdd` с плохим именем вернул «Название: латиница, цифры…». Сервис `legacy-check`/`probe-check` после проверки удалён, `mcpServers` снова `{}`.
- Изолированная копия (временный профиль, `NOX_DATA_DIR` в `%TEMP%`): пустой список → добавление `echo` (официальный stdio-сервер) → `status:'connected'`, `protocolVersion:'2025-06-18'`, `capabilities.tools/resources/prompts`, 5 действий; окно показывает «подключён» и «Действия (5): …». Добавление `broken` с несуществующей программой не сломало `echo` и показало причину + «Повторить». Выключение/включение убирает и возвращает `echo_*` в реестре (`debug:tools` в копии). Опрос сам обновил строку на «выключен». Удаление очищает список и инструменты. `dictationStart` дал событие с понятной причиной вместо тишины. Скриншоты — в `%TEMP%\nox-mvp-verify\`.

## Дефекты, найденные по дороге

1. **Диктовка не работала вообще** (V1, `main.js`): одна строка PowerShell ломала весь скрипт, окно не получало ни состояния, ни ошибки. Исправлено в моей зоне; нужна интеграция из п.2 контракта.
2. `no_audio` и падение движка показывались как «Распознавание не удалось» — заменены конкретными причинами.
3. `voice:test` при отсутствии локальной модели говорил про ключ `.env` — теперь `availability()` называет, чего именно нет.
4. MCP подключался только при запуске, не было ни возможностей, ни причины ошибки — добавлен менеджер и экран.
5. Ошибка запуска MCP содержала сырой `spawn … ENOENT` — теперь понятная причина; в журнал попадала дважды — исправлено.
6. Секреты из `env`/`headers` сервера могли попасть в stderr-хвост ошибки — маскируются на уровне клиента.

## Остаток и ограничения

- **`main.js`/`preload.js`/`index.html` не изменены** — вертикаль MCP и исправленная диктовка в настоящем окне `9333` появятся только после применения контракта выше (сборка окон и `registry.unregister` — зона интегратора). В изолированной копии тот же патч проверен.
- Выбор голоса/скорости в интерфейсе Настроек не сделан (зона интерфейса); модули и протокол готовы.
- Потеря микрофона **посреди** сеанса отдельно не проверена: нет русского распознавания/микрофона на машине; честные ошибки проверены для запуска (`no_audio`, `no_language`, `no_engine`).
- Настоящий синтез Silero не запускался: модель не закэширована, первая загрузка тянет её из сети — без согласия владельца не делал. Fish Audio не запускался: нет ключа (`.env` не читался).
- `scripts/check-voice.js` не запускался: он читает `.env`, а это запрещено. Косвенно его зависимости (`SpeechClient`/`FishSpeech`) покрыты тестами.
- Каталога «39 подключений» нет и не обещается: подключение — по адресу/команде, одна проверенная вертикаль (требование этапа F). `mcpAllow` (белый список) остаётся настройкой файла; UI для него не делал (вне зоны).
- `PRODUCT.md` всё ещё говорит «голос пока не делаем» — противоречие с текущим запросом владельца; на решение по матрице это не влияет (см. deep-spec, этап G).

## Тесты

- Целевые: `node --test tests/mcp-manager.test.js tests/connections-view.test.js tests/validate-connections.test.js tests/voice-options.test.js tests/mcp-mail.test.js tests/dictation.test.js tests/tts.test.js tests/fish-tts.test.js` — **90/90 pass**.
- Полный прогон `node --test` в `apps/jarvis-desktop` — **1646 pass, 0 fail** (36 suites, 12 с).
- Полный прогон `node --test` в `apps/nox-server` — **31 pass, 0 fail** (сервер не менялся).
- `node scripts/check-manifest.js` — «проблем нет».
- Существующие тесты не ослаблялись; новые тесты используют только временные файлы/профили и свой stdio-сервер, пакеты не устанавливались. Тест синтаксиса PowerShell пропускается вне Windows (`skip: !win`), тест протокола Silero — если в системе нет `python`.
