# VISUAL BASELINE (Gate 0, read-only, 2026-11-13, Opus)

## UI entrypoints (D:\nox-release\apps\jarvis-desktop\renderer)
- `index.html` (1424 строки) — единая разметка; подключает 12 CSS (`styles → home → themes → hands → presence → tools-extra → nox-screen → nox-commands → nox-connections → nox-settings → nox-shell → backdrop → nox-signature`) — это и есть каскад-«пластырь» из `02_REPLACE_LEGACY_UI.md`.
- `app.js` — чат, события ядра (`window.jarvis.onEvent`, строки ~3375–3470: `text`, `task`, `tool_start`, `tool_result`, `approval_request`, `error`, `done`, `hands`, `notice`, `record:step`), состояние сцены в `#stage[data-state]`.
- `nox-screen.js/.css` — текущая композиция Nox (читаемая подпись «готов/работает/ждёт вас», `#noxOrbStage`, canvas `#noxOrb`).
- `nox-shell.js`, `nox-settings.js`, `settings-nav.js`, `desks.js`, `connections.js`, `extensions.js` — оболочка, настройки, пространства (НЕ трогаем в D1).
- Минимальное окно: 864×520 (`main.js` minWidth/minHeight) — подтверждено.
- Тем в `theme-boot.js` — 24 id (`signal, dark, light, graphite, lime, paper, forest, wine, cobalt, aurora, ember, dawn, glass, liquid, liquidday, frost, gradient, gradientday, midnight, neon, starry, moonlight, sunrise, system`); спека говорит «11» — расхождение, приоритет у кода.

## Две рендер-системы шара (важно)
1. **`JarvisOrb`** (`orb.js`, `orb-variants.js`, `orb-tune.js`): виды `core` «Ядро», `iris` «Диафрагма», `sphere` «Точечная сфера». Выбор: `localStorage jarvis.orbVariant` (`store.get('orbVariant')`), настройки — `jarvis.orbTune`, API `window.JarvisOrbTune`. Canvas `#orb` 32 px в шапке + превью `[data-orb-opt]`.
2. **`NoxOrb`** (`orb-nox.js`, +`orb-shutter.js` добавляет вид): виды `nox` (1400 точек Фибоначчи + ядро, циан), `wire` (проволочная сетка, циан), `shutter` «Затвор» (9 лепестков, оранжевый — это сфера на скриншоте 01). Выбор: `localStorage noxOrb` или `#orb=wire|nox`; по умолчанию `shutter`. API: `setVariant/setState/setVoice/pulse/setAnimated/resize/destroy`; состояния `idle, attentive, listening, thinking, speaking, waiting_approval, error, success`.
- Git: `orb-nox.js` и `nox-screen.js` изменены (M), `orb-shutter.js` и `nox-signature.css` не в git (??) — **в работе у другого агента, не трогать**.

## ДВЕ ЗАЩИЩЁННЫЕ СФЕРЫ — статус идентификации: ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ ВЛАДЕЛЬЦА
Живьём в Electron/браузере не подтверждено (панель браузера скрыта, проверка политики не завершилась) → **не проверял визуально**.
Гипотеза по коду и скриншоту 02 (синие точки, «С чего начнём?»):
- «Точечная» = `NoxOrb` вид `nox` (циан, облако точек + свет ядра) — совпадает со скриншотом 02. Альтернатива: `JarvisOrb` вид `sphere` «Точечная сфера».
- «Синяя» = вероятно `NoxOrb` вид `wire` (циановая проволочная сетка). Альтернативы: `JarvisOrb` `core` «Ядро»/`iris`.
- `shutter` «Затвор» (оранж., скриншот 01) — **не** одна из двух защищённых; это текущая, не нравящаяся владельцу сфера, и она в разработке у другого агента.
Решение: в макетах Gate 1 сферы рисуются **реальными модулями из проекта** (подключение скриптов по относительному пути, без копий и правок). В Мастерской показываются все кандидаты с подписью; владелец указывает две. До ответа реализация (Gate 2) не начинается.

## Файлы других агентов (C5/C6/C7), не трогать
`src/link/`, `src/browser-bridge/`, `apps/nox-browser-*`, `apps/nox-meeting-spike`, `apps/nox-server/*`, `docs/audits/*`, `docs/reconstruction/link/`, `link-tls-spike/`, `main.js`, `preload.js`, `src/policy/*`, `src/workspaces/chat.js` и др. (53 изменённых/новых). Незакоммиченные изменения в `renderer/app.js`, `index.html`, `themes.css`, `shared.js`, `dev-stub.js`, `theme-boot.js` тоже чужие — до Gate 2 мы их только читаем.

## Контрольные снимки
Скриншоты владельца: `package/assets/01_current_nox.png`, `02_previous_nox.png`. Снимки реального окна на 1200×720/864×520 — **NOT RUN** (нужен Electron/браузер; сделает Haiku/Fable в Gate 1 для baseline).

## Что не так с нынешним Nox (по скриншоту 01 и коду)
Трёхколоночная сетка с жёсткими рамками; чат — узкая колонка с мелким моноширинным текстом; сфера заперта в правой «панели статуса» с подписью «работает / доступ спрашивать»; 12 наложенных CSS; пустой центр.
