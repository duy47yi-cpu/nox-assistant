'use strict';

// Read-only UI audit driver for the working tree. It starts a real Electron window with an
// isolated profile/data root, changes themes through the visible settings controls, records
// computed styles and captures a small set of representative screens. It never invokes tools.
const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow, dialog, globalShortcut } = electron;
const repo = path.resolve(__dirname, '../../../../');
const appRoot = path.join(repo, 'apps', 'jarvis-desktop');
const evidence = __dirname;
const extraViews = process.argv[2] === 'extra-views';
const tempRoot = path.join(evidence, 'electron-temp', extraViews ? 'theme-probe-extra-r1' : 'theme-probe-v2');
const profileDir = path.join(tempRoot, 'profile');
const dataDir = path.join(tempRoot, 'data');
const workspaceDir = path.join(tempRoot, 'workspace');
for (const dir of [profileDir, dataDir, workspaceDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false,
  desktopOverlay: false, alwaysOnTop: false, motion: false, seededBrief: true,
  modelTier: 'fast', thinking: 'low', keepAwake: 'off', clipboardHistory: false, quiet: true,
}), 'utf8');

for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = dataDir;
app.setPath('userData', profileDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
try {
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
  dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  dialog.showMessageBoxSync = () => 0;
  dialog.showErrorBox = () => {};
} catch {}
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const paths = require(path.join(appRoot, 'src', 'config', 'paths.js'));
paths.projectRoot = () => tempRoot;

const THEMES = [
  'dark', 'light', 'graphite', 'lime', 'paper', 'forest', 'wine', 'cobalt', 'aurora', 'ember',
  'dawn', 'glass', 'liquid', 'liquidday', 'frost', 'gradient', 'gradientday', 'midnight',
  'neon', 'starry', 'moonlight', 'sunrise', 'system',
];
const SAMPLE_THEMES = new Set(extraViews ? ['dark', 'light'] : ['dark', 'light', 'glass']);
const SAMPLE_VIEWS = extraViews ? ['journal', 'deals', 'account'] : ['nox', 'dialog', 'commands', 'mcp', 'settings'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (win, code, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    try { const v = await win.webContents.executeJavaScript(code, true); if (v) return v; }
    catch (err) { last = err && err.message ? err.message : String(err); }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last}` : ''}`);
};
const js = (win, code) => win.webContents.executeJavaScript(code, true);
const sampleJs = `(() => {
  const css = (el) => el ? getComputedStyle(el) : null;
  const props = (el, names) => {
    const s = css(el); const out = {};
    if (s) for (const n of names) out[n] = s.getPropertyValue(n).trim();
    return out;
  };
  const root = getComputedStyle(document.documentElement);
  const body = document.body;
  const app = document.querySelector('.app');
  const rail = document.querySelector('.rail');
  const content = body.dataset.view === 'settings' ? document.querySelector('#setPanel')
    : body.dataset.view === 'commands' ? document.querySelector('#cmdCatalog')
    : body.dataset.view === 'mcp' ? document.querySelector('#mcpPage')
    : body.dataset.view === 'dialog' ? document.querySelector('.view-dialog')
    : ['journal', 'deals', 'account'].includes(body.dataset.view) ? document.querySelector('.view:not([hidden]) .page')
    : document.querySelector('.nox-grid');
  const card = body.dataset.view === 'settings' ? document.querySelector('.set-section')
    : body.dataset.view === 'commands' ? document.querySelector('#cmdCatalog .cmd-row, #cmdCatalog .cmd-pack')
    : body.dataset.view === 'mcp' ? document.querySelector('#mcpPage .mcp-card, #mcpPage article')
    : body.dataset.view === 'dialog' ? document.querySelector('.view-dialog .composer, .view-dialog .turn, .view-dialog .msg')
    : body.dataset.view === 'journal' ? document.querySelector('#histSearch')
    : body.dataset.view === 'deals' ? document.querySelector('#dealsPage .deal-card, #dealsPage button')
    : body.dataset.view === 'account' ? document.querySelector('#accountPage .account-card:not([hidden]), #accountPage .account-local')
    : document.querySelector('.nox-history, .nox-chat, .nox-orb-panel');
  const values = (el) => el ? {
    background: css(el).backgroundColor,
    color: css(el).color,
    font: css(el).fontFamily,
    border: css(el).borderColor,
    radius: css(el).borderRadius,
  } : null;
  return {
    view: body.dataset.view,
    theme: document.documentElement.dataset.theme,
    storedTheme: (() => { try { return JSON.parse(localStorage.getItem('jarvis.theme')); } catch { return null; } })(),
    systemPrefersLight: matchMedia('(prefers-color-scheme: light)').matches,
    root: props(document.documentElement, ['--bg','--surface','--surface-2','--text','--text-2','--text-3','--hue','--font','--font-head','--font-reply','--panel-r','--glass-blur','--win-alpha','--win-radius']),
    viewTokens: props(body, ['--nox-bg','--nox-surface-1','--nox-surface-2','--nox-border','--nox-text-1','--nox-text-2','--nox-text-3','--nox-accent','--font','--font-head','--font-reply']),
    app: values(app), rail: values(rail), content: values(content), card: values(card),
    activeRail: values(document.querySelector('.rail-item[aria-current="page"]')),
    pageBg: css(body).backgroundColor,
    ...( ['journal', 'deals', 'account'].includes(body.dataset.view) && content
      ? { text: content.innerText.slice(0, 800) } : {} ),
  };
})()`;

async function inspect(win) {
  const matrix = [];
  const screenshotFiles = [];
  await waitFor(win, `Boolean(window.JarvisNox && document.querySelector('[data-theme-opt="dark"]'))`, 'renderer ready');
  await js(win, `window.JarvisNox.show('settings')`);
  await waitFor(win, `document.body.dataset.view === 'settings'`, 'settings view');
  for (const theme of THEMES) {
    if (extraViews) await js(win, `window.JarvisNox.show('settings')`);
    const clicked = await js(win, `(() => { const b = document.querySelector('[data-theme-opt=${JSON.stringify(theme)}]'); if (!b) return false; b.click(); return true; })()`);
    if (!clicked) throw new Error(`theme option missing: ${theme}`);
    await sleep(450);
    const snapshot = { selected: theme, views: [] };
    for (const view of SAMPLE_VIEWS) {
      await js(win, `window.JarvisNox.show(${JSON.stringify(view)})`);
      await waitFor(win, `document.body.dataset.view === ${JSON.stringify(view)}`, `${theme}/${view}`);
      await sleep(180);
      const styles = await js(win, sampleJs);
      snapshot.views.push(styles);
      if (SAMPLE_THEMES.has(theme)) {
        const safeName = view === 'mcp' ? 'connections' : view === 'nox' ? 'chat' : view === 'dialog' ? 'classic-chat' : view;
        const file = `${safeName}-${theme}-1200-v2.png`;
        const png = (await win.webContents.capturePage()).toPNG();
        fs.writeFileSync(path.join(extraViews ? tempRoot : evidence, file), png);
        screenshotFiles.push(file);
      }
    }
    matrix.push(snapshot);
  }
  if (extraViews) {
    fs.writeFileSync(path.join(tempRoot, 'theme-matrix.json'), JSON.stringify({ themes: matrix, screenshots: screenshotFiles }, null, 2));
    console.log(JSON.stringify({ themes: matrix.length, screenshots: screenshotFiles.length, tempRoot }));
    app.quit();
    return;
  }

  // Exercise the visible user controls for the other cross-cutting appearance settings too.
  await js(win, `window.JarvisNox.show('settings')`);
  await waitFor(win, `document.body.dataset.view === 'settings'`, 'return settings');
  await js(win, `(() => {
    const theme = document.querySelector('[data-theme-opt="light"]'); if (theme) theme.click();
    const hex = document.querySelector('.accent-hex');
    if (hex) { hex.value = '#FF0000'; hex.dispatchEvent(new Event('change', { bubbles: true })); }
    const setSelect = (key, value) => { const s = document.querySelector('select[data-look-key="' + key + '"]'); if (s) { s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); } };
    const setSegment = (key, value) => { const b = document.querySelector('.look-seg[data-look-key="' + key + '"] button[data-id="' + value + '"]'); if (b) b.click(); };
    setSelect('ui', 'book'); setSelect('head', 'georgia'); setSelect('reply', 'ui');
    setSegment('size', 'xl'); setSegment('round', 'l'); setSegment('panel', 'xl');
    setSegment('blur', 'off'); setSegment('bg', 'solid'); setSegment('winAlpha', '25');
    setSegment('winRadius', '28'); setSegment('orb', 'l');
    const glow = document.querySelector('input[data-look-key="glow"]');
    if (glow && glow.checked) { glow.checked = false; glow.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  })()`);
  await sleep(500);
  const userSettings = await js(win, `(() => ({
    theme: JSON.parse(localStorage.getItem('jarvis.theme') || 'null'),
    accent: JSON.parse(localStorage.getItem('jarvis.accent') || 'null'),
    look: JSON.parse(localStorage.getItem('jarvis.look') || 'null'),
    themeTokens: { bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), hue: getComputedStyle(document.documentElement).getPropertyValue('--hue').trim(), userHue: getComputedStyle(document.documentElement).getPropertyValue('--user-hue').trim() },
    lookTokens: { font: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(), head: getComputedStyle(document.documentElement).getPropertyValue('--font-head').trim(), reply: getComputedStyle(document.documentElement).getPropertyValue('--font-reply').trim(), size: getComputedStyle(document.documentElement).getPropertyValue('--fs-md').trim(), panelRadius: getComputedStyle(document.documentElement).getPropertyValue('--panel-r').trim(), blur: getComputedStyle(document.documentElement).getPropertyValue('--glass-blur').trim(), alpha: getComputedStyle(document.documentElement).getPropertyValue('--win-alpha').trim(), windowRadius: getComputedStyle(document.documentElement).getPropertyValue('--win-radius').trim() },
    accentInfo: window.JarvisTheme.getAccentInfo(),
  }))()`);
  const customLookViews = [];
  for (const view of ['nox', 'dialog', 'commands', 'mcp', 'settings']) {
    await js(win, `window.JarvisNox.show(${JSON.stringify(view)})`);
    await waitFor(win, `document.body.dataset.view === ${JSON.stringify(view)}`, `custom-look/${view}`);
    await sleep(180);
    const styles = await js(win, sampleJs);
    customLookViews.push(styles);
    if (view === 'nox' || view === 'dialog' || view === 'settings') {
      const safeName = view === 'nox' ? 'chat' : view === 'dialog' ? 'classic-chat' : view;
      const file = `${safeName}-light-custom-look-1200-v2.png`;
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG());
      screenshotFiles.push(file);
    }
  }

  // Persistence: reload and confirm theme/accent/look survive in the isolated browser profile.
  await js(win, `window.JarvisNox.show('settings')`);
  await waitFor(win, `document.body.dataset.view === 'settings'`, 'return settings');
  const beforeReload = await js(win, `(() => ({ theme: document.documentElement.dataset.theme, stored: JSON.parse(localStorage.getItem('jarvis.theme') || 'null'), systemLight: matchMedia('(prefers-color-scheme: light)').matches }))()`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reload timeout')), 15000);
    win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    win.webContents.reload();
  });
  await waitFor(win, `Boolean(window.JarvisNox && document.documentElement.dataset.theme)`, 'post-reload theme boot');
  await sleep(250);
  const afterReload = await js(win, `(() => ({ theme: document.documentElement.dataset.theme, stored: JSON.parse(localStorage.getItem('jarvis.theme') || 'null'), accent: JSON.parse(localStorage.getItem('jarvis.accent') || 'null'), look: JSON.parse(localStorage.getItem('jarvis.look') || 'null'), systemLight: matchMedia('(prefers-color-scheme: light)').matches, rootBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), rootFont: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(), noxBg: getComputedStyle(document.body).getPropertyValue('--nox-bg').trim() }))()`);

  const result = { themes: matrix, userSettings, customLookViews, screenshots: screenshotFiles, beforeReload, afterReload, tempRoot };
  fs.writeFileSync(path.join(evidence, 'theme-matrix-v2.json'), JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(`NOX_THEME_PROBE ${JSON.stringify({ ok: true, themes: matrix.length, screenshots: screenshotFiles.length, beforeReload, afterReload, tempRoot })}\n`);
  app.exit(0);
}

let attached = false;
app.on('browser-window-created', (_event, win) => {
  if (attached) return;
  attached = true;
  win.webContents.once('did-finish-load', () => inspect(win).catch((err) => {
    process.stderr.write(`NOX_THEME_PROBE_ERROR ${err && err.stack ? err.stack : String(err)}\n`);
    app.exit(1);
  }));
});

app.whenReady().then(() => {
  require(path.join(appRoot, 'main.js'));
}).catch((err) => {
  process.stderr.write(`NOX_THEME_PROBE_ERROR ${err && err.stack ? err.stack : String(err)}\n`);
  app.exit(1);
});

setTimeout(() => {
  process.stderr.write('NOX_THEME_PROBE_ERROR global timeout\n');
  app.exit(2);
}, 150000).unref();
