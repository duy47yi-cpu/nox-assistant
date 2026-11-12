# Building from a blueprint

## General

- **Units**: blueprint values are computed px. If the project uses rem, divide by the root font size (usually 16). Letter-spacing in em is `ls ÷ font-size`.
- **Line-height `normal`** depends on the font's metrics. It only matches once the same font is loaded.
- **Centred containers**: a box at `x = (viewport − width) / 2` is a centred `max-width` container. Use the width as the max-width and the padding values as given.
- **Equal grid tracks**: `grid cols[421.3px 421.3px 421.3px] gap 24` is `grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px`.
- **Buttons and inputs** carry browser default styles (background, border, padding, font). Reset them before styling, or you will get `extra` and style findings.
- **Fonts**: load the same family and weights the blueprint lists, with the project's usual mechanism (`next/font`, `@font-face`, a fontsource package). Use reference font files only when the user has the right to use them. Otherwise pick the closest free family and report it.
- **Icons and SVGs**: `blueprint.json` has inline markup for small SVGs. Use it only when the user owns the asset or it is from an open icon set; otherwise use the project's icon library at the same size.
- **Images**: keep the exact box size and `object-fit`. Use placeholders with the same dimensions when the user has no assets.
- **Placeholders**: put `data-replica="placeholder"` on the stand-in (image, SVG, video). Its box is still scored on layout; its pixels are left out of the pixel score and listed in the report. Text, buttons and anything else painted in front of it still count, so a full-bleed background placeholder doesn't hide the headline.

## CSS

```css
.hero h1 { font: 700 56px/64px Inter, sans-serif; letter-spacing: -1px; }
@keyframes rise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
.hero h1 { animation: rise 600ms cubic-bezier(0.33, 1, 0.68, 1) both; }
.hero p { animation: rise 600ms cubic-bezier(0.33, 1, 0.68, 1) 120ms both; }
```

## Tailwind

Arbitrary values keep exact numbers: `text-[56px] leading-[64px] tracking-[-1px] font-bold`, `gap-[24px]`, `rounded-[12px]`, `shadow-[0_1px_2px_#0000000f]`, `bg-[#5b4bff]`. Put repeated values into the theme (`--color-accent`) instead of repeating them. For motion, add keyframes to the theme and use `animate-[rise_600ms_cubic-bezier(0.33,1,0.68,1)_both]`, or `transition-transform duration-[250ms] ease-[cubic-bezier(0.34,1.56,0.64,1)]`.

## Framer Motion / Motion

```jsx
<motion.p
  initial={{ opacity: 0, y: 24 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.6, delay: 0.12, ease: [0.33, 1, 0.68, 1] }}
/>
// A spring from the timeline: stiffness 940, damping 36.8, mass 1
transition={{ type: 'spring', stiffness: 940, damping: 36.8, mass: 1 }}
```

Stagger: `transition={{ staggerChildren: 0.12 }}` on the parent, when the timeline's starts step by 120ms.

## GSAP

GSAP's power eases are Penner curves: `power1` = quad, `power2` = cubic, `power3` = quart, `power4` = quint.

| timeline easing | GSAP |
|---|---|
| out-cubic | `power2.out` |
| out-quart | `power3.out` |
| out-quint | `power4.out` |
| out-expo | `expo.out` |
| out-circ | `circ.out` |
| out-back | `back.out(1.7)` |
| in-out-cubic | `power2.inOut` |
| custom cubic-bezier | `CustomEase.create("x", "0.33,1,0.68,1")` |

```js
gsap.from('.hero p', { y: 24, opacity: 0, duration: 0.6, delay: 0.12, ease: 'power2.out' });
```

## Continuous motion (marquees, loops)

When the timeline gives a velocity (`still moving at end (-80/s)`), the loop duration is the travelled distance ÷ |velocity|. A marquee moving its 1600px track at 80px/s loops every 20s. Match the velocity rather than guessing a duration.
