# С5: проверка в Chrome

Статус: **проверено в Chrome for Testing 156.0.8078.47** (автоматизированный прогон в изолированном временном профиле без реальных аккаунтов и секретов; Edge отдельно не проверялся).

P1-5 (невидимый текст) перепроверен 2026-11-13 в Chrome for Testing 156.0.8078.47 на **неизменённом** `manifest.json` (SHA-256 `c63e10c17cd2860d895ad369c8e1bdce2eb4a6f49835d5c4bcba04670d6c7d44`): см. раздел ниже и `docs/audits/c5-p1-5/chrome-qa-result.json`.

## Подготовка

- Chrome for Testing `156.0.8078.47` (`chrome://extensions` / `--load-extension` с временным профилем).
- Локальная тестовая страница `test-page.html` и второй локальный origin для проверки смены сайта.
- Экземпляр `createBridge({ origin: 'chrome-extension://ID' })` из `apps/nox-browser-bridge`.

## Проверенные сценарии (Chrome 156.0.8078.47)

- [x] Загрузка распакованного расширения MV3 (`activeTab`, `scripting`, без `chrome.storage`).
- [x] Явное уведомление в popup о передаче содержимого выбранной вкладки модели Nox.
- [x] Одноразовое сопряжение и сохранение установленной сессии после истечения срока первоначального сопряжения.
- [x] Отказ на `read_request` (`permission_required`) до нажатия «Разрешить и прочитать».
- [x] После нажатия «Разрешить и прочитать»: фильтрация скрытых/приватных/полей ввода (`TEST_*_MARKER` не попадают в результат), одноразовое чтение через мост (`read_request`/`read_result`), очистка вывода в popup и отказ на повторный `read_request`.
- [x] Немедленный отзыв при нажатии «Отозвать доступ», смене вкладки, смене `origin`, закрытии вкладки и `bridge.revoke()`.
- [x] P1-5: все шесть техник невидимого текста (`opacity:0`, `font-size:0`, `color:transparent`, `position:absolute;left:-9999px`, `height:0;overflow:hidden`, `clip-path:inset(100%)`) не попадают ни в popup, ни в подписанный `read_result` моста; обычная длинная статья читается целиком, включая текст ниже первого экрана.

## P1-5: невидимый текст (13.11.2026)

Команда:

```bash
cd apps/nox-browser-extension
node scripts/chrome-visibility-qa.mjs
```

Скрипт запускает Chrome for Testing 156.0.8078.47 с расширением из этой папки
(`--load-extension` без правок manifest), поднимает настоящий мост
`createBridge({ origin })`, сопрягает popup и читает страницу с маркерами. Затем
нажимает «Разрешить и прочитать», забирает текст из popup и отдельно через
`bridge.readPage()`. Результаты — в `docs/audits/c5-p1-5/chrome-qa-result.json`.

| Проверка | Результат |
|---|---|
| Видимые маркеры статьи, конца длинной страницы, градиентного текста, обводки, тени и заголовка закрытого `details` | есть в popup и в `read_result` |
| `opacity:0`, `font-size:0`, `color:transparent`, `-webkit-text-fill-color:transparent` | не попали |
| `position:absolute;left:-9999px`, `height:0;overflow:hidden`, `clip-path:inset(100%)` | не попали |
| `filter:opacity(0)`, `visibility:hidden`, `display:none`, `aria-hidden`, закрытый `details` | не попали |
| `-webkit-text-security:disc`, `contenteditable`, `data-private`, `input[type=password]` | не попали |
| Длина текста в popup и в мосте | одинаковая, 9 305 символов (16 694 байта UTF-8) |

Замеры на больших страницах (headless Chrome; извлечение останавливается на лимите
49 280 байт): 6 001 абзац / 12 005 текстовых узлов — 5,1 мс; 3 001 абзац с
`opacity:0` / 6 005 узлов (обход всей страницы, текст отброшен) — 30,9 мс.

Ограничение стенда: замеры выполняются вызовом того же исходника `extractPage` в
контексте страницы, а не через `chrome.scripting`; корректность при этом проверяется
полным путём расширения и моста. Headless-время — ориентир, не гарантия на машине
владельца.
