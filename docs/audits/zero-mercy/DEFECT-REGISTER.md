# Реестр находок

Дата среза: 10.11.2026. Классы: **CONFIRMED DEFECT**, **LIKELY DEFECT**, **DESIGN INCONSISTENCY**, **UNVERIFIED**, **EXPECTED BEHAVIOR**. Полное описание, первопричина и безопасный тест — в связанных отчётах.

| ID | Приоритет | Класс | Кратко | Доказательство |
|---|---:|---|---|---|
| ZM-001 | P0 | CONFIRMED DEFECT | При совпадении ID синхронизированное нажатие в живом диалоге одобряет второе действие, пока показано первое | [живой прогон](evidence/electron-temp/journal-window-approval-r3/approval.json), [изолированная проба ядра](evidence/approval-misbinding-probe.json) |
| ZM-002 | P1 | DESIGN INCONSISTENCY | «Тема», акцент и шрифты меняются в настройках, но не меняют чат Nox, команды, подключения и настройки | [матрица тем](evidence/theme-matrix-v2.json), снимки [чата](evidence/chat-light-1200.png), [команд](evidence/commands-light-1200.png), [подключений](evidence/connections-light-1200.png), [настроек](evidence/settings-light-1200.png) |
| ZM-003 | P1 | CONFIRMED DEFECT | Рискованное успешное действие без подтверждения результата отображается как «выполнено» | [живой журнал](evidence/electron-temp/journal-window-r1/write.json), [проба классификатора](evidence/agent-probes.json) |
| ZM-004 | P1 | CONFIRMED DEFECT | `stop()` отправляет итог до завершения инструмента; поздний результат не попадает в окно | [результат пробы](evidence/agent-probes.json) |
| ZM-005 | P1 | CONFIRMED DEFECT | Кнопка «Повторить» заново отправляет поручение после частичного выполнения. В пробе повторно записан тот же файл и создана лишняя копия | [два подтверждённых вызова и файлы](evidence/electron-temp/journal-window-retry-r2/retry.json) |
| ZM-006 | P2 | CONFIRMED DEFECT | Экран журнала ищет в пределах последних 200 строк файла. В прогоне из 50 000 записей показал 199 и пропустил старую запись, доступную через IPC поиска | [живой прогон](evidence/electron-temp/journal-window-r1/write.json), `renderer/app.js`, `main.js` |
| ZM-007 | P2 | CONFIRMED DEFECT | После остановки строка текущего действия может остаться в состоянии «выполняется» | `agent-probes.json`, обработчик `done` и `endTurn()` в `renderer/app.js` |
| ZM-008 | P2 | CONFIRMED DEFECT | Аргументы инструмента выводятся в карточке разрешения и строке действия без маскировки | `renderer/shared.js` (`argsPretty`, `argsBrief`), `renderer/app.js` |
| ZM-009 | P2 | CONFIRMED DEFECT | Приглушённый текст имеет контраст 3.47:1 на основной поверхности, ниже 4.5:1 для обычного текста | расчёт по `nox-settings.css` токенам `#6B6B70` / `#141415` |
| ZM-010 | P2 | CONFIRMED DEFECT | Сфера Nox явно игнорирует `prefers-reduced-motion` Windows | `renderer/nox-screen.js`, `renderer/orb-nox.js` |
| ZM-011 | P2 | DESIGN INCONSISTENCY | Предпросмотр импорта раскрывает названия внутренних инструментов и сериализованные аргументы | [снимок импорта](evidence/commands-import-audit.png) |
| ZM-012 | P3 | DESIGN INCONSISTENCY | Редактор команд на 1200×720 оставляет большую пустую область справа и смещён влево | [снимок редактора](evidence/commands-editor-audit.png) |
| ZM-013 | P1 | CONFIRMED DEFECT | Запрос подтверждения не открывает диалог автоматически. Ручное открытие работает, но после Escape диалог остаётся висеть | [живой прогон](evidence/electron-temp/journal-window-approval-r3/approval.json) |
| ZM-014 | P2 | CONFIRMED DEFECT | В длинном чате кнопка «Вниз» остаётся скрытой после прокрутки вверх. После нового ответа лента не дошла до низа | [проверка long-scroll](evidence/chat-qa-r1/verify-report.json) |
| ZM-015 | P2 | CONFIRMED DEFECT | Экспорт успешно пишет файл с 611 командами, импорт этого файла отклоняется из-за лимита 500 | [проверка экспорта и импорта](evidence/electron-temp/commands-load-r1-600/bench.json) |
| ZM-016 | P2 | CONFIRMED DEFECT | В каталоге с 10 011 командами широкая выдача синхронно пересоздаёт тысячи строк и задерживает следующий кадр интерфейса | [замер каталога](evidence/electron-temp/commands-load-r1-10000/bench.json) |
| ZM-017 | P2 | CONFIRMED DEFECT | Запись команд добавляет в черновик отклонённое действие, которого не было на диске | [запись и решение](evidence/electron-temp/journal-window-record-r1/record.json), [черновик](evidence/electron-temp/journal-window-record-r1/record-refused-draft.png) |
| ZM-018 | P1 | CONFIRMED DEFECT | При зависшем ответе окна ядру следующие подтверждения перестают принимать нажатия. При ошибке ответа запрос исчезает из очереди окна, хотя ядро его ещё ждёт | [контролируемый отказ и зависание](evidence/electron-temp/journal-window-approval-ipc-r1/approval-ipc.json) |
| ZM-019 | P2 | CONFIRMED DEFECT | После выхода без обработчика штатного завершения отправленная реплика незаконченного хода исчезает из общего чата | [до выхода](evidence/electron-temp/journal-window-restart-abrupt-r1/restart-abrupt.json), [после запуска](evidence/electron-temp/journal-window-restart-abrupt-r1/restart-read.json) |
| ZM-020 | P1 | CONFIRMED DEFECT | Вход остаётся заблокирован дольше 15 секунд, если сервер прислал заголовки и не закончил ответ | [замер ответа](evidence/electron-temp/account-window-r2/account.json) |
| ZM-021 | P2 | CONFIRMED DEFECT | Ошибка обновления аккаунта убирает лимиты и выход из аккаунта. Экран остаётся пустым без объяснения | [данные](evidence/electron-temp/account-window-r2/account.json), [пустой экран](evidence/electron-temp/account-window-r2/offline-864.png) |
| ZM-022 | P2 | CONFIRMED DEFECT | На первом запуске клавиатурный фокус может оказаться за формой регистрации. Tab обходит закрытые ею кнопки чата | [порядок фокуса](evidence/electron-temp/account-window-r2/account.json), [форма](evidence/electron-temp/account-window-r2/onboarding-864.png) |

## Количество

| Приоритет | Все записи | Подтверждённые дефекты |
|---|---:|---:|
| P0 | 1 | 1 |
| P1 | 7 | 6 |
| P2 | 13 | 12 |
| P3 | 1 | 0 |

Для ZM-001 запросы должны пересечься с одинаковым ID, а нажатие должно попасть между новым запросом и обработкой отклонения старого. В пробе момент нажатия задан скриптом, оба действия были фиктивными. Частота коллизий и попадания обычным ручным нажатием не измерялась. ZM-005 воспроизведён с обычной записью файла внутри временного профиля. Сценарии внешней отправки остаются непроверенными.
