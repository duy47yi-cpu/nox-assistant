// End-to-end check: capture a reference page, then compare three clones against it.
//   ref.html        → itself: must score 100 everywhere (captures are deterministic)
//   clone-good.html → different markup, JS instead of CSS animations, same look: must pass `faithful`
//   clone-bad.html  → five planted defects: must fail, and the report must name each one
// and a nested animation (spring card, staggered rows, popping dots, a full spin, a growing bar):
//   motion-clone-good.html → rebuilt from the report's numbers: must pass
//   motion-clone-bad.html  → generic easing, no spin, no pops: must fail on motion, with the card's spring
//                            reported once for everything inside it and the missing spin named
// and a section under a header that compacts on resize, against a clone with a placeholder:
//   resize-clone.html → pixels just under 100: the still fires no resize, the placeholder is left out,
//   but the caption chip painted over it (dark in the clone) still counts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../replica.mjs', import.meta.url));
const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'replica-test-'));
const run = (...args) => {
  try {
    return { code: 0, out: execFileSync('node', [cli, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: e.stdout + e.stderr };
  }
};
const read = async (round, file) => readFile(join(dir, round, file), 'utf8');

try {
  const ref = join(dir, 'ref');
  let r = run('capture', fixture('ref.html'), '--out', ref, '--viewports', '1440x900,390x844', '--motion', '1000');
  assert.equal(r.code, 0, r.out);
  const blueprint = await readFile(join(ref, 'blueprint.md'), 'utf8');
  assert.match(blueprint, /\| 120 \| p "Replica measures/, 'staggered start measured at 120ms');
  assert.match(blueprint, /\| 600 \| out-cubic/, 'duration and easing measured exactly');

  r = run('compare', ref, fixture('ref.html'));
  assert.equal(r.code, 0, r.out);
  const self = JSON.parse(await read('round-1', 'score.json'));
  for (const [axis, score] of Object.entries(self.axes)) assert.equal(score, 100, `self-compare ${axis}`);

  r = run('compare', ref, fixture('clone-good.html'));
  assert.equal(r.code, 0, r.out);

  r = run('compare', ref, fixture('clone-bad.html'));
  assert.equal(r.code, 1, r.out);
  const issues = JSON.parse(await read('round-3', 'issues.json')).map((i) => i.text).join('\n');
  for (const planted of [
    /missing.*"Converge"/, // third card removed
    /Likely cause: h1 .*font-size 56 \(yours 48\)/, // smaller heading pushes everything up
    /border-radius 12px \(yours 4px\)/, // card radius
    /background-color #5b4bff \(yours #4f46e5\)/, // button colour
    /lasts 300ms \(ref 600ms\).*yours linear/, // paragraph animation
  ]) assert.match(issues, planted);

  const history = (await readFile(join(dir, 'history.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(history.length, 3);

  const mref = join(dir, 'motion', 'ref');
  r = run('capture', fixture('motion-ref.html'), '--out', mref, '--viewports', '720x560', '--motion', '1600');
  assert.equal(r.code, 0, r.out);
  const mbp = await readFile(join(mref, 'blueprint.md'), 'utf8');
  assert.match(mbp, /section \.card .*spring: overshoot 16%, ≈ stiffness 2[56]\d, damping 1[56]\.\d/, 'spring read from its first peak');
  assert.match(mbp, /\| 150 \| span \.spin .*rotate 0° → 360° \| 1000 \| in-out-cubic/, 'a full turn is one segment');
  assert.match(mbp, /\| 200 \| div \.fill .*width 0 → 464px \| 950 \| in-out-quart/, 'a bar growing from 0 is measured from its first frame');
  assert.match(mbp, /\| 420 \| span \.dot .*width 0 → 12px.*\| 380 \| out-back/, 'a pop from scale(0)');
  assert.match(mbp, /text color #b4610a → #17824a/, 'color endpoints named');

  r = run('compare', mref, fixture('motion-clone-good.html'));
  assert.equal(r.code, 0, r.out);
  r = run('compare', mref, fixture('motion-clone-bad.html'));
  assert.equal(r.code, 1, r.out);
  const bad = JSON.parse(await readFile(join(dir, 'motion', 'round-2', 'score.json'), 'utf8'));
  assert.ok(bad.axes.motion < 70, `motion ${bad.axes.motion}`);
  const mi = JSON.parse(await readFile(join(dir, 'motion', 'round-2', 'issues.json'), 'utf8')).map((i) => i.text);
  assert.match(mi[0], /section \.card .*yours ease-out.*12 elements inside move with it/, 'the spring is one finding, on the card');
  assert.ok(mi.some((t) => /span \.spin .*rotate 0° → 360°.*nothing matching moves in yours/.test(t)), 'missing spin named');
  assert.equal(mi.filter((t) => /^\*\*motion\*\* · li .*stiffness 258/.test(t)).length, 0, 'rows do not repeat the card spring');

  const rref = join(dir, 'resize', 'ref');
  r = run('capture', fixture('resize-ref.html'), '--out', rref, '--selector', '.box', '--viewports', '800x600', '--motion', '0');
  assert.equal(r.code, 0, r.out);
  r = run('compare', rref, fixture('resize-clone.html'));
  assert.equal(r.code, 0, r.out);
  const rs = JSON.parse(await readFile(join(dir, 'resize', 'round-1', 'score.json'), 'utf8'));
  assert.ok(rs.axes.pixels > 85, `no resize fired for the still, placeholder left out (pixels ${rs.axes.pixels})`);
  assert.ok(rs.axes.pixels < 100, 'the chip over the placeholder still counts');
  assert.match(await readFile(join(dir, 'resize', 'round-1', 'report.md'), 'utf8'), /placeholders left out of pixels: \[40,88 320×160\]/);
  console.log('selftest ok');
} finally {
  await rm(dir, { recursive: true, force: true });
}
