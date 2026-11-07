/* Джарвис — ещё два вида шара для JarvisOrb. Оба — вещи из настоящего материала, а не схемы из линий.
 * Каждый рисует на том же холсте и получает общее окружение:
 *   e.clock  часы вида: идут быстрее в работе и останавливаются при ожидании и ошибке;
 *   e.work   0..1 — занят; e.W.waiting_approval, e.W.error — плавные веса состояний;
 *   e.c      текущий цвет [r,g,b] из темы; e.kick — толчок от порции ответа; e.light — светлый фон.
 * hole — радиус выреза контурных линий в долях стороны холста. */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const mix = (a, b, k) => a + (b - a) * k;
  const mix3 = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
  const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const WHITE = [255, 255, 255];
  // В чёрно-белой теме цвет почти чёрный: материалу нужен хотя бы серый, иначе нет ни бликов, ни света.
  const lifted = (c) => {
    const lum = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    return lum >= 90 ? c : mix3(c, [150, 152, 158], (90 - lum) / 90);
  };

  /* ── Диафрагма: чернёный металл, девять лепестков в тяжёлой оправе, за ними свет. Дыхание — это
   * раскрытие. В работе лепестки ходят шагами, в ожидании сужаются до точки цвета очереди,
   * при ошибке захлопываются. ─────────────────────────────────────────────────────────────────── */
  const BLADES = 9;

  function paintIris(o, ctx, size, cx, cy, e) {
    const { W, clock, work, light } = e;
    const c = lifted(e.c);
    const hold = W.waiting_approval, err = W.error;
    const Ro = size * 0.455; // оправа снаружи
    const Ri = size * 0.372; // оправа внутри
    // Металл: тёмное тело с лёгким оттенком цвета темы; на светлом фоне тоже тёмное, это даёт вес.
    const steel = mix3(light ? [30, 32, 40] : [13, 15, 21], c, 0.1);
    const sheen = mix3(steel, mix3(c, WHITE, 0.45), 0.55);

    // Раскрытие: вдох в покое, шаг затвора в работе.
    const beat = clock * 0.9;
    const step = Math.floor(beat) + Math.pow(beat - Math.floor(beat), 5);
    const rest = 0.15 + 0.026 * Math.sin(clock * 1.4);
    const busy = 0.205 + 0.04 * Math.sin(step * 2.4);
    let open = mix(rest, busy, work);
    open = mix(open, 0.068, hold);
    open = mix(open, 0.03, err);
    const a = size * (open + 0.012 * e.kick);
    // Лепестки поворачиваются вместе с раскрытием, как в настоящем механизме.
    const turn = -open * 5.2 + 0.25;

    // Оправа с тенью вниз: предмет лежит над полем.
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${light ? 0.28 : 0.55})`;
    ctx.shadowBlur = size * 0.05;
    ctx.shadowOffsetY = size * 0.018 * o.dpr;
    ctx.fillStyle = css(steel);
    ctx.beginPath();
    ctx.arc(cx, cy, Ro, 0, TAU);
    ctx.fill();
    ctx.restore();

    // Токарная оправа: свет ходит по кругу, как на проточенном металле.
    const ring = ctx.createConicGradient(-0.9, cx, cy);
    for (const [p, k] of [[0, 0.95], [0.1, 0.25], [0.25, 0.08], [0.42, 0.5], [0.5, 0.12], [0.68, 0.04], [0.86, 0.3], [1, 0.95]]) ring.addColorStop(p, css(mix3(steel, sheen, k)));
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(cx, cy, Ro, 0, TAU);
    ctx.arc(cx, cy, Ri, 0, TAU, true);
    ctx.fill();

    // Насечка по внешнему краю, только в крупном размере.
    if (size >= 120) {
      const n = 96;
      ctx.lineWidth = Math.max(1, Ro * TAU / n * 0.42);
      for (let i = 0; i < n; i += 1) {
        const t = (i / n) * TAU;
        const lit = 0.5 + 0.5 * Math.cos(t + 2.2);
        ctx.strokeStyle = css(lit > 0.5 ? sheen : [0, 0, 0], 0.12 + 0.24 * lit);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(t) * Ro * 0.965, cy + Math.sin(t) * Ro * 0.965);
        ctx.lineTo(cx + Math.cos(t) * Ro * 0.998, cy + Math.sin(t) * Ro * 0.998);
        ctx.stroke();
      }
    }

    // Колодец и свет за лепестками.
    const glowC = mix3(c, WHITE, 0.25 + 0.2 * work);
    const well = ctx.createRadialGradient(cx - a * 0.25, cy - a * 0.3, 0, cx, cy, Math.max(a * 1.4, 1));
    // Глубокая линза: свет собран в середине и гаснет к лепесткам, а не заливает отверстие.
    well.addColorStop(0, css(mix3(glowC, WHITE, 0.2)));
    well.addColorStop(0.28, css(c));
    well.addColorStop(0.62, css(mix3(c, [0, 0, 0], 0.6)));
    well.addColorStop(1, css(mix3(c, [0, 0, 0], 0.9)));
    ctx.fillStyle = well;
    ctx.beginPath();
    ctx.arc(cx, cy, Ri, 0, TAU);
    ctx.fill();

    // Лепестки. Внутренняя кромка каждого — касательная к кругу раскрытия; кромки образуют вершины V.
    const edge = (k) => turn + (k / BLADES) * TAU;
    const V = [];
    const half = Math.PI / BLADES;
    const Rv = a / Math.cos(half);
    for (let k = 0; k < BLADES; k += 1) {
      const t = edge(k) + half;
      V.push([cx + Math.cos(t) * Rv, cy + Math.sin(t) * Rv]);
    }
    // Точка, где кромка лепестка k, пройдя вершину, доходит до оправы.
    const rim = (k) => {
      const p = V[k], q = V[(k + BLADES - 1) % BLADES];
      const dx = p[0] - q[0], dy = p[1] - q[1];
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const fx = p[0] - cx, fy = p[1] - cy;
      const b = fx * ux + fy * uy;
      const dist = -b + Math.sqrt(Math.max(0, b * b - (fx * fx + fy * fy - Ri * Ri)));
      return { x: p[0] + ux * dist, y: p[1] + uy * dist, ux, uy, dist };
    };

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, Ri, 0, TAU);
    ctx.clip();
    const curve = (r, k, nx, ny) => {
      // Лепесток выгнут: кромка уходит к оправе не по прямой.
      const bow = r.dist * 0.16;
      ctx.quadraticCurveTo(V[k][0] + r.ux * r.dist * 0.5 + nx * bow, V[k][1] + r.uy * r.dist * 0.5 + ny * bow, r.x, r.y);
    };
    for (let k = 0; k < BLADES; k += 1) {
      const n = (k + 1) % BLADES;
      const r0 = rim(k), r1 = rim(n);
      ctx.beginPath();
      ctx.moveTo(V[k][0], V[k][1]);
      ctx.lineTo(V[n][0], V[n][1]);
      ctx.quadraticCurveTo(V[n][0] + r1.ux * r1.dist * 0.5 + r1.uy * r1.dist * 0.16, V[n][1] + r1.uy * r1.dist * 0.5 - r1.ux * r1.dist * 0.16, r1.x, r1.y);
      ctx.arc(cx, cy, Ri + 1, Math.atan2(r1.y - cy, r1.x - cx), Math.atan2(r0.y - cy, r0.x - cx), true);
      ctx.quadraticCurveTo(V[k][0] + r0.ux * r0.dist * 0.5 + r0.uy * r0.dist * 0.16, V[k][1] + r0.uy * r0.dist * 0.5 - r0.ux * r0.dist * 0.16, V[k][0], V[k][1]);
      ctx.closePath();

      // Свет на лепестке зависит от его поворота: шлифованный металл бликует полосой.
      const mid = (V[k][0] + V[n][0]) / 2 - cx, midY = (V[k][1] + V[n][1]) / 2 - cy;
      const ang = Math.atan2(midY, mid);
      const lit = Math.pow(0.5 + 0.5 * Math.cos(2 * (ang + 0.85)), 3);
      const g = ctx.createLinearGradient(V[k][0], V[k][1], r0.x, r0.y);
      g.addColorStop(0, css(mix3(steel, sheen, 0.18 + 0.72 * lit)));
      g.addColorStop(0.5, css(mix3(steel, sheen, 0.05 + 0.4 * lit)));
      g.addColorStop(1, css(mix3(steel, sheen, 0.02 + 0.16 * lit)));
      ctx.fillStyle = g;
      ctx.fill();

      // Тень от соседа на лепесток: так читается, что они лежат внахлёст.
      ctx.save();
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(V[n][0], V[n][1]);
      ctx.quadraticCurveTo(V[n][0] + r1.ux * r1.dist * 0.5 + r1.uy * r1.dist * 0.16, V[n][1] + r1.uy * r1.dist * 0.5 - r1.ux * r1.dist * 0.16, r1.x, r1.y);
      // Мягкая тень из трёх проходов и тонкая светлая фаска по самой кромке.
      for (const [w, al] of [[0.05, 0.14], [0.03, 0.2], [0.014, 0.3]]) {
        ctx.strokeStyle = `rgba(0,0,0,${al})`;
        ctx.lineWidth = size * w;
        ctx.stroke();
      }
      ctx.strokeStyle = css(sheen, 0.22 + 0.5 * lit);
      ctx.lineWidth = Math.max(0.75, size * 0.0025);
      ctx.stroke();
      ctx.restore();
    }
    // Подсвеченная кромка у самого отверстия: сюда падает свет изнутри.
    ctx.strokeStyle = css(c, 0.3 + 0.3 * work);
    ctx.lineWidth = Math.max(0.75, size * 0.0035);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    V.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.stroke();
    // Блик на стекле линзы: серп сверху слева.
    if (a > size * 0.05) {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = Math.max(1, a * 0.05);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, a * 0.62, Math.PI * 1.08, Math.PI * 1.42);
      ctx.stroke();
    }
    ctx.restore();

    // Внутренний скос оправы: тень сверху, свет снизу.
    const lip = ctx.createLinearGradient(cx, cy - Ri, cx, cy + Ri);
    lip.addColorStop(0, 'rgba(0,0,0,0.55)');
    lip.addColorStop(1, css(sheen, 0.5));
    ctx.strokeStyle = lip;
    ctx.lineWidth = Math.max(1.5, size * 0.011);
    ctx.beginPath();
    ctx.arc(cx, cy, Ri, 0, TAU);
    ctx.stroke();
  }

  /* ── Обмотка: шар, плотно намотанный толстым эмалированным проводом. Считается попиксельно: у каждого
   * витка своя круглая нормаль, поэтому видны объём и блик вдоль провода. Поверх основной намотки лежат
   * ленты: каждая обходит шар целиком, а её край идёт ровно по шву между витками, поэтому провод нигде
   * не обрывается. В работе по проводу бежит ток, в ожидании шар стоит. ──────────── */
  const COIL_R = 0.435;
  const unit = (v) => { const d = Math.hypot(...v) || 1; return v.map((q) => q / d); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const COIL_BASE = unit([0.2, 0.92, 0.33]);
  // Первая в списке лежит выше всех. half — полуширина ленты в радианах. Первые две идут через полюса
  // основной намотки и закрывают их: стянутые в точку витки не видны при любом повороте шара.
  const LAYERS = [
    { axis: cross(COIL_BASE, [1, 0.1, 0.4]), half: 0.36 },
    { axis: cross(COIL_BASE, [-0.3, 0.2, 1]), half: 0.42 },
    { axis: [0.7, 0.1, 0.7], half: 0.32 },
    { axis: [-0.6, 0.6, 0.5], half: 0.38 },
    { axis: COIL_BASE, half: 2 }, // основная намотка, видна там, где нет лент
  ].map((l) => {
    const axis = unit(l.axis);
    // u, v — плоскость витка: по ней считается путь тока вдоль провода.
    const u = unit(cross(axis, [0.31, 0.87, 0.38]));
    return { ...l, axis, u, v: cross(axis, u) };
  });
  const TOP = LAYERS.length - 1;

  function coilBuffer(o, size) {
    const n = Math.max(40, Math.min(270, Math.round(COIL_R * 2 * size * o.dpr)));
    if (o.coil && o.coil.n === n) return o.coil;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const c2 = canvas.getContext('2d');
    o.coil = { n, canvas, c2, img: c2.createImageData(n, n) };
    return o.coil;
  }

  function paintCoil(o, ctx, size, cx, cy, e) {
    const { W, clock, work, light } = e;
    const c = lifted(e.c);
    const hold = W.waiting_approval;
    const breath = 1 + 0.016 * Math.sin(clock * 1.4) * (1 - hold) + 0.012 * e.kick;
    const R = COIL_R * size * breath;

    // Тень вниз: шар тяжёлый и лежит над полем.
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${light ? 0.3 : 0.55})`;
    ctx.shadowBlur = size * 0.05;
    ctx.shadowOffsetY = size * 0.02 * o.dpr;
    ctx.fillStyle = css(mix3(c, [0, 0, 0], 0.8));
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.99, 0, TAU);
    ctx.fill();
    ctx.restore();

    const buf = coilBuffer(o, size);
    const { n, img } = buf;
    const px = img.data;
    const turns = Math.max(6, Math.min(9, Math.round(size / 32))); // витков на радиан: провод толстый, тоньше у края шара идёт лесенка
    const ay = clock * 0.11, cosA = Math.cos(ay), sinA = Math.sin(ay);
    // Эмаль: тень заметно темнее цвета темы, блик светлее; так провод читается в любой теме.
    const deep = mix3(c, [0, 0, 0], light ? 0.72 : 0.8);
    const body = mix3(c, [0, 0, 0], 0.18);
    const shine = mix3(c, WHITE, 0.6);
    // Свет сверху слева, полувектор к зрителю.
    const lx = -0.42, ly = -0.58, lz = 0.7;
    const hx = lx * 0.58, hy = ly * 0.58, hz = (lz + 1) * 0.58;
    const flow = clock * 2.6;
    const current = work * 0.9 + e.kick * 0.5;
    // Край ленты ровно на целом числе витков, то есть на шве между проводами.
    const edges = LAYERS.map((L) => Math.sin(Math.max(1, Math.round(L.half * turns)) / turns));
    const phases = LAYERS.map((L, k) => [Math.cos(flow - k * 1.7), Math.sin(flow - k * 1.7)]);

    for (let j = 0, q = 0; j < n; j += 1) {
      const sy = ((j + 0.5) / n) * 2 - 1;
      for (let i = 0; i < n; i += 1, q += 4) {
        const sx = ((i + 0.5) / n) * 2 - 1;
        const r2 = sx * sx + sy * sy;
        if (r2 >= 1) { px[q + 3] = 0; continue; }
        const sz = Math.sqrt(1 - r2);
        // Точка на теле шара: шар медленно поворачивается вокруг вертикали.
        const x = sx * cosA + sz * sinA, y = sy, z = -sx * sinA + sz * cosA;
        // Верхняя лента над этой точкой; shade — тень от края лежащей выше ленты.
        let layer = LAYERS[TOP], shade = 0, li = TOP, dot = x * layer.axis[0] + y * layer.axis[1] + z * layer.axis[2];
        for (let k = 0; k < TOP; k += 1) {
          const L = LAYERS[k], A = L.axis;
          const h = x * A[0] + y * A[1] + z * A[2];
          const d = edges[k] - (h < 0 ? -h : h);
          if (d > 0) { layer = L; li = k; dot = h; break; }
          if (d > -0.09) shade = Math.max(shade, 1 + d / 0.09);
        }
        const a = layer.axis;
        const lat = Math.asin(dot < -1 ? -1 : dot > 1 ? 1 : dot) * turns;
        const f = (lat - Math.floor(lat)) * 2 - 1; // поперёк витка, -1..1
        // Направление поперёк витка на поверхности.
        let gx = a[0] - dot * x, gy = a[1] - dot * y, gz = a[2] - dot * z;
        const gl = Math.hypot(gx, gy, gz) || 1;
        gx /= gl; gy /= gl; gz /= gl;
        // Круглая нормаль провода (в осях шара), затем обратно в экранные.
        // У края шара витки сжимаются сильнее пикселя: там рельеф гасим, иначе идёт муар.
        const relief = sz > 0.34 ? 1 : sz / 0.34;
        const round = 0.85 * f * relief;
        const up = Math.sqrt(1 - round * round);
        const wx = x * up + gx * round, wy = y * up + gy * round, wz = z * up + gz * round;
        const nx = wx * cosA - wz * sinA, ny = wy, nz = wx * sinA + wz * cosA;

        const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
        const spec = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 40);
        const groove = 1 - relief * Math.pow(Math.abs(f), 4); // тёмный шов между витками
        const rimShade = 0.45 + 0.55 * Math.min(1, sz * 1.5); // шар темнеет к краю
        let k = (0.1 + 0.95 * diff) * groove * rimShade * (1 - 0.72 * shade);
        k = k > 1 ? 1 : k;

        let r = mix(deep[0], body[0], k), g = mix(deep[1], body[1], k), b = mix(deep[2], body[2], k);
        const sp = spec * groove * (1 - shade) * 0.8;
        // Ток: светлые участки бегут вдоль провода, у каждого слоя своя фаза.
        let juice = 0;
        if (current > 0.01) {
          const pu = x * layer.u[0] + y * layer.u[1] + z * layer.u[2];
          const pv = x * layer.v[0] + y * layer.v[1] + z * layer.v[2];
          // Фаза общая для всей ленты: вспышка идёт плавно по всем виткам, а не рубится на куски.
          // Это sin(2·азимут - фаза) без atan2: на 70 тысячах точек он съедал бюджет кадра.
          const wave = 0.5 + 0.5 * (2 * pu * pv * phases[li][0] - (pu * pu - pv * pv) * phases[li][1]) / (pu * pu + pv * pv || 1);
          juice = current * groove * relief * wave * wave;
        }
        const add = sp + juice * 0.38;
        px[q] = mix(r, shine[0], add > 1 ? 1 : add);
        px[q + 1] = mix(g, shine[1], add > 1 ? 1 : add);
        px[q + 2] = mix(b, shine[2], add > 1 ? 1 : add);
        px[q + 3] = 255;
      }
    }
    buf.c2.putImageData(img, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buf.canvas, cx - R, cy - R, R * 2, R * 2);
    ctx.restore();
  }

  window.JarvisOrbVariants = {
    iris: { hole: 0.46, paint: paintIris },
    coil: { hole: 0.455, paint: paintCoil },
  };
})();
