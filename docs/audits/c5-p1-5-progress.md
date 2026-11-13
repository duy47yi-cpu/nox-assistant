# C5 P1-5 — журнал исправления «извлекатель читает невидимый текст»

Дата: 2026-11-13. Автор: исполнитель C5 P1-5. Статус: **исправлено и проверено** в объёме P1-5.
C5 в целом по-прежнему не готов к включению по умолчанию, пока открыты P1-1…P1-4 из
`docs/audits/c5-final-integration-audit.md`.

Ничего не закоммичено и не отправлено (`commit`/`push` не выполнялись). Новые пакеты не
ставились. `apps/nox-browser-bridge`, `protocol.js`, `client.mjs`, `messages.mjs`,
`background-core.mjs`, `popup.html`, `popup.mjs` и `manifest.json` не менялись.
Terra, C6/C7 и дизайн Aether не трогались.

## 1. Что было и что стало

Аудит P1-5: `extractPage` проверял только `display`/`visibility`, поэтому в текст вкладки
попадали `opacity:0`, `font-size:0`, `color:transparent`, `position:absolute;left:-9999px`,
`height:0;overflow:hidden` и `clip-path:inset(100%)`. Popup обещает «видимое содержимое»,
README — что скрытые элементы не читаются.

Теперь `apps/nox-browser-extension/page.mjs` возвращает только текст, который владелец
может увидеть. Решение принимается по трём слоям.

1. **Запреты (как раньше):** формы, `contenteditable`, `[hidden]`, `[aria-hidden="true"]`,
   `[data-private]`, `[data-sensitive]`, `role=textbox/combobox/searchbox`, `script/style`,
   `iframe/svg/canvas/template`; добавлен `[inert]`. Значения `input`/`textarea` не читаются
   в принципе (TreeWalker берёт только текстовые узлы).
2. **Стили всех родителей** (кэш на элемент, обход до `documentElement`):
   - `display:none`, `content-visibility:hidden` — скрывают поддерево;
   - `visibility:hidden/collapse` — проверяется по вычисленному стилю самого элемента,
     поэтому `visibility:visible` у потомка корректно перекрывает скрытого родителя;
   - `opacity` перемножается по цепочке; порог `≤ 0.05` считается невидимым;
   - `filter:opacity(...)` перемножается в ту же цепочку;
   - `inert` у любого предка;
   - закрытый `<details>` скрывает всё, кроме своего `<summary>`;
   - `clip-path` формы `inset(...)` разрешается в прямоугольник обрезки, `inset(100%)` и
     вырожденные значения скрывают; другие формы (`polygon`, `circle`, `path`, `url`)
     трактуются как невидимые (безопасный отказ);
   - устаревший `clip: rect(...)` разрешается; нулевой прямоугольник скрывает;
   - `overflow`/`overflow-x`/`overflow-y`: `hidden`/`clip` дают жёсткую обрезку по этой оси;
     `auto`/`scroll`/`overlay` не скрывают содержимое, потому что его можно прокрутить
     (это сохраняет чтение длинных статей и панелей документации); нулевой бокс скрывает.
   - `Element.checkVisibility({checkOpacity, checkVisibilityCSS, opacityProperty,
     visibilityProperty})` используется как дополнительный быстрый фильтр, но не как
     единственный: у `display:contents` он возвращает `false`, поэтому такие элементы
     проверяются вручную и не скрываются.
3. **Собственная краска текста** (по вычисленному стилю ближайшего родителя текста):
   - глифы рисуются `-webkit-text-fill-color`, а не `color`; `currentcolor` разрешается в
     `color`; проверено в Chrome 156;
   - прозрачная заливка скрывает, **кроме** случаев, когда текст реально виден иначе:
     `background-clip:text` + фон-картинка (градиентный текст), обводка
     `-webkit-text-stroke` ненулевой ширины с непрозрачным цветом, `text-shadow` с
     непрозрачным цветом;
   - `font-size ≤ 0.5px` скрывает;
   - `-webkit-text-security` (точки вместо символов) скрывает;
   - документ в `designMode=on` не читается целиком (аналог contenteditable).
4. **Геометрия текста** через `Range.getClientRects()`:
   - прямоугольник должен иметь ширину и высоту ≥ 1 px;
   - текст вне досягаемой области страницы (document-relative правее/ниже границ
     `scrollWidth`/`scrollHeight`, либо левее/выше документа дальше 2 000 px) скрывается —
     это ловит `left:-9999px`, `top:-9999px`, `text-indent:-9999px`, `translate(-9999px)`;
   - для `position:fixed` границы считаются по области просмотра;
   - текст ниже первого экрана и текст в прокручиваемых панелях **читается**;
   - пересечение с каждой областью обрезки предков (overflow-hidden/clip, `clip`,
     `clip-path:inset`) должно быть не меньше 2×2 px, иначе текст скрыт; так ловится
     `height:0;overflow:hidden` и текст, выехавший за пределы обрезающего блока.
5. **Лимиты сохранены:** 49 280 байт текста и 600 байт заголовка в странице,
   `truncateUtf8`/`fitReadResultFrame` в `messages.mjs` не менялись, кадр ≤ 64 KiB.

Если геометрия недоступна (`document.createRange` отсутствует — так работают старые
мок-тесты), стилевые проверки всё равно применяются, а геометрические пропускаются.
В Chromium ≥116 `createRange` есть всегда; это совместимость с тестовым стендом, не
продуктовый путь.

## 2. Файлы и хэши

| Файл | Что | SHA-256 |
|---|---|---|
| `apps/nox-browser-extension/page.mjs` | новый извлекатель | `bf9b48f718f48ab44fdf23a057569304510108996a232e9ce6e8489f7332d410` |
| `apps/nox-browser-extension/page-visibility.test.mjs` | 42 постоянных теста P1-5 | `2c6a75d054aa9f70e80c5871740e7ef415e4d6b27cfab82cf00adf78355a053f` |
| `apps/nox-browser-extension/scripts/chrome-visibility-qa.mjs` | живая проверка Chrome for Testing | `4bfb7798c0bcd06d1f1d3d36fefc7249f83af689ac407ed7c1283c571f69cb7d` |
| `apps/nox-browser-extension/README.md` | описание видимости и команда живой проверки | `01dc3fbdb06f267e83f6638cdcdee8ece8725589377945685be7a0df6d1b4e8d` |
| `apps/nox-browser-extension/CHROME-QA.md` | раздел P1-5 и результаты Chrome | `7ce61880921739cbc73ac4d47526dd966ba6c985c31a02dd70df39a040204cde` |
| `apps/nox-browser-extension/manifest.json` | **не менялся** | `c63e10c17cd2860d895ad369c8e1bdce2eb4a6f49835d5c4bcba04670d6c7d44` |
| `docs/audits/c5-p1-5/chrome-qa-result.json` | машинный результат живого прогона | `497aa49815ced1a193c5e49be9b67a336b90ca386ac09864cf4078beda0b5956` |

Хэш `manifest.json` совпадает с зафиксированным в `docs/audits/c5-independent-rerun.md`,
то есть живой прогон шёл на неизменённом manifest.

## 3. Постоянные тесты

Команда:

```bash
cd apps/nox-browser-extension
node --test
```

Результат: **58 / 58 pass** (`16` прежних + `42` новых в `page-visibility.test.mjs`),
0 fail. Покрыты:

- все шесть случаев аудита: `opacity:0`, `font-size:0`, `color:transparent`,
  `position:absolute;left:-9999px`, `height:0;overflow:hidden`, `clip-path:inset(100%)`;
- родительские стили: `opacity`/`display:none` у предка, `visibility:hidden` с
  перекрытием `visible` у потомка, `content-visibility:hidden`, `filter:opacity(0)`,
  `inert`, закрытый/открытый `<details>`;
- дополнительные техники: `-webkit-text-fill-color:transparent`, `-webkit-text-security`,
  устаревший `clip:rect(0,0,0,0)`, `transform:scale(0)`, `position:fixed` за экраном,
  `text-indent:-9999px`, контент правее документа, прозрачный `color(srgb … / 0)`;
- сохранение видимого текста: обычная статья, текст ниже первого экрана длинной страницы,
  текст в прокручиваемой панели, частично обрезанный текст у края, полупрозрачный текст
  (alpha 0.4), градиентный текст `background-clip:text`, обводка, видимая тень,
  `display:contents` (у которого Chrome `checkVisibility` даёт `false`), перекрытие
  `visibility`;
- формы/editable/private остаются исключёнными; UTF-8-лимиты текста и заголовка
  соблюдаются; отдельный тест на 4 000 абзацев укладывается в 5 с (фактически ~15–40 мс
  на фейковом DOM).

Независимый тест аудита `docs/audits/c5-rerun/gate-and-utf8.test.mjs` (SG-03 и остальные)
не менялся и проходит: **5 / 5 pass**. Проверено командой:

```bash
node --test --test-timeout=20000 docs/audits/c5-rerun/gate-and-utf8.test.mjs
```

## 4. Живая проверка Chrome for Testing

Команда:

```bash
cd apps/nox-browser-extension
node scripts/chrome-visibility-qa.mjs
```

Скрипт берёт Chrome for Testing `156.0.8078.47` из
`~/.cache/puppeteer/chrome/win64-156.0.8078.47` (можно задать `NOX_CHROME_BIN`),
загружает **эту папку** через `--load-extension` без копирования и правок manifest,
поднимает настоящий `createBridge({ origin })`, сопрягает popup через
`Extensions.triggerAction` (как в E2E) и нажимает «Разрешить и прочитать».
Текст проверяется дважды: в popup и отдельным `bridge.readPage()`.

Результат (`docs/audits/c5-p1-5/chrome-qa-result.json`, итоговый прогон):

| Проверка | Результат |
|---|---|
| Chrome | `Chrome/156.0.8078.47` |
| Manifest | hash `c63e10c1…`, `permissions: [activeTab, scripting]`, без `host_permissions`/`content_scripts` |
| Сопряжение | «Мост подтверждён», секрет очищен |
| Текст в popup / в мосте | 9 305 символов / 16 694 байта, одинаково |
| Видимое | `VISIBLE_MARKER`, `BOTTOM_MARKER` (конец длинной страницы), `VISIBLE_GRADIENT`, `VISIBLE_STROKE`, `VISIBLE_SHADOW`, `VISIBLE_SUMMARY` (заголовок закрытого `details`) — есть |
| Шесть случаев аудита | `HID_OPACITY`, `HID_FONT0`, `HID_COLOR`, `HID_OFFSCREEN`, `HID_HEIGHT0`, `HID_CLIP` — нет |
| Дополнительно скрытое | `HID_VISIBILITY`, `HID_DISPLAY`, `HID_ARIA`, `HID_FILL_TRANSPARENT`, `HID_FILTER`, `HID_DETAILS`, `HID_SECURITY` — нет |
| Приватное | `SEC_PASSWORD`, `SEC_EDIT`, `SEC_PRIVATE` — нет |

Замеры (headless, извлечение останавливается на лимите 49 280 байт):

| Страница | Узлов | Время (3/2 прогона) | Итог |
|---|---|---|---|
| 6 001 абзац видимого текста | 12 005 текстовых | 7,1 / 6,0 / 5,1 мс (лучшее 5,1) | 49 279 байт, лимит достигнут |
| 3 001 абзац `opacity:0` + хвост | 6 005 текстовых | 30,9 / 31,8 мс (лучшее 30,9) | 43 байта, вся страница обойдена |

Числа между прогонами плавают (по серии заходов: 5,1–6,5 мс и 27,4–30,9 мс); это
headless-ориентир, не гарантия на машине владельца. Замер выполняется вызовом того же
исходника `extractPage` в контексте страницы; корректность при этом проверяется полным
путём расширения и моста.

## 5. Ограничения и остаточные риски

- **Нестандартная `clip-path`.** `polygon`/`circle`/`path`/`url` трактуются как скрытые:
  видимый текст внутри декоративной фигуры будет пропущен. Это осознанный безопасный отказ;
  при необходимости можно добавить разбор простых фигур.
- **`mask-image`, `mix-blend-mode`, совпадение цвета текста с фоном** не определяются:
  визуально невидимый текст с непрозрачной заливкой может попасть в результат. Для атаки
  это менее удобно, чем шесть техник аудита, но остаток есть.
- **Shadow DOM, `::before`/`::after`, canvas-текст, изображения** не читаются (и не читались
  раньше): это пропуски, а не утечки.
- **Порог прозрачности 0.05.** `opacity:0.06` считается видимым.
- **Порог обрезки 2×2 px.** Текст, от которого видна полоска 1 px, считается скрытым.
- **Текст частично виден — включается целиком.** Пословной/построчной обрезки нет.
- **`position:fixed`** игнорирует обрезку предков (fixed выходит из overflow), но сохраняет
  собственные `clip`/`clip-path`. Fixed внутри трансформированного обрезающего контейнера —
  редкий случай, может быть прочитан.
- **Вложенная прокрутка внутри жёстко обрезанного предка.** Если внешний блок с
  `overflow:hidden`/`clip` (например, `body { overflow:hidden }` в оболочке веб-приложения)
  обрезает внутреннюю прокручиваемую панель, текст, который оказался за пределами внешнего
  блока, может быть пропущен: жёсткая обрезка предка применяется ко всей цепочке. Для
  обычной прокрутки документа и панелей без такого предка ограничение не действует.
- **`designMode=on`** отдаёт пустой текст (заголовок сохраняется).
- **Неизмеряемая геометрия** (нет `document.createRange`) — стилевые проверки есть,
  геометрических нет. В Chromium ≥116 путь недостижим; это совместимость с мок-тестами.
- **Тестовая зависимость F10 не устранена:** `extension.test.mjs` и живой QA берут `ws` из
  `apps/nox-browser-bridge/node_modules`. Без соседней папки тесты/QA не запустятся.
  Это не безопасность, а условие воспроизводимости.
- **Живой прогон** выполнен на Chrome for Testing 156.0.8078.47 (headless, изолированный
  временный профиль). Edge и другие версии отдельно не проверялись; в Chrome 155
  независимый аудит проверял только платформенные допущения.
- **Вердикт по C5 в целом не меняется:** текст страницы остаётся недоверенным; P1-1…P1-4
  (память, запись файлов, кросс-ходовой taint, `reasoning_content`) этим заходом не
  исправлялись. Интеграция обязана сохранять `untrusted:true`/`source:browser_extension`
  и правила подтверждений.

## 6. Что проверить повторно

```bash
# 1. Постоянные тесты расширения (ожидается 58/58)
cd apps/nox-browser-extension && node --test

# 2. Независимый тест аудита (ожидается 5/5, SG-03 без изменений)
cd D:/nox-release && node --test --test-timeout=20000 docs/audits/c5-rerun/gate-and-utf8.test.mjs

# 3. Живой Chrome for Testing с неизменённым manifest
cd apps/nox-browser-extension && node scripts/chrome-visibility-qa.mjs

# 4. Сверка манифеста
sha256sum apps/nox-browser-extension/manifest.json
# ожидается c63e10c17cd2860d895ad369c8e1bdce2eb4a6f49835d5c4bcba04670d6c7d44
```

Проверяющему стоит самостоятельно воспроизвести шесть техник на своей странице (или взять
`hiddenPageHtml()` из `scripts/chrome-visibility-qa.mjs`) и убедиться, что маркеры не
появляются ни в `#output` popup, ни в `read_result` моста. Для повторной проверки по
исходникам: `page.mjs`, функции `stateOf`, `textRenderable`, `clipPathRect`,
`legacyClipRect`, `overflowClipOf`, `textRects`, `rectVisible`.

## 7. Журнал хода работы

1. Прочитаны `page.mjs`, тесты, manifest, popup, мост, отчёт аудита P1-5 и E2E.
2. Сняты живые пробы Chrome 156 (`--dump-dom`) по неоднозначным сигналам:
   `color:transparent` даёт прозрачный `-webkit-text-fill-color`; `font-size:0` даёт
   прямоугольник 0×0; `height:0;overflow:hidden` сохраняет прямоугольник текста (нужна
   обрезка); `clip-path:inset(100%)` не отражается в `checkVisibility`; закрытый `details`
   сохраняет прямоугольники (нужна явная проверка); `display:contents` даёт
   `checkVisibility:false`; градиентный/обводочный/теневой текст видим при прозрачной
   заливке; `-webkit-text-security` отдаёт `disc`.
3. Написан новый извлекатель с кэшами стилей/состояний и геометрией.
4. Добавлены 42 постоянных теста на фейковом DOM; старый SG-03 и тесты расширения не
   сломаны (фолбэк без `createRange`).
5. Написан и отлажен живой QA в Chrome for Testing: обнаружение extension origin,
   сопряжение, `Extensions.triggerAction`, popup, `read_result`, замеры.
6. Проведены финальные прогоны: 58/58, 5/5, живой Chrome `ok:true`, манифест не изменён.
