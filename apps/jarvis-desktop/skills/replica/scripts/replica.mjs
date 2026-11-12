#!/usr/bin/env node
// Replica CLI: capture a reference, then compare clone rounds against it until the score passes.
import { parseArgs } from 'node:util';
import { readFile, writeFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launch, captureUrl, captureImage, captureVideo, vpName, parseAction } from './lib/capture.mjs';
import { openLab } from './lib/pixels.mjs';
import { prepare, match, scoreLayout, scoreStyle, under, weight } from './lib/match.mjs';
import { pairSegments, segScore, onsetSettle, describeEase, CH_NAME } from './lib/motion.mjs';
import { blueprintMd, outline, reportMd, issueText } from './lib/report.mjs';

const HELP = `replica — rebuild UI from a reference and prove it with a score

  node replica.mjs capture <url|file.html|image|video> --out <dir> [options]
  node replica.mjs compare <ref-dir> <clone url|file.html> [options]
  node replica.mjs doctor

capture options
  --selector <css>      capture one element (section, component) instead of the whole page
  --viewports <list>    e.g. 1440x900,390x844 (default 1440x900; the first one is primary)
  --action <a>          what starts the motion: load (default) | reveal | hover:<css> | click:<css>
                        | focus:<css> | scroll:<px> | scrub:<px>
  --motion <ms>         record this long after the action, frame by frame (default 0 = stills only)
  --fps <n>             motion frame rate (default 30)
  --settle <ms>         virtual time allowed for things to come to rest (default 2500)
  --level <l>           structure | faithful (default) | exact — the bar compare will hold the clone to
  --hide <css>          hide elements on both sides (cookie banners, chat widgets, dev overlays)
  --wait <css>          wait until this element exists before capturing
  --scheme <s>          light (default) | dark
  --storage <file>      Playwright storageState JSON for pages behind a login
  image/video sources:  --dpr <n> (2 for @2x exports and retina recordings), --viewports <WxH> for
                        the clone, and for video --crop x,y,w,h --start <s> --end <s>

compare options
  --out <dir>           default: round-N next to the reference directory
  --selector, --action, --hide, --wait, --storage
                        override the reference's values for the clone side (e.g. a different selector)
  --level <l>           override the level stored with the reference

compare exits 0 when every gated axis passes, 1 when not yet, 2 on errors.`;

export const LEVELS = {
  structure: { tol: { px: 8, rel: 0.04, ms: 80 }, gate: { layout: 90, motion: 85 } },
  faithful: { tol: { px: 3, rel: 0.02, ms: 50 }, gate: { layout: 95, style: 95, pixels: 85, motion: 90 } },
  exact: { tol: { px: 1, rel: 0.01, ms: 34 }, gate: { layout: 98, style: 98, pixels: 97, motion: 95 } },
};

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.gif', '.mkv', '.m4v']);
const pixelScore = (ratio) => Math.max(0, 100 - 1000 * ratio); // every 1% of differing pixels costs 10 points
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const toUrl = (s) => (/^[a-z]+:\/\//i.test(s) ? s : pathToFileURL(resolve(s)).href);
const pad = (k) => String(k).padStart(4, '0');

function parseViewports(s) {
  return s.split(',').map((v) => {
    const m = /^(\d+)x(\d+)$/.exec(v.trim());
    if (!m) throw new Error(`Bad viewport "${v}", expected WIDTHxHEIGHT like 1440x900`);
    return { width: +m[1], height: +m[2] };
  });
}

function options(f) {
  const level = f.level || 'faithful';
  if (!LEVELS[level]) throw new Error(`--level must be one of ${Object.keys(LEVELS).join(', ')}`);
  parseAction(f.action);
  return {
    level,
    opts: {
      selector: f.selector || null,
      viewports: f.viewports ? parseViewports(f.viewports) : null,
      action: f.action || 'load',
      motion: +(f.motion || 0),
      fps: +(f.fps || 30),
      settle: +(f.settle || 2500),
      scheme: f.scheme || 'light',
      hide: f.hide || null,
      wait: f.wait || null,
      dpr: +(f.dpr || 1),
      crop: f.crop || null,
      start: f.start ? +f.start : null,
      end: f.end ? +f.end : null,
    },
  };
}

// ── capture ───────────────────────────────────────────────────────────────────────────────────

async function capture(source, f) {
  if (!source || !f.out) throw new Error('capture needs a source and --out <dir>');
  const out = resolve(f.out);
  const { level, opts } = options(f);
  const ext = extname(source.split('?')[0]).toLowerCase();
  const kind = /^[a-z]+:\/\//i.test(source) || ext === '.html' || ext === '.htm' ? 'url' : IMAGE.has(ext) ? 'image' : VIDEO.has(ext) ? 'video' : null;
  if (!kind) throw new Error(`Don't know how to capture "${source}" (URL, .html, image or video expected)`);
  await mkdir(out, { recursive: true });
  const browser = await launch();
  try {
    const meta = { tool: 'replica', version: 1, kind, source: kind === 'url' ? toUrl(source) : resolve(source), level, captured: new Date().toISOString(), browser: browser.version() };
    if (kind === 'url') {
      opts.viewports ??= [{ width: 1440, height: 900 }];
      const res = await captureUrl(browser, { ...opts, url: meta.source, storage: f.storage }, out);
      Object.assign(meta, { opts, roots: res.roots });
      const bps = {};
      for (const vp of opts.viewports) {
        bps[vpName(vp)] = await readJson(join(out, vpName(vp), 'blueprint.json'));
        await writeFile(join(out, vpName(vp), 'outline.md'), outline(bps[vpName(vp)], 5000) + '\n');
      }
      if (res.motion) await filmstrip(browser, out, res.motion);
      await writeFile(join(out, 'blueprint.md'), blueprintMd(meta, bps, res.motion));
    } else {
      const lab = await openLab(browser);
      const res = kind === 'image' ? await captureImage(lab, resolve(source), opts, out) : await captureVideo(lab, resolve(source), opts, out);
      Object.assign(meta, { opts: { ...opts, viewports: res.viewports, motion: Math.round(res.motion || 0) }, roots: res.roots });
      if (kind === 'video') await filmstrip(browser, out, await readJson(join(out, 'motion', 'motion.json')));
    }
    await writeFile(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
    const first = vpName(meta.opts.viewports[0]);
    console.log(`Captured ${kind} → ${relative(process.cwd(), out) || '.'}`);
    if (kind === 'url') console.log(`  read   ${join(relative(process.cwd(), out), 'blueprint.md')}`);
    console.log(`  view   ${join(relative(process.cwd(), out), first, 'shot.png')}`);
    if (meta.opts.motion) console.log(`  view   ${join(relative(process.cwd(), out), 'motion', 'filmstrip.png')}`);
    const open = kind === 'url' && meta.opts.motion ? (await readJson(join(out, 'motion', 'motion.json'))).tracks.filter((t) => t.segs.some((g) => g.open)).length : 0;
    if (open) console.log(`  note   ${open} element(s) were still moving when the recording ended — re-capture with a longer --motion unless they loop forever`);
  } finally {
    await browser.close();
  }
}

async function filmstrip(browser, out, motion) {
  const lab = await openLab(browser);
  const n = motion.times.length;
  const picks = [...new Set(Array.from({ length: Math.min(12, n) }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, Math.min(12, n) - 1))))];
  for (const k of picks) await lab.load(`f${k}`, join(out, 'motion', 'frames', `${pad(k)}.png`));
  const png = await lab.strip([{ label: 'REF', keys: picks.map((k) => `f${k}`) }], picks.map((k) => motion.times[k]));
  await lab.write(join(out, 'motion', 'filmstrip.png'), png);
  await lab.close();
}

// ── compare ───────────────────────────────────────────────────────────────────────────────────

async function compare(refDir, cloneSrc, f) {
  if (!refDir || !cloneSrc) throw new Error('compare needs <ref-dir> and <clone url|file>');
  refDir = resolve(refDir);
  const meta = await readJson(join(refDir, 'meta.json'));
  const level = f.level || meta.level;
  if (!LEVELS[level]) throw new Error(`--level must be one of ${Object.keys(LEVELS).join(', ')}`);
  const { tol, gate } = LEVELS[level];
  const parent = dirname(refDir);
  const done = (await readdir(parent)).filter((d) => /^round-\d+$/.test(d)).map((d) => +d.slice(6));
  const round = Math.max(0, ...done) + 1;
  const out = f.out ? resolve(f.out) : join(parent, `round-${round}`);
  const o = {
    ...meta.opts,
    url: toUrl(cloneSrc),
    selector: f.selector ?? meta.opts.selector,
    action: f.action ?? meta.opts.action,
    hide: f.hide ?? meta.opts.hide,
    wait: f.wait ?? meta.opts.wait,
    storage: f.storage,
  };
  if (meta.kind === 'video' && o.action === 'load' && !f.action) console.warn('note: reference is a video; the clone is recorded from page load. Pass --action if the recording starts on an interaction.');

  const browser = await launch();
  try {
    const cap = await captureUrl(browser, o, join(out, 'clone'));
    const lab = await openLab(browser);
    const rel = (p) => relative(out, p);
    const views = [];
    let issues = [];
    let structural = null;

    for (const vp of meta.opts.viewports) {
      const name = vpName(vp);
      await lab.load('ref', join(refDir, name, 'shot.png'));
      await lab.load('clone', join(out, 'clone', name, 'shot.png'));
      const cb = await readJson(join(out, 'clone', name, 'blueprint.json'));
      // Placeholders (data-replica="placeholder") stand in for assets the clone may not reuse:
      // layout still checks their boxes, the pixel score leaves them out, except where something
      // paints in front (a headline over a background illustration): those pixels still count.
      // ponytail: holes are the clone's boxes; a misplaced clone hides a bit of the reference's text.
      const byId = new Map(cb.nodes.map((n) => [n.id, n]));
      const above = (n) => { const ids = new Set(); for (let p = n.p; p != null; p = byId.get(p)?.p) ids.add(p); return ids; };
      const parents = new Set(cb.nodes.map((n) => n.p));
      const paints = (n) => !parents.has(n.id) || n.s.bg || n.s.bgi || n.s.bw || n.s.sh;
      const skip = cb.nodes.filter((n) => n.ph).map((ph) => {
        const up = above(ph);
        return [...ph.box, cb.nodes.filter((n) => !n.ph && paints(n) && !up.has(n.id) && !above(n).has(ph.id)).map((n) => n.box)];
      });
      const px = await lab.compare('ref', 'clone', { title: name, skip });
      const sheets = [];
      for (const [i, b64] of px.sheets.entries()) sheets.push(rel(await lab.write(join(out, 'sheets', px.sheets.length > 1 ? `${name}-${i + 1}.png` : `${name}.png`), b64)));
      const zooms = [];
      for (const [i, b64] of px.zooms.entries()) zooms.push(rel(await lab.write(join(out, 'sheets', `${name}-hot${i + 1}.png`), b64)));
      await lab.drop('ref', 'clone');
      const view = { name, ratio: px.ratio, refSize: px.refSize, cloneSize: px.cloneSize, sheets, zooms, hotspots: px.hotspots, placeholders: skip.map((b) => b.slice(0, 4)) };

      let nodes = [];
      if (meta.kind === 'url') {
        const rb = await readJson(join(refDir, name, 'blueprint.json'));
        const A = prepare(rb.nodes), B = prepare(cb.nodes);
        const m = match(A, B, Math.hypot(rb.root.box.w, Math.min(rb.root.box.h, 3000)));
        const lay = scoreLayout(m, tol);
        const sty = scoreStyle(m.pairs);
        Object.assign(view, { layout: lay.score, style: sty.score });
        issues.push(...[...lay.issues, ...sty.issues].map((i) => ({ ...i, vp: name })));
        nodes = A;
        structural ??= { A, B, diag: Math.hypot(rb.root.box.w, Math.min(rb.root.box.h, 3000)) };
      } else {
        // No structure on the reference side: name what sits under each hotspot in the clone instead.
        nodes = prepare(cb.nodes);
      }
      const [[rw, rh], [cw, ch]] = [px.refSize, px.cloneSize];
      if (rw !== cw || rh !== ch) {
        const outside = px.size[0] * px.size[1] - Math.min(rw, cw) * Math.min(rh, ch);
        issues.push({ axis: 'pixels', type: 'size', vp: name, ref: px.refSize, clone: px.cloneSize, gain: (1000 * outside) / (px.size[0] * px.size[1]) });
      }
      // Hotspots that no structural issue explains become pixel issues of their own.
      for (const [i, h] of px.hotspots.entries()) {
        const names = under(nodes, h.box);
        const explained = names.some((n) => issues.some((is) => is.vp === name && (is.node === n || is.clone === n)));
        if (!explained && h.share >= 0.05) {
          issues.push({ axis: 'pixels', type: 'hotspot', vp: name, hot: i + 1, box: h.box, share: h.share, names, side: meta.kind === 'url' ? 'reference' : 'yours', gain: (1000 * h.count) / (px.size[0] * px.size[1]) });
        }
      }
      views.push(view);
    }
    for (const i of issues) i.gain /= views.length; // each viewport carries 1/n of every axis

    const axes = {};
    const add = (k, score, note) => score != null && (axes[k] = { score, gate: gate[k] ?? null, ...(note && { note }) });
    add('layout', mean(views.map((v) => v.layout).filter((v) => v != null)));
    add('style', mean(views.map((v) => v.style).filter((v) => v != null)));
    const ph = views.reduce((s, v) => s + v.placeholders.length, 0);
    add('pixels', mean(views.map((v) => pixelScore(v.ratio))), `${(mean(views.map((v) => v.ratio)) * 100).toFixed(2)}% differ${ph ? `, ${ph} placeholder${ph > 1 ? 's' : ''} left out` : ''}`);

    let motion = null;
    if (meta.opts.motion > 0) {
      motion = await compareMotion(lab, meta, refDir, out, cap.motion, tol, structural);
      add('motion', motion.score);
      issues.push(...motion.issues);
    }

    // A shift's cause is the thing to fix: name its style differences right in the shift finding.
    for (const sh of issues.filter((i) => i.type === 'shift' && i.cause)) {
      sh.causeStyle = issues.find((i) => i.type === 'style' && i.node === sh.cause && i.vp === sh.vp)?.diffs;
      const own = issues.findIndex((i) => i.type === 'box' && i.node === sh.cause && i.vp === sh.vp);
      if (own >= 0) sh.gain += issues.splice(own, 1)[0].gain;
    }
    // One fix per finding: the same difference on several viewports, or on repeated components
    // (three cards with the same wrong radius), is listed once.
    const signature = (i) => (i.type === 'style' ? `style|${JSON.stringify(i.diffs.map((d) => [d.prop, d.ref, d.yours]))}` : issueText(i).replace(/\[-?\d+,-?\d+ \d+×\d+\]/g, ''));
    const merged = new Map();
    for (const i of issues) {
      const m = merged.get(signature(i));
      if (!m) {
        merged.set(signature(i), { ...i, vps: i.vp ? [i.vp] : undefined, also: [] });
        continue;
      }
      m.gain += i.gain;
      if (i.vp && !m.vps.includes(i.vp)) m.vps.push(i.vp);
      else if (i.node && i.vp === m.vps?.[0]) m.also.push(i.node);
    }
    const gated = (i) => gate[i.axis === 'missing' || i.axis === 'extra' ? 'layout' : i.axis] != null;
    issues = [...merged.values()].sort((a, b) => gated(b) - gated(a) || b.gain - a.gain);
    if (views.length < 2) issues.forEach((i) => delete i.vps);

    const scored = Object.entries(axes).filter(([, a]) => a.gate != null);
    const overall = mean(scored.map(([, a]) => a.score));
    const pass = scored.every(([, a]) => a.score >= a.gate);
    const history = join(parent, 'history.jsonl');
    const prev = existsSync(history) ? (await readFile(history, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1) : null;
    const result = { round: f.out ? 'custom' : round, level, pass, overall, axes, views, issues, prev, motion };

    await writeFile(join(out, 'report.md'), reportMd(result));
    await writeFile(join(out, 'issues.json'), JSON.stringify(issues.map((i) => ({ axis: i.axis, gain: +i.gain.toFixed(2), text: issueText(i), vps: i.vps })), null, 2));
    const summary = { round: result.round, level, pass, overall: +overall.toFixed(2), axes: Object.fromEntries(Object.entries(axes).map(([k, a]) => [k, +a.score.toFixed(2)])), clone: o.url, at: new Date().toISOString() };
    await writeFile(join(out, 'score.json'), JSON.stringify(summary, null, 2));
    if (!f.out) await appendFile(history, JSON.stringify(summary) + '\n');

    console.log(`Replica round ${result.round} · ${level} · score ${overall.toFixed(1)} — ${pass ? 'PASS' : 'NOT YET'}`);
    for (const [k, a] of Object.entries(axes)) console.log(`  ${k.padEnd(7)} ${a.score.toFixed(1).padStart(5)}  ${a.gate == null ? 'info' : a.score >= a.gate ? `>= ${a.gate} ok` : `>= ${a.gate} FAIL`}`);
    for (const i of issues.slice(0, 5)) console.log(`  · ${issueText(i).replace(/\*\*/g, '')}`);
    console.log(`  report ${join(relative(process.cwd(), out), 'report.md')}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    await browser.close();
  }
}

async function compareMotion(lab, meta, refDir, out, cloneMotion, tol, structural) {
  const refMotion = await readJson(join(refDir, 'motion', 'motion.json'));
  const n = Math.min(refMotion.times.length, cloneMotion.times.length);
  const times = refMotion.times.slice(0, n);
  const ratios = [], actRef = [0], actClone = [0];
  for (let k = 0; k < n; k++) {
    await lab.load(`r${k}`, join(refDir, 'motion', 'frames', `${pad(k)}.png`));
    await lab.load(`c${k}`, join(out, 'clone', 'motion', 'frames', `${pad(k)}.png`));
    ratios.push(await lab.ratio(`r${k}`, `c${k}`));
    if (k) {
      actRef.push(await lab.activity(`r${k - 1}`, `r${k}`));
      actClone.push(await lab.activity(`c${k - 1}`, `c${k}`));
      await lab.drop(`r${k - 1}`, `c${k - 1}`);
    }
  }
  await lab.drop(`r${n - 1}`, `c${n - 1}`);

  const picks = [...new Set(Array.from({ length: Math.min(6, n) }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, Math.min(6, n) - 1))))];
  for (const k of picks) {
    await lab.load(`r${k}`, join(refDir, 'motion', 'frames', `${pad(k)}.png`));
    await lab.load(`c${k}`, join(out, 'clone', 'motion', 'frames', `${pad(k)}.png`));
  }
  const strip = await lab.strip(
    [
      { label: 'REF', keys: picks.map((k) => `r${k}`) },
      { label: 'YOURS', keys: picks.map((k) => `c${k}`), notes: picks.map((k) => `${(ratios[k] * 100).toFixed(1)}% differ`) },
    ],
    picks.map((k) => times[k]),
  );
  const stripPath = await lab.write(join(out, 'sheets', 'motion.png'), strip);
  const worstK = ratios.indexOf(Math.max(...ratios));
  let worst = null;
  if (ratios[worstK] > 0.001) {
    await lab.load('rw', join(refDir, 'motion', 'frames', `${pad(worstK)}.png`));
    await lab.load('cw', join(out, 'clone', 'motion', 'frames', `${pad(worstK)}.png`));
    const w = await lab.compare('rw', 'cw', { title: `${times[worstK]}ms`, zooms: 0 });
    worst = await lab.write(join(out, 'sheets', 'motion-worst.png'), w.sheets[0]);
  }

  const timing = [onsetSettle(actRef, times), onsetSettle(actClone, times)];
  const lines = [`- mean frame difference ${(mean(ratios) * 100).toFixed(2)}%, worst ${(ratios[worstK] * 100).toFixed(2)}% at ${times[worstK]}ms`];
  const issues = [];
  let timingScore = null;
  if (timing[0] && timing[1]) {
    const [a, b] = timing;
    lines.push(`- visible motion: reference ${a.onset}–${a.settle}ms · yours ${b.onset}–${b.settle}ms`);
    const errs = [Math.abs(a.onset - b.onset), Math.abs(a.settle - b.settle)];
    timingScore = mean(errs.map((e) => (e <= tol.ms ? 1 : Math.max(0, 1 - (e - tol.ms) / 300))));
    if (errs[0] > tol.ms) issues.push({ axis: 'motion', type: 'timing', gain: 0, text: `motion starts ${b.onset - a.onset > 0 ? `${b.onset - a.onset}ms late` : `${a.onset - b.onset}ms early`} (reference starts at ${a.onset}ms, yours at ${b.onset}ms)` });
    if (errs[1] > tol.ms) issues.push({ axis: 'motion', type: 'timing', gain: 0, text: `motion settles ${b.settle - a.settle > 0 ? `${b.settle - a.settle}ms late` : `${a.settle - b.settle}ms early`} (reference at ${a.settle}ms, yours at ${b.settle}ms)` });
  } else if (timing[0] || timing[1]) {
    timingScore = 0;
    issues.push({ axis: 'motion', type: 'timing', gain: 0, text: timing[0] ? 'the reference moves but nothing visibly moves in yours' : 'yours moves but the reference does not' });
  }
  const frameScore = pixelScore(mean(ratios));

  let score;
  if (meta.kind === 'url') {
    ({ score } = scoreTracks(refMotion.tracks, cloneMotion.tracks, tol, structural, issues));
  } else {
    score = timingScore == null ? frameScore : (timingScore * 100 + frameScore) / 2;
    issues.forEach((i) => (i.gain = (100 - score) / Math.max(1, issues.length)));
  }
  return {
    score,
    issues: issues.map((i) => ({ ...i, vp: undefined })),
    strip: relative(out, stripPath),
    worst: worst && relative(out, worst),
    worstAt: times[worstK],
    summary: lines.join('\n'),
  };
}

// Pair moving elements like still ones, then pair their segments channel by channel.
function scoreTracks(refTracks, cloneTracks, tol, structural, issues) {
  if (!refTracks.length && !cloneTracks.length) return { score: 100 };
  const diag = structural?.diag || 1500;
  const m = match(refTracks, cloneTracks, diag);
  // Motion draws the eye whatever the size: a 16px spinner that doesn't spin is as visible as a 60px one.
  const weigh = (n) => Math.max(60, weight(n));
  const near = (u, v) => !u === !v && (!u || (Math.abs(u.start - v.start) <= 34 && Math.abs(u.dur - v.dur) <= 34));
  const holds = (p, c, strict) => p !== c && (strict ? p.box[2] * p.box[3] > c.box[2] * c.box[3] : true) && c.box[0] >= p.box[0] - 1 && c.box[1] >= p.box[1] - 1 && c.box[0] + c.box[2] <= p.box[0] + p.box[2] + 1 && c.box[1] + c.box[3] <= p.box[1] + p.box[3] + 1;
  const pairedA = m.pairs.map(([a]) => a), pairedB = m.pairs.map(([, b]) => b);
  // A child moving with its moving parent is the parent's motion seen twice, not a separate miss;
  // only what it does on its own (a spin, a pop) is missing.
  const own = (list) => (n) => ({ ...n, segs: n.segs.filter((g) => !list.some((p) => holds(p, n) && p.segs.some((q) => q.ch === g.ch && near(q, g)))) });
  const missing = m.missing.map(own(pairedA)).filter((n) => n.segs.length);
  const extra = m.extra.map(own(pairedB)).filter((n) => n.segs.length);

  // Every segment of every pair, scored: w is what it can earn (an extra one costs half), text what's off.
  const rows = m.pairs.map(([a, b]) => {
    const sp = pairSegments(a.segs, b.segs);
    const segs = sp.pairs.map(([x, y]) => {
      const r = segScore(x, y, tol.ms);
      const p = [];
      if (r.parts.start < 1) p.push(`starts ${y.start}ms (ref ${x.start}ms)`);
      if (r.parts.duration < 1) p.push(`lasts ${y.dur}ms (ref ${x.dur}ms)`);
      if (r.parts.distance < 1) p.push(x.open ? `speed ${y.velocity}/s (ref ${x.velocity}/s)` : `goes ${y.from} → ${y.to} (ref ${x.from} → ${x.to})`);
      if (r.parts.curve < 1) p.push(`curve: ref ${describeEase(x)}, yours ${describeEase(y)}`);
      return { ch: x.ch, x, y, w: 1, score: r.score, text: p.join(', ') };
    });
    for (const x of sp.missing) segs.push({ ch: x.ch, x, w: 1, score: 0, text: `reference goes ${x.from} → ${x.to} from ${x.start}ms over ${x.dur}ms (${describeEase(x)}); yours doesn't` });
    for (const y of sp.extra) segs.push({ ch: y.ch, y, w: 0.5, score: 0, text: `yours goes ${y.from} → ${y.to} at ${y.start}ms; the reference doesn't` });
    return { a, b, w: weigh(a), segs, followers: new Set() };
  });
  // A child's segment that follows a moving parent's on both sides (same channel, same timing) is the
  // parent's motion seen again: it counts once, on the outermost such parent, and so does its miss.
  const outer = [...rows].sort((p, q) => q.a.box[2] * q.a.box[3] - p.a.box[2] * p.a.box[3]);
  for (const c of rows) {
    const parents = outer.filter((p) => holds(p.a, c.a, true));
    c.segs = c.segs.filter((g) => {
      const p = parents.find((q) => q.segs.some((h) => h.ch === g.ch && near(h.x, g.x) && near(h.y, g.y)));
      if (p && g.text) p.followers.add(c);
      return !p;
    });
  }

  let got = 0, all = 0;
  for (const r of rows) for (const g of r.segs) (got += r.w * g.score), (all += r.w * g.w);
  for (const n of missing) all += weigh(n) * n.segs.length;
  for (const n of extra) all += 0.5 * weigh(n) * n.segs.length;
  if (!all) return { score: 100 };
  for (const r of rows) {
    // Channels with the same problem (x, y, width, height of one scale) read as one line.
    const byText = new Map();
    for (const { ch, text } of r.segs) if (text) byText.set(text, [...(byText.get(text) || []), CH_NAME[ch]]);
    if (!byText.size) continue;
    const lost = r.segs.reduce((sum, g) => sum + g.w - g.score, 0);
    const problems = [...byText].map(([text, chs]) => `${chs.join(', ')}: ${text}`);
    issues.push({ axis: 'motion', type: 'motion', gain: (100 * r.w * lost) / all, node: r.a, problems, follow: r.followers.size });
  }
  for (const n of missing) issues.push({ axis: 'motion', type: 'motion-missing', gain: (100 * weigh(n) * n.segs.length) / all, node: n });
  for (const n of extra) issues.push({ axis: 'motion', type: 'motion-extra', gain: (50 * weigh(n) * n.segs.length) / all, node: n });
  return { score: (100 * got) / all };
}

async function doctor() {
  const browser = await launch();
  console.log(`browser  ${browser.version()}`);
  await browser.close();
  try {
    console.log(`ffmpeg   ${execFileSync('ffmpeg', ['-version']).toString().split('\n')[0]}`);
  } catch {
    console.log('ffmpeg   not found (only needed for video/GIF references)');
  }
  console.log('ready');
}

const { values: f, positionals: [cmd, ...args] } = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    ['out', 'selector', 'viewports', 'action', 'motion', 'fps', 'settle', 'level', 'hide', 'wait', 'scheme', 'storage', 'dpr', 'crop', 'start', 'end'].map((k) => [k, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]]),
  ),
});

try {
  if (f.help || !cmd) console.log(HELP);
  else if (cmd === 'capture') await capture(args[0], f);
  else if (cmd === 'compare') await compare(args[0], args[1], f);
  else if (cmd === 'doctor') await doctor();
  else throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
} catch (e) {
  console.error(`replica: ${e.message}`);
  process.exitCode = 2;
}
