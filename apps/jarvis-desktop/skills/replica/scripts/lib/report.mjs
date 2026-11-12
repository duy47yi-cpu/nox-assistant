// Markdown for the agent: blueprint.md (what to build) and report.md (what to fix next).
import { CH_NAME, describeEase } from './motion.mjs';
import { PROP_NAME } from './match.mjs';

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const base = (src) => (src || '').split(/[?#]/)[0].split('/').pop();
const top = (values, n = 10) =>
  [...values.filter((v) => v !== undefined && v !== null).reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([v, c]) => `${v} ×${c}`)
    .join(' · ');

export const label = (n) => {
  const what = n.text ? `"${trunc(n.text, 48)}"` : n.alt ? `[${trunc(n.alt, 40)}]` : n.src ? `<${trunc(base(n.src), 40)}>` : n.cls ? `.${n.cls.split('.')[0]}` : '';
  return `${n.tag || n.k}${what ? ` ${what}` : ''}`;
};
export const at = (b) => `[${Math.round(b[0])},${Math.round(b[1])} ${Math.round(b[2])}×${Math.round(b[3])}]`;

// ── blueprint ─────────────────────────────────────────────────────────────────────────────────

function styleLine(n) {
  const s = n.s || {};
  const out = [];
  if (s.fs) out.push(`${s.fw} ${s.fs}/${s.lh} ${s.ff}${s.ls ? ` ls ${s.ls}` : ''}${s.tt ? ` ${s.tt}` : ''}${s.fst ? ` ${s.fst}` : ''}`, s.c);
  if (s.ta) out.push(s.ta);
  if (s.td) out.push(s.td);
  if (s.bg) out.push(`bg ${s.bg}`);
  if (s.bgi) out.push(`bg-image ${trunc(s.bgi, 110)}`);
  if (s.r) out.push(`radius ${s.r}`);
  if (s.bw) out.push(`border ${s.bw} ${s.bc}`);
  if (s.sh) out.push(`shadow ${trunc(s.sh, 90)}`);
  if (s.pad) out.push(`pad ${s.pad}`);
  if (s.lay) out.push(s.lay);
  if (s.pos) out.push(s.pos);
  if (s.o !== undefined) out.push(`opacity ${s.o}`);
  if (s.eo !== undefined) out.push(`seen at opacity ${s.eo}`);
  if (s.fl) out.push(`filter ${s.fl}`);
  if (s.bf) out.push(`backdrop-filter ${s.bf}`);
  if (n.svg) out.push(`inline svg in blueprint.json (#${n.id})`);
  return out.filter(Boolean).join(' · ');
}

export function outline(bp, limit = 700) {
  const depth = new Map();
  const lines = [];
  for (const n of bp.nodes) {
    const d = n.p == null ? 0 : (depth.get(n.p) ?? -1) + 1;
    depth.set(n.id, d);
    if (lines.length >= limit) continue;
    const head = [`${n.tag}${n.cls ? `.${n.cls}` : ''}`, n.k];
    if (n.text) head.push(`"${trunc(n.text, 80)}"`);
    if (n.src) head.push(`<${trunc(n.src, 90)}>`);
    if (n.alt) head.push(`alt "${trunc(n.alt, 60)}"`);
    head.push(at(n.box));
    const st = styleLine(n);
    lines.push(`${'  '.repeat(d)}- ${head.join(' ')}${st ? ` · ${st}` : ''} #${n.id}`);
  }
  if (bp.nodes.length > limit) lines.push(`- … ${bp.nodes.length - limit} more nodes in blueprint.json (scope the capture with --selector to see them here)`);
  return lines.join('\n');
}

function tokens(bp) {
  const N = bp.nodes;
  const S = N.map((n) => n.s || {});
  const families = new Map();
  for (const s of S) if (s.ff) families.set(s.ff, new Set([...(families.get(s.ff) || []), s.fw]));
  const scale = [...new Set(S.filter((s) => s.fs).map((s) => `${s.fs}/${s.lh}`))].sort((a, b) => parseFloat(b) - parseFloat(a));
  const spacing = S.flatMap((s) => [...(s.pad || '').split(' '), ...((s.lay || '').match(/gap ([\d./]+)/)?.[1].split('/') || [])]).filter((v) => v && v !== '0');
  const vars = Object.entries(bp.vars || {});
  const faces = bp.fonts?.faces || [];
  return [
    `- fonts: ${[...families].map(([f, w]) => `${f} (${[...w].sort().join(', ')})`).join(' · ') || '—'}`,
    ...(faces.length ? [`- font files: ${faces.slice(0, 12).map((f) => `${f.family} ${f.weight}${f.src ? ` → ${f.src}` : ''}`).join(' · ')}`] : []),
    ...(bp.fonts?.links?.length ? [`- font stylesheets: ${bp.fonts.links.join(' · ')}`] : []),
    `- type scale (size/line-height px): ${scale.join(' · ') || '—'}`,
    `- text colors: ${top(S.map((s) => s.c)) || '—'}`,
    `- backgrounds: ${top(S.map((s) => s.bg)) || '—'}`,
    ...(S.some((s) => s.bgi) ? [`- background images: ${top(S.map((s) => s.bgi && trunc(s.bgi, 120)), 6)}`] : []),
    `- borders: ${top(S.map((s) => s.bw && (s.bw.includes(' ') ? `${s.bw} (top right bottom left) ${s.bc}` : `${s.bw}px ${s.bc}`))) || '—'}`,
    `- radii: ${top(S.map((s) => s.r)) || '—'}`,
    `- shadows: ${top(S.map((s) => s.sh), 6) || '—'}`,
    `- spacing in use (padding/gap px): ${top(spacing, 14) || '—'}`,
    ...(vars.length ? [`- css variables (${vars.length}): ${vars.slice(0, 40).map(([k, v]) => `${k}: ${v}`).join(' · ')}${vars.length > 40 ? ' · … (all in blueprint.json)' : ''}`] : []),
    `- media: ${N.filter((n) => n.k === 'media').slice(0, 20).map((n) => `${n.tag}${n.src ? ` ${trunc(n.src, 80)}` : ''} ${Math.round(n.box[2])}×${Math.round(n.box[3])}`).join(' · ') || '—'}`,
  ].join('\n');
}

function responsive(primary, other) {
  const byPath = new Map(primary.nodes.map((n) => [n.path, n]));
  const seen = new Set();
  const lines = [];
  for (const n of other.nodes) {
    const p = byPath.get(n.path);
    if (!p) continue;
    seen.add(n.path);
    if (p.s?.lay !== n.s?.lay && (p.s?.lay || n.s?.lay)) lines.push(`- ${label(n)}: ${p.s?.lay || 'block'} → ${n.s?.lay || 'block'}`);
    if (p.s?.fs && n.s?.fs && (p.s.fs !== n.s.fs || p.s.lh !== n.s.lh)) lines.push(`- ${label(n)}: font ${p.s.fs}/${p.s.lh} → ${n.s.fs}/${n.s.lh}`);
    if (p.s?.pad !== n.s?.pad && p.s?.pad && n.s?.pad) lines.push(`- ${label(n)}: pad ${p.s.pad} → ${n.s.pad}`);
  }
  const named = (n) => n.text || n.src || n.k === 'box';
  const hidden = primary.nodes.filter((n) => !seen.has(n.path) && named(n) && !other.nodes.some((m) => m.path === n.path));
  const shown = other.nodes.filter((n) => !byPath.has(n.path) && named(n));
  if (hidden.length) lines.push(`- not shown here (${hidden.length}): ${hidden.slice(0, 8).map(label).join(' · ')}`);
  if (shown.length) lines.push(`- only shown here (${shown.length}): ${shown.slice(0, 8).map(label).join(' · ')}`);
  return lines.slice(0, 60).join('\n') || '- no layout, font or visibility changes';
}

export function change(seg) {
  const name = CH_NAME[seg.ch];
  if (seg.yoyo) return `${name} ${seg.from} → ${seg.peak} → ${seg.to}`;
  if ((seg.ch === 'x' || seg.ch === 'y') && !seg.open) {
    const d = Math.round((seg.from - seg.to) * 10) / 10;
    return `${name} ${d > 0 ? '+' : ''}${d}px → rest`;
  }
  if (seg.ch === 'r') return `rotate ${seg.from}° → ${seg.to}°`;
  if (seg.ch === 'w' || seg.ch === 'h') return `${name} ${seg.from} → ${seg.to}px${seg.from && seg.to ? ` (×${(seg.from / seg.to).toFixed(2)} of final)` : ''}`;
  return `${name} ${seg.from} → ${seg.to}`;
}

function timeline(motion) {
  const rows = [];
  for (const t of motion.tracks) {
    const groups = new Map();
    for (const s of t.segs) {
      const k = `${s.start}|${s.dur}`;
      groups.set(k, [...(groups.get(k) || []), s]);
    }
    for (const segs of groups.values()) rows.push({ t, segs, start: segs[0].start });
  }
  rows.sort((a, b) => a.start - b.start || a.t.box[1] - b.t.box[1]);
  return [
    '| start ms | element | change | duration ms | easing |',
    '|---|---|---|---|---|',
    ...rows.slice(0, 80).map(({ t, segs }) => `| ${segs[0].start} | ${label(t)} ${at(t.box)} | ${segs.map(change).join(', ')} | ${segs[0].dur}${segs[0].open ? '+' : ''} | ${describeEase(segs.find((s) => s.ease || s.spring) || segs[0])} |`),
    ...(rows.length > 80 ? [`\n… ${rows.length - 80} more rows in motion/motion.json`] : []),
  ].join('\n');
}

function declared(list) {
  const seen = new Set();
  const out = [];
  for (const d of list || []) {
    const key = JSON.stringify([d.el, d.name, d.duration, d.delay, d.easing]);
    if (seen.has(key) || out.length >= 40) continue;
    seen.add(key);
    const frames = Array.isArray(d.keyframes) ? d.keyframes : [];
    // CSS animation-timing-function lives on the keyframes, so the effect itself reports linear.
    const kfEase = new Set(frames.slice(0, -1).map((k) => k.easing || 'linear'));
    const easing = d.easing === 'linear' && kfEase.size === 1 && !kfEase.has('linear') ? `${[...kfEase][0]} (per keyframe)` : d.easing;
    const kf = frames.length ? frames.map(({ at, easing: _, ...p }) => `${at}: ${Object.entries(p).map(([k, v]) => `${k} ${v}`).join(', ')}`).join(' → ') : d.keyframes;
    out.push(
      `- ${label(d)}${d.pseudo || ''} · ${d.type}${d.name ? ` \`${d.name}\`` : ''} · start ${d.start}ms · ${d.duration}ms · delay ${d.delay}ms · ${easing} · iterations ${d.iterations}${d.direction !== 'normal' ? ` · ${d.direction}` : ''} · fill ${d.fill}${kf ? `\n  - keyframes: ${trunc(kf, 400)}` : ''}`,
    );
  }
  return out.join('\n');
}

export function blueprintMd(meta, bps, motion) {
  const names = Object.keys(bps);
  const [first] = names;
  const bp = bps[first];
  const out = [
    `# Replica blueprint — ${bp.title || meta.source}`,
    '',
    `Source: ${meta.source}${meta.opts.selector ? ` · selector \`${meta.opts.selector}\`` : ''} · action \`${meta.opts.action}\` · level \`${meta.level}\` · captured ${meta.captured}`,
    '',
    `Build from these measurements, not from memory or habit: every value was read from the rendered page. Boxes are \`[x,y w×h]\` in CSS px from the root's top-left; \`#n\` ids point into \`<viewport>/blueprint.json\`. Look at \`${first}/shot.png\`${motion ? ' and `motion/filmstrip.png`' : ''} alongside this file.`,
    '',
    `## Tokens (${first})`,
    '',
    tokens(bp),
    '',
    `## Outline (${first}, root ${bp.root.box.w}×${bp.root.box.h})`,
    '',
    outline(bp),
  ];
  for (const name of names.slice(1)) {
    out.push('', `## Responsive: ${name} (root ${bps[name].root.box.w}×${bps[name].root.box.h}) — changes vs ${first}; full outline in \`${name}/outline.md\``, '', responsive(bp, bps[name]));
  }
  if (motion) {
    out.push('', `## Motion (${first}, action \`${motion.action}\`, ${motion.fps} fps, t = 0 at the action)`, '');
    out.push(motion.tracks.length ? timeline(motion) : 'Nothing visible moved during the recording.');
    const d = declared(bp.declared);
    if (d) out.push('', '### Declared animations (exact values read from the page — prefer these over the fitted ones)', '', d);
  }
  return out.join('\n') + '\n';
}

// ── report ────────────────────────────────────────────────────────────────────────────────────

const px = (v) => `${Math.abs(v)}px`;
function moves({ dx, dy, dw, dh }) {
  return [
    dx && `${px(dx)} too far ${dx > 0 ? 'right' : 'left'}`,
    dy && `${px(dy)} too ${dy > 0 ? 'low' : 'high'}`,
    dw && `${px(dw)} too ${dw > 0 ? 'wide' : 'narrow'}`,
    dh && `${px(dh)} too ${dh > 0 ? 'tall' : 'short'}`,
  ].filter(Boolean).join(', ');
}
const fmt = (v) => (v === undefined ? 'none' : typeof v === 'number' ? `${v}` : trunc(String(v), 80));

const diffText = (diffs) => diffs.map((d) => `${PROP_NAME[d.prop]} ${fmt(d.ref)} (yours ${fmt(d.yours)})`).join(' · ');
const inside = (i) => (i.kids?.length ? ` with ${i.kids.length} thing${i.kids.length > 1 ? 's' : ''} inside (${i.kids.slice(0, 3).map(label).join(', ')}${i.kids.length > 3 ? ', …' : ''})` : '');
const also = (i) =>
  i.also?.length ? ` Same on ${i.also.length} more: ${i.also.slice(0, 3).map((n) => `${label(n)} ${at(n.box)}`).join(', ')}${i.also.length > 3 ? ', …' : ''}.` : '';

export function issueText(i) {
  const n = i.node;
  switch (i.type) {
    case 'box':
      return `**layout** · ${label(n)} ${at(n.box)} — ${moves(i)}. Yours: ${at(i.clone.box)}.`;
    case 'shift': {
      const where = i.dy && Math.abs(i.dy) >= Math.abs(i.dx) ? `${px(i.dy)} too ${i.dy > 0 ? 'low' : 'high'}` : `${px(i.dx)} too far ${i.dx > 0 ? 'right' : 'left'}`;
      const why = i.causeStyle ? ` (${diffText(i.causeStyle)})` : '';
      const cause = i.cause
        ? `Likely cause: ${label(i.cause)} ${at(i.cause.box)} is ${px(i.causeDelta)} ${Math.abs(i.dy) >= Math.abs(i.dx) ? (i.causeDelta > 0 ? 'taller' : 'shorter') : i.causeDelta > 0 ? 'wider' : 'narrower'} than the reference${why} — fix that and these follow.`
        : `Nothing before them changed size, so the spacing (margin / gap / padding) just before ${label(n)} differs.`;
      return `**layout** · ${i.count} elements sit ${where}, starting at ${label(n)} ${at(n.box)}. ${cause}`;
    }
    case 'missing':
      return `**missing** · ${label(n)} ${at(n.box)} (${n.k})${inside(i)} has no counterpart in yours.${also(i)}`;
    case 'extra':
      return `**extra** · yours has ${label(n)} ${at(n.box)} (${n.k})${inside(i)}; the reference has nothing like it there.${also(i)}`;
    case 'style':
      return `**style** · ${label(n)} ${at(n.box)} — ${diffText(i.diffs)}.${also(i)}`;
    case 'motion':
      return `**motion** · ${label(n)} ${at(n.box)} — ${i.problems.join('; ')}${i.follow ? ` · ${i.follow} element${i.follow > 1 ? 's' : ''} inside move with it and repeat this — fix it here and they follow.` : ''}`;
    case 'motion-missing':
      return `**motion** · ${label(n)} ${at(n.box)} animates in the reference (${n.segs.map((s) => `${change(s)} from ${s.start}ms over ${s.dur}ms, ${describeEase(s)}`).join('; ')}) but nothing matching moves in yours.`;
    case 'motion-extra':
      return `**motion** · ${label(n)} ${at(n.box)} moves in yours (${n.segs.map(change).join(', ')}) but not in the reference.`;
    case 'hotspot':
      return `**pixels** · region ${at(i.box)} holds ${Math.round(i.share * 100)}% of the differing pixels — ${i.names?.length ? `over ${i.side === 'yours' ? 'your ' : ''}${i.names.map(label).join(', ')}` : 'no measured element explains it (image, icon, gradient, canvas or font rendering?)'}. Look at \`sheets/${i.vp}-hot${i.hot}.png\`.`;
    case 'size': {
      const [dw, dh] = [i.clone[0] - i.ref[0], i.clone[1] - i.ref[1]];
      const what = [dh && `${px(dh)} ${dh > 0 ? 'taller' : 'shorter'}`, dw && `${px(dw)} ${dw > 0 ? 'wider' : 'narrower'}`].filter(Boolean).join(', ');
      return `**size** · yours is ${i.clone.join('×')}, the reference ${i.ref.join('×')} (${what}); everything outside the overlap counts as differing pixels. This usually follows from the findings above — if not, check the root's height, min-height and padding.`;
    }
    case 'timing':
      return `**motion** · ${i.text}`;
    default:
      return JSON.stringify(i);
  }
}

export function reportMd(r) {
  const tick = (a) => (a.gate == null ? 'info' : a.score >= a.gate ? `≥ ${a.gate} ✓` : `≥ ${a.gate} ✗`);
  const delta = r.prev ? ` (round ${r.prev.round}: ${r.prev.overall.toFixed(1)}, ${r.overall >= r.prev.overall ? '▲' : '▼'} ${Math.abs(r.overall - r.prev.overall).toFixed(1)})` : '';
  const out = [
    `# Replica · round ${r.round} · level \`${r.level}\``,
    '',
    `**Score ${r.overall.toFixed(1)}${delta} — ${r.pass ? 'PASS ✓' : 'NOT YET ✗'}**`,
    '',
    '| axis | score | gate |',
    '|---|---|---|',
    ...Object.entries(r.axes).map(([k, a]) => `| ${k} | ${a.score.toFixed(1)}${a.note ? ` (${a.note})` : ''} | ${tick(a)} |`),
    '',
    ...r.views.map((v) => `- ${v.name}: reference ${v.refSize.join('×')} · yours ${v.cloneSize.join('×')}${v.refSize[1] !== v.cloneSize[1] ? ` (${v.cloneSize[1] > v.refSize[1] ? '+' : ''}${v.cloneSize[1] - v.refSize[1]}px tall)` : ''} · ${(v.ratio * 100).toFixed(2)}% pixels differ${v.placeholders?.length ? ` · placeholders left out of pixels: ${v.placeholders.map(at).join(' ')}` : ''}`),
  ];
  if (r.prev && r.overall < r.prev.overall) out.push('', `> Score went down since round ${r.prev.round}. Undo the last change that made things worse before trying something new.`);
  out.push('', '## Fix next (highest gain first)', '');
  if (!r.issues.length) out.push('Nothing left above tolerance.');
  r.issues.slice(0, 20).forEach((i, k) => out.push(`${k + 1}. ${issueText(i)}${i.vps ? ` _[${i.vps.join(', ')}]_` : ''} **(+${i.gain.toFixed(1)} ${i.axis === 'missing' || i.axis === 'extra' ? 'layout' : i.axis})**`));
  if (r.issues.length > 20) out.push('', `…and ${r.issues.length - 20} smaller ones in \`issues.json\`.`);
  out.push('', '## Look at', '');
  for (const v of r.views) out.push(`- \`${v.sheets.join('`, `')}\` — reference | yours | diff (numbered boxes are hotspots)`, ...(v.zooms.length ? [`- \`${v.zooms.join('`, `')}\` — hotspots zoomed`] : []));
  if (r.motion) {
    out.push(`- \`${r.motion.strip}\` — reference vs yours over time${r.motion.worst ? `; \`${r.motion.worst}\` — the frame that differs most (${r.motion.worstAt}ms)` : ''}`);
    out.push('', '## Motion timing', '', r.motion.summary);
  }
  return out.join('\n') + '\n';
}
