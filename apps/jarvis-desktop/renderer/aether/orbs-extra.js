/* Авторские сферы Nox Aether: Поток, Мембрана, Резонанс, Кристалл, Плазма, Соты.
 *
 * Шесть самостоятельных сфер на canvas 2D с общей машиной состояний. Подключаются
 * к «Библиотеке сфер» Nox Aether через registerOrb() как пользовательские движки
 * (engine: 'custom'), поэтому не меняют nox:nox и nox:wire; по умолчанию остаётся wire.
 *
 * Что внутри:
 *   - один цикл requestAnimationFrame, все состояния STATE_TO_NOX (idle, listening,
 *     thinking, speaking, waiting_approval, success, error) и голосовой уровень setVoice(0..1);
 *   - DPR (backing store до x2), пауза в скрытом окне и вне экрана, «уменьшение движения»
 *     (setAnimated, html[data-motion|data-animations="off"], prefers-reduced-motion) — статичный кадр;
 *   - у каждой сферы свои параметры (масштаб, скорость, свечение, плотность, движение, голос),
 *     три пресета и сброс — силами orb-library (поля range/switch и presets);
 *   - подписи на русском, без названий моделей и поставщиков;
 *   - бюджет кадра: геометрия строится один раз, кадр — только проекция и штрихи.
 *
 * Публично: window.NoxOrbsExtra = { VARIANTS, STATES, SPECS, createOrb, registerExtraOrbs }.
 * В Node тот же объект уходит в module.exports (реестр и бюджет кадра в tests/orbs-extra.test.js).
 */
(function (root) {
  'use strict';

  const TAU = Math.PI * 2;
  const TILT = 0.24;
  const COS_TILT = Math.cos(TILT);
  const SIN_TILT = Math.sin(TILT);
  const PERSPECTIVE = 4.4;
  const RADIUS_RATIO = 0.45;
  const BLOCK_BUCKETS = 7;
  const SEG_BUCKETS = 5;

  const VARIANTS = ['flux', 'membrane', 'resonance', 'crystal', 'plasma', 'comb'];

  // Все состояния, которые приходят после mapState('nox', …), плюс синонимы ядра.
  const STATES = ['idle', 'listening', 'thinking', 'speaking', 'waiting_approval', 'success', 'error'];
  const ALIAS = {
    attentive: 'listening',
    searching: 'thinking',
    acting: 'thinking',
    verifying: 'thinking',
    working: 'thinking',
    planning: 'thinking',
    warning: 'waiting_approval',
    succeeded: 'success',
    cancelled: 'idle',
    partial: 'idle',
    failed: 'error',
    stopped: 'idle',
  };

  // Параметры состояния: скорость формы, амплитуда деформации, яркость, вращение, ореол, ядро.
  const MOTION = {
    idle: { speed: 1.25, amp: 0.65, bright: 0.96, spin: 0.34, halo: 0.18, core: 0.94 },
    listening: { speed: 1.4, amp: 0.88, bright: 1.14, spin: 0.18, halo: 0.23, core: 1.05 },
    thinking: { speed: 1.75, amp: 1.05, bright: 1.3, spin: 0.48, halo: 0.27, core: 1.18 },
    speaking: { speed: 1.32, amp: 0.84, bright: 1.18, spin: 0.22, halo: 0.23, core: 1.12 },
    waiting_approval: { speed: 0.55, amp: 0.34, bright: 0.84, spin: 0.08, halo: 0.14, core: 0.76 },
    success: { speed: 1.15, amp: 0.72, bright: 1.36, spin: 0.28, halo: 0.3, core: 1.24 },
    error: { speed: 1.35, amp: 0.42, bright: 1.04, spin: 0.06, halo: 0.17, core: 0.82 },
  };
  const MIX_KEYS = ['speed', 'amp', 'bright', 'spin', 'halo', 'core'];

  const DEFAULTS = { scale: 1, speed: 1, light: 1, detail: 1, animated: true, voice: true };
  const FALLBACK_COLORS = {
    accent: [78, 206, 235],
    warn: [255, 194, 77],
    err: [255, 127, 120],
    ok: [110, 239, 168],
  };

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const mix = (a, b, t) => a + (b - a) * t;
  const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
  const lighten = (c, t) => mixRgb(c, [255, 255, 255], t);
  const darken = (c, t) => mixRgb(c, [8, 10, 12], t);
  const luminanceOf = (rgb) => {
    const channel = (value) => {
      const c = clamp(value, 0, 255) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };

  function parseColor(text, fallback) {
    const value = String(text || '').trim();
    if (!value) return fallback.slice();
    const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
    if (hex) {
      const raw = hex[1];
      if (raw.length === 3 || raw.length === 4) {
        return [parseInt(raw[0] + raw[0], 16), parseInt(raw[1] + raw[1], 16), parseInt(raw[2] + raw[2], 16)];
      }
      if (raw.length === 6 || raw.length === 8) {
        return [parseInt(raw.slice(0, 2), 16), parseInt(raw.slice(2, 4), 16), parseInt(raw.slice(4, 6), 16)];
      }
      return fallback.slice();
    }
    const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((v) => (Number.isFinite(v) ? clamp(v, 0, 255) : 0));
    return fallback.slice();
  }

  // Детерминированный ГПСЧ: картинка не «кипит» между запусками.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const norm3 = (x, y, z) => {
    const d = Math.hypot(x, y, z) || 1;
    return [x / d, y / d, z / d];
  };

  // Геодезический многогранник: 12 вершин при level 0, 42 при 1, 92 при 2, 162 при 3.
  function geodesic(level) {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];
    let verts = raw.map((v) => norm3(v[0], v[1], v[2]));
    let faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for (let step = 0; step < level; step++) {
      const cache = new Map();
      const next = [];
      const midpoint = (a, b) => {
        const key = a < b ? a + '_' + b : b + '_' + a;
        let index = cache.get(key);
        if (index === undefined) {
          index = verts.length;
          const va = verts[a];
          const vb = verts[b];
          verts.push(norm3((va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2));
          cache.set(key, index);
        }
        return index;
      };
      for (const [a, b, c] of faces) {
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      }
      faces = next;
    }
    return { verts, faces };
  }

  function makeFloat(values) {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) out[i] = values[i];
    return out;
  }

  class ExtraOrb {
    constructor(canvas, opts = {}) {
      if (!canvas || typeof canvas.getContext !== 'function') throw new Error('Авторская сфера: нужен <canvas>');
      const o = opts || {};
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('Авторская сфера: canvas 2D недоступен');

      this.variant = VARIANTS.includes(o.variant) ? o.variant : 'flux';
      this.state = this._normalizeState(o.state);
      this.cfg = { ...DEFAULTS };
      this._applyConfig(o, true);
      this.animated = o.animated !== false; // общий выключатель движения сцены
      // Выключатель движения самой сферы приходит отдельно: mount() передаёт и общий флаг, и выбор владельца.
      this.userAnimated = typeof o.userAnimated === 'boolean' ? o.userAnimated : this.cfg.animated !== false;
      this.cfg.animated = this.userAnimated;

      const win = typeof window !== 'undefined' ? window : null;
      this.dprOpt = Number.isFinite(Number(o.dpr)) && Number(o.dpr) > 0
        ? clamp(Number(o.dpr), 0.5, 3)
        : Math.min((win && win.devicePixelRatio) || 1, 2);

      this.w = 0;
      this.h = 0;
      this.dpr = this.dprOpt;
      this.rt = 0;
      this.phase = 1.1;
      this.angle = -0.35;
      this.breath = 0;
      this.voiceTarget = 0;
      this.voice = 0;
      this.voiceAt = -10;
      this.impulse = 0;
      this.flash = 0;
      this.shake = 0;
      this.mix = { ...MOTION[this.state] };
      this.col = [0, 0, 0];
      this._pal = {};
      this._readColors();
      this.col = this._pal[this.state].slice();
      // Замороженные часы: в статичном режиме время стоит, и повторный кадр совпадает побитно.
      this._staticPhase = this.phase;
      this._staticAngle = this.angle;
      if (this._still()) this._snap();

      this.status = { frames: 0, frameMs: 0, fps: 0 };
      this._n = 0;
      this._statAt = 0;
      this._raf = 0;
      this._last = 0;
      this._visible = true;
      this._lastDrawCost = 0;

      this._buildGeometry();
      this._bind();
      this._resize();
      this._sync();
      this._draw();
    }

    // ── Публичный API ─────────────────────────────────────────────────

    getVariant() {
      return this.variant;
    }

    setState(state) {
      const next = this._normalizeState(state);
      if (next === this.state) {
        if (this._still()) this._draw();
        return;
      }
      this.state = next;
      if (next === 'error') this.shake = 1;
      if (next === 'success') this.flash = 1;
      if (this._still()) this._snap();
      this._sync();
      this._draw();
    }

    setVoice(level) {
      const v = Number(level);
      this.voiceTarget = Number.isFinite(v) ? clamp(v, 0, 1) : 0;
      this.voiceAt = this.rt;
    }

    setAnimated(on) {
      this.animated = Boolean(on);
      if (this._still()) this._snap();
      this._sync();
      this._draw();
    }

    setScale(scale) {
      const v = Number(scale);
      this.cfg.scale = Number.isFinite(v) ? clamp(v, 0.5, 1.8) : 1;
      this._sync();
      this._draw();
    }

    // Импульс нажатия: у каждой сферы свой отклик (кольцо, искры, вспышка ячеек).
    pulse(strength = 1) {
      const s = clamp(Number(strength) || 0);
      if (s <= 0) return;
      this.impulse = Math.max(this.impulse, s);
      this._sync();
    }

    resize() {
      this._resize();
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      const doc = typeof document !== 'undefined' ? document : null;
      const win = typeof window !== 'undefined' ? window : null;
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', this._onVisibility);
      if (doc && doc.removeEventListener) doc.removeEventListener('jarvis:themechange', this._onTheme);
      if (win && win.removeEventListener) win.removeEventListener('resize', this._onWinResize);
      if (this._reduceQuery && this._reduceQuery.removeEventListener) this._reduceQuery.removeEventListener('change', this._onReduce);
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this._mo) this._mo.disconnect();
      this._ro = null;
      this._io = null;
      this._mo = null;
      if (this.ctx) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    getStats() {
      return {
        variant: this.variant,
        state: this.state,
        dpr: this.dpr,
        css: { width: this.w, height: this.h },
        frames: this.status.frames,
        frameMs: this.status.frameMs,
        fps: this.status.fps,
        drawMs: this._lastDrawCost,
        voice: this._voiceOut(),
        animated: !this._still(),
      };
    }

    // Снимок для тестов и отладки: без DOM-узлов и ссылок на движки.
    snapshot() {
      const geo = this._geo || {};
      return {
        variant: this.variant,
        state: this.state,
        settings: { ...this.cfg },
        voice: this.voice,
        voiceOut: this._voiceOut(),
        animated: !this._still(),
        dpr: this.dpr,
        css: { width: this.w, height: this.h },
        geometry: {
          kind: geo.kind || '',
          points: geo.n || 0,
          lines: geo.lines ? geo.lines.length : 0,
          blocks: geo.blocks ? geo.blocks.length : 0,
          faces: geo.faceCount || 0,
          cells: geo.cellCount || 0,
        },
        color: this.col.slice().map(Math.round),
        mix: { ...this.mix },
      };
    }

    // ── Цвета, состояние движения, часы ───────────────────────────────

    _normalizeState(state) {
      const raw = String(state || '');
      if (STATES.includes(raw)) return raw;
      return ALIAS[raw] || 'idle';
    }

    _readColors() {
      const fallback = FALLBACK_COLORS;
      let css = null;
      try {
        const doc = typeof document !== 'undefined' ? document : null;
        if (doc) {
          const host = this.canvas && this.canvas.closest ? this.canvas.closest('[data-theme]') : null;
          css = getComputedStyle(host || doc.documentElement);
        }
      } catch {
        css = null;
      }
      const read = (name, fb) => parseColor(css ? css.getPropertyValue(name) : '', fb);
      const readText = (name) => (css ? String(css.getPropertyValue(name) || '').trim() : '');
      const accent = read('--hue', fallback.accent);
      const warn = read('--warn', fallback.warn);
      const err = read('--err', fallback.err);
      const ok = read('--ok', fallback.ok);
      // Светлая тема: фон панели светлый. На нём сферу рисуем плотнее и тёмным ядром,
      // иначе акцент, осветлённый для тёмной темы, становится бледным.
      const bgColor = parseColor(readText('--bg') || readText('--surface') || readText('--g1'), [12, 14, 18]);
      this._light = luminanceOf(bgColor) > 0.55;
      this._pal = {
        idle: accent,
        listening: this._light ? darken(accent, 0.08) : lighten(accent, 0.2),
        thinking: this._light
          ? mixRgb(accent, [8, 14, 28], 0.18)
          : mixRgb(lighten(accent, 0.28), [170, 214, 255], 0.25),
        speaking: this._light ? darken(accent, 0.05) : lighten(accent, 0.14),
        waiting_approval: warn,
        success: ok,
        error: err,
      };
      this._shade = darken(accent, 0.55);
    }

    // fromMount: при создании в opts.animated лежит общий флаг сцены, а не выбор владельца.
    _applyConfig(source, fromMount = false) {
      const s = source || {};
      const num = (key, lo, hi) => {
        const v = Number(s[key]);
        if (Number.isFinite(v)) this.cfg[key] = clamp(v, lo, hi);
      };
      num('scale', 0.5, 1.8);
      num('speed', 0.3, 2);
      num('light', 0.4, 1.6);
      num('detail', 0.5, 1.6);
      if (!fromMount && typeof s.animated === 'boolean') this.cfg.animated = s.animated;
      if (typeof s.voice === 'boolean') this.cfg.voice = s.voice;
    }

    updateSettings(next) {
      const before = { ...this.cfg };
      this._applyConfig({ ...this.cfg, ...(next || {}) });
      this.userAnimated = this.cfg.animated !== false;
      if (before.detail !== this.cfg.detail) this._buildGeometry();
      if (this._still()) this._snap();
      this._sync();
      this._draw();
    }

    _still() {
      if (!this.animated || !this.userAnimated) return true;
      const doc = typeof document !== 'undefined' ? document : null;
      if (doc && doc.documentElement && doc.documentElement.dataset) {
        const data = doc.documentElement.dataset;
        if (data.motion === 'off' || data.animations === 'off') return true;
      }
      if (!ExtraOrb.ignoreSystemMotion && this._reduceQuery && this._reduceQuery.matches) return true;
      return false;
    }

    _voiceOut() {
      if (this.cfg.voice === false) return 0;
      return this.voice;
    }

    _bind() {
      const doc = typeof document !== 'undefined' ? document : null;
      const win = typeof window !== 'undefined' ? window : null;
      this._onVisibility = () => this._sync();
      this._onWinResize = () => this._resize();
      this._onReduce = () => {
        if (this._still()) this._snap();
        this._sync();
      };
      this._onTheme = () => {
        this._readColors();
        this._draw();
      };
      this._onFrame = (now) => this._frame(now);
      if (doc && doc.addEventListener) {
        doc.addEventListener('visibilitychange', this._onVisibility);
        doc.addEventListener('jarvis:themechange', this._onTheme);
      }
      if (win && win.addEventListener) win.addEventListener('resize', this._onWinResize);
      this._reduceQuery = win && typeof win.matchMedia === 'function'
        ? win.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
      if (this._reduceQuery && this._reduceQuery.addEventListener) this._reduceQuery.addEventListener('change', this._onReduce);
      this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
      if (this._ro) this._ro.observe(this.canvas);
      this._io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          this._visible = entries.some((e) => e.isIntersecting);
          this._sync();
        })
        : null;
      if (this._io) this._io.observe(this.canvas);
      if (typeof MutationObserver === 'function' && doc && doc.documentElement) {
        this._mo = new MutationObserver(() => {
          if (this._still()) this._snap();
          this._sync();
        });
        this._mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-motion', 'data-animations'] });
      }
    }

    _sync() {
      const doc = typeof document !== 'undefined' ? document : null;
      const run = !this._still() && !(doc && doc.hidden) && this._visible && this.w > 1 && this.h > 1;
      if (run && !this._raf) {
        this._last = performance.now();
        this._statAt = this._last;
        this._n = 0;
        this._raf = requestAnimationFrame(this._onFrame);
      } else if (!run && this._raf) {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        this.status.fps = 0;
        this._draw();
      }
    }

    _resize() {
      const rect = this.canvas.getBoundingClientRect ? this.canvas.getBoundingClientRect() : null;
      const cw = Math.round((this.canvas.clientWidth || (rect && rect.width) || 0));
      const ch = Math.round((this.canvas.clientHeight || (rect && rect.height) || 0));
      const dpr = this.dprOpt;
      if (cw < 2 || ch < 2) {
        this.w = 0;
        this.h = 0;
        this._sync();
        return;
      }
      if (cw === this.w && ch === this.h && dpr === this.dpr) {
        this._draw();
        return;
      }
      this.w = cw;
      this.h = ch;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(cw * dpr));
      this.canvas.height = Math.max(1, Math.round(ch * dpr));
      this._ensureBuffers();
      this._draw();
      this._sync();
    }

    _frame(now) {
      this._raf = 0;
      const doc = typeof document !== 'undefined' ? document : null;
      if (this._still() || (doc && doc.hidden) || !this._visible) return;
      const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this.rt += dt;
      const started = performance.now();
      this._update(dt);
      this._draw();
      const cost = performance.now() - started;
      this.status.frames++;
      this.status.frameMs = this.status.frameMs ? this.status.frameMs * 0.9 + cost * 0.1 : cost;
      this._n++;
      if (now - this._statAt >= 500) {
        this.status.fps = (this._n * 1000) / Math.max(1, now - this._statAt);
        this._n = 0;
        this._statAt = now;
      }
      this._raf = requestAnimationFrame(this._onFrame);
    }

    _snap() {
      this.mix = { ...MOTION[this.state] };
      this.col = this._pal[this.state].slice();
      this.voice = 0;
      this.impulse = 0;
      this.flash = 0;
      this.shake = 0;
      this._staticPhase = this.phase;
      this._staticAngle = this.angle;
      this.breath = Math.sin(this._staticPhase);
    }

    // Часы рисунка: в покое берём замороженную фазу, в движении — живую.
    _phaseNow() {
      return this._still() ? this._staticPhase : this.phase;
    }

    _angleNow() {
      return this._still() ? this._staticAngle : this.angle;
    }

    _update(dt) {
      const k = 1 - Math.exp(-dt / 0.24);
      const target = MOTION[this.state];
      for (const key of MIX_KEYS) this.mix[key] = mix(this.mix[key], target[key], k);
      const palTarget = this._pal[this.state];
      for (let i = 0; i < 3; i++) this.col[i] = mix(this.col[i], palTarget[i], k);

      const spd = clamp(Number(this.cfg.speed) || 1, 0.2, 3);
      this.phase += dt * this.mix.speed * spd * (1 + this._voiceOut() * 0.65);
      this.angle += dt * this.mix.spin * spd;
      this.breath = Math.sin(this.phase);

      // Голос: быстрый подъём, мягкий спад; без внешнего уровня «дышит» только речь.
      const external = this.rt - this.voiceAt <= 0.3;
      if (!external && (this.state === 'listening' || this.state === 'speaking')) {
        this.voiceTarget = 0.16 + 0.36 * (0.5 + 0.5 * Math.sin(this.rt * 7.9) * Math.sin(this.rt * 3.3 + 1.4));
      } else if (!external) {
        this.voiceTarget = 0;
      }
      const attack = this.voiceTarget > this.voice ? 0.07 : 0.22;
      this.voice = mix(this.voice, this.voiceTarget, 1 - Math.exp(-dt / attack));

      this.impulse *= Math.exp(-dt / 0.42);
      if (this.impulse < 0.002) this.impulse = 0;
      this.flash *= Math.exp(-dt / 0.55);
      this.shake *= Math.exp(-dt / 0.16);
    }

    // ── Геометрия ─────────────────────────────────────────────────────

    _buildGeometry() {
      switch (this.variant) {
        case 'membrane': this._buildMembrane(); break;
        case 'resonance': this._buildResonance(); break;
        case 'crystal': this._buildCrystal(); break;
        case 'plasma': this._buildPlasma(); break;
        case 'comb': this._buildComb(); break;
        default: this._buildFlux(); break;
      }
      this._ensureBuffers();
    }

    _makeLines(kind, lines, blockSplits) {
      let n = 0;
      for (const line of lines) n += line.length / 3;
      const px = new Float32Array(n);
      const py = new Float32Array(n);
      const pz = new Float32Array(n);
      const lat = new Float32Array(n);
      const lon = new Float32Array(n);
      const blocks = [];
      const lineStart = new Uint16Array(lines.length + 1);
      let at = 0;
      for (let li = 0; li < lines.length; li++) {
        const arr = lines[li];
        const count = arr.length / 3;
        const start = at;
        lineStart[li] = start;
        for (let k = 0; k < count; k++) {
          const x = arr[k * 3];
          const y = arr[k * 3 + 1];
          const z = arr[k * 3 + 2];
          px[at] = x;
          py[at] = y;
          pz[at] = z;
          lat[at] = Math.asin(clamp(y, -1, 1));
          lon[at] = Math.atan2(z, x);
          at++;
        }
        const splits = Math.max(2, blockSplits);
        for (let b = 0; b < splits; b++) {
          const from = Math.round((b / splits) * (count - 1));
          const to = Math.round(((b + 1) / splits) * (count - 1));
          if (to <= from) continue;
          blocks.push({ start: start + from, count: to - from + 1, line: li, phase: li * 0.7 + (b / splits) * TAU });
        }
      }
      lineStart[lines.length] = n;
      this._geo = {
        kind, n, px, py, pz, lat, lon, lines, lineStart,
        blockCount: 0,
        blocks,
      };
      this._geo.blockCount = blocks.length;
    }

    _buildFlux() {
      const lineCount = Math.max(18, Math.round(30 * Math.sqrt(this.cfg.detail)));
      const steps = 62;
      const lines = [];
      for (let j = 0; j < lineCount; j++) {
        const arr = new Float32Array(steps * 3);
        const phi = (j / lineCount) * TAU;
        const shell = 0.78 + 0.16 * (0.5 + 0.5 * Math.sin(j * 2.39996));
        const twist = 0.42 + 0.2 * Math.sin(j * 1.7);
        for (let k = 0; k < steps; k++) {
          const u = k / (steps - 1);
          const theta = 0.1 + u * (Math.PI - 0.2);
          const r = shell + 0.2 * Math.sin(theta) ** 2;
          const a = phi + twist * Math.cos(theta) + 0.08 * Math.sin(theta * 3 + j);
          arr[k * 3] = r * Math.sin(theta) * Math.cos(a);
          arr[k * 3 + 1] = r * Math.cos(theta) * 0.9;
          arr[k * 3 + 2] = r * Math.sin(theta) * Math.sin(a);
        }
        lines.push(arr);
      }
      this._makeLines('lines', lines, 3);
    }

    _buildMembrane() {
      const meridians = Math.max(16, Math.round(24 * Math.sqrt(this.cfg.detail)));
      const parallels = Math.max(9, Math.round(13 * Math.sqrt(this.cfg.detail)));
      const merSteps = 52;
      const parSteps = 76;
      const lines = [];
      for (let j = 0; j < meridians; j++) {
        const arr = new Float32Array(merSteps * 3);
        const phi = (j / meridians) * TAU;
        for (let k = 0; k < merSteps; k++) {
          const t = 0.024 + (k / (merSteps - 1)) * (Math.PI - 0.048);
          arr[k * 3] = Math.sin(t) * Math.cos(phi);
          arr[k * 3 + 1] = Math.cos(t);
          arr[k * 3 + 2] = Math.sin(t) * Math.sin(phi);
        }
        lines.push(arr);
      }
      for (let j = 1; j <= parallels; j++) {
        const arr = new Float32Array(parSteps * 3);
        const t = (j / (parallels + 1)) * Math.PI;
        const rr = Math.sin(t);
        for (let k = 0; k < parSteps; k++) {
          const phi = (k / parSteps) * TAU;
          arr[k * 3] = rr * Math.cos(phi);
          arr[k * 3 + 1] = Math.cos(t);
          arr[k * 3 + 2] = rr * Math.sin(phi);
        }
        lines.push(arr);
      }
      this._makeLines('lines', lines, 4);
    }

    _buildResonance() {
      const bands = Math.max(14, Math.round(22 * Math.sqrt(this.cfg.detail)));
      const steps = 88;
      const lines = [];
      for (let j = 0; j < bands; j++) {
        const arr = new Float32Array(steps * 3);
        const lat = -0.94 + (1.88 * (j + 0.5)) / bands;
        const rr = Math.sqrt(Math.max(0.04, 1 - lat * lat));
        for (let k = 0; k < steps; k++) {
          const phi = (k / steps) * TAU;
          arr[k * 3] = rr * Math.cos(phi);
          arr[k * 3 + 1] = lat;
          arr[k * 3 + 2] = rr * Math.sin(phi);
        }
        lines.push(arr);
      }
      this._makeLines('lines', lines, 4);
    }

    _buildCrystal() {
      const level = this.cfg.detail < 0.74 ? 0 : this.cfg.detail < 1.18 ? 1 : 2;
      const { verts, faces } = geodesic(level);
      const n = verts.length;
      const px = new Float32Array(n);
      const py = new Float32Array(n);
      const pz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        px[i] = verts[i][0];
        py[i] = verts[i][1];
        pz[i] = verts[i][2];
      }
      const edgeMap = new Map();
      const edges = [];
      for (const [a, b, c] of faces) {
        for (const pair of [[a, b], [b, c], [c, a]]) {
          const key = pair[0] < pair[1] ? pair[0] + '_' + pair[1] : pair[1] + '_' + pair[0];
          if (edgeMap.has(key)) continue;
          edgeMap.set(key, edges.length);
          edges.push(pair[0], pair[1]);
        }
      }
      const faceFlat = new Uint16Array(faces.length * 3);
      for (let i = 0; i < faces.length; i++) faceFlat.set(faces[i], i * 3);
      this._geo = {
        kind: 'crystal',
        n,
        px,
        py,
        pz,
        faceCount: faces.length,
        faces: faceFlat,
        edgeCount: edges.length / 2,
        edges: Uint16Array.from(edges),
        level,
      };
    }

    _buildPlasma() {
      const rng = mulberry32(0x9e3779b9);
      const strands = Math.max(12, Math.round(18 * Math.sqrt(this.cfg.detail)));
      const steps = 56;
      const lines = [];
      const rnd = new Float32Array(strands * steps);
      for (let j = 0; j < strands; j++) {
        const arr = new Float32Array(steps * 3);
        const phi = (j / strands) * TAU + rng() * 0.5;
        const tiltJ = (rng() - 0.5) * 1.5;
        for (let k = 0; k < steps; k++) {
          const u = k / (steps - 1);
          const theta = 0.24 + u * (Math.PI - 0.48);
          const swirl = phi + 1.6 * Math.sin(theta * 2 + j * 0.7);
          const rr = 0.62 + 0.3 * Math.sin(theta * 3 + j * 1.1) + tiltJ * 0.06;
          arr[k * 3] = rr * Math.sin(theta) * Math.cos(swirl);
          arr[k * 3 + 1] = rr * Math.cos(theta);
          arr[k * 3 + 2] = rr * Math.sin(theta) * Math.sin(swirl);
          rnd[j * steps + k] = rng();
        }
        lines.push(arr);
      }
      this._makeLines('lines', lines, 3);
      this._geo.rnd = rnd;
      const particles = Math.max(38, Math.round(58 * Math.sqrt(this.cfg.detail)));
      const particleBase = new Float32Array(particles * 4);
      for (let i = 0; i < particles; i++) {
        const theta = Math.acos(2 * rng() - 1);
        const phi = rng() * TAU;
        particleBase[i * 4] = theta;
        particleBase[i * 4 + 1] = phi;
        particleBase[i * 4 + 2] = 0.35 + rng() * 0.65;
        particleBase[i * 4 + 3] = rng();
      }
      this._geo.particles = particleBase;
      this._geo.particleCount = particles;
    }

    _buildComb() {
      // Уровень подразбиения: 12 пятиугольников, 42 ячейки (12+30) или 162 ячейки.
      const level = this.cfg.detail < 0.85 ? 0 : this.cfg.detail < 1.2 ? 1 : 2;
      const { verts, faces } = geodesic(level);
      const faceCentroids = faces.map(([a, b, c]) => norm3(
        (verts[a][0] + verts[b][0] + verts[c][0]) / 3,
        (verts[a][1] + verts[b][1] + verts[c][1]) / 3,
        (verts[a][2] + verts[b][2] + verts[c][2]) / 3,
      ));
      const incident = verts.map(() => []);
      faces.forEach((face, index) => { for (const v of face) incident[v].push(index); });

      const n = faceCentroids.length;
      const px = new Float32Array(n);
      const py = new Float32Array(n);
      const pz = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        px[i] = faceCentroids[i][0];
        py[i] = faceCentroids[i][1];
        pz[i] = faceCentroids[i][2];
      }
      const cellStart = new Uint16Array(verts.length + 1);
      const cellVerts = [];
      const centers = new Float32Array(verts.length * 3);
      for (let v = 0; v < verts.length; v++) {
        const center = norm3(verts[v][0], verts[v][1], verts[v][2]);
        centers[v * 3] = center[0];
        centers[v * 3 + 1] = center[1];
        centers[v * 3 + 2] = center[2];
        const list = incident[v].slice();
        // Порядок обхода вокруг вершины: две касательные к сфере.
        const axis = Math.abs(center[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let e1 = [axis[1] * center[2] - axis[2] * center[1], axis[2] * center[0] - axis[0] * center[2], axis[0] * center[1] - axis[1] * center[0]];
        e1 = norm3(e1[0], e1[1], e1[2]);
        const e2 = norm3(
          center[1] * e1[2] - center[2] * e1[1],
          center[2] * e1[0] - center[0] * e1[2],
          center[0] * e1[1] - center[1] * e1[0],
        );
        list.sort((ia, ib) => {
          const a = faceCentroids[ia];
          const b = faceCentroids[ib];
          const aa = Math.atan2(a[0] * e2[0] + a[1] * e2[1] + a[2] * e2[2], a[0] * e1[0] + a[1] * e1[1] + a[2] * e1[2]);
          const ba = Math.atan2(b[0] * e2[0] + b[1] * e2[1] + b[2] * e2[2], b[0] * e1[0] + b[1] * e1[1] + b[2] * e1[2]);
          return aa - ba;
        });
        cellStart[v] = cellVerts.length;
        cellVerts.push(...list);
      }
      cellStart[verts.length] = cellVerts.length;
      this._geo = {
        kind: 'comb',
        n,
        px,
        py,
        pz,
        cellCount: verts.length,
        cellStart,
        cellVerts: Uint16Array.from(cellVerts),
        centers,
        level,
      };
    }

    _ensureBuffers() {
      const geo = this._geo;
      if (!geo) return;
      const n = geo.n || 0;
      if (!this._ox || this._ox.length < n) {
        this._ox = new Float32Array(n);
        this._oy = new Float32Array(n);
        this._oz = new Float32Array(n);
      }
      if (geo.blocks && (!this._blockBucket || this._blockBucket.length < geo.blocks.length)) {
        this._blockBucket = new Uint8Array(geo.blocks.length);
      }
      if (geo.edgeCount && (!this._segBucket || this._segBucket.length < geo.edgeCount)) {
        this._segBucket = new Uint8Array(geo.edgeCount);
      }
      if (geo.faceCount && (!this._faceBucket || this._faceBucket.length < geo.faceCount)) {
        this._faceBucket = new Uint8Array(geo.faceCount);
      }
      if (geo.cellCount && (!this._cellBucket || this._cellBucket.length < geo.cellCount)) {
        this._cellBucket = new Uint8Array(geo.cellCount);
      }
    }

    // ── Кадр: проекция ────────────────────────────────────────────────

    _camera() {
      const w = this.w;
      const h = this.h;
      const cx = w / 2;
      const cy = h / 2;
      const quiet = this._still();
      const breath = quiet ? 0 : Math.sin(this.phase);
      const voice = this._voiceOut();
      const amp = this.mix.amp;
      const shakeX = quiet ? 0 : Math.sin(this.rt * 62) * this.shake * 2.2;
      const shakeY = quiet ? 0 : Math.cos(this.rt * 47) * this.shake * 1.6;
      const R = Math.min(w, h) * RADIUS_RATIO * this.cfg.scale
        * (1 + breath * 0.016 * amp + voice * 0.018 + this.flash * 0.02);
      this._R = R;
      this._cx = cx + shakeX;
      this._cy = cy + shakeY;
      const angle = quiet ? this._staticAngle : this.angle;
      this._ca = Math.cos(angle);
      this._sa = Math.sin(angle);
      return { cx: this._cx, cy: this._cy, R, quiet, breath, voice, amp, phase: quiet ? this._staticPhase : this.phase };
    }

    _projectAll() {
      const geo = this._geo;
      const cam = this._camera();
      const ox = this._ox;
      const oy = this._oy;
      const oz = this._oz;
      const px = geo.px;
      const py = geo.py;
      const pz = geo.pz;
      const n = geo.n;
      const ca = this._ca;
      const sa = this._sa;
      const cx = cam.cx;
      const cy = cam.cy;
      const R = cam.R;
      const phase = cam.phase;
      const voice = cam.voice;
      const amp = cam.amp;
      const breath = cam.breath;
      const variant = this.variant;

      if (variant === 'lines' || geo.kind === 'lines') {
        const lat = geo.lat;
        const lon = geo.lon;
        const rnd = geo.rnd;
        let i = 0;
        for (let li = 0; li < geo.lines.length; li++) {
          const count = (geo.lines[li].length / 3) | 0;
          for (let k = 0; k < count; k++, i++) {
            let x = px[i];
            let y = py[i];
            let z = pz[i];
            if (this.variant === 'flux') {
              const wob = Math.sin(phase * 1.15 + y * 2.7 + x * 1.5 + li * 0.35) * 0.085 * amp;
              const cs = Math.cos(wob);
              const sn = Math.sin(wob);
              const nx = x * cs - z * sn;
              z = x * sn + z * cs;
              x = nx;
              const swell = 1 + breath * 0.02 * amp + voice * 0.055 * Math.sin(y * 4 + phase * 2.2);
              x *= swell;
              y *= swell;
              z *= swell;
            } else if (this.variant === 'membrane') {
              const la = lat[i];
              const lo = lon[i];
              const ripple = amp * (0.034 * Math.sin(3 * lo + phase * 0.85) * Math.sin(2 * la + phase * 0.6)
                + 0.017 * Math.sin(5 * la - phase * 1.2));
              const local = 1 + ripple + voice * 0.06 * Math.sin(la * 4 + phase * 2.1) + breath * 0.018 * amp;
              x *= local;
              y *= local;
              z *= local;
            } else if (this.variant === 'resonance') {
              const la = lat[i];
              const lo = lon[i];
              const wave = 0.055 * amp * Math.sin(lo * 3 + li * 0.55 + phase * 1.5)
                + voice * 0.03 * Math.sin(lo * 2 - phase * 2.1);
              const ny = y + wave;
              const rr = Math.sqrt(Math.max(0.02, 1 - ny * ny));
              const inv = rr / Math.sqrt(Math.max(0.02, 1 - y * y));
              x *= inv;
              z *= inv;
              y = ny;
            } else if (this.variant === 'plasma') {
              const rp = rnd ? rnd[i] : 0;
              const turb = 0.085 * amp + voice * 0.05;
              const nx = x + turb * Math.sin(phase * 1.7 + rp * 5 + x * 2.2);
              const ny = y + turb * Math.cos(phase * 1.3 + rp * 3.7 + y * 2.6);
              const nz = z + turb * Math.sin(phase * 2.1 + rp * 4.3 + z * 2.1);
              const len = Math.hypot(nx, ny, nz) || 1;
              x = nx / len;
              y = ny / len;
              z = nz / len;
            }
            const rx = x * ca - z * sa;
            const rz = x * sa + z * ca;
            const ry = y * COS_TILT - rz * SIN_TILT;
            const depth = y * SIN_TILT + rz * COS_TILT;
            const persp = PERSPECTIVE / (PERSPECTIVE - depth);
            ox[i] = cx + rx * R * persp;
            oy[i] = cy + ry * R * persp;
            oz[i] = clamp((depth + 1) * 0.5, 0, 1);
          }
        }
        this._bucketBlocks(amp, cam.phase);
        return;
      }

      if (geo.kind === 'crystal') {
        const pulse = 1 + voice * 0.04 + this.flash * 0.04 + (cam.quiet ? 0 : breath * 0.024);
        const wobble = cam.quiet ? 0 : Math.sin(cam.phase * 0.8) * 0.03 * amp;
        for (let i = 0; i < n; i++) {
          const x = px[i] * pulse;
          const y = (py[i] + wobble * Math.sin(py[i] * 2 + cam.phase)) * pulse;
          const z = pz[i] * pulse;
          const rx = x * ca - z * sa;
          const rz = x * sa + z * ca;
          const ry = y * COS_TILT - rz * SIN_TILT;
          const depth = y * SIN_TILT + rz * COS_TILT;
          const persp = PERSPECTIVE / (PERSPECTIVE - depth);
          ox[i] = cx + rx * R * persp;
          oy[i] = cy + ry * R * persp;
          oz[i] = clamp((depth + 1) * 0.5, 0, 1);
        }
        this._bucketCrystal();
        return;
      }

      if (geo.kind === 'comb') {
        const pulse = 1 + voice * 0.03 + this.flash * 0.035 + (cam.quiet ? 0 : breath * 0.018);
        for (let i = 0; i < n; i++) {
          const x = px[i] * pulse;
          const y = py[i] * pulse;
          const z = pz[i] * pulse;
          const rx = x * ca - z * sa;
          const rz = x * sa + z * ca;
          const ry = y * COS_TILT - rz * SIN_TILT;
          const depth = y * SIN_TILT + rz * COS_TILT;
          const persp = PERSPECTIVE / (PERSPECTIVE - depth);
          ox[i] = cx + rx * R * persp;
          oy[i] = cy + ry * R * persp;
          oz[i] = clamp((depth + 1) * 0.5, 0, 1);
        }
        this._bucketComb();
      }
    }

    _bucketBlocks(amp, phase) {
      const geo = this._geo;
      const blocks = geo.blocks;
      const buckets = this._blockBucket;
      const oz = this._oz;
      const variant = this.variant;
      for (let b = 0; b < blocks.length; b++) {
        const bl = blocks[b];
        let sum = 0;
        const end = bl.start + bl.count;
        for (let i = bl.start; i < end; i++) sum += oz[i];
        let depth = sum / bl.count;
        if (variant === 'flux' || variant === 'resonance' || variant === 'plasma') {
          const wave = 0.5 + 0.5 * Math.sin(phase * 1.7 + bl.phase);
          depth = depth * 0.7 + wave * 0.3 * amp;
        } else if (variant === 'membrane') {
          const wave = 0.5 + 0.5 * Math.sin(phase * 0.8 + bl.phase * 0.3);
          depth = depth * 0.82 + wave * 0.18;
        }
        let bucket = (depth * BLOCK_BUCKETS) | 0;
        if (bucket < 0) bucket = 0;
        else if (bucket >= BLOCK_BUCKETS) bucket = BLOCK_BUCKETS - 1;
        buckets[b] = bucket;
      }
    }

    _bucketCrystal() {
      const geo = this._geo;
      const ox = this._ox;
      const oy = this._oy;
      const oz = this._oz;
      const faces = geo.faces;
      const faceBucket = this._faceBucket;
      for (let f = 0; f < geo.faceCount; f++) {
        const a = faces[f * 3];
        const b = faces[f * 3 + 1];
        const c = faces[f * 3 + 2];
        const area = (ox[b] - ox[a]) * (oy[c] - oy[a]) - (ox[c] - ox[a]) * (oy[b] - oy[a]);
        const shade = clamp(Math.abs(area) / (this._R * this._R * 0.55));
        const depth = (oz[a] + oz[b] + oz[c]) / 3;
        let bucket = ((depth * 0.55 + shade * 0.45) * BLOCK_BUCKETS) | 0;
        if (bucket < 0) bucket = 0;
        else if (bucket >= BLOCK_BUCKETS) bucket = BLOCK_BUCKETS - 1;
        faceBucket[f] = bucket;
      }
      const edges = geo.edges;
      const segBucket = this._segBucket;
      for (let e = 0; e < geo.edgeCount; e++) {
        const a = edges[e * 2];
        const b = edges[e * 2 + 1];
        let bucket = (((oz[a] + oz[b]) * 0.5 * SEG_BUCKETS) | 0);
        if (bucket < 0) bucket = 0;
        else if (bucket >= SEG_BUCKETS) bucket = SEG_BUCKETS - 1;
        segBucket[e] = bucket;
      }
    }

    _bucketComb() {
      const geo = this._geo;
      const start = geo.cellStart;
      const verts = geo.cellVerts;
      const oz = this._oz;
      const cells = this._cellBucket;
      const centers = geo.centers;
      const phase = this._phaseNow();
      for (let c = 0; c < geo.cellCount; c++) {
        const from = start[c];
        const to = start[c + 1];
        let sum = 0;
        for (let i = from; i < to; i++) sum += oz[verts[i]];
        let depth = sum / Math.max(1, to - from);
        const wave = 0.5 + 0.5 * Math.sin(phase * 1.6 + centers[c * 3] * 2.6 + centers[c * 3 + 1] * 1.7);
        depth = depth * 0.78 + wave * 0.22;
        let bucket = (depth * BLOCK_BUCKETS) | 0;
        if (bucket < 0) bucket = 0;
        else if (bucket >= BLOCK_BUCKETS) bucket = BLOCK_BUCKETS - 1;
        cells[c] = bucket;
      }
    }

    // ── Кадр: рисование ───────────────────────────────────────────────

    _rgba(alpha) {
      const c = this.col;
      return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp(alpha).toFixed(3) + ')';
    }

    _rgbaOf(rgb, alpha) {
      const c = rgb || this.col;
      return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp(alpha).toFixed(3) + ')';
    }

    // На тёмной теме свет добавляем (lighter), на светлой — рисуем цветом темы поверх
    // (source-over): иначе белое свечение уходит в светлый фон и сфера бледнеет.
    _glowOp() {
      return this._light ? 'source-over' : 'lighter';
    }

    _draw() {
      const ctx = this.ctx;
      if (!ctx || !this.w || !this.h) return;
      const started = performance.now();
      this._projectAll();
      const w = this.w;
      const h = this.h;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, w, h);
      const bright = this.mix.bright * this.cfg.light;
      this._drawHalo(ctx, w / 2, h / 2, this._R, bright);
      switch (this.variant) {
        case 'membrane': this._paintMembrane(ctx, bright); break;
        case 'resonance': this._paintResonance(ctx, bright); break;
        case 'crystal': this._paintCrystal(ctx, bright); break;
        case 'plasma': this._paintPlasma(ctx, bright); break;
        case 'comb': this._paintComb(ctx, bright); break;
        default: this._paintFlux(ctx, bright); break;
      }
      this._drawImpulse(ctx);
      this._lastDrawCost = performance.now() - started;
    }

    _drawHalo(ctx, cx, cy, R, bright) {
      const halo = this.mix.halo * bright * (this._light ? 1.35 : 1);
      if (halo <= 0) return;
      const grad = ctx.createRadialGradient(cx, cy, R * 0.05, cx, cy, R * 1.55);
      grad.addColorStop(0, this._rgba((this._light ? 0.11 : 0.075) * halo));
      grad.addColorStop(0.55, this._rgba((this._light ? 0.045 : 0.03) * halo));
      grad.addColorStop(1, this._rgba(0));
      ctx.fillStyle = grad;
      ctx.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);
    }

    _drawSphereBody(ctx, cx, cy, R, alpha) {
      const body = ctx.createRadialGradient(cx - R * 0.32, cy - R * 0.38, 0, cx, cy, R);
      body.addColorStop(0, this._rgba(alpha));
      body.addColorStop(0.62, this._rgba(alpha * 0.42));
      body.addColorStop(0.92, this._rgba(alpha * 0.14));
      body.addColorStop(1, this._rgba(0));
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();
    }

    _drawBlocks(ctx, bright) {
      const geo = this._geo;
      const blocks = geo.blocks;
      const bucket = this._blockBucket;
      const ox = this._ox;
      const oy = this._oy;
      const NB = BLOCK_BUCKETS;
      for (let b = 0; b < NB; b++) {
        ctx.beginPath();
        let painted = false;
        for (let k = 0; k < blocks.length; k++) {
          if (bucket[k] !== b) continue;
          const bl = blocks[k];
          painted = true;
          ctx.moveTo(ox[bl.start], oy[bl.start]);
          const end = bl.start + bl.count;
          for (let i = bl.start + 1; i < end; i++) ctx.lineTo(ox[i], oy[i]);
        }
        if (!painted) continue;
        const t = b / (NB - 1);
        // На светлой теме линии плотнее: тот же цвет темы, но чуть шире и непрозрачнее.
        const gain = this._light ? 1.14 : 1;
        const widthAdd = this._light ? 0.14 : 0;
        // Мягкое свечение перед чёткими линиями: у ярких корзин рисуем широкий полупрозрачный штрих.
        if (t > 0.68) {
          ctx.strokeStyle = this._rgba((0.05 + t * 0.12) * bright * (this._light ? 0.9 : 1));
          ctx.lineWidth = 2.4 + t * 3.4;
          ctx.stroke();
        }
        ctx.strokeStyle = this._rgba((0.095 + t * 0.86) * bright * gain);
        ctx.lineWidth = 0.6 + t * 0.85 + widthAdd;
        ctx.stroke();
      }
    }

    _drawCore(ctx, cx, cy, R, bright, size, alpha) {
      const coreR = Math.max(2, R * size * (1 + this._voiceOut() * 0.12 + this.flash * 0.16));
      if (this._light) {
        // Светлая тема: ядро — плотное тёмное пятно цвета темы с мягким ореолом.
        const deep = darken(this.col, 0.34);
        ctx.globalCompositeOperation = 'source-over';
        const lightGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.4);
        lightGrad.addColorStop(0, this._rgbaOf(deep, 0.98 * alpha));
        lightGrad.addColorStop(0.2, this._rgbaOf(this.col, 0.85 * alpha));
        lightGrad.addColorStop(0.5, this._rgbaOf(this.col, 0.2 * alpha));
        lightGrad.addColorStop(1, this._rgbaOf(this.col, 0));
        ctx.fillStyle = lightGrad;
        ctx.fillRect(cx - coreR * 3.4, cy - coreR * 3.4, coreR * 6.8, coreR * 6.8);
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
      ctx.globalCompositeOperation = 'lighter';
      const grad = ctx.createRadialGradient(cx - coreR * 0.3, cy - coreR * 0.35, 0, cx, cy, coreR * 4.2);
      grad.addColorStop(0, 'rgba(255,255,255,' + (0.96 * alpha).toFixed(3) + ')');
      grad.addColorStop(0.16, this._rgba(0.78 * alpha * bright));
      grad.addColorStop(0.42, this._rgba(0.2 * alpha));
      grad.addColorStop(1, this._rgba(0));
      ctx.fillStyle = grad;
      ctx.fillRect(cx - coreR * 4.2, cy - coreR * 4.2, coreR * 8.4, coreR * 8.4);
      ctx.globalCompositeOperation = 'source-over';
    }

    _drawImpulse(ctx) {
      if (this.impulse <= 0.001) return;
      const R = this._R;
      const cx = this._cx;
      const cy = this._cy;
      const k = 1 - this.impulse;
      const radius = R * (0.55 + k * 0.85);
      const alpha = this.impulse * 0.5 * this.cfg.light * (this._light ? 1.3 : 1);
      ctx.globalCompositeOperation = this._glowOp();
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.strokeStyle = this._rgba(alpha);
      ctx.lineWidth = 0.9 + this.impulse * 1.3;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    _paintFlux(ctx, bright) {
      const cx = this._cx;
      const cy = this._cy;
      const R = this._R;
      this._drawSphereBody(ctx, cx, cy, R, 0.21 * bright);
      this._drawBlocks(ctx, bright);
      // Светящиеся «головы» струй: поток всё время течёт по линиям.
      const geo = this._geo;
      const ox = this._ox;
      const oy = this._oy;
      const oz = this._oz;
      ctx.globalCompositeOperation = this._glowOp();
      const phase = this._phaseNow();
      for (let li = 0; li < geo.lines.length; li++) {
        const start = geo.lineStart[li];
        const count = geo.lineStart[li + 1] - start;
        const u = (phase * 0.09 + li * 0.13) % 1;
        const at = start + Math.min(count - 1, (u * (count - 1)) | 0);
        const depth = oz[at];
        ctx.beginPath();
        ctx.arc(ox[at], oy[at], (0.8 + depth * 1.6) * (this._light ? 1.25 : 1), 0, TAU);
        ctx.fillStyle = this._rgba((0.35 + depth * 0.45) * (this._light ? 1.35 : 1));
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      this._drawCore(ctx, cx, cy, R, bright, 0.055, 1);
    }

    _paintMembrane(ctx, bright) {
      const cx = this._cx;
      const cy = this._cy;
      const R = this._R;
      this._drawSphereBody(ctx, cx, cy, R, 0.13 * bright);
      this._drawBlocks(ctx, bright);
      ctx.globalCompositeOperation = this._glowOp();
      // Кромка мембраны: дышит и отзывается на голос.
      const rim = R * (1 + this._voiceOut() * 0.035 + (this._still() ? 0 : this.breath) * 0.008);
      ctx.beginPath();
      ctx.arc(cx, cy, rim, 0, TAU);
      ctx.strokeStyle = this._rgba((this._light ? 0.52 : 0.34) * bright);
      ctx.lineWidth = this._light ? 1.1 : 0.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, rim * 0.985, 0, TAU);
      ctx.strokeStyle = this._rgba((this._light ? 0.2 : 0.13) * bright);
      ctx.lineWidth = 1.9;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      this._drawCore(ctx, cx, cy, R, bright, 0.03, 0.7);
    }

    _paintResonance(ctx, bright) {
      const cx = this._cx;
      const cy = this._cy;
      const R = this._R;
      this._drawSphereBody(ctx, cx, cy, R, 0.13 * bright);
      this._drawBlocks(ctx, bright);
      ctx.globalCompositeOperation = this._glowOp();
      // Расходящиеся кольца резонанса.
      const voice = this._voiceOut();
      const phase = this._phaseNow();
      for (let k = 0; k < 3; k++) {
        const wave = 0.5 + 0.5 * Math.sin(phase * 1.7 - k * 1.1);
        const radius = R * (0.34 + k * 0.22 + wave * 0.05 + voice * 0.03);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, TAU);
        ctx.strokeStyle = this._rgba((0.07 + wave * 0.19) * bright * (this._light ? 1.5 : 1));
        ctx.lineWidth = 0.7 + wave * 0.6 + (this._light ? 0.15 : 0);
        ctx.stroke();
      }
      // Две наклонные орбиты.
      for (let k = 0; k < 2; k++) {
        const rot = this._angleNow() * 0.6 + k * 1.2;
        ctx.beginPath();
        ctx.ellipse(cx, cy, R * (1.08 + k * 0.1), R * (0.3 + k * 0.06), rot, 0, TAU);
        ctx.strokeStyle = this._rgba((0.09 + k * 0.03) * bright * (this._light ? 1.6 : 1));
        ctx.lineWidth = 0.8 + (this._light ? 0.1 : 0);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      this._drawCore(ctx, cx, cy, R, bright, 0.05, 1);
    }

    _paintCrystal(ctx, bright) {
      const cx = this._cx;
      const cy = this._cy;
      const R = this._R;
      this._drawSphereBody(ctx, cx, cy, R * 0.95, 0.1 * bright);
      const geo = this._geo;
      const faces = geo.faces;
      const ox = this._ox;
      const oy = this._oy;
      const buckets = this._faceBucket;
      const NB = BLOCK_BUCKETS;
      // Грани: полупрозрачные стеклянные многоугольники, сгруппированные по глубине.
      for (let b = 0; b < NB; b++) {
        ctx.beginPath();
        let painted = false;
        for (let f = 0; f < geo.faceCount; f++) {
          if (buckets[f] !== b) continue;
          const a = faces[f * 3];
          const bb = faces[f * 3 + 1];
          const c = faces[f * 3 + 2];
          painted = true;
          ctx.moveTo(ox[a], oy[a]);
          ctx.lineTo(ox[bb], oy[bb]);
          ctx.lineTo(ox[c], oy[c]);
          ctx.closePath();
        }
        if (!painted) continue;
        const t = b / (NB - 1);
        ctx.fillStyle = this._rgba((0.055 + t * 0.17) * bright * (this._light ? 1.55 : 1));
        ctx.fill();
      }
      // Рёбра: от дальних к ближним.
      const edges = geo.edges;
      const segBucket = this._segBucket;
      for (let b = 0; b < SEG_BUCKETS; b++) {
        ctx.beginPath();
        let painted = false;
        for (let e = 0; e < geo.edgeCount; e++) {
          if (segBucket[e] !== b) continue;
          const a = edges[e * 2];
          const bb = edges[e * 2 + 1];
          painted = true;
          ctx.moveTo(ox[a], oy[a]);
          ctx.lineTo(ox[bb], oy[bb]);
        }
        if (!painted) continue;
        const t = b / (SEG_BUCKETS - 1);
        ctx.strokeStyle = this._rgba((0.13 + t * 0.92) * bright * (this._light ? 1.12 : 1));
        ctx.lineWidth = 0.65 + t * 0.9 + (this._light ? 0.14 : 0);
        ctx.stroke();
      }
      // Искры на вершинах и внутреннее ядро.
      ctx.globalCompositeOperation = this._glowOp();
      for (let i = 0; i < geo.n; i++) {
        const depth = this._oz[i];
        if (depth < 0.42 && this.flash <= 0.05) continue;
        const s = (0.7 + depth * 1.9 + this.flash * 1.8) * (this._light ? 1.15 : 1);
        ctx.beginPath();
        ctx.arc(ox[i], oy[i], s, 0, TAU);
        ctx.fillStyle = this._rgba((0.16 + depth * 0.62) * bright * (this._light ? 1.5 : 1));
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      this._drawCore(ctx, cx, cy, R, bright, 0.07, 0.95);
    }

    _paintPlasma(ctx, bright) {
      const cx = this._cx;
      const cy = this._cy;
      const R = this._R;
      this._drawSphereBody(ctx, cx, cy, R, 0.15 * bright);
      this._drawBlocks(ctx, bright);
      const geo = this._geo;
      const base = geo.particles;
      if (base) {
        const voice = this._voiceOut();
        const ca = this._ca;
        const sa = this._sa;
        const phase = this._phaseNow();
        ctx.globalCompositeOperation = this._glowOp();
        for (let i = 0; i < geo.particleCount; i++) {
          const theta = base[i * 4] + Math.sin(phase * 1.3 + i) * 0.16 * this.mix.amp;
          const phi = base[i * 4 + 1] + phase * 0.32 * (0.6 + base[i * 4 + 3]);
          const radius = base[i * 4 + 2] * (1 + voice * 0.06);
          const x = radius * Math.sin(theta) * Math.cos(phi);
          const y = radius * Math.cos(theta);
          const z = radius * Math.sin(theta) * Math.sin(phi);
          const rx = x * ca - z * sa;
          const rz = x * sa + z * ca;
          const ry = y * COS_TILT - rz * SIN_TILT;
          const depth = y * SIN_TILT + rz * COS_TILT;
          const persp = PERSPECTIVE / (PERSPECTIVE - depth);
          const sx = cx + rx * R * persp;
          const sy = cy + ry * R * persp;
          const d = clamp((depth + 1) * 0.5, 0, 1);
          ctx.beginPath();
          ctx.arc(sx, sy, (0.6 + d * 1.4) * (this._light ? 1.15 : 1), 0, TAU);
          ctx.fillStyle = this._rgba((0.18 + d * 0.72) * bright * (this._light ? 1.45 : 1));
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      this._drawCore(ctx, cx, cy, R, bright, 0.075, 1.05);
    }

    _paintComb(ctx, bright) {
      const cx = this._cx;
      const cy = this._cy;
      const R = this._R;
      this._drawSphereBody(ctx, cx, cy, R, 0.14 * bright);
      const geo = this._geo;
      const start = geo.cellStart;
      const verts = geo.cellVerts;
      const ox = this._ox;
      const oy = this._oy;
      const buckets = this._cellBucket;
      const NB = BLOCK_BUCKETS;
      const phase = this._phaseNow();
      const centers = geo.centers;
      const voice = this._voiceOut();
      for (let b = 0; b < NB; b++) {
        ctx.beginPath();
        let painted = false;
        for (let c = 0; c < geo.cellCount; c++) {
          if (buckets[c] !== b) continue;
          painted = true;
          const from = start[c];
          const to = start[c + 1];
          const first = verts[from];
          ctx.moveTo(ox[first], oy[first]);
          for (let i = from + 1; i < to; i++) ctx.lineTo(ox[verts[i]], oy[verts[i]]);
          ctx.closePath();
        }
        if (!painted) continue;
        const t = b / (NB - 1);
        ctx.fillStyle = this._rgba((0.045 + t * 0.13) * bright * (this._light ? 1.6 : 1));
        ctx.fill();
        ctx.strokeStyle = this._rgba((0.1 + t * 0.62) * bright * (this._light ? 1.2 : 1));
        ctx.lineWidth = 0.55 + t * 0.55 + (this._light ? 0.12 : 0);
        ctx.stroke();
      }
      // Волна отклика: ячейки, которые «загораются» по сфере.
      ctx.globalCompositeOperation = this._glowOp();
      ctx.beginPath();
      let hot = false;
      for (let c = 0; c < geo.cellCount; c++) {
        const wave = 0.5 + 0.5 * Math.sin(phase * 1.6 + centers[c * 3] * 2.6 + centers[c * 3 + 1] * 1.7);
        if (wave < 0.62 + 0.06 * Math.sin(phase)) continue;
        hot = true;
        const from = start[c];
        const to = start[c + 1];
        const first = verts[from];
        ctx.moveTo(ox[first], oy[first]);
        for (let i = from + 1; i < to; i++) ctx.lineTo(ox[verts[i]], oy[verts[i]]);
        ctx.closePath();
      }
      if (hot) {
        ctx.fillStyle = this._rgba((0.12 + voice * 0.1 + this.flash * 0.12) * bright * (this._light ? 1.5 : 1));
        ctx.fill();
        ctx.strokeStyle = this._rgba((0.16 + voice * 0.1) * bright * (this._light ? 1.25 : 1));
        ctx.lineWidth = 0.6 + (this._light ? 0.1 : 0);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      this._drawCore(ctx, cx, cy, R, bright, 0.055, 0.85);
    }
  }

  ExtraOrb.ignoreSystemMotion = false;

  // ── Реестр библиотеки: метаданные и регистрация ─────────────────────

  const VARIANT_META = {
    flux: { name: 'Поток', subtitle: 'Живые струи света вокруг тёплого ядра', detailLabel: 'Плотность струй' },
    membrane: { name: 'Мембрана', subtitle: 'Дышащая сетка-оболочка с мягкой кромкой', detailLabel: 'Плотность сетки' },
    resonance: { name: 'Резонанс', subtitle: 'Полосы, бегущие по сфере в такт волне', detailLabel: 'Число полос' },
    crystal: { name: 'Кристалл', subtitle: 'Огранённый многогранник с искрами граней', detailLabel: 'Детализация граней' },
    plasma: { name: 'Плазма', subtitle: 'Трепещущие сгустки света без чёткой формы', detailLabel: 'Турбулентность' },
    comb: { name: 'Соты', subtitle: 'Ячеистый панцирь с волной отклика', detailLabel: 'Число ячеек' },
  };

  function makeFields(detailLabel) {
    return [
      { key: 'scale', label: 'Масштаб сферы', min: 0.7, max: 1.3, step: 0.05, kind: 'range' },
      { key: 'speed', label: 'Скорость движения', min: 0.5, max: 1.6, step: 0.05, kind: 'range' },
      { key: 'light', label: 'Свечение', min: 0.6, max: 1.4, step: 0.05, kind: 'range' },
      { key: 'detail', label: detailLabel, min: 0.6, max: 1.4, step: 0.1, kind: 'range' },
      { key: 'animated', label: 'Плавное движение', kind: 'switch' },
      { key: 'voice', label: 'Реакция на голос', kind: 'switch' },
    ];
  }

  const PRESETS = {
    default: { name: 'Баланс', patch: { ...DEFAULTS } },
    calm: { name: 'Спокойная', patch: { scale: 0.92, speed: 0.6, light: 0.9, detail: 0.8, animated: true, voice: false } },
    vivid: { name: 'Выразительная', patch: { scale: 1.12, speed: 1.35, light: 1.3, detail: 1.2, animated: true, voice: true } },
  };

  function createOrb(variant) {
    return (canvas, opts = {}) => new ExtraOrb(canvas, { ...opts, variant });
  }

  const SPECS = VARIANTS.map((variant) => {
    const meta = VARIANT_META[variant];
    return {
      id: 'aether:' + variant,
      engine: 'custom',
      stateMap: 'nox',
      variant,
      name: meta.name,
      subtitle: meta.subtitle,
      systemLabel: 'Авторские сферы',
      defaults: { ...DEFAULTS },
      fields: makeFields(meta.detailLabel),
      presets: {
        default: { name: PRESETS.default.name, patch: { ...PRESETS.default.patch } },
        calm: { name: PRESETS.calm.name, patch: { ...PRESETS.calm.patch } },
        vivid: { name: PRESETS.vivid.name, patch: { ...PRESETS.vivid.patch } },
      },
      create: createOrb(variant),
    };
  });

  function registerExtraOrbs(lib) {
    if (!lib || typeof lib.registerOrb !== 'function' || typeof lib.get !== 'function') return 0;
    let added = 0;
    for (const spec of SPECS) {
      if (lib.get(spec.id)) continue;
      lib.registerOrb(spec);
      added++;
    }
    return added;
  }

  const api = {
    VARIANTS,
    STATES,
    SPECS,
    createOrb,
    createExtraOrb: (canvas, variant, opts = {}) => new ExtraOrb(canvas, { ...opts, variant }),
    ExtraOrb,
    registerExtraOrbs,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof window !== 'undefined') {
    root.NoxOrbsExtra = api;
    if (root.NoxOrbLibrary) registerExtraOrbs(root.NoxOrbLibrary);
  }
})(typeof window !== 'undefined' ? window : globalThis);
