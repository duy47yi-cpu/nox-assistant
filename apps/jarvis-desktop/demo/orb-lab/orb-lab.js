/* Автономная лаборатория сфер Nox. Не импортирует и не изменяет сферы приложения.
 * Canvas 2D, реальная 3D-геометрия, глубина, затемнение задней поверхности.
 * Публичный мини-API: setVariant, setState, setVoice, setTune, setAnimated, resize, destroy.
 */
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const COLORS = {
    idle: [164, 217, 203], listening: [181, 231, 223], thinking: [156, 212, 232],
    speaking: [172, 221, 211], success: [159, 224, 178], error: [229, 150, 140],
  };
  const TARGETS = {
    idle: { period: 5.4, amplitude: .62, rotation: .10, light: 1 },
    listening: { period: 2.6, amplitude: .85, rotation: .08, light: 1.12 },
    thinking: { period: 2.8, amplitude: .9, rotation: .22, light: 1.08 },
    speaking: { period: 3.2, amplitude: .78, rotation: .12, light: 1.14 },
    success: { period: 5.8, amplitude: .42, rotation: .06, light: 1.17 },
    error: { period: 7, amplitude: .2, rotation: 0, light: .94 },
  };
  const VARIANTS = ['flux', 'membrane', 'resonance'];
  const rgb = (c, a) => 'rgba(' + c.map(Math.round).join(',') + ',' + a.toFixed(3) + ')';

  function curve(points, count, sampler) {
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const p = sampler(i / (count - 1), i);
      out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2];
    }
    return out;
  }

  function lineField(variant) {
    const lines = [];
    if (variant === 'flux') {
      for (let j = 0; j < 38; j++) {
        const phi = j / 38 * TAU;
        const shell = .76 + .18 * (0.5 + 0.5 * Math.sin(j * 2.39996));
        const twist = .48 + .17 * Math.sin(j * 1.8);
        lines.push(curve(null, 100, (u) => {
          const theta = .12 + u * (Math.PI - .24);
          const r = shell + .22 * Math.sin(theta) ** 2;
          const a = phi + twist * Math.cos(theta) + .1 * Math.sin(theta * 3 + j);
          return [r * Math.sin(theta) * Math.cos(a), r * Math.cos(theta) * .87, r * Math.sin(theta) * Math.sin(a)];
        }));
      }
    } else if (variant === 'membrane') {
      const meridians = 34, parallels = 18;
      for (let j = 0; j < meridians; j++) {
        const phi = j / meridians * TAU;
        lines.push(curve(null, 74, (u) => {
          const t = .022 + u * (Math.PI - .044);
          return [Math.sin(t) * Math.cos(phi), Math.cos(t), Math.sin(t) * Math.sin(phi)];
        }));
      }
      for (let j = 1; j <= parallels; j++) {
        const t = j / (parallels + 1) * Math.PI;
        lines.push(curve(null, 108, (u) => {
          const p = u * TAU;
          return [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
        }));
      }
    } else {
      for (let j = 0; j < 18; j++) {
        const phase = j / 18 * TAU;
        const band = .48 + .43 * (j / 17);
        lines.push(curve(null, 220, (u) => {
          const a = u * TAU;
          const lat = band * Math.sin(a * 3 + phase) * (.7 + .3 * Math.sin(a + phase));
          const lon = a + .58 * Math.sin(a * 2 + phase);
          const r = .97 + .025 * Math.sin(a * 5 + phase);
          return [r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.sin(lon)];
        }));
      }
    }
    return lines;
  }

  class OrbLab {
    constructor(canvas, options = {}) {
      if (!canvas) throw new Error('Canvas is required');
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.surface = document.createElement('canvas');
      this.pen = this.surface.getContext('2d');
      this.bloom = document.createElement('canvas');
      this.bloomPen = this.bloom.getContext('2d');
      this.variant = VARIANTS.includes(options.variant) ? options.variant : 'flux';
      this.state = COLORS[options.state] ? options.state : 'idle';
      this.animated = options.animated !== false;
      this.tune = { motion: .7, light: 1 };
      this.voiceTarget = 0; this.voice = 0;
      this.color = COLORS[this.state].slice();
      this.mix = { ...TARGETS[this.state] };
      this.lines = lineField(this.variant);
      this.angle = -.24; this.clock = 0; this.time = 0; this.phase = 0;
      this.last = 0; this.raf = 0; this.visible = true; this.destroyed = false;
      this.width = 0; this.height = 0; this.dpr = 1;
      this.stats = { frames: 0, intervals: [], costs: [], fps: 0, p95: 0 };
      this.frame = this.frame.bind(this);
      this.onVisibility = () => this.sync();
      this.onReduced = () => this.sync();
      this.io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
        this.visible = entries.some((entry) => entry.isIntersecting); this.sync();
      }) : null;
      if (this.io) this.io.observe(canvas);
      document.addEventListener('visibilitychange', this.onVisibility);
      if (motionQuery.addEventListener) motionQuery.addEventListener('change', this.onReduced);
      this.resize(); this.sync();
    }
    get reduced() { return !this.animated || motionQuery.matches || this.tune.motion === 0; }
    setVariant(id) {
      if (!VARIANTS.includes(id) || id === this.variant) return;
      this.variant = id; this.lines = lineField(id);
      if (this.reduced) this.draw();
    }
    setState(id) {
      if (!COLORS[id]) return;
      this.state = id;
      if (this.reduced) this.draw();
    }
    setVoice(value) { this.voiceTarget = clamp(Number(value) || 0); }
    setTune(next = {}) {
      if (Number.isFinite(next.motion)) this.tune.motion = clamp(next.motion, 0, 1.3);
      if (Number.isFinite(next.light)) this.tune.light = clamp(next.light, .4, 1.4);
      this.sync();
    }
    setAnimated(value) { this.animated = Boolean(value); this.sync(); }
    sync() {
      cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0;
      if (!this.destroyed && this.visible && !document.hidden && !this.reduced) this.raf = requestAnimationFrame(this.frame);
      this.draw();
    }
    resize() {
      const box = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, Math.round(box.width)); this.height = Math.max(1, Math.round(box.height));
      this.dpr = Math.min(devicePixelRatio || 1, 2);
      for (const c of [this.canvas, this.surface]) {
        c.width = Math.round(this.width * this.dpr); c.height = Math.round(this.height * this.dpr);
      }
      this.bloom.width = Math.max(1, Math.round(this.width / 4)); this.bloom.height = Math.max(1, Math.round(this.height / 4));
      this.draw();
    }
    frame(now) {
      this.raf = 0;
      if (this.destroyed || this.reduced || document.hidden || !this.visible) return;
      const start = performance.now();
      const dt = this.last ? Math.min((now - this.last) / 1000, .05) : 1 / 60;
      this.last = now; this.clock += dt;
      this.stats.intervals.push(dt * 1000); if (this.stats.intervals.length > 180) this.stats.intervals.shift();
      this.draw();
      const cost = performance.now() - start;
      this.stats.costs.push(cost); if (this.stats.costs.length > 180) this.stats.costs.shift();
      this.stats.frames++;
      if (this.stats.frames % 30 === 0) {
        const values = this.stats.costs.slice().sort((a, b) => a - b);
        this.stats.p95 = values[Math.floor(values.length * .95)] || 0;
        this.stats.fps = Math.round(this.stats.intervals.length * 1000 / this.stats.intervals.reduce((a, b) => a + b, 0));
      }
      this.raf = requestAnimationFrame(this.frame);
    }
    update(dt) {
      const target = TARGETS[this.state];
      const k = 1 - Math.exp(-dt / .20);
      Object.keys(target).forEach((key) => { this.mix[key] = mix(this.mix[key], target[key], k); });
      for (let i = 0; i < 3; i++) this.color[i] = mix(this.color[i], COLORS[this.state][i], k);
      this.voice = mix(this.voice, this.voiceTarget, 1 - Math.exp(-dt / (this.voiceTarget > this.voice ? .06 : .18)));
      if (dt) {
        this.time += dt;
        this.phase += dt * TAU / this.mix.period;
        this.angle += dt * this.mix.rotation * (this.reduced ? 0 : 1);
      }
    }
    draw() {
      if (this.destroyed || !this.width) return;
      const started = performance.now();
      this.update(this.reduced ? 0 : (this.lastDraw ? Math.min((started - this.lastDraw) / 1000, .05) : 1 / 60));
      this.lastDraw = started;
      const ctx = this.pen;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      const cx = this.width / 2, cy = this.height / 2;
      const R = Math.min(this.width, this.height) * .365;
      const c = this.color;
      const motion = this.tune.motion * this.mix.amplitude;
      const speech = this.state === 'speaking' || this.state === 'listening';
      const v = speech ? this.voice : 0;
      const breath = this.reduced ? 0 : Math.sin(this.phase) * .017 * motion;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.55);
      glow.addColorStop(0, rgb(c, .047 * this.tune.light));
      glow.addColorStop(.58, rgb(c, .022 * this.tune.light));
      glow.addColorStop(1, rgb(c, 0));
      ctx.fillStyle = glow; ctx.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);
      const paths = Array.from({ length: 24 }, () => ({ back: new Path2D(), front: new Path2D() }));
      const ca = Math.cos(this.angle), sa = Math.sin(this.angle), tilt = .22;
      const cb = Math.cos(tilt), sb = Math.sin(tilt);
      for (let l = 0; l < this.lines.length; l++) {
        const line = this.lines[l];
        for (let i = 0; i < line.length; i += 3) {
          let x = line[i], y = line[i + 1], z = line[i + 2];
          const n1 = this.reduced ? 0 : Math.sin(y * 3.4 + z * 2.2 + this.phase + this.time * .21);
          const n2 = this.reduced ? 0 : Math.cos(x * 3.1 - y * 2.5 - this.phase * .73);
          if (this.variant === 'membrane') {
            const amp = .064 * motion + v * .035;
            const local = 1 + n1 * amp * .6 + n2 * amp * .45;
            x *= local + breath; y *= local + breath - v * .024; z *= local + breath;
            x += n2 * .018 * motion;
          } else {
            const a = this.reduced ? 0 : Math.sin(this.phase * .42 + y * 2 + x) * .025 * motion;
            const cs = Math.cos(a), sn = Math.sin(a);
            const xx = x * cs - z * sn; z = x * sn + z * cs; x = xx;
            const swell = 1 + breath + v * .04 * Math.sin(y * 4 + this.phase * 2);
            x *= swell; y *= swell; z *= swell;
          }
          if (this.state === 'error') x += .013;
          const xx = x * ca - z * sa, zz = x * sa + z * ca;
          const yy = y * cb - zz * sb; z = y * sb + zz * cb; x = xx; y = yy;
          const perspective = 4.6 / (4.6 - z);
          const px = cx + x * R * perspective, py = cy + y * R * perspective;
          let intensity = .27 + .67 * clamp((z + 1) / 2);
          const key = clamp(.3 + y * -.35 + x * -.27 + z * .43);
          intensity *= .6 + .64 * key;
          if (this.variant === 'flux') {
            const hot = this.reduced ? .35 : .5 + .5 * Math.sin(this.time * 2.1 + y * 4 + l * .18);
            if (this.state === 'thinking') intensity *= .7 + hot * .68;
            intensity *= 1.03 + .14 * Math.sin(l * 1.7);
          }
          if (this.variant === 'resonance') {
            const travel = .5 + .5 * Math.sin(i * .038 - this.time * (this.state === 'thinking' ? 3.2 : 1.6) + l * .22);
            intensity *= .30 + travel * .58;
          }
          if (this.state === 'success') intensity *= 1 + .15 * Math.exp(-((this.time % 4) / 1.2));
          const bucket = Math.max(0, Math.min(23, Math.floor(intensity * 15)));
          const path = z < -.03 ? paths[bucket].back : paths[bucket].front;
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
        }
      }
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (let i = 0; i < paths.length; i++) {
        ctx.strokeStyle = rgb(c, (.05 + i / 23 * .34) * this.tune.light * this.mix.light);
        ctx.lineWidth = .45 + i / 23 * .25;
        ctx.stroke(paths[i].back);
      }
      const bodyR = this.variant === 'flux' ? R * .48 : this.variant === 'resonance' ? R * .78 : R * .87;
      const body = ctx.createRadialGradient(cx - bodyR * .32, cy - bodyR * .4, 0, cx, cy, bodyR);
      body.addColorStop(0, rgb(c, this.variant === 'flux' ? .12 * this.tune.light : .045));
      body.addColorStop(.55, rgb(c, this.variant === 'flux' ? .052 : .026));
      body.addColorStop(.85, rgb(c, .018));
      body.addColorStop(1, rgb(c, 0));
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.arc(cx, cy, bodyR, 0, TAU); ctx.fill();
      if (this.variant === 'flux') {
        const coreR = R * (.052 + (this.state === 'success' ? .015 : 0));
        const core = ctx.createRadialGradient(cx - coreR * .25, cy - coreR * .35, 0, cx, cy, coreR * 3.5);
        core.addColorStop(0, rgb([228, 245, 224], .97));
        core.addColorStop(.16, rgb(c, .75));
        core.addColorStop(.34, rgb(c, .16));
        core.addColorStop(1, rgb(c, 0));
        ctx.fillStyle = core; ctx.fillRect(cx - coreR * 3.5, cy - coreR * 3.5, coreR * 7, coreR * 7);
      }
      for (let i = 0; i < paths.length; i++) {
        ctx.strokeStyle = rgb(c, (.028 + i / 23 * .7) * this.tune.light * this.mix.light);
        ctx.lineWidth = .52 + i / 23 * .42;
        ctx.stroke(paths[i].front);
      }
      if (this.variant === 'membrane') {
        ctx.beginPath();
        for (let j = 0; j < 140; j++) {
          const a = j / 140 * TAU;
          const r = R * (1 + motion * .05 * Math.sin(a * 3 + this.phase));
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.strokeStyle = rgb(c, .20 * this.tune.light); ctx.lineWidth = .6; ctx.stroke();
      }
      this.bloomPen.clearRect(0, 0, this.bloom.width, this.bloom.height);
      this.bloomPen.filter = 'blur(3px)';
      this.bloomPen.drawImage(this.surface, 0, 0, this.bloom.width, this.bloom.height);
      this.bloomPen.filter = 'none';
      this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.globalAlpha = .12; this.ctx.drawImage(this.bloom, 0, 0, this.canvas.width, this.canvas.height);
      this.ctx.globalAlpha = 1; this.ctx.drawImage(this.surface, 0, 0);
    }
    snapshot() {
      return { variant: this.variant, state: this.state, color: this.color.slice(), animated: !this.reduced,
        canvas: { width: this.width, height: this.height, dpr: this.dpr }, lines: this.lines.length,
        vertices: this.lines.reduce((n, line) => n + line.length / 3, 0), ...this.stats };
    }
    destroy() {
      this.destroyed = true; cancelAnimationFrame(this.raf);
      document.removeEventListener('visibilitychange', this.onVisibility);
      if (motionQuery.removeEventListener) motionQuery.removeEventListener('change', this.onReduced);
      if (this.io) this.io.disconnect();
    }
  }
  window.NoxOrbLab = OrbLab;
})();