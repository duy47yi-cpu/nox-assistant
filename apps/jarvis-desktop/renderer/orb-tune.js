/* Настройки → Вид: свои настройки выбранного вида шара (Ядро, Диафрагма, Точечная сфера).
 * У каждого вида свой набор: свечение, скорость, сила движения, объём, реакция на голос и её сила,
 * у Точечной сферы ещё плотность точек. Хранится в localStorage jarvis.orbTune только на этом компьютере.
 * Шары слушают событие jarvis:orbtune и читают значения через window.JarvisOrbTune.get(вид). Ядро не трогается. */
(() => {
  'use strict';
  const KEY = 'jarvis.orbTune';
  const STYLES = { core: 'Ядро', iris: 'Диафрагма', sphere: 'Точечная сфера' };
  // [подпись, подсказка, мин, макс, шаг]; значения — множители, 1 — как задумано.
  const FIELDS = {
    glow: ['Яркость', 'Насколько ярко светится шар изнутри', 0.3, 1.6, 0.05],
    speed: ['Скорость', 'Как быстро движется свет внутри шара', 0.3, 2, 0.05],
    motion: ['Движение', 'Насколько заметно шар дышит. Ноль — шар стоит, но меняет цвет и свет', 0, 1.6, 0.05],
    depth: ['Объём', 'Насколько шар выглядит выпуклым: разница света и тени', 0.3, 1.6, 0.05],
    voiceGain: ['Сила отклика на голос', 'Насколько сильно шар отзывается на громкость речи', 0.2, 2, 0.05],
    density: ['Плотность точек', 'Сколько точек в сфере', 0.5, 1.6, 0.05],
  };
  const DEFAULTS = { glow: 1, speed: 1, motion: 1, depth: 1, voice: true, voiceGain: 1, density: 1 };
  const OWN = { core: ['glow', 'speed', 'motion', 'depth'], iris: ['glow', 'speed', 'motion', 'depth'], sphere: ['glow', 'speed', 'motion', 'depth', 'density'] };

  function readAll() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  // Битые и чужие значения не попадают в шар: числа зажимаются в границы, остальное — по умолчанию.
  function normalize(raw) {
    const out = { ...DEFAULTS };
    const src = raw && typeof raw === 'object' ? raw : {};
    for (const [k, f] of Object.entries(FIELDS)) {
      const v = Number(src[k]);
      if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(v)) out[k] = Math.min(f[3], Math.max(f[2], v));
    }
    if (typeof src.voice === 'boolean') out.voice = src.voice;
    return out;
  }
  // Раньше «Ядро» называлось reactor: старые сохранённые настройки читаются как настройки Ядра.
  const LEGACY = { core: 'reactor' };
  const get = (style) => { const all = readAll(); return normalize(all[style] ?? all[LEGACY[style]]); };
  function set(style, patch) {
    if (!STYLES[style]) return get(style);
    const all = readAll();
    all[style] = patch === null ? undefined : normalize({ ...get(style), ...patch });
  if (LEGACY[style]) all[LEGACY[style]] = undefined;
    try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* нет хранилища: значения живут до перезапуска */ }
    try { document.dispatchEvent(new CustomEvent('jarvis:orbtune', { detail: { style } })); } catch { /* без DOM */ }
    return get(style);
  }

  window.JarvisOrbTune = { STYLES, FIELDS, DEFAULTS, OWN, get, set, normalize };

  // ── Строки настроек под «Вид шара» ──
  const pick = typeof document !== 'undefined' && document.getElementById && document.getElementById('orbPick');
  const anchor = pick && pick.closest('.set-row');
  if (!anchor) return;
  const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const box = make('div', 'orb-tune');
  anchor.after(box);
  const fmt = (v) => `${Math.round(v * 100)} %`;
  const current = () => {
    const on = pick.querySelector('[aria-checked="true"]');
    return on && STYLES[on.dataset.orbOpt] ? on.dataset.orbOpt : 'core';
  };

  function render() {
    const style = current();
    const t = get(style);
    box.replaceChildren();
    box.dataset.style = style;
    const head = make('div', 'set-row');
    const ht = make('span', 'set-text');
    ht.append(make('span', 'set-name', `Настройки вида «${STYLES[style]}»`), make('span', 'set-hint', 'Размер шара — в строке «Размер шара» выше. Только на этом компьютере'));
    const reset = make('button', 'btn btn-secondary btn-sm', 'Как было');
    reset.type = 'button';
    reset.addEventListener('click', () => { set(style, null); render(); });
    head.append(ht, reset);
    box.append(head);
    const fields = [...OWN[style], 'voice', 'voiceGain'];
    for (const k of fields) {
      const r = make('div', 'set-row');
      const tx = make('span', 'set-text');
      if (k === 'voice') {
        tx.append(make('span', 'set-name', 'Отклик на голос'), make('span', 'set-hint', 'Шар отзывается на громкость речи, когда звук подаёт уровень'));
        const c = make('input', 'switch');
        c.type = 'checkbox'; c.setAttribute('role', 'switch'); c.setAttribute('aria-label', 'Отклик на голос');
        c.checked = t.voice; c.dataset.tune = k;
        c.addEventListener('change', () => { set(style, { voice: c.checked }); render(); });
        r.append(tx, c);
      } else {
        const f = FIELDS[k];
        const hint = make('span', 'set-hint', `${fmt(t[k])}. ${f[1]}`);
        hint.id = `orbTune-${k}`;
        tx.append(make('span', 'set-name', f[0]), hint);
        const s = make('input', 'range');
        Object.assign(s, { type: 'range', min: f[2], max: f[3], step: f[4], value: t[k] });
        s.setAttribute('aria-label', f[0]); s.setAttribute('aria-describedby', hint.id);
        s.dataset.tune = k;
        if (k === 'voiceGain' && !t.voice) s.disabled = true;
        s.addEventListener('input', () => { const v = set(style, { [k]: Number(s.value) })[k]; hint.textContent = `${fmt(v)}. ${f[1]}`; });
        r.append(tx, s);
      }
      box.append(r);
    }
  }
  // Смена вида в «Вид шара» перерисовывает строки под выбранный вид.
  new MutationObserver(render).observe(pick, { subtree: true, attributes: true, attributeFilter: ['aria-checked'] });
  render();
})();
