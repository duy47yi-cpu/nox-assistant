/* Nox — раздел «Настройки»: оболочка окна и новые карточки.
 *
 * Здесь только то, чего раньше не было в окне настроек (кнопки окна — в общей шапке, nox-shell.js):
 *   • честное состояние загрузки/ошибки раздела,
 *   • карточка «ИИ и провайдеры» — модель и глубина обдумывания (существующие
 *     settings:setModelTier / settings:setThinking, значения из settings.json),
 *   • карточка «Сфера Nox» — реальный вариант Wire / Nox Points (window.NoxScreen.setVariant,
 *     localStorage noxOrb) и предпросмотр размера/свечения, который НЕ применяется к живой
 *     сфере (у неё нет механизма сохранения этих параметров — поэтому preview-only, честно).
 * Все прежние настройки остаются в app.js/look.js/accent.js/orb-tune.js и не дублируются. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const api = () => window.jarvis || null;

  // ── 2. Состояние раздела: загрузка и ошибки ───────────────────
  const state = { loaded: false, loading: false, revision: 0, model: 'fast', level: 'low' };

  function setStatus(text, tone) {
    const node = $('#setStatus');
    if (!node) return;
    node.textContent = text || '';
    if (tone) node.dataset.tone = tone;
    else node.removeAttribute('data-tone');
  }

  function showError(text) {
    const box = $('#setError');
    const label = $('#setErrorText');
    if (!box || !label) return;
    label.textContent = String(text || 'Не удалось сохранить настройку.');
    box.hidden = false;
    clearTimeout(showError.timer);
    showError.timer = setTimeout(() => { box.hidden = true; }, 8000);
  }

  let errorsBound = false;
  function bindErrors() {
    if (errorsBound) return;
    errorsBound = true;
    // app.js сообщает об ошибках тостом; в разделе настроек показываем ту же причину строкой,
    // чтобы её было видно и после исчезновения тоста. Своих сообщений не придумываем.
    document.addEventListener('jarvis:toast', (e) => {
      const detail = (e && e.detail) || {};
      if (detail.kind !== 'error') return;
      if (document.body.dataset.view !== 'settings') return;
      if (!detail.text) return;
      showError(detail.text);
    });
  }

  function loadStatus() {
    const bridge = api();
    if (!bridge || typeof bridge.getSettings !== 'function') return;
    if (state.loaded || state.loading) return;
    state.loading = true;
    const revision = state.revision;
    const main = $('#setMain');
    if (main) main.dataset.loading = 'true';
    setStatus('Проверяю настройки…');
    let timer = 0;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ядро не ответило вовремя')), 8000);
    });
    Promise.race([Promise.resolve().then(() => bridge.getSettings()), deadline])
      .then((s) => {
        state.loaded = true;
        if (s && typeof s === 'object') {
          if (state.revision === revision) syncTierCard(s);
          setStatus('');
        } else {
          setStatus('Настройки недоступны в этой версии ядра', 'err');
        }
      })
      .catch((err) => {
        setStatus('Не удалось прочитать настройки', 'err');
        showError('Настройки не прочитаны: ' + String((err && err.message) || err || 'ядро не ответило'));
      })
      .finally(() => {
        clearTimeout(timer);
        state.loading = false;
        if (main) main.removeAttribute('data-loading');
      });
  }

  // ── 3. «ИИ и провайдеры»: модель и обдумывание ────────────────
  const MODEL_HINT = {
    fast: 'Отвечает сразу. Подходит для команд и коротких вопросов.',
    smart: 'Сильнее в сложных поручениях и длинных текстах.',
  };
  const THINKING_HINT = {
    low: 'Обычный расход лимита.',
    medium: 'Лимит тратится примерно в 1,5 раза быстрее.',
    high: 'Лимит тратится примерно в 2,5 раза быстрее.',
  };

  function setHint(id, text) {
    const node = document.getElementById(id);
    if (node) node.textContent = text || '';
  }

  function syncTierCard(settings) {
    const tier = $('#setModelTier');
    const thinking = $('#setThinking');
    const model = settings && settings.modelTier === 'smart' ? 'smart' : 'fast';
    const level = settings && ['low', 'medium', 'high'].includes(settings.thinking) ? settings.thinking : 'low';
    state.model = model;
    state.level = level;
    if (tier) tier.value = model;
    if (thinking) thinking.value = level;
    setHint('setModelHint', MODEL_HINT[model]);
    setHint('setThinkingHint', THINKING_HINT[level]);
    syncReplyStyle(settings);
    // Поле выбора у чата показывает те же значения — сообщаем ему, а не перерисовываем его.
    try { document.dispatchEvent(new CustomEvent('jarvis:tier', { detail: { tier: model, level } })); } catch { /* без DOM */ }
  }

  async function changeTier(next) {
    const bridge = api();
    const select = $('#setModelTier');
    if (!bridge || typeof bridge.setModelTier !== 'function') return;
    state.revision += 1;
    // Прежнее значение запоминаем до сохранения: select.value уже содержит новый вариант.
    const prev = state.model || (select ? select.value : 'fast');
    if (select) select.disabled = true;
    try {
      const r = await bridge.setModelTier(next);
      if (!r || r.ok === false) throw new Error('ядро отклонило выбор');
      const value = r.tier === 'smart' ? 'smart' : 'fast';
      state.model = value;
      if (select) select.value = value;
      setHint('setModelHint', MODEL_HINT[value]);
      document.dispatchEvent(new CustomEvent('jarvis:tier', { detail: { tier: value, level: $('#setThinking') ? $('#setThinking').value : 'low' } }));
    } catch (err) {
      if (select) select.value = prev;
      showError('Модель не сохранена: ' + String((err && err.message) || err));
    } finally {
      if (select) select.disabled = false;
    }
  }

  async function changeThinking(next) {
    const bridge = api();
    const select = $('#setThinking');
    if (!bridge || typeof bridge.setThinking !== 'function') return;
    state.revision += 1;
    const prev = state.level || (select ? select.value : 'low');
    if (select) select.disabled = true;
    try {
      const r = await bridge.setThinking(next);
      if (!r || r.ok === false) throw new Error('ядро отклонило выбор');
      const value = ['low', 'medium', 'high'].includes(r.level) ? r.level : next;
      state.level = value;
      if (select) select.value = value;
      setHint('setThinkingHint', THINKING_HINT[value]);
      document.dispatchEvent(new CustomEvent('jarvis:tier', { detail: { tier: $('#setModelTier') ? $('#setModelTier').value : 'fast', level: value } }));
    } catch (err) {
      if (select) select.value = prev;
      showError('Глубина обдумывания не сохранена: ' + String((err && err.message) || err));
    } finally {
      if (select) select.disabled = false;
    }
  }

  // Оформление ответов: правила уходят модели (ядро), вид текста — атрибут body для стилей ленты.
  const REPLY_STYLES = ['plain', 'rich', 'notes'];
  const REPLY_HINT = {
    plain: 'Коротко и по делу, без оформления.',
    rich: 'Подписи блоков, жирные числа и формулы — для объяснений и расчётов. Ответы длиннее.',
    notes: 'Название, короткие пункты и итог одной строкой.',
  };
  function syncReplyStyle(settings) {
    const value = settings && REPLY_STYLES.includes(settings.replyStyle) ? settings.replyStyle : 'plain';
    state.replyStyle = value;
    const select = $('#setReplyStyle');
    if (select) select.value = value;
    setHint('setReplyStyleHint', REPLY_HINT[value]);
    document.body.dataset.replyStyle = value;
  }

  async function changeReplyStyle(next) {
    const bridge = api();
    const select = $('#setReplyStyle');
    if (!bridge || typeof bridge.setReplyStyle !== 'function') return;
    state.revision += 1;
    const prev = state.replyStyle || 'plain';
    if (select) select.disabled = true;
    try {
      const r = await bridge.setReplyStyle(next);
      if (!r || r.ok === false) throw new Error('ядро отклонило выбор');
      syncReplyStyle({ replyStyle: r.style });
    } catch (err) {
      if (select) select.value = prev;
      showError('Оформление ответов не сохранено: ' + String((err && err.message) || err));
    } finally {
      if (select) select.disabled = false;
    }
  }

  function bindTierCard() {
    const reply = $('#setReplyStyle');
    if (reply) reply.addEventListener('change', () => changeReplyStyle(REPLY_STYLES.includes(reply.value) ? reply.value : 'plain'));
    const tier = $('#setModelTier');
    const thinking = $('#setThinking');
    if (tier) tier.addEventListener('change', () => changeTier(tier.value === 'smart' ? 'smart' : 'fast'));
    if (thinking) thinking.addEventListener('change', () => changeThinking(['low', 'medium', 'high'].includes(thinking.value) ? thinking.value : 'low'));
  }

  // ── 4. «Сфера Nox»: вариант настоящий, тонкая настройка — превью ─
  const PREVIEW_KEY = 'jarvis.spherePreview';
  const PREVIEW_LIMITS = { size: [70, 120, 5], glow: [40, 160, 5] };
  const preview = { size: 100, glow: 100, orb: null, canvas: null };

  function readPreview() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREVIEW_KEY) || '{}');
      for (const key of ['size', 'glow']) {
        const [min, max] = PREVIEW_LIMITS[key];
        const num = Number(raw && raw[key]);
        if (Number.isFinite(num)) preview[key] = Math.min(max, Math.max(min, num));
      }
    } catch { /* битое значение: показываем значения по умолчанию */ }
  }

  function savePreview() {
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify({ size: preview.size, glow: preview.glow })); } catch { /* приватный режим */ }
  }

  function currentVariant() {
    try {
      if (window.NoxScreen && typeof window.NoxScreen.getVariant === 'function') return window.NoxScreen.getVariant() === 'wire' ? 'wire' : 'nox';
      return localStorage.getItem('noxOrb') === 'wire' ? 'wire' : 'nox';
    } catch { return 'nox'; }
  }

  function applyVariant(variant) {
    const value = variant === 'wire' ? 'wire' : 'nox';
    try {
      if (window.NoxScreen && typeof window.NoxScreen.setVariant === 'function') window.NoxScreen.setVariant(value);
      else localStorage.setItem('noxOrb', value);
    } catch { /* без экрана Nox вариант всё равно сохранится при следующем запуске */ }
    paintVariant(value);
    if (preview.orb) {
      try { preview.orb.setVariant(value); } catch { /* превью переживёт */ }
    }
  }

  function paintVariant(variant) {
    for (const b of $$('#sphereVariant [data-sphere-variant]')) {
      b.setAttribute('aria-checked', String(b.dataset.sphereVariant === variant));
      b.tabIndex = b.dataset.sphereVariant === variant ? 0 : -1;
    }
  }

  function paintPreviewValues() {
    const size = $('#sphereSize');
    const glow = $('#sphereGlow');
    const sizeValue = $('#sphereSizeValue');
    const glowValue = $('#sphereGlowValue');
    if (size) size.value = String(preview.size);
    if (glow) glow.value = String(preview.glow);
    if (sizeValue) sizeValue.textContent = preview.size + ' %';
    if (glowValue) glowValue.textContent = preview.glow + ' %';
  }

  function paintPreview() {
    const canvas = preview.canvas;
    if (!canvas) return;
    // Свечение превью — только оформление этого маленького образца: filter на canvas.
    const glow = preview.glow / 100;
    canvas.style.filter = `brightness(${(0.75 + glow * 0.35).toFixed(3)}) drop-shadow(0 0 ${Math.round((glow - 1) * 26 + 14)}px rgba(46,154,193,${(0.18 + glow * 0.16).toFixed(3)}))`;
    if (preview.orb) {
      try { preview.orb.setScale(0.62 * (preview.size / 100)); } catch { /* старый шар */ }
    }
  }

  function createPreviewOrb() {
    const canvas = $('#spherePreview');
    if (!canvas || typeof window.NoxOrb !== 'function') return;
    preview.canvas = canvas;
    if (preview.orb) {
      try { preview.orb.destroy(); } catch { /* уже снят */ }
      preview.orb = null;
    }
    try {
      const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      preview.orb = new window.NoxOrb(canvas, {
        variant: currentVariant(),
        state: 'idle',
        animated: !calm,
        scale: 0.62 * (preview.size / 100),
        dpr: Math.min(window.devicePixelRatio || 1, 2),
      });
    } catch { preview.orb = null; }
    paintPreview();
  }

  function resetPreview() {
    preview.size = 100;
    preview.glow = 100;
    savePreview();
    paintPreviewValues();
    paintPreview();
  }

  function bindSphereCard() {
    paintVariant(currentVariant());
    readPreview();
    paintPreviewValues();
    createPreviewOrb();

    const group = $('#sphereVariant');
    if (group) {
      group.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('[data-sphere-variant]') : null;
        if (!b) return;
        applyVariant(b.dataset.sphereVariant);
      });
      // Одна точка табуляции и стрелки, как у остальных радиогрупп окна.
      group.addEventListener('keydown', (e) => {
        const opts = $$('#sphereVariant [data-sphere-variant]');
        const i = opts.indexOf(document.activeElement);
        if (i < 0) return;
        let j = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % opts.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + opts.length) % opts.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = opts.length - 1;
        if (j < 0) return;
        e.preventDefault();
        opts[j].focus();
        applyVariant(opts[j].dataset.sphereVariant);
      });
    }

    const size = $('#sphereSize');
    const glow = $('#sphereGlow');
    if (size) size.addEventListener('input', () => {
      preview.size = Number(size.value) || 100;
      const label = $('#sphereSizeValue');
      if (label) label.textContent = preview.size + ' %';
      savePreview();
      paintPreview();
    });
    if (glow) glow.addEventListener('input', () => {
      preview.glow = Number(glow.value) || 100;
      const label = $('#sphereGlowValue');
      if (label) label.textContent = preview.glow + ' %';
      savePreview();
      paintPreview();
    });
    const reset = $('#sphereReset');
    if (reset) reset.addEventListener('click', resetPreview);
  }

  // ── 5. Запуск ─────────────────────────────────────────────────
  function onView(e) {
    if (e.detail !== 'settings') return;
    loadStatus();
    bindErrors(); // один раз: повторные вызовы ничего не добавят
  }

  function init() {
    bindErrors();
    bindTierCard();
    bindSphereCard();
    if (api() && typeof api().getSettings === 'function') {
      // Раздел мог быть открыт не первым: значения всё равно читаем сразу, чтобы
      // выбранные модель и обдумывание не показывались «по умолчанию».
      loadStatus();
    }
    document.addEventListener('jarvis:view', onView);
  }

  window.NoxSettings = {
    init,
    showError,
    getPreview() { return { ...preview, orb: undefined, canvas: undefined }; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
