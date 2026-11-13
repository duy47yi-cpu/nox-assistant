/* Тонкий мост к window.jarvis (preload.js) с защитой от падений и честной деградацией. */
(() => {
  'use strict';

  const U = window.JarvisUI || {};

  function ensureBridge() {
    if (window.jarvis) return Promise.resolve('ipc');
    if (typeof U.ensureBridge === 'function') return U.ensureBridge();
    return Promise.resolve('none');
  }

  function has(name) {
    return Boolean(window.jarvis && typeof window.jarvis[name] === 'function');
  }

  function call(name, ...args) {
    if (!has(name)) return Promise.reject(new Error(`метод ${name} недоступен`));
    return window.jarvis[name](...args);
  }

  function errText(err) {
    const raw = err && typeof err === 'object' && err.message ? err.message : String(err || 'неизвестная ошибка');
    return typeof U.scrub === 'function' ? U.scrub(raw) : raw;
  }

  function subscribeEvents(onAgent, onDict) {
    const off = [];
    if (typeof onAgent === 'function' && has('onEvent')) {
      off.push(window.jarvis.onEvent((ev) => onAgent(ev)));
    }
    if (typeof onDict === 'function' && has('onDictationEvent')) {
      off.push(window.jarvis.onDictationEvent((ev) => onDict(ev)));
    }
    return () => {
      for (const fn of off) {
        try { if (typeof fn === 'function') fn(); } catch { /* ignore */ }
      }
    };
  }

  window.NoxAetherBridge = { ensureBridge, has, call, errText, subscribeEvents };
})();
