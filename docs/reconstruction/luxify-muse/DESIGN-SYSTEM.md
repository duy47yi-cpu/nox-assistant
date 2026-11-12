# Nox — Дизайн-система (Phase R2)

## 1. Архитектура токенов

Трёхслойная — как у зрелых систем (W3C Design Tokens):

```
primitive  →  semantic  →  component
#0F0F10        --bg, --surface, --border        .nox-panel, .turn, .card
#2E9AC1       --accent, --accent-soft          .btn--primary, .rail-item[active], .orb
```

**Текущая проблема Nox [В]:** `nox-screen.css` объявил `--nox-*` изолированно, не читает `[data-theme]` из `themes.css`. Поэтому переключение темы не влияет на экран Nox — жалоба из брифа подтверждена.

**Решение [П]:** экран Nox читает те же семантические токены, что и остальные разделы. `--nox-*` остаются алиасами для обратной совместимости, но указывают на `--bg/--surface-*/--border/--text-*/--accent`:

```css
body[data-view="nox"] {
  --nox-bg: var(--bg);
  --nox-surface-1: var(--surface);
  --nox-surface-2: var(--surface-2);
  --nox-surface-3: var(--surface-3);
  --nox-border: var(--border);
  --nox-text-1: var(--text);
  --nox-text-2: var(--text-2);
  --nox-text-3: var(--text-3);
  --nox-accent: var(--accent);
}
```

Тогда `theme-boot.js` решает тему один раз — и чат, и сфера, и рейка идут за ней.

---

## 2. Primitive (палитра-основа)

| Токен | Значение (dark) | Роль | Происхождение |
|---|---|---|---|
| ` primitive.bg-900 ` | #0F0F10 | Глубокий фон окна | [П] Nox — темнее Luxify #0A0A0A [В] для контраста карточек |
| ` primitive.surface-800 ` | #18181B | Панели | [В] текущий Nox |
| ` primitive.surface-700 ` | #1C1C1F | Поля, вторичные панели | [В] |
| ` primitive.surface-600 ` | #232326 | Hover, выбранное | [В] |
| ` primitive.border ` | #2A2A2E / 6–8% белого [О] | Бордеры 1px | [О] по Luxify |
| ` primitive.text-100 ` | #F1F1F3 | Основной текст | [В] Nox |
| ` primitive.text-200 ` | #9A9AA0 | Вторичный | [В] |
| ` primitive.text-300 ` | #6B6B70 | Третичный, подписи | [В] |
| ` primitive.accent-cyan ` | #2E9AC1 | Акцент по умолчанию | [П] Nox — баланс между Luxify #4466FF [В] и Nox #58D9E8 |
| ` primitive.ok ` | #3DD68C | Успех | [В] Nox |
| ` primitive.warn ` | #F5A524 | Ожидание | [В] Nox (янтарь) — как Luxify оранжевый щит [В] |
| ` primitive.err ` | #FF5C5C | Ошибка | [В] Nox |

Акцент меняется палитрой `theme-boot.js` (blue/violet/green/…) + custom HEX — сфера берёт его же [В].

## 3. Semantic (тема)

```yaml
semantic:
  bg: var(--bg)                 # окно (.app)
  surface: var(--surface)       # рейка, история, чат, сфера (панели)
  surface-2: var(--surface-2)   # поля, карточки настроек
  surface-3: var(--surface-3)   # hover, выбранная строка
  border: var(--border)         # 1px бордеры
  border-strong: color-mix(white 4%, border)
  text-1: var(--text)           # заголовки, тело
  text-2: var(--text-2)         # подписи
  text-3: var(--text-3)         # ghost, плейсхолдер
  accent: var(--accent)         # кнопки, активные, сфера
  accent-soft: color-mix(accent 14%, transparent)
  accent-line: color-mix(accent 45%, surface)
  ok/warn/err: как в themes.css
  scrim: #00000066  # затемнение модалки
```

Light-тема инвертирует bg→#F4F1EB, surface→#FFFDF9 и т.д. Контраст ≥4.5:1 проверяет `themes.test.js` [В].

## 4. Typography

**Семейства [В]:** Inter Variable (интерфейс) + IBM Plex Serif (крупные часы/заголовки-герои). Luxify G1 — Segoe UI [О], G2 — геометрический гротеск [О] — не берём, Inter остаётся (уже в Nox, OFL).

**Шкала (из themes.css + Nox):**

| Роль | Размер | Вес | Интерлиньяж | Где |
|---|---|---|---|---|
| display | 22/28 | 600 | -0.02em | `chat-empty h2` «С чего начнём?» |
| title | 16/20 | 600 | -0.01em | `nox-hist-title`, карточки |
| body | 13.5/20 | 400 | 0 | сообщения, md |
| body-strong | 13.5/20 | 600 | 0 | `turn::before` NOX |
| label | 11/14 | 600 | 0.04em upper | `turn::before`, `nox-hist-label` |
| caption | 12/16 | 500 | 0.02em | подписи, время |
| small | 11.5/14 | 400 | 0 | workspace-switch |
| mono | 12/16 | 500 | 0 | code, `rail-count` |

Luxify G2 держал шаг строк 29 при 15 [О] — воздух. Nox 20 при 13.5 — плотнее, для длинных ответов лучше — оставляем [П]. Заголовки не upper (у Luxify G1 upper [В] — устарело).

## 5. Spacing & Layout

**Шкала (из themes.css):** 4/8/12/16/24/32/48 — кратна 4 [В].

**Сетка Nox (референс Luxify [В]):**

| Зона | Luxify G2 | Nox сейчас | Nox R2 [П] |
|---|---|---|---|
| Rail | 15.2% (163/1074) | 52px (4.3% на 1200) | 52 / 46 <1000 — уже верно, узкая рейка — фишка Nox |
| History | — (нет) | 244px | 244 / 176 <1000 |
| Content (chat) | 43% (458) | 1fr (~540) | 1fr — верно |
| Orb | 40% (431, срезана) | 360px (30%) | 360 / 278 + опция anchored +64px |

Gap между панелями — 8px [В] (Luxify 22–23, но Nox плотнее — 8px уже в коде).

**Отступы панелей:** 16px outer, 12px inner (Nox), внутренний карточки 20px (Luxify [О]) — для карточки настроек берём 20px, для истории 12px.

## 6. Radius & Borders

| Токен | Значение | Где | Происхождение |
|---|---|---|---|
| `--r-sm` | 8px | кнопки-значки, поля | [В] Luxify icon-btn 8 [О], Nox r-sm 6 — поднимаем до 8 для консистентности [П] |
| `--r-md` | 10px | рейка-актив, инпуты | [В] Luxify 10 |
| `--r-lg` | 12px | окно | [В] Nox 12 |
| `--r-xl` | 16px | панели | [В] Nox 16 (Luxify 14) — оставляем 16 [П] — Nox крупнее |
| `--r-pill` | 999px | переключатели, плашки | [В] |

Бордер: 1px solid `border` (6–8% белого поверх surface) [О]. У активной строки истории — inset 1px 7% белого.

## 7. Shadows & Glass

- Тень окна: `0 16px 48px rgba(0,0,0,0.32)` — мягкая, как Luxify слабая тень [О].
- Тени панелей — нет, только бордер — плоско, как Luxify карточки [В].
- Стекло: `--glass: 72–86%` + `backdrop-filter: blur(22px)` уже в `themes.css` — Nox-экран его не использует, но может [П]: при `data-glass="on"` панели получают `var(--glass)` — для темы `glass`.

## 8. Motion Tokens

| Токен | Значение | Кривая | Где | Происхождение |
|---|---|---|---|---|
| `--dur-fast` | 120ms | ease-default 0.2,0,0,1 | hover, focus | [В] Nox |
| `--dur-normal` | 200ms | ease-out 0.16,1,0.3,1 | появление, `nox-rise` | [В] Nox = Luxify 170–270ms [О] |
| `--dur-slow` | 280ms | ease-out | модалки, approval | [В] Nox |
| `viewIn` | 320ms | ease-out | смена раздела | [П] — Luxify мгновенно [В] или 220ms [О] — берём 320ms для мягкости |
| `dialogRise` | 240ms | ease-out | модалки | [В] Nox |
| `scrimIn` | 240ms | ease | затемнение | [В] Nox |
| `orb-breath` | 2.1s | ease-in-out | сфера idle | [О] Luxify 2.1s, Nox 1.8s — синхронизируем на 2.1s [П] |

`prefers-reduced-motion: reduce` и `html[data-motion="off"]` отключают всё — уже есть [В].

## 9. Iconography

Линейные 1.5px, 16–18px, скруглённые концы (G2 [О]). В Nox — 18px в рейке, 16px в кнопках сферы, 14px в копировании — оставляем. Активная рейка — заливка accent-soft, не обводка.

## 10. Component Mapping

| Примитив Luxify [В] | Токен Nox | Комментарий |
|---|---|---|
| Карточка #232939 + бордер 1px | `surface` + `border` | Уже 1:1 |
| Таблетка-актив #4466FF | `accent` + `accent-soft` | Уже |
| Переключатель 51×22 | 48×24 — крупнее для доступа | [П] — доступность > пиксель-перфект |
| Ползунок 273 + ручка 18 | 100% + 16px ручка | Адаптивный |
| Кольца сферы 5× alpha 0.2–1.0 | Точки 1400 + ядро 200 | Nox не кольца [П] — сохраняем идентичность |

## 11. Недостатки текущих Nox-токенов и фиксы

| Недостаток | Риск | Фикс [П] |
|---|---|---|
| `nox-screen.css` изолирован от `themes.css` | Светлая тема не применяется | Алиасы на semantic (см. §1) |
| `--nox-accent: #2E9AC1` хардкодит циан | Кастомный акцент не доходит до сферы | `--nox-accent: var(--accent)` + `orb.setPalette(accent)` |
| Нет `--accent-soft` в Nox | Hover пятна разные | Добавить токен 14% (как в семантике) |
| `rail-w 52` фиксирован | На 864px тесно | Уже есть 46 <1000 — ок |
| Нет токена для `scrim` в Nox | Модалки без затемнения | `--scrim: var(--scrim)` из темы |

Все токены — CSS-переменные, без препроцессора — как сейчас.
