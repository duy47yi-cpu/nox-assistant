# Наводки со скриншотов: проверка доноров для Nox

Дата проверки: 8 ноября 2026 года. Звёзды — меняющийся снимок GitHub на эту дату. Я сверил все девять проектов с [донор/КАТАЛОГ.md](../../донор/КАТАЛОГ.md): ни один там не указан, все являются новыми наводками. Для строгого отбора донора требуется MIT на конкретном используемом коде; общей метки репозитория недостаточно. Проверены публичные страницы и лицензии, код не скачивался.

## Новые MIT-доноры среди наводок со скриншотов

### Cua / Cua Driver

**Takeaway.** Самый подходящий проект для сравнения с управлением Windows в Nox. Рассматривать только явно MIT-лицензированные Driver/SDK-компоненты.

**Cited Findings.** [trycua/cua](https://github.com/trycua/cua) — около 32,0 тыс. звёзд. В [LICENSING.md](https://github.com/trycua/cua/blob/main/LICENSING.md) Cua Driver, CLI и SDK указаны под MIT; приложение и части Cua Spaces — FSL-1.1-MIT; расширение cua-perception — AGPL-3.0-only. [Windows Driver](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/WINDOWS.md) использует Windows UI Automation. У Driver есть MCP stdio-интерфейс и элементы, привязанные к снимку экрана ([README Driver](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md)). TypeScript SDK содержит Node и Electron host adapters ([каталог пакета](https://github.com/trycua/cua/tree/main/libs/cua-driver/typescript); [заметки разработки](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/development.mdx)).

**Inferences.** Сравнить UIA-действия, получение сцены и проверку результата с Nox: src/perception/scene.js, src/screen/agent.js, src/agent/effects.js, src/control/desktop-lock.js. Node/Electron адаптеры подходят архитектуре Nox лучше Python-обвязок.

**Gaps.** Не скачаны исходники, не зафиксирован SHA и не проверены зависимости. До использования проверить лицензию в закреплённой ревизии каждого пакета; не переносить Spaces, cua-perception, OmniParser и иные отдельно лицензированные части. Нативный Rust компонент требует проверки упаковки Electron и работы в интерактивной Windows-сессии.

### Stagehand

**Takeaway.** Сильный MIT-кандидат для отдельных браузерных приёмов на TypeScript/Node.

**Cited Findings.** [browserbase/stagehand](https://github.com/browserbase/stagehand) — около 26,0 тыс. звёзд; корневая [LICENSE](https://github.com/browserbase/stagehand/blob/main/LICENSE) — MIT. В [README](https://github.com/browserbase/stagehand/blob/main/README.md) описаны observe, act и extract, локальный запуск Chrome через профиль пользователя и TypeScript SDK. Для облачного Browserbase MCP нужен отдельный API-ключ.

**Inferences.** Изучить способы наблюдения за страницей, выбора действия и извлечения проверяемых структурированных данных; сравнить с существующим Browser Bridge Nox и src/agent/effects.js. Локальный браузерный путь ближе к Nox, чем облачный сервис.

**Gaps.** Точное дерево пакетов и лицензии каждого подпакета не были сверены на commit. До заимствования проверить LICENSE/NOTICE целевого пакета и зависимости, а также поведение с пользовательским профилем и данными, отправляемыми модели.

### Browser Use

**Takeaway.** MIT-проект с богатыми примерами, но основная библиотека Python; для Nox это скорее источник идей для переноса, чем прямая Node-зависимость.

**Cited Findings.** [browser-use/browser-use](https://github.com/browser-use/browser-use) — около 120,3 тыс. звёзд; репозиторий и [README](https://github.com/browser-use/browser-use/blob/main/README.md) указывают MIT. В дереве есть browser_use/, examples/, tests/ и skills/ ([дерево](https://github.com/browser-use/browser-use/tree/main)). README описывает локальный браузер и поддержку локальных моделей; облачный Browser Use Cloud предоставляется отдельно.

**Inferences.** Полезны организация браузерных задач, поиск элементов, цикл действий и тестовые сценарии. Сопоставить с текущим Browser Bridge Nox, переносить лишь отдельные алгоритмы, если они улучшают надёжность.

**Gaps.** Не сверены SHA и лицензии всех зависимостей, моделей и внешних сервисов. Перед заимствованием проверить целевой файл и его зависимости в закреплённой ревизии.

### Activepieces Community Edition

**Takeaway.** Возможный источник отдельных интеграций, но весь продукт нельзя считать единым MIT-донором.

**Cited Findings.** [activepieces/activepieces](https://github.com/activepieces/activepieces) — около 24,5 тыс. звёзд. Корневая [LICENSE](https://github.com/activepieces/activepieces/blob/main/LICENSE) распространяет Community Edition под MIT, но исключает packages/ee/ и packages/server/api/src/app/ee; для EE указана отдельная [лицензия](https://github.com/activepieces/activepieces/tree/main/packages/ee). Обсуждение проекта относит community pieces к packages/pieces/community/<name> ([обсуждение](https://github.com/activepieces/activepieces/issues/16544)). Сторонние компоненты сохраняют собственные лицензии.

**Inferences.** Проверять по одному community-коннектору для нужной интеграции, сравнивая с инструментами и MCP-подключениями Nox; движок workflow целиком не нужен.

**Gaps.** Нужно проверить LICENSE конкретного piece, зависимости и уведомления на закреплённой ревизии; исключить EE и компоненты с другой лицензией. Метаданные npm могут отличаться от лицензии исходников.

## Проекты, которые не проходят требование MIT

### Nanobrowser

**Takeaway.** Не MIT-донор; полезен как пример браузерного агента в пользовательском Chrome/Edge.

**Cited Findings.** [nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser) — около 14 тыс. звёзд, Apache-2.0. Это TypeScript-расширение, работающее с пользовательской сессией; README описывает действия с вкладками, подтверждения и проверку видимости/стабильности цели ([README](https://github.com/nanobrowser/nanobrowser#readme)).

**Inferences.** Смотреть на UX подтверждения и устойчивость выбора элементов. Код не добавлять в MIT-доноры.

**Gaps.** Не проверены SHA и лицензии зависимостей.

### Mem0

**Takeaway.** Не MIT-донор: Apache-2.0. Подходит как архитектурный ориентир по памяти.

**Cited Findings.** [mem0ai/mem0](https://github.com/mem0ai/mem0) и его [LICENSE](https://github.com/mem0ai/mem0/blob/main/LICENSE) указывают Apache-2.0; проект содержит Python и TypeScript компоненты. Точные звёзды не фиксирую: сторонние каталоги давали расходящиеся числа.

**Inferences.** Идеи поиска и извлечения памяти можно сравнить с src/memory/store.js и src/memory/learn.js, но код не включать в MIT-список.

**Gaps.** Не проверены отдельные лицензии моделей, API и зависимостей; точное число звёзд не подтверждено надёжно.

### Pipecat

**Takeaway.** Не MIT-донор: BSD-2-Clause. Сравнительный источник по потоковому голосу.

**Cited Findings.** [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) — около 17 тыс. звёзд; [LICENSE](https://github.com/pipecat-ai/pipecat/blob/main/LICENSE) указывает BSD-2-Clause. Это Python-фреймворк real-time голосовых и мультимодальных агентов.

**Inferences.** Сравнить устройство аудио-конвейера с голосовым путём Nox; код не добавлять к MIT-донорам.

**Gaps.** Не сверены SHA и лицензии дополнительных сервисов/моделей.

### pywinauto

**Takeaway.** Не MIT-донор: BSD-3-Clause. Тематически близкая Windows GUI Automation библиотека на Python.

**Cited Findings.** [pywinauto/pywinauto](https://github.com/pywinauto/pywinauto) — около 6,4 тыс. звёзд; проект и [license.txt](https://github.com/pywinauto/pywinauto/blob/master/license.txt) указывают BSD-3-Clause. Библиотека работает через Win32 и UI Automation.

**Inferences.** Можно изучить модели адресации окон и контролов, но не переносить код по заданному фильтру. Nox на Windows, однако эта библиотека Python.

**Gaps.** Не сверены актуальный commit и зависимости.

### MCP TypeScript SDK

**Takeaway.** Весь SDK нельзя считать подтверждённым MIT-донором: лицензирование различается по вкладам, а граница файлов неочевидна.

**Cited Findings.** [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) — около 13,7 тыс. звёзд. [LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) и [обсуждение смены лицензии](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1995) указывают: новые вклады Apache-2.0, существующий код сохраняет MIT до явного перелицензирования; документация, кроме спецификаций, CC-BY-4.0. Неоднозначность границ кода обсуждается также в [issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/1018).

**Inferences.** SDK функционально близок к MCP-подключениям Nox, но по строгому MIT-фильтру не подходит для копирования как единый репозиторий. Использовать зависимости по их условиям лицензии безопаснее, чем заимствовать неразмеченные фрагменты.

**Gaps.** Не разделены файлы по авторству/дате и не проверены лицензии пакетов-зависимостей. Пока такое разделение не доказано, исключить из прямых MIT-доноров.

## Приоритет и границы

**Takeaway.** Первыми читать на конкретных SHA Cua Driver, Stagehand и один-два Activepieces community pieces. Browser Use — следующий источник переносимых идей. Пока ни один проект из этой проверки не является скачанным и подтверждённым донорским снимком.

**Cited Findings.** Cua совпадает с Windows/UIA и имеет Node/Electron SDK; Stagehand — TypeScript браузерный агент с локальным режимом; Activepieces содержит MIT Community Edition и отдельно лицензированный EE; Browser Use — MIT, но написан на Python. Все девять перечисленных на скриншотах проектов отсутствовали в донор/КАТАЛОГ.md на 8 ноября 2026 года.

**Inferences.** Очередь: (1) Cua Driver/его MIT TypeScript SDK; (2) Stagehand локальное наблюдение, действия и проверки; (3) конкретные Activepieces-интеграции под нужды Nox; (4) перенос лучших идей Browser Use. Коротко отдельно проверить Browser Harness JS как менее популярную TypeScript-наводку.

**Gaps.** Это проверка публичных страниц, не юридическое заключение. Перед переносом зафиксировать URL и SHA, сохранить лицензии/NOTICE, перечислить файлы и зависимости и перепроверить лицензионную границу. Звёзды — только моментальный снимок GitHub.
