# Capturing each kind of reference

Every capture runs Chromium at device scale factor 1. It uses a fixed clock (2026-01-01 UTC), a seeded `Math.random`, locale `en-US` and timezone UTC, and it freezes CSS and Web Animations on a virtual timeline. Two captures of the same page are therefore identical, so any difference `compare` reports comes from your build. `compare` re-uses the reference's viewports, motion length, fps and settle time; don't try to match them by hand.

## Live site or local page

```bash
replica.mjs capture https://example.com --out .replica/hero/ref --selector "main > section:first-child"
replica.mjs capture ./design/landing.html --out .replica/landing/ref          # static files work too
replica.mjs capture http://localhost:3000/pricing --out .replica/pricing/ref   # so does a dev server
```

- **Find the selector** by opening the page in a browser and inspecting the section. Prefer stable hooks (`#id`, `[data-*]`, semantic tags) over generated class names. If you leave out `--selector`, Replica captures the whole document, with stills cut at 8000px.
- `--wait "<css>"`: for client-rendered pages, waits until that element exists before anything else happens.
- `--settle <ms>`: virtual time allowed for intro animations to finish before the stills are taken. The default is 2500.
- `--hide "<css>"`: hides cookie banners, chat bubbles, and dev-only UI such as `nextjs-portal` or Vite's error overlay. It applies to both sides; on `compare` it overrides the reference's value for your clone.
- `--scheme dark`: the page renders with `prefers-color-scheme: dark`.
- Before stills are taken, Replica scrolls through the captured area once, so lazy images load and reveal-on-scroll content shows in its settled state.

## Interactions and motion

`--action` says what happens at t = 0. `--motion <ms>` records that many milliseconds afterwards at `--fps`, which defaults to 30.

| action | use for |
|---|---|
| `load` (default) | page-load intros. Recording starts before any timer or animation frame runs. |
| `reveal` | sections that animate when scrolled into view. Scrolls `--selector` to the middle of the viewport at t = 0. |
| `hover:<css>` | hover effects. Moves the real pointer onto the element. |
| `click:<css>` | menus, accordions, tabs, modals. |
| `focus:<css>` | focus rings and input states. |
| `scroll:<px>` | jumps down by px at t = 0, for sticky headers that shrink and scroll-triggered changes. |
| `scrub:<px>` | scrolls steadily across the recording, for parallax and scroll-linked progress. |

The settled stills (`shot.png`, `blueprint.json`) are taken *after* the action, so for `hover:` they show the hovered state. For an intro that runs before an interaction, settle it with `--settle`.

## Pages behind a login

Save a session once, then pass it to `capture` and `compare`. Keep the file out of git.

```bash
npx --prefix <skill>/scripts playwright codegen --save-storage=.replica/auth.json https://app.example.com
replica.mjs capture https://app.example.com/dashboard --out .replica/dash/ref --storage .replica/auth.json
replica.mjs compare .replica/dash/ref http://localhost:3000/dashboard --storage .replica/auth.json
```

## Iframes, canvas, WebGL, Lottie, video backgrounds

- **Iframe**: capture the iframe's own URL.
- **Canvas, WebGL and Lottie**: animation-frame-driven drawing runs on the virtual clock, so it is deterministic. Layout and style only see the canvas box, so judge the drawing itself by the pixel axis and the motion frames (`sheets/motion.png`).
- **`<video>` elements** are held on their first frame on both sides.

## Screenshots and design exports

```bash
replica.mjs capture hero@2x.png --out .replica/hero/ref --dpr 2 --viewports 1440x900
replica.mjs compare .replica/hero/ref http://localhost:3000 --selector "#hero"
```

- `--dpr`: the export's pixel ratio. The image is scaled to CSS pixels, so a 2880px-wide @2x export becomes 1440.
- `--viewports`: the browser size your clone is rendered at. For a full-page image it should equal the image width ÷ dpr. For a component image, pass `--selector` to `compare` so only your component is cropped and compared.
- Only the pixel axis is scored, because an image has no DOM. Hotspots still name *your* elements under each difference.

## Screen recordings and GIFs

```bash
replica.mjs capture recording.mov --out .replica/menu/ref --fps 30 --dpr 2 \
  --crop 120,80,900,640 --start 1.2 --end 2.8 --viewports 1440x900
replica.mjs compare .replica/menu/ref http://localhost:3000 --selector "#menu" --action click:"#menu-button"
```

- These need `ffmpeg` on PATH.
- `--crop x,y,w,h` is in the source video's pixels and is applied before `--dpr` scaling.
- Trim with `--start` and `--end` so the first frame is the moment the interaction starts. Then give `compare` the same trigger as an `--action`. Your clone is recorded for the same length at the same fps.
- Scoring uses the pixel axis plus motion. Motion compares per-frame differences and the moments when visible motion starts and settles.
- YouTube, Loom and other streaming links can't be fetched here. Ask the user for a screen recording, and meanwhile build from screenshots.
