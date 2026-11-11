/* Nox — реконструированный шар на canvas 2D: два вида, один цикл и общая машина состояний.
 *
 * Виды:
 *   'wire' — проволочная сфера из референса (02-sphere-2x, 05/06-sphere): полая сетка
 *            ~60 меридиан x ~34 параллели, 1px линии, глубина по z (ближние светлее),
 *            светлая деформируемая линия-пояс около экватора, центр неподвижен, вращения нет.
 *   'nox'  — продакшн-вид по orb-spec §2–4: 1400 точек Фибоначчи + ~200 точек ядра,
 *            объёмное свечение ядра, additive-смешение, медленное вращение 0.08 рад/с,
 *            дыхание ±6 % с периодом ~1.8 с, сдержанный ореол.
 *
 * Состояния меняют только параметры (скорость, амплитуда, яркость, цвет, ореол), геометрия одна:
 *   idle — дыхание 1.8 с, амплитуда 6 %, ореол 14 %;
 *   attentive — дыхание глубже 8 %, чуть светлее;
 *   listening — рябь по сфере в такт голосу, ядро пульсирует уровнем setVoice(0..1);
 *   thinking — дыхание 0.9 с, амплитуда 9 %, яркость +40 %, ореол 22 %;
 *   speaking — волна в такт голосу, пояс гаснет;
 *   waiting_approval — замедление 2.4 с, янтарь #F5A524, амплитуда 3 %;
 *   error — красный #FF5C5C, короткая затухающая дрожь 1.5 % за ~400 мс;
 *   success — вспышка и масштаб 1.04 на ~220 мс, изумрудный оттенок.
 *
 * Движение уважает систему: prefers-reduced-motion: reduce (если только
 * NoxOrb.ignoreSystemMotion !== true), html[data-motion="off"] и setAnimated(false).
 * В статичном режиме сфера остаётся цветной и подпись состояния меняется, движение уходит.
 * Кадры идут на requestAnimationFrame, пауза при document.hidden и вне экрана.
 * DPR учитывается: холст получает backing store dpr, рисование в CSS-пикселях.
 *
 *   const orb = new window.NoxOrb(canvas, {
 *     variant: 'nox', state: 'idle', animated: true, scale: 1,
 *     dpr: Math.min(window.devicePixelRatio || 1, 2),
 *   });
 *   orb.setVariant('wire'); orb.setState('thinking'); orb.setVoice(0.4);
 *   orb.pulse(0.8); orb.setAnimated(false); orb.resize(); orb.destroy();
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const RADIUS_RATIO = 0.49; // R = 0.49 * min(cssW, cssH) * scale: 260 px -> R ≈ 127
  const TILT = 0.13;         // фиксированный наклон камеры, не вращение
  const COS_T = Math.cos(TILT);
  const SIN_T = Math.sin(TILT);
  const TILT_CORE = 1;       // у ядра тот же наклон камеры

  const STATES = ['idle', 'attentive', 'listening', 'thinking', 'speaking', 'waiting_approval', 'error', 'success'];
  // Синонимы событий ядра: шар их понимает, но публичные состояния — только список выше.
  const ALIAS = {
    planning: 'thinking',
    searching: 'thinking',
    verifying: 'thinking',
    warning: 'waiting_approval',
    succeeded: 'success',
    cancelled: 'idle',
  };

  // Параметры состояния. speed — скорость формы, period — вдох-выдох (с), deform — пик ±доли R,
  // bright — яркость точек/линий, halo — сила ореола, coreGlow — свечение ядра, spin — рад/с, belt — пояс.
  const MOTION = {
    idle:             { speed: 1.00, period: 1.8, deform: 0.060, bright: 1.00, halo: 0.14, coreGlow: 0.90, pointScale: 1.00, spin: 0.08, belt: 1.00 },
    attentive:        { speed: 0.90, period: 2.1, deform: 0.080, bright: 1.05, halo: 0.15, coreGlow: 0.95, pointScale: 1.02, spin: 0.05, belt: 0.95 },
    listening:        { speed: 1.20, period: 1.6, deform: 0.060, bright: 1.10, halo: 0.17, coreGlow: 1.00, pointScale: 1.06, spin: 0.05, belt: 0.80 },
    thinking:         { speed: 1.50, period: 0.9, deform: 0.090, bright: 1.40, halo: 0.22, coreGlow: 1.15, pointScale: 1.25, spin: 0.16, belt: 1.15 },
    speaking:         { speed: 1.20, period: 1.8, deform: 0.060, bright: 1.15, halo: 0.17, coreGlow: 1.05, pointScale: 1.10, spin: 0.06, belt: 0.45 },
    waiting_approval: { speed: 0.55, period: 2.4, deform: 0.030, bright: 0.85, halo: 0.14, coreGlow: 0.80, pointScale: 0.95, spin: 0.02, belt: 0.85 },
    error:            { speed: 1.40, period: 3.2, deform: 0.040, bright: 1.05, halo: 0.16, coreGlow: 0.85, pointScale: 1.00, spin: 0.00, belt: 0.80 },
    success:          { speed: 1.00, period: 1.8, deform: 0.060, bright: 1.20, halo: 0.20, coreGlow: 1.10, pointScale: 1.05, spin: 0.08, belt: 1.05 },
  };
  const MIX_KEYS = ['speed', 'period', 'deform', 'bright', 'halo', 'coreGlow', 'pointScale', 'spin', 'belt'];

  const toRgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const pal = (line, lo, hi, pLo, coreHi, coreMid, coreLo) => ({
    line: toRgb(line), lo: toRgb(lo), hi: toRgb(hi), pLo: toRgb(pLo),
    coreHi: toRgb(coreHi), coreMid: toRgb(coreMid), coreLo: toRgb(coreLo),
  });
  // Палитры состояний. Циан — по референсу и токену accent; янтарь/красный/изумруд —
  // из ролей warn/err/ok (в модуле не читаем CSS: шар может жить и вне темы окна).
  const PALETTE = {
    idle:             pal('#4DBCE8', '#1A3D4F', '#E0F4FF', '#2A5A6B', '#E0F4FF', '#3AAAD6', '#1A5A7B'),
    attentive:        pal('#5CCCF5', '#1E4658', '#E4F8FF', '#2E6678', '#E4F8FF', '#46B6DE', '#1D6486'),
    listening:        pal('#6ED6FA', '#205062', '#E8FBFF', '#337486', '#E8FBFF', '#52C0E6', '#226E92'),
    thinking:         pal('#96E2FF', '#2A5A6B', '#F0FCFF', '#3E8298', '#F4FDFF', '#62C8EC', '#2A7EA6'),
    speaking:         pal('#5ACDF0', '#1E4A5B', '#E4F8FF', '#2E6C80', '#E4F8FF', '#46B6DE', '#1D6486'),
    waiting_approval: pal('#F5A524', '#4F3514', '#FFE0AA', '#5C4020', '#FFE8BE', '#F5A524', '#5A340A'),
    error:            pal('#FF5C5C', '#521C1C', '#FFCECE', '#602828', '#FFDCDC', '#FF5C5C', '#601414'),
    success:          pal('#8CF2BE', '#1A4F35', '#EBFFF6', '#2E6E4C', '#E6FFF4', '#6EEFA8', '#145032'),
  };
  const PAL_KEYS = Object.keys(PALETTE.idle);

  // Сетка проволочного вида. В документации оценка «~60 x ~40 ячеек», но по 02-sphere-2x.png
  // на диаметр сферы приходится ~40 ячеек (≈120 меридиан × ~60 параллелей): при 60 сфера
  // выглядит заметно реже референса. Берём 112 x 54 — плотность референса без слипания линий.
  const WIRE_MERIDIANS = 112;
  const WIRE_MER_STEPS = 64;
  const WIRE_PARALLELS = 54;
  const WIRE_PAR_STEPS = 96;
  const WIRE_BELT_LAT = -0.19;   // светлая линия чуть ниже экватора, как в кадрах 8.5–12.8 с
  const WIRE_BELT_STEPS = 132;
  const WIRE_SHADES = 12;        // корзин яркости: одна заливка пути на корзину
  const WIRE_DEFORM_GAIN = 1.45; // у референса изгиб глубже номинальных ±6 % (силуэт «пухлый»)

  // Точечная сфера: количество, корзины глубины, радиус ядра.
  const NOX_SHELL = 1400;
  const NOX_CORE = 200;
  const NOX_BUCKETS = 8;
  const CORE_RATIO = 0.42;

  // Виртуальный свет (orb-spec §4): ключевой сверху-слева, контровой снизу-справа.
  const norm3 = (x, y, z) => { const d = Math.hypot(x, y, z) || 1; return [x / d, y / d, z / d]; };
  const KEY = norm3(-0.55, 0.72, 0.42);
  const RIM = norm3(0.52, -0.44, 0.30);
  const KEY_X = KEY[0], KEY_Y = KEY[1], KEY_Z = KEY[2];
  const RIM_X = RIM[0], RIM_Y = RIM[1], RIM_Z = RIM[2];

  const reduceQuery = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const mixRgb = (a, b, k) => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp01(a).toFixed(3) + ')';

  // Детерминированный ГПСЧ: картинка не «кипит» между запусками и кадрами.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class NoxOrb {
    constructor(canvas, opts = {}) {
      if (!canvas || typeof canvas.getContext !== 'function') throw new Error('NoxOrb: нужен <canvas>');
      const o = opts || {};
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      if (!this.ctx) throw new Error('NoxOrb: canvas 2D недоступен');

      this.variant = o.variant === 'wire' ? 'wire' : 'nox';
      this.state = STATES.includes(o.state) ? o.state : (ALIAS[o.state] || 'idle');
      this.animated = o.animated !== false;
      this.scale = Number.isFinite(Number(o.scale)) && Number(o.scale) > 0 ? Math.min(6, Math.max(0.05, Number(o.scale))) : 1;
      // DPR задаётся явно (Lead передаёт Math.min(devicePixelRatio, 2)); иначе читаем сами.
      this.dprOpt = Number.isFinite(Number(o.dpr)) && Number(o.dpr) > 0
        ? Math.min(3, Math.max(0.5, Number(o.dpr)))
        : Math.min(window.devicePixelRatio || 1, 2);

      this.w = 0;
      this.h = 0;
      this.dpr = this.dprOpt;

      // Часы. phase — форма (изгиб сетки), breath — вдох-выдох, rotY — вращение nox, beltPhase — пояс.
      this.rt = 0;
      this.phase = 1.2;
      this.breath = 0.9;
      this.rotY = 0.35;
      this.beltPhase = 0;

      this.voiceTarget = 0;
      this.voice = 0;
      this.voiceAt = -10;

      this.kick = 0;        // импульс pulse(): расход по оболочке/поясу
      this.shake = 0;       // дрожь ошибки, затухает за ~400 мс
      this.shakePhase = 0;
      this.flash = 0;       // вспышка успеха, затухает за ~220 мс
      this.waves = [];      // расходящиеся кольца от pulse() у nox

      this.mix = { ...MOTION[this.state] };
      this.col = {};
      for (const key of PAL_KEYS) this.col[key] = PALETTE[this.state][key].slice();

      // Диагностика для замера fps (публичный API от неё не зависит).
      this.status = { fps: 0, frameMs: 0, frames: 0 };
      this._n = 0;
      this._statAt = 0;
      this._raf = 0;
      this._last = 0;
      this._visible = true;

      this._buildGeometry();
      this._bind();
      this._resize();
      this._sync();
      this._draw();
    }

    // ── Публичный API ────────────────────────────────────────────────────

    setVariant(variant) {
      const next = variant === 'wire' ? 'wire' : 'nox';
      if (next === this.variant) return;
      this.variant = next;
      this.waves.length = 0;
      this._draw();
      this._sync();
    }

    getVariant() {
      return this.variant;
    }

    setState(state) {
      const raw = String(state || '');
      const next = STATES.includes(raw) ? raw : ALIAS[raw];
      this.state = next || 'idle';
      if (this._still()) {
        this._snap();
      } else if (this.state === 'error') {
        this.shake = 1;
        this.shakePhase = 0;
      } else if (this.state === 'success') {
        this.flash = 1;
      }
      this._sync();
      this._draw();
    }

    setVoice(level) {
      const v = Number(level);
      this.voiceTarget = Number.isFinite(v) ? clamp01(v) : 0;
      this.voiceAt = this.rt;
    }

    setAnimated(on) {
      this.animated = Boolean(on);
      if (!this.animated) this._snap();
      this._sync();
      this._draw();
    }

    setScale(scale) {
      const v = Number(scale);
      this.scale = Number.isFinite(v) && v > 0 ? Math.min(6, Math.max(0.05, v)) : 1;
      this._draw();
    }

    // Импульс 0..1: у nox расходится кольцо по оболочке, у wire толчок формы и пояс.
    pulse(strength = 1) {
      const s = clamp01(Number(strength) || 0);
      if (s <= 0) return;
      this.kick = Math.max(this.kick, s);
      if (this.variant === 'nox') {
        this.waves.push({ t0: this.rt, amp: s });
        if (this.waves.length > 6) this.waves.shift();
      }
      this._sync();
    }

    resize() {
      this._resize();
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      document.removeEventListener('visibilitychange', this._onVis);
      window.removeEventListener('resize', this._onWinResize);
      if (reduceQuery && reduceQuery.removeEventListener) reduceQuery.removeEventListener('change', this._onReduce);
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this._mo) this._mo.disconnect();
      if (this.ctx) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }

    // Для замеров и отладки: fps по кадрам rAF, средняя стоимость update+draw.
    getStats() {
      return { fps: this.status.fps, frameMs: this.status.frameMs, frames: this.status.frames, variant: this.variant, state: this.state };
    }

    // ── События, движение, часы ──────────────────────────────────────────

    _bind() {
      this._onVis = () => this._sync();
      this._onWinResize = () => this._resize();
      this._onReduce = () => this._sync();
      this._onMotionAttr = () => this._sync();
      this._onFrame = (now) => this._frame(now);
      document.addEventListener('visibilitychange', this._onVis);
      window.addEventListener('resize', this._onWinResize);
      if (reduceQuery && reduceQuery.addEventListener) reduceQuery.addEventListener('change', this._onReduce);
      this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
      if (this._ro) this._ro.observe(this.canvas);
      this._io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          this._visible = entries.some((e) => e.isIntersecting);
          this._sync();
        })
        : null;
      if (this._io) this._io.observe(this.canvas);
      // html[data-motion="off"] — переключатель «Движение» в Настройках → Вид.
      if (typeof MutationObserver === 'function') {
        this._mo = new MutationObserver(this._onMotionAttr);
        this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
      }
    }

    // Движение запрещено: выключено владельцем, темой или системой.
    _still() {
      if (!this.animated) return true;
      if (document.documentElement && document.documentElement.getAttribute('data-motion') === 'off') return true;
      if (NoxOrb.ignoreSystemMotion !== true && reduceQuery && reduceQuery.matches) return true;
      return false;
    }

    _sync() {
      const run = !this._still() && !document.hidden && this._visible && this.w > 1 && this.h > 1;
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
      const cw = Math.round(this.canvas.clientWidth || (rect && rect.width) || 0);
      const ch = Math.round(this.canvas.clientHeight || (rect && rect.height) || 0);
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
      if (this._spr && this._spr.dpr !== dpr) this._spr = null;
      this._draw();
      this._sync();
    }

    _radius() {
      return RADIUS_RATIO * Math.min(this.w, this.h) * this.scale;
    }

    _frame(now) {
      if (this._still() || document.hidden) {
        this._raf = 0;
        return;
      }
      this._raf = requestAnimationFrame(this._onFrame);
      const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this.rt += dt;
      const t0 = performance.now();
      this._update(dt);
      this._draw();
      const ms = performance.now() - t0;
      this.status.frames++;
      this.status.frameMs = this.status.frameMs ? this.status.frameMs * 0.9 + ms * 0.1 : ms;
      this._n++;
      if (now - this._statAt >= 500) {
        this.status.fps = (this._n * 1000) / Math.max(1, now - this._statAt);
        this._n = 0;
        this._statAt = now;
      }
    }

    _update(dt) {
      // Мягкий переход параметров и цвета: смена состояния не режет глаз.
      const k = 1 - Math.exp(-dt / 0.26);
      const target = MOTION[this.state];
      for (const key of MIX_KEYS) this.mix[key] += (target[key] - this.mix[key]) * k;
      const palTarget = PALETTE[this.state];
      for (const key of PAL_KEYS) {
        const src = this.col[key];
        const dst = palTarget[key];
        for (let i = 0; i < 3; i++) src[i] += (dst[i] - src[i]) * k;
      }

      // Голос: быстрая атака, мягкий спад. Если источник не передаёт уровень, а состояние
      // говорит или слушает, рисуем оценку по времени — это не измеренная громкость.
      const external = this.rt - this.voiceAt <= 0.3;
      if (!external && (this.state === 'listening' || this.state === 'speaking')) {
        this.voiceTarget = 0.18 + 0.42 * (0.5 + 0.5 * Math.sin(this.rt * 8.3) * Math.sin(this.rt * 3.1 + 1.7));
      } else if (!external) {
        this.voiceTarget = 0;
      }
      this.voice += (this.voiceTarget - this.voice) * (1 - Math.exp(-dt / (this.voiceTarget > this.voice ? 0.05 : 0.18)));

      // Форма: speed задаёт, насколько быстро бегут волны, breathing живёт по своему периоду.
      this.phase += dt * this.mix.speed;
      this.breath += dt * (TAU / Math.max(0.5, this.mix.period));
      this.rotY += dt * this.mix.spin; // wire вращение игнорирует: в референсе только деформация
      this.beltPhase += dt * (TAU / 7);

      this.kick *= Math.exp(-dt / 0.22);
      this.flash *= Math.exp(-dt / 0.075);
      if (this.flash < 0.01) this.flash = 0;
      this.shake *= Math.exp(-dt / 0.09);
      this.shakePhase += dt * 58;
      if (this.shake < 0.004) this.shake = 0;
      const alive = [];
      for (const w of this.waves) if (this.rt - w.t0 < 0.65) alive.push(w);
      this.waves = alive;
    }

    _snap() {
      const m = MOTION[this.state];
      for (const key of MIX_KEYS) this.mix[key] = m[key];
      const p = PALETTE[this.state];
      for (const key of PAL_KEYS) this.col[key] = p[key].slice();
      this.kick = 0;
      this.flash = 0;
      this.shake = 0;
      this.voice = 0;
      this.waves.length = 0;
    }

    // ── Геометрия ────────────────────────────────────────────────────────

    _buildGeometry() {
      this.wire = this._buildWire();
      this.nox = this._buildNox();
    }

    _buildWire() {
      const lines = [];
      const meridian = (lon) => {
        const cl = Math.cos(lon), sl = Math.sin(lon);
        const arr = new Float32Array((WIRE_MER_STEPS + 1) * 3);
        for (let j = 0; j <= WIRE_MER_STEPS; j++) {
          const lat = -Math.PI / 2 + (j / WIRE_MER_STEPS) * Math.PI;
          const clat = Math.cos(lat);
          arr[j * 3] = cl * clat;
          arr[j * 3 + 1] = Math.sin(lat);
          arr[j * 3 + 2] = sl * clat;
        }
        return arr;
      };
      for (let i = 0; i < WIRE_MERIDIANS; i++) lines.push(meridian((i / WIRE_MERIDIANS) * TAU));
      for (let k = 0; k < WIRE_PARALLELS; k++) {
        const lat = -Math.PI / 2 + ((k + 0.5) / WIRE_PARALLELS) * Math.PI;
        const clat = Math.cos(lat), slat = Math.sin(lat);
        const arr = new Float32Array((WIRE_PAR_STEPS + 1) * 3);
        for (let j = 0; j <= WIRE_PAR_STEPS; j++) {
          const lon = (j / WIRE_PAR_STEPS) * TAU;
          arr[j * 3] = Math.cos(lon) * clat;
          arr[j * 3 + 1] = slat;
          arr[j * 3 + 2] = Math.sin(lon) * clat;
        }
        lines.push(arr);
      }
      let nPts = 0, nSegs = 0;
      for (const line of lines) {
        nPts += line.length / 3;
        nSegs += line.length / 3 - 1;
      }
      const base = new Float32Array(nPts * 3);
      const segs = new Int32Array(nSegs * 2);
      let po = 0, so = 0, pi = 0;
      for (const line of lines) {
        base.set(line, po);
        const n = line.length / 3;
        for (let j = 0; j < n - 1; j++) {
          segs[so++] = pi + j;
          segs[so++] = pi + j + 1;
        }
        pi += n;
        po += line.length;
      }
      // Светлый пояс: одно кольцо чуть ниже экватора, деформируется вместе с сеткой.
      const belt = new Float32Array((WIRE_BELT_STEPS + 1) * 3);
      const bClat = Math.cos(WIRE_BELT_LAT), bSlat = Math.sin(WIRE_BELT_LAT);
      for (let j = 0; j <= WIRE_BELT_STEPS; j++) {
        const lon = (j / WIRE_BELT_STEPS) * TAU;
        belt[j * 3] = Math.cos(lon) * bClat;
        belt[j * 3 + 1] = bSlat;
        belt[j * 3 + 2] = Math.sin(lon) * bClat;
      }
      return {
        base,
        segs,
        pts: new Float32Array(nPts * 3),
        segBucket: new Uint8Array(nSegs),
        belt,
        beltOut: new Float32Array(belt.length),
      };
    }

    _buildNox() {
      const rand = mulberry32(0x9e3779b9);
      const shell = new Float32Array(NOX_SHELL * 3);
      for (let i = 0; i < NOX_SHELL; i++) {
        const y = 1 - (i / (NOX_SHELL - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const th = i * GOLDEN;
        shell[i * 3] = Math.cos(th) * r;
        shell[i * 3 + 1] = y;
        shell[i * 3 + 2] = Math.sin(th) * r;
      }
      // Ядро: направления равномерно, радиус ∝ cbrt(rand) — плотнее к центру.
      const core = new Float32Array(NOX_CORE * 3);
      for (let i = 0; i < NOX_CORE; i++) {
        const z = rand() * 2 - 1;
        const phi = rand() * TAU;
        const rr = Math.sqrt(Math.max(0, 1 - z * z));
        const radius = CORE_RATIO * Math.cbrt(rand());
        core[i * 3] = Math.cos(phi) * rr * radius;
        core[i * 3 + 1] = z * radius;
        core[i * 3 + 2] = Math.sin(phi) * rr * radius;
      }
      const buckets = [];
      for (let b = 0; b < NOX_BUCKETS; b++) buckets.push(new Int32Array(NOX_SHELL));
      return {
        shell,
        core,
        sx: new Float32Array(NOX_SHELL),
        sy: new Float32Array(NOX_SHELL),
        ss: new Float32Array(NOX_SHELL),
        buckets,
        bucketCount: new Int32Array(NOX_BUCKETS),
      };
    }

    // ── Форма и затенение ───────────────────────────────────────────────

    // Крупные волны по трём осям — аналог изгиба сетки в референсе. Диапазон примерно ±1.
    // Две низкочастотные составляющие с постоянной фазой дают «пухлый» силуэт (низ и левый бок),
    // как на 02-sphere-2x, а не идеальный шар.
    _deformShape(x, y, z, t) {
      return Math.sin(y * 1.9 + t * 2.6) * 0.52
        + Math.sin(x * 2.3 - t * 2.2) * 0.26
        + Math.sin(z * 1.8 + t * 1.8) * 0.12
        + Math.sin(y * 1.28 + 0.7) * 0.16
        + Math.sin(x * 1.55 + 2.3) * 0.10;
    }

    // Голос и импульс добавляют рябь поверх общей формы.
    _extraDeform(x, y, z, t) {
      const v = this.voice;
      if (v > 0.01) {
        if (this.state === 'listening') return v * 0.040 * Math.sin(y * 5.5 + t * 7.5);
        if (this.state === 'speaking') return v * 0.060 * Math.sin(y * 4.0 - t * 6.0);
      }
      return 0;
    }

    // Свет и глубина точки/вершины (nox): 0 — дальняя тёмная сторона, 1 — ближняя яркая.
    _shade(px, ty, tz) {
      const key = Math.max(0, px * KEY_X + ty * KEY_Y + tz * KEY_Z);
      const edge = 1 - Math.abs(tz);
      const rim = edge * edge * edge * Math.max(0, px * RIM_X + ty * RIM_Y + tz * RIM_Z);
      const depth01 = (tz + 1) * 0.5;
      const light = 0.76 + 0.30 * key + 0.10 * rim;
      return { depth01, light, shade: Math.pow(depth01, 0.9) * light };
    }

    // Свет для проволочной сетки: середина приглушена, ярче к силуэту и к ключевому свету,
    // задняя полусфера заметно тусклее — именно так читается 02-sphere-2x.
    _wireShade(px, ty, tz) {
      const key = Math.max(0, px * KEY_X + ty * KEY_Y + tz * KEY_Z);
      const edge = 1 - Math.abs(tz);
      const rim = edge * edge * edge * Math.max(0, px * RIM_X + ty * RIM_Y + tz * RIM_Z);
      const depth01 = (tz + 1) * 0.5;
      // Задняя полусфера заметно тусклее ближней, но не исчезает: в референсе
      // дальняя сетка просвечивает и вместе с ближней даёт плотную «ткань».
      const side = tz >= 0 ? 1 : 0.42 + 0.22 * depth01;
      const form = (0.34 + 0.30 * Math.pow(depth01, 1.2))
        * (0.70 + 0.30 * key)
        * (0.82 + 0.68 * edge * edge * edge);
      const s = (form + 0.28 * rim) * side;
      return { depth01, light: s, shade: s > 1 ? 1 : s };
    }

    // ── Рисование ────────────────────────────────────────────────────────

    _draw() {
      const ctx = this.ctx;
      if (!ctx || this.w < 2 || this.h < 2) return;
      const still = this._still();
      const t = still ? 1.15 : this.phase;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;

      const half = Math.min(this.w, this.h) / 2;
      // Ореол не должен доходить до края холста: иначе в приложении видна квадратная кромка.
      // Градиенты гаснут в ноль до края (0.94 полустороны), а вершины/точки/пояс ограничены
      // отдельным пределом bodyLimit. Клип по кругу не нужен и не даёт лишней кромки.
      const bodyLimit = half - 3;
      const R0 = this._radius() * (1 + 0.04 * this.flash);
      // Дрожь ошибки — единицы пикселей, быстро затухает; центр в покое не смещается.
      const shakeAmp = still ? 0 : this.shake * R0 * 0.015;
      const cx = this.w / 2 + Math.sin(this.shakePhase) * shakeAmp;
      const cy = this.h / 2 + Math.cos(this.shakePhase * 1.37) * shakeAmp * 0.5;

      this._drawHalo(ctx, cx, cy, R0, half);
      if (this.variant === 'wire') this._drawWire(ctx, t, cx, cy, R0, bodyLimit);
      else this._drawNox(ctx, t, cx, cy, R0, bodyLimit);

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // Сдержанный ореол: 14 % в покое, до 22 % в работе. Не неон.
    // Градиент гаснет в ноль заметно раньше края холста (0.94 полустороны), поэтому
    // кромка canvas не видна ни на тёмной, ни на светлой панели.
    _drawHalo(ctx, cx, cy, R, clipR) {
      const strength = this.mix.halo;
      if (strength <= 0.004) return;
      const half = Math.min(this.w, this.h) / 2;
      const outer = Math.min(clipR, half * 0.94);
      const inner = Math.min(R * 0.80, outer * 0.82);
      const peak = Math.min(R * 0.98, outer * 0.88);
      if (outer - inner < 2) return;
      const mid = clamp01((peak - inner) / (outer - inner));
      const a = strength * (this.variant === 'wire' ? 0.90 : 0.72);
      const c = this.col.line;
      const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
      g.addColorStop(0, rgba(c, 0));
      g.addColorStop(mid * 0.6, rgba(c, a * 0.55));
      g.addColorStop(mid, rgba(c, a));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, outer, 0, TAU);
      ctx.fill();
    }

    // ── Вид 'wire' ───────────────────────────────────────────────────────

    _projectWire(t, cx, cy, R, limit) {
      const G = this.wire;
      const base = G.base;
      const out = G.pts;
      const amp = (this.mix.deform + this.kick * 0.03) * WIRE_DEFORM_GAIN;
      for (let i = 0; i < out.length; i += 3) {
        const x = base[i], y = base[i + 1], z = base[i + 2];
        const d = this._deformShape(x, y, z, t) * amp + this._extraDeform(x, y, z, t);
        const r = 1 + d;
        const px = x * r, py = y * r, pz = z * r;
        const ty = py * COS_T - pz * SIN_T;
        const tz = py * SIN_T + pz * COS_T;
        const persp = 1 + 0.03 * tz;
        let sx = cx + px * R * persp;
        let sy = cy - ty * R * persp;
        // Вершины (деформация + перспектива + дрожь) не выходят за холст: край не режется.
        // Проверка именно по радиусу, а не по осям: иначе угол проходит мимо предела.
        const dx = sx - cx, dy = sy - cy;
        const dd = dx * dx + dy * dy;
        if (dd > limit * limit) {
          const k = limit / Math.sqrt(dd);
          sx = cx + dx * k;
          sy = cy + dy * k;
        }
        out[i] = sx;
        out[i + 1] = sy;
        const sh = this._wireShade(px, ty, tz);
        out[i + 2] = sh.shade;
      }
      // Штрихи раскладываем по 12 корзинам яркости: 12 заливок на кадр вместо 7 тысяч.
      const segs = G.segs;
      const segBucket = G.segBucket;
      for (let s = 0; s < segs.length; s += 2) {
        const a = out[segs[s] * 3 + 2];
        const b = out[segs[s + 1] * 3 + 2];
        let bucket = (((a + b) * 0.5 * WIRE_SHADES) | 0);
        if (bucket < 0) bucket = 0;
        else if (bucket >= WIRE_SHADES) bucket = WIRE_SHADES - 1;
        segBucket[s >> 1] = bucket;
      }
    }

    _drawWire(ctx, t, cx, cy, R, limit) {
      this._projectWire(t, cx, cy, R, limit);
      const G = this.wire;
      const out = G.pts;
      const segs = G.segs;
      const segBucket = G.segBucket;
      const u = Math.max(0.7, R / 127.4);
      const bright = this.mix.bright * (1 + this.flash * 0.5);
      const line = this.col.line, lo = this.col.lo, hi = this.col.hi;

      // Тёмная основа полой сферы: в референсе ячейки темнее панели и с синевой.
      // Поверх лежит сетка; ближе к краю основа чуть светлее — объём, а не плоский круг.
      const bodyLimit = Math.min(R * 1.02, Math.min(this.w, this.h) / 2 - 3);
      const fill = ctx.createRadialGradient(cx, cy, R * 0.08, cx, cy, bodyLimit);
      fill.addColorStop(0, rgba(mixRgb([6, 14, 22], lo, 0.98), 0.92));
      fill.addColorStop(0.72, rgba(mixRgb([5, 12, 20], lo, 0.92), 0.94));
      fill.addColorStop(1, rgba(mixRgb([13, 32, 46], lo, 0.94), 0.82));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, cy, bodyLimit, 0, TAU);
      ctx.fill();

      // Дымка внутри — свет дальней сетки в референсе не исчезает в черноту.
      const hazeR = Math.min(R, Math.min(this.w, this.h) / 2 - 3);
      const haze = ctx.createRadialGradient(cx, cy, 0, cx, cy, hazeR);
      haze.addColorStop(0, rgba(line, 0.090));
      haze.addColorStop(0.7, rgba(line, 0.070));
      haze.addColorStop(1, rgba(line, 0.035));
      ctx.fillStyle = haze;
      ctx.beginPath();
      ctx.arc(cx, cy, hazeR, 0, TAU);
      ctx.fill();

      // Цвета корзин: дальняя сторона #1A3D4F, ближняя — около #2E9AC1, у силуэта — к #4DBCE8.
      // #4DBCE8 — потолок для основной сетки; почти белый оставлен поясу.
      const cols = [];
      const alphas = [];
      const widths = [];
      for (let b = 0; b < WIRE_SHADES; b++) {
        const s = b / (WIRE_SHADES - 1);
        let c = s < 0.82
          ? mixRgb(lo, line, (s / 0.82) * 0.92)
          : mixRgb(line, hi, ((s - 0.82) / 0.18) * 0.55);
        // «Ярче» в работе — сдвиг к белому, а не только умножение каналов.
        if (bright > 1) c = mixRgb(c, [230, 249, 255], Math.min(0.40, (bright - 1) * 0.35));
        cols.push(c);
        alphas.push(Math.min(1, (0.28 + 0.50 * s) * (0.94 + 0.06 * Math.min(bright, 1.5))));
        widths.push((0.68 + 0.22 * s) * u);
      }

      for (let b = 0; b < WIRE_SHADES; b++) {
        let has = false;
        ctx.beginPath();
        for (let i = 0; i < segBucket.length; i++) {
          if (segBucket[i] !== b) continue;
          const a = segs[i * 2] * 3;
          const c = segs[i * 2 + 1] * 3;
          ctx.moveTo(out[a], out[a + 1]);
          ctx.lineTo(out[c], out[c + 1]);
          has = true;
        }
        if (!has) continue;
        ctx.strokeStyle = rgba(cols[b], alphas[b]);
        ctx.lineWidth = widths[b];
        ctx.stroke();
      }

      // Мягкое свечение только у ближних линий: в референсе линии не «царапины», а светятся.
      // Дальние корзины не светим — экономим растеризацию широких штрихов и не засвечиваем фон.
      ctx.globalCompositeOperation = 'lighter';
      for (let b = WIRE_SHADES - 2; b < WIRE_SHADES; b++) {
        let has = false;
        ctx.beginPath();
        for (let i = 0; i < segBucket.length; i++) {
          if (segBucket[i] !== b) continue;
          const a = segs[i * 2] * 3;
          const c = segs[i * 2 + 1] * 3;
          ctx.moveTo(out[a], out[a + 1]);
          ctx.lineTo(out[c], out[c + 1]);
          has = true;
        }
        if (!has) continue;
        ctx.strokeStyle = rgba(cols[b], 0.012 + 0.024 * (b / (WIRE_SHADES - 1)));
        ctx.lineWidth = widths[b] * 2.6;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Пояс светится шире, чем линия: его свечение не должно доходить до кромки холста.
      this._drawBelt(ctx, t, cx, cy, R, u, Math.max(2, limit - 3.5 * u));
    }

    // Светлая линия-пояс: в референсе это выделенная линия сетки, а не отдельный обод.
    _drawBelt(ctx, t, cx, cy, R, u, limit) {
      const B = this.wire;
      const base = B.belt;
      const out = B.beltOut;
      const amp = (this.mix.deform + this.kick * 0.03) * WIRE_DEFORM_GAIN * 1.1;
      for (let i = 0; i < out.length; i += 3) {
        const x = base[i], y = base[i + 1], z = base[i + 2];
        const d = this._deformShape(x, y, z, t) * amp + this._extraDeform(x, y, z, t);
        const r = 1 + d;
        const px = x * r, py = y * r, pz = z * r;
        const ty = py * COS_T - pz * SIN_T;
        const tz = py * SIN_T + pz * COS_T;
        const persp = 1 + 0.03 * tz;
        let sx = cx + px * R * persp;
        let sy = cy - ty * R * persp;
        const dx = sx - cx, dy = sy - cy;
        const dd = dx * dx + dy * dy;
        if (dd > limit * limit) {
          const k = limit / Math.sqrt(dd);
          sx = cx + dx * k;
          sy = cy + dy * k;
        }
        out[i] = sx;
        out[i + 1] = sy;
        out[i + 2] = tz;
      }
      const n = out.length / 3;
      const pulse = (0.80 + 0.20 * (0.5 + 0.5 * Math.sin(this.beltPhase))) * this.mix.belt;
      const amt = clamp01(pulse + this.kick * 0.35);
      if (amt <= 0.02) return;
      const hi = this.col.hi;

      // Задняя половина пояса за сферой — тусклая, передняя — почти белая.
      for (let pass = 0; pass < 2; pass++) {
        const front = pass === 1;
        ctx.beginPath();
        let has = false;
        for (let i = 0; i < n - 1; i++) {
          const za = out[i * 3 + 2];
          const zb = out[(i + 1) * 3 + 2];
          if (((za + zb) * 0.5 >= 0) !== front) continue;
          ctx.moveTo(out[i * 3], out[i * 3 + 1]);
          ctx.lineTo(out[(i + 1) * 3], out[(i + 1) * 3 + 1]);
          has = true;
        }
        if (!has) continue;
        ctx.strokeStyle = rgba(hi, front ? 0.42 * amt : 0.16 * amt);
        ctx.lineWidth = (front ? 1.5 : 1.0) * u;
        ctx.stroke();
      }

      // Свечение пояса: складываем свет, чтобы полоса читалась на тёмной панели.
      ctx.globalCompositeOperation = 'lighter';
      for (let pass = 0; pass < 2; pass++) {
        const front = pass === 1;
        ctx.beginPath();
        let has = false;
        for (let i = 0; i < n - 1; i++) {
          const za = out[i * 3 + 2];
          const zb = out[(i + 1) * 3 + 2];
          if (((za + zb) * 0.5 >= 0) !== front) continue;
          ctx.moveTo(out[i * 3], out[i * 3 + 1]);
          ctx.lineTo(out[(i + 1) * 3], out[(i + 1) * 3 + 1]);
          has = true;
        }
        if (!has) continue;
        ctx.strokeStyle = rgba(hi, (front ? 0.075 : 0.03) * amt);
        ctx.lineWidth = (front ? 6.0 : 4.4) * u;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Вид 'nox' ────────────────────────────────────────────────────────

    _drawNox(ctx, t, cx, cy, R, limit) {
      const mix = this.mix;
      const col = this.col;
      const v = this.voice;
      const kick = this.kick;
      const bright = mix.bright * (1 + this.flash * 0.6);

      // Ядро: объёмное свечение #E0F4FF → #3AAAD6 → #1A5A7B, дышит и откликается на голос.
      const corePulse = 1 + 0.03 * Math.sin(this.breath) + 0.05 * v + 0.06 * kick;
      const Rc = R * CORE_RATIO * corePulse;
      const cg = mix.coreGlow;
      // Центр ядра — светлый cyan, а не чистый белый: объём, а не пересвет.
      const coreHot = mixRgb(col.coreHi, col.coreMid, 0.30);
      const coreWarm = mixRgb(col.coreHi, col.coreMid, 0.55);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Rc * 1.62);
      g.addColorStop(0, rgba(coreHot, Math.min(1, 0.60 * cg)));
      g.addColorStop(0.32, rgba(coreWarm, Math.min(1, 0.44 * cg)));
      g.addColorStop(0.58, rgba(col.coreMid, Math.min(1, 0.30 * cg)));
      g.addColorStop(0.83, rgba(col.coreLo, 0.13 * cg));
      g.addColorStop(1, rgba(col.coreLo, 0));
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, Rc * 1.62, 0, TAU);
      ctx.fill();

      this._drawCorePoints(ctx, cx, cy, R, corePulse, bright);
      this._drawShell(ctx, t, cx, cy, R, bright, limit);

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    _drawCorePoints(ctx, cx, cy, R, corePulse, bright) {
      const base = this.nox.core;
      const rot = this.rotY * 0.55;
      const cosY = Math.cos(rot), sinY = Math.sin(rot);
      const col = this.col;
      const u = Math.max(0.7, R / 127.4);
      for (let pass = 0; pass < 2; pass++) {
        const front = pass === 1;
        ctx.beginPath();
        let has = false;
        for (let i = 0; i < NOX_CORE; i++) {
          const p = i * 3;
          const x = base[p], y = base[p + 1], z = base[p + 2];
          const x1 = x * cosY + z * sinY;
          const z1 = -x * sinY + z * cosY;
          const y1 = y * TILT_CORE * COS_T - z1 * TILT_CORE * SIN_T;
          const z2 = y * TILT_CORE * SIN_T + z1 * TILT_CORE * COS_T;
          if ((z2 >= 0) !== front) continue;
          const persp = 1 + 0.06 * z2;
          const sx = cx + x1 * R * corePulse * persp;
          const sy = cy - y1 * R * corePulse * persp;
          const rr = (0.42 + 0.50 * (0.5 + 0.5 * Math.sin(i * 1.7 + 0.4))) * u;
          ctx.moveTo(sx + rr, sy);
          ctx.arc(sx, sy, rr, 0, TAU);
          has = true;
        }
        if (!has) continue;
        const alpha = front ? 0.48 : 0.16;
        // Точки ядра чуть холоднее белого: объём, а не пересвеченный центр.
        const cc = mixRgb(col.coreHi, col.coreMid, 0.38);
        ctx.fillStyle = rgba(cc, Math.min(1, alpha * bright));
        ctx.fill();
      }
    }

    _drawShell(ctx, t, cx, cy, R, bright, limit) {
      const G = this.nox;
      const base = G.shell;
      const bx = G.sx, by = G.sy, bsz = G.ss;
      const buckets = G.buckets;
      const counts = G.bucketCount;
      for (let b = 0; b < NOX_BUCKETS; b++) counts[b] = 0;
      const rot = this.rotY;
      const cosY = Math.cos(rot), sinY = Math.sin(rot);
      const amp = this.mix.deform + this.kick * 0.03;
      const u = Math.max(0.7, R / 127.4);
      const waves = this.waves;
      const tf = this.rt;
      const v = this.voice;
      // Точки и их свечение не должны касаться края холста: оставляем запас под спрайт.
      const cl = Math.max(4, limit - 4);

      for (let i = 0, p = 0; i < NOX_SHELL; i++, p += 3) {
        const x = base[p], y = base[p + 1], z = base[p + 2];
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        let d = this._deformShape(x1, y, z1, t) * amp + this._extraDeform(x1, y, z1, t);
        let boost = 0;
        for (let w = 0; w < waves.length; w++) {
          const e = (tf - waves[w].t0) / 0.6;
          if (e < 0 || e > 1) continue;
          const frontPos = 0.15 + 1.90 * (1 - Math.pow(1 - e, 2));
          const g = (1 - frontPos) / 0.18;
          const bump = Math.exp(-g * g) * Math.pow(1 - e, 1.5) * waves[w].amp;
          d += bump * 0.08;
          boost += bump * 0.8;
        }
        const r = 1 + d;
        const px = x1 * r;
        const ty = y * r * COS_T - z1 * r * SIN_T;
        const tz = y * r * SIN_T + z1 * r * COS_T;
        const persp = 1 + 0.045 * tz;
        let sx = cx + px * R * persp;
        let sy = cy - ty * R * persp;
        const dx = sx - cx, dy = sy - cy;
        const dd = dx * dx + dy * dy;
        if (dd > cl * cl) {
          const k = cl / Math.sqrt(dd);
          sx = cx + dx * k;
          sy = cy + dy * k;
        }
        bx[i] = sx;
        by[i] = sy;
        const sh = this._shade(px, ty, tz);
        let s = sh.depth01 * sh.light + boost * 0.5 + v * 0.18;
        if (s < 0) s = 0;
        else if (s > 1) s = 1;
        let bucket = (s * NOX_BUCKETS) | 0;
        if (bucket >= NOX_BUCKETS) bucket = NOX_BUCKETS - 1;
        buckets[bucket][counts[bucket]++] = i;
        // Диаметр спрайта 2.8–4.4 css px: ядро точки 1.2–1.8 px, остальное — мягкое свечение.
        bsz[i] = (2.8 + 1.6 * sh.depth01) * u * (0.9 + 0.2 * sh.light) * this.mix.pointScale;
      }

      const spr = this._pointSprites(bright);
      for (let b = 0; b < NOX_BUCKETS; b++) {
        const n = counts[b];
        if (!n) continue;
        ctx.globalAlpha = spr.alpha[b];
        const img = spr.list[b];
        const list = buckets[b];
        for (let j = 0; j < n; j++) {
          const i = list[j];
          const s = bsz[i];
          ctx.drawImage(img, bx[i] - s / 2, by[i] - s / 2, s, s);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Спрайты точек по глубине: одна текстура на корзину, перестраиваются только при смене цвета/DPR.
    _pointSprites(bright) {
      const px = Math.max(8, Math.round(12 * this.dpr));
      const pb = this.col.pLo, line = this.col.line, hi = this.col.hi;
      const keyParts = [];
      const row = [];
      for (let b = 0; b < NOX_BUCKETS; b++) {
        const d = b / (NOX_BUCKETS - 1);
        const c = d < 0.55 ? mixRgb(pb, line, d / 0.55) : mixRgb(line, hi, (d - 0.55) / 0.45);
        const cc = [Math.min(255, c[0] * bright), Math.min(255, c[1] * bright), Math.min(255, c[2] * bright)];
        const a = Math.min(1, (0.22 + 0.78 * Math.pow(d, 1.3)) * (0.82 + 0.22 * bright));
        row.push({ c: cc, a });
        keyParts.push((cc[0] | 0), (cc[1] | 0), (cc[2] | 0), Math.round(a * 100));
      }
      const key = keyParts.join(',') + '|' + px;
      if (this._spr && this._spr.key === key) return this._spr;
      if (!this._sprCanvas || this._sprCanvas[0].width !== px) {
        this._sprCanvas = [];
        for (let b = 0; b < NOX_BUCKETS; b++) {
          const cv = document.createElement('canvas');
          cv.width = px;
          cv.height = px;
          this._sprCanvas.push(cv);
        }
      }
      const list = [];
      const alpha = [];
      const h = px / 2;
      for (let b = 0; b < NOX_BUCKETS; b++) {
        const cv = this._sprCanvas[b];
        const g2 = cv.getContext('2d');
        g2.setTransform(1, 0, 0, 1, 0, 0);
        g2.clearRect(0, 0, px, px);
        const c = row[b].c;
        const gr = g2.createRadialGradient(h, h, 0, h, h, h);
        gr.addColorStop(0, rgba(c, 1));
        gr.addColorStop(0.30, rgba(c, 0.94));
        gr.addColorStop(0.58, rgba(c, 0.26));
        gr.addColorStop(0.82, rgba(c, 0.04));
        gr.addColorStop(1, rgba(c, 0));
        g2.fillStyle = gr;
        g2.fillRect(0, 0, px, px);
        list.push(cv);
        alpha.push(row[b].a);
      }
      this._spr = { key, dpr: this.dpr, list, alpha };
      return this._spr;
    }
  }

  // false — уважать системное «уменьшить движение»; true — рисовать движение даже при нём.
  // html[data-motion="off"] и setAnimated(false) останавливают всегда: это явный выбор продукта.
  NoxOrb.ignoreSystemMotion = false;
  NoxOrb.STATES = STATES.slice();
  NoxOrb.ALIAS = { ...ALIAS };

  window.NoxOrb = NoxOrb;
})();
