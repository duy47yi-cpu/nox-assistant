// Motion: turn per-frame samples into segments (start, duration, from → to, easing) and score a clone's
// segments against the reference's.

// Channels sampled per element, and the smallest change that counts as movement. Captures run on a
// virtual clock, so there is no noise to filter: any change in the rounded values is real.
export const CHANNELS = ['x', 'y', 'w', 'h', 'o', 'r', 'c', 'bg'];
const EPS = { x: 0.0005, y: 0.0005, w: 0.0005, h: 0.0005, o: 0.00005, r: 0.05, c: 0.5, bg: 0.5 };
export const CH_NAME = { x: 'x', y: 'y', w: 'width', h: 'height', o: 'opacity', r: 'rotate', c: 'text color', bg: 'background' };

// Named curves (CSS keywords plus the common Penner fits) used to name a measured curve.
export const EASINGS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  'in-quad': [0.11, 0, 0.5, 0],
  'in-cubic': [0.32, 0, 0.67, 0],
  'out-quad': [0.5, 1, 0.89, 1],
  'out-cubic': [0.33, 1, 0.68, 1],
  'out-quart': [0.25, 1, 0.5, 1],
  'out-quint': [0.22, 1, 0.36, 1],
  'out-expo': [0.16, 1, 0.3, 1],
  'out-circ': [0, 0.55, 0.45, 1],
  'out-back': [0.34, 1.56, 0.64, 1],
  'in-out-quad': [0.45, 0, 0.55, 1],
  'in-out-cubic': [0.65, 0, 0.35, 1],
  'in-out-quart': [0.76, 0, 0.24, 1],
  'in-out-expo': [0.87, 0, 0.13, 1],
};

export function bezier([x1, y1, x2, y2]) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, s = x;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      X(s) < x ? (lo = s) : (hi = s);
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

const rms = (curve, f) => Math.sqrt(curve.reduce((sum, [t, p]) => sum + (f(t) - p) ** 2, 0) / curve.length);

// Nearest named easing, plus a free cubic-bezier refined from it by coordinate descent.
export function fitEasing(curve) {
  let best = { name: 'linear', bez: EASINGS.linear, rms: Infinity };
  for (const [name, bez] of Object.entries(EASINGS)) {
    const e = rms(curve, bezier(bez));
    if (e < best.rms) best = { name, bez, rms: e };
  }
  let p = [...best.bez], e = best.rms;
  for (let step = 0.1; step > 0.004; step /= 2) {
    for (let moved = true, guard = 0; moved && guard < 50; guard++) {
      moved = false;
      for (let i = 0; i < 4; i++) {
        for (const d of [step, -step]) {
          const q = [...p];
          q[i] = i % 2 ? Math.min(2, Math.max(-1, q[i] + d)) : Math.min(1, Math.max(0, q[i] + d));
          const eq = rms(curve, bezier(q));
          if (eq < e - 1e-6) [p, e, moved] = [q, eq, true];
        }
      }
    }
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  return { name: best.name, rms: r2(best.rms * 100) / 100, fit: p.map(r2), fitRms: r2(e * 100) / 100 };
}

// A curve that overshoots its target reads as a spring: damping from the overshoot, stiffness from
// when the first peak lands (mass 1). The peak time holds even when a long tail hides the settle.
function springOf(overshoot, peakMs) {
  const ln = Math.log(overshoot);
  const zeta = -ln / Math.sqrt(Math.PI ** 2 + ln ** 2);
  const wn = Math.PI / (peakMs / 1000) / Math.sqrt(1 - zeta ** 2);
  return { damping_ratio: +zeta.toFixed(2), stiffness: Math.round(wn * wn), damping: +(2 * zeta * wn).toFixed(1), mass: 1 };
}

const hexRgb = (h) => (h ? [1, 3, 5, 7].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255)) : [0, 0, 0, 0]);
const colorDist = (a, b) => Math.hypot(...hexRgb(a).map((v, i) => v - hexRgb(b)[i]));

function resample(curve, n = 24) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const j = curve.findIndex(([tt]) => tt >= t);
    if (j <= 0) return curve[Math.max(0, j)][1];
    const [ta, pa] = curve[j - 1], [tb, pb] = curve[j];
    return pa + ((pb - pa) * (t - ta)) / (tb - ta || 1);
  }).map((v) => Math.round(v * 1000) / 1000);
}

// Frames only bracket the true start and end, which skews both the duration and the easing fit.
// Try sub-frame starts and ends and keep the pair under which some named curve fits best.
function bracket(times, v, a, b, from, span) {
  const pts = [];
  for (let k = a + 1; k < b; k++) pts.push([times[k], (v[k] - from) / span]);
  let best = { s: times[a], e: times[b], rms: Infinity };
  if (pts.length < 3) return best;
  const curves = Object.values(EASINGS).map(bezier);
  for (let i = 0; i < 10; i++) {
    const s = times[a] + ((times[a + 1] - times[a]) * i) / 10;
    for (let j = 1; j <= 10; j++) {
      const e = times[b - 1] + ((times[b] - times[b - 1]) * j) / 10;
      const curve = pts.map(([t, p]) => [(t - s) / (e - s), p]);
      for (const f of curves) {
        const r = rms(curve, f);
        if (r < best.rms) best = { s, e, rms: r };
      }
    }
  }
  return best;
}

// Runs of change separated by at least 3 still frames.
// colors: the raw hex values behind a color channel's distances, so a segment can name its endpoints.
function segmentsOf(times, v, ch, colors) {
  const runs = [];
  let cur = null, still = 0;
  for (let k = 1; k < v.length; k++) {
    if (Math.abs(v[k] - v[k - 1]) > EPS[ch]) {
      if (cur) cur.b = k;
      else cur = { a: k - 1, b: k };
      still = 0;
    } else if (cur && ++still >= 3) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);

  return runs.map(({ a, b }) => {
    const from = v[a], to = v[b];
    const open = b === v.length - 1;
    const slice = v.slice(a, b + 1);
    const peak = slice.reduce((m, x) => (Math.abs(x - from) > Math.abs(m - from) ? x : m), from);
    const rnd = ch === 'o' ? (x) => Math.round(x * 1000) / 1000 : r1;
    const seg = { ch, start: times[a], end: times[b], dur: Math.round(times[b] - times[a]), from: colors ? colors[a] : rnd(from), to: colors ? colors[b] : rnd(to) };
    if (open) {
      seg.open = true; // still moving when the recording ended (a loop, or --motion too short)
      seg.velocity = r1(((to - from) / (times[b] - times[a] || 1)) * 1000);
    }
    const amp = to - from;
    const yoyo = Math.abs(amp) < Math.abs(peak - from) * 0.25;
    const span = yoyo ? peak - from : amp;
    if (Math.abs(span) <= EPS[ch]) return seg;
    const { s, e } = open || yoyo ? { s: times[a], e: times[b] } : bracket(times, v, a, b, from, span);
    Object.assign(seg, { start: Math.round(s), end: Math.round(e), dur: Math.round(e - s) });
    const curve = [[0, 0], ...slice.slice(1, -1).map((x, i) => [(times[a + 1 + i] - s) / (e - s || 1), (x - from) / span]), [1, (to - from) / span]];
    seg.curve = resample(curve);
    if (yoyo) {
      seg.yoyo = true;
      seg.peak = rnd(peak);
      return seg;
    }
    const top = curve.reduce((j, [, p], i) => (p > curve[j][1] ? i : j), 0);
    const over = curve[top][1] - 1;
    if (!open) {
      const ease = fitEasing(curve);
      // An overshoot a cubic-bezier draws exactly (out-back and friends) stays a bezier; one it can't is a spring.
      if (over > 0.02 && ease.fitRms > 0.015) seg.spring = { overshoot: +over.toFixed(3), ...springOf(over, peakAt(curve, top) * seg.dur) };
      else seg.ease = ease;
    }
    return seg;
  });
}

const r1 = (v) => Math.round(v * 10) / 10;

// Where the top of a sampled peak really is, between frames: the vertex of a parabola through it.
function peakAt(curve, j) {
  if (j < 1 || j >= curve.length - 1) return curve[j][0];
  const [[t0, a], [t1, b], [t2, c]] = curve.slice(j - 1, j + 2);
  const den = a - 2 * b + c;
  return den ? t1 + ((t2 - t0) / 2) * ((a - c) / (2 * den)) : t1;
}

// The page reports rotation in (-180, 180], so a full spin wraps around; follow the shortest turn
// between frames instead (exact while it turns less than 180° per frame).
function unwrap(deg) {
  let acc = deg[0];
  return deg.map((d, k) => (k ? (acc += d - deg[k - 1] - 360 * Math.round((d - deg[k - 1]) / 360)) : acc));
}

// frames: [{ t, rows: [[id, x, y, w, h, o, r, color, bg], …] }] → { id: { segs, box } } for things that move.
export function tracksOf(frames) {
  const times = frames.map((f) => f.t);
  const by = new Map();
  frames.forEach((f, k) => {
    for (const [id, x, y, w, h, o, r, c, bg] of f.rows) {
      if (!by.has(id)) by.set(id, []);
      by.get(id)[k] = { x, y, w, h, o, r, c, bg };
    }
  });
  const out = {};
  for (const [id, rows] of by) {
    // Frames where the element was absent count as invisible, holding the nearest known geometry.
    const first = rows.find(Boolean);
    let last = first;
    const full = times.map((_, k) => (rows[k] ? (last = rows[k]) : { ...last, o: 0 }));
    const segs = [];
    for (const ch of CHANNELS) {
      const raw = full.map((s) => s[ch]);
      const v = ch === 'c' || ch === 'bg' ? raw.map((c) => colorDist(c, raw[0])) : ch === 'r' ? unwrap(raw) : raw;
      segs.push(...segmentsOf(times, v, ch, ch === 'c' || ch === 'bg' ? raw : null));
    }
    if (!segs.length) continue;
    const end = full.at(-1);
    out[id] = { box: [end.x, end.y, end.w, end.h], segs: segs.sort((a, b) => a.start - b.start) };
  }
  return out;
}

// A child that only moves because its parent moves (same channels, same timing, inside the parent)
// is the parent's motion seen twice; keep the parent.
export function dropPassengers(list) {
  const area = (t) => t.box[2] * t.box[3];
  const inside = (c, p) => c.box[0] >= p.box[0] - 1 && c.box[1] >= p.box[1] - 1 && c.box[0] + c.box[2] <= p.box[0] + p.box[2] + 1 && c.box[1] + c.box[3] <= p.box[1] + p.box[3] + 1;
  const same = (a, b) => a.ch === b.ch && Math.abs(a.start - b.start) <= 34 && Math.abs(a.dur - b.dur) <= 34;
  const bigger = (p, t) => area(p) > area(t) || (area(p) === area(t) && p.id < t.id);
  return list.filter((t) => !list.some((p) => p !== t && bigger(p, t) && inside(t, p) && t.segs.every((s) => p.segs.some((q) => same(s, q)))));
}

// Activity per frame (mean pixel change from the previous frame) → when motion starts and stops.
export function onsetSettle(activity, times) {
  const peak = Math.max(...activity);
  if (peak <= 0.0005) return null;
  const on = activity.findIndex((a) => a > peak * 0.1);
  const off = activity.findLastIndex((a) => a > peak * 0.1);
  return { onset: times[Math.max(0, on - 1)], settle: times[off] };
}

const sub = (err, tol, span) => (err <= tol ? 1 : Math.max(0, 1 - (err - tol) / span));

// Score one clone segment against one reference segment: timing, distance and curve shape.
export function segScore(a, b, tolMs) {
  const amp = Math.abs(a.to - a.from) || Math.abs((a.peak ?? a.from) - a.from);
  const parts = {
    start: sub(Math.abs(a.start - b.start), tolMs, 300),
    duration: a.open && b.open ? 1 : sub(Math.abs(a.dur - b.dur), tolMs, Math.max(200, a.dur)),
    distance:
      a.ch === 'c' || a.ch === 'bg'
        ? colorDist(a.to, b.to) <= 8 ? 1 : 0
        : sub(Math.abs((a.to - a.from) - (b.to - b.from)), Math.max(EPS[a.ch] * 20, amp * 0.1), Math.max(amp, 1)),
    curve: a.curve && b.curve ? sub(Math.sqrt(a.curve.reduce((s, p, i) => s + (p - b.curve[i]) ** 2, 0) / a.curve.length), 0.04, 0.25) : 1,
  };
  if (a.open && b.open && a.velocity != null) parts.distance = sub(Math.abs(a.velocity - b.velocity), Math.abs(a.velocity) * 0.05 + 1, Math.abs(a.velocity) + 1);
  return { score: (parts.start + parts.duration + parts.distance + parts.curve) / 4, parts };
}

// Pair each reference segment with the clone segment on the same channel that starts closest.
export function pairSegments(ref, clone) {
  const used = new Set();
  const pairs = [];
  const missing = [];
  for (const a of ref) {
    let best = null;
    for (const b of clone) {
      if (b.ch !== a.ch || used.has(b)) continue;
      if (!best || Math.abs(b.start - a.start) < Math.abs(best.start - a.start)) best = b;
    }
    if (best) {
      used.add(best);
      pairs.push([a, best]);
    } else missing.push(a);
  }
  return { pairs, missing, extra: clone.filter((b) => !used.has(b)) };
}

export function describeEase(seg) {
  if (seg.open) return `still moving at end (${seg.velocity}/s)`;
  if (seg.yoyo) return `there and back (peak ${seg.peak})`;
  if (seg.spring) return `spring: overshoot ${Math.round(seg.spring.overshoot * 100)}%, ≈ stiffness ${seg.spring.stiffness}, damping ${seg.spring.damping} (mass 1)`;
  if (!seg.ease) return 'step';
  const { name, rms, fit, fitRms } = seg.ease;
  return rms <= 0.02 ? `${name} (cubic-bezier(${EASINGS[name].join(', ')}))` : `≈ cubic-bezier(${fit.join(', ')}) (nearest named: ${name})${fitRms > 0.03 ? ' — irregular curve' : ''}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Self-check: a sampled out-cubic curve is recognised as out-cubic.
  const f = bezier(EASINGS['out-cubic']);
  const times = Array.from({ length: 21 }, (_, i) => i * 33.3);
  const frames = times.map((t, i) => ({ t, rows: [[1, 0, i <= 18 ? 100 * f(Math.min(1, i / 18)) : 100, 10, 10, 1, 0, '#000000', null]] }));
  const segs = tracksOf(frames)[1].segs;
  const { default: assert } = await import("node:assert");
  assert.ok(segs.length === 1 && segs[0].ch === "y" && segs[0].ease.name === "out-cubic", JSON.stringify(segs));
  assert.equal(bezier(EASINGS.linear)(0.3).toFixed(3), "0.300");
  // A full turn is one 0 → 360° segment, not a jump where it wraps past 180°.
  const wrap = (d) => d - 360 * Math.round(d / 360);
  const spin = times.map((t, i) => ({ t, rows: [[1, 0, 0, 10, 10, 1, wrap(360 * f(Math.min(1, i / 18))), '#000000', null]] }));
  const r = tracksOf(spin)[1].segs;
  assert.ok(r.length === 1 && r[0].to === 360 && r[0].ease.name === 'out-cubic', JSON.stringify(r));
  // A color change names its real endpoints even when its timing is fitted between frames.
  const grey = (i) => `#${Math.round(255 * f(Math.min(1, i / 18))).toString(16).padStart(2, '0').repeat(3)}`;
  const bg = tracksOf(times.map((t, i) => ({ t, rows: [[1, 0, 0, 10, 10, 1, 0, '#000000', grey(i)]] })))[1].segs[0];
  assert.ok(bg.ch === 'bg' && bg.from === '#000000' && bg.to === '#ffffff', JSON.stringify(bg));
  // A spring (stiffness 260, damping 16) sampled at 30 fps comes back within 10% of both.
  const z = 16 / (2 * Math.sqrt(260)), wn = Math.sqrt(260), wd = wn * Math.sqrt(1 - z * z);
  const sp = (s) => 1 - Math.exp(-z * wn * s) * (Math.cos(wd * s) + ((z * wn) / wd) * Math.sin(wd * s));
  const st = Array.from({ length: 31 }, (_, i) => i * 33.3);
  const s = tracksOf(st.map((t, i) => ({ t, rows: [[1, 0, i < 28 ? Math.round(100 * sp(t / 1000) * 10) / 10 : 100, 10, 10, 1, 0, '#000000', null]] })))[1].segs[0].spring;
  assert.ok(Math.abs(s.stiffness / 260 - 1) < 0.1 && Math.abs(s.damping / 16 - 1) < 0.1, JSON.stringify(s));
  console.log('motion.mjs ok');
}
