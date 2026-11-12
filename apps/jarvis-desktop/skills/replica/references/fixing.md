# Acting on a report

Each finding in **Fix next** ends with `(+n axis)`: roughly how many points that axis gains when the finding is fixed. The list puts gated axes first, then sorts by gain. `[1440x900, 390x844]` names the viewports where the finding occurs. "Same on N more" means repeated components share the same difference, so fix the shared style once.

## Findings

| finding | what it means | usual fix |
|---|---|---|
| **layout** · N elements sit Xpx too low/high… **Likely cause:** E is Ypx taller/shorter | Everything after E moved because E has the wrong size. The finding lists E's style differences. | Fix E (usually font-size, line-height, padding or wrapping). The others follow, so leave them alone. |
| **layout** · N elements sit… **Nothing before them changed size** | The gap just above the first of them differs. | Compare that element's `y` with the bottom (`y + h`) of the element before it in the outline, in the reference and in yours. Fix that margin, gap or padding. |
| **layout** · E — too low/high/left/right | E's position is wrong but its size is right. | Alignment (`justify`/`align`), container padding, margin, or centring. |
| **layout** · E — too wide/narrow/tall/short | E's size is wrong. | width/max-width/flex-basis/grid tracks; for text, font-size, letter-spacing, line-height, or different words wrapping. |
| **missing** · E (with N things inside) | The reference shows E and you have nothing like it there. | Build it. If the user asked for it to be dropped, list it as a known difference. |
| **extra** · yours has E | You paint something the reference doesn't. | Often browser defaults (button background or border, list bullets, a `body` margin) or a stray border or background. Remove it, or list it if the user asked for it. |
| **style** · E — prop ref (yours …) | A computed style differs. | Set exactly the reference value. A wrong `font-family` usually means the font never loaded: check `@font-face` src, weights and `next/font` config. |
| **pixels** · region … over E | Pixels differ there, and no layout or style finding explains it. | Open the named `-hotN.png`. Common causes: different image or crop, an SVG icon, gradient stops, `backdrop-filter`, font smoothing, variable-font axes, or canvas drawing. |
| **pixels** · … no measured element explains it | It's inside an image, canvas or background. | Compare the zoomed sheet. Check the image asset, `object-fit` and `background-position`. |
| **motion** · E — channel starts / lasts / goes / curve | One part of E's animation is off: start → delay or stagger · lasts → duration · goes A → B → distance or the from value · curve → easing. | Change exactly that parameter to the reference value the finding gives. |
| **motion** · E — … · N elements inside move with it and repeat this | E's own animation is off, and everything inside E inherits it (a card's spring moves its rows, text and icons). | Fix E only. The children's remaining findings are what they do on their own: a stagger, a pop, a spin. |
| **motion** · E animates in the reference … but nothing matching moves in yours | Your version doesn't animate, or the animation never triggers. | Check the trigger: the `IntersectionObserver` threshold for `reveal`, the hover selector, and the initial state. |
| **motion** · E moves in yours but not in the reference | An animation the reference doesn't have. | Remove it, or make it not move during the recorded action. |
| **motion** · motion starts/settles Xms late | From video references: when visible movement begins or ends. | Shift the delay or duration. |

## When the score stalls

- **Fonts**: look at `round-N/clone/<viewport>/shot.png`. Fallback fonts are obvious there. The clone's `blueprint.json` → `fonts.loaded` lists what actually loaded.
- **Wrong part compared**: check that the `--selector` you pass to `compare` selects your whole component and nothing else.
- **Wrong state**: hover and click states need the same `--action` on both sides; `compare` re-uses the reference's unless you override it.
- **Dev overlays and badges**: hide them with `--hide`.
- **The score went down** (▼ in the report): undo the last change first. Two half-fixes interacting is the usual cause.

## How the score works

- **Matching** pairs what is visible in the reference with what is visible in yours: identical text or image first (nearest wins), then kind, text similarity and position. Markup differences are normalised away. `<a><span>Go</span></a>` equals `<a>Go</a>`. A painted wrapper that hugs one child equals a child that paints itself. A single inset `0 0 0 1px` shadow equals a 1px border. A background the same colour as what is behind it doesn't count.
- **Layout**: the weighted share of reference elements whose box is within tolerance (structure 8px, faithful 3px, exact 1px, plus 4/2/1% of the size for width and height). The weight is √area, capped at 200. Missing elements score 0, and extra ones cost half their weight.
- **Style**: the weighted share of computed properties that match: font family, size, weight, line-height, letter-spacing, colour, text-transform and decoration, background, background image, radius, border, shadow, opacity, filters. Colours match within a small RGB distance and lengths within 0.5px.
- **Pixels**: 100 − 10 × (% of pixels that differ). Each pixel is compared by perceptual (YIQ) colour difference, with 1px of anti-aliasing tolerance in both directions.
- **Motion** (from URLs): moving elements are paired like still ones, then their segments channel by channel (x, y, width, height, opacity, rotation, colours). Each pair is scored on start and duration (±80/50/34 ms by level), distance (±10%) and curve shape (RMS ≤ 0.04). A child's segment that only repeats its moving parent's (same channel, same timing, on both sides) counts once, on the outermost parent. Elements weigh √area like layout, but never less than a 60×60 box, so a small spinner that doesn't spin still costs the pass. From videos: the per-frame pixel difference, plus when visible motion starts and settles.
- **Pass**: every gated axis for the level meets its gate. The overall score is the mean of the gated axes.
