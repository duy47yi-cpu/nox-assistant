# Популярные MIT-проекты — ассистенты ПК и близкие проекты
Дата проверки GitHub-страниц и лицензий: 2026-11-08. Звёзды — округлённое значение, видимое на GitHub на дату доступа. Источники — страницы проектов, их README, LICENSE и официальные security advisories.

## Какие популярные MIT-проекты действительно близки к ассистенту на ПК?

### Takeaway
Лучшие прямые ориентиры: OpenClaw как популярный агент для личных устройств, Hermes Agent как Electron-приложение с отдельным агентным ядром, Leon как Node/TypeScript-ассистент с режимами и управлением компьютером, Alice как небольшой Electron-проект с подтверждениями действий. У всех четырёх репозиториев указана MIT; это не подтверждает лицензии каждой зависимости, модели или ресурса.

### Cited Findings
- OpenClaw (openclaw/openclaw) — около 394,2 тыс. звёзд, лицензия MIT. README описывает открытого ассистента на собственном устройстве, приложения для Windows/macOS/iOS/Android/Linux, каналы чатов, Gateway для сессий, инструментов и событий, расширяемые инструменты, навыки и плагины. В дереве есть src/, packages/, extensions/, apps/, skills/ и security/. [Репозиторий](https://github.com/openclaw/openclaw), [README](https://github.com/openclaw/openclaw/blob/main/README.md), [правила безопасности](https://github.com/openclaw/openclaw/blob/main/SECURITY.md).
- Документация OpenClaw предупреждает, что инструменты основного сеанса могут исполняться на хост-машине; входящие сообщения надо считать недоверенными, а изоляция зависит от настройки sandbox. Полезно изучать модель доверия и границы инструментов, но не переносить выполнение без проверки изоляции. [README](https://github.com/openclaw/openclaw/blob/main/README.md), [SECURITY.md](https://github.com/openclaw/openclaw/blob/main/SECURITY.md).
- Hermes Agent (NousResearch/hermes-agent) — около 261,6 тыс. звёзд, MIT; Python-ядро и React/Electron desktop-приложение. Desktop README описывает Windows и MSIX, чат с потоковыми событиями инструментов, просмотр файлов, голос, настройки и onboarding. Команда pnpm run dev в apps/desktop поднимает Electron и Python backend. [Репозиторий](https://github.com/NousResearch/hermes-agent), [LICENSE](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), [desktop README и карта кода](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/README.md).
- Hermes desktop README указывает разделение границ: Electron main выполняет нативные операции с файлами, git и окнами; preload даёт ограниченный мост; React управляет маршрутами, панелями, состоянием и стенограммой; hermes serve предоставляет tui_gateway по JSON-RPC/WebSocket, renderer общается через apps/shared. Указаны electron/main.ts, src/store и src/lib как ключевые файлы/папки. [Карта desktop-кода](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/README.md).
- Leon (leon-ai/leon) — около 17,6 тыс. звёзд, MIT в LICENSE.md, TypeScript/Node. README описывает режимы smart/controlled/agent, навыки, контекст и память, управление компьютером и браузером с визуальной проверкой результата. Полезные области: core/context/LEON.md, core/context/ARCHITECTURE.md, tools/, skills/, apps/, bridges/ и server/src/. README отмечает, что v2 на develop — Developer Preview с неполной документацией; master — стабильная legacy-версия. [Репозиторий и README](https://github.com/leon-ai/leon), [LICENSE.md](https://github.com/leon-ai/leon/blob/develop/LICENSE.md).
- Alice (pmbstyle/Alice) — около 325 звёзд, MIT; небольшой Electron/Vue/Vite-ассистент. README перечисляет распознавание и синтез речи, VAD и прерывание речи, память/RAG, интерпретацию скриншотов, инструменты компьютера, расписание, MCP и пользовательские JSON-инструменты. Для файлов и shell описаны разрешения на один раз/сессию/постоянно с отзывом и UI управления. В дереве есть electron/, backend/, src/ и docs/. Локальный режим помечен экспериментальным. [Репозиторий и README](https://github.com/pmbstyle/Alice), [MIT LICENSE](https://github.com/pmbstyle/Alice/blob/main/LICENSE).

### Inferences
- Для Nox (Electron/Node) наиболее близок по границе renderer/main и событиям Hermes; Alice — по интерфейсу разрешений и локальным функциям; Leon — по Node/TypeScript и навыкам; OpenClaw — по Gateway, расширениям и модели доверия. Это вывод из описаний стеков и файловых карт, не подтверждённая совместимость кода.
- OpenClaw и Hermes очень крупные. Рационально изучать узкие подсистемы, а не планировать перенос крупных модулей без проверки зависимостей, платформенных требований и политики Nox.

### Gaps
- Не проверялись лицензии всех транзитивных зависимостей, моделей, голосовых ресурсов, иконок и сторонних assets; MIT в корне не означает автоматически MIT для каждого компонента.
- Репозитории не клонировались и не собирались; архитектура приведена по актуальным README и деревьям GitHub.

## Какие популярные MIT-проекты полезны как соседние доноры, но не являются полноценным помощником ПК?

### Takeaway
Популярны MIT-проекты с отдельными полезными слоями: движок агента, RAG, локальные модели и клиент чата. Их нельзя выдавать за полноценного помощника Windows. У AnythingLLM core MIT, однако официальный CONTRIBUTING говорит, что Electron wrapper не входит в core-репозиторий.

### Cited Findings
- nanobot (HKUDS/nanobot) — около 49,9 тыс. звёзд, MIT, Python. README описывает компактного персонального агента с файлами, shell, веб-поиском/чтением, MCP, cron, памятью, multi-agent delegation, API/gateway и WebUI/TUI/чат-интерфейсами; есть Windows/PowerShell-инструкции. Дерево включает nanobot/, webui/, tui/, tests/ и docs/. [Репозиторий, README и дерево](https://github.com/HKUDS/nanobot).
- AnythingLLM (Mintplex-Labs/anything-llm) — около 68 тыс. звёзд, core-репозиторий MIT; README описывает локальные LLM, документы/RAG, память, агентов, MCP и desktop-сборки Windows/macOS/Linux. CONTRIBUTING уточняет, что desktop-приложение копируется в Electron wrapper, который не входит в core project; core включает server/, frontend/ и collector/. [Репозиторий](https://github.com/Mintplex-Labs/anything-llm), [CONTRIBUTING](https://github.com/Mintplex-Labs/anything-llm/blob/master/CONTRIBUTING.md), [условия self-hosted/MIT](https://github.com/Mintplex-Labs/anything-llm/blob/master/TERMS_SELF_HOSTED.md).
- У AnythingLLM есть официальный advisory для desktop v1.11.1: XSS в streaming UI могла привести к RCE из-за небезопасной конфигурации Electron. Использовать как пример риска при анализе границы Electron, не копировать уязвимые настройки. [GitHub Security Advisory GHSA-rrmw-2j6x-4mf2](https://github.com/Mintplex-Labs/anything-llm/security/advisories/GHSA-rrmw-2j6x-4mf2).
- GPT4All (nomic-ai/gpt4all) — около 77,3 тыс. звёзд, MIT в корне; локальные LLM, Windows-установщик, LocalDocs и OpenAI-совместимый локальный API. Структура: gpt4all-chat/, gpt4all-backend/, gpt4all-bindings/ и gpt4all-training/; README описывает Qt/C++ desktop-приложение и Python API. [Репозиторий и README](https://github.com/nomic-ai/gpt4all), [LICENSE](https://github.com/nomic-ai/gpt4all/blob/main/LICENSE.txt).
- NextChat (ChatGPTNextWeb/NextChat) — около 88,9 тыс. звёзд, MIT; кроссплатформенный чат-клиент с провайдерами моделей и шаблонами инструментов, в дереве есть app/ и src-tauri/. Это клиентский UI, не автономное управление ОС. [Репозиторий и README](https://github.com/ChatGPTNextWeb/NextChat), [package.json](https://github.com/ChatGPTNextWeb/NextChat/blob/main/package.json).
- OpenHands software-agent-sdk — около 1,4 тыс. звёзд, MIT. Это SDK/сервер для программных агентов, не помощник ПК; содержит clients/typescript, openhands-agent-server, openhands-sdk, openhands-tools и openhands-workspace. Основной OpenHands позиционируется как платформа разработки ПО. [SDK](https://github.com/OpenHands/software-agent-sdk), [основной репозиторий](https://github.com/OpenHands/OpenHands).

### Inferences
- nanobot полезен как компактный пример инструментов агента, расписаний и gateway; GPT4All — для локальных моделей и поиска по документам; NextChat — только для клиентского UX. Их полезность не означает готовую совместимость с Nox.
- AnythingLLM годится как референс core/RAG, но не следует считать Electron wrapper доступным MIT-донором без отдельной проверки его исходников и лицензии.

### Gaps
- Не проверялись отдельные лицензии вложенных пакетов и изолируемость модулей.
- Звёзды округлены по верхнему уровню GitHub на дату доступа; вложенные пакеты могут иметь отдельные репозитории и условия.

## Какие популярные проекты похожи, но не проходят фильтр MIT или не являются ассистентом ПК?

### Takeaway
Совпадение по названию и популярности даёт ложные результаты: isair/jarvis содержит некоммерческое ограничение; microsoft/JARVIS имеет MIT, но не управляет пользовательским ПК; Open Interpreter, Jan, OVOS и Chatbox указаны с другими лицензиями.

### Cited Findings
- isair/jarvis — около 2,2 тыс. звёзд и функции помощника, но LICENSE называется Jarvis AI Assistant License и содержит ограничение некоммерческого использования, отдельную коммерческую лицензию и share-alike условие для производных работ. Исключить по фильтру MIT. [Репозиторий](https://github.com/isair/jarvis), [LICENSE](https://github.com/isair/jarvis/blob/main/LICENSE).
- microsoft/JARVIS — около 25,6 тыс. звёзд и MIT, но README описывает связь LLM с сообществом ML-моделей; дерево включает hugginggpt, easytool и taskbench. Это не помощник, управляющий Windows-ПК. [Репозиторий и README](https://github.com/microsoft/JARVIS).
- Open Interpreter (openinterpreter/openinterpreter) — около 68,8 тыс. звёзд; официальный LICENSE указывает Apache-2.0. [Репозиторий](https://github.com/openinterpreter/openinterpreter), [LICENSE](https://github.com/openinterpreter/openinterpreter/blob/main/LICENSE).
- Jan (janhq/jan) — популярное desktop-приложение локального ИИ, официальная документация указывает Apache 2.0. [Документация](https://docs.jan.ai/desktop), [репозиторий](https://github.com/janhq/jan).
- OpenVoiceOS ovos-core — около 300 звёзд, Apache-2.0 по репозиторию; ядро голосового ассистента. [Репозиторий и лицензия](https://github.com/OpenVoiceOS/ovos-core).
- Chatbox (chatboxai/chatbox) — около 42,3 тыс. звёзд, GitHub указывает GPL-3.0; это клиент чата, не MIT-донор. [Репозиторий](https://github.com/chatboxai/chatbox).

### Inferences
- Проверять надо корневую LICENSE и metadata текущей ветки, затем лицензии конкретных файлов, пакетов, ассетов и зависимостей. Одного совпадения по имени Jarvis или наличия desktop-приложения недостаточно.
- MIT здесь — предварительный фильтр, не юридическое заключение о переносе конкретного кода.

### Gaps
- Open WebUI не включён в лицензионные выводы: в проверке не было надёжного первичного подтверждения точного типа лицензии. Проекты с других форумов и не-GitHub площадок покрывает параллельное исследование родительской задачи.

