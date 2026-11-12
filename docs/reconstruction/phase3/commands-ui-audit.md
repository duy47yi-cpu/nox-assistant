# Аудит тестов под редизайн раздела «Команды» — phase 1 (read-only)

Область: `renderer/index.html` (разметка «Команд»), `renderer/app.js` (render-функции «Команд»),
`renderer/nox-commands.css` + `renderer/nox-commands.js`. Чат, прочие разделы, backend/IPC не меняются.
Как гоняются тесты: `node --test` в `apps/jarvis-desktop` (берёт `tests/*.test.js` и `renderer/themes.test.js`).
Electron нигде не запускается; всё ниже — статические чтения файлов.

Состояние дерева на момент аудита (10.11.2026, ~17:50): `index.html` уже переписан на `nox-*`
разметку, `nox-commands.css` и `renderer/nox-commands.js` созданы, `app.js` ещё старый
(генерирует `.cmd-item`/`.cmd-steps`, ссылается на `#panelLib`/`#libGroups`). Пока аудит шёл,
в корневой `AGENTS.md` уже добавлены строки 127-128 с `` `renderer/nox-commands.css` `` и
`` `renderer/nox-commands.js` `` — статическая проверка обоих тестов `project-map` теперь чистая.
Вердикты ниже не зависят от этой промежуточности.

---

## 1. WILL BREAK (на момент проверки — пусто; единственный кандидат уже исправлен)

| Файл:строки | Тест | Что именно проверяет | Вердикт / причина |
|---|---|---|---|
| `apps/jarvis-desktop/tests/project-map.test.js:17-22` | «каждый файл ядра и интерфейса есть на карте» | Обходит `apps/jarvis-desktop/src` и `renderer`, файлы `/\.(js\|html\|css)$/` (кроме `*.test.js` и `*.gen.*`), путь в posix-виде от `apps/jarvis-desktop`, и требует, чтобы строка `` `<путь>` `` (в бэктиках) встречалась в **корневом** `AGENTS.md`: `map.includes('`'+f+'`')`. | Был **WILL BREAK** (не было `` `renderer/nox-commands.css` `` и `` `renderer/nox-commands.js` `` — 2 файла из 182). Сейчас **зелёный**: строки добавлены в `AGENTS.md` (127-128). Условие на будущее: новый файл в `src/`/`renderer/` — сразу строка в карте. |
| `apps/jarvis-desktop/tests/project-map.test.js:24-28` | «пути на карте существуют» | Любой бэктик-токен, начинающийся с `apps|docs|src|renderer|tests|scripts|skills|workspace|...` и содержащий `/`, должен существовать от корня репозитория или от `apps/jarvis-desktop`; плюс `paths.length > 50` (сейчас 347). | **SAFE**. Станет **WILL BREAK**, если в карту добавить путь до создания файла или оставить в карте путь удалённого/переименованного файла. Порядок: сначала файл — потом строка в карте. |

Других падающих сейчас тестов из-за «Команд» нет: ни один тест не проверяет подписи/классы/порядок
элементов «Команд» (см. §3).

---

## 2. RISK (сломается только при выходе за согласованный объём или при массовом переформатировании)

| Файл:строки | Зависимость | Когда станет WILL BREAK |
|---|---|---|
| `apps/jarvis-desktop/tests/orb-styles.test.js:60-68` | `index.html`: порядок скриптов `orb-variants.js < orb-tune.js < app.js` (63-64); точная разметка `data-orb-opt="<v>"...><canvas></canvas><Подпись><` (61-62); в `app.js` дословно `function defaultOrb() { return 'core'; }` (65) и `raw === 'reactor' ? 'core' : raw` (66); `html+variants+tune` не содержит «Реактор» (67). | Изменить порядок `<script>` в `index.html`; прогнать prettier/переформатировать `app.js`; тронуть блок орба. Новые `<script src="nox-commands.js" ...>` безопасны, пока стоят после `app.js`/до/после — порядок важен только для `orb-tune.js < app.js`. |
| `apps/jarvis-desktop/tests/orb-life.test.js:160-163` | `app.js` режется по точным маркерам `'  function initChat() {'` и `'\n  // Готовые фразы'`, затем исполняется в vm как `initChat()`. | Переместить/переименовать `initChat`, убрать/переиндентировать комментарий `// Готовые фразы`, вынести чат в отдельный файл, массово переформатировать `app.js`. Раздел «Команды» трогать можно — маркеры чата далеко (сейчас 2753/2811). |
| `apps/jarvis-desktop/renderer/themes.test.js:34,39,42,44,94,102-106` | Читает `index.html`: кнопки тем одной строкой `data-theme-opt="<id>" ... </span><Имя></button>` (39,42), `<div class="theme-fx" aria-hidden="true"></div>` дословно (44), у каждой темы есть кнопка (106), нет кнопок archive/tablet/acrylic (94). | Массовое переформатирование `index.html` (перенос строк внутри кнопок тем) или переписывание блока «Настройки → Вид». Редизайн «Команд» к этому блоку не относится — не трогать его строки. |
| `apps/jarvis-desktop/tests/command-editor.test.js:9-12` | `require('../renderer/cmd-steps')` и 9 имен экспорта: `moveStep, describeSteps, stepWarning, warningsForSteps, foldersOf, groupCommands, diffLines, previewCountsLine, canApplyImport`. | Удалить/переименовать `renderer/cmd-steps.js`, убрать любой из экспортов или перенести помощники в `nox-commands.js`. **Оставить `cmd-steps.js` и его `module.exports` как есть** — именно из него сейчас живут чистые помощники редактора. |
| `apps/jarvis-desktop/tests/validate-connections.test.js:25-27` | Гоняет `checkRendererBridge(APP)`/`checkConnections({appDir:APP})` по **настоящим** файлам; `src/validate/connections.js:106-114` требует, чтобы в `renderer/index.html` были все `getElementById('...')` и `[data-view="..."]`, которые использует `renderer/connections.js` (сейчас: `mcpList`, `mcpEmpty`, `mcpForm`, `mcpFormNote`, `data-view="mcp"`). | Переписывая `index.html` целиком, удалить/переименовать эти id или `data-view="mcp"`. Раздел «Подключения» не трогаем — проверка останется зелёной. |
| `apps/jarvis-desktop/tests/computer-use.test.js:288-297` | `index.html`: дословный `<div class="hands-banner" id="handsBanner" hidden>…</div></div>`, ссылка `href="hands.css"`; `app.js`: `case 'hands':[\s\S]{0,200}banner.hidden = ev.active !== true`. | Тронуть баннер рук/ссылку `hands.css` или ветку `case 'hands'` в `app.js`. Вне «Команд» — не трогать. |
| `apps/jarvis-desktop/tests/home-taste.test.js:9-11,32-45,85-98` | `index.html`: нет `scene-chips`, есть `<ol class="scene-list">` ровно с 3 `data-scene-draft`, индексы `01/02/03`, `<p class="scene-name">Джарвис</p>`; `presence.css`: правила `.scene-list button`, `.scene-name`, `body[data-view="dialog"] .main::before`, `.rail`, `.stage`, reduced-motion. | Тронуть главную/чат/рейку или `presence.css`. К «Командам» не относится; сам `body[data-view="dialog"]` — это CSS в `presence.css`, не разметка. |
| `apps/jarvis-desktop/tests/keep-awake.test.js:97-102`, `overlay-listen.test.js:26,37-38,47-49`, `memory-learn.test.js:140-141`, `second-hands.test.js:379-380,392-397`, `tiers.test.js:59-63` | Простые `id="…"`/`data-setting="…"` и отдельные строки в `app.js` (`setKeepAwake`, `'alwaysListen'`, `Напомнить: `, `remindersList`, `side.reply`, `setWindowBackground`, `'#00000000'`, `winAlpha`, `winRadius`, `keepAwake`); `tiers` запрещает `/deepseek|minimax|deepinfra|digitalocean/i` в `index.html`/`app.js` и списке файлов. | Станут RISK только при массовом переписывании `index.html`/`app.js` целиком. Точечные правки секции «Команды» их не задевают. `nox-commands.js` в список `tiers` не входит — названия моделей там тестом не ловятся (не полагаться на это). |

---

## 3. SAFE (ничего не проверяют из «Команд»)

| Файл | Что читает/проверяет | Почему SAFE |
|---|---|---|
| `tests/commands.test.js` | `src/commands/store`, `src/commands/runner`, `src/journal`, `src/policy` | Backend, renderer не читает; подписи/классы/порядок DOM не проверяет. |
| `tests/packs.test.js` | `src/commands/packs` (`describePacks`), `store`, политика | Только данные паков; карточки `renderPacks` в `app.js` не читает. |
| `tests/workspace-commands.test.js` | `src/workspaces/*`, `CommandStore` | Backend пространств, UI не читает. |
| `tests/command-tools.test.js`, `tests/autonomy.test.js`, `tests/sample-protocols.test.js`, `tests/builder.test.js`, `tests/match.test.js`, `tests/quick-actions.test.js` | `src/commands/*`, `src/tools/*`, `src/shortcuts/offline` | Чистые данные/инструменты; ни `index.html`, ни `app.js`, ни CSS не читают. |
| `tests/command-editor.test.js` (кроме require, см. RISK) | `src/commands/store` + `renderer/cmd-steps` | Проверяет данные и чистые функции; подписи кнопок («Проверить» и т.п.) здесь — текст имени теста/инъекция, а не разметка. |
| `tests/appearance.test.js` | `theme-boot.js`, `themes.css` | Команды не участвуют; новые CSS/разметка на контраст тем не влияют. |
| `tests/look.test.js` | `look.js`, `theme-boot.js`, `presence.css` (`.app`, `--win-bg`, `overflow: clip`, `border-radius`, `html[data-win-alpha]`) | `presence.css` в объём не входит; правки `nox-commands.css` не читаются. |
| `tests/connections-view.test.js` | `renderer/connections.js` + фейковый DOM (`[data-view="mcp"]` — в фейке, не в index.html) | Настоящие файлы «Команд» не читает. |
| `tests/mcp-catalog.test.js:209-231` | `renderer/connections.js`, блок между `// ── начало списка популярных` и `// ── конец списка популярных` | Только «Подключения»; не трогаем. |
| `tests/humanize.test.js`, `tests/verify-status.test.js` | `renderer/shared.js` в vm | Не «Команды». |
| `tests/orb-a11y.test.js` | `renderer/orb.js` | `app.js` только в комментарии (стр. 84), файл не читается. |
| `tests/home-taste.test.js`, `tests/keep-awake.test.js`, `tests/overlay-listen.test.js`, `tests/memory-learn.test.js`, `tests/computer-use.test.js`, `tests/second-hands.test.js`, `tests/tiers.test.js`, `tests/orb-styles.test.js`, `tests/orb-life.test.js` | См. RISK: точные строки вне секции «Команды» | Точечный редизайн «Команд» их не задевает. |
| `tests/desktop-lock.test.js:198` | Строка `file:///.../renderer/index.html` в вызове | Только путь, содержимое не читает. |

**Чего в тестах нет вообще** (значит, свободно меняется):
подписи кнопок «Записать», «Импорт», «Экспорт», «Новая», «Проверить», «Запустить», «Сохранить»;
вкладки «Мои ·», «Библиотека ·»; классы `.cmd-item`, `.cmd-name`, `.cmd-run`, `.cmd-toggle`, `.cmd-steps`,
`.editor*`, `.step`, `.arg`, `.chip`, `.inline-add`, `.pack-card`, `.lib-item`; порядок элементов;
`data-view="commands"` и вообще список значений `body[data-view]`; новые id `#cmdActionDialog`,
`#cmdSideReady`, `#cmdLoading`, `#cmdNoResults`, `#cmdPacks`/`#cmdPacksList`, `#cmdSearchWrap`/`#libSearchWrap`.
Единственная проверка id в `index.html` — `validate-connections` и только для id, которые использует
`renderer/connections.js` (§2).

---

## 4. project-map.test.js: правило AGENTS.md (точно)

Тест читает **корневой** `D:\nox-release\AGENTS.md` (в коде: `ROOT = APP/../..`), не `apps/jarvis-desktop/AGENTS.md` (его нет).

Тест 1 (`tests/project-map.test.js:17-22`):
```js
const files = [...walk(APP/src), ...walk(APP/renderer)]
  .filter((f) => /\.(js|html|css)$/.test(f) && !/\.test\.js$/.test(f) && !/\.gen\./.test(f))
  .map((f) => path.relative(APP, f).split(path.sep).join('/'));
assert.deepEqual(files.filter((f) => !map.includes(`\`${f}\``)), []);
```
Т.е. каждый файл `src/**` и `renderer/**` с расширением `.js/.html/.css` (кроме тестов и `.gen.`)
обязан встретиться в `AGENTS.md` **дословно в бэктиках** как путь от `apps/jarvis-desktop`
с прямыми слэшами. Где именно (таблица/раздел) — не важно. `renderer/themes.test.js` под
исключение `*.test.js` попадает, его на карте не требуют.

Тест 2 (`tests/project-map.test.js:24-28`):
```js
const paths = [...map.matchAll(/`((?:apps|docs|src|renderer|tests|scripts|skills|workspace|core|schemas|corpus|eval|review|persona|tools|bus|orch|NIGHT|stt-spike|studio-spike|dist|\.megapowers)[\w./-]*)`/g)].map((m) => m[1]).filter((p) => p.includes('/'));
assert.ok(paths.length > 50);
const missing = paths.filter((p) => ![ROOT, APP].some((base) => fs.existsSync(path.join(base, p))));
assert.deepEqual(missing, []);
```
Т.е. любой бэктик-токен, начинающийся с `renderer/` и т.п. и содержащий `/`, должен существовать
(от корня или от папки приложения). Сейчас таких токенов 347, битых нет.

**Что сделать:** строки с точными путями
`` `renderer/nox-commands.css` `` и `` `renderer/nox-commands.js` `` уже добавлены в таблицу `renderer/`
(сейчас строки 127-128, рядом с `renderer/nox-screen.css`/`renderer/nox-screen.js`). Оба файла
существуют — оба теста проходят по статической проверке (182/182 файла на карте, 347 путей, битых 0).
Пожелание (тестом не проверяется, но карта не должна врать): строка 59 (`renderPacks`/`packCard`
в `renderer/app.js`, `.pack-*` в `renderer/tools-extra.css`) и строка 113 (описание `app.js`)
после переноса логики в `nox-commands.js` станут неточными — их стоит обновить.
Если в карту попадёт бэктик-путь несуществующего файла (например, упомянуть новый
`renderer/nox-commands-*.js` до его создания) — упадёт тест 2.

---

## 5. Чек-лист перед прогоном

1. ~~Добавить в `AGENTS.md` две строки из §4~~ — уже сделано (строки 127-128). При добавлении новых файлов в `renderer/` — строка в карту сразу.
2. Не удалять и не менять `module.exports` в `renderer/cmd-steps.js`.
3. Не менять порядок `<script>`: `orb-variants.js` → `orb-tune.js` → … → `app.js` (и `orb-tune.js` строго до `app.js`).
4. Не переформатировать в `index.html` блоки тем/орба/баннера рук/настроек и не менять id `mcpList`, `mcpEmpty`, `mcpForm`, `mcpFormNote`, `data-view="mcp"`.
5. Не трогать в `app.js` `initChat`/`// Готовые фразы`, `defaultOrb`/`reactor`, `case 'hands'`, `side.reply`, `setWindowBackground`/`winAlpha`/`winRadius`.
6. Когда попросят — прогон: `node --test tests/project-map.test.js` (без Electron), затем полный `node --test` в `apps/jarvis-desktop`.
