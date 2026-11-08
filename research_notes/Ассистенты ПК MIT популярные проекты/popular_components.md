# Популярные MIT компоненты для ассистента ПК

Проверено 8 ноября 2026 года. Звёзды — приблизительный снимок GitHub на дату просмотра; счётчики быстро меняются. Под «MIT-донором» ниже понимается репозиторий, который GitHub помечает MIT и где доступна соответствующая лицензия. Это первичный фильтр, не аудит всех файлов, подмодулей, зависимостей, бинарников и моделей.

## Какие популярные проекты полезны для управления рабочим столом и Windows

### Takeaway

Лучшее сочетание популярности и прямой пользы для Nox — `microsoft/UFO` (Windows UI агент), `iFurySt/open-computer-use` (MCP-сервис управления компьютером) и `microsoft/PowerToys` (проверенный Windows UX для палитры команд и расширений). Для низкоуровневых ввода и снимков экрана есть `robotjs`, но Nox уже имеет более семантический слой наблюдения, поэтому его следует рассматривать как точечный источник идей.

### Cited Findings

- **Microsoft UFO — около 10,2 тыс. звёзд, MIT.** В текущем репозитории есть UFO³, UFO² и изначальный UFO; документация описывает UFO² как агент для Windows с глубокой интеграцией ОС и гибридом GUI + API действий. Сопоставлять стоит [`ufo/`](https://github.com/microsoft/UFO/tree/main/ufo), [`aip/`](https://github.com/microsoft/UFO/tree/main/aip), [`tests/`](https://github.com/microsoft/UFO/tree/main/tests) и описание стратегии объединения Windows UI Automation с OmniParser в [`app_agent/strategy.md`](https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/app_agent/strategy.md). Репозиторий также помечает MIT и содержит `DISCLAIMER.md`; README просит ознакомиться с ним. ([репозиторий, звёзды и MIT](https://github.com/microsoft/UFO), [README о UFO² и UFO³](https://github.com/microsoft/UFO/blob/main/README.md), [гибридная стратегия UIA и OCR/vision](https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/app_agent/strategy.md))
- **iFurySt/open-computer-use — около 2,9 тыс. звёзд, MIT.** Это кроссплатформенный MCP-сервис, который заявляет поддержку Windows, macOS и Linux; README говорит, что Windows-рантайм использует UI Automation и запасные Win32-события. В Nox его стоит оценить прежде всего как внешний сервер для уже имеющегося MCP-клиента и как пример того, как публиковать desktop-возможности через MCP; изучать можно [`packages/`](https://github.com/iFurySt/open-computer-use/tree/main/packages), [`plugins/open-computer-use/`](https://github.com/iFurySt/open-computer-use/tree/main/plugins/open-computer-use), [`skills/open-computer-use/`](https://github.com/iFurySt/open-computer-use/tree/main/skills/open-computer-use), README и `SECURITY.md`. ([репозиторий, счётчик, MIT и дерево](https://github.com/iFurySt/open-computer-use), [README и подключение MCP](https://github.com/iFurySt/open-computer-use/blob/main/README.md), [документация о Windows UIA/Win32 и границах среды](https://github.com/iFurySt/open-computer-use/blob/main/skills/open-computer-use/references/usage.md))
- **Microsoft PowerToys — около 138,6 тыс. звёзд, MIT.** Это не ассистент с моделью, зато большой Windows-проект с палитрой команд, горячими клавишами и множеством системных утилит. Самый уместный участок для Nox — [`src/modules/cmdpal/`](https://github.com/microsoft/PowerToys/tree/main/src/modules/cmdpal): README указывает `Win+Alt+Space`, отдельные расширения, toolkit и примеры. API пока помечен как preview с возможными изменениями до v1. Для Nox это материал для изучения архитектуры быстрого запуска команд, поиска и расширений, но реализация написана под Windows/WinUI, а не Electron. ([репозиторий, звёзды и MIT](https://github.com/microsoft/PowerToys), [README Command Palette и SDK](https://github.com/microsoft/PowerToys/blob/main/src/modules/cmdpal/README.md), [документ об устройстве палитры](https://github.com/microsoft/PowerToys/blob/main/src/modules/cmdpal/doc/command-pal-anatomy/command-palette-anatomy.md))
- **RobotJS — около 12,8 тыс. звёзд, MIT.** Node.js-библиотека даёт управление мышью и клавиатурой, чтение пикселей и захват экрана; README поддерживает Windows и описывает prebuild для x64/arm64, при этом неподдержанные цели требуют исходной сборки. Полезно просмотреть `src/`, `test/`, `index.js` и Electron-инструкцию как компактный низкоуровневый пример. Она работает координатами и не заменяет дерево UIA/проверку эффекта Nox; нативный addon и сборочная цепочка тоже добавляют эксплуатационный риск. ([репозиторий, MIT и звёзды](https://github.com/octalmage/robotjs), [README о Windows, prebuild и API](https://github.com/octalmage/robotjs/blob/master/README.md), [текущие релизы](https://github.com/octalmage/robotjs/releases))
- **OmniParser — не MIT-репозиторий.** Несмотря на 25,6 тыс. звёзд и пользу для распознавания экранов, GitHub помечает сам репозиторий как CC-BY-4.0; поэтому его код не проходит заданный фильтр доноров. Отдельные модели `icon_detect_v3` и `icon_caption` в README обозначены MIT, тогда как старый `icon_detect` основан на Ultralytics и сохраняет AGPL-3.0; это отдельные условия модели, не лицензия кода репозитория. Если Nox когда-нибудь будет исследовать только веса MIT-варианта, надо отдельно зафиксировать версии и проверять зависимость/веса; код из репозитория не включать в MIT-список. ([репозиторий, звёзды и CC-BY-4.0](https://github.com/microsoft/OmniParser), [README о моделях и лицензиях](https://github.com/microsoft/OmniParser/blob/master/README.md), [карточка моделей с разными лицензиями по папкам](https://huggingface.co/microsoft/OmniParser-v2.0))

### Inferences

- **Первым стоит читать `open-computer-use`, затем UFO.** Первый ближе к стеку Nox по MCP и уже заявляет Windows UIA, второй глубже раскрывает работу Windows-агента и выбор между UI/API. Проверка должна сравнить их подходы с `src/mcp/client.js`, `src/tools/observe.js`, `src/perception/scene.js`, `src/agent/effects.js` и политикой подтверждений Nox, а не заменять эти уровни без причин.
- RobotJS полезен только если Nox не хватает какого-либо низкоуровневого ввода или захвата экрана. Его координатные команды менее устойчивы к изменению окна, чем действия по UI-элементам.
- Большие звёзды показывают интерес сообщества, но не доказывают безопасность действий или применимость проекта к Electron.

### Gaps

- В этой проверке не выполнялись сборка или испытания библиотек; совместимость с текущей версией Electron/Node Nox не подтверждена.
- Для полного решения о включении понадобятся закреплённые версии исходников и проверка конкретных сторонних зависимостей, разрешений и сборочных артефактов.

## Какие популярные проекты дают идеи для локальных моделей и голоса

### Takeaway

Для локального AI-рантайма самый прямой Node-ориентир — Ollama и официальный `ollama-js`; для распознавания речи — `whisper.cpp`; для речи-озвучки можно изучить прежний MIT-код Piper, учитывая, что он архивирован и активная ветка переехала на GPL. Rhasspy полезен архитектурой взаимозаменяемых voice-сервисов, но проект архивирован.

### Cited Findings

- **Ollama — около 186 тыс. звёзд, MIT; официальный `ollama-js` — около 4,4 тыс. звёзд, MIT.** Ollama предоставляет API локального сервера, а JavaScript-клиент (`src/`, `examples/`, `test/`) умеет чат, изображения и потоковые ответы через async iterator. Это сильная точка сравнения для локального провайдера в `src/brain/providers.js` или `src/brain/tiers.js`; не нужно копировать рантайм модели. Лицензия самого приложения не устанавливает лицензию каждого скачиваемого веса. ([Ollama, GitHub и MIT](https://github.com/ollama/ollama), [ollama-js, звёзды, MIT, файлы и streaming API](https://github.com/ollama/ollama-js), [официальное описание локального API](https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx))
- **whisper.cpp — около 54,9 тыс. звёзд, MIT.** C/C++ реализация Whisper перечисляет CPU-only режим, поддержку VAD, HTTP-сервер, потоковый пример микрофона `examples/stream/`, голосовой пример `examples/command/` и JavaScript binding в `bindings/javascript/`. Binding назван в README rudimentary; для Electron/Node разумно сравнить запуск CLI/HTTP-сервера с встраиванием WebAssembly, а не предполагать, что binding готов для полноценного стриминга. ([репозиторий, звёзды и MIT](https://github.com/ggml-org/whisper.cpp), [README с примерами, VAD и платформами](https://github.com/ggml-org/whisper.cpp#readme), [ограничения JavaScript binding](https://github.com/ggml-org/whisper.cpp/tree/master/bindings/javascript), [LICENSE](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE))
- **Piper (`rhasspy/piper`) — около 11,3 тыс. звёзд, MIT, но архивирован 6 октября 2025 года.** Это код быстрой локальной нейронной озвучки с каталогами `src/`, `lib/`, `etc/`, сборочными файлами и описанием голосов; upstream прямо сообщает о переносе разработки в `OHF-Voice/piper1-gpl`. Значит, старый репозиторий может быть MIT-источником только для его соответствующего состояния; новый активный upstream не входит в MIT-список. Отдельно проверять лицензии voice-моделей и phonemizer. ([архивированный репозиторий, 11,3 тыс. звёзд и MIT](https://github.com/rhasspy/piper), [README и перенос разработки](https://github.com/rhasspy/piper#readme), [список голосов и их условия](https://github.com/rhasspy/piper/blob/master/VOICES.md), [новый upstream](https://github.com/OHF-Voice/piper1-gpl))
- **Rhasspy v2 — около 2,8 тыс. звёзд, MIT, но архивирован 6 октября 2025 года.** Проект описывает полностью offline voice assistant и набор служб для разных языков. Лицензионная заметка прямо просит проверять лицензии вспомогательных программ; это полезно для идеи отдельных заменяемых стадий микрофон → wake/VAD → ASR → intent → TTS, а не готовая Electron-зависимость. ([репозиторий, архив и MIT](https://github.com/rhasspy/rhasspy), [документация о MIT и лицензиях внешних инструментов](https://github.com/rhasspy/rhasspy/blob/master/docs/license.md), [Rhasspy pipeline и поддерживаемые компоненты](https://github.com/rhasspy/rhasspy/blob/master/README.md))
- **Whisper models and Piper voices не следует автоматически считать частью MIT-кода.** В самом проекте Piper есть отдельная таблица условий голосов; Ollama предоставляет веса, для которых нужно смотреть лицензию конкретной модели. Для любого дистрибутива Nox это отдельная запись в provenance/notice, даже если исходный репозиторий runtime помечен MIT. ([Piper voice licensing](https://github.com/rhasspy/piper/blob/master/VOICES.md), [Ollama API показывает лицензию конкретной модели в model metadata](https://github.com/ollama/ollama/blob/main/docs/api/openapi.yaml))

### Inferences

- Ollama с официальным JS-клиентом — самый короткий путь для эксперимента с локальным провайдером, потому что это привычный JavaScript интерфейс с потоковой выдачей, а существующая архитектура Nox уже отделяет провайдеры от UI.
- Whisper.cpp можно изучать ради производительной локальной диктовки и VAD; для Nox лучше сравнить модели и задержки с существующей схемой `src/voice/dictation.js`, прежде чем вводить вторую параллельную инфраструктуру.
- Старый Piper и Rhasspy стоит рассматривать как референсные исходники, а не как живые зависимости: архивный статус увеличивает стоимость сопровождения и проверки безопасности.

### Gaps

- Star count не говорит о производительности на пользовательских машинах Nox; конкретные замеры русской речи и поддерживаемых аппаратных ускорителей в этой проверке не проводились.
- Для Piper не сверялись каждый voice bundle и все цепочки сборки; нужен отдельный аудит конкретной модели и внешних библиотек до распространения.

## Какие популярные проекты не проходят MIT-фильтр и что читать первым

### Takeaway

Популярность не равна лицензии. В частности, текущий Open Interpreter под Apache-2.0 не соответствует прежнему требованию пользователя «MIT»; OmniParser как репозиторий имеет CC-BY-4.0, хотя часть конкретных моделей помечена MIT. Эти проекты годятся для изучения публичных идей, но не для включения кода в MIT-донорский список.

### Cited Findings

- **Open Interpreter — около 68,8 тыс. звёзд, текущая ветка помечена Apache-2.0.** GitHub-страница описывает его как coding agent; по текущей лицензии он исключается из MIT-доноров, даже если ранние обсуждения или более старые версии могли называть проект MIT. ([текущий репозиторий, 68,8 тыс. звёзд и Apache-2.0](https://github.com/OpenInterpreter/open-interpreter))
- **OmniParser — CC-BY-4.0 на уровне GitHub-репозитория, не MIT.** Разрешение на MIT для отдельных model folders не переносит MIT на source tree и не делает весь проект MIT. ([GitHub metadata](https://github.com/microsoft/OmniParser), [модельные лицензии](https://huggingface.co/microsoft/OmniParser-v2.0))
- **PowerToys допускает сторонние зависимости, описанные отдельно.** Его `NOTICE.md` содержит уведомления о встроенных расширениях и используемых проектах; при переносе конкретного куска нужно проверить не только верхнюю лицензию, но также путь, файл уведомлений и включённую зависимость. ([NOTICE.md](https://github.com/microsoft/PowerToys/blob/main/NOTICE.md), [правила разработки о проверке лицензий и безопасности пакетов](https://github.com/microsoft/PowerToys/blob/main/doc/devdocs/development/guidelines.md))
- Сохранение уведомления и авторских прав обязательно для MIT-кода; MIT не является доказательством качества, безопасности или отсутствия отдельных лицензий у моделей, шрифтов, голосов и зависимостей. ([LICENSE RobotJS как пример MIT-текста](https://github.com/octalmage/robotjs/blob/master/LICENSE.md), [Ollama model API metadata](https://github.com/ollama/ollama/blob/main/docs/api/openapi.yaml))

### Inferences

- Рекомендуемый порядок изучения по близости к Nox: (1) `iFurySt/open-computer-use` — MCP и Windows UIA, (2) `microsoft/UFO` — выбор и проверка действий, (3) `ollama-js` — Node streaming/provider patterns, (4) `whisper.cpp` — offline ASR, (5) `PowerToys` CmdPal — поиск команд и extension UX, (6) Piper/Rhasspy — голосовой пайплайн и архивные решения, (7) RobotJS — raw input/capture.
- Для каждого фактического заимствования полезно записать commit/tag, путь, лицензии файла и связанных библиотек, модификации и сохранённые уведомления; отдельное подключение сервера через MCP может быть дешевле сопровождать, чем перенос его кода.

### Gaps

- Этот поиск не является анализом истории лицензий по каждому старому тегу. Если Nox захочет использовать старую версию репозитория, нужно открыть конкретный commit/tag и сверить именно его LICENSE.
- В списке не проводился аудит моделей/голосов и всех транзитивных npm/pip/nuget зависимостей, а также не запускались security scanners.
