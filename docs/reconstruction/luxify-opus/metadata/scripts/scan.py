# Per-video scan: motion curve at full fps, 1fps labelled contact sheet, 1fps half-res frames for review.
import cv2, numpy as np, json, sys, os
from PIL import Image, ImageDraw

L = 'C:/Users/abdut/Downloads/luxify'
O = 'D:/nox-release/docs/reconstruction/luxify-opus'
S = os.path.dirname(os.path.abspath(__file__))
VIDS = ['JCyGkRjS4FoCyrgYN1674g', 'cJzcvVmmUYlRCD2Why9OEg', 'yPGB7_7OcWSnDvYaFLOREg', '6eY2h5i9vrl6Dw_2ejg8yA',
        'video_2026-11-10_22-11-08', 'video_2026-11-10_22-11-27', 'video_2026-11-10_22-12-02', 'video_2026-11-10_22-12-47']

def run(idx, name):
    cap = cv2.VideoCapture(f'{L}/{name}.mp4')
    fps = cap.get(cv2.CAP_PROP_FPS); n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    prev = None; curve = []; thumbs = []; i = 0
    tag = f'V{idx:02d}'
    os.makedirs(f'{S}/f1/{tag}', exist_ok=True)
    while True:
        ok, fr = cap.read()
        if not ok: break
        small = cv2.cvtColor(cv2.resize(fr, (160, 90) if fr.shape[1] > fr.shape[0] else (90, 160)), cv2.COLOR_BGR2GRAY).astype(np.int16)
        d = 0.0 if prev is None else float(np.abs(small - prev).mean())
        curve.append(round(d, 3)); prev = small
        if i % round(fps) == 0:
            t = i / fps
            h, w = fr.shape[:2]
            half = cv2.resize(fr, (w // 2, h // 2)) if w >= 1280 else fr
            cv2.imwrite(f'{S}/f1/{tag}/{int(t):03d}.jpg', half, [cv2.IMWRITE_JPEG_QUALITY, 85])
            tw = 320 if w > h else 180
            th = int(h * tw / w)
            im = Image.fromarray(cv2.cvtColor(cv2.resize(fr, (tw, th)), cv2.COLOR_BGR2RGB))
            dr = ImageDraw.Draw(im); dr.rectangle((0, 0, 44, 14), fill=(0, 0, 0)); dr.text((3, 1), f'{int(t)//60}:{int(t)%60:02d}', fill=(255, 230, 0))
            thumbs.append(im)
        i += 1
    cols = 6 if thumbs[0].width > thumbs[0].height else 10
    rows = -(-len(thumbs) // cols)
    tw, th = thumbs[0].size
    sheet = Image.new('RGB', (cols * tw, rows * th), (20, 20, 20))
    for k, im in enumerate(thumbs): sheet.paste(im, ((k % cols) * tw, (k // cols) * th))
    sheet.save(f'{O}/storyboards/{tag}-{name}-1fps.jpg', quality=82)
    # per-second activity summary
    sec = [round(float(np.mean(curve[int(s*fps):int((s+1)*fps)])), 2) for s in range(int(len(curve)/fps)+1) if curve[int(s*fps):int((s+1)*fps)]]
    peaks = [ (round(k/fps,3), v) for k, v in enumerate(curve) if v > 6 ]
    json.dump({'video': name, 'fps': fps, 'frames_read': i, 'frame_count_meta': n, 'per_second_mean_absdiff': sec,
               'frames_absdiff_gt6': peaks[:400]}, open(f'{O}/metadata/{tag}-motion.json', 'w'), indent=0)
    print(tag, name, 'frames', i, 'sheet', sheet.size, 'peaks>6:', len(peaks))
    print('  per-sec:', sec)

if __name__ == '__main__':
    sel = [int(a) for a in sys.argv[1:]] or range(1, len(VIDS) + 1)
    for k in sel: run(k, VIDS[k - 1])
