# curve.py VIDEO OUTCSV : per-frame mean abs diff at 320px wide gray + count of exact-duplicate frames (effective capture fps)
import cv2, numpy as np, sys
cap = cv2.VideoCapture(sys.argv[1]); fps = cap.get(cv2.CAP_PROP_FPS)
prev = None; rows = []; dup = 0; i = 0
while True:
    ok, fr = cap.read()
    if not ok: break
    h, w = fr.shape[:2]
    g = cv2.cvtColor(cv2.resize(fr, (320, round(320 * h / w))), cv2.COLOR_BGR2GRAY).astype(np.int16)
    d = 0.0 if prev is None else float(np.abs(g - prev).mean())
    if prev is not None and d < 0.02: dup += 1
    rows.append(f'{i},{i/fps:.4f},{d:.4f}'); prev = g; i += 1
open(sys.argv[2], 'w').write('frame,t,absdiff\n' + '\n'.join(rows))
print(sys.argv[1].split('/')[-1], 'frames', i, 'near-duplicate', dup, f'({dup/i:.1%})', 'effective fps ~', round(fps * (1 - dup / i), 1))
