# sample.py IMG name:x,y[,r] ... -> median RGB hex of (2r+1)^2 patch
import sys, numpy as np
from PIL import Image
im = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(int)
for a in sys.argv[2:]:
    n, c = a.split(':'); v = [int(t) for t in c.split(',')]; x, y = v[0], v[1]; r = v[2] if len(v) > 2 else 2
    p = im[y-r:y+r+1, x-r:x+r+1].reshape(-1, 3); m = np.median(p, axis=0).astype(int)
    print(f'{n:18s} ({x},{y}) #{m[0]:02X}{m[1]:02X}{m[2]:02X}  sd={p.std(axis=0).mean():.1f}')
