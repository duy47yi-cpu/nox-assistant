# mode.py IMG name:x0,y0,x1,y1 ... -> dominant (quantized 4-bit) colour of box, refined as mean of that bin
import sys, numpy as np
from PIL import Image
im = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
for a in sys.argv[2:]:
    n, c = a.split(':'); x0, y0, x1, y1 = [int(t) for t in c.split(',')]
    p = im[y0:y1, x0:x1].reshape(-1, 3); q = (p // 8); k = q[:, 0] * 1024 + q[:, 1] * 32 + q[:, 2]
    vals, cnt = np.unique(k, return_counts=True); top = vals[cnt.argmax()]; m = p[k == top].mean(0).astype(int)
    print(f'{n:16s} #{m[0]:02X}{m[1]:02X}{m[2]:02X}  share={cnt.max()/len(k):.0%}')
