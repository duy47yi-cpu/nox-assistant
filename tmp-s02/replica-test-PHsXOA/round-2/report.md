# Replica · round 2 · level `faithful`

**Score 100.0 (round 1: 100.0, ▼ 0.0) — PASS ✓**

| axis | score | gate |
|---|---|---|
| layout | 100.0 | ≥ 95 ✓ |
| style | 100.0 | ≥ 95 ✓ |
| pixels | 100.0 (0.00% differ) | ≥ 85 ✓ |
| motion | 100.0 | ≥ 90 ✓ |

- 1440x900: reference 1440×900 · yours 1440×900 · 0.00% pixels differ
- 390x844: reference 390×856 · yours 390×856 · 0.00% pixels differ

> Score went down since round 1. Undo the last change that made things worse before trying something new.

## Fix next (highest gain first)

1. **pixels** · region [1216,512 16×16] holds 85% of the differing pixels — no measured element explains it (image, icon, gradient, canvas or font rendering?). Look at `sheets/1440x900-hot1.png`. _[1440x900]_ **(+0.0 pixels)**

## Look at

- `sheets\1440x900.png` — reference | yours | diff (numbered boxes are hotspots)
- `sheets\1440x900-hot1.png` — hotspots zoomed
- `sheets\390x844.png` — reference | yours | diff (numbered boxes are hotspots)
- `sheets\motion.png` — reference vs yours over time

## Motion timing

- mean frame difference 0.00%, worst 0.00% at 0ms
- visible motion: reference 0–567ms · yours 0–567ms
