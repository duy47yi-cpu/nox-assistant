# Архитектура новой оболочки чата NOX AETHER (Step 3)

> Статус: архитектурная спецификация (Gate 1). Рабочий `apps/jarvis-desktop/renderer/` сейчас **не изменяется** до выбора визуального направления владельцем.

---

## 1. Почему отказ от CSS-переопределений и как выглядит новая оболочка

Сейчас `apps/jarvis-desktop/renderer/index.html` (1424 строки) грузит последовательно **13 CSS-файлов** (`styles.css` → `home.css` → `themes.css` → `hands.css` → `presence.css` → `tools-extra.css` → `nox-screen.css` → `nox-commands.css` → `nox-connections.css` → `nox-settings.css` → `nox-shell.css` → `backdrop.css` → `nox-signature.css`), а `nox-screen.js` на лету **переставляет живые DOM-узлы** (`#convo`, `#dock`, `#composer`) между `.view-dialog` и `.view-nox` (строки 588–626). Любая следующая правка поверх такого каскада ломает либо классический вид, либо соседние разделы, либо отступы на `864×520`.

**Принцип Aether:** отдельная изолированная точка входа `apps/jarvis-desktop/renderer/aether/index.html` со своим деревом компонентов и одной чистой слоистой таблицей стилей (`tokens` → `shell` → `components`), **не импортирующая** `styles.css`, `home.css`, `nox-screen.css`, `nox-shell.css`, `nox-signature.css` и не занимающаяся перестановкой DOM-узлов.

---

## 2. Безопасный откат (Rollback) на этапе внедрения

На время перехода (Gate 2) в `main.js` (`createWindow`, сейчас строка 4501 `win.loadFile(path.join(__dirname, 'renderer', 'index.html'))`) добавляется переключатель оболочки:

- Настройка `uiShell` в `settings.json` (`'aether' | 'legacy'`, по умолчанию сначала можно держать проверку через `NOX_UI=aether` или переключатель в Настройках с перезагрузкой окна).
- Прежний `renderer/index.html` и связанные старые файлы **не удаляются**, пока не пройдут все тесты (`node --test` в обеих папках + живой прогон Electron на `1200×720` и `864×520`).
- **Важно про тесты проекта:** согласно `apps/jarvis-desktop/tests/project-map.test.js`, любой новый `.js`, `.css` или `.html` файл внутри `renderer/` обязан быть внесён в карту `AGENTS.md` (будет сделано строго в Gate 2 при создании файлов).
- Вне главного окна остаются вспомогательные окна (`mini.html`, `hands.html`, `region.html`, `dictate.html`) — в Gate 2 они продолжают работать с общими данными без поломки (`localStorage` темы/акцента, IPC-канал `agent:event`).

---

## 3. Компонентная архитектура `renderer/aether/`

```text
renderer/aether/
├── index.html                  # Чистая HTML-оболочка (~120–160 строк) с CSP без изменений
├── aether.css                  # Свои токены, сетка, адаптив 1200×720 и 864×520 (без старого каскада)
├── store.js                    # Единое реактивное состояние сеанса (чаты, ход, инструменты, подтверждения, настройки)
├── bridge.js                   # Адаптер поверх window.jarvis (preload.js) + dev-stub в браузере
├── orb-library.js              # OrbRegistry + OrbSettingsStore + адаптеры NoxOrbAdapter / JarvisOrbAdapter
└── components/
    ├── Topbar.js               # Безрамочная шапка окна: drag-область, режим доступа, профиль/аккаунт, кнопки окна
    ├── Rail.js                 # Узкая навигация (Чат, Столы, Команды, Подключения, Журнал, Настройки)
    ├── HistoryDrawer.js        # Списки чатов, пространства, новый чат, поиск/закрытие (переключаемая ширина/overlay)
    ├── OrbStage.js             # Живая сфера (OrbLibrary), состояние хода, голос, быстрый доступ к выбору сферы
    ├── MessageFeed.js          # Поток диалога: пустой экран, сообщения, LaTeX-формулы (math.js), длинные ответы
    ├── ToolRunCard.js          # Сводная капсула/лента шагов инструментов: статус, verify, откат/ошибка, источники
    ├── ApprovalCard.js         # Подтверждение опасного действия со строгим контрактом токена показа
    ├── Composer.js             # Поле ввода, файлы/область экрана, микрофон/диктовка, выбор «Быстрая/Умная» и Стоп
    ├── AppearanceDrawer.js     # Настройка внешнего вида: тема (22+system), акцент, плотность, шрифт, прозрачность, FX
    ├── OrbLibrarySheet.js      # Каталог и настройка сфер обеих систем + пресеты + задел под «Мои сферы»
    └── SecondaryHost.js        # Контейнер разделов: Столы, Команды, Подключения, Журнал, Память/Настройки
```

### Главный принцип взаимодействия данных (без DOM-хаков)

```text
  preload.js (window.jarvis)
        │
        ├─ IPC invoke (send, stop, chatList/Select/New, respondApproval, markApprovalShown, ...)
        └─ IPC event stream ('agent:event', 'dictation:event')
                │
                ▼
         [ bridge.js + store.js ]  ──(единый state & pub/sub)──►  Компоненты UI (OrbStage, MessageFeed, ApprovalCard, Composer)
```

- События `agent:event` больше не размазаны между `app.js` (5740 строк) и `nox-screen.js` (`MutationObserver` на скрытых узлах). Всё приходит в `store.js`, который единым проходом обновляет:
  1. текущую фазу орба и текста статуса (`idle`, `listening`, `thinking`, `speaking`, `waiting_approval`, `error`, `success`);
  2. группировку вызовов инструментов текущего хода (`ToolRunCard` — реальный статус `running / ok / fail / unverified / cancelled` без скрытия провалов и без выдачи незавершённого текста за готовый);
  3. очередь подтверждений (`ApprovalCard`).

---

## 4. Что в старом UI будет ЗАМЕНЕНО, а что СОХРАНЕНО

### 4.1. Что ЗАМЕНЯЕТСЯ (удаляется только после прохождения тестов и финального отключения legacy)

| Что в старом UI | Где сейчас | Что приходит на замену в Aether |
|---|---|---|
| Монолитная разметка обоих экранов + перестановка DOM (`#convo`, `#dock`) | `renderer/index.html` (1424 строки), DOM-перенос в `renderer/nox-screen.js` | Изолированная разметка `renderer/aether/index.html` с чистыми точками монтирования компонентов без перемещения DOM |
| Многослойный конфликтующий CSS-каскад (13 файлов) | `styles.css`, `home.css`, `nox-screen.css`, `nox-shell.css`, `nox-signature.css`, `presence.css`, `tools-extra.css`, `hands.css` | Один модульный набор стилей `renderer/aether/aether.css` *(либо токены вынесены в общий модуль тем)* + адаптивные правила под `1200×720` и `864×520` |
| Старая логика экрана Nox и обвязка поверх классического DOM | `nox-screen.js` (791 строка), `nox-shell.js` (109 строк) | `components/Topbar.js`, `Rail.js`, `HistoryDrawer.js`, `OrbStage.js` |
| Монолитный контроллер интерфейса | `renderer/app.js` (5740 строк: смешаны чат, подтверждения, команды, настройки, виджеты) | Разделение на `store.js` + узкие компоненты (`MessageFeed.js`, `Composer.js`, `ApprovalCard.js`) |
| Разрозненные панели настройки вида и сферы | `look.js`, `accent.js`, `nox-settings.js`, разметка в `index.html` | Единые панели `AppearanceDrawer.js` и `OrbLibrarySheet.js` |

> Примечание по вторичным разделам (`Команды`, `Подключения`, `Столы`, `Настройки`): в Gate 2 возможна поэтапная миграция: чистая новая оболочка сразу заменяет **главный экран чата, сферу, композицию, подтверждения и внешний вид**, а модули логики (`cmd-steps.js`, `connections.js`, `desks.js`, `extensions.js`, `account.js`) подключаются через `SecondaryHost.js` или последовательно переводятся на чистые компоненты.

### 4.2. Что СОХРАНЯЕТСЯ полностью (модель, ядро, контракты, данные)

| Функция / контракт | Реальные файлы и символы в коде | Как подключается в Aether |
|---|---|---|
| **Весь мост с ядром Electron** | `apps/jarvis-desktop/preload.js` (`window.jarvis`: `send`, `side`, `stop`, `chatList`, `chatNew`, `chatSelect`, `chatClose`, `workspacesList/Select/Create`, `pickFiles`, `pickRegion`, `openSource`, `setMode`, `listApprovals`, `markApprovalShown`, `respondApproval`, `getSettings/setSetting`, `setModelTier`, `setThinking`, `dictation*`, `commands*`, `mcp*`, `desks*`, `memory*`, `journal*`, `account*`, `windowControl`, `onEvent`) | Вызывается напрямую через `bridge.js` без изменений в `main.js` и `preload.js` *(кроме опциональной загрузки `aether/index.html` в `createWindow`)*. В обычном браузере подхватывается `renderer/dev-stub.js` |
| **Все Existing Chats & Workspaces** | `chatList`, `chatHistory`, `chatNew`, `chatSelect`, `chatClose`, `workspaces*` | Та же модель БД/истории из `main.js`, отображается в `HistoryDrawer.js` |
| **Агент, инструменты и честный `verify`** | Поток `onEvent` в `app.js` (`text`, `task`, `hands`, `record:step`, `notice`, `tool_start`, `tool_result`, `approval_request`, `approval_closed`, `error`, `done` с разбором `cancelled`) | Полностью переносится в `store.js`; названия инструментов и формулировки переиспользуются из `shared.js` (`TOOL_TITLES`, `humanize`) |
| **Контракт безопасности подтверждений (`R3-01 / R3-02`)** | `app.js` (`APPROVAL_ARM_MS = 700`, `markApprovalShown(id)` → `token`, разделение кнопок `reject` сразу / `allow` & `session` только после токена и паузы, `approval:shown`, превью diff + `autoCancelAt` таймер автоотмены 30 с, явный переход по очереди без подмены нажатия) | `ApprovalCard.js` и резервный диалог **обязательно** сохраняют точный 2-фазный протокол (`markApprovalShown` + 700 мс пауза + привязка к `viewSeq` + запрет авто-переключения на следующий запрос под пальцем) |
| **Модель и глубина обдумывания** | `model-pick.js` (`Быстрая` / `Умная`; `Кратко` / `Обычно` / `Глубоко`; честный коэффициент расхода лимита) | Используется в `Composer.js` — владельцу показываются **только** «Быстрая» и «Умная», без внутренних имён моделей/провайдеров |
| **Голос, диктовка и микрофон** | `dictationMode` (`Слушаю` / `Только имя` / `Микрофон выкл`), `onDictationEvent`, `voiceTest`, `voiceVoices`, `dictate.html`, `mini.html` | Кнопка микрофона в `Composer.js` + передача уровня громкости в `OrbStage` (`setVoice(level)`); отдельное окно диктовки в поле не затрагивается |
| **Темы (22+system), 9 FX, своя картинка, прозрачность/радиус окна** | `theme-boot.js` (`window.JarvisTheme`, `localStorage['jarvis.theme']`, `jarvis.accent`, `jarvis.look`, расчёт контраста `>= 4.5:1`), `themes.css` (палитры тем + FX), `backdrop.js` (IndexedDB `nox-backdrop`) | `theme-boot.js` и `backdrop.js` переиспользуются целиком; цветовые токены 22 тем выносятся в чистый общий `theme-tokens.css` (или загружаются из выделенной секции без старой верстки) |
| **Обе системы сфер целиком** | `orb.js` + `orb-variants.js` + `orb-tune.js` (`JarvisOrb`), `orb-nox.js` + `orb-shutter.js` (`NoxOrb`) | Подключаются без единой правки исходного кода через `OrbLibrary` (`ORB_LIBRARY_ARCHITECTURE.md`) |
| **Рендер формул LaTeX** | `renderer/math.js` | Переиспользуется модульно в `MessageFeed.js` без внешних библиотек |

---

## 5. Проверка минимального окна `864×520` в новой архитектуре

Чтобы на малом окне (`864×520`) не повторялись переполнения текущего UI:
1. Боковая панель истории (`HistoryDrawer`) на ширине `< 1040px` автоматически переходит в компактный выдвижной слой (overlay-drawer) и не сжимает зону диалога.
2. Поле ввода (`Composer`) и шапка (`Topbar`) сохраняют минимальный бюджет высоты (`~96–112px` и `44px`), оставляя ленте сообщений минимум `52%` высоты окна даже с учётом сферы.
3. Инструменты внутри ответа собираются в одну компактную строку/раскрывающуюся капсулу (при 8+ шагах отображается аккуратный сводный счётчик и скролл внутри раскрытой панели, а не бесконечное вытягивание вверх).
4. Все панели настроек (`AppearanceDrawer`, `OrbLibrarySheet`) скроллятся внутри собственной ограниченной области и не выдавливают шапку или кнопки закрытия.
