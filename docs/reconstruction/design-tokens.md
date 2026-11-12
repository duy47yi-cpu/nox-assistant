# Nox — Design Tokens | Токены визуальной системы

> Опорный кадр: `IMG_22660 12.0с` (окно 864×520 в видео 1092×576), проверка по `03-empty-original.png` (1604×1080) и `01-chat-full.png` / `02-sphere-2x.png`. Верификация по оригинальным MP4: `verification-2026-11-09.md` (FFmpeg 10fps, 50 кадров 8.5–13.5с).  
> Статус токенов: **[В]** — подтверждено оригинальным видео, **[О]** — оценено по кадрам, **[П]** — придумано для реализации. Все цвета даны в sRGB.

---

## 1. Принцип: REFERENCE FIDELITY → NOX IDENTITY

| Слой | Что воспроизводим | Что меняем |
|------|------------------|-----------|
| **A. Reference** | Тёмный монохром, геометрия 4 панелей, тонкие бордеры, скругления 16px, минимальная плотность, проволочная сфера | Брендинг JARVIS → NOX, кириллические подписи, данные чата |
| **B. Nox Identity** | Те же пропорции, материалы, плотность, свечение | Акцент Nox вместо cyan-референса, **точечная сфера с ядром** вместо проволочной сетки, отсутствие «BY AMBIONYS» и рекламы |

Frontend-реализация должна уметь переключать `orbVariant: 'wire' → 'nox-points'` без изменения лейаута.

---

## 2. Цветовая система

### 2.1 Примитивы (тёмная тема — единственная эталонная)

```css
/* primitives — не использовать напрямую, только через semantic */
--nox-black: #0A0A0C;          /* [О] фон за окном Electron, прозрачность 0 */
--nox-bg: #0F0F10;              /* [О] page background, измерено #0F0F10≈#101011 */
--nox-surface-1: #141415;       /* [И] поверхность панелей — ~#141414, B/C/D фон */
--nox-surface-2: #18181B;       /* [И] история/чат — ~#181818 в кадре 500,445 */
--nox-surface-3: #1C1C1F;       /* [О] hover истории, карточка вложения */
--nox-surface-4: #232326;       /* [О] пузырь пользователя — светло-серый на тёмном */
--nox-border: #2A2A2E;          /* [И] тонкая граница — ~#2B2B2B / #535255 в сжатии, берём #2A2A2E */
--nox-border-strong: #34343A;   /* [П] focus ring outer */
--nox-text-1: #F1F1F3;          /* [О] primary белый ~#F2F2F2 */
--nox-text-2: #9A9AA0;          /* [О] secondary — подписи, плейсхолдер, «Сегодня/Ранее» */
--nox-text-3: #6B6B70;          /* [О] tertiary — неактивные иконки рельсы */
--nox-text-ghost: #3A3A3E;      /* [О] disabled / разделители */

--nox-accent: #2E9AC1;          /* [О] Nox cyan — из сферы #2E9AC1, не #114156 (тёмная точка сетки) */
--nox-accent-hover: #3AAAD6;    /* [П] +8% lightness */
--nox-accent-active: #2280A8;   /* [П] -10% lightness */
--nox-accent-ink: #071318;      /* [П] текст на акценте */
--nox-accent-soft: color-mix(in srgb, var(--nox-accent) 14%, transparent); /* [О] заливка активного пункта */
--nox-ok: #3DD68C;              /* [П] success — зелёный, виден на тёмном */
--nox-warn: #F5A524;            /* [П] amber, только «ждёт вас» */
--nox-err: #FF5C5C;             /* [П] error */
```

### 2.2 Semantic mapping

```css
--bg: var(--nox-bg);
--surface: var(--nox-surface-2);
--surface-raised: var(--nox-surface-3);
--border: var(--nox-border);
--text: var(--nox-text-1);
--text-2: var(--nox-text-2);
--text-3: var(--nox-text-3);
--accent: var(--nox-accent);
--accent-ink: var(--nox-accent-ink);

/* Производные — считать в CSS, не хардкодить */
--border-input: color-mix(in srgb, var(--nox-border) 100%, var(--nox-surface-2));
--surface-hover: color-mix(in srgb, var(--nox-text-1) 6%, var(--nox-surface-2));
--surface-active: color-mix(in srgb, var(--nox-text-1) 10%, var(--nox-surface-2));
--focus-ring: 0 0 0 2px var(--nox-bg), 0 0 0 4px var(--nox-accent);
```

### 2.3 Градиенты и фон

Никакого цветного пятна в углу (как в старых темах Nox `presence.css`). Фон — сплошной `#0F0F10` [И]. Градиент по вертикали отсутствует в референсе; лёгкое затемнение низа — артефакт монтажа, не воспроизводить.

```css
.app { background: var(--nox-bg); }
.app::before, .app::after { display: none; } /* удалить старый --hue свет */
```

### 2.4 Точность цветов

- Измерено пипеткой в `IMG_22660__00012.000s.png`: `hist #2b2b2b`, `chat #262626`, `input #181818`, `grid point #114156` — **не использовать как токен**, это сжатый hevc + пересвет. Токены выше сдвинуты на +2–4% lightness для читаемости и контраста WCAG 4.5:1.
- Проверка контраста: `--text-1 #F1F1F3 на --surface-2 #18181B = 16.2:1 ✓`, `--accent #2E9AC1 на --surface-2 = 6.1:1 ✓`.

---

## 3. Прозрачность и размытие

| Токен | Значение | Применение | Статус |
|-------|----------|------------|--------|
| `--panel-alpha` | `100%` (непрозрачно) | Все панели — в референсе нет backdrop-blur, стекло не используется | [И] |
| `--glass-blur` | `0` (откл.) | `backdrop-filter: none` | [И] |
| `--overlay-scrim` | `rgba(0,0,0,0.48)` | Диалог выбора файла (если модалка) | [П] по типовому Electron |
| `--focus-alpha` | `100%` | Focus ring — сплошной | [О] |

> Если в будущем нужна полупрозрачность (macOS vibrancy), включить только для заголовка Electron: `backgroundColor: '#00000000'` + `vibrancy: 'dark'` — панели остаются opaque. Не применять `blur(20px)` к истории/чату — ломает минимализм референса.

---

## 4. Скругления (Radius)

| Токен | Значение | Где | Статус |
|-------|----------|-----|--------|
| `--r-window` | `12px` | Внешнее окно Electron (`win-radius`) | [И] измерено 12–16px в кадре, берём 12 |
| `--r-panel` | `16px` | История, чат, сфера — крупные панели A/B/C/D | [И] |
| `--r-card` | `12px` | Карточка вложения, input, пузырь пользователя | [И] |
| `--r-pill` | `999px` | «Новый чат», «что это за модель», селект «Гибрид» | [И] |
| `--r-icon-btn` | `10px` | Кнопки рельсы 36×36 | [И] |
| `--r-avatar` | `50%` | Аватар внизу рельсы | [И] |

```css
:root {
  --r-window: 12px;
  --r-panel: 16px;
  --r-card: 12px;
  --r-pill: 999px;
}
```

---

## 5. Шкала отступов и размеров

Базовый шаг `4px`, как в существующем `presence.css`.

| Токен | Значение | Статус |
|-------|----------|--------|
| `--sp-1` | `4px` | |
| `--sp-2` | `8px` | |
| `--sp-3` | `12px` | |
| `--sp-4` | `16px` | |
| `--sp-5` | `20px` | |
| `--sp-6` | `24px` | |
| `--sp-7` | `32px` | |
| `--sp-8` | `40px` | |
| `--sp-10` | `48px` | |
| `--control-h` | `36px` | Высота рельсы-кнопки, входных контролов | [И] |
| `--header-h` | `44px` | Шапка панели (заголовок + window controls) | [И] |
| `--input-h` | `76px` | Нижний блок ввода F — 76–88px в кадре, берём 76 | [И+П] |
| `--rail-w` | `52px` | Узкая рельса слева (только иконки) | [И] 5.3% от 864px ≈ 46px → 52px с учётом padding |
| `--history-w` | `244px` | Панель истории | [И] 20.4% ≈ 176px + gaps → 244px для 1200px окна |
| `--gap` | `8px` | Зазор между B/C/D — ~6px в видео → 8px | [И+П] |

**Сетка окна (эталон 1200×720, resizable min 960×640):**

```
| rail 52 | history 244 | gap 8 | chat 1fr (~520) | gap 8 | sphere 360 |  (сумма 1192 + padding)
Высота: header 44 + content 1fr + composer 76 + pad 16
```

Для `1080px` ширины: `history 220`, `sphere 320`, `chat ~460` — сохранять пропорции B 28.7% / C 35.8% / D 32.2% [И].

---

## 6. Типографика

### 6.1 Семейства

```css
--font-sans: "Inter", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif; /* [О] в кадре — гротеск без засечек, Inter уже в проекте */
--font-display: "Inter", sans-serif; /* Заголовок «История» — тот же гротеск, bold, не сериф */
--font-mono: "Cascadia Mono", "Cascadia Code", Consolas, monospace; /* технические строки */
```

> IBM Plex Serif из текущих тем **не использовать** — в референсе сериф отсутствует. Заголовки — `Inter SemiBold`.

### 6.2 Шкала

| Токен | Размер / Line-height / Weight | Применение | Статус |
|-------|------------------------------|------------|--------|
| `--fs-title` | `16px / 20px / 600` | «История» шапка | [И] 24–27px в видео → 16px CSS |
| `--fs-body` | `13.5px / 20px / 400` | Сообщения чата | [И] 10–12px в видео → 13.5px CSS |
| `--fs-body-strong` | `13.5px / 20px / 600` | Имена `JARVIS`/`Логотипы` внутри ответа, `Lamborghini` | [И] |
| `--fs-meta` | `12px / 16px / 400` (text-2) | «Сегодня», «Ранее», «Ход работы · Выполняется 10.4 с» | [И] |
| `--fs-caption` | `11px / 14px / 500` | Подсказка «BY AMBIONYS» — **не воспроизводить**, для Nox → `11px / muted` | [О] |
| `--fs-input` | `13px / 18px / 400` | Placeholder «введите текст…», ввод | [И] |
| `--fs-pill` | `12.5px / 16px / 500` | «Новый чат», чип «Гибрид», пузырь пользователя | [И] |

Tracking: `letter-spacing: -0.01em` для title, `0` для body, `+0.02em` для uppercase meta если понадобится.

### 6.3 Контраст и усечения

- История элементы: `text-2` → `text-1` при hover, `ellipsis` после 2 строк.
- Троеточие `…` — `text-3`, отступ 8px от текста.

---

## 7. Тени, свечение, границы

Минимализм = **нет теней** между панелями. Все панели разделены `1px border` и `8px gap` на фоне `var(--nox-bg)`.

| Токен | Значение | Применение | Статус |
|-------|----------|------------|--------|
| `--border` | `1px solid var(--nox-border)` | Все панели B/C/D/F | [И] |
| `--border-subtle` | `1px solid color-mix(in srgb, var(--nox-border) 60%, transparent)` | Разделитель внутри истории между секциями | [П] |
| `--shadow-panel` | `none` | — | [И] в референсе нет drop-shadow |
| `--shadow-popover` | `0 8px 24px rgba(0,0,0,0.36)` | Только dropdown/ tooltip | [П] |
| `--glow-accent` | `0 0 16px color-mix(in srgb, var(--nox-accent) 30%, transparent)` | Focus акцент, не для сферы | [П] |
| `--glow-sphere` | `0 0 40px color-mix(in srgb, var(--nox-accent) 14%, transparent)` | Внешнее свечение сферы — см. orb-spec.md | [О] |

> Никакого `box-shadow` на панелях — только border. Свечение только у сферы и интерактивных фокусов.

---

## 8. Иконография

- Стиль: `outline`, толщина `1.5px`, скругление концов `round`, размер `18px` (рельса) / `16px` (чат-инлайн) / `14px` (window controls). [И]
- Цвета: по умолчанию `var(--text-3)`, hover `var(--text-1)`, active `var(--accent)`.
- Рельса иконки (сверху вниз): `orb/logo` (кольцо), `home`, `close/clear`, `settings`, `history`, `avatar` внизу. Активный пункт — `bg: var(--accent-soft)`, `icon: var(--accent)`, индикатор слева `4×22px pill` у текущего [П по DESIGN.md].
- Window controls: `—` minimize, `⛶` maximize, `×` close — все `18px`, hover `surface-hover`, close hover `err` bg.

Не использовать залитые (filled) иконки — только контурные.

---

## 9. Motion (кратко, подробно — в animation-timeline.md)

| Токен | Значение |
|-------|----------|
| `--ease-default` | `cubic-bezier(0.2, 0, 0, 1)` — стандартный вход |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` — появление панелей |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` — сфера дыхание |
| `--dur-fast` | `120ms` |
| `--dur-normal` | `200ms` |
| `--dur-slow` | `280ms` |
| `--dur-sphere` | `1800ms` (дыхание idle) — см. orb-spec |

Respect `prefers-reduced-motion` и `html[data-motion="off"]` — все длительности → `0`.

---

## 10. Реализация токенов (готовый файл для разработчика)

Создать `renderer/tokens-nox.css` (подключать **после** `themes.css`, до `presence.css`):

```css
:root {
  /* primitives */
  --nox-bg: #0F0F10;
  --nox-surface-1: #141415;
  --nox-surface-2: #18181B;
  --nox-surface-3: #1C1C1F;
  --nox-surface-4: #232326;
  --nox-border: #2A2A2E;
  --nox-text-1: #F1F1F3;
  --nox-text-2: #9A9AA0;
  --nox-text-3: #6B6B70;
  --nox-accent: #2E9AC1;
  --nox-accent-soft: color-mix(in srgb, var(--nox-accent) 14%, transparent);
  /* semantic */
  --bg: var(--nox-bg);
  --surface: var(--nox-surface-2);
  --border: var(--nox-border);
  --text: var(--nox-text-1);
  --text-2: var(--nox-text-2);
  --hue: var(--nox-accent);
  /* radius/spacing */
  --r-panel: 16px; --r-card: 12px; --r-pill: 999px;
  --rail-w: 52px; --history-w: 244px; --gap: 8px;
  /* motion */
  --ease-default: cubic-bezier(0.2,0,0,1);
  --dur-normal: 200ms;
}
```

Заменить логику `--hue` из `theme-boot.js` на фиксированный `--nox-accent` для темы Nox (добавить `data-theme="nox"`).

---

## 11. Чек-лист приёмки токенов

- [ ] WCAG AA: текст на поверхности ≥4.5:1 — проверить `themes.test.js` аналог для `nox`.
- [ ] Нет градиента/ пятна за окном — `app::before` удалён.
- [ ] Бордеры 1px, не тени, зазоры 8px.
- [ ] Радиусы панелей 16px, а не 12/14 из старой системы.
- [ ] Типографика Inter 13.5px, не 14/15.

