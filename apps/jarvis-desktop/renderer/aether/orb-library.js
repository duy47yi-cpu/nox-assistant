/* Orb Library для Nox Aether.
 *
 * Оставлено только 2 сферы по запросу владельца (скриншоты от 2026-11-15):
 *   - 'nox:nox'  — Сфера Nox (точки Фибоначчи и мягкое ядро)
 *   - 'nox:wire' — Сетка Nox (проволочная геометрия и пояс)
 * Остальные варианты (nox:shutter, jarvis:core/sphere/iris) удалены из встроенного списка.
 *
 * Возможности библиотеки:
 * - независимые настройки для каждой сферы + сброс к умолчанию;
 * - именованные пресеты без потери индивидуальных параметров при переключении;
 * - регистрация будущих/пользовательских сфер через registerOrb();
 * - единое сопоставление состояний помощника и голосового уровня на оба движка. */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'aether.orbLibrary';
  const DEFAULT_ORB_ID = 'nox:wire';

  const STATE_TO_NOX = {
    idle: 'idle',
    listening: 'listening',
    thinking: 'thinking',
    searching: 'thinking',
    speaking: 'speaking',
    acting: 'thinking',
    verifying: 'thinking',
    waiting_approval: 'waiting_approval',
    success: 'success',
    cancelled: 'idle',
    error: 'error',
  };

  const STATE_TO_JARVIS = {
    idle: 'idle',
    attentive: 'listening',
    listening: 'listening',
    thinking: 'thinking',
    searching: 'searching',
    speaking: 'speaking',
    acting: 'acting',
    verifying: 'verifying',
    waiting_approval: 'waiting_approval',
    success: 'success',
    cancelled: 'cancelled',
    error: 'error',
  };

  // Оставлены только выбранные владельцем сферы — см. скриншоты Библиотеки сфер
  const BUILTIN_ORBS = [
    {
      id: 'nox:nox',
      engine: 'nox',
      variant: 'nox',
      name: 'Сфера Nox',
      systemLabel: 'Система Nox',
      subtitle: 'Облако точек Фибоначчи и объёмное свечение ядра',
      defaults: { scale: 1, animated: true, voiceReact: true },
      fields: [
        { key: 'scale', label: 'Масштаб сферы', min: 0.65, max: 1.35, step: 0.05, kind: 'range' },
        { key: 'animated', label: 'Плавное движение', kind: 'switch' },
        { key: 'voiceReact', label: 'Реакция на голос', kind: 'switch' },
      ],
      presets: {
        default: { name: 'Баланс', patch: { scale: 1, animated: true, voiceReact: true } },
        calm: { name: 'Спокойная', patch: { scale: 0.9, animated: true, voiceReact: false } },
        vivid: { name: 'Выразительная', patch: { scale: 1.15, animated: true, voiceReact: true } },
      },
    },
    {
      id: 'nox:wire',
      engine: 'nox',
      variant: 'wire',
      name: 'Сетка Nox',
      systemLabel: 'Система Nox',
      subtitle: 'Проволочная геометрическая сфера с экваториальным поясом',
      defaults: { scale: 1, animated: true, voiceReact: true },
      fields: [
        { key: 'scale', label: 'Масштаб сферы', min: 0.65, max: 1.35, step: 0.05, kind: 'range' },
        { key: 'animated', label: 'Плавное движение', kind: 'switch' },
        { key: 'voiceReact', label: 'Реакция на голос', kind: 'switch' },
      ],
      presets: {
        default: { name: 'Баланс', patch: { scale: 1, animated: true, voiceReact: true } },
        calm: { name: 'Спокойная', patch: { scale: 0.9, animated: true, voiceReact: false } },
        vivid: { name: 'Выразительная', patch: { scale: 1.15, animated: true, voiceReact: true } },
      },
    },
  ];

  function createOrbLibrary(options = {}) {
    const storage = options.storage !== undefined
      ? options.storage
      : (typeof localStorage !== 'undefined' ? localStorage : null);
    const getWin = () => (options.win || (typeof window !== 'undefined' ? window : {}));
    const registry = new Map();

    const WRAPPER_DEFAULTS = { opacity: 1, aura: 1 };
    const WRAPPER_FIELDS = [
      { key: 'opacity', label: 'Прозрачность сферы', min: 0.35, max: 1, step: 0.05, kind: 'range' },
      { key: 'aura', label: 'Ореол сцены', min: 0, max: 1.5, step: 0.05, kind: 'range' },
    ];

    function cloneSpec(item, withWrapper = false) {
      const baseFields = Array.isArray(item.fields) ? item.fields.map((f) => ({ ...f })) : [];
      const extraFields = withWrapper
        ? WRAPPER_FIELDS.filter((wf) => !baseFields.some((f) => f.key === wf.key)).map((f) => ({ ...f }))
        : [];
      return {
        ...item,
        defaults: { ...(withWrapper ? WRAPPER_DEFAULTS : {}), ...(item.defaults || {}) },
        fields: [...baseFields, ...extraFields],
        presets: item.presets ? Object.fromEntries(Object.entries(item.presets).map(([k, p]) => [k, { ...p, patch: { ...p.patch } }])) : {},
      };
    }

    for (const item of BUILTIN_ORBS) registry.set(item.id, cloneSpec(item, true));

    function sanitizeField(field, value, fallback) {
      if (field.kind === 'switch') {
        return typeof value === 'boolean' ? value : Boolean(fallback);
      }
      if (field.kind === 'range') {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(field.max, Math.max(field.min, Math.round(n * 100) / 100));
      }
      return value !== undefined ? value : fallback;
    }

    function normalizeSettings(spec, raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const out = { ...(spec.defaults || {}) };
      for (const field of spec.fields || []) {
        out[field.key] = sanitizeField(field, src[field.key], spec.defaults[field.key]);
      }
      if (typeof src.presetId === 'string') out.presetId = src.presetId;
      return out;
    }

    function readRawStore() {
      if (!storage || typeof storage.getItem !== 'function') return null;
      try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }

    function inferInitialOrb() {
      if (storage && typeof storage.getItem === 'function') {
        try {
          const legacyNox = storage.getItem('noxOrb');
          if (legacyNox && registry.has(`nox:${legacyNox}`)) return `nox:${legacyNox}`;
          const legacyJarvis = storage.getItem('jarvis.orbVariant');
          if (legacyJarvis) {
            const v = legacyJarvis === 'reactor' ? 'core' : legacyJarvis;
            if (registry.has(`jarvis:${v}`)) return `jarvis:${v}`;
          }
        } catch { /* ignore */ }
      }
      return DEFAULT_ORB_ID;
    }

    function loadState() {
      const saved = readRawStore();
      const activeId = saved && typeof saved.activeId === 'string' && registry.has(saved.activeId)
        ? saved.activeId
        : inferInitialOrb();
      const byId = {};
      const savedMap = saved && saved.byId && typeof saved.byId === 'object' ? saved.byId : {};
      for (const [id, spec] of registry.entries()) {
        byId[id] = normalizeSettings(spec, savedMap[id]);
      }
      return { activeId, byId };
    }

    let state = loadState();
    const listeners = new Set();

    function saveState() {
      if (!storage || typeof storage.setItem !== 'function') return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ activeId: state.activeId, byId: state.byId }));
        const spec = registry.get(state.activeId);
        if (spec && spec.engine === 'nox') storage.setItem('noxOrb', spec.variant);
        if (spec && spec.engine === 'jarvis') storage.setItem('jarvis.orbVariant', spec.variant);
      } catch { /* игнорируем квоту/отсутствие storage */ }
    }

    function emitChange() {
      const snapshot = getSnapshot();
      for (const cb of listeners) {
        try { cb(snapshot); } catch { /* изоляция слушателей */ }
      }
    }

    function getSnapshot() {
      const spec = registry.get(state.activeId) || registry.get(DEFAULT_ORB_ID);
      return {
        activeId: spec.id,
        activeSpec: cloneSpec(spec),
        activeSettings: { ...(state.byId[spec.id] || spec.defaults) },
        orbs: list(),
      };
    }

    function list() {
      return [...registry.values()].map((s) => ({
        ...cloneSpec(s),
        settings: { ...(state.byId[s.id] || s.defaults) },
      }));
    }

    function get(id) {
      return registry.has(id) ? cloneSpec(registry.get(id)) : null;
    }

    function getSettings(id = state.activeId) {
      const spec = registry.get(id) || registry.get(state.activeId);
      return { ...(state.byId[spec.id] || spec.defaults) };
    }

    function setActive(id) {
      if (!registry.has(id)) return false;
      if (state.activeId === id) return true;
      state.activeId = id;
      saveState();
      syncJarvisTuneStorage(id);
      emitChange();
      return true;
    }

    function syncJarvisTuneStorage(id) {
      const spec = registry.get(id);
      const w = getWin();
      if (!spec || spec.engine !== 'jarvis' || !w.JarvisOrbTune || typeof w.JarvisOrbTune.set !== 'function') return;
      const cfg = state.byId[id] || spec.defaults;
      w.JarvisOrbTune.set(spec.variant, {
        glow: cfg.glow,
        speed: cfg.speed,
        motion: cfg.motion,
        depth: cfg.depth,
        voice: cfg.voice,
        voiceGain: cfg.voiceGain,
        ...(spec.variant === 'sphere' ? { density: cfg.density } : {}),
      });
    }

    function updateSettings(id, patch) {
      const spec = registry.get(id);
      if (!spec || !patch || typeof patch !== 'object') return getSettings(id);
      const next = normalizeSettings(spec, { ...(state.byId[id] || spec.defaults), ...patch, presetId: undefined });
      state.byId[id] = next;
      saveState();
      if (spec.engine === 'jarvis') syncJarvisTuneStorage(id);
      emitChange();
      return { ...next };
    }

    function applyPreset(id, presetKey) {
      const spec = registry.get(id);
      if (!spec || !spec.presets || !spec.presets[presetKey]) return getSettings(id);
      const next = normalizeSettings(spec, { ...spec.defaults, ...spec.presets[presetKey].patch, presetId: presetKey });
      state.byId[id] = next;
      saveState();
      if (spec.engine === 'jarvis') syncJarvisTuneStorage(id);
      emitChange();
      return { ...next };
    }

    function resetOrb(id) {
      const spec = registry.get(id);
      if (!spec) return null;
      state.byId[id] = normalizeSettings(spec, { ...spec.defaults, presetId: 'default' });
      saveState();
      if (spec.engine === 'jarvis') {
        const w = getWin();
        if (w.JarvisOrbTune && typeof w.JarvisOrbTune.set === 'function') w.JarvisOrbTune.set(spec.variant, null);
      }
      emitChange();
      return { ...state.byId[id] };
    }

    function registerOrb(customSpec) {
      if (!customSpec || typeof customSpec.id !== 'string' || !customSpec.id.trim()) {
        throw new Error('registerOrb: требуется строковый id');
      }
      const spec = cloneSpec({
        engine: 'custom',
        variant: customSpec.variant || customSpec.id,
        systemLabel: customSpec.systemLabel || 'Пользовательская',
        defaults: {},
        fields: [],
        presets: {},
        ...customSpec,
      });
      registry.set(spec.id, spec);
      const saved = readRawStore();
      const rawCfg = saved && saved.byId && saved.byId[spec.id];
      state.byId[spec.id] = normalizeSettings(spec, rawCfg || spec.defaults);
      emitChange();
      return cloneSpec(spec);
    }

    function mapState(engine, appState) {
      const key = String(appState || 'idle');
      return engine === 'nox' ? (STATE_TO_NOX[key] || 'idle') : (STATE_TO_JARVIS[key] || 'idle');
    }

    // Создаёт обёртку поверх живого движка (NoxOrb / JarvisOrb / Custom factory) без правки оригиналов.
    function mount(canvas, orbId = state.activeId, opts = {}) {
      const w = getWin();
      const spec = registry.get(orbId) || registry.get(DEFAULT_ORB_ID);
      const cfg = getSettings(spec.id);
      const globalAnim = opts.globalAnimated !== false;
      const densityMul = Number.isFinite(opts.density) ? opts.density : 1;
      const stageEl = opts.stageEl || (canvas && canvas.closest ? canvas.closest('#stage') : null);
      if (stageEl && stageEl.dataset) stageEl.dataset.orb = spec.variant;

      let instance = null;
      if (spec.engine === 'custom' && typeof spec.create === 'function') {
        instance = spec.create(canvas, { ...cfg, state: opts.state || 'idle', animated: globalAnim && cfg.animated !== false });
      } else if (spec.engine === 'nox' && typeof w.NoxOrb === 'function') {
        if (w.NoxOrb) w.NoxOrb.ignoreSystemMotion = true;
        instance = new w.NoxOrb(canvas, {
          variant: spec.variant,
          colorway: spec.variant === 'wire' ? 'green' : undefined,
          state: mapState('nox', opts.state || 'idle'),
          scale: cfg.scale || 1,
          animated: globalAnim && cfg.animated !== false,
        });
      } else if (spec.engine === 'jarvis' && typeof w.JarvisOrb === 'function') {
        if (w.JarvisOrb) w.JarvisOrb.ignoreSystemMotion = true;
        syncJarvisTuneStorage(spec.id);
        const baseDensity = Number.isFinite(Number(cfg.density)) ? Number(cfg.density) : 1;
        instance = new w.JarvisOrb(canvas, {
          variant: spec.variant,
          state: mapState('jarvis', opts.state || 'idle'),
          density: baseDensity * densityMul,
          animated: globalAnim && cfg.animated !== false,
        });
        if (typeof instance.setTune === 'function') {
          instance.setTune({
            glow: cfg.glow,
            speed: cfg.speed,
            motion: cfg.motion,
            depth: cfg.depth,
            voice: cfg.voice,
            voiceGain: cfg.voiceGain,
            density: baseDensity * densityMul,
          });
        }
      }

      const handle = {
        orbId: spec.id,
        engine: spec.engine,
        variant: spec.variant,
        raw: instance,
        setState(appState) {
          if (!instance || typeof instance.setState !== 'function') return;
          instance.setState(mapState(spec.engine, appState));
        },
        setVoice(level) {
          if (!instance || typeof instance.setVoice !== 'function') return;
          const liveCfg = getSettings(spec.id);
          const enabled = spec.engine === 'nox' ? liveCfg.voiceReact !== false : liveCfg.voice !== false;
          instance.setVoice(enabled ? level : 0);
        },
        setAnimated(on) {
          if (!instance || typeof instance.setAnimated !== 'function') return;
          const liveCfg = getSettings(spec.id);
          instance.setAnimated(Boolean(on) && liveCfg.animated !== false);
        },
        applySettings(nextCfg, gAnim = globalAnim) {
          if (!instance) return;
          const c = nextCfg || getSettings(spec.id);
          if (spec.engine === 'nox') {
            if (typeof instance.setScale === 'function') instance.setScale(c.scale || 1);
            if (typeof instance.setAnimated === 'function') instance.setAnimated(Boolean(gAnim) && c.animated !== false);
          } else if (spec.engine === 'jarvis') {
            if (typeof instance.setTune === 'function') {
              const baseDensity = Number.isFinite(Number(c.density)) ? Number(c.density) : 1;
              instance.setTune({
                glow: c.glow, speed: c.speed, motion: c.motion, depth: c.depth,
                voice: c.voice, voiceGain: c.voiceGain, density: baseDensity * densityMul,
              });
            }
            if (typeof instance.setAnimated === 'function') instance.setAnimated(Boolean(gAnim) && c.animated !== false);
          } else if (typeof instance.updateSettings === 'function') {
            instance.updateSettings(c);
          }
        },
        setComposer(text) {
          if (instance && typeof instance.setComposer === 'function') instance.setComposer(text);
        },
        gesture(kind, caret) {
          if (instance && typeof instance.gesture === 'function') instance.gesture(kind, caret);
        },
        pulse(power = 0.6) {
          if (instance && typeof instance.pulse === 'function') instance.pulse(power);
        },
        refreshColors() {
          if (instance && typeof instance._readColors === 'function') {
            instance._readColors();
            if (typeof instance._draw === 'function') instance._draw();
          }
        },
        resize() {
          if (instance && typeof instance.resize === 'function') instance.resize();
        },
        destroy() {
          if (instance && typeof instance.destroy === 'function') instance.destroy();
          instance = null;
        },
      };
      return handle;
    }

    function subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }

    return {
      STORAGE_KEY,
      DEFAULT_ORB_ID,
      list,
      get,
      getActiveId: () => state.activeId,
      setActive,
      getSettings,
      updateSettings,
      applyPreset,
      resetOrb,
      registerOrb,
      mapState,
      mount,
      getSnapshot,
      subscribe,
    };
  }

  const exported = { BUILTIN_ORBS, STORAGE_KEY, DEFAULT_ORB_ID, createOrbLibrary };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root && typeof window !== 'undefined') {
    root.NoxOrbLibraryFactory = exported;
    root.NoxOrbLibrary = createOrbLibrary();
  }
})(typeof window !== 'undefined' ? window : globalThis);
