# Reading a blueprint

`ref/blueprint.md` is written for you. `ref/<viewport>/blueprint.json` holds the same data plus every node, every CSS variable and inline SVG markup. Each `<viewport>/outline.md` has the full outline for that viewport.

## What counts as a node

Replica records only what a visitor can see. It ignores the markup that produces it.

| kind | what it is |
|---|---|
| `heading` | `h1`–`h6` |
| `text` | any element with its own text (`p`, `span`, `li`, `label`…) |
| `link`, `button` | `a`, and `button` or `[role=button]`, with their full text |
| `field` | `input`, `textarea`, `select` (value or placeholder as text) |
| `media` | `img`, `svg`, `video`, `canvas`, `iframe` |
| `box` | an element that paints: a background that differs from what is behind it, a background image, a border or a shadow |
| `layout` | an unpainted flex or grid container. Shown for structure, not scored. |

Elements that are invisible (opacity ≈ 0 or `visibility: hidden`) and plain wrappers don't appear. Your clone may use different tags, wrappers and class names; only the visible result is compared.

## Outline syntax

```
- a.btn.primary link "Get started" [576,328 125×50] · 700 16/24 Arial · #ffffff · center · bg #5b4bff · radius 8px · pad 12 20 12 20 #4
```

| piece | meaning |
|---|---|
| `a.btn.primary` | tag and its first three classes (a hint only; you don't need the same classes) |
| `link` | kind |
| `"Get started"` | text (up to 80 characters here; the full text is in JSON) |
| `[576,328 125×50]` | x,y from the root's top-left, then width×height, in CSS px |
| `700 16/24 Arial` | font-weight, font-size/line-height in px, first font family |
| `ls -1` | letter-spacing in px (divide by font-size to get em) |
| `#ffffff` | text colour. 8-digit hex has alpha: `#ffffff14` is white at 8%. |
| `center` | text-align (shown when not start/left) |
| `bg`, `bg-image` | background colour, gradient or image (colours are converted to hex) |
| `radius` | border-radius, as computed |
| `border 1 #e6e6ea` | border width in px and colour. Four numbers mean top right bottom left. |
| `shadow` | box-shadow as computed: `color x y blur spread [inset]` |
| `pad 12 20 12 20` | padding top right bottom left |
| `flex row gap 12 jc … ai …` | display flex, direction, gap (row/column when they differ), justify-content and align-items when not default |
| `grid cols[421.3px 421.3px 421.3px] gap 24` | resolved grid tracks. Equal tracks usually mean `repeat(3, 1fr)`. |
| `fixed` / `sticky` / `absolute` | position, when it is not static or relative |
| `seen at opacity 0.6` | how opaque it looks after ancestors' opacity is applied |
| `#4` | node id, for looking it up in `blueprint.json` |

Indentation follows the visual nesting of recorded nodes, not raw DOM depth.

## Tokens

These are aggregated from the outline with usage counts. Map them into the project's token system first. The CSS-variable line lists the reference's own design tokens (`--accent: #5b4bff`); keep their names when the project has no conventions of its own. `font files` and `font stylesheets` show where the fonts come from.

## Responsive section

For each extra viewport, this lists only what changed against the primary one: layout switches (`grid 3 cols → 1 col`), font changes (`56/64 → 36/44`), padding changes, and elements hidden or shown. These are your media-query rules. Write them as the project already writes breakpoints.

## Motion timeline

```
| 120 | p "Replica measures…" [460,248 520×56] | y +24px → rest, opacity 0 → 1 | 600 | out-cubic (cubic-bezier(0.33, 1, 0.68, 1)) |
```

- **start**: ms after the action. Starts and durations are fitted below frame precision.
- **change**: `y +24px → rest` means the element starts 24px below its final place, so animate from `translateY(24px)` to none. Width or height changes `(×0.97 of final)` usually mean `scale(0.97)`. `opacity`, `rotate`, `text color` and `background` are given as from → to.
- **duration**: a trailing `+` means it was still moving when the recording ended (a loop, or a recording that was too short).
- **easing**: either a named curve with its exact cubic-bezier, `≈ cubic-bezier(…)` for a custom fit, a spring (overshoot %, stiffness, damping, mass 1), or a velocity for continuous motion.
- Children that only move because their parent moves are left out. Animate the parent.

**Declared animations** are read straight from the page's CSS animations, transitions and Web Animations: exact duration, delay, easing (including per-keyframe easing) and keyframes. When an element has one, use it instead of the fitted values. JavaScript-driven motion (GSAP, Framer Motion springs, animation-frame loops) appears only in the timeline.

## blueprint.json fields

`nodes[]`: `id`, `p` (parent id), `k` (kind), `tag`, `cls`, `text`, `src`, `alt`, `path`, `box` `[x,y,w,h]`, `svg` (inline markup for SVGs under 4 KB), and `s` (style):
`ff` font-family · `fs` size · `fw` weight · `lh` line-height · `ls` letter-spacing · `c` colour · `tt` text-transform · `fst` font-style · `td` text-decoration · `ta` text-align · `bg` · `bgi` · `r` radius · `bw`/`bc` border width/colour · `sh` shadow · `o` own opacity · `eo` seen opacity · `fl` filter · `bf` backdrop-filter · `pos` · `lay` · `pad`.

Other keys: `vars` holds every `:root` custom property with its value, `fonts` holds `@font-face` rules, loaded faces and font stylesheets, and `declared` holds the declared animations.
