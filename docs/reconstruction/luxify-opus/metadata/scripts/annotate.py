# Draw measured boxes (from manual grid measurement) onto source images, plus motion charts.
import csv
from PIL import Image, ImageDraw
O = 'D:/nox-release/docs/reconstruction/luxify-opus'
P = 'C:/Users/abdut/Downloads/luxify'

def boxes(src, out, items, scale=1.0):
    im = Image.open(src).convert('RGB')
    if scale != 1: im = im.resize((round(im.width * scale), round(im.height * scale)))
    d = ImageDraw.Draw(im, 'RGBA')
    for (x0, y0, x1, y1), label, col in items:
        X0, Y0, X1, Y1 = [round(v * scale) for v in (x0, y0, x1, y1)]
        d.rectangle((X0, Y0, X1, Y1), outline=col + (255,), width=2)
        txt = f'{label} {x1-x0}x{y1-y0}'
        d.rectangle((X0, Y0 - 12, X0 + 6 * len(txt) + 4, Y0), fill=(0, 0, 0, 200)); d.text((X0 + 2, Y0 - 12), txt, fill=col + (255,))
    im.save(out, quality=92); print(out)

Y, C, M, G, R, W = (255, 220, 0), (0, 220, 255), (255, 80, 255), (80, 255, 120), (255, 90, 90), (255, 255, 255)
boxes(f'{P}/photo_2026-11-10_22-09-41.jpg', f'{O}/annotated/IMG04-home-v2-measured.jpg', [
    ((63, 32, 1137, 737), 'window', W), ((63, 32, 226, 737), 'rail panel', C), ((76, 127, 214, 168), 'nav item active', Y),
    ((77, 138, 80, 158), 'ind', R), ((668, 49, 706, 87), 'mic', M), ((248, 107, 706, 463), 'card History r~14', G),
    ((248, 486, 706, 716), 'card Control', G), ((635, 551, 686, 573), 'toggle', Y), ((362, 676, 635, 688), 'slider', Y),
    ((706, 32, 1137, 737), 'orb zone (clipped by window)', M)], 1.0)
boxes(f'{O}/frames/V08-t01.500-home-v1.png', f'{O}/annotated/V08-home-v1-measured.jpg', [
    ((250, 133, 987, 589), 'window (video px; screen px ~ /0.6)', W), ((250, 133, 312, 589), 'icon rail', C),
    ((327, 193, 650, 402), 'card History', G), ((327, 417, 650, 578), 'card Control', G), ((612, 152, 660, 176), 'mic', M),
    ((650, 133, 987, 589), 'orb zone', M), ((268, 270, 304, 306), 'active icon box', Y), ((600, 466, 635, 478), 'toggle', Y)], 1.6)

def chart(csvp, out, title, cols, colors, xlab, ylab, invert=False):
    rows = [r for r in csv.reader(open(csvp)) if not r[0].startswith('#')]
    data = [[float(v) for v in r] for r in rows]
    W_, H_ = 900, 360; im = Image.new('RGB', (W_, H_), (16, 18, 26)); d = ImageDraw.Draw(im)
    xs = [r[0] for r in data]; x0, x1 = min(xs), max(xs)
    for j, col in zip(cols, colors):
        ys = [r[j] for r in data]; y0, y1 = min(ys), max(ys); span = (y1 - y0) or 1
        pts = [(40 + (x - x0) / (x1 - x0) * (W_ - 60), 40 + (y - y0) / span * (H_ - 80)) for x, y in zip(xs, ys)]
        d.line(pts, fill=col, width=2); d.text((pts[0][0] + 4, pts[0][1] - 12), f'col{j} range {y0:.1f}..{y1:.1f}', fill=col)
    d.text((10, 8), title, fill=(255, 255, 255)); d.text((W_ - 200, H_ - 18), f'{xlab}: {x0:.2f}..{x1:.2f}', fill=(200, 200, 200)); d.text((10, H_ - 18), ylab, fill=(200, 200, 200))
    im.save(out); print(out)

chart(f'{O}/metadata/V08-orb-ring-edges.csv', f'{O}/storyboards/V08-orb-ring-edges-chart.png',
      'V08 home v1: left edge x of orb rings 1..4 over time (each normalised to its own range; down = ring larger)',
      [1, 2, 3, 4], [(255, 90, 90), (255, 200, 0), (80, 255, 120), (0, 200, 255)], 't, s', 'per-ring normalised x')
