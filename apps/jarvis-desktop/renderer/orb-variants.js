/* Джарвис — виды шара «Ядро» и «Диафрагма» для JarvisOrb. Оба — предметы с телом и светом, а не схемы из линий.
 * Каждый рисует на том же холсте и получает общее окружение:
 *   e.clock  часы вида: идут быстрее в работе и останавливаются при ожидании и ошибке;
 *   e.work   0..1 — занят; e.W — плавные веса состояний; e.c — текущий цвет [r,g,b] из темы;
 *   e.kick   толчок от порции ответа; e.light — светлый фон; e.still — статичная картинка;
 *   e.voice  уровень голоса 0..2 (уже умножен на силу реакции; 0, если реакция выключена);
 *   e.tune   настройки вида: glow, motion, depth (скорость уже учтена в clock).
 * Тяжёлые слои (тело, стенка, оправа, стекло, пятна света) рисуются один раз в спрайт и кэшируются по размеру, цвету и объёму.
 * hole — радиус выреза контурных линий в долях стороны холста. */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const mix = (a, b, k) => a + (b - a) * k;
  const mix3 = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
  const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : +a.toFixed(3)})`;
  const WHITE = [255, 255, 255];
  const BLACK = [0, 0, 0];
  // В чёрно-белой теме цвет почти чёрный: материалу нужен хотя бы серый, иначе нет ни бликов, ни света.
  const lifted = (c) => {
    const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    return lum >= 90 ? c : mix3(c, [150, 152, 158], (90 - lum) / 90);
  };

  // Спрайт в кэше вида: перерисовывается, только когда меняется ключ (размер, цвет, объём, тема).
  function sprite(o, name, key, side, paint) {
    o._spr = o._spr || {};
    const old = o._spr[name];
    if (old && old.key === key) return old.canvas;
    const px = Math.max(2, Math.ceil(side * o.dpr));
    const canvas = old && old.px === px ? old.canvas : document.createElement('canvas');
    canvas.width = canvas.height = px;
    const g = canvas.getContext('2d');
    g.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
    g.clearRect(0, 0, side, side);
    paint(g, side / 2);
    o._spr[name] = { key, px, canvas };
    return canvas;
  }
  const q = (c) => `${c[0] >> 4},${c[1] >> 4},${c[2] >> 4}`;

  /* ── Ядро: «свет, который тлеет за тонкой стенкой тёмной глины». Тело — матовая обожжённая глина
   * (тёплый графит с крапом), свет один, сверху, блик один и мягкий. В середине стенка тоньше, и сквозь
   * неё видно, как внутри медленно и неровно ходит свет цвета акцента: три пятна с разной скоростью,
   * без колец и меток. Состояние читается по силе и темпу света и по одной тонкой линии-пояску, там, где
   * тонкая стенка переходит в толстую. Свет только внутри тела: ореола и тени вокруг нет.
   * Тело, стенка, блик и пятна света — спрайты; в кадре только drawImage и одна-две дуги пояска. ───── */
  const BODY = 0.43;   // радиус тела в долях стороны
  const SEAM = 0.656;  // поясок: граница тонкой стенки, в долях радиуса тела
  // Пятна света: доля радиуса, период обхода (с), соотношение частот x/y, фаза. Неровные, чтобы не совпадали.
  const FLOW = [
    { r: 0.62, per: 22, fx: 1, fy: 1.46, ph: 5.73, amp: 0.16, a: 0.55 },
    { r: 0.44, per: 15, fx: 1.89, fy: 1, ph: 0.96, amp: 0.22, a: 0.5 },
    { r: 0.27, per: 7.3, fx: 1.3, fy: 0.77, ph: 5.25, amp: 0.13, a: 0.42 },
  ];
  // Цвет обожжённой глины: тёплый графит, на светлой теме чуть светлее, чтобы читался объём.
  const clay = (light) => (light ? [64, 58, 53] : [46, 42, 39]);

  // Тело: матовый шар со светом сверху и мягким уходом в тень снизу, мелкий крап по глине.
  function coreBody(o, size, light, dep) {
    const R0 = size * BODY, side = R0 * 2.06;
    return sprite(o, 'coreBody', `${size}|${o.dpr}|${light}|${dep.toFixed(2)}`, side, (g, h) => {
      const base = clay(light);
      const body = g.createRadialGradient(h - R0 * 0.12, h - R0 * 0.62, 0, h, h + R0 * 0.1, R0 * 1.12);
      body.addColorStop(0, css(mix3(base, [196, 184, 170], Math.min(0.75, 0.42 * dep))));
      body.addColorStop(0.45, css(base));
      body.addColorStop(1, css(mix3(base, BLACK, Math.min(0.6, 0.32 * dep))));
      g.fillStyle = body;
      g.beginPath(); g.arc(h, h, R0, 0, TAU); g.fill();
      // Крап: железистые точки обожжённой глины. Детерминированно, чтобы спрайт не мигал при пересборке.
      if (size >= 80) {
        let s = 23;
        const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < 120; i++) {
          const a = rnd() * TAU, d = Math.sqrt(rnd()) * R0 * 0.97;
          const x = h + Math.cos(a) * d, y = h + Math.sin(a) * d;
          g.fillStyle = rnd() < 0.7 ? `rgba(0,0,0,${0.18 + 0.2 * rnd()})` : `rgba(230,214,196,${0.05 + 0.06 * rnd()})`;
          g.beginPath(); g.arc(x, y, Math.max(0.4, R0 * (0.004 + 0.006 * rnd())), 0, TAU); g.fill();
        }
      }
    });
  }

  // Толщина стенки и блик: в середине прозрачно, к краю стенка толще и закрывает свет. Сверху — один
  // широкий матовый блик (не глянец), снизу отражённого света нет: источник один.
  function coreWall(o, size, light, dep) {
    const R0 = size * BODY, side = R0 * 2.06;
    return sprite(o, 'coreWall', `${size}|${o.dpr}|${light}|${dep.toFixed(2)}`, side, (g, h) => {
      const base = clay(light);
      const wall = g.createRadialGradient(h, h - R0 * 0.04, R0 * 0.2, h, h, R0);
      wall.addColorStop(0, css(base, 0));
      wall.addColorStop(SEAM * 0.9, css(base, 0.35));
      wall.addColorStop(0.86, css(mix3(base, BLACK, 0.12), 0.88));
      wall.addColorStop(1, css(mix3(base, BLACK, Math.min(0.5, 0.28 * dep)), 1));
      g.fillStyle = wall;
      g.beginPath(); g.arc(h, h, R0, 0, TAU); g.fill();
      g.save();
      g.beginPath(); g.arc(h, h, R0, 0, TAU); g.clip();
      g.translate(h - R0 * 0.08, h - R0 * 0.6);
      g.scale(1, 0.55);
      const spec = g.createRadialGradient(0, 0, 0, 0, 0, R0 * 0.58);
      spec.addColorStop(0, `rgba(255,244,230,${0.13 * Math.min(1.5, dep)})`);
      spec.addColorStop(1, 'rgba(255,244,230,0)');
      g.fillStyle = spec;
      g.beginPath(); g.arc(0, 0, R0 * 0.58, 0, TAU); g.fill();
      g.restore();
      // Верхний край ловит тот же свет: тонкий серп держит силуэт на тёмном фоне. Это край тела, не ореол.
      const lw = Math.max(0.8, R0 * 0.018);
      const edge = g.createLinearGradient(h, h - R0, h, h + R0 * 0.2);
      edge.addColorStop(0, `rgba(240,226,208,${0.3 * Math.min(1.4, dep)})`);
      edge.addColorStop(1, 'rgba(240,226,208,0)');
      g.strokeStyle = edge;
      g.lineWidth = lw;
      g.beginPath(); g.arc(h, h, R0 - lw / 2, Math.PI * 1.02, Math.PI * 1.98); g.stroke();
    });
  }

  // Пятно света: мягкий круг одного цвета. Цвет — акцент темы, смешанный с тёплым белым, без неона.
  function coreGlow(o, size, c, hot) {
    const Rg = size * BODY, side = Rg * 2;
    return sprite(o, hot ? 'coreHot' : 'coreGlow', `${size}|${o.dpr}|${q(c)}`, side, (g, h) => {
      const col = mix3(c, [255, 238, 218], hot ? 0.55 : 0.18);
      const gr = g.createRadialGradient(h, h, 0, h, h, h);
      gr.addColorStop(0, css(col, 1));
      gr.addColorStop(0.35, css(col, 0.6));
      gr.addColorStop(0.7, css(col, 0.16));
      gr.addColorStop(1, css(col, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, side, side);
    });
  }

  function paintCore(o, ctx, size, cx, cy, e) {
    const { W, clock, work, light, tune, voice, still } = e;
    const c = lifted(e.c);
    const glo = tune.glow, mot = tune.motion, dep = tune.depth;
    const hold = Math.min(1, W.waiting_approval + W.cancelled + W.error);
    const R = size * BODY, side = R * 2.06;
    const v = Math.min(1.5, voice);

    ctx.drawImage(coreBody(o, size, light, dep), cx - side / 2, cy - side / 2, side, side);

    // Течение: фаза копится из часов вида, голос и работа его ускоряют. При статичной картинке — фиксировано.
    if (still) o._coreFlow = 1.3;
    else {
      const dc = Math.max(0, clock - (o._coreClock ?? clock));
      o._coreFlow = (o._coreFlow || 0) + dc * (1 + 1.6 * v);
    }
    o._coreClock = clock;
    const f = o._coreFlow;
    // Яркость: дыхание (медленный вдох ~5 с) и неровное тление из двух несоизмеримых волн.
    const breath = still ? 0.5 : 0.5 + 0.5 * Math.sin(clock * 1.25);
    const smoulder = still ? 0 : 0.5 * Math.sin(f * 1.7 + 0.4) * Math.sin(f * 0.61);
    const lift = 0.25 * W.listening + 0.18 * W.success + 0.35 * work;
    const lum = Math.max(0.15, Math.min(2.2,
      (0.62 + 0.16 * mot * breath + 0.12 * mot * smoulder + lift + 0.55 * v + 0.3 * e.kick) * glo * (1 - 0.45 * hold)));
    // Прислушивание собирает свет к середине, голос и работа разгоняют его шире.
    const spread = mot * (1 - 0.45 * W.listening + 0.35 * work + 0.4 * v) * (1 - hold);

    // Свет — только внутри тела: всё ниже обрезано кругом тела. За круг не выходит ни один пиксель.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < FLOW.length; i++) {
      const L = FLOW[i];
      const t = (f / L.per) * TAU + L.ph;
      const x = cx + Math.sin(t * L.fx) * R * L.amp * spread;
      const y = cy + Math.cos(t * L.fy) * R * L.amp * 0.8 * spread - R * 0.04;
      const r = R * L.r * (1 + 0.12 * v + (i === 2 ? 0.1 * e.kick : 0));
      ctx.globalAlpha = Math.min(1, L.a * lum * (light ? 1.3 : 1) * (i === 2 ? 0.8 + 0.4 * v : 1));
      ctx.drawImage(coreGlow(o, size, c, i === 2), x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();

    ctx.drawImage(coreWall(o, size, light, dep), cx - side / 2, cy - side / 2, side, side);

    // Поясок: одна тонкая линия по границе тонкой стенки. В покое еле видна; в работе по ней медленно
    // идёт светлый участок; в ожидании решения и при ошибке она ровная и полная, цвета состояния.
    const rs = R * SEAM;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.75, R * 0.011);
    ctx.strokeStyle = css(mix3(c, [255, 238, 218], 0.2), Math.min(0.9, (0.1 + 0.08 * breath + 0.5 * hold + 0.12 * work + 0.15 * v) * Math.min(1.5, glo)));
    ctx.beginPath(); ctx.arc(cx, cy, rs, 0, TAU); ctx.stroke();
    const busy = Math.min(1, work + 0.6 * W.listening) * (1 - hold);
    if (busy > 0.02 && !still) {
      const head = f * (0.5 + 0.9 * W.searching) - Math.PI / 2;
      const span = 0.5 + 1.1 * work + 0.6 * v;
      ctx.strokeStyle = css(mix3(c, [255, 238, 218], 0.35), Math.min(0.95, (0.35 + 0.4 * work) * busy * Math.min(1.5, glo)));
      ctx.beginPath(); ctx.arc(cx, cy, rs, head, head + span); ctx.stroke();
    }
  }

  /* ── Диафрагма: чернёный металл, девять лепестков в тяжёлой оправе, за ними свет. Дыхание — это
   * раскрытие. В работе лепестки ходят шагами, от голоса раскрываются, в ожидании сужаются до точки
   * цвета очереди, при ошибке захлопываются. Оправа и стекло — спрайты, лепестки — живые. ───────── */
  const BLADES = 9;

  function irisBezel(o, size, c, light, dep) {
    const Ro = size * 0.455, Ri = size * 0.372, side = Ro * 2.3;
    return sprite(o, 'irisBezel', `${size}|${o.dpr}|${q(c)}|${light}|${dep.toFixed(2)}`, side, (g, h) => {
      const steel = mix3(light ? [30, 32, 40] : [13, 15, 21], c, 0.1);
      const sheen = mix3(steel, mix3(c, WHITE, 0.45), Math.min(0.85, 0.55 * dep));
      g.save();
      g.shadowColor = `rgba(0,0,0,${light ? 0.28 : 0.55})`;
      g.shadowBlur = size * 0.05 * o.dpr;
      g.shadowOffsetY = size * 0.018 * o.dpr;
      g.fillStyle = css(steel);
      g.beginPath(); g.arc(h, h, Ro, 0, TAU); g.fill();
      g.restore();
      // Токарная оправа: свет ходит по кругу, как на проточенном металле.
      const ring = g.createConicGradient ? g.createConicGradient(-0.9, h, h) : null;
      if (ring) {
        for (const [p, k] of [[0, 0.95], [0.1, 0.25], [0.25, 0.08], [0.42, 0.5], [0.5, 0.12], [0.68, 0.04], [0.86, 0.3], [1, 0.95]]) ring.addColorStop(p, css(mix3(steel, sheen, k)));
        g.fillStyle = ring;
      } else g.fillStyle = css(steel);
      g.beginPath(); g.arc(h, h, Ro, 0, TAU); g.arc(h, h, Ri, 0, TAU, true); g.fill();
      // Объём оправы: выпуклый пояс, свет сверху слева, тень снизу справа.
      const dome = g.createRadialGradient(h - Ro * 0.45, h - Ro * 0.5, Ro * 0.1, h, h, Ro);
      dome.addColorStop(0, `rgba(255,255,255,${0.14 * dep})`);
      dome.addColorStop(0.6, 'rgba(255,255,255,0)');
      dome.addColorStop(1, `rgba(0,0,0,${Math.min(0.7, 0.4 * dep)})`);
      g.fillStyle = dome;
      g.beginPath(); g.arc(h, h, Ro, 0, TAU); g.arc(h, h, Ri, 0, TAU, true); g.fill();
      if (size >= 120) {
        const n = 96;
        g.lineWidth = Math.max(1, Ro * TAU / n * 0.42);
        for (let i = 0; i < n; i += 1) {
          const t = (i / n) * TAU;
          const lit = 0.5 + 0.5 * Math.cos(t + 2.2);
          g.strokeStyle = css(lit > 0.5 ? sheen : BLACK, 0.12 + 0.24 * lit);
          g.beginPath();
          g.moveTo(h + Math.cos(t) * Ro * 0.965, h + Math.sin(t) * Ro * 0.965);
          g.lineTo(h + Math.cos(t) * Ro * 0.998, h + Math.sin(t) * Ro * 0.998);
          g.stroke();
        }
      }
      // Тонкий светлый край снаружи — контур предмета, не ореол.
      const rim = g.createLinearGradient(h - Ro, h - Ro, h + Ro, h + Ro);
      rim.addColorStop(0, `rgba(255,255,255,${0.35 * Math.min(1.4, dep)})`);
      rim.addColorStop(0.5, 'rgba(255,255,255,0.02)');
      rim.addColorStop(1, css(mix3(c, WHITE, 0.2), 0.35 * Math.min(1.4, dep)));
      g.strokeStyle = rim;
      g.lineWidth = Math.max(0.8, Ro * 0.012);
      g.beginPath(); g.arc(h, h, Ro - g.lineWidth / 2, 0, TAU); g.stroke();
    });
  }

  function paintIris(o, ctx, size, cx, cy, e) {
    const { W, clock, work, light, tune, voice } = e;
    const c = lifted(e.c);
    const glo = tune.glow, mot = tune.motion, dep = tune.depth;
    const hold = W.waiting_approval, err = W.error;
    const Ro = size * 0.455; // оправа снаружи
    const Ri = size * 0.372; // оправа внутри
    const steel = mix3(light ? [30, 32, 40] : [13, 15, 21], c, 0.1);
    const sheen = mix3(steel, mix3(c, WHITE, 0.45), Math.min(0.85, 0.55 * dep));

    // Раскрытие: вдох в покое, шаг затвора в работе, шире при прислушивании и от голоса.
    const beat = clock * 0.9;
    const step = Math.floor(beat) + Math.pow(beat - Math.floor(beat), 5);
    const rest = 0.15 + 0.026 * mot * Math.sin(clock * 1.4);
    const busy = 0.205 + 0.04 * mot * Math.sin(step * 2.4);
    let open = mix(rest, busy, work) + 0.03 * W.listening + 0.075 * Math.min(1.5, voice);
    open = mix(open, 0.068, hold);
    open = mix(open, 0.03, err);
    open = Math.min(0.33, open);
    const a = size * (open + 0.012 * e.kick);
    // Лепестки поворачиваются вместе с раскрытием, как в настоящем механизме.
    const turn = -open * 5.2 + 0.25;

    const side = Ro * 2.3;
    ctx.drawImage(irisBezel(o, size, c, light, dep), cx - side / 2, cy - side / 2, side, side);

    // Колодец и свет за лепестками: свет собран в середине и гаснет к лепесткам.
    const glowC = mix3(c, WHITE, 0.25 + 0.2 * work);
    const well = ctx.createRadialGradient(cx - a * 0.25, cy - a * 0.3, 0, cx, cy, Math.max(a * 1.4, 1));
    const lum = Math.min(1, 0.55 + 0.45 * glo);
    well.addColorStop(0, css(mix3(mix3(glowC, WHITE, 0.2), BLACK, 1 - lum)));
    well.addColorStop(0.28, css(mix3(c, BLACK, 1 - lum)));
    well.addColorStop(0.62, css(mix3(c, BLACK, 0.6)));
    well.addColorStop(1, css(mix3(c, BLACK, 0.9)));
    ctx.fillStyle = well;
    ctx.beginPath(); ctx.arc(cx, cy, Ri, 0, TAU); ctx.fill();

    // Лепестки. Внутренняя кромка каждого — касательная к кругу раскрытия; кромки образуют вершины V.
    const half = Math.PI / BLADES;
    const Rv = a / Math.cos(half);
    const V = [];
    for (let k = 0; k < BLADES; k += 1) {
      const t = turn + (k / BLADES) * TAU + half;
      V.push([cx + Math.cos(t) * Rv, cy + Math.sin(t) * Rv]);
    }
    // Точка, где кромка лепестка k, пройдя вершину, доходит до оправы.
    const rim = (k) => {
      const p = V[k], qq = V[(k + BLADES - 1) % BLADES];
      const dx = p[0] - qq[0], dy = p[1] - qq[1];
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const fx = p[0] - cx, fy = p[1] - cy;
      const b = fx * ux + fy * uy;
      const dist = -b + Math.sqrt(Math.max(0, b * b - (fx * fx + fy * fy - Ri * Ri)));
      return { x: p[0] + ux * dist, y: p[1] + uy * dist, ux, uy, dist };
    };
    const bow = (r, k) => [V[k][0] + r.ux * r.dist * 0.5 + r.uy * r.dist * 0.16, V[k][1] + r.uy * r.dist * 0.5 - r.ux * r.dist * 0.16];

    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, Ri, 0, TAU); ctx.clip();
    for (let k = 0; k < BLADES; k += 1) {
      const n = (k + 1) % BLADES;
      const r0 = rim(k), r1 = rim(n);
      const b0 = bow(r0, k), b1 = bow(r1, n);
      ctx.beginPath();
      ctx.moveTo(V[k][0], V[k][1]);
      ctx.lineTo(V[n][0], V[n][1]);
      ctx.quadraticCurveTo(b1[0], b1[1], r1.x, r1.y);
      ctx.arc(cx, cy, Ri + 1, Math.atan2(r1.y - cy, r1.x - cx), Math.atan2(r0.y - cy, r0.x - cx), true);
      ctx.quadraticCurveTo(b0[0], b0[1], V[k][0], V[k][1]);
      ctx.closePath();

      // Свет на лепестке зависит от его поворота: шлифованный металл бликует полосой.
      const mx = (V[k][0] + V[n][0]) / 2 - cx, my = (V[k][1] + V[n][1]) / 2 - cy;
      const lit = Math.pow(0.5 + 0.5 * Math.cos(2 * (Math.atan2(my, mx) + 0.85)), 3);
      const g = ctx.createLinearGradient(V[k][0], V[k][1], r0.x, r0.y);
      g.addColorStop(0, css(mix3(steel, sheen, 0.18 + 0.72 * lit)));
      g.addColorStop(0.5, css(mix3(steel, sheen, 0.05 + 0.4 * lit)));
      g.addColorStop(1, css(mix3(steel, sheen, 0.02 + 0.16 * lit)));
      ctx.fillStyle = g;
      ctx.fill();

      // Тень от соседа и светлая фаска по кромке: так читается, что лепестки лежат внахлёст.
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(V[n][0], V[n][1]);
      ctx.quadraticCurveTo(b1[0], b1[1], r1.x, r1.y);
      for (const [w, al] of [[0.04, 0.18 * dep], [0.016, 0.3 * dep]]) {
        ctx.strokeStyle = `rgba(0,0,0,${Math.min(0.6, al)})`;
        ctx.lineWidth = size * w;
        ctx.stroke();
      }
      ctx.strokeStyle = css(sheen, 0.22 + 0.5 * lit);
      ctx.lineWidth = Math.max(0.75, size * 0.0025);
      ctx.stroke();
      ctx.restore();
    }
    // Подсвеченная кромка у самого отверстия: сюда падает свет изнутри.
    ctx.strokeStyle = css(c, (0.3 + 0.3 * work + 0.2 * Math.min(1, voice)) * Math.min(1.5, glo));
    ctx.lineWidth = Math.max(0.75, size * 0.0035);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    V.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
    // Блик на стекле линзы: серп сверху слева и мягкое пятно, как на выпуклом стекле.
    ctx.strokeStyle = `rgba(255,255,255,${0.16 * Math.min(1.5, dep)})`;
    ctx.lineWidth = Math.max(1, Ri * 0.03);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, Ri * 0.86, Math.PI * 1.1, Math.PI * 1.4); ctx.stroke();
    ctx.restore();

    // Внутренний скос оправы: тень сверху, свет снизу.
    const lip = ctx.createLinearGradient(cx, cy - Ri, cx, cy + Ri);
    lip.addColorStop(0, 'rgba(0,0,0,0.55)');
    lip.addColorStop(1, css(sheen, 0.5));
    ctx.strokeStyle = lip;
    ctx.lineWidth = Math.max(1.5, size * 0.011);
    ctx.beginPath(); ctx.arc(cx, cy, Ri, 0, TAU); ctx.stroke();
  }

  window.JarvisOrbVariants = {
    core: { hole: 0.45, paint: paintCore },
    iris: { hole: 0.46, paint: paintIris },
  };
})();
