# Доказательства аудита

Все изменяющие состояние прогоны использовали временные профили, фиктивные настройки и данные внутри этой папки. Настоящие `.env` и `data/` не использовались. Файлы профилей и временные данные оставлены как артефакты воспроизведения.

## Основные файлы

- `theme-matrix-v2.json`, `theme-probe-v2.log` — 23 темы, computed styles и цепочка сохранения после reload.
- [Расширенная матрица тем](electron-temp/theme-probe-extra-r1/theme-matrix.json) — все 23 пункта для журнала, «Дел» и «Аккаунта» без сервера. Шесть снимков для тёмного и светлого варианта.
- `settings-qa.log`, `commands-qa.log`, `connections-qa.log` — живые QA-прогоны настроек, команд и подключений.
- `jarvis-node-test.log`, `server-node-test.log` — итоговые `node --test`.
- `agent-probes.js`, `agent-probes.json`, `agent-probes.log` — статусы и гонка остановки на фиктивном инструменте.
- `approval-misbinding-probe.js`, `approval-misbinding-probe.json` — две фиктивные операции с общим ID; внешний эффект ограничен массивом JavaScript в памяти.
- [Живой журнал](electron-temp/journal-window-r1/write.json) и [повторный запуск](electron-temp/journal-window-r1/read.json) — 50 000 фиктивных записей, статусы, поиск, четыре размера окна, измерения и сохранение настроек.
- [«Как в системе»](electron-temp/journal-window-system-r3/system.json) — переключение нативной темы только в тестовом процессе и отдельная эмуляция медиаусловия Chromium. Сравнение журнала и чата.
- [Подтверждения в живом окне](electron-temp/journal-window-approval-r3/approval.json) — ошибка автоматического открытия, штатная кнопка «Решить», Escape, истечение 30 секунд и синхронизированное нажатие при коллизии. Финальный прогон `r3` использовал неизменённую разметку. В диагностическом `r2` временно добавлялся отсутствующий элемент, чтобы отличить причину ошибки от поведения брокера.
- [Сбой ответа окна](electron-temp/journal-window-approval-ipc-r1/approval-ipc.json) — два отказа на границе окна и ядра, ожидания до и после таймера, нажатие для следующего запроса и счётчик фиктивных эффектов.
- [Перезапуск без обработчика выхода](electron-temp/journal-window-restart-abrupt-r1/restart-read.json) и [штатный перезапуск](electron-temp/journal-window-restart-clean-r1/restart-read.json) — ожидание согласия на безопасную запись, фактическое состояние после повторного запуска и журналы изолированного профиля.
- [Доступность при 125%](electron-temp/access-window-r2-125/accessibility.json) и [при 200%](electron-temp/access-window-r2-200/accessibility.json) — пять разделов, клавиатура, два диалога и изменение пикселей сферы при эмуляции уменьшения движения.
- [Нативное уведомление](notification-native-r1.log) — отдельный временный профиль, событие Electron `show`.
- [Первый запуск и аккаунт](electron-temp/account-window-r2/account.json) — регистрация, вход, обновление лимитов, отзыв входа, неполный HTTP-ответ и Tab на фоне формы. Сервер слушал только локальный адрес. Секреты на тестовый сервер не отправлялись.
- [Пространства при 200%](electron-temp/access-window-r3-workspace/accessibility.json) — создание пространства, модальный фокус, отказ переключения с черновиком и переход после очистки поля.
- [Прогон чата](chat-qa-r1/verify-report.json) — восемь сценариев с локальным сервером. Обёртка исключила проверку общего буфера Windows.
- [«Повторить» после подтверждённого шага](electron-temp/journal-window-retry-r2/retry.json) — фиктивный ответ модели, настоящая запись в рабочей папке профиля и два результата проверки в журнале.
- [Отклонённый шаг в записи команд](electron-temp/journal-window-record-r1/record.json) — решение ядра, проверка отсутствия файла и черновик с отклонённым шагом.
- [Каталог из 111 команд](electron-temp/commands-load-r1-100/bench.json), [611](electron-temp/commands-load-r1-600/bench.json) и [10 011](electron-temp/commands-load-r1-10000/bench.json) — поиск, время загрузки и повторные переходы. Для двух меньших наборов также проверено чтение сохранённого экспорта.
- [Повторный замер 111](electron-temp/commands-load-r3-100/bench.json), [611](electron-temp/commands-load-r3-600/bench.json) и [10 011 команд](electron-temp/commands-load-r3-10000/bench.json) — готовность подтверждена заменой строки, а для малого каталога дополнительно выполнены 60 переходов со сборкой мусора каждые 20 переходов.
- [Импорт и экспорт через кнопки](electron-temp/commands-load-ui-transfer-r1/bench.json) — сохранение, отмены, добавление одной команды, возврат фокуса и ошибка испорченного JSON.
- [Прерванный длительный прогон](electron-temp/commands-load-soak-r1/soak-samples.jsonl) — 177 выборок за 29 мин. Запись итогового показателя отсутствует, потому что владелец остановил проверку.
- [Второй прерванный прогон](electron-temp/commands-load-soak-r2/soak-samples.jsonl) — 28 выборок за 4,5 минуты, в отдельном профиле со 111 командами.
- [Чат и кадр источника](reference-chat-pair-864.png), [команды](reference-commands-pair-1200.png), [редактор](reference-editor-pair-1200.png), [подключения](reference-connections-populated-pair-1200.png), [настройки](reference-settings-pair-1200.png) — сопоставления со справочными материалами проекта.
- `settings-light-1200.png`, `commands-light-1200.png`, `connections-light-1200.png`, `chat-light-1200.png`, `classic-chat-light-1200-v2.png` — сравнение реакции разных экранов на светлую тему.
- `commands-editor-audit.png`, `commands-picker-audit.png`, `commands-record-audit.png`, `commands-import-audit.png` — состояния раздела команд.
- `connections-details-audit.png`, `connections-add-audit.png`, `connections-delete-audit.png`, `connections-drift-audit.png`, `connections-error-audit.png`, `connections-empty-audit.png` — состояния раздела подключений на локальных фикстурах.
- `nox-full-*.png`, `nox-empty-*.png`, `*-catalog-*.png` — снимки при 960×640 и 1600×900.

Остальные PNG — снимки темы и внешнего вида для четырёх основных разделов. Снимки из probe не являются продуктовыми эталонами; они фиксируют фактическое отображение.
