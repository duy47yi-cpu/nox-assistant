/* Джарвис — шар состояния: сфера из светящихся точек на canvas 2D, без колец.
 *
 * Состояния (ключи): idle, listening, thinking, searching, speaking, acting,
 * verifying, waiting_approval, success, cancelled, error. Планирование — это thinking,
 * «предупреждение» — waiting_approval, успешный итог — success, остановка — cancelled.
 *   idle              медленное дыхание (~4 с), точки едва мерцают, мягкое свечение;
 *   listening         свечение ярче, точки собираются к центру и расходятся (2 с), редкие вспышки;
 *   thinking          быстрее вращение, сфера плотнее, по поверхности бежит светлая дуга-орбита;
 *   searching         по сфере слева направо ходит сканирующий луч, точки под ним подсвечиваются;
 *   acting            импульс: точки разлетаются волной наружу и собираются обратно;
 *   verifying         проверка результата: спокойная дуга и ровное свечение, без импульса;
 *   speaking          на каждый pulse() из центра расходится кольцевая волна (0,6 с);
 *   waiting_approval  янтарный, замирает;
 *   success           зелёный итог: спокойное дыхание, точки чуть ярче обычного;
 *   cancelled         остановка: нейтральный серый, замирает без тряски и красного;
 *   error             красный, затем замирает, без тряски.
 * Другие виды шара лежат в orb-variants.js и выбираются через setVariant().
 *
 * Переходы плавные: у каждого состояния свой вес 0..1, веса и цвет сходятся
 * к цели за ~400 мс. Один requestAnimationFrame на шар, пауза при скрытом окне
 * или холсте вне экрана, dt ограничен. «Уменьшить движение» в системе и
 * setAnimated(false) дают статичную сферу с сохранением смены состояния:
 * статус остаётся, движение уходит.
 *
 * Доступность: главный шар получает role="img" и подпись состояния на обёртке
 * (#orbWrap), поэтому состояние читается и без зрения. Сам холст остаётся
 * декоративным (aria-hidden в разметке).
 *
 *   const orb = new JarvisOrb(canvas, { density: 1 });
 *   orb.setState('thinking'); orb.pulse(); orb.setAnimated(false); orb.destroy();
 */
(() => {
  'use strict';

  const STATES = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'acting', 'verifying', 'waiting_approval', 'success', 'cancelled', 'error'];
  // Синонимы из событий ядра: в UI они не отдельные состояния, но шар должен их понимать.
  const ALIAS = { planning: 'thinking', warning: 'waiting_approval', succeeded: 'success' };
  const TOKEN = {
    idle: '--orb-idle',
    listening: '--orb-listening',
    thinking: '--orb-thinking',
    searching: '--orb-searching',
    speaking: '--orb-speaking',
    acting: '--orb-acting',
    verifying: '--orb-verifying',
    waiting_approval: '--orb-waiting',
    success: '--orb-success',
    cancelled: '--orb-cancelled',
    error: '--orb-error',
  };
  // У очереди, отмены, итога и ошибки цвет берётся из токенов темы, у остальных — из --hue.
  const STATE_VAR = { waiting_approval: '--warn', error: '--err', success: '--ok', cancelled: '--text-2' };
  const FALLBACK = {
    idle: [63, 200, 245],
    listening: [126, 227, 255],
    thinking: [138, 180, 255],
    searching: [79, 240, 210],
    speaking: [100, 214, 255],
    acting: [63, 212, 255],
    verifying: [138, 180, 255],
    waiting_approval: [255, 181, 71],
    success: [110, 239, 168],
    cancelled: [155, 174, 192],
    error: [255, 95, 109],
  };
  // Подписи состояний для доступного описания. Если shared.js загружен, его PHRASE важнее.
  const PHRASE = {
    idle: 'Готов',
    listening: 'Слушаю',
    thinking: 'Думаю',
    searching: 'Ищу',
    speaking: 'Отвечаю',
    acting: 'Выполняю',
    verifying: 'Проверяю',
    waiting_approval: 'Нужно ваше решение',
    success: 'Готово',
    cancelled: 'Остановлено',
    error: 'Не получилось',
  };
  const phraseOf = (state) => {
    const ui = typeof window !== 'undefined' && window.JarvisUI;
    return (ui && ui.PHRASE && ui.PHRASE[state]) || PHRASE[state] || PHRASE.idle;
  };
  // spin — оборотов в секунду; period — длина вдоха-выдоха, с; amp — глубина дыхания;
  // radius — размер сферы; twinkle — частота мерцания; flicker — сила мерцания; glow — свечение.
  const MOTION = {
    idle:             { spin: 0.026, period: 4.5, amp: 0.060, radius: 1.00, twinkle: 0.6, flicker: 0.16, glow: 0.85 },
    listening:        { spin: 0.032, period: 2.0, amp: 0.018, radius: 1.00, twinkle: 1.1, flicker: 0.22, glow: 1.30 },
    thinking:         { spin: 0.110, period: 2.0, amp: 0.022, radius: 0.90, twinkle: 2.4, flicker: 0.32, glow: 1.15 },
    searching:        { spin: 0.045, period: 2.4, amp: 0.020, radius: 0.96, twinkle: 1.0, flicker: 0.22, glow: 1.10 },
    speaking:         { spin: 0.042, period: 2.6, amp: 0.022, radius: 1.00, twinkle: 1.3, flicker: 0.22, glow: 1.20 },
    acting:           { spin: 0.060, period: 2.2, amp: 0.020, radius: 1.00, twinkle: 1.6, flicker: 0.28, glow: 1.20 },
    verifying:        { spin: 0.080, period: 2.4, amp: 0.020, radius: 0.93, twinkle: 1.8, flicker: 0.26, glow: 1.08 },
    waiting_approval: { spin: 0, period: 6.0, amp: 0, radius: 0.97, twinkle: 0, flicker: 0, glow: 0.55 },
    success:          { spin: 0.030, period: 5.2, amp: 0.050, radius: 1.00, twinkle: 0.5, flicker: 0.13, glow: 1.15 },
    cancelled:        { spin: 0, period: 6.0, amp: 0, radius: 0.97, twinkle: 0, flicker: 0, glow: 0.55 },
    error:            { spin: 0, period: 3.4, amp: 0, radius: 0.95, twinkle: 0, flicker: 0, glow: 0.95 },
  };
  const FRAME_MS = 30;      // потолок ~30 кадров в секунду (rAF 60 Гц даёт шаг 33 мс)
  const FREEZE_AFTER = 1;   // через столько секунд ожидание, отмена и ошибка перестают рисоваться и кадры останавливаются
  const SPHERE_HOLE = 0.44; // наибольший видимый радиус сферы в долях стороны холста
  const KEYS = Object.keys(MOTION.idle);
  const TAU = Math.PI * 2;
  const WAVE_LIFE = 0.6;   // жизнь кольцевой волны, с
  const SETTLE = 0.13;     // постоянная времени перехода, с (~400 мс до 95 %)

  const reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  // Системное «уменьшить движение» шар уважает всегда: при включённых «Анимациях» main.js просит браузер
  // считать движение разрешённым, поэтому выключенные эффекты Windows сами по себе шар не останавливают.
  const sysReduced = () => Boolean(reduceQuery && reduceQuery.matches);

  function parseColor(str, fallback) {
    const s = String(str || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) return m[1].split(',').slice(0, 3).map((v) => parseFloat(v) || 0);
    return fallback.slice();
  }

  const lerp = (a, b, k) => a + (b - a) * k;
  // Поворот оттенка, как CSS hue-rotate: из одного цвета темы получается цветовая гамма шара.
  function hueRotate(col, deg) {
    const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    const m = [
      0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
      0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
      0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072,
    ];
    return [0, 1, 2].map((i) => Math.max(0, Math.min(255, col[0] * m[i * 3] + col[1] * m[i * 3 + 1] + col[2] * m[i * 3 + 2])));
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (v) => v * v * (3 - 2 * v);
  const rgba = (r, g, b, a) => `rgba(${r | 0},${g | 0},${b | 0},${clamp01(a).toFixed(3)})`;

  // Только числовые сигналы: текст поручения не хранится. Время общее с кадром шара.
  class OrbLife {
    constructor() { this.reset(); }
    reset() {
      this.focused = false; this.hasText = false; this.caret = 0;
      this.energy = 0; this.tap = 0; this.inhale = 0; this.recoil = 0;
      this.send = 0; this.attention = 0; this.age = 10; this.direction = 1;
    }
    edit(kind, caret = 0) {
      this.energy = Math.min(1, this.energy + (this.age < 0.25 ? 0.22 : 0.1));
      this.age = 0;
      this.caret = Math.max(-1, Math.min(1, caret));
      this.direction *= -1;
      if (kind === 'delete') this.recoil = 1;
      else if (kind === 'space') this.inhale = 1;
      else this.tap = kind === 'paste' ? 0.35 : 1;
    }
    step(dt) {
      this.age += dt;
      this.energy *= Math.exp(-dt / 0.45);
      for (const key of ['tap', 'inhale', 'recoil', 'send']) this[key] *= Math.exp(-dt / (key === 'send' ? 0.24 : 0.18));
      const target = this.focused ? (this.hasText ? 1 : 0.35) : 0;
      this.attention = lerp(this.attention, target, 1 - Math.exp(-dt / 0.22));
    }
  }

  class JarvisOrb {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.density = opts.density || 1;
      this.variant = opts.variant || 'sphere';
      this.clock = 0;    // часы вида: идут быстрее в работе, стоят в ожидании и при ошибке
      this.life = new OrbLife();
      this.kick = 0;     // толчок от порции ответа, быстро затухает
      this.state = 'idle';
      this.stateAt = 0;
      this.animated = true;
      this.visible = true;
      this.raf = 0;
      this.t = 0;
      this.ay = 0;       // угол вращения (копится, поэтому смена скорости без рывка)
      this.breath = 0;   // фаза дыхания
      this.gather = 0;   // фаза «вдоха» при прислушивании
      this.actT = 0;     // время импульса действия
      this.scanT = 0;    // время сканирующего луча
      this.arcT = 0;     // положение дуги-орбиты
      this.steps = [];   // статусы шагов поручения для кольца с бусинами
      this.stepsAmt = 0; // видимость кольца шагов 0..1
      this.last = 0;
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.colors = {};
      this.points = [];
      this.waves = [];
      this.lastWave = -10;
      this.weights = {};
      for (const s of STATES) this.weights[s] = s === 'idle' ? 1 : 0;
      this.mix = { ...MOTION.idle };

      this._frame = this._frame.bind(this);
      this._onVisibility = () => this._sync();
      this._onReduce = () => this._sync();

      this._readColors();
      this.color = this.colors.idle.slice();

      this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._resize()) : null;
      if (this.ro) this.ro.observe(canvas);
      this.io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
          this.visible = entries.some((e) => e.isIntersecting);
          this._sync();
        })
        : null;
      if (this.io) this.io.observe(canvas);

      document.addEventListener('visibilitychange', this._onVisibility);
      if (reduceQuery && reduceQuery.addEventListener) reduceQuery.addEventListener('change', this._onReduce);

      this._resize();
      this._sync();
      this._describe();
    }

    setVariant(id) {
      this.variant = id;
      this._publishHole();
      this._draw();
    }

    // Контурные линии (contour.js) вырезают под шаром ровно этот радиус.
    _publishHole() {
      const v = window.JarvisOrbVariants && window.JarvisOrbVariants[this.variant];
      this.canvas.dataset.hole = String((v ? v.hole : SPHERE_HOLE) * Math.min(this.w, this.h));
    }

    // Доступное описание состояния: только у главного шара (обёртка .orb-wrap). Холст декоративный.
    _describe() {
      const wrap = this.canvas.closest && this.canvas.closest('.orb-wrap');
      if (!wrap || typeof wrap.setAttribute !== 'function') return;
      if (!wrap.getAttribute('role')) wrap.setAttribute('role', 'img');
      wrap.setAttribute('aria-label', 'Шар состояния: ' + phraseOf(this.state));
    }

    _frozen() {
      return (this.state === 'waiting_approval' || this.state === 'cancelled' || this.state === 'error') && this.t - this.stateAt > FREEZE_AFTER;
    }

    setState(state) {
      const raw = String(state || '');
      const next = STATES.includes(raw) ? raw : (ALIAS[raw] || 'idle');
      if (next === this.state) { this._describe(); return; }
      this.state = next;
      if (next !== 'idle' && next !== 'listening') {
        // Не проигрывать старый набор после долгого ожидания подтверждения.
        const send = this.life.send;
        this.life.reset();
        this.life.send = next === 'thinking' ? send : 0;
      }
      this.stateAt = this.t;
      if (next === 'acting') this.actT = 0;
      if (next === 'searching') this.scanT = 0;
      if (next === 'speaking') this.pulse(0.8);
      if (!this.animated || sysReduced()) this._snap();
      // Ожидание и ошибка замирают и останавливают кадры; возврат из них снова запускает цикл.
      this._sync();
      this._draw();
      this._describe();
    }

    // Жесты не меняют состояние: работа, подтверждение и ошибка всегда важнее набора.
    setComposer(focused, hasText, caret = 0) {
      this.life.focused = Boolean(focused);
      this.life.hasText = Boolean(hasText);
      this.life.caret = Math.max(-1, Math.min(1, caret));
    }

    gesture(kind, caret = 0) {
      if (!this.animated || sysReduced()) return;
      if (kind === 'send') {
        if (this.state !== 'idle' && this.state !== 'listening') return;
        this.life.reset();
        this.life.send = 1;
      } else {
        if (this.state !== 'idle' && this.state !== 'listening') return;
        this.life.edit(kind, caret);
      }
    }

    _lifePose(still) {
      const L = this.life;
      const rest = this.state === 'idle' || this.state === 'listening';
      const gain = still || sysReduced() ? 0 : rest ? 1 : 0;
      return {
        x: gain * (L.caret * L.attention * 0.025 + L.direction * L.tap * 0.024),
        y: gain * (L.attention * 0.012 - L.inhale * 0.028 + L.recoil * 0.022) - (still ? 0 : L.send * 0.03),
        stretch: gain * (0.08 * L.inhale - 0.095 * L.recoil + 0.035 * L.tap) - (still ? 0 : 0.09 * L.send),
        tilt: gain * (L.caret * L.attention * 0.22 + L.direction * L.tap * 0.16),
        energy: gain * L.energy,
      };
    }

    // Кольцевая волна из центра: вызывается на каждую порцию текста ответа.
    pulse(strength = 1) {
      if (!this.animated) return;
      this.kick = Math.max(this.kick, Math.min(1, strength));
      if (this.t - this.lastWave < 0.09) return; // частые дельты сливаются в одну волну
      this.lastWave = this.t;
      this.waves.push({ t0: this.t, amp: Math.max(0.2, Math.min(1, strength)) });
      if (this.waves.length > 8) this.waves.shift();
    }

    setAnimated(on) {
      this.animated = Boolean(on);
      if (!this.animated) { this.waves.length = 0; this.kick = 0; this.life.reset(); this._snap(); }
      this._sync();
      this._draw();
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.ro) this.ro.disconnect();
      if (this.io) this.io.disconnect();
      document.removeEventListener('visibilitychange', this._onVisibility);
      if (reduceQuery && reduceQuery.removeEventListener) reduceQuery.removeEventListener('change', this._onReduce);
    }

    _snap() {
      for (const s of STATES) this.weights[s] = s === this.state ? 1 : 0;
      this.mix = { ...MOTION[this.state] };
      this.color = (this.colors[this.state] || this.color).slice();
      this.stepsAmt = this.steps.length ? 1 : 0;
    }

    _speed() {
      return sysReduced() ? 0.35 : 1;
    }

    _readColors() {
      // Образец темы читает цвета своей темы, а не цвета окна.
      const css = getComputedStyle(this.canvas.closest('[data-theme]') || document.documentElement);
      // Цвет главного окна — --hue; у мини-окна его нет, там остаются токены --orb-*.
      const hue = css.getPropertyValue('--hue').trim();
      const warn = css.getPropertyValue('--warn').trim();
      const err = css.getPropertyValue('--err').trim();
      const ok = css.getPropertyValue('--ok').trim();
      for (const s of STATES) {
        const own = STATE_VAR[s] === '--warn' ? warn : STATE_VAR[s] === '--err' ? err : STATE_VAR[s] === '--ok' ? ok : hue;
        this.colors[s] = parseColor(own || css.getPropertyValue(TOKEN[s]), FALLBACK[s]);
      }
      this.stateCol = {
        ok: parseColor(ok, [110, 239, 168]),
        warn: parseColor(warn, FALLBACK.waiting_approval),
        err: parseColor(err, FALLBACK.error),
        dim: parseColor(css.getPropertyValue('--text-2'), [185, 201, 215]),
      };
      const bg = parseColor(css.getPropertyValue('--bg'), [0, 0, 0]);
      this.core = bg.map((v, i) => lerp(v, this.colors.idle[i], 0.14));
      this.light = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11 > 128;
      if (this.color && this._frozen()) this.color = this.colors[this.state].slice();
    }

    _resize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (w === this.w && h === this.h && dpr === this.dpr) return;
      this.w = w; this.h = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this._publishHole();
      this._buildPoints();
      this._draw();
      this._sync();
    }

    // Точки по спирали Фибоначчи; число зависит от размера холста.
    _buildPoints() {
      const size = Math.min(this.w, this.h);
      const n = Math.round(Math.max(180, Math.min(1300, (size * size) / 130)) * this.density);
      const golden = Math.PI * (3 - Math.sqrt(5));
      const pts = new Array(n);
      for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const th = golden * i;
        pts[i] = {
          x: Math.cos(th) * r, y, z: Math.sin(th) * r,
          seed: Math.random() * TAU,
          rate: 0.6 + Math.random() * 0.8,
          size: 0.65 + Math.random() * 0.7,
          lift: 0.985 + Math.random() * 0.03,
          pair: 0,
        };
      }
      // Пары для мигания в ожидании решения: соседние по спирали точки.
      for (let i = 0; i < n; i++) pts[i].pair = pts[i & ~1].seed;
      this.points = pts;
      this.buf = {
        sx: new Float32Array(n), sy: new Float32Array(n), s: new Float32Array(n),
        a: new Float32Array(n), hi: new Float32Array(n), z: new Float32Array(n),
        r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n),
      };
    }

    _sync() {
      const reduced = sysReduced();
      if (reduced) { this.life.reset(); this.waves.length = 0; this.kick = 0; this._snap(); }
      const run = this.animated && !reduced && this.visible && !document.hidden && this.w > 1;
      if (run && !this.raf) {
        this.last = performance.now();
        this.raf = requestAnimationFrame(this._frame);
      } else if (!run && this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      if (!run) this._draw();
    }

    _frame(now) {
      // Ожидание решения и ошибка стоят на месте: последний кадр уже нарисован, кадры больше не нужны.
      // Любая смена состояния вернёт цикл через _sync().
      if (this._frozen()) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        return;
      }
      this.raf = requestAnimationFrame(this._frame);
      if (now - this.last < FRAME_MS) return;
      const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000)) * this._speed();
      this.last = now;
      this.t += dt;
      this.life.step(dt);

      const k = 1 - Math.exp(-dt / SETTLE);
      const target = this.colors[this.state] || this.color;
      for (let i = 0; i < 3; i++) this.color[i] = lerp(this.color[i], target[i], k);
      let sum = 0;
      for (const s of STATES) {
        this.weights[s] = lerp(this.weights[s], s === this.state ? 1 : 0, k);
        sum += this.weights[s];
      }
      for (const key of KEYS) {
        let v = 0;
        for (const s of STATES) v += MOTION[s][key] * this.weights[s];
        this.mix[key] = v / (sum || 1);
      }

      this.ay += dt * this.mix.spin * TAU;
      const typing = this.state === 'idle' || this.state === 'listening' ? this.life.energy : 0;
      this.breath += dt * TAU * (1 + typing * 1.4) / Math.max(0.6, this.mix.period);
      this.gather += dt * TAU / 2.0;
      this.actT += dt;
      this.scanT += dt;
      this.arcT += dt * (1.2 + 1.6 * this.weights.thinking);
      this.stepsAmt = lerp(this.stepsAmt, this.steps.length ? 1 : 0, 1 - Math.exp(-dt / 0.35));

      // Между порциями текста волны редкие.
      if (this.state === 'speaking' && this.t - this.lastWave > 1.5) this.pulse(0.45);
      this.waves = this.waves.filter((w) => this.t - w.t0 < WAVE_LIFE);

      this.kick *= Math.exp(-dt / 0.35);
      this.clock += dt * (1 + 2.6 * this._work()) * (1 - this.weights.waiting_approval - this.weights.cancelled - this.weights.error);

      this._draw();
    }

    // Шаги текущего поручения: список статусов (confirmed, running, pending, failed, ...). Пусто — кольцо уходит.
    setSteps(list) {
      this.steps = Array.isArray(list) ? list.slice(-6) : [];
      if (!this.animated || sysReduced()) this.stepsAmt = this.steps.length ? 1 : 0;
      this._draw();
    }

    // Точечное кольцо с бегущей кометой; front — половина перед шаром, остальное за ним.
    _ring(ctx, cx, cy, cfg, front, still) {
      const cr = Math.cos(cfg.roll), sr = Math.sin(cfg.roll), sp = Math.sin(cfg.psi), cp = Math.cos(cfg.psi);
      for (let i = 0; i < cfg.n; i++) {
        const th = (i / cfg.n) * TAU;
        const x = cfg.Rr * Math.cos(th), zr = cfg.Rr * Math.sin(th);
        const y = zr * sp, z = zr * cp;
        if ((z >= 0) !== front) continue;
        const d = still ? 9 : (((th - cfg.head) % TAU) + TAU) % TAU;
        const br = cfg.base + (d < 3.2 ? 1.6 * Math.exp(-d * 2.6) : 0);
        const a = Math.min(1, br) * cfg.alpha * (front ? 1 : 0.5);
        if (a < 0.03) continue;
        ctx.fillStyle = rgba(cfg.col[0], cfg.col[1], cfg.col[2], a);
        ctx.beginPath();
        ctx.arc(cx + x * cr - y * sr, cy + x * sr + y * cr, cfg.size * (0.7 + br * 0.8), 0, TAU);
        ctx.fill();
      }
    }

    // Бусины шагов на передней дуге кольца: цвет и форма по статусу проверки.
    _beads(ctx, cx, cy, cfg, size) {
      const steps = this.steps || [];
      const n = steps.length;
      if (!n) return;
      const cr = Math.cos(cfg.roll), sr = Math.sin(cfg.roll), sp = Math.sin(cfg.psi);
      const u = Math.max(0.8, size / 330);
      const k = this.stateCol || {};
      ctx.save();
      ctx.globalAlpha = cfg.alpha;
      ctx.lineWidth = 1.5 * u;
      for (let i = 0; i < n; i++) {
        const th = n === 1 ? Math.PI / 2 : Math.PI * (0.88 - 0.76 * (i / (n - 1)));
        const x = cfg.Rr * Math.cos(th), y = cfg.Rr * Math.sin(th) * sp;
        const px = cx + x * cr - y * sr, py = cy + x * sr + y * cr;
        const st = steps[i];
        ctx.fillStyle = rgba(this.core[0], this.core[1], this.core[2], 0.92);
        ctx.beginPath(); ctx.arc(px, py, 11 * u, 0, TAU); ctx.fill();
        let col = this.color;
        let solid = true;
        if (st === 'confirmed') col = k.ok || this.color;
        else if (st === 'pending') col = k.warn || this.color;
        else if (st === 'failed' || st === 'error') col = k.err || this.color;
        else if (st === 'unverified' || st === 'refused') { col = k.dim || this.color; solid = false; }
        ctx.fillStyle = rgba(col[0], col[1], col[2], 1);
        ctx.strokeStyle = rgba(col[0], col[1], col[2], 0.9);
        ctx.beginPath(); ctx.arc(px, py, (solid ? 6.5 : 5.5) * u, 0, TAU);
        if (solid) ctx.fill(); else ctx.stroke();
        if (st === 'running') {
          const pr = 0.5 + 0.5 * Math.sin(this.t * 5);
          ctx.strokeStyle = rgba(col[0], col[1], col[2], 0.35 + 0.5 * pr);
          ctx.beginPath(); ctx.arc(px, py, (11 + 2 * pr) * u, 0, TAU); ctx.stroke();
        }
      }
      ctx.restore();
    }

    _work() {
      const W = this.weights;
      return Math.min(1, W.thinking + W.searching + W.acting + W.verifying + W.speaking);
    }

    _draw() {
      const { ctx, w, h, dpr } = this;
      if (!ctx || w < 2 || h < 2 || !this.buf) return;
      const still = !this.animated || sysReduced();
      const t = still ? 1.3 : this.t;
      const W = this.weights;
      const m = this.mix;
      const c = this.color;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const size = Math.min(w, h);
      const lifeRaw = this._lifePose(still);
      // Главный шар не мнётся и не едет от набора текста: ввод и ответ только добавляют свет.
      const isHero = Boolean(this.canvas.closest('#stageOrb')) && this.variant === 'sphere';
      const life = isHero ? { ...lifeRaw, x: 0, y: 0, stretch: 0, tilt: 0 } : lifeRaw;
      const disp = isHero ? 0.25 : 1;
      let cx = w / 2 + size * life.x;
      let cy = h / 2 + size * life.y;
      // Деформация внутри холста: разметка и положение соседних элементов не меняются.
      ctx.translate(cx, cy);
      ctx.rotate(life.tilt * 0.3);
      ctx.scale(1 - life.stretch * 0.5, 1 + life.stretch);
      ctx.translate(-cx, -cy);

      // На главной сцене шар крупнее и окружён орбитами; остальные окна и миниатюры сохраняют выбранный вид.
      const hero = Boolean(this.canvas.closest('#stageOrb')) && this.variant === 'sphere';
      const variant = window.JarvisOrbVariants && window.JarvisOrbVariants[this.variant];
      if (variant) {
        variant.paint(this, ctx, size, cx, cy, {
          clock: still ? 1.3 : this.clock, work: this._work(), W, c: this.color, kick: this.kick, light: this.light,
        });
        return;
      }

      const b = still ? 0.5 : 0.5 + 0.5 * Math.sin(this.breath);
      const wL = still ? 0 : W.listening;
      // Проверка результата — та же работа ума: дуга-орбита и подсветка точек, только спокойнее.
      const wT = still ? 0 : W.thinking + 0.6 * W.verifying;
      const wS = still ? 0 : W.searching;
      const wA = still ? 0 : W.acting;
      // Прислушивание: вдох-выдох к центру за 2 с.
      const gather = 0.5 - 0.5 * Math.cos(this.gather);
      const clock = still ? 1.3 : this.clock;
      const swellAmp = isHero ? 0.03 : 0.035 + 0.065 * this._work() + life.energy * 0.085;

      const base = size * (hero ? 0.335 : 0.43);
      const R = base * m.radius * (1 + m.amp * (b - 0.5) * 2) * (1 - 0.05 * wL * gather);

      // Свечение позади сферы: слабое, форму держат точки, а не ореол. На главной сцене света больше, и он тёплый снизу справа.
      const glowA = (this.light ? 0.05 : 0.11) * (hero ? 1.9 : 1) * m.glow * (0.82 + 0.36 * b);
      if (hero) {
        const wx = cx + R * 0.55, wy = cy + R * 0.5;
        const wg = ctx.createRadialGradient(wx, wy, 0, wx, wy, R * 1.1);
        const wm = 1 - Math.min(1, W.waiting_approval + W.error);
        wg.addColorStop(0, rgba(lerp(c[0], 255, 0.55 * wm), lerp(c[1], 150, 0.55 * wm), lerp(c[2], 112, 0.55 * wm), (this.light ? 0.12 : 0.17) * m.glow));
        wg.addColorStop(1, rgba(c[0], c[1], c[2], 0));
        ctx.fillStyle = wg;
        ctx.beginPath(); ctx.arc(wx, wy, R * 1.1, 0, TAU); ctx.fill();
      }
      // Радиус свечения не выходит за холст, иначе видна резкая граница.
      const glowR = Math.min(R * 1.9, size * 0.5 - 2);
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, glowR);
      glow.addColorStop(0, rgba(c[0], c[1], c[2], glowA));
      glow.addColorStop(0.45, rgba(c[0], c[1], c[2], glowA * 0.42));
      glow.addColorStop(1, rgba(c[0], c[1], c[2], 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, TAU);
      ctx.fill();

      // Тонкая граница собирает облако точек в цельное объёмное тело.
      ctx.strokeStyle = rgba(c[0], c[1], c[2], this.light ? 0.16 : 0.22);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.92, 0, TAU);
      ctx.stroke();

      // Тёмная сердцевина для глубины.
      const coreG = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      coreG.addColorStop(0, rgba(this.core[0], this.core[1], this.core[2], 0.55));
      coreG.addColorStop(1, rgba(this.core[0], this.core[1], this.core[2], 0));
      ctx.fillStyle = coreG;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();

      const ay = still ? 0.6 : this.ay + life.tilt;
      const ax = 0.38 + (still ? 0 : 0.07 * Math.sin(t * 0.21) + life.energy * 0.08);
      const sinY = Math.sin(ay), cosY = Math.cos(ay);
      const sinX = Math.sin(ax), cosX = Math.cos(ax);
      const dotBase = Math.max(0.85, size / 290) * (hero ? 0.82 : 1);
      const scale = R * 1.62;

      // Орбита (думает): большой круг, видимый чуть сверху как эллипс; нормаль слегка покачивается.
      const nb = t * 0.35;
      let nx = 0.32 * Math.sin(nb), ny = 1, nz = 0.62 + 0.14 * Math.cos(nb * 0.8);
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;
      // Базис плоскости орбиты: u ⟂ n, v = n × u.
      let ux = ny, uy = -nx, uz = 0;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
      const arcHead = this.arcT * 2.2;
      const ARC_LEN = 2.5;

      // Луч (ищет): проходит слева направо за ~1,8 с, затем короткая пауза.
      const scanPeriod = 2.2;
      const scanPh = (this.scanT % scanPeriod) / 1.8;
      const beamX = cx + (smooth(clamp01(scanPh)) * 2 - 1) * R * 1.35;
      const beamW = R * 0.24;
      const beamOn = scanPh <= 1 ? 1 : 0;

      // Импульс (выполняет): быстрый выброс наружу и плавный возврат, период 1,3 с.
      const actPh = (this.actT % 1.3) / 1.3;

      // Волны (отвечает): фронт в долях радиуса.
      const waves = still ? [] : this.waves.map((wv) => {
        const e = clamp01((this.t - wv.t0) / WAVE_LIFE);
        return { front: 0.15 + (1 - Math.pow(1 - e, 2)) * 1.25, fade: Math.pow(1 - e, 1.6) * wv.amp };
      });

      const hiCol = [255, 255, 255];
      // Источник света медленно ходит, и блик плывёт по точкам, хотя сама сфера вращается иначе.
      const la = still ? 0 : 0.34 * Math.sin(t * 0.17);
      const lx = -0.45 * Math.cos(la) - 0.55 * Math.sin(la);
      const ly = -0.55 * Math.cos(la) + 0.45 * Math.sin(la);
      const pts = this.points;
      const B = this.buf;
      // Северное сияние из одного цвета темы: сдвиг оттенка вдоль поверхности и тёплый край у света.
      const mono = Math.min(1, W.waiting_approval + W.cancelled + W.error);
      const palB = hueRotate(c, hero ? 95 : 38), palC = hueRotate(c, hero ? 190 : 82);
      const warm = this.light ? [236, 98, 150] : [255, 150, 112];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const x1 = p.x * cosY + p.z * sinY;
        const z1 = -p.x * sinY + p.z * cosY;
        const y2 = p.y * cosX - z1 * sinX;
        const z2 = p.y * sinX + z1 * cosX;

        let r = still ? p.lift : p.lift + 0.012 * Math.sin(t * 0.9 + p.seed);
        let boost = 0;
        if (!still) {
          // Вдох проходит по сфере сверху вниз, а не надувает её разом.
          r += 0.014 * Math.sin(this.breath - p.y * 1.7);
          // Редкая искра, как блик на зерне: только там, куда падает свет.
          boost += 1.4 * Math.pow(Math.max(0, Math.sin(t * 0.31 * p.rate + p.seed * 9)), 90);
        }

        if (wA > 0.01) {
          const ph = (actPh + p.seed * 0.012) % 1;
          const env = ph < 0.28 ? 1 - Math.pow(1 - ph / 0.28, 3) : 1 - smooth((ph - 0.28) / 0.72);
          r += 0.09 * disp * env * wA * (0.75 + 0.25 * Math.sin(p.seed * 3));
          boost += 0.35 * env * wA;
        }
        if (wT > 0.01) {
          r += 0.025 * disp * wT * Math.sin(t * 6.5 + p.seed * 3);
          // Точки под бегущей дугой подсвечиваются хвостом кометы.
          const d = Math.abs(x1 * nx + y2 * ny + z2 * nz);
          if (d < 0.14) {
            const phi = Math.atan2(x1 * vx + y2 * vy + z2 * vz, x1 * ux + y2 * uy + z2 * uz);
            let delta = (arcHead - phi) % TAU;
            if (delta < 0) delta += TAU;
            if (delta < ARC_LEN) boost += wT * (1 - d / 0.14) * (1 - delta / ARC_LEN) * 1.1;
          }
        }
        if (wL > 0.01) {
          // Редкие вспышки отдельных точек.
          const fl = Math.pow(Math.max(0, Math.sin(t * 0.8 * p.rate + p.seed * 7)), 28);
          boost += fl * wL * 1.2;
        }
        const rr = Math.hypot(x1, y2);
        for (const wv of waves) {
          const g = (rr - wv.front) / 0.16;
          const bump = Math.exp(-g * g) * wv.fade;
          r += 0.07 * disp * bump;
          boost += 0.6 * bump;
        }

        // Зыбь: по поверхности идут гребни, у сферы появляется рельеф вместо ровного шума.
        if (isHero) boost += life.energy * 0.7 + this.life.send * 0.8;
        const swell = Math.sin(3.1 * p.x + clock * 0.8) * Math.sin(3.1 * p.y - clock * 0.55) * Math.sin(3.1 * p.z + clock * 0.67);
        r += swellAmp * swell;
        const depth = (z2 + 1) / 2;
        // Свет сверху слева: объём читается по освещению, а не только по глубине.
        const lit = Math.max(0, lx * x1 + ly * y2 + 0.7 * z2);
        const persp = 1 / (1.9 - z2 * 0.45);
        const sx = cx + x1 * scale * r * persp;
        const sy = cy + y2 * scale * r * persp;

        if (wS > 0.01 && beamOn) {
          const d = Math.abs(sx - beamX) / beamW;
          if (d < 1) boost += (1 - d) * (1 - d) * wS * 1.3 * (0.4 + 0.6 * depth);
        }

        const tw = still ? 0.75 : 0.5 + 0.5 * Math.sin(t * m.twinkle * p.rate * 2.2 + p.seed);
        // Бегущая светлая полоса: точки проходят сквозь неё при вращении.
        const bandY = y2 - 0.28 * Math.sin(x1 * 3 + t * 0.55) - 0.12;
        if (!still && mono < 0.5) boost += 0.55 * Math.exp(-bandY * bandY / 0.035) * m.glow * (1 - mono);
        let a = (0.1 + 0.2 * depth + 0.75 * lit) * (1 - m.flicker + m.flicker * tw) * (1 + 0.75 * swell);
        a = Math.min(1, a * (1 + boost));
        const u = 0.5 + 0.5 * Math.sin(Math.atan2(x1, z2) + t * 0.15 + y2 * 1.6);
        let cr, cg, cb;
        if (u < 0.5) { const q = u * 2; cr = lerp(c[0], palB[0], q); cg = lerp(c[1], palB[1], q); cb = lerp(c[2], palB[2], q); }
        else { const q = (u - 0.5) * 2; cr = lerp(palB[0], palC[0], q); cg = lerp(palB[1], palC[1], q); cb = lerp(palB[2], palC[2], q); }
        const wf = Math.pow(Math.max(0, 0.62 * x1 + 0.52 * y2 + 0.58 * z2), 3) * 0.85 * (1 - mono);
        cr = lerp(cr, warm[0], wf); cg = lerp(cg, warm[1], wf); cb = lerp(cb, warm[2], wf);
        B.r[i] = lerp(cr, c[0], mono); B.g[i] = lerp(cg, c[1], mono); B.b[i] = lerp(cb, c[2], mono);
        B.sx[i] = sx;
        B.sy[i] = sy;
        B.z[i] = z2;
        B.a[i] = a;
        B.s[i] = dotBase * p.size * (0.5 + 0.55 * depth + 0.3 * lit) * (0.94 + 0.12 * b) * (1 + 0.45 * Math.min(1, boost));
        B.hi[i] = this.light ? 0 : Math.min(0.85, lit * lit * 0.5 * tw + boost * 0.45) * (hero ? 0.55 : 1);
      }

      // Кольцевые волны поверх свечения.
      for (const wv of waves) {
        if (wv.fade < 0.02) continue;
        ctx.strokeStyle = rgba(lerp(c[0], 255, 0.35), lerp(c[1], 255, 0.35), lerp(c[2], 255, 0.35), 0.42 * wv.fade);
        ctx.lineWidth = Math.max(1, size / 260) * (0.6 + wv.fade);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, wv.front * R), 0, TAU);
        ctx.stroke();
      }

      // Сканирующий луч: полупрозрачная вертикальная полоса в пределах сферы.
      if (wS > 0.01 && beamOn) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.98, 0, TAU);
        ctx.clip();
        const g = ctx.createLinearGradient(beamX - beamW * 1.6, 0, beamX + beamW * 1.6, 0);
        g.addColorStop(0, rgba(c[0], c[1], c[2], 0));
        g.addColorStop(0.5, rgba(lerp(c[0], 255, 0.3), lerp(c[1], 255, 0.3), lerp(c[2], 255, 0.3), 0.2 * wS));
        g.addColorStop(1, rgba(c[0], c[1], c[2], 0));
        ctx.fillStyle = g;
        ctx.fillRect(beamX - beamW * 1.6, cy - R * 1.2, beamW * 3.2, R * 2.4);
        ctx.restore();
      }

      // Орбиты вокруг шара (только главная сцена): тонкая постоянная и кольцо шагов поручения с бусинами.
      const rings = [];
      if (hero) {
        const wm2 = 1 - mono;
        rings.push({ Rr: R * 1.4, psi: 0.5, roll: 0.42, n: 220, head: -this.arcT * 0.5, base: 0.26, size: dotBase * 0.85, alpha: 0.55,
          col: [lerp(c[0], warm[0], 0.6 * wm2), lerp(c[1], warm[1], 0.6 * wm2), lerp(c[2], warm[2], 0.6 * wm2)] });
        if (this.stepsAmt > 0.01) {
          const e = 1 - Math.pow(1 - this.stepsAmt, 3);
          rings.push({ Rr: R * (1 + 0.28 * e), psi: 0.3, roll: -0.3, n: 300, head: -this.arcT, base: 0.5, size: dotBase * 1.15, alpha: this.stepsAmt,
            col: [lerp(c[0], 255, 0.35), lerp(c[1], 255, 0.35), lerp(c[2], 255, 0.35)], steps: true });
        }
      }
      // На светлом фоне сложение цветов выбеливает точки до невидимости.
      ctx.globalCompositeOperation = this.light ? 'source-over' : 'lighter';
      for (const rg of rings) this._ring(ctx, cx, cy, rg, false, still);
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) {
          // Прозрачное тело между половинами: задние точки уходят в глубину, край ловит свет.
          ctx.globalCompositeOperation = 'source-over';
          const veil = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
          veil.addColorStop(0, rgba(this.core[0], this.core[1], this.core[2], 0.36));
          veil.addColorStop(0.8, rgba(this.core[0], this.core[1], this.core[2], 0.26));
          veil.addColorStop(1, rgba(this.core[0], this.core[1], this.core[2], 0));
          ctx.fillStyle = veil;
          ctx.beginPath();
          ctx.arc(cx, cy, R, 0, TAU);
          ctx.fill();
          const limb = ctx.createRadialGradient(cx - lx * R * 0.5, cy - ly * R * 0.5, R * 0.86, cx - lx * R * 0.1, cy - ly * R * 0.1, R * 1.02);
          limb.addColorStop(0, rgba(c[0], c[1], c[2], 0));
          limb.addColorStop(0.75, rgba(c[0], c[1], c[2], (this.light ? 0.05 : 0.08) * m.glow * (hero ? 2.6 : 1)));
          limb.addColorStop(1, rgba(c[0], c[1], c[2], 0));
          ctx.fillStyle = limb;
          ctx.beginPath();
          ctx.arc(cx, cy, R * 1.02, 0, TAU);
          ctx.fill();
          ctx.globalCompositeOperation = this.light ? 'source-over' : 'lighter';
        }
        for (let i = 0; i < pts.length; i++) {
          if ((pass === 0) !== (B.z[i] < 0)) continue;
          const mh = B.hi[i];
          ctx.fillStyle = rgba(lerp(B.r[i], hiCol[0], mh), lerp(B.g[i], hiCol[1], mh), lerp(B.b[i], hiCol[2], mh), B.a[i]);
          ctx.beginPath();
          ctx.arc(B.sx[i], B.sy[i], B.s[i], 0, TAU);
          ctx.fill();
        }
      }

      for (const rg of rings) this._ring(ctx, cx, cy, rg, true, still);
      ctx.globalCompositeOperation = 'source-over';
      for (const rg of rings) if (rg.steps) this._beads(ctx, cx, cy, rg, size);

      // Дуга-орбита (думает): тонкая светлая дуга по поверхности.
      if (wT > 0.02) {
        const segs = 36;
        const rad = 1.07;
        ctx.lineCap = 'round';
        let prev = null;
        for (let j = 0; j <= segs; j++) {
          const f = j / segs;
          const phi = arcHead - ARC_LEN * (1 - f);
          const cp = Math.cos(phi), sp = Math.sin(phi);
          const px = (ux * cp + vx * sp) * rad;
          const py = (uy * cp + vy * sp) * rad;
          const pz = (uz * cp + vz * sp) * rad;
          const persp = 1 / (1.9 - pz * 0.45);
          const pt = { x: cx + px * scale * persp, y: cy + py * scale * persp, z: pz };
          if (prev) {
            const front = (prev.z + pt.z) / 2 > 0 ? 1 : 0.3;
            const k2 = f * f * wT * front;
            // Широкий мягкий след и тонкая яркая линия поверх.
            ctx.strokeStyle = rgba(c[0], c[1], c[2], 0.22 * k2);
            ctx.lineWidth = Math.max(2, size / 90) * (0.5 + 0.8 * f);
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(pt.x, pt.y);
            ctx.stroke();
            ctx.strokeStyle = rgba(lerp(c[0], 255, 0.7), lerp(c[1], 255, 0.7), lerp(c[2], 255, 0.7), 0.95 * k2);
            ctx.lineWidth = Math.max(1.2, size / 200) * (0.6 + 0.9 * f);
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(pt.x, pt.y);
            ctx.stroke();
          }
          prev = pt;
        }
        // Светящаяся «голова» орбиты.
        if (prev) {
          const headA = (prev.z > 0 ? 0.9 : 0.35) * wT;
          const hr = Math.max(3, size / 70);
          const hg = ctx.createRadialGradient(prev.x, prev.y, 0, prev.x, prev.y, hr);
          hg.addColorStop(0, rgba(255, 255, 255, headA));
          hg.addColorStop(0.4, rgba(c[0], c[1], c[2], headA * 0.5));
          hg.addColorStop(1, rgba(c[0], c[1], c[2], 0));
          ctx.fillStyle = hg;
          ctx.beginPath();
          ctx.arc(prev.x, prev.y, hr, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  JarvisOrb.Life = OrbLife;
  JarvisOrb.STATES = STATES.slice();
  JarvisOrb.ALIAS = { ...ALIAS };
  JarvisOrb.PHRASE = { ...PHRASE };
  // Доступная подпись любого состояния: одна и та же для обёртки шара и для проверок.
  JarvisOrb.describe = phraseOf;
  window.JarvisOrb = JarvisOrb;
})();
