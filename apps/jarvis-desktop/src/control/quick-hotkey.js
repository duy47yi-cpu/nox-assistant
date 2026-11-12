'use strict';

function normalizeQuickHotkey(value) {
  if (typeof value !== 'string') throw new Error('Укажите сочетание клавиш');
  const parts = value.split('+').map((part) => part.trim());
  const key = (parts.pop() || '').toUpperCase();
  const aliases = { CTRL: 'Control', CONTROL: 'Control', ALT: 'Alt', SHIFT: 'Shift', WIN: 'Super', SUPER: 'Super' };
  const mods = new Set(parts.map((part) => aliases[part.toUpperCase()]));
  if (mods.has(undefined) || mods.size === 0 || !/^(SPACE|[A-Z0-9]|F([1-9]|1[0-2]))$/.test(key)) throw new Error('Укажите сочетание, например Ctrl+Alt+Space');
  const normalized = [...['Control', 'Alt', 'Shift', 'Super'].filter((mod) => mods.has(mod)), key === 'SPACE' ? 'Space' : key].join('+');
  if (['Control+Alt+J', 'Control+Alt+M', 'Control+Alt+Shift+K'].includes(normalized)) throw new Error('Это сочетание уже использует Nox');
  return normalized;
}

// Register a replacement before releasing the working shortcut.
function createQuickHotkey({ register, unregister, activate }) {
  let key = null;
  return {
    state: () => ({ key, registered: key !== null }),
    set(next) {
      if (next === key && key !== null) return { ok: true, key };
      let registered = false;
      try { registered = register(next, activate) === true; } catch { /* invalid or unavailable accelerator */ }
      if (!registered) return { ok: false, key, error: 'Сочетание недоступно' };
      const previous = key;
      key = next;
      if (previous) unregister(previous);
      return { ok: true, key };
    },
  };
}
module.exports = { createQuickHotkey, normalizeQuickHotkey };
