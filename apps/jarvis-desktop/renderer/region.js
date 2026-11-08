'use strict';

// Рамка мышью поверх экрана. Итог — заголовок «nox-region:{...}» или «nox-region:cancel»; проверяет его ядро (src/screen/region.js).
(() => {
  const box = document.getElementById('box');
  let start = null;
  const send = (body) => { document.title = 'nox-region:' + body; };
  const rect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') send('cancel'); });
  document.addEventListener('contextmenu', (e) => { e.preventDefault(); send('cancel'); });
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY };
    Object.assign(box.style, { display: 'block', left: start.x + 'px', top: start.y + 'px', width: '0px', height: '0px' });
  });
  document.addEventListener('mousemove', (e) => {
    if (!start) return;
    const r = rect(start, { x: e.clientX, y: e.clientY });
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
  });
  document.addEventListener('mouseup', (e) => {
    if (!start || e.button !== 0) return;
    const r = rect(start, { x: e.clientX, y: e.clientY });
    start = null;
    if (r.width < 8 || r.height < 8) { box.style.display = 'none'; return; } // щелчок — не рамка, можно обвести снова
    send(JSON.stringify(r));
  });
})();
