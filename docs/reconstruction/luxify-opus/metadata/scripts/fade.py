# fade.py VIDEO f0 f1 x,y,w,h : normalized luminance contrast of region per frame (0=start state,1=end state)
import cv2, numpy as np, sys
v, f0, f1 = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]); x, y, w, h = [int(a) for a in sys.argv[4].split(',')]
cap = cv2.VideoCapture(v); fps = cap.get(5); cap.set(1, f0); R = []
for i in range(f0, f1 + 1):
    ok, f = cap.read(); g = cv2.cvtColor(f[y:y+h, x:x+w], cv2.COLOR_BGR2GRAY).astype(float); R.append(g)
end = R[-1]; st = R[0]; den = ((end - st) ** 2).sum() or 1
for k, g in enumerate(R):
    p = ((g - st) * (end - st)).sum() / den  # projection of change onto start->end
    print(f'f{f0+k} t={(f0+k)/fps:.3f} progress={p:.2f}')
