/* Набор простых векторных иконок (SVG, без эмодзи и без HTML-строк — совместимо со строгим CSP). */
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  const ICONS = {
    chat: [
      ['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }],
    ],
    commands: [
      ['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }],
    ],
    mcp: [
      ['path', { d: 'M12 22v-5' }],
      ['path', { d: 'M9 8V2' }],
      ['path', { d: 'M15 8V2' }],
      ['path', { d: 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z' }],
    ],
    personal: [
      ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1.5' }],
      ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1.5' }],
      ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1.5' }],
      ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1.5' }],
    ],
    settings: [
      ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
    ],
    panelLeft: [
      ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
      ['line', { x1: '9', y1: '3', x2: '9', y2: '21' }],
    ],
    user: [
      ['circle', { cx: '12', cy: '8', r: '3.2' }],
      ['path', { d: 'M5.5 20v-1.5a5.5 5.5 0 0 1 5.5-5.5h2a5.5 5.5 0 0 1 5.5 5.5V20' }],
    ],
    plus: [
      ['line', { x1: '12', y1: '5', x2: '12', y2: '19' }],
      ['line', { x1: '5', y1: '12', x2: '19', y2: '12' }],
    ],
    send: [
      ['line', { x1: '12', y1: '19', x2: '12', y2: '5' }],
      ['polyline', { points: '5 12 12 5 19 12' }],
    ],
    stop: [
      ['rect', { x: '6', y: '6', width: '12', height: '12', rx: '2', fill: 'currentColor' }],
    ],
    mic: [
      ['path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z' }],
      ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
      ['line', { x1: '12', y1: '19', x2: '12', y2: '22' }],
    ],
    orb: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['ellipse', { cx: '12', cy: '12', rx: '4', ry: '9' }],
      ['path', { d: 'M3 12h18' }],
    ],
    palette: [
      ['path', { d: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.3 1.3 0 0 1 1-2.2H18a3 3 0 0 0 3-3C21 7.3 17 3 12 3Z' }],
      ['path', { d: 'M7.5 11h.01m3-4h.01m4 0h.01m3 3h.01' }],
    ],
    paperclip: [
      ['path', { d: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }],
    ],
    target: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
      ['line', { x1: '12', y1: '2', x2: '12', y2: '5' }],
      ['line', { x1: '12', y1: '19', x2: '12', y2: '22' }],
    ],
    sliders: [
      ['line', { x1: '4', y1: '21', x2: '4', y2: '14' }],
      ['line', { x1: '4', y1: '10', x2: '4', y2: '3' }],
      ['line', { x1: '12', y1: '21', x2: '12', y2: '12' }],
      ['line', { x1: '12', y1: '8', x2: '12', y2: '3' }],
      ['line', { x1: '20', y1: '21', x2: '20', y2: '16' }],
      ['line', { x1: '20', y1: '12', x2: '20', y2: '3' }],
      ['line', { x1: '2', y1: '14', x2: '6', y2: '14' }],
      ['line', { x1: '10', y1: '8', x2: '14', y2: '8' }],
      ['line', { x1: '18', y1: '16', x2: '22', y2: '16' }],
    ],
    chevronDown: [
      ['polyline', { points: '6 9 12 15 18 9' }],
    ],
    chevronUp: [
      ['polyline', { points: '18 15 12 9 6 15' }],
    ],
    chevronRight: [
      ['polyline', { points: '9 18 15 12 9 6' }],
    ],
    x: [
      ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }],
      ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
    ],
    minus: [
      ['line', { x1: '5', y1: '12', x2: '19', y2: '12' }],
    ],
    square: [
      ['rect', { x: '6', y: '6', width: '12', height: '12', rx: '1.5' }],
    ],
    copy: [
      ['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }],
      ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
    ],
    check: [
      ['polyline', { points: '20 6 9 17 4 12' }],
    ],
    alert: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['line', { x1: '12', y1: '8', x2: '12', y2: '12' }],
      ['line', { x1: '12', y1: '16', x2: '12.01', y2: '16' }],
    ],
    shield: [
      ['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }],
    ],
    globe: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['ellipse', { cx: '12', cy: '12', rx: '4', ry: '9' }],
      ['path', { d: 'M3 12h18' }],
    ],
    external: [
      ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
      ['polyline', { points: '15 3 21 3 21 9' }],
      ['line', { x1: '10', y1: '14', x2: '21', y2: '3' }],
    ],
    search: [
      ['circle', { cx: '11', cy: '11', r: '7' }],
      ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }],
    ],
    trash: [
      ['polyline', { points: '3 6 5 6 21 6' }],
      ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ],
    refresh: [
      ['polyline', { points: '23 4 23 10 17 10' }],
      ['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }],
    ],
    sparkles: [
      ['path', { d: 'm12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z' }],
    ],
    folder: [
      ['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }],
    ],
    play: [
      ['polygon', { points: '6 4 20 12 6 20 6 4' }],
    ],
    pause: [
      ['rect', { x: '6', y: '4', width: '4', height: '16' }],
      ['rect', { x: '14', y: '4', width: '4', height: '16' }],
    ],
    more: [
      ['circle', { cx: '12', cy: '12', r: '1.3', fill: 'currentColor' }],
      ['circle', { cx: '19', cy: '12', r: '1.3', fill: 'currentColor' }],
      ['circle', { cx: '5', cy: '12', r: '1.3', fill: 'currentColor' }],
    ],
    arrowDown: [
      ['line', { x1: '12', y1: '5', x2: '12', y2: '19' }],
      ['polyline', { points: '19 12 12 19 5 12' }],
    ],
    home: [
      ['path', { d: 'M3 10.5 12 3l9 7.5V20a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-6v6H4.5A1.5 1.5 0 0 1 3 20v-9.5Z' }],
    ],
    volume: [
      ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }],
      ['path', { d: 'M15.5 8.5a5 5 0 0 1 0 7' }],
      ['path', { d: 'M18.5 6a9 9 0 0 1 0 12' }],
    ],
    volumeOff: [
      ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }],
      ['line', { x1: '22', y1: '9', x2: '16', y2: '15' }],
      ['line', { x1: '16', y1: '9', x2: '22', y2: '15' }],
    ],
    heart: [
      ['path', { d: 'M19.5 13.5 12 20.5 4.5 13.5a4.8 4.8 0 0 1 6.8-6.8L12 7.4l.7-.7a4.8 4.8 0 0 1 6.8 6.8Z' }],
    ],
    eye: [
      ['path', { d: 'M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12Z' }],
      ['circle', { cx: '12', cy: '12', r: '2.8' }],
    ],
    eyeOff: [
      ['path', { d: 'M17.9 17.9A10.9 10.9 0 0 1 12 18.5C5.8 18.5 2 12 2 12a19.7 19.7 0 0 1 4.2-4.8' }],
      ['path', { d: 'M9.9 5.7A10.6 10.6 0 0 1 12 5.5c6.2 0 10 6.5 10 6.5a19.4 19.4 0 0 1-2.5 3.3' }],
      ['line', { x1: '3', y1: '3', x2: '21', y2: '21' }],
    ],
    pencil: [
      ['path', { d: 'M12 20h9' }],
      ['path', { d: 'M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z' }],
    ],
    sort: [
      ['line', { x1: '4', y1: '7', x2: '20', y2: '7' }],
      ['line', { x1: '7', y1: '12', x2: '17', y2: '12' }],
      ['line', { x1: '10', y1: '17', x2: '14', y2: '17' }],
    ],
    music: [
      ['path', { d: 'M9 18V5l11-2v13' }],
      ['circle', { cx: '6', cy: '18', r: '3' }],
      ['circle', { cx: '17', cy: '16', r: '3' }],
    ],
    gamepad: [
      ['rect', { x: '2', y: '6', width: '20', height: '12', rx: '4' }],
      ['line', { x1: '6', y1: '12', x2: '10', y2: '12' }],
      ['line', { x1: '8', y1: '10', x2: '8', y2: '14' }],
      ['circle', { cx: '15.5', cy: '11', r: '0.8', fill: 'currentColor' }],
      ['circle', { cx: '17.5', cy: '13', r: '0.8', fill: 'currentColor' }],
    ],
    terminal: [
      ['polyline', { points: '4 17 10 11 4 5' }],
      ['line', { x1: '12', y1: '19', x2: '20', y2: '19' }],
    ],
    layers: [
      ['polygon', { points: '12 2 2 7 12 12 22 7 12 2' }],
      ['polyline', { points: '2 12 12 17 22 12' }],
      ['polyline', { points: '2 17 12 22 22 17' }],
    ],
    checkCircle: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['polyline', { points: '8.5 12.5 11 15 16 9.5' }],
    ],
    listChecks: [
      ['path', { d: 'M10 6h10' }],
      ['path', { d: 'M10 12h10' }],
      ['path', { d: 'M10 18h10' }],
      ['polyline', { points: '3.5 6 5 7.5 7.5 4.5' }],
      ['polyline', { points: '3.5 12 5 13.5 7.5 10.5' }],
      ['polyline', { points: '3.5 18 5 19.5 7.5 16.5' }],
    ],
    file: [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z' }],
      ['polyline', { points: '14 2 14 8 20 8' }],
    ],
    archive: [
      ['polyline', { points: '21 8 21 21 3 21 3 8' }],
      ['rect', { x: '1', y: '3', width: '22', height: '5', rx: '1' }],
      ['line', { x1: '10', y1: '12', x2: '14', y2: '12' }],
    ],
    link: [
      ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
      ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
    ],
    flag: [
      ['path', { d: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z' }],
      ['line', { x1: '4', y1: '22', x2: '4', y2: '15' }],
    ],
    arrowUp: [
      ['line', { x1: '12', y1: '19', x2: '12', y2: '5' }],
      ['polyline', { points: '5 12 12 5 19 12' }],
    ],
    cornerDownRight: [
      ['polyline', { points: '15 10 20 15 15 20' }],
      ['path', { d: 'M4 4v7a4 4 0 0 0 4 4h12' }],
    ],
    cornerUpLeft: [
      ['polyline', { points: '9 14 4 9 9 4' }],
      ['path', { d: 'M20 20v-7a4 4 0 0 0-4-4H4' }],
    ],
    keyboard: [
      ['rect', { x: '2', y: '5', width: '20', height: '14', rx: '2' }],
      ['line', { x1: '6', y1: '9', x2: '6.01', y2: '9' }],
      ['line', { x1: '10', y1: '9', x2: '10.01', y2: '9' }],
      ['line', { x1: '14', y1: '9', x2: '14.01', y2: '9' }],
      ['line', { x1: '18', y1: '9', x2: '18.01', y2: '9' }],
      ['line', { x1: '7', y1: '14', x2: '17', y2: '14' }],
    ],
    mousePointer: [
      ['path', { d: 'm4 4 7.07 17 2.51-7.39L21 11.07Z' }],
    ],
    clock: [
      ['circle', { cx: '12', cy: '12', r: '9' }],
      ['polyline', { points: '12 7 12 12 15.5 14' }],
    ],
    // История: циферблат со стрелкой назад — «что было раньше».
    history: [
      ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
      ['path', { d: 'M3 3v5h5' }],
      ['path', { d: 'M12 7v5l4 2' }],
    ],
    save: [
      ['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z' }],
      ['polyline', { points: '17 21 17 13 7 13 7 21' }],
      ['polyline', { points: '7 3 7 8 15 8' }],
    ],
  };

  function icon(name, className = '') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className ? `ae-ico ${className}` : 'ae-ico');
    const shapes = ICONS[name] || ICONS.chat;
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  /* Собственный логотип-сфера Nox: синий градиент + минималистичный белый глиф «N / искра». */
  function logoSphere(className = '') {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className ? `lx-logo-svg ${className}` : 'lx-logo-svg');
    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'radialGradient');
    grad.setAttribute('id', 'lxNoxSphereGrad');
    grad.setAttribute('cx', '35%');
    grad.setAttribute('cy', '28%');
    grad.setAttribute('r', '75%');
    const s1 = document.createElementNS(NS, 'stop');
    s1.setAttribute('offset', '0%');
    s1.setAttribute('stop-color', '#5B8BFF');
    const s2 = document.createElementNS(NS, 'stop');
    s2.setAttribute('offset', '55%');
    s2.setAttribute('stop-color', '#2559E8');
    const s3 = document.createElementNS(NS, 'stop');
    s3.setAttribute('offset', '100%');
    s3.setAttribute('stop-color', '#0F2A7A');
    grad.append(s1, s2, s3);
    defs.append(grad);

    const sphere = document.createElementNS(NS, 'circle');
    sphere.setAttribute('cx', '18');
    sphere.setAttribute('cy', '18');
    sphere.setAttribute('r', '16');
    sphere.setAttribute('fill', 'url(#lxNoxSphereGrad)');

    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', '18');
    ring.setAttribute('cy', '18');
    ring.setAttribute('r', '15.2');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'rgba(255,255,255,0.22)');
    ring.setAttribute('stroke-width', '1');

    // Геометрический белый глиф Nox: стилизованная N с дугой-искрой
    const glyph = document.createElementNS(NS, 'path');
    glyph.setAttribute('d', 'M12.5 23.5V12.5L23.5 23.5V12.5');
    glyph.setAttribute('fill', 'none');
    glyph.setAttribute('stroke', '#FFFFFF');
    glyph.setAttribute('stroke-width', '2.3');
    glyph.setAttribute('stroke-linecap', 'round');
    glyph.setAttribute('stroke-linejoin', 'round');

    const spark = document.createElementNS(NS, 'circle');
    spark.setAttribute('cx', '23.5');
    spark.setAttribute('cy', '12.5');
    spark.setAttribute('r', '1.6');
    spark.setAttribute('fill', '#FFFFFF');

    svg.append(defs, sphere, ring, glyph, spark);
    return svg;
  }

  window.NoxAetherIcons = { icon, logoSphere };
})();
