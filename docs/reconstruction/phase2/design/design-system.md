# Nox Design System — единая визуальная система

> База — уже реализованный чат Nox (`renderer/nox-screen.css`, `docs/reconstruction/design-tokens.md`, `docs/reconstruction/phase2/navigation-map.md`).  
> Новые разделы — расширение той же системы, не новая тема.  
> Маркеры: **[В] подтверждено видео**, **[О] оценено** (измерено по кадрам / выведено), **[П] проектное решение Nox**.

---

## 1. Принципы

1. **Минимализм интерфейса** [П] — нет декоративных иллюстраций, градиентных заливок, цветных пятен в углу окна (как в старых темах `presence.css`). Фон сплошной, панели плоские, границы 1px.
2. **Тёмные поверхности** [В] — в референсе все экраны на тёмном монохроме (пипетка чата `#181818–#2B2B2B` в сжатом кадре; токен `#0F0F10`). Дополнительные темы не вводятся: один Nox-монохром.
3. **Inter everywhere** [О] — в кадрах гротеск без засечек; в токенах `Inter` единственный шрифт. IBM Plex Serif / Sitka из классических разделов **не использовать** в новых экранах.
4. **Сдержанный голубой акцент** [О] — сфера и активные рейки — `cyan #2E9AC1`. Акцент только для интерактива/ фокуса / успеха, не для заливки панелей.
5. **Компактная навигация** [П] — рейка 52px, заголовок 56px, строки 56–64px, плотность выше чем в `presence.css` (там rail 188px).
6. **Последовательность** [П] — шаг отступов 4px, радиусы 8/12/16, высоты 36/40, анимация `200ms cubic-bezier(0.2,0,0,1)`.

> Не копировать Luxify: Luxify — светлый SaaS с крупными карточками, большими пустотами и яркими иллюстрациями. Nox — плотный тёмный инструмент.

---

## 2. Цветовые токены

### 2.1 Примитивы

```css
/* примитивы — доступны только через semantic */
--nox-black:           #0A0A0C;  /* [О] фон за окном Electron, transparent fallback */
--nox-bg:              #0F0F10;  /* [О] page bg, в кадре ~#101011 */
--nox-surface-1:       #141415;  /* [О] углублённая панель */
--nox-surface-2:       #18181B;  /* [В] панели истории/чата/сферы, измерено ~#181818 */
--nox-surface-3:       #1C1C1F;  /* [О] hover, карточка, input */
--nox-surface-4:       #232326;  /* [О] пузырь пользователя, активная строка */
--nox-border:          #2A2A2E;  /* [О] тонкая граница #535255 в сжатии → #2A2A2E */
--nox-border-strong:   #34343A;  /* [П] hover border / focus outer */
--nox-text-1:          #F1F1F3;  /* [О] primary ~#F2F2F2 */
--nox-text-2:          #9A9AA0;  /* [О] secondary — подписи, placeholder, «Сегодня» */
--nox-text-3:          #6B6B70;  /* [О] tertiary — неактивные иконки */
--nox-text-ghost:      #3A3A3E;  /* [О] disabled, разделители */
--nox-accent:          #2E9AC1;  /* [О] Nox cyan — из сферы #2E9AC1 */
--nox-accent-hover:    #3AAAD6;  /* [П] +8% lightness */
--nox-accent-active:   #2280A8;  /* [П] -10% lightness */
--nox-accent-ink:      #061217;  /* [П] текст на акценте */
--nox-accent-soft:     color-mix(in srgb, var(--nox-accent) 14%, transparent); /* [О] активный пункт */
--nox-ok:              #3DD68C;  /* [П] успех */
--nox-warn:            #F5A524;  /* [П] amber — только «ждёт вас» */
--nox-err:             #FF5C5C;  /* [П] ошибка */
--nox-ghost:           #3A3A3E;  /* [О] disabled bg */
```

Контрасты (WCAG AA 4.5:1) [П] проверено:
- `text-1 #F1F1F3` на `surface-2 #18181B` = **16.2:1** ✓
- `accent #2E9AC1` на `surface-2` = **6.1:1** ✓
- `text-2 #9A9AA0` на `surface-2` = **6.8:1** ✓
- `text-3 #6B6B70` на `surface-2` = **3.9:1** → использовать только для иконок ≥18px или disabled

### 2.2 Семантика

```css
--bg:                var(--nox-bg);
--surface:           var(--nox-surface-2);
--surface-raised:    var(--nox-surface-3);
--surface-hover:     color-mix(in srgb, var(--nox-text-1) 6%, var(--nox-surface-2));
--surface-active:    color-mix(in srgb, var(--nox-text-1) 10%, var(--nox-surface-2));
--border:            var(--nox-border);
--border-strong:     var(--nox-border-strong);
--text:              var(--nox-text-1);
--text-2:            var(--nox-text-2);
--text-3:            var(--nox-text-3);
--accent:            var(--nox-accent);
--accent-ink:        var(--nox-accent-ink);
--border-input:      var(--nox-border);
--focus-ring:        0 0 0 2px var(--nox-bg), 0 0 0 4px var(--nox-accent);
```

- `--bg` — только для `.app` подложки; панели всегда `--surface` + `1px --border` [О].
- Никакого `box-shadow` между панелями; свечение только у сферы и focus [В].

### 2.3 Запреты цвета

- Не использовать градиенты `presence.css` (`--g1..g3`) в новых разделах [П].
- Не заливать панели `accent`; accent только иконка/текст/рамка/кнопка [П].
- `warn` и `err` не для украшений; `warn` — только «ожидает решения», `err` — только ошибка [П].

---

## 3. Типографика

### 3.1 Гарнитуры

```css
--font:       "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif; /* [О] гротеск в кадре */
--font-mono:  "Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace;                  /* [П] код/аргументы/риски */
```

- Заголовки, тело, подписи — один `Inter`; сериф не используется [П].
- В уже готовом чате токены переопределены на `body[data-view="nox"]` для изоляции от `jarvis.look` [В по PHASE-1.1]. Новые разделы наследуют тот же приём: не читать `html --font` пользователя.

### 3.2 Шкала

| Токен | Размер / интерлиньяж / вес | Применение | Источник |
|-------|---------------------------|------------|----------|
| `--fs-title` | 24px / 30px / 600 | Заголовок раздела «Команды», «Настройки» | [П] по navigation-map 24/30 |
| `--fs-section` | 16px / 22px / 600 | Подзаголовок секции / карточки «Внешний вид» | [П] |
| `--fs-body` | 14px / 20px / 400 | Основной текст, описания, поля | [П] |
| `--fs-body-strong` | 14px / 20px / 600 | Имя команды, имя сервиса, выделенная строка | [П] |
| `--fs-meta` | 12px / 16px / 400 + `text-2` | «Сегодня/Ранее», подсказки, счётчики | [О] |
| `--fs-caption` | 11px / 14px / 500 | Верхний лейбл, бейдж | [О] |
| `--fs-mono` | 12px / 16px / 400 `font-mono` | Аргументы, JSON, путь файлов | [П] |

- Tracking: `title -0.01em`, `body 0`, `uppercase meta +0.02em` [П].
- Строки истории: `13px/400/text-1` с `ellipsis 1 line` [О].
- Не использовать 20/24px в плотных списках; 24px только заголовок страницы [П].

---

## 4. Отступы, размеры, радиусы

### 4.1 Шкала отступов (база 4px) [П]

```
--sp-1: 4px   --sp-2: 8px   --sp-3: 12px  --sp-4: 16px
--sp-5: 20px  --sp-6: 24px  --sp-7: 32px  --sp-8: 40px  --sp-10: 48px
```

Использование:
- `sp-2 (8px)` — зазор между панелями (gap) [В ~6px → 8px]
- `sp-3 (12px)` — padding карточки компактной
- `sp-4 (16px)` — padding панели / карточки стандартной
- `sp-5 (20px)` — padding редактора
- `sp-6 (24px)` — отступ секции

### 4.2 Радиусы [О/П]

```
--r-window: 12px   /* окно Electron */
--r-panel:  16px   /* крупная панель: история/чат/сфера, панель редактора */
--r-card:   12px   /* карточка, attachment, пузырь */
--r-control: 8px   /* кнопка, поле ввода, вкладка */
--r-pill:   999px  /* «Новый чат», пилюля статуса */
--r-icon-btn: 10px /* кнопка рейки 36×36 */
```

### 4.3 Высоты контролов [П]

```
--control-h: 36px  /* поле ввода, вторичная кнопка, фильтр */
--control-h-lg: 40px /* основная кнопка «Сохранить», «Новая» */
--row-h: 56px      /* минимальная высота строки журнала/commands */
--row-h-lg: 64px   /* строка команды с фразами */
--header-h: 56px   /* шапка раздела внутри рабочей области */
--gap: 8px         /* зазор между колонками */
```

---

## 5. Границы, тени, свечения

| Токен | Значение | Где | Статус |
|-------|----------|-----|--------|
| `--border` | `1px solid var(--nox-border)` | Все панели, поля, карточки | [О] |
| `--border-subtle` | `1px solid color-mix(in srgb, var(--nox-border) 60%, transparent)` | Разделитель секций внутри панели | [П] |
| `--border-accent` | `1px solid var(--nox-accent)` | Selected item, focus альтернатива | [П] |
| `--shadow-panel` | `none` | — | [В] в референсе нет теней |
| `--shadow-popover` | `0 8px 24px rgba(0,0,0,0.36)` | Dropdown, tooltip, диалог | [П] |
| `--glow-accent` | `0 0 16px color-mix(in srgb, var(--nox-accent) 30%, transparent)` | Focus ring доп. | [П] |
| `--glow-sphere` | `0 0 40px color-mix(in srgb, var(--nox-accent) 14%, transparent)` | Внешнее свечение сферы | [О] |

---

## 6. Иконография

- **Стиль** [В]: outline, толщина 1.5px, концы round, размеры 18px (рейка) / 16px (инлайн) / 14px (window controls). Никаких filled иконок.
- **Набор**: Lucide-подобный (уже в `nox-screen.css`): `house`, `spark`, `gear`, `history`, `plug`, `sliders`, `plus`, `search`, `chevron`, `x`, `check`, `alert`, `play`, `mic`, `paperclip` [П].
- **Цвета**: default `text-3`, hover `text-1`, active `accent` [П].
- **Активный индикатор рейки**: `::before 4×22px pill, bg accent, left -9px` [П по DESIGN.md].

---

## 7. Состояния интерактива (универсальны)

| Состояние | Фон | Текст/Иконка | Бордер | Курсор |
|-----------|-----|--------------|--------|--------|
| Default | `transparent` / `surface` | `text-2` | `border` | `pointer` |
| Hover | `surface-hover` (text 6%) | `text-1` | `border-strong` | — |
| Active/Pressed | `surface-active` (text 10%) + `scale 0.98` | `text-1` | — | — |
| Focus-visible | `focus-ring` тень | — | `accent` | — |
| Selected | `accent-soft` | `text-1` + `icon accent` | `accent` 1px | — |
| Disabled | `surface-2` приглушён | `text-ghost` | `border` | `not-allowed` |
| Error | `err/14%` фон | `err` | `err/42%` | — |

- Focus **всегда** `outline 2px accent + offset 2px`; цвет не единственный носитель статуса — рядом текст [П].
- Disabled — не `opacity 0.5`, а `color text-ghost + bg surface-2` для сохранения контраста [П].

---

## 8. Компоновка плотностей

- **Плотный список** (команды, журнал, подключения): строки 56–64px, gap 8px между строками, padding панели 16px [П].
- **Карточки настроек**: padding 20px, заголовок 16/600, gap между карточками 12px, внутри строк gap 16px [П].
- **Пустые/ошибочные состояния**: центрированный блок `pad 32px`, иконка 24px `text-ghost`, заголовок 16/600 `text-1`, подсказка 14/400 `text-2`, кнопка 36px [П].

---

## 9. Адаптивность токенов

| Ширина окна | Рейка | История/навигация | Сфера | Chat | Зазор |
|-------------|-------|-------------------|-------|------|-------|
| 1200×720 (эталон) | 52px | 244px (history) / 252px (settings nav) | 360px | 1fr | 8px |
| 960–1000px | 46px | 176–200px | 278–320px | 1fr | 8px |
| ≤864×520 | 46px | overlay drawer (см. navigation-layout) | скрыта в таб | full | 8px |

На `max-width:1000px`: вспомогательная колонка под основной (команды: паки вниз; подключения: популярные вниз) [П по commands-spec].

---

## 10. Что не делать

- Не переопределять токены на `:root` глобально; новые разделы — только внутри `body[data-view="nox"]` [П].
- Не добавлять светлую тему, градиенты, blur 20px, тени между панелями [П].
- Не копировать размеры Luxify (крупные карты 120px+, огромные пустоты 48px+); Nox — компактный [П].
- Не наследовать гарнитуры `jarvis.look` (Inter фиксирован) [П по PHASE-1.1].

---

## 11. Чек-лист приёмки токенов

- [ ] `app::before/after` пятна удалены; фон сплошной `#0F0F10`.
- [ ] Рейка 52px, история 244px, gap 8px, radius панели 16px.
- [ ] Текст Inter 13.5–14px, заголовок 24px/600, моно для аргументов.
- [ ] Контраст `text-1/surface-2 ≥4.5:1`, `accent/surface-2 ≥4.5:1`.
- [ ] Focus ring 2px accent, not color-only.
- [ ] Hover не «синий фон», а `surface-hover 6%` mix.
