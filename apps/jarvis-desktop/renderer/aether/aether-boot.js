/* Инициализация Nox Aether до первой отрисовки:
 * - применяет тёплую тёмную палитру по умолчанию, если пользователь ещё не выбирал тему в Aether;
 * - восстанавливает выбранный режим движения, размер и шрифт подписи «The Nox»;
 * - не обращается к внешним серверам и не меняет чужие настройки при откате на прошлый интерфейс. */
(() => {
  'use strict';

  const WORKSHOP_KEY = 'aether.workshop';
  const THEME_CHOSEN_KEY = 'aether.themeChosen';
  const LEGACY_ORB_ANIM_KEY = 'jarvis.orbAnim';
  const MOTION_KEY = 'aether.motion';

  const DEFAULT_WORKSHOP = {
    signatureFont: 'plex', // 'plex' | 'times' | 'georgia' | 'sitka'
    chatWidth: 'medium',   // 'narrow' | 'medium' | 'wide'
    orbPosition: 'right',  // 'right' | 'left' | 'top' | 'hidden'
    density: 'calm',       // 'calm' | 'compact'
    orbSplitPx: 400,       // ширина панели сферы на широких окнах
    accentGlow: true,      // мягкое тепло вокруг сферы
  };

  function readWorkshop() {
    try {
      const raw = JSON.parse(localStorage.getItem(WORKSHOP_KEY) || '{}');
      return { ...DEFAULT_WORKSHOP, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch {
      return { ...DEFAULT_WORKSHOP };
    }
  }

  function applyWorkshopToDom(cfg) {
    const c = cfg || readWorkshop();
    const root = document.documentElement;
    root.dataset.aether = 'true';
    root.dataset.aeWidth = ['narrow', 'medium', 'wide'].includes(c.chatWidth) ? c.chatWidth : 'medium';
    root.dataset.aeOrbPos = ['right', 'left', 'top', 'hidden'].includes(c.orbPosition) ? c.orbPosition : 'right';
    root.dataset.aeDensity = ['calm', 'compact'].includes(c.density) ? c.density : 'calm';
    root.dataset.aeGlow = c.accentGlow === false ? 'off' : 'on';

    const sigMap = {
      plex: '"IBM Plex Serif", "Times New Roman", Georgia, serif',
      times: '"Times New Roman", "Liberation Serif", Georgia, serif',
      georgia: 'Georgia, "Times New Roman", serif',
      sitka: '"Sitka Heading", "Sitka Text", Georgia, "Times New Roman", serif',
    };
    const sigFont = sigMap[c.signatureFont] || sigMap.plex;
    root.style.setProperty('--ae-serif-head', sigFont);

    const split = Number(c.orbSplitPx);
    if (Number.isFinite(split)) {
      const clamped = Math.max(260, Math.min(540, Math.round(split)));
      root.style.setProperty('--ae-orb-col', `${clamped}px`);
    }
  }

  function boot() {
    const root = document.documentElement;
    const T = window.JarvisTheme;
    // Первый вход в Aether: ставим спокойную тёмную тему (Concept B), пока владелец сам не выберет иную.
    try {
      const chosen = localStorage.getItem(THEME_CHOSEN_KEY) === '1';
      if (T && typeof T.apply === 'function' && !chosen) {
        T.apply('dark');
      }
    } catch { /* без localStorage работаем на дефолте */ }

    try {
      const orbAnim = localStorage.getItem(LEGACY_ORB_ANIM_KEY);
      root.dataset.motion = orbAnim === '0' ? 'off' : 'on';
      const anim = localStorage.getItem(MOTION_KEY);
      root.dataset.animations = anim === 'off' ? 'off' : 'on';
    } catch {
      root.dataset.motion = 'on';
      root.dataset.animations = 'on';
    }

    applyWorkshopToDom(readWorkshop());
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    boot();
    window.NoxAetherBoot = { DEFAULT_WORKSHOP, readWorkshop, applyWorkshopToDom, WORKSHOP_KEY, THEME_CHOSEN_KEY };
  }
})();
