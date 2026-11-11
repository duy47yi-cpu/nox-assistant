'use strict';

// Сборка сравнительных PNG для Nox. Новых пакетов не требует: картинки собирает
// Python 3 + Pillow (в этой среде — 12.3.0), вызываемый из Node.
//
// Из папки apps/jarvis-desktop (или из корня — пути абсолютные):
//   node scripts/nox-compare.js --mode side --original <png> --impl <png> --out <png>
//     [--height 720] [--label-left Original --label-right "Nox implementation"] [--python <exe>]
//   node scripts/nox-compare.js --mode crop --image <png> --rect x,y,w,h --out <png>
//   node scripts/nox-compare.js --mode diff --original <png> --impl <png> --out <png>
//     [--threshold 12]
//
// Python выбирается так: --python, затем env PYTHON, затем встроенный Pillow-питон,
// затем python/python3 из PATH. Печатает одну строку NOX_COMPARE_RESULT <json>.
// Код выхода 0 — файл собран, 1 — ошибка.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BUNDLED_PYTHON = 'C:\\Users\\abdut\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}

function fail(message) {
  console.error(`nox-compare: ${message}`);
  process.exit(1);
}

function parseRect(value) {
  const parts = String(value || '').split(',').map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) fail('--rect: нужно x,y,w,h');
  return parts;
}

// ── Python + Pillow ───────────────────────────────────────────────
function probe(cmd) {
  const res = spawnSync(cmd, ['-c', 'import PIL; from PIL import Image; print(PIL.__version__)'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) return null;
  const version = String(res.stdout || '').trim().split(/\r?\n/).pop();
  if (!/^\d+\.\d+/.test(version)) return null;
  return { cmd, version };
}

function findPython() {
  const explicit = arg('python', '');
  const candidates = [explicit, process.env.PYTHON, BUNDLED_PYTHON, 'python', 'python3'].map((item) => item && String(item).trim()).filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const found = probe(candidate);
    if (found) return found;
  }
  return null;
}

// Программа на Python: масштабирование, подписи и разница. Параметры приходят JSON-ом
// в argv[1], поэтому кавычки и кириллица не ломают командную строку.
const PYTHON_PROGRAM = String.raw`
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

p = json.loads(sys.argv[1])
mode = p.get('mode')

BG = (16, 16, 17)
CAPTION = (206, 206, 210)
SEPARATOR = (58, 58, 62)
PAD = 24
CAPTION_H = 26


def fail(message):
    print(json.dumps({'ok': False, 'error': message}, ensure_ascii=False))
    sys.exit(1)


def load(file_path):
    try:
        return Image.open(file_path).convert('RGB')
    except Exception as error:
        fail('cannot open %s: %s' % (file_path, error))


def get_font(size=13):
    fonts_dir = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts')
    for name in ('segoeui.ttf', 'arial.ttf', 'tahoma.ttf'):
        try:
            return ImageFont.truetype(os.path.join(fonts_dir, name), size)
        except Exception:
            pass
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def save(canvas, out_path):
    try:
        canvas.save(out_path, 'PNG')
    except Exception as error:
        fail('cannot save %s: %s' % (out_path, error))


def scale_to_height(image, target_h):
    target_w = max(1, int(round(image.width * target_h / float(image.height))))
    return image.resize((target_w, target_h), Image.LANCZOS)


def draw_caption(draw, text, x, width, font):
    if not text:
        return
    box = draw.textbbox((0, 0), text, font=font)
    text_w = box[2] - box[0]
    text_h = box[3] - box[1]
    tx = x + max(0, int((width - text_w) / 2))
    ty = PAD + max(0, int((CAPTION_H - text_h) / 2)) - box[1]
    draw.text((tx, ty), text, font=font, fill=CAPTION)


if mode == 'crop':
    source = load(p['image'])
    x, y, w, h = [int(value) for value in p['rect']]
    left = max(0, x)
    top = max(0, y)
    right = min(source.width, x + w)
    bottom = min(source.height, y + h)
    if right <= left or bottom <= top:
        fail('crop rect is outside image: %s in %sx%s' % (p['rect'], source.width, source.height))
    result = source.crop((left, top, right, bottom))
    save(result, p['out'])
    print(json.dumps({
        'ok': True,
        'mode': 'crop',
        'out': p['out'],
        'size': [result.width, result.height],
        'rect': [left, top, right - left, bottom - top],
        'sourceSize': [source.width, source.height],
    }, ensure_ascii=False))
    sys.exit(0)

if mode == 'side':
    target_h = int(p.get('height') or 720)
    left_image = scale_to_height(load(p['original']), target_h)
    right_image = scale_to_height(load(p['impl']), target_h)
    gap = 16
    separator = 1
    canvas_w = PAD * 2 + left_image.width + gap + separator + gap + right_image.width
    canvas_h = PAD * 2 + CAPTION_H + target_h
    canvas = Image.new('RGB', (canvas_w, canvas_h), BG)
    draw = ImageDraw.Draw(canvas)
    font = get_font(13)
    draw_caption(draw, p.get('labelLeft') or 'Original', PAD, left_image.width, font)
    right_x = PAD + left_image.width + gap + separator + gap
    draw_caption(draw, p.get('labelRight') or 'Nox implementation', right_x, right_image.width, font)
    top = PAD + CAPTION_H
    canvas.paste(left_image, (PAD, top))
    canvas.paste(right_image, (right_x, top))
    draw.rectangle(
        [PAD + left_image.width + gap, top, PAD + left_image.width + gap + separator - 1, top + target_h],
        fill=SEPARATOR,
    )
    save(canvas, p['out'])
    print(json.dumps({
        'ok': True,
        'mode': 'side',
        'out': p['out'],
        'height': target_h,
        'leftSize': [left_image.width, left_image.height],
        'rightSize': [right_image.width, right_image.height],
        'canvasSize': [canvas_w, canvas_h],
    }, ensure_ascii=False))
    sys.exit(0)

if mode == 'diff':
    implementation = load(p['impl'])
    original = load(p['original'])
    resampled = original.size != implementation.size
    if resampled:
        original = original.resize(implementation.size, Image.LANCZOS)
    threshold = int(p.get('threshold') or 12)
    difference = ImageChops.difference(original, implementation)
    red, green, blue = difference.split()
    max_channel = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    mask = max_channel.point(lambda value: 255 if value > threshold else 0)
    histogram = mask.histogram()
    total = implementation.width * implementation.height
    changed = histogram[255] if len(histogram) > 255 else 0
    ratio = (changed / float(total)) if total else 0.0
    amplified = difference.point(lambda value: min(255, value * 4)).convert('RGB')
    canvas_w = implementation.width
    canvas_h = implementation.height + PAD * 2 + CAPTION_H
    canvas = Image.new('RGB', (canvas_w, canvas_h), BG)
    draw = ImageDraw.Draw(canvas)
    font = get_font(13)
    caption = 'changed pixels: %.2f%% (%d of %d, threshold %d/255)' % (ratio * 100.0, changed, total, threshold)
    draw_caption(draw, caption, 0, canvas_w, font)
    canvas.paste(amplified, (0, PAD + CAPTION_H))
    save(canvas, p['out'])
    print(json.dumps({
        'ok': True,
        'mode': 'diff',
        'out': p['out'],
        'changed': changed,
        'total': total,
        'ratio': ratio,
        'threshold': threshold,
        'originalResampled': resampled,
        'implSize': [implementation.width, implementation.height],
        'canvasSize': [canvas_w, canvas_h],
    }, ensure_ascii=False))
    sys.exit(0)

fail('unknown mode: %s' % mode)
`;

function main() {
  const mode = String(arg('mode', '')).toLowerCase();
  if (!['side', 'crop', 'diff'].includes(mode)) fail('--mode: side|crop|diff');
  const out = arg('out', '');
  if (!out) fail('--out обязателен');
  const outPath = path.resolve(out);

  const payload = { mode, out: outPath };
  if (mode === 'crop') {
    const image = arg('image', '');
    if (!image) fail('--image обязателен');
    payload.image = path.resolve(image);
    payload.rect = parseRect(arg('rect', ''));
  } else {
    const original = arg('original', '');
    const impl = arg('impl', '');
    if (!original) fail('--original обязателен');
    if (!impl) fail('--impl обязателен');
    payload.original = path.resolve(original);
    payload.impl = path.resolve(impl);
    for (const key of ['original', 'impl']) {
      if (!fs.existsSync(payload[key])) fail(`файл не найден: ${payload[key]}`);
    }
    if (mode === 'side') {
      payload.height = Number.parseInt(arg('height', '720'), 10) || 720;
      payload.labelLeft = arg('label-left', 'Original');
      payload.labelRight = arg('label-right', 'Nox implementation');
    } else {
      payload.threshold = Number.parseInt(arg('threshold', '12'), 10) || 12;
    }
  }
  if (mode === 'crop') {
    const source = payload.image;
    if (!fs.existsSync(source)) fail(`файл не найден: ${source}`);
  }

  const python = findPython();
  if (!python) fail('не найден Python 3 с Pillow: задайте --python или env PYTHON');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const result = spawnSync(python.cmd, ['-c', PYTHON_PROGRAM, JSON.stringify(payload)], {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) fail(`python не запустился: ${result.error.message}`);

  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let parsed = null;
  try { parsed = JSON.parse(lines[lines.length - 1] || ''); } catch { parsed = null; }
  if (result.status !== 0 || !parsed || parsed.ok !== true) {
    const detail = (parsed && parsed.error) || String(result.stderr || '').trim() || `python exited ${result.status}`;
    fail(detail);
  }
  if (!fs.existsSync(outPath)) fail(`файл не создан: ${outPath}`);

  console.log(`NOX_COMPARE_RESULT ${JSON.stringify({ ...parsed, python: python.cmd, pillow: python.version })}`);
}

main();
