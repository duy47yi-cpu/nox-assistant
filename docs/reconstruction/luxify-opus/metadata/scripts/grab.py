# grab.py VIDEO OUT t1 t2 ... [--crop x,y,w,h] [--w W]  -> labelled grid (2 cols) of frames at exact times
import cv2, sys, math
from PIL import Image, ImageDraw
args = sys.argv[1:]
crop = None; W = None; cols = 2
if '--crop' in args:
    i = args.index('--crop'); crop = tuple(int(v) for v in args[i+1].split(',')); del args[i:i+2]
if '--w' in args:
    i = args.index('--w'); W = int(args[i+1]); del args[i:i+2]
if '--cols' in args:
    i = args.index('--cols'); cols = int(args[i+1]); del args[i:i+2]
vid, out, times = args[0], args[1], [float(t) for t in args[2:]]
cap = cv2.VideoCapture(vid); fps = cap.get(cv2.CAP_PROP_FPS)
ims = []
for t in times:
    cap.set(cv2.CAP_PROP_POS_FRAMES, round(t * fps)); ok, fr = cap.read()
    if not ok: continue
    if crop: x, y, w, h = crop; fr = fr[y:y+h, x:x+w]
    im = Image.fromarray(cv2.cvtColor(fr, cv2.COLOR_BGR2RGB))
    if W: im = im.resize((W, round(im.height * W / im.width)))
    d = ImageDraw.Draw(im); d.rectangle((0, 0, 70, 13), fill=(0, 0, 0)); d.text((3, 1), f't={t:.3f}s f{round(t*fps)}', fill=(255, 230, 0))
    ims.append(im)
w, h = ims[0].size; rows = math.ceil(len(ims) / cols)
g = Image.new('RGB', (cols * w + (cols - 1) * 4, rows * h + (rows - 1) * 4), (255, 0, 255))
for k, im in enumerate(ims): g.paste(im, ((k % cols) * (w + 4), (k // cols) * (h + 4)))
g.save(out, quality=90); print(out, g.size)
