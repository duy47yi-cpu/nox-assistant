// Structure and style: pair what is visible in the reference with what is visible in the clone,
// independent of markup, then score boxes (layout) and computed styles (style).

const GROUP = { heading: 'T', text: 'T', link: 'I', button: 'I', field: 'F', media: 'M', box: 'B' };
const TEXTY = new Set(['heading', 'link', 'button', 'text', 'field']);
const PAINT = ['bg', 'bgi', 'r', 'bw', 'bc', 'sh'];
const TYPE = ['ff', 'fs', 'fw', 'lh', 'ls', 'c', 'tt', 'fst', 'td'];

export const weight = (n) => Math.min(200, Math.sqrt(n.box[2] * n.box[3]));
const area = (n) => n.box[2] * n.box[3];
const center = (n) => [n.box[0] + n.box[2] / 2, n.box[1] + n.box[3] / 2];
const dist = (a, b) => Math.hypot(...center(a).map((v, i) => v - center(b)[i]));
const base = (src) => (src || '').split(/[?#]/)[0].split('/').pop();
const contains = (a, b) => b.box[0] >= a.box[0] - 1 && b.box[1] >= a.box[1] - 1 && b.box[0] + b.box[2] <= a.box[0] + a.box[2] + 1 && b.box[1] + b.box[3] <= a.box[1] + a.box[3] + 1;
const hugs = (a, b, px = 2) => a.box.every((v, i) => Math.abs(v - b.box[i]) <= px);

// Markup-agnostic view of a blueprint: only things that are seen, with two collapses so that
// "<a><span>Go</span></a>" equals "<a>Go</a>" and a painted wrapper hugging one child equals a child
// that paints itself.
export function prepare(nodes) {
  const all = new Map(nodes.map((n) => [n.id, n]));
  const keep = new Map();
  for (const n of nodes) if (GROUP[n.k] && area(n) >= 4) keep.set(n.id, { ...n, s: ring({ ...(n.s || {}) }) });
  const up = (n) => {
    let p = all.get(n.p);
    while (p && !keep.has(p.id)) p = all.get(p.p);
    return p && keep.get(p.id);
  };
  for (const n of [...keep.values()].reverse()) {
    const p = up(n);
    if (!p) continue;
    if (TEXTY.has(n.k) && n.text && p.text === n.text) {
      for (const k of TYPE) if (n.s[k] !== undefined) p.s[k] = n.s[k];
      for (const k of PAINT) if (p.s[k] === undefined && n.s[k] !== undefined) p.s[k] = n.s[k];
      keep.delete(n.id);
    }
  }
  const kids = new Map();
  for (const n of keep.values()) {
    const p = up(n);
    if (p) kids.set(p.id, [...(kids.get(p.id) || []), n]);
  }
  for (const p of [...keep.values()].reverse()) {
    const only = kids.get(p.id);
    if (p.k !== 'box' || only?.length !== 1 || !hugs(p, only[0])) continue;
    for (const k of PAINT) if (only[0].s[k] === undefined && p.s[k] !== undefined) only[0].s[k] = p.s[k];
    keep.delete(p.id);
  }
  return [...keep.values()];
}

// Shadows drawn in a fully transparent colour are no-ops (Tailwind emits several), and a single
// inset 0 0 0 Npx shadow draws exactly what an N px border draws.
function ring(s) {
  if (!s.sh) return s;
  const visible = s.sh.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => !/^#[0-9a-f]{6}00\b|^#0000\b/.test(x));
  const m = visible.length === 1 && /^(#[0-9a-f]{6,8}) 0px 0px 0px ([\d.]+)px inset$/.exec(visible[0]);
  if (m && !s.bw) return Object.assign(s, { bw: m[2], bc: m[1], sh: undefined });
  s.sh = visible.join(', ') || undefined;
  return s;
}

function kindCost(a, b) {
  if (a === b) return 0;
  const [ga, gb] = [GROUP[a], GROUP[b]];
  if (ga === gb) return 0.15;
  const pair = ga + gb;
  if (pair === 'TI' || pair === 'IT') return 0.4;
  if (pair === 'BI' || pair === 'IB') return 0.6;
  return Infinity;
}

function similar(a, b) {
  if (a === b) return 1;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  const [x, y] = [grams(a.toLowerCase()), grams(b.toLowerCase())];
  let both = 0;
  for (const [g, c] of x) both += Math.min(c, y.get(g) || 0);
  return (2 * both) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}

const keyOf = (n) => (n.k === 'media' ? (base(n.src) || n.alt ? `m:${base(n.src) || n.alt}` : null) : n.text ? `t:${n.text.toLowerCase()}` : null);

// Greedy matching: identical text/media first (nearest wins), then kind + text similarity + position.
export function match(A, B, diag) {
  const pairs = [];
  const [usedA, usedB] = [new Set(), new Set()];
  const take = (cands) => {
    cands.sort((p, q) => p[0] - q[0]);
    for (const [, i, j] of cands) {
      if (usedA.has(i) || usedB.has(j)) continue;
      usedA.add(i);
      usedB.add(j);
      pairs.push([A[i], B[j]]);
    }
  };
  const byKey = new Map();
  B.forEach((n, j) => {
    const k = keyOf(n);
    if (k) byKey.set(k, [...(byKey.get(k) || []), j]);
  });
  const exact = [];
  A.forEach((n, i) => {
    for (const j of byKey.get(keyOf(n)) || []) {
      const kc = kindCost(n.k, B[j].k);
      if (kc < Infinity) exact.push([kc + dist(n, B[j]) / diag, i, j]);
    }
  });
  take(exact);
  const loose = [];
  A.forEach((n, i) => {
    if (usedA.has(i)) return;
    B.forEach((m, j) => {
      if (usedB.has(j)) return;
      const kc = kindCost(n.k, m.k);
      if (kc === Infinity) return;
      const g = (dist(n, m) / diag) * 4 + Math.abs(Math.log((area(n) + 1) / (area(m) + 1))) * 0.5;
      if (g > 1.5) return;
      const tc = n.text && m.text ? (1 - similar(n.text, m.text)) * 1.5 : n.text || m.text ? 0.6 : 0;
      if (kc + g + tc < 1.6) loose.push([kc + g + tc, i, j]);
    });
  });
  take(loose);
  return { pairs, missing: A.filter((_, i) => !usedA.has(i)), extra: B.filter((_, j) => !usedB.has(j)) };
}

// ── layout ────────────────────────────────────────────────────────────────────────────────────

export function scoreLayout({ pairs, missing, extra }, tol) {
  const denom = [...pairs.map(([a]) => a), ...missing].reduce((s, n) => s + weight(n), 0) + 0.5 * extra.reduce((s, n) => s + weight(n), 0);
  if (!denom) return { score: null, issues: [] };
  const gain = (lost) => (100 * lost) / denom;
  let got = 0;
  const off = [];
  for (const [a, b] of pairs) {
    const [dx, dy, dw, dh] = b.box.map((v, i) => Math.round(v - a.box[i]));
    const tPos = tol.px, tw = tol.px + tol.rel * a.box[2], th = tol.px + tol.rel * a.box[3];
    const err = Math.max(Math.abs(dx) - tPos, Math.abs(dy) - tPos, Math.abs(dw) - tw, Math.abs(dh) - th, 0);
    const s = Math.max(0, 1 - err / (5 * tol.px + 20));
    got += s * weight(a);
    if (err > 0) off.push({ a, b, dx, dy, dw, dh, sized: Math.abs(dw) > tw || Math.abs(dh) > th, lost: (1 - s) * weight(a) });
  }
  const issues = [];
  // Many elements off by the same offset with the right size: one cause upstream, not N problems.
  const buckets = new Map();
  for (const o of off.filter((o) => !o.sized)) {
    const k = `${Math.round(o.dx / 3)},${Math.round(o.dy / 3)}`;
    buckets.set(k, [...(buckets.get(k) || []), o]);
  }
  const grouped = new Set();
  for (const group of buckets.values()) {
    if (group.length < 3) continue;
    group.sort((p, q) => p.a.box[1] - q.a.box[1] || p.a.box[0] - q.a.box[0]);
    const lead = group[0];
    const vertical = Math.abs(lead.dy) >= Math.abs(lead.dx);
    const cause = off
      .filter((o) => o.sized && (vertical ? o.a.box[1] < lead.a.box[1] && Math.sign(o.dh) === Math.sign(lead.dy) : o.a.box[0] < lead.a.box[0] && Math.sign(o.dw) === Math.sign(lead.dx)))
      .sort((p, q) => Math.abs((vertical ? p.dh - lead.dy : p.dw - lead.dx)) - Math.abs((vertical ? q.dh - lead.dy : q.dw - lead.dx)))[0];
    group.forEach((o) => grouped.add(o));
    issues.push({
      axis: 'layout',
      type: 'shift',
      gain: gain(group.reduce((s, o) => s + o.lost, 0)),
      node: lead.a,
      count: group.length,
      dx: lead.dx,
      dy: lead.dy,
      cause: cause?.a,
      causeDelta: cause && (vertical ? cause.dh : cause.dw),
    });
  }
  for (const o of off) if (!grouped.has(o)) issues.push({ axis: 'layout', type: 'box', gain: gain(o.lost), node: o.a, clone: o.b, dx: o.dx, dy: o.dy, dw: o.dw, dh: o.dh });
  // A missing card is one finding, not one per heading and paragraph inside it.
  const fold = (list, type, k) => {
    const hosts = [];
    for (const n of [...list].sort((p, q) => area(q) - area(p))) {
      const host = hosts.find((h) => contains(h.node, n));
      if (host) {
        host.kids.push(n);
        host.gain += gain(k * weight(n));
      } else hosts.push({ axis: 'layout', type, gain: gain(k * weight(n)), node: n, kids: [] });
    }
    issues.push(...hosts);
  };
  fold(missing, 'missing', 1);
  fold(extra, 'extra', 0.5);
  return { score: (100 * got) / denom, issues };
}

// ── style ─────────────────────────────────────────────────────────────────────────────────────

const PROPS = { ff: 2, fs: 2, fw: 1.5, lh: 1.5, ls: 1, c: 1.5, tt: 1, fst: 1, td: 1, bg: 1.5, bgi: 1, r: 1, bw: 1, bc: 1, sh: 1, o: 1, fl: 1, bf: 1 };
export const PROP_NAME = {
  ff: 'font-family', fs: 'font-size', fw: 'font-weight', lh: 'line-height', ls: 'letter-spacing', c: 'color', tt: 'text-transform',
  fst: 'font-style', td: 'text-decoration', bg: 'background-color', bgi: 'background-image', r: 'border-radius', bw: 'border-width',
  bc: 'border-color', sh: 'box-shadow', o: 'opacity', fl: 'filter', bf: 'backdrop-filter',
};
const DEFAULTS = { ls: 0, o: 1, tt: 'none', fst: 'normal', td: 'none' };

const rgba = (h) => [1, 3, 5, 7].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
const nums = (s) => String(s).replace(/-?\d*\.?\d+/g, (n) => String(Math.round(parseFloat(n) * 2) / 2));

function same(k, a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (k === 'c' || k === 'bg' || k === 'bc') {
    const [p, q] = [rgba(a), rgba(b)];
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= 6 && Math.abs(p[3] - q[3]) <= 10;
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.5;
  if (k === 'ff') return a.toLowerCase() === b.toLowerCase();
  return nums(a) === nums(b);
}

export function scoreStyle(pairs) {
  let got = 0, all = 0;
  const issues = [];
  const rows = pairs.map(([a, b]) => {
    const w = weight(a);
    const diffs = [];
    for (const [k, pw] of Object.entries(PROPS)) {
      const [va, vb] = [a.s[k] ?? DEFAULTS[k], b.s[k] ?? DEFAULTS[k]];
      if (va === undefined && vb === undefined) continue;
      all += w * pw;
      if (same(k, va, vb)) got += w * pw;
      else diffs.push({ prop: k, ref: va, yours: vb, w: pw });
    }
    return { a, b, w, diffs };
  });
  if (!all) return { score: null, issues };
  for (const { a, b, w, diffs } of rows) {
    if (diffs.length) issues.push({ axis: 'style', type: 'style', gain: (100 * w * diffs.reduce((s, d) => s + d.w, 0)) / all, node: a, clone: b, diffs });
  }
  return { score: (100 * got) / all, issues };
}

// Paired nodes in both blueprints whose box overlaps a rectangle (for naming pixel hotspots).
export function under(nodes, [x, y, w, h]) {
  return nodes
    .filter((n) => n.box[0] < x + w && n.box[0] + n.box[2] > x && n.box[1] < y + h && n.box[1] + n.box[3] > y && area(n) < w * h * 4)
    .sort((p, q) => area(p) - area(q))
    .slice(0, 3);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: assert } = await import('node:assert');
  // A link with a span inside equals a link with bare text; the painted wrapper folds into its child.
  const ref = prepare([{ id: 1, p: null, k: 'link', text: 'Go', box: [0, 0, 100, 40], s: { fs: 16, bg: '#ff0000' } }]);
  const clone = prepare([
    { id: 1, p: null, k: 'box', tag: 'div', box: [0, 0, 100, 40], s: { bg: '#ff0000' } },
    { id: 2, p: 1, k: 'link', text: 'Go', box: [0, 0, 100, 40], s: {} },
    { id: 3, p: 2, k: 'text', text: 'Go', box: [30, 10, 40, 20], s: { fs: 16 } },
  ]);
  assert.equal(clone.length, 1);
  const m = match(ref, clone, 1000);
  assert.equal(m.pairs.length, 1);
  assert.equal(scoreStyle(m.pairs).score, 100);
  assert.equal(scoreLayout(m, { px: 3, rel: 0.02 }).score, 100);
  console.log('match.mjs ok');
}
