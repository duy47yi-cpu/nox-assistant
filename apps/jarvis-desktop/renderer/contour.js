'use strict';

// Контурное поле главного экрана: настоящая карта высот с вершиной под шаром, второй горой и седловиной между ними.
// Высоты считаются один раз на размер окна; в кадре линии только стекают от вершины. Скорость зависит от состояния.
(() => {
  const canvas = document.getElementById('contour');
  const stage = document.getElementById('stage');
  if (!canvas || !stage) return;
  const ctx = canvas.getContext('2d');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const FRAME_MS = 100;
  const CELL = 10;
  const STEP = 0.058;
  const LEVELS = 26;
  const PACE = { thinking: 2.2, acting: 3, searching: 2.2, speaking: 1.4, waiting_approval: 0, error: 0, stopped: 0 };

  let grid = null;
  let phase = 0;
  let last = 0;

  function buildGrid(w, h, cx, cy) {
    const cols = Math.ceil(w / CELL) + 1;
    const rows = Math.ceil(h / CELL) + 1;
    const unit = Math.min(w, h);
    const px = cx / unit;
    const py = cy / unit;
    const hill = (x, y, hx, hy, sx, sy, top) => top * Math.exp(-(((x - hx) / sx) ** 2 + ((y - hy) / sy) ** 2) / 2);
    const data = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const x = (i * CELL) / unit;
        const y = (j * CELL) / unit;
        data[j * cols + i] = hill(x, y, px, py, 0.34, 0.3, 1.1)
          + hill(x, y, px - 0.62, py + 0.5, 0.2, 0.17, 0.62)
          + hill(x, y, px + 0.58, py - 0.46, 0.17, 0.22, 0.48)
          + 0.035 * Math.sin(x * 7.3 + 1.2) * Math.cos(y * 6.1 - 0.7)
          + 0.016 * Math.sin(x * 15.1 - y * 11.3);
      }
    }
    return { cols, rows, data, w, h, cx, cy };
  }

  // Marching squares: отрезки линии уровня в каждой клетке сетки.
  function traceLevel(path, g, level, dpr) {
    const { cols, rows, data } = g;
    const s = CELL * dpr;
    const t = (a, b) => (level - a) / (b - a);
    for (let j = 0; j < rows - 1; j += 1) {
      for (let i = 0; i < cols - 1; i += 1) {
        const a = data[j * cols + i];
        const b = data[j * cols + i + 1];
        const c = data[(j + 1) * cols + i + 1];
        const d = data[(j + 1) * cols + i];
        const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const x = i * s;
        const y = j * s;
        const top = () => [x + t(a, b) * s, y];
        const right = () => [x + s, y + t(b, c) * s];
        const bottom = () => [x + t(d, c) * s, y + s];
        const left = () => [x, y + t(a, d) * s];
        const seg = (p, q) => { path.moveTo(p[0], p[1]); path.lineTo(q[0], q[1]); };
        switch (code) {
          case 1: case 14: seg(left(), bottom()); break;
          case 2: case 13: seg(bottom(), right()); break;
          case 3: case 12: seg(left(), right()); break;
          case 4: case 11: seg(top(), right()); break;
          case 6: case 9: seg(top(), bottom()); break;
          case 7: case 8: seg(left(), top()); break;
          default: seg(left(), top()); seg(bottom(), right());
        }
      }
    }
  }

  function draw() {
    if (canvas.offsetParent === null) return;
    const core = stage.querySelector('.orbit-core');
    const box = canvas.getBoundingClientRect();
    if (!core || !box.width) return;
    const c = core.getBoundingClientRect();
    const cx = c.left + c.width / 2 - box.left;
    const cy = c.top + c.height / 2 - box.top;
    if (!grid || grid.w !== box.width || grid.h !== box.height || Math.abs(grid.cx - cx) > 1 || Math.abs(grid.cy - cy) > 1) {
      grid = buildGrid(box.width, box.height, cx, cy);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const css = getComputedStyle(stage);
    const minor = new Path2D();
    const major = new Path2D();
    const flow = phase % 1;
    const shift = Math.floor(phase);
    for (let k = 0; k < LEVELS; k += 1) {
      // «Каждая пятая» едет вместе с линией, поэтому при стекании линия не меняет толщину.
      const level = 0.07 + (k + 1 - flow) * STEP;
      traceLevel((k + shift) % 5 === 0 ? major : minor, grid, level, dpr);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    // Шар — вершина: внутри него линий нет. Радиус публикует сам шар, у каждого вида свой.
    const orbCanvas = core.querySelector('canvas');
    const radius = (orbCanvas && parseFloat(orbCanvas.dataset.hole)) || c.width * 0.46;
    const hole = new Path2D();
    hole.rect(0, 0, w, h);
    hole.arc(cx * dpr, cy * dpr, (radius + 6) * dpr, 0, Math.PI * 2);
    ctx.clip(hole, 'evenodd');
    ctx.lineCap = 'round';
    ctx.strokeStyle = css.getPropertyValue('--contour').trim();
    ctx.lineWidth = 0.8 * dpr;
    ctx.stroke(minor);
    ctx.strokeStyle = css.getPropertyValue('--contour-index').trim();
    ctx.lineWidth = 1.3 * dpr;
    ctx.stroke(major);
    ctx.restore();
  }

  function moving() {
    return !still.matches && !document.hidden && document.documentElement.dataset.motion !== 'off';
  }

  function tick(now) {
    requestAnimationFrame(tick);
    if (!moving() || now - last < FRAME_MS) return;
    const pace = PACE[stage.dataset.state] ?? 0.45;
    phase += (Math.min(now - last, 500) / 1000) * pace * 0.25;
    last = now;
    draw();
  }

  new ResizeObserver(() => { grid = null; draw(); }).observe(canvas);
  still.addEventListener('change', draw);
  new MutationObserver(draw).observe(stage, { attributes: true, attributeFilter: ['data-state', 'data-orb'] });
  new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('click', () => requestAnimationFrame(draw));
  draw();
  requestAnimationFrame(tick);
})();
