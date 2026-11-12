// Capture: load a page on a virtual clock, settle it, act, record motion frame by frame, then read
// the settled page. The same function captures the reference and every clone round, so both sides
// are always measured with identical settings.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tracksOf, dropPassengers } from './motion.mjs';

const INPAGE = await readFile(new URL('./inpage.js', import.meta.url), 'utf8');
const EPOCH = Date.UTC(2026, 0, 1);
const MAX_H = 8000; // ponytail: stills are cut at 8000px; capture long pages per section with --selector
const pad = (k) => String(k).padStart(4, '0');
export const vpName = (vp) => `${vp.width}x${vp.height}`;

export async function launch() {
  try {
    return await chromium.launch();
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: 'chrome' });
    } catch {
      throw new Error(`No browser available. Run once:\n  npx --prefix "${new URL('..', import.meta.url).pathname}" playwright install chromium\n\n${bundled.message}`);
    }
  }
}

async function settleNetwork(page) {
  await page.evaluate(() => document.fonts.ready.then(() => 0)).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}

// Advance virtual time in steps, moving CSS/WAAPI animations with it.
async function step(page, ms, by = 100) {
  for (let t = 0; t < ms; t += by) {
    await page.clock.runFor(Math.min(by, ms - t));
    await page.evaluate(() => window.__replica.seek());
  }
}

// Scroll through the captured area once so lazy images load and reveal-on-scroll content runs.
async function scrollThrough(page, selector) {
  const ys = await page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : null;
    const top = el ? el.getBoundingClientRect().top + scrollY - innerHeight : 0;
    const bottom = el ? el.getBoundingClientRect().bottom + scrollY : document.documentElement.scrollHeight;
    const out = [];
    for (let y = Math.max(0, top); y < bottom && out.length < 40; y += innerHeight * 0.8) out.push(Math.round(y));
    return out;
  }, selector);
  for (const y of ys) {
    await page.evaluate((v) => scrollTo({ top: v, behavior: 'instant' }), y);
    await step(page, 200);
  }
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await settleNetwork(page);
}

// A full-page screenshot resizes the page to its whole height and fires a resize event; pages
// that react (a header that compacts) move the root's content mid-shot. Shoot the viewport when
// the clip (document coordinates) fits in it; go full-page only when it doesn't.
// ponytail: a root below the fold still goes full-page; scroll it into view first if that bites.
async function shoot(page, path, clip) {
  const v = await page.evaluate(() => ({ x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }));
  const inside = clip.x >= v.x && clip.y >= v.y && clip.x + clip.width <= v.x + v.w && clip.y + clip.height <= v.y + v.h;
  await page.screenshot(inside
    ? { path, clip: { ...clip, x: clip.x - v.x, y: clip.y - v.y }, caret: 'hide' }
    : { path, clip, fullPage: true, caret: 'hide' });
}

// Actions run at t = 0 of the recording.
export function parseAction(a = 'load') {
  const m = /^(load|reveal|hover|click|focus|scroll|scrub)(?::(.+))?$/.exec(a);
  if (!m) throw new Error(`Unknown --action "${a}". Use load | reveal | hover:<css> | click:<css> | focus:<css> | scroll:<px> | scrub:<px>`);
  const [, type, arg] = m;
  if (['hover', 'click', 'focus'].includes(type) && !arg) throw new Error(`--action ${type} needs a selector, e.g. ${type}:.button`);
  if (['scroll', 'scrub'].includes(type) && !Number.isFinite(+arg)) throw new Error(`--action ${type} needs pixels, e.g. ${type}:800`);
  return { type, arg };
}

async function act(page, { type, arg }, selector) {
  if (type === 'reveal' && selector) await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), selector);
  if (type === 'hover' || type === 'click') {
    const c = await page.evaluate((s) => window.__replica.center(s), arg);
    await page.mouse.move(c.x, c.y);
    if (type === 'click') await page.mouse.click(c.x, c.y);
  }
  if (type === 'focus') await page.focus(arg);
  if (type === 'scroll') await page.evaluate((y) => scrollBy({ top: y, behavior: 'instant' }), +arg);
}

/**
 * Capture a URL into `out`: per viewport a still (shot.png + blueprint.json), and for the first
 * viewport, when o.motion > 0, a frame-by-frame recording (motion/frames + motion.json).
 */
export async function captureUrl(browser, o, out) {
  const action = parseAction(o.action);
  const result = { roots: {}, motion: null };
  for (const [i, vp] of o.viewports.entries()) {
    const dir = join(out, vpName(vp));
    await mkdir(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: 1,
      colorScheme: o.scheme || 'light',
      reducedMotion: 'no-preference',
      locale: 'en-US',
      timezoneId: 'UTC',
      ...(o.storage && { storageState: o.storage }),
    });
    try {
      const page = await context.newPage();
      await page.addInitScript(INPAGE);
      await page.clock.install({ time: EPOCH });
      await page.clock.pauseAt(EPOCH + 1000);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 }); // freeze the document timeline
      const res = await page.goto(o.url, { waitUntil: 'load', timeout: 60_000 });
      // An error page captures and compares perfectly well, which is exactly the problem: stop here.
      if (res && res.status() >= 400)
        throw new Error(`${o.url} answered HTTP ${res.status()} ${res.statusText()}. ${res.status() === 401 || res.status() === 403 ? 'It may need a login (--storage) or refuse automated browsers; if so, capture a screen recording of it instead.' : 'Check the URL.'}`);
      await settleNetwork(page);
      if (o.hide) await page.addStyleTag({ content: `${o.hide} { visibility: hidden !important; }` });
      if (o.wait) {
        for (let t = 0; !(await page.$(o.wait)); t += 100) {
          if (t > 15_000) throw new Error(`--wait "${o.wait}" never appeared`);
          await step(page, 100);
        }
      }
      const record = i === 0 && o.motion > 0;
      if (!record) await scrollThrough(page, o.selector);
      if (!record || action.type !== 'load') await step(page, o.settle);

      if (record) {
        const mark = await page.evaluate((s) => window.__replica.mark(s), o.selector);
        await act(page, action, o.selector);
        result.motion = await recordMotion(page, o, mark, action, join(out, 'motion'));
        await step(page, o.settle);
        if (action.type === 'load') {
          await scrollThrough(page, o.selector); // load lazy content for the still, as other viewports do
          await step(page, o.settle);
        }
      } else if (action.type !== 'load') {
        await act(page, action, o.selector);
        await step(page, o.settle);
      }

      const bp = await page.evaluate((s) => window.__replica.blueprint(s), o.selector);
      bp.declared = await page.evaluate(() => window.__replica.declared());
      const b = bp.root.box;
      await shoot(page, join(dir, 'shot.png'), { x: b.x, y: b.y, width: Math.max(1, b.w), height: Math.max(1, Math.min(b.h, MAX_H)) });
      await writeFile(join(dir, 'blueprint.json'), JSON.stringify(bp));
      result.roots[vpName(vp)] = b;
    } finally {
      await context.close();
    }
  }
  return result;
}

async function recordMotion(page, o, mark, action, dir) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'frames'), { recursive: true });
  const dt = 1000 / o.fps;
  const n = Math.round(o.motion / dt) + 1;
  const scrub = action.type === 'scrub' ? +action.arg : 0;
  const startY = mark.scroll[1];
  const frames = [];
  for (let k = 0; k < n; k++) {
    if (k) {
      if (scrub) await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), startY + (scrub * k) / (n - 1));
      await page.clock.runFor(Math.round(k * dt) - Math.round((k - 1) * dt));
    }
    await page.evaluate(() => window.__replica.seek());
    frames.push(await page.evaluate(() => window.__replica.sample()));
    // Section captures crop to the root as it was at t = 0; full-page captures follow the viewport.
    const clip = o.selector
      ? { x: mark.box.x, y: mark.box.y, width: mark.box.w, height: Math.min(mark.box.h, MAX_H) }
      : await page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }));
    await shoot(page, join(dir, 'frames', `${pad(k)}.png`), clip);
  }
  const tracks = tracksOf(frames);
  const info = await page.evaluate((ids) => window.__replica.describeIds(ids), Object.keys(tracks).map(Number));
  for (const d of info) Object.assign(tracks[d.id], d);
  const motion = { fps: o.fps, times: frames.map((f) => f.t), action: o.action || 'load', tracks: dropPassengers(Object.values(tracks)) };
  await writeFile(join(dir, 'motion.json'), JSON.stringify(motion));
  return motion;
}

// Stills from an image file (screenshot, design export). --dpr 2 for @2x exports.
export async function captureImage(lab, file, o, out) {
  const [w, h] = await lab.load('src', file);
  const { png, size } = await lab.toPng('src', o.dpr || 1);
  const vp = o.viewports?.[0] ?? { width: size[0], height: Math.min(size[1], 900) };
  await lab.write(join(out, vpName(vp), 'shot.png'), png);
  await lab.drop('src');
  return { viewports: [vp], roots: { [vpName(vp)]: { x: 0, y: 0, w: size[0], h: size[1] } }, source: [w, h] };
}

// Frames from a video or GIF with ffmpeg, scaled to CSS pixels.
export async function captureVideo(lab, file, o, out) {
  const dir = join(out, 'motion', 'frames');
  await rm(join(out, 'motion'), { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const vf = [`fps=${o.fps}`];
  if (o.crop) {
    const [x, y, w, h] = o.crop.split(',').map(Number);
    vf.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (o.dpr && o.dpr !== 1) vf.push(`scale=iw/${o.dpr}:ih/${o.dpr}`);
  const args = ['-v', 'error', ...(o.start ? ['-ss', String(o.start)] : []), '-i', file, ...(o.end ? ['-t', String(o.end - (o.start || 0))] : []), '-vf', vf.join(','), '-start_number', '0', join(dir, '%04d.png')];
  try {
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'Video references need ffmpeg on PATH (brew install ffmpeg / apt install ffmpeg).' : `ffmpeg failed: ${e.stderr}`);
  }
  const names = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  if (!names.length) throw new Error('ffmpeg produced no frames — check --start/--end/--crop.');
  const times = names.map((_, k) => Math.round((k * 1000) / o.fps));
  await writeFile(join(out, 'motion', 'motion.json'), JSON.stringify({ fps: o.fps, times, action: o.action || 'load', tracks: [] }));
  // The last frame doubles as the settled still.
  const [w, h] = await lab.load('last', join(dir, `${pad(names.length - 1)}.png`));
  const vp = o.viewports?.[0] ?? { width: w, height: h };
  await lab.write(join(out, vpName(vp), 'shot.png'), (await lab.toPng('last')).png);
  await lab.drop('last');
  return { viewports: [vp], roots: { [vpName(vp)]: { x: 0, y: 0, w, h } }, motion: (names.length - 1) * (1000 / o.fps) };
}
