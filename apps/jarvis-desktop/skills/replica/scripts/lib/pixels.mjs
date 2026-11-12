// Pixels: image work runs in a blank browser page on OffscreenCanvas, so Replica needs no image
// libraries. Node passes PNGs in as base64 and gets PNGs back the same way.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, extname } from 'node:path';

function lab() {
  const images = new Map();
  const W = 0.5053, I = 0.299, Q = 0.1957; // YIQ perceptual weights
  const THRESHOLD = 35215 * 0.1 * 0.1; // max YIQ delta × (0.1)²: ignores differences the eye barely sees

  const canvas = (w, h) => {
    const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    return [c, c.getContext('2d', { willReadFrequently: true })];
  };
  const pixels = (img, w, h) => {
    const [, x] = canvas(w, h);
    x.fillStyle = '#fff';
    x.fillRect(0, 0, w, h);
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, w, h).data;
  };
  const delta = (A, i, B, j) => {
    const [r1, g1, b1, r2, g2, b2] = [A[i], A[i + 1], A[i + 2], B[j], B[j + 1], B[j + 2]];
    if (r1 === r2 && g1 === g2 && b1 === b2) return 0;
    const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
    const ii = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
    const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
    return W * y * y + I * ii * ii + Q * q * q;
  };
  const AROUND = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];

  // Mismatch mask over the union of both sizes. A pixel matches when some pixel within 1px of it on
  // the other side looks the same, both ways round: anti-aliasing and sub-pixel shifts are not
  // differences (the layout axis measures position exactly).
  // Boxes in `skip` (placeholders) are left out entirely: neither differing nor counted in the area.
  // A skip box's optional fifth item lists holes, boxes painted in front of it, which still count.
  function diff(a, b, skip = []) {
    const w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
    const A = pixels(a, w, h), B = pixels(b, w, h);
    const mask = new Uint8Array(w * h);
    const off = new Uint8Array(w * h);
    for (const [sx, sy, sw, sh, holes = []] of skip)
      for (let y = Math.max(0, Math.floor(sy)); y < Math.min(h, Math.ceil(sy + sh)); y++)
        for (let x = Math.max(0, Math.floor(sx)); x < Math.min(w, Math.ceil(sx + sw)); x++)
          if (!holes.some(([hx, hy, hw, hh]) => x + 0.5 >= hx && x + 0.5 < hx + hw && y + 0.5 >= hy && y + 0.5 < hy + hh)) off[y * w + x] = 1;
    let count = 0, skipped = 0;
    const near = (P, Q2, x, y, qw, qh) => {
      const i = (y * w + x) * 4;
      for (const [dx, dy] of AROUND) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= qw || yy >= qh) continue;
        if (delta(P, i, Q2, (yy * w + xx) * 4) <= THRESHOLD) return true;
      }
      return false;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (off[y * w + x]) {
          skipped++;
          continue;
        }
        const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
        // 1 = looks different, 2 = only one side has a pixel here (sizes differ; reported separately).
        const bad = inA !== inB ? 2 : inA && !(near(A, B, x, y, b.width, b.height) && near(B, A, x, y, a.width, a.height)) ? 1 : 0;
        if (bad) {
          mask[y * w + x] = bad;
          count++;
        }
      }
    }
    return { w, h, mask, count, area: w * h - skipped };
  }

  // Connected 16px cells with enough differing pixels, as rectangles, biggest first.
  function hotspots({ w, h, mask, count }, limit) {
    const S = 16, cw = Math.ceil(w / S), ch = Math.ceil(h / S);
    const cells = new Uint32Array(cw * ch);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] === 1) cells[((y / S) | 0) * cw + ((x / S) | 0)]++;
    const seen = new Uint8Array(cw * ch);
    const out = [];
    for (let s = 0; s < cells.length; s++) {
      if (seen[s] || cells[s] < 12) continue;
      let [x0, y0, x1, y1, n] = [cw, ch, 0, 0, 0];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const c = stack.pop(), cx = c % cw, cy = (c / cw) | 0;
        [x0, y0, x1, y1, n] = [Math.min(x0, cx), Math.min(y0, cy), Math.max(x1, cx), Math.max(y1, cy), n + cells[c]];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy, k = ny * cw + nx;
          if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && !seen[k] && cells[k] >= 12) {
            seen[k] = 1;
            stack.push(k);
          }
        }
      }
      out.push({ box: [x0 * S, y0 * S, Math.min(w, (x1 + 1) * S) - x0 * S, Math.min(h, (y1 + 1) * S) - y0 * S], count: n, share: n / count });
    }
    return out.sort((p, q) => q.count - p.count).slice(0, limit);
  }

  const png = async (c) => {
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  const HEAD = 30, GAP = 12, BG = '#f2f2f4', INK = '#16161d', RED = [235, 30, 60], HOT = '#ff8a00';

  function label(x, text, cx, cy, color = INK) {
    x.font = '600 13px ui-sans-serif, system-ui, sans-serif';
    x.fillStyle = color;
    x.fillText(text, cx, cy);
  }

  // A panel showing region [rx, ry, rw, rh] of the diff scaled by s: the reference faded, with every
  // differing source pixel painted red (max-pooled so thin differences survive downscaling).
  function diffPanel(x, ref, d, [rx, ry, rw, rh], s, ox, oy) {
    x.globalAlpha = 0.22;
    x.drawImage(ref, rx, ry, rw, rh, ox, oy, rw * s, rh * s);
    x.globalAlpha = 1;
    const [mc, mx] = canvas(rw * s, rh * s);
    const img = mx.createImageData(mc.width, mc.height);
    for (let y = ry; y < ry + rh; y++) {
      for (let xx = rx; xx < rx + rw; xx++) {
        if (!d.mask[y * d.w + xx]) continue;
        const i = (Math.min(mc.height - 1, ((y - ry) * s) | 0) * mc.width + Math.min(mc.width - 1, ((xx - rx) * s) | 0)) * 4;
        img.data.set([...RED, 255], i);
      }
    }
    mx.putImageData(img, 0, 0);
    x.drawImage(mc, ox, oy);
  }

  function sheet(ref, clone, d, region, s, title, hot) {
    const [rx, ry, rw, rh] = region;
    const pw = Math.round(rw * s), ph = Math.round(rh * s);
    const [c, x] = canvas(pw * 3 + GAP * 4, ph + HEAD + GAP);
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    const cols = [GAP, GAP * 2 + pw, GAP * 3 + pw * 2];
    [`REFERENCE  ${title}`, 'YOURS', `DIFF  ${((100 * d.count) / (d.w * d.h)).toFixed(2)}% of all pixels`].forEach((t, i) => label(x, t, cols[i], 20));
    for (const [i, img] of [ref, clone].entries()) {
      x.fillStyle = BG;
      x.fillRect(cols[i], HEAD, pw, ph);
      x.drawImage(img, rx, ry, rw, rh, cols[i], HEAD, rw * s, rh * s);
    }
    x.fillStyle = BG;
    x.fillRect(cols[2], HEAD, pw, ph);
    diffPanel(x, ref, d, region, s, cols[2], HEAD);
    for (const [n, h] of hot.entries()) {
      const [hx, hy, hw, hh] = h.box;
      if (hx + hw < rx || hy + hh < ry || hx > rx + rw || hy > ry + rh) continue;
      for (const col of cols) {
        x.strokeStyle = HOT;
        x.lineWidth = 2;
        x.strokeRect(col + (hx - rx) * s, HEAD + (hy - ry) * s, hw * s, hh * s);
        x.fillStyle = HOT;
        x.fillRect(col + (hx - rx) * s, HEAD + (hy - ry) * s - 16, 18, 16);
        label(x, String(n + 1), col + (hx - rx) * s + 5, HEAD + (hy - ry) * s - 3, '#fff');
      }
    }
    return png(c);
  }

  window.lab = {
    async load(key, b64, mime = 'image/png') {
      const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
      images.set(key, await createImageBitmap(blob));
      return [images.get(key).width, images.get(key).height];
    },
    drop(...keys) {
      for (const k of keys) images.get(k)?.close(), images.delete(k);
    },
    async toPng(key, scale = 1) {
      const img = images.get(key);
      const [c, x] = canvas(img.width / scale, img.height / scale);
      x.drawImage(img, 0, 0, c.width, c.height);
      return { png: await png(c), size: [c.width, c.height] };
    },

    // Full comparison of two stills: score inputs, hotspots, an overview sheet (cut into bands for
    // tall pages) and a zoomed sheet per hotspot.
    async compare(refKey, cloneKey, { title = '', hot = 6, zooms = 4, skip = [] } = {}) {
      const ref = images.get(refKey), clone = images.get(cloneKey);
      const d = diff(ref, clone, skip);
      const spots = hotspots(d, hot);
      const s = Math.min(1, 760 / d.w);
      const band = Math.ceil(1100 / s);
      const sheets = [];
      for (let y = 0; y < d.h && sheets.length < 6; y += band) sheets.push(await sheet(ref, clone, d, [0, y, d.w, Math.min(band, d.h - y)], s, title, spots));
      const zoomed = [];
      for (const [i, h] of spots.slice(0, zooms).entries()) {
        const pad = 24;
        const r = [Math.max(0, h.box[0] - pad), Math.max(0, h.box[1] - pad)];
        r.push(Math.min(d.w, h.box[0] + h.box[2] + pad) - r[0], Math.min(d.h, h.box[1] + h.box[3] + pad) - r[1]);
        const z = Math.max(0.25, Math.min(3, 560 / r[2], 420 / r[3]));
        zoomed.push(await sheet(ref, clone, d, r, z, `hotspot ${i + 1}`, [h]));
      }
      return { size: [d.w, d.h], refSize: [ref.width, ref.height], cloneSize: [clone.width, clone.height], count: d.count, ratio: d.count / Math.max(1, d.area), hotspots: spots, sheets, zooms: zoomed };
    },

    ratio(refKey, cloneKey) {
      const d = diff(images.get(refKey), images.get(cloneKey));
      return d.count / (d.w * d.h);
    },

    // Mean absolute luminance change between two frames at quarter resolution, 0..1.
    activity(aKey, bKey) {
      const a = images.get(aKey), b = images.get(bKey);
      const w = Math.max(1, (a.width / 4) | 0), h = Math.max(1, (a.height / 4) | 0);
      const grab = (img) => {
        const [, x] = canvas(w, h);
        x.drawImage(img, 0, 0, w, h);
        return x.getImageData(0, 0, w, h).data;
      };
      const [A, B] = [grab(a), grab(b)];
      let sum = 0;
      for (let i = 0; i < A.length; i += 4) sum += Math.abs(A[i] + A[i + 1] + A[i + 2] - B[i] - B[i + 1] - B[i + 2]);
      return sum / (w * h * 765);
    },

    // Frames laid out in bands of 6 columns; each band has one row per sequence.
    async strip(rows, times, cell = 220) {
      const first = images.get(rows[0].keys[0]);
      const s = cell / first.width, ch = Math.round(first.height * s);
      const bands = Math.ceil(times.length / 6);
      const bandH = HEAD + rows.length * (ch + GAP + 18);
      const [c, x] = canvas(GAP + 6 * (cell + GAP) + 64, bands * bandH + GAP);
      x.fillStyle = '#fff';
      x.fillRect(0, 0, c.width, c.height);
      times.forEach((t, i) => {
        const bx = 64 + GAP + (i % 6) * (cell + GAP), by = ((i / 6) | 0) * bandH;
        label(x, `${Math.round(t)} ms`, bx, by + 20);
        rows.forEach((row, r) => {
          const img = images.get(row.keys[i]);
          const y = by + HEAD + r * (ch + GAP + 18);
          if (i % 6 === 0) label(x, row.label, GAP, y + ch / 2);
          x.fillStyle = BG;
          x.fillRect(bx, y, cell, ch);
          if (img) x.drawImage(img, bx, y, img.width * s, img.height * s);
          if (row.notes?.[i]) label(x, row.notes[i], bx, y + ch + 14, '#b3261e');
        });
      });
      return png(c);
    },
  };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export async function openLab(browser) {
  const page = await browser.newPage();
  await page.evaluate(`(${lab})()`);
  const write = async (path, b64) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(b64, 'base64'));
    return path;
  };
  return {
    load: async (key, path) => page.evaluate(([k, b, m]) => window.lab.load(k, b, m), [key, (await readFile(path)).toString('base64'), MIME[extname(path).toLowerCase()] || 'image/png']),
    drop: (...keys) => page.evaluate((k) => window.lab.drop(...k), keys),
    toPng: (key, scale) => page.evaluate(([k, s]) => window.lab.toPng(k, s), [key, scale]),
    compare: (a, b, opts) => page.evaluate(([a, b, o]) => window.lab.compare(a, b, o), [a, b, opts]),
    ratio: (a, b) => page.evaluate(([a, b]) => window.lab.ratio(a, b), [a, b]),
    activity: (a, b) => page.evaluate(([a, b]) => window.lab.activity(a, b), [a, b]),
    strip: (rows, times) => page.evaluate(([r, t]) => window.lab.strip(r, t), [rows, times]),
    write,
    close: () => page.close(),
  };
}
