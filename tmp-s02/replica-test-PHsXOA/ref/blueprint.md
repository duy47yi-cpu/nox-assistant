# Replica blueprint — Reference

Source: file:///D:/nox-release/apps/jarvis-desktop/skills/replica/scripts/test/fixtures/ref.html · action `load` · level `faithful` · captured 2026-11-11T10:19:41.803Z

Build from these measurements, not from memory or habit: every value was read from the rendered page. Boxes are `[x,y w×h]` in CSS px from the root's top-left; `#n` ids point into `<viewport>/blueprint.json`. Look at `1440x900/shot.png` and `motion/filmstrip.png` alongside this file.

## Tokens (1440x900)

- fonts: Arial (400, 700)
- type scale (size/line-height px): 56/64 · 20/28 · 18/28 · 16/24 · 15/24
- text colors: #0b0b0f ×5 · #5b5b66 ×4 · #ffffff ×1
- backgrounds: #5b4bff ×1
- borders: 1px #e6e6ea ×4
- radii: 12px ×3 · 8px ×2
- shadows: #0000000f 0px 1px 2px 0px ×3
- spacing in use (padding/gap px): 24 ×14 · 12 ×5 · 64 ×4 · 20 ×4 · 96 ×2 · 72 ×1
- css variables (4): --ink: #0b0b0f · --muted: #5b5b66 · --accent: #5b4bff · --line: #e6e6ea
- media: —

## Outline (1440x900, root 1440×900)

- section.hero layout [0,0 1440×450] · pad 96 64 72 64 · flex column gap 24 ai center #14
  - h1 heading "Ship interfaces that feel exactly right" [340,96 760×128] · 700 56/64 Arial ls -1 · #0b0b0f · center #0
  - p text "Replica measures your rebuild against the reference and tells you what to chang…" [460,248 520×56] · 400 18/28 Arial · #5b5b66 · center #1
  - div.actions layout [576,328 288×50] · flex row gap 12 #2
    - a.btn.primary link "Get started" [576,328 125×50] · 700 16/24 Arial · #ffffff · center · bg #5b4bff · radius 8px · pad 12 20 12 20 #3
    - a.btn.ghost link "Read the docs" [713,328 151×50] · 700 16/24 Arial · #0b0b0f · center · radius 8px · border 1 #e6e6ea · pad 12 20 12 20 #4
- section.cards layout [0,450 1440×206] · pad 0 64 96 64 · grid cols[421.328px 421.328px 421.344px] gap 24 #15
  - div.card box [64,450 421×110] · radius 12px · border 1 #e6e6ea · shadow #0000000f 0px 1px 2px 0px · pad 24 24 24 24 #5
    - h3 heading "Measure" [89,475 371×28] · 700 20/28 Arial · #0b0b0f #6
    - p text "Boxes, styles, pixels and motion from both pages." [89,511 371×24] · 400 15/24 Arial · #5b5b66 #7
  - div.card box [509,450 421×110] · radius 12px · border 1 #e6e6ea · shadow #0000000f 0px 1px 2px 0px · pad 24 24 24 24 #8
    - h3 heading "Compare" [534,475 371×28] · 700 20/28 Arial · #0b0b0f #9
    - p text "Every difference ranked by what fixing it is worth." [534,511 371×24] · 400 15/24 Arial · #5b5b66 #10
  - div.card box [955,450 421×110] · radius 12px · border 1 #e6e6ea · shadow #0000000f 0px 1px 2px 0px · pad 24 24 24 24 #11
    - h3 heading "Converge" [980,475 371×28] · 700 20/28 Arial · #0b0b0f #12
    - p text "Fix the top of the list, run it again, repeat." [980,511 371×24] · 400 15/24 Arial · #5b5b66 #13

## Responsive: 390x844 (root 390×856) — changes vs 1440x900; full outline in `390x844/outline.md`

- section .hero: pad 96 64 72 64 → 64 20 48 20
- h1 "Ship interfaces that feel exactly right": font 56/64 → 36/44
- section .cards: grid cols[421.328px 421.328px 421.344px] gap 24 → grid cols[350px] gap 24
- section .cards: pad 0 64 96 64 → 0 20 48 20

## Motion (1440x900, action `load`, 30 fps, t = 0 at the action)

| start ms | element | change | duration ms | easing |
|---|---|---|---|---|
| 0 | h1 "Ship interfaces that feel exactly right" [340,96 760×128] | y +24px → rest, opacity 0 → 1 | 600 | out-cubic (cubic-bezier(0.33, 1, 0.68, 1)) |
| 120 | p "Replica measures your rebuild against the refer…" [460,248 520×56] | y +24px → rest | 600 | out-cubic (cubic-bezier(0.33, 1, 0.68, 1)) |
| 123 | p "Replica measures your rebuild against the refer…" [460,248 520×56] | opacity 0 → 1 | 577 | out-cubic (cubic-bezier(0.33, 1, 0.68, 1)) |
| 240 | a "Get started" [576,328 124×50] | y +24px → rest, opacity 0 → 1 | 593 | out-cubic (cubic-bezier(0.33, 1, 0.68, 1)) |
| 240 | a "Read the docs" [713,328 151×50] | y +24px → rest, opacity 0 → 1 | 593 | out-cubic (cubic-bezier(0.33, 1, 0.68, 1)) |

### Declared animations (exact values read from the page — prefer these over the fitted ones)

- h1 "Ship interfaces that feel exactly right" · CSSAnimation `rise` · start 0ms · 600ms · delay 0ms · cubic-bezier(0.33, 1, 0.68, 1) (per keyframe) · iterations 1 · fill both
  - keyframes: 0: transform translateY(24px), opacity 0 → 1: transform none, opacity 1
- p "Replica measures your rebuild against the refer…" · CSSAnimation `rise` · start 0ms · 600ms · delay 120ms · cubic-bezier(0.33, 1, 0.68, 1) (per keyframe) · iterations 1 · fill both
  - keyframes: 0: transform translateY(24px), opacity 0 → 1: transform none, opacity 1
- div .actions · CSSAnimation `rise` · start 0ms · 600ms · delay 240ms · cubic-bezier(0.33, 1, 0.68, 1) (per keyframe) · iterations 1 · fill both
  - keyframes: 0: transform translateY(24px), opacity 0 → 1: transform none, opacity 1
