# Дизайн-токены Luxify (как наблюдалось)

Это **замеры источника**, а не токены для Nox. Как применять их в Nox, решает следующий этап (см. `MUSE-HANDOFF.md`). Дост.: [В] — значение показано в интерфейсе или прямо измерено; [О] — оценка по кадрам.

Пиксели приведены к **G2 (IMG04)**. Для G1 из V08 пересчитано ×1/0.6, это оценка.

```yaml
source: luxify
generation: G2 (v2.0)        # G1 отличия — в конце файла

color:
  accent:            "#4466FF"   # [В] поле «Цвет темы» в настройках G1; на видео G2 ≈ #4486FF [О]
  accent-alt-themes: [indigo, violet, magenta, green, orange, crimson, white, custom-hex]   # [В] V08, V04
  bg-window:         "#0A0A0A"   # [В] поле «Цвет фона» в настройках G1; на экране с прозрачностью ≈ #0A0D1C…#171C2F [О]
  window-opacity:    0.80        # [В] «Прозрачность 20%» → непрозрачность 0.8 (если ползунок = прозрачность)
  window-blur:       "30%"       # [В] «Размытие 30%»; в пикселях неизвестно
  rail:              "#141B2C"   # [О]
  surface-card:      "#262D40"   # [О] над фоном #171C2F
  surface-card-2:    "#232939"   # [О]
  surface-input:     "#202333"   # [О]
  surface-ai-reply:  "#191D29"   # [О]
  surface-step-chip: "#111521"   # [О]
  surface-modal:     "#1A1C22…#20222E"  # [О]
  border-card:       "rgba(255,255,255,~0.06–0.08)"  # [О] видна как 1 px светлее
  toggle-off-track:  "#242730"   # [О]
  slider-track:      "#45484F"   # [О]
  text-1:            "#E8EAEE"   # [О]
  text-2:            "#9CA3AD"   # [О]
  text-3:            "#737A8C"   # [О]
  success:           "#36DA7E"   # [О] V02 (макет); IMG11 точка «Подключено» #4EB04F
  warning:           orange      # [О] подсветка важных писем, щит
  orb-ring-alpha:    [0.20, 0.52, 0.81, 0.96, 1.00]   # [О] доля акцента поверх фона, снаружи → внутрь (V08)

radius:
  window:   14       # [О]
  card:     14       # [О] IMG04
  nav-pill: 10       # [О]
  button:   10       # [О]
  icon-btn: 8        # [О]
  input:    10       # [О]
  pill:     999      # переключатели, плашки, «таблетки» вкладок [В]

space:
  card-gap:        22   # [О] IMG04 (G1: 15 видео-px ≈ 25 px экрана)
  card-padding:    20   # [О]
  rail-to-content: 22   # [О]
  nav-pitch:       48   # [О]
  list-row-pitch:  29   # [О] строки журнала
  control-row:     30   # [О] строки переключателей

size:
  window-aspect:   1.52   # [В] IMG04 (G1: 1.616)
  rail-width:      163    # [О] 15% окна (G1: 62 видео-px ≈ 103 px экрана, только значки)
  rail-collapsed:  "≈ 60–70"   # [О] V04 13 с
  nav-item:        [138, 41]
  content-column:  "43% ширины окна"
  orb-zone:        "40% ширины окна, сфера срезана правым краем"
  header-mic-btn:  38
  toggle:          [51, 22]   # ручка 16
  slider-track-h:  4…6        # ручка 18
  catalog-card:    [486, 125] # IMG08
  agent-card:      "≈ 400×80 при 1920×1080"  # [О] V02, макет

type:
  family-g2:  "геометрический гротеск (похож на Manrope/Onest/Gilroy)"   # [О], файл шрифта не найден
  family-g1:  "Segoe UI"   # [О]
  header:     {size: 20, weight: "400 + 600"}   # «Luxify Assistant | Главная»
  card-title: {size: 17, weight: 600}
  body:       {size: 15, weight: 400}
  nav:        {size: 15, weight: 500}
  caption:    {size: 13, weight: 400, color: text-2}
  numeric-xl: {size: "28–40", weight: 600}     # погода, курсы
  line-height-list: 1.9
  g1-page-title: {case: upper, size: "≈30 экрана", weight: 600}   # [В] заглавные

motion:   # подробности и происхождение — MOTION-ANALYSIS.md
  page-enter-g1b:   {duration: "220–270ms", easing: "ease-out", stagger: "≈50ms (шапка → список)"}   # [О] V07
  page-enter-g1:    {duration: "0 (2 пустых кадра ≈ 33ms, затем мгновенно)"}                          # [В] V08
  modal-enter:      {duration: "≤ 33ms (2 кадра)"}       # [В] V07
  context-menu:     {duration: "≈ 67ms (4 кадра)"}       # [О] V07
  tree-expand:      {duration: "≤ 33ms"}                 # [О] V07
  orb-breath:       {period: "≈ 2.1s", amplitude: "±2.2% радиуса (±6.4 видео-px на внешнем кольце)", inward-lag: "≈ 0.33s на кольцо"}  # [О] V08
  color-preview:    "мгновенно, во время перетаскивания в палитре"   # [В] V08
```

## Отличия G1

| Токен | G1 |
|---|---|
| Рейка | только значки, ≈ 62 видео-px; активный значок в рамке 36×36 с светлым фоном |
| Заголовок страницы | заглавными, без «Luxify Assistant \|» |
| Переключатель выкл | ручка акцентная, дорожка тёмная (в G2 ручка серая) |
| Ползунок | сплошная толстая полоса, ручки нет |
| Окно | пропорция 1.616 |
| Акцент | #4466FF [В] |
| Фон | #0A0A0A, прозрачность 20%, размытие 30% [В] |
