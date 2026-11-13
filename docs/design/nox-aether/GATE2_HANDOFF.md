# NOX AETHER — GATE 2 HANDOFF (Concept B: Fluid Workspace)

## 1. Статус этапа

Реализация новой оболочки **Nox Aether** (`apps/jarvis-desktop/renderer/aether/`) на базе утверждённой концепции **B (Fluid Workspace)** завершена, стабилизирована и проверена живым прогоном Electron + автотестами.

- Старая оболочка (`renderer/index.html`) полностью сохранена как рабочий путь отката (`uiShell: "legacy"` или переменная окружения `NOX_UI=legacy`), без массовых CSS-переопределений.
- Обе существующие системы визуализации сфер (`NoxOrb` и `JarvisOrb`) сохранены без изменения оригинальных движков и подключены через единую библиотеку `NoxOrbLibrary`.
- Новые зависимости не устанавливались; `git commit` / `git push` не выполнялись; файлы C5/C6/C7 (`src/link/`, `src/browser-bridge/`, `src/policy/*`) не затрагивались.

---

## 2. Архитектура и состав файлов Nox Aether

### Ядро оболочки (`apps/jarvis-desktop/renderer/aether/`)
- `index.html` — точка входа со строгим офлайн-CSP (`connect-src 'none'`, `style-src 'self'`, `script-src 'self'`), подключает темы, математику и обе системы сфер (`orb.js`, `orb-variants.js`, `orb-tune.js`, `orb-nox.js`, `orb-shutter.js`) без изменения их кода.
- `aether-boot.js` — ранняя инициализация темы, параметров Мастерской Nox (`signatureFont`, позиция и ширина колонки сферы) и флага уменьшения анимаций до первого кадра.
- `bridge.js` — обёртка над `window.jarvis` (включая корректную раздельную доставку `agent:event` и `dictation:event` в `subscribeEvents(onAgent, onDict)`).
- `store.js` — центральное состояние интерфейса:
  - 5 маршрутов навигации (`chat`, `commands`, `mcp`, `personal`, `settings`);
  - пустой и закреплённый режимы чата, флаг FLIP-перехода при первом сообщении;
  - сохранение несохранённых черновиков (`drafts` Map) в рамках текущей сессии при переключении чатов и рабочих пространств (`refreshChats(true)` + `restoreDraftFor` до уведомления подписчиков);
  - одна спокойная строка живого прогресса во время хода агента и перенос вызовов/источников в свёрнутые подробности;
  - инварианты подтверждения **R3-01** (`700` мс взвод кнопок разрешения при моментальном «Отклонить», `shownToken`, затвор вместо скрытия, обратный отсчёт автоотмены);
  - обработка ошибок модели с человекочитаемым заголовком (`humanErrorHeadline`), техническими деталями под спойлером и кнопкой «Повторить».
- `orb-library.js` — единая архитектура `NoxOrbLibrary`:
  - `NoxOrb`: `nox:nox` («Сфера Nox»), `nox:wire` («Сетка Nox»), `nox:shutter` («Затвор Nox»);
  - `JarvisOrb`: `jarvis:core` («Ядро»), `jarvis:sphere` («Точечная сфера» — отдельно от `nox:nox`), `jarvis:iris` («Диафрагма»);
  - независимые настройки, именованные пресеты (`applyPreset`), сброс активной сферы (`resetOrb` -> кнопка «Сбросить эту сферу»), единое сопоставление состояний и расширяемость через `registerOrb()`;
  - гарантированная передача конечного числового `density` в `JarvisOrb.setTune()` при `mount()` и `applySettings()` для `jarvis:core` и `jarvis:iris` (устраняет `RangeError: Invalid array length` в `orb.js:420`).
- `icons.js`, `markdown.js`, `aether.css`, `aether.js` — иконки, рендер Markdown/кода/таблиц/формул, стили и сборка оболочки.

### Компоненты (`apps/jarvis-desktop/renderer/aether/components/`)
- `topbar.js` — ровно 5 основных разделов (**Чат**, **Готовые команды**, **MCP-подключения**, **Личное пространство**, **Настройки**), переключатель истории, режим доступа и системные кнопки окна; без демонстрационных элементов прототипа; при ширине `864×520` второстепенные разделы убираются в меню **«Разделы ▾»**.
- `history-drawer.js` — пространства и чаты («Сегодня» / «Ранее»), создание, выбор, закрытие и поиск без перегрузки главного экрана.
- `chat-view.js` — лента диалога, стартовые чипсы, FLIP-переход композера из центра вниз, единая панель «Подробности» с сохранением фокуса клавиатуры на кнопке `.ae-details-toggle` при перерисовке ленты, кнопка прокрутки вниз (`#toBottom`), карточки ошибок.
- `composer.js` — авторасширяемый ввод текста, вложения (до 5 файлов), захват области экрана, выбор уровня модели/мышления (только «Быстрая» / «Умная», без утечки провайдеров), голосовой ввод и синхронизация черновиков даже при удержании фокуса в `#chatInput`.
- `approval-card.js` — карточка подтверждения R3-01 поверх композера с предпросмотром действия и таймером автоотмены.
- `orb-stage.js` — композиционная правая/левая сцена сферы, подпись `The Nox`, строка состояния `.ae-orb-status[data-state]`, перетаскиваемый разделитель ширины (`220–440px`) и индикатор уровня голоса.
- `settings-view.js` — вкладки «Мастерская Nox», «Основные и доступ», «Голос и диктовка»; живая библиотека обеих систем сфер без разрушения DOM ползунков во время перетаскивания, пресеты, сброс, настройка подписи и шрифтов.
- `commands-view.js`, `mcp-view.js`, `personal-view.js` — полноценные разделы команд/паков, MCP-подключений и «Личного пространства» (столы и виджеты с явным индикатором загрузки `data-loading` до ответа `desks:state`, память, напоминания, аккаунт, почта/календарь, журнал и утилиты буфера/загрузок).

---

## 3. Точка входа и откат на legacy UI

- В `apps/jarvis-desktop/main.js`:
  - `readSettings()` хранит `uiShell` (`'legacy'` или `'aether'`, по умолчанию `'aether'`);
  - при старте `shellMode` определяется через `NOX_UI` (`legacy` / `aether`) или `settings.uiShell`, загружая либо `renderer/index.html`, либо `renderer/aether/index.html`;
  - изменение `settings:set('uiShell', 'legacy' | 'aether')` сохраняет настройку и сразу перезагружает главное окно.
- Карта файлов в `AGENTS.md` актуальна (проверено `tests/project-map.test.js`).

---

## 4. Проверки и результаты после финальной правки

### Живая проверка Electron QA (`apps/jarvis-desktop/scripts/aether-qa.js`)
- Изолированный профиль (`NOX_DATA_DIR`), локальный mock OpenAI SSE + tool-call + HTTP 503 сервер, проверка обоих размеров **1200×720** и **864×520**.
- Результат: **14 / 14 проверок пройдено (`ok: true`, `fail: 0`)**, **`consoleErrors: 0`**, **`pageErrors: 0`**.
- Отчёт: `docs/design/nox-aether/screenshots-gate2/qa-report.json`.
- Скриншоты: `docs/design/nox-aether/screenshots-gate2/` (`01-empty-1200x720.png`, `01-empty-864x520.png`, `02-dialog-1200x720.png`, `03-long-reply-1200x720.png`, `04-tool-live-1200x720.png`, `04b-tool-details-open-1200x720.png`, `05-approval-1200x720.png`, `05-approval-864x520.png`, `06-error-1200x720.png`, `07-dictation-1200x720.png`, `08-workshop-1200x720.png`, `09-orb-jarvis-core-1200x720.png`, `10-commands-1200x720.png`, `11-mcp-1200x720.png`, `12-personal-1200x720.png`, `13-narrow-nav-864x520.png`, `14-narrow-history-864x520.png`, `15-narrow-workshop-864x520.png`).

### Дымовая проверка отката (`uiShell: "legacy"`)
- Изолированный запуск Electron с `settings.json = { "uiShell": "legacy", "motion": true }`.
- Подтверждено: главное окно открыло `apps/jarvis-desktop/renderer/index.html`, `#aeApp` отсутствует, **`consoleErrors: 0`**, **`pageErrors: 0`**.

### Автотесты (`node --test` после финальной правки)
1. **`apps/nox-server`** (`cd apps/nox-server; node --test`):
   - **54 / 54 pass, 0 fail** (`4637 мс`).
2. **`apps/jarvis-desktop` — фокусный прогон карты и Aether** (`tests/project-map.test.js`, `tests/aether-orb-library.test.js`, `tests/aether-store.test.js`, `tests/aether-ui.test.js`):
   - **14 / 14 pass, 0 fail** (`1601 мс`).
3. **`apps/jarvis-desktop` — полный прогон** (`cd apps/jarvis-desktop; node --test`):
   - **2376 тестов (41 suite): 2369 pass, 7 fail, 0 cancelled, 0 skipped** (`122526 мс`).
   - Все 7 падений относятся к заранее существовавшим тестам политики C5/MCP (файлы C5/MCP не изменялись в рамках Aether):
     - `tests/c5-provenance-regression.test.js` (строки 11, 42, 55)
     - `tests/mcp-mail.test.js` (строки 26, 344)
     - `tests/mcp-manager.test.js` (строки 157, 196)

---

## 5. Известные особенности и ограничения

- Черновики сообщений (`store.js` -> `state.drafts`) хранятся в памяти процесса в рамках текущей сессии и не сохраняются на диск между перезапусками приложения.
- Вкладку «Столы и виджеты» можно дополнять виджетами кнопкой `+ Виджет…`; до получения ответа `desks:state` область показывает непустой статус загрузки.
- Удаление старой оболочки (`renderer/index.html` и устаревших стилей) намеренно отложено до подтверждения стабильности Gate 2 владельцем.
