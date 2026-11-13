/* Nox — вид шара «Затвор»: девять металлических лепестков в оправе, за ними свет. Подключается после orb-nox.js
 * и добавляет NoxOrb один метод; сфера и проволока остаются как были.
 *
 * Состояния говорят раскрытием диафрагмы, цвет — только подсказка:
 *   idle — спокойное дыхание, раскрытие ~ 0.30; attentive/listening — шире, дышит в такт голосу;
 *   thinking — затвор идёт шагами (поворот на лепесток) и мелко щёлкает раскрытием, по оправе бежит метка;
 *   speaking — раскрытие дышит голосом; waiting_approval — сужение почти до точки, янтарь;
 *   error — закрыт, красный; success — короткая вспышка раскрытия, зелёный.
 * Цвета лепестков нейтральные тёплые, сигнальный цвет виден только в свете за отверстием и в метках оправы. */
(() => {
  'use strict';
  if (typeof window === 'undefined' || typeof window.NoxOrb !== 'function') return;

  const TAU = Math.PI * 2;
  const BLADES = 9;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp01(a).toFixed(3) + ')';

  // Свет за отверстием по состояниям. Янтарь, красный и зелёный — те же роли, что у остальных видов.
  const SIGNAL = {
    idle: [255, 106, 61],
    attentive: [255, 122, 74],
    listening: [255, 138, 92],
    thinking: [255, 150, 96],
    speaking: [255, 122, 74],
    waiting_approval: [245, 165, 36],
    error: [255, 92, 92],
    success: [140, 242, 190],
  };
  // Раскрытие диафрагмы: доля внутреннего радиуса оправы.
  const OPEN = {
    idle: 0.30, attentive: 0.36, listening: 0.40, thinking: 0.34, speaking: 0.38,
    waiting_approval: 0.07, error: 0.025, success: 0.46,
  };

  const proto = window.NoxOrb.prototype;

  proto._drawShutter = function (ctx, t, cx, cy, R, limit) {
    const still = this._still();
    const state = this.state;
    if (!this._sh) this._sh = { col: SIGNAL[state].slice(), open: OPEN[state], rot: 0, rotTarget: 0, tick: 0 };
    const S = this._sh;

    // Плавный переход света и раскрытия. Шаг на кадр, не на секунды: вид не гоняет собственных часов.
    const kc = still ? 1 : 0.10;
    const sig = SIGNAL[state] || SIGNAL.idle;
    for (let i = 0; i < 3; i++) S.col[i] = lerp(S.col[i], sig[i], kc);

    let open = OPEN[state] || OPEN.idle;
    const breath = Math.sin(this.breath);
    if (state === 'idle') open += 0.025 * breath;
    else if (state === 'attentive') open += 0.03 * breath;
    else if (state === 'thinking') open += 0.035 * Math.sin(this.phase * 7.0);
    else if (state === 'listening' || state === 'speaking') open += 0.10 * this.voice + 0.02 * breath;
    else if (state === 'waiting_approval') open += 0.012 * breath;
    open += 0.22 * this.flash + 0.06 * this.kick;
    if (still) open = OPEN[state] || OPEN.idle;
    S.open = lerp(S.open, open, still ? 1 : 0.16);

    // Ход затвора шагами: пока думает, раз за разом поворот на один лепесток с быстрым дожатием.
    if (state === 'thinking' && !still) S.rotTarget = Math.floor(this.phase * 1.3) * (TAU / BLADES);
    else if (still) S.rot = S.rotTarget = 0.35;
    S.rot = lerp(S.rot, S.rotTarget, still ? 1 : 0.22);

    const rOuter = Math.min(R * 1.02, limit);
    const rIn = rOuter * 0.80;
    const a = Math.max(1.2, rIn * S.open);
    const col = S.col;
    const u = Math.max(0.7, rOuter / 130);

    // Свет за отверстием: яркий центр, сигнальный край. Лепестки ниже закрывают всё, что шире отверстия.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, a * 1.25);
    glow.addColorStop(0, 'rgba(255,244,232,1)');
    glow.addColorStop(0.45, rgba(col, 1));
    glow.addColorStop(1, rgba(col, 0.9));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, a * 1.25, 0, TAU);
    ctx.fill();

    // Оправа: тёмное тело, тонкое кольцо, ниже — лепестки.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rIn, 0, TAU);
    ctx.clip();
    const edge = a * Math.tan(Math.PI / BLADES);
    const reach = Math.sqrt(Math.max(0, rIn * rIn - a * a)) + rIn * 0.6;
    const geo = [];
    for (let i = 0; i < BLADES; i++) {
      const phi = S.rot + (i * TAU) / BLADES;
      const nx = Math.cos(phi), ny = Math.sin(phi);
      const dx = -ny, dy = nx;
      const px = cx + nx * a, py = cy + ny * a;
      const sx = px - dx * edge, sy = py - dy * edge;
      const ex = px + dx * reach, ey = py + dy * reach;
      const far = rIn * 1.3;
      // Свет сверху слева: лепестки, обращённые к нему, светлее. Проход первый — только заливка.
      const lit = 0.5 + 0.5 * Math.cos(phi + 2.35);
      const base = 38 + 40 * lit;
      const g = ctx.createLinearGradient(sx, sy, sx + nx * far * 0.55, sy + ny * far * 0.55);
      g.addColorStop(0, 'rgb(' + ((base + 14) | 0) + ',' + ((base + 11) | 0) + ',' + ((base + 5) | 0) + ')');
      g.addColorStop(1, 'rgb(' + ((base - 14) | 0) + ',' + ((base - 16) | 0) + ',' + ((base - 20) | 0) + ')');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.lineTo(ex + nx * far, ey + ny * far);
      ctx.lineTo(sx + nx * far, sy + ny * far);
      ctx.closePath();
      ctx.fill();
      geo.push([sx, sy, ex, ey, lit, phi]);
    }
    // Проход второй: кромки всех лепестков поверх заливки — виден спиральный рисунок затвора.
    for (let i = 0; i < BLADES; i++) {
      const [sx, sy, ex, ey, lit, phi] = geo[i];
      ctx.strokeStyle = 'rgba(' + ((150 + 70 * lit) | 0) + ',' + ((140 + 66 * lit) | 0) + ',' + ((120 + 56 * lit) | 0) + ',0.85)';
      ctx.lineWidth = Math.max(1, 1.2 * u);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // Ось лепестка: заклёпка у оправы.
      ctx.fillStyle = 'rgba(12,11,9,0.95)';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(phi - 0.34) * rIn * 0.9, cy + Math.sin(phi - 0.34) * rIn * 0.9, Math.max(1.6, 2.6 * u), 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Отсвет на лепестках от света в отверстии: мягкий, не неон.
    const spill = ctx.createRadialGradient(cx, cy, a, cx, cy, Math.min(rIn, a * 3.4 + 12 * u));
    spill.addColorStop(0, rgba(col, 0.22));
    spill.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = spill;
    ctx.beginPath();
    ctx.arc(cx, cy, rIn, 0, TAU);
    ctx.arc(cx, cy, a, 0, TAU, true);
    ctx.fill('evenodd');

    // Оправа и шкала.
    ctx.strokeStyle = 'rgba(120,112,96,0.75)';
    ctx.lineWidth = Math.max(1, 1.4 * u);
    ctx.beginPath();
    ctx.arc(cx, cy, rIn, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(70,64,54,0.9)';
    ctx.lineWidth = Math.max(1, 1.2 * u);
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, TAU);
    ctx.stroke();

    const TICKS = 72;
    const hot = state === 'thinking' && !still ? Math.floor((this.phase * 9) % TICKS) : -1;
    for (let i = 0; i < TICKS; i++) {
      const ang = (i / TICKS) * TAU - Math.PI / 2;
      const major = i % 6 === 0;
      const r0 = rIn + (rOuter - rIn) * 0.32;
      const r1 = rOuter - (rOuter - rIn) * (major ? 0.12 : 0.40);
      const isHot = i === hot || i === (hot + TICKS - 1) % TICKS;
      ctx.strokeStyle = isHot ? rgba(col, 1) : (major ? 'rgba(168,158,138,0.85)' : 'rgba(104,96,82,0.65)');
      ctx.lineWidth = Math.max(1, (major || isHot ? 1.5 : 1) * u);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }
    // Метка «сверху»: сигнальный цвет, один штрих — то, что глаз видит первым.
    ctx.strokeStyle = rgba(col, 1);
    ctx.lineWidth = Math.max(2, 2.4 * u);
    ctx.beginPath();
    ctx.moveTo(cx, cy - rOuter + 1);
    ctx.lineTo(cx, cy - rIn - (rOuter - rIn) * 0.1);
    ctx.stroke();
  };
})();
