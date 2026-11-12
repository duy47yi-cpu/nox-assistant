# gridify.py IN OUT x,y,w,h scale step : crop, upscale, overlay coordinate grid in SOURCE pixel units
import sys
from PIL import Image, ImageDraw
src, out, box, sc, step = sys.argv[1], sys.argv[2], [int(v) for v in sys.argv[3].split(',')], float(sys.argv[4]), int(sys.argv[5])
x, y, w, h = box
im = Image.open(src).convert('RGB').crop((x, y, x + w, y + h)).resize((round(w * sc), round(h * sc)), Image.LANCZOS)
d = ImageDraw.Draw(im, 'RGBA')
for gx in range((x // step + 1) * step, x + w, step):
    X = (gx - x) * sc; major = gx % (step * 5) == 0
    d.line((X, 0, X, im.height), fill=(255, 60, 60, 150 if major else 60))
    if major: d.text((X + 2, 2), str(gx), fill=(255, 255, 0))
for gy in range((y // step + 1) * step, y + h, step):
    Y = (gy - y) * sc; major = gy % (step * 5) == 0
    d.line((0, Y, im.width, Y), fill=(60, 200, 255, 150 if major else 60))
    if major: d.text((2, Y + 2), str(gy), fill=(0, 255, 255))
im.save(out, quality=92); print(out, im.size)
