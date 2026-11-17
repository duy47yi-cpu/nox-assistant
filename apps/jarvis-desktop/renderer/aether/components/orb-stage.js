/* Сцена сферы Nox Aether:
 * - монтирует живые движки обеих существующих систем (NoxOrb и JarvisOrb) через NoxOrbLibrary;
 * - мгновенно откликается на смену сферы и настроек в Мастерской Nox без перерисовки лишнего;
 * - рендерит подпись «The Nox» в книжной антикве (IBM Plex Serif / Times New Roman / Georgia / Sitka);
 * - показывает не-цветовую текстовую метку состояния и поддерживает плавный разделитель ширины. */
(() => {
  'use strict';

  const STATE_LABELS = {
    idle: 'Ждёт',
    thinking: 'Думает',
    searching: 'Ищет',
    acting: 'Работает',
    working: 'Работает',
    verifying: 'Проверяет',
    waiting_approval: 'Ждёт решения',
    listening: 'Слушает',
    speaking: 'Отвечает',
    success: 'Готово',
    partial: 'Выполнено частично',
    cancelled: 'Остановлено',
    error: 'Ошибка',
  };

  function createOrbStage({ store }) {
    const lib = window.NoxOrbLibrary;
    const boot = window.NoxAetherBoot;

    const stage = document.createElement('section');
    stage.className = 'ae-orb-stage';
    stage.id = 'aeOrbStage';
    stage.setAttribute('aria-label', 'Присутствие Nox');

    // Ручка изменения ширины панели сферы на широком окне
    const resizer = document.createElement('div');
    resizer.className = 'ae-orb-resizer';
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', 'Ширина панели сферы');
    resizer.tabIndex = 0;

    const inner = document.createElement('div');
    inner.className = 'ae-orb-inner';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'ae-orb-canvas-wrap';
    canvasWrap.setAttribute('role', 'button');
    canvasWrap.tabIndex = 0;
    canvasWrap.setAttribute('aria-label', 'Сфера Nox: нажмите для взаимодействия');

    const canvas = document.createElement('canvas');
    canvas.className = 'ae-orb-canvas';
    canvas.id = 'aeOrbCanvas';
    canvasWrap.append(canvas);

    const caption = document.createElement('div');
    caption.className = 'ae-orb-caption';

    const signature = document.createElement('div');
    signature.className = 'ae-orb-signature';
    signature.textContent = 'The Nox';

    const statusBadge = document.createElement('div');
    statusBadge.className = 'ae-orb-status';
    statusBadge.dataset.state = 'idle';
    const statusDot = document.createElement('span');
    statusDot.className = 'ae-orb-status-dot';
    statusDot.setAttribute('aria-hidden', 'true');
    const statusText = document.createElement('span');
    statusText.className = 'ae-orb-status-text';
    statusText.textContent = STATE_LABELS.idle;
    statusBadge.append(statusDot, statusText);

    const hintEl = document.createElement('div');
    hintEl.className = 'ae-orb-hint';
    hintEl.textContent = 'Нажмите для отклика';

    const voiceMeter = document.createElement('div');
    voiceMeter.className = 'ae-orb-voice-meter';
    voiceMeter.hidden = true;
    const voiceFill = document.createElement('span');
    voiceFill.className = 'ae-orb-voice-fill';
    voiceMeter.append(voiceFill);

    caption.append(signature, statusBadge, hintEl, voiceMeter);
    inner.append(canvasWrap, caption);
    stage.append(resizer, inner);

    let mounted = null;
    let currentOrbId = null;
    let lastState = 'idle';
    let lastMotionOn = true;
    let elapsedTimer = null;

    function getGlobalMotionOn() {
      const { aeOrbPos, animations, motion } = document.documentElement.dataset;
      return !stage.hidden && aeOrbPos !== 'hidden' && animations !== 'off' && motion !== 'off';
    }

    function applyWrapperLook(cfg) {
      const c = cfg || {};
      const opacity = Number.isFinite(Number(c.opacity)) ? Math.max(0.35, Math.min(1, Number(c.opacity))) : 1;
      const aura = Number.isFinite(Number(c.aura)) ? Math.max(0, Math.min(1.5, Number(c.aura))) : 1;
      canvas.style.opacity = String(opacity);
      canvasWrap.style.setProperty('--ae-orb-aura', String(aura));
    }

    function formatElapsedLabel(eff) {
      const base = STATE_LABELS[eff] || STATE_LABELS.idle;
      const turn = store.state.activeTurn;
      if (store.state.trackerBusy && turn && Number.isFinite(turn.startedAt)) {
        const sec = Math.max(0, (Date.now() - turn.startedAt) / 1000);
        return `${base} · ${sec.toFixed(1)} с`;
      }
      return base;
    }

    function updateStatusAndHint(st) {
      const eff = store.getOrbEffectiveState();
      stage.dataset.state = eff;
      statusBadge.dataset.state = eff;
      statusText.textContent = formatElapsedLabel(eff);

      if (st.trackerBusy) {
        hintEl.textContent = 'Нажмите на сферу, чтобы остановить';
        canvasWrap.setAttribute('aria-label', 'Остановить выполнение запроса');
      } else if (st.dictation && st.dictation.recording) {
        hintEl.textContent = 'Слушаю · нажмите, чтобы завершить';
        canvasWrap.setAttribute('aria-label', 'Выключить голосовой ввод');
      } else if (st.settings && st.settings.dictation) {
        hintEl.textContent = 'Нажмите на сферу, чтобы говорить';
        canvasWrap.setAttribute('aria-label', 'Включить голосовой ввод');
      } else {
        hintEl.textContent = 'Нажмите для отклика';
        canvasWrap.setAttribute('aria-label', 'Сфера Nox: нажмите для отклика');
      }
      canvasWrap.title = hintEl.textContent;
    }

    async function handleOrbActivate() {
      const st = store.state;
      if (mounted && typeof mounted.pulse === 'function') mounted.pulse(0.85);
      if (st.trackerBusy) {
        await store.stopRun();
        return;
      }
      if (st.settings?.dictation) await store.toggleDictation();
    }

    canvasWrap.addEventListener('click', handleOrbActivate);
    canvasWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleOrbActivate();
      }
    });

    function mountCurrentOrb() {
      if (!lib) return;
      const snap = lib.getSnapshot();
      const animOn = getGlobalMotionOn();
      applyWrapperLook(snap.activeSettings);
      if (mounted && currentOrbId === snap.activeId) {
        mounted.applySettings(snap.activeSettings, animOn);
        return;
      }
      if (mounted) {
        mounted.destroy();
        mounted = null;
      }
      currentOrbId = snap.activeId;
      stage.dataset.orbId = snap.activeId;
      stage.dataset.orbEngine = snap.activeSpec.engine;
      stage.dataset.orb = snap.activeSpec.variant;
      mounted = lib.mount(canvas, snap.activeId, {
        globalAnimated: animOn,
        state: lastState,
        stageEl: stage,
      });
    }

    // Переподключение и обновление цветов при смене сферы/настроек/темы
    const unsubOrb = lib ? lib.subscribe((snap) => {
      applyWrapperLook(snap.activeSettings);
      if (snap.activeId !== currentOrbId) {
        mountCurrentOrb();
      } else if (mounted) {
        mounted.applySettings(snap.activeSettings, getGlobalMotionOn());
      }
    }) : () => {};

    document.addEventListener('jarvis:themechange', () => {
      requestAnimationFrame(() => {
        if (mounted && typeof mounted.refreshColors === 'function') mounted.refreshColors();
      });
    });

    // ResizeObserver поддерживает чёткое масштабирование canvas без искажений
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => {
        if (mounted && typeof mounted.resize === 'function') mounted.resize();
      });
      ro.observe(canvasWrap);
    }

    // Логика перетаскивания разделителя ширины
    let dragging = false;
    let dragStartX = 0;
    let dragStartW = 400;
    resizer.addEventListener('pointerdown', (e) => {
      if (window.innerWidth < 760) return;
      dragging = true;
      dragStartX = e.clientX;
      dragStartW = stage.getBoundingClientRect().width || 400;
      resizer.setPointerCapture(e.pointerId);
      document.body.classList.add('ae-resizing');
    });
    resizer.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const pos = document.documentElement.dataset.aeOrbPos || 'right';
      const delta = pos === 'left' ? (e.clientX - dragStartX) : (dragStartX - e.clientX);
      const next = Math.max(260, Math.min(540, Math.round(dragStartW + delta)));
      document.documentElement.style.setProperty('--ae-orb-col', `${next}px`);
      if (mounted && typeof mounted.resize === 'function') mounted.resize();
    });
    function finishResize() {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('ae-resizing');
      if (boot) {
        const cur = boot.readWorkshop();
        const px = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ae-orb-col'), 10);
        if (Number.isFinite(px)) {
          const updated = { ...cur, orbSplitPx: Math.max(260, Math.min(540, px)) };
          try { localStorage.setItem(boot.WORKSHOP_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
          boot.applyWorkshopToDom(updated);
        }
      }
    }
    resizer.addEventListener('pointerup', finishResize);
    resizer.addEventListener('pointercancel', finishResize);

    resizer.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const curPx = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ae-orb-col'), 10) || 400;
      const pos = document.documentElement.dataset.aeOrbPos || 'right';
      const step = (e.key === 'ArrowLeft' ? (pos === 'left' ? -16 : 16) : (pos === 'left' ? 16 : -16));
      const next = Math.max(260, Math.min(540, curPx + step));
      document.documentElement.style.setProperty('--ae-orb-col', `${next}px`);
      if (boot) {
        const cur = boot.readWorkshop();
        const updated = { ...cur, orbSplitPx: next };
        try { localStorage.setItem(boot.WORKSHOP_KEY, JSON.stringify(updated)); } catch { /* ignore */ }
      }
    });

    function syncElapsedTimer(busy) {
      if (busy && !elapsedTimer) {
        elapsedTimer = setInterval(() => {
          updateStatusAndHint(store.state);
        }, 200);
      } else if (!busy && elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
    }

    function render(st) {
      const motionOn = getGlobalMotionOn();
      if (!mounted) mountCurrentOrb();
      if (motionOn !== lastMotionOn) {
        lastMotionOn = motionOn;
        if (mounted) mounted.setAnimated(motionOn);
      }

      const eff = store.getOrbEffectiveState();
      if (eff !== lastState) {
        lastState = eff;
        if (mounted) mounted.setState(eff);
      }
      updateStatusAndHint(st);
      syncElapsedTimer(st.trackerBusy && !stage.hidden);

      if (mounted) {
        mounted.setVoice(st.dictation.recording ? st.dictation.level : 0);
      }
      voiceMeter.hidden = !st.dictation.recording;
      if (st.dictation.recording) {
        const pct = Math.max(6, Math.round((st.dictation.level || 0) * 100));
        voiceFill.style.width = `${pct}%`;
      }
    }

    // Совместимость со скриптом проверки вариантов NoxScreen
    window.NoxScreen = {
      setVariant(v) {
        if (!lib) return;
        const id = `nox:${v}`;
        if (lib.get(id)) lib.setActive(id);
      },
      geometry() {
        const rect = canvas.getBoundingClientRect();
        return { width: rect.width, height: rect.height, orbId: currentOrbId };
      },
    };

    mountCurrentOrb();

    return {
      el: stage,
      render,
      pulse: (p) => mounted && mounted.pulse(p),
      gesture: (kind, caret) => mounted && mounted.gesture(kind, caret),
      setComposer: (txt) => mounted && mounted.setComposer(txt),
      destroy: () => {
        if (elapsedTimer) clearInterval(elapsedTimer);
        unsubOrb();
        if (mounted) mounted.destroy();
      },
    };
  }

  window.NoxAetherOrbStage = { createOrbStage, STATE_LABELS };
})();
