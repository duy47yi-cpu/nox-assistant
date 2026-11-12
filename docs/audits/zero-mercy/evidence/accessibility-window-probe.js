'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, globalShortcut, screen } = require('electron');
const tag = process.argv[2] || '';
const scale = process.argv[3];
if (!/^access-window-[a-z0-9-]+$/.test(tag) || !['1.25', '2'].includes(scale)) {
  throw new Error('Expected access-window-* and a scale of 1.25 or 2');
}
const appDir = path.resolve(__dirname, '../../../../apps/jarvis-desktop');
const root = path.join(__dirname, 'electron-temp', tag);
const profile = path.join(root, 'profile');
const data = path.join(root, 'data');
fs.mkdirSync(root);
fs.mkdirSync(profile);
fs.mkdirSync(data);
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = data;
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false,
  desktopOverlay: false, alwaysOnTop: false, motion: true, seededBrief: true,
  clipboardHistory: false, quiet: true, keepAwake: 'off', city: '',
  mcpServers: [{ name: 'audit-local-disabled', url: 'https://example.invalid/mcp', disabled: true }],
}));
require(path.join(appDir, 'src/config/paths.js')).projectRoot = () => root;
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', scale);
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = { scale: Number(scale), keyboard: {}, dialogs: {}, layouts: [], errors: [] };
const write = () => fs.writeFileSync(path.join(root, 'accessibility.json'), JSON.stringify(result, null, 2));
const fail = (error) => {
  result.fatal = String(error.stack || error);
  write();
  console.error(result.fatal);
  app.exit(1);
};

async function inspect(win) {
  const wc = win.webContents;
  const js = (source) => wc.executeJavaScript(source, true);
  wc.on('console-message', (event) => { if (event.level === 'error') result.errors.push(event.message); });
  const when = async (source) => {
    for (let i = 0; i < 100; i++) {
      if (await js(source)) return true;
      await wait(40);
    }
    return false;
  };
  const key = async (keyCode, modifiers = []) => {
    if (keyCode === 'Enter') {
      const details = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...details, type: 'keyDown', text: '\r' });
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { ...details, type: 'keyUp' });
    } else {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
    await wait(100);
  };
  const focus = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.focus(); true`);
  const snapshot = () => js(`(() => {
    const el = document.activeElement;
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return { id: el.id || null, tag: el.tagName, nav: el.dataset.nav || null,
      name: el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('title') ||
        (el.tagName === 'BUTTON' ? el.innerText.trim().slice(0, 100) : null),
      focusVisible: el.matches(':focus-visible'), outline: css.outlineStyle, outlineWidth: css.outlineWidth,
      rect: [r.x, r.y, r.width, r.height], dialog: el.closest('dialog')?.id || null,
      view: document.body.dataset.view };
  })()`);
  if (!await when('Boolean(window.JarvisNox && window.jarvis)')) throw new Error('Renderer not ready');
  await wait(550);
  win.show();
  win.focus();
  const contentSizes = scale === '2' ? [[864, 520]] : [[864, 520], [960, 640], [1200, 720]];
  const views = ['nox', 'commands', 'journal', 'mcp', 'settings'];
  result.display = { size: screen.getPrimaryDisplay().size, workAreaSize: screen.getPrimaryDisplay().workAreaSize,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor, electron: process.versions.electron };
  const ownDebugger = !wc.debugger.isAttached();
  if (ownDebugger) wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Accessibility.enable');
  for (const [width, height] of contentSizes) {
    win.setContentSize(width, height);
    await wait(140);
    for (const view of views) {
      await js(`document.querySelector('[data-nav="${view}"]').click()`);
      await wait(220);
      const geometry = await js(`(() => {
        const current = document.querySelector('.view[data-view="' + document.body.dataset.view + '"]');
        const rect = current.getBoundingClientRect();
        return { view: document.body.dataset.view, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth, viewWidth: current.clientWidth, viewScrollWidth: current.scrollWidth,
          bounds: [rect.left, rect.top, rect.right, rect.bottom] };
      })()`);
      result.layouts.push({ requested: [width, height], ...geometry });
      if (width === 864) {
        const tree = await wc.debugger.sendCommand('Accessibility.getFullAXTree');
        const relevant = tree.nodes.filter((node) => !node.ignored &&
          ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'switch', 'combobox', 'tab'].includes(node.role?.value));
        const unnamed = relevant.filter((node) => !String(node.name?.value || '').trim());
        const details = [];
        for (const { role, backendDOMNodeId } of unnamed) {
          if (!backendDOMNodeId) continue;
          const { node } = await wc.debugger.sendCommand('DOM.describeNode', { backendNodeId: backendDOMNodeId });
          const attributes = {};
          for (let i = 0; i < (node.attributes || []).length; i += 2) attributes[node.attributes[i]] = node.attributes[i + 1];
          details.push({ role: role.value, tag: node.nodeName, id: attributes.id || null,
            class: attributes.class || null, type: attributes.type || null, setting: attributes['data-setting'] || null });
        }
        result.keyboard[view] = { axControls: relevant.length, unnamed: details };
      }
    }
  }
  win.setContentSize(864, 520);
  await wait(180);
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    await key(String(i + 1), ['control']);
    const switched = await when(`document.body.dataset.view === "${view}"`);
    const afterShortcut = await snapshot();
    await focus(`[data-nav="${view}"]`);
    const tab = [];
    for (let step = 0; step < 12; step++) {
      await key('Tab');
      tab.push(await snapshot());
    }
    await key('Tab', ['shift']);
    result.keyboard[view] = { ...result.keyboard[view], switched, afterShortcut, tab, reverse: await snapshot() };
  }

  async function modal(id, trigger) {
    const opened = await when(`document.querySelector('#${id}').open`);
    const observed = await js(`(() => {
      const el = document.querySelector('#${id}');
      const r = el.getBoundingClientRect();
      return { bounds: [r.left, r.top, r.right, r.bottom], screen: [innerWidth, innerHeight],
        dialogWidth: el.clientWidth, scrollWidth: el.scrollWidth };
    })()`);
    const entry = await snapshot();
    const tab = [];
    if (opened) {
      for (let i = 0; i < 10; i++) {
        await key('Tab');
        tab.push(await snapshot());
      }
      await key('Tab', ['shift']);
    }
    const reverse = await snapshot();
    await key('Escape');
    result.dialogs[id] = { opened, observed, entry, tab, reverse,
      closed: await when(`!document.querySelector('#${id}').open`), returned: await snapshot(), trigger };
  }
  await key('2', ['control']);
  await key('N', ['control']);
  result.newCommand = { visible: await when('!document.querySelector("#cmdEditor").hidden'), focus: await snapshot() };
  if (result.newCommand.visible) {
    await focus('#cmdStepAdd');
    await key('Enter');
    await modal('cmdActionDialog', 'cmdStepAdd');
    await js('document.querySelector("#cmdCancel").click()');
    // Close the unsaved draft prompt with Escape if the editor created one.
    if (await js('document.querySelector("#confirmDialog").open')) await key('Escape');
  }
  await key('4', ['control']);
  await focus('#mcpAddBtn');
  await key('Enter');
  await modal('mcpAddDialog', 'mcpAddBtn');

  await key('1', ['control']);
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await wait(230);
  const canvasMotion = () => js(`(async () => {
    const canvas = document.querySelector('#noxOrb');
    const before = canvas.toDataURL();
    await new Promise((resolve) => setTimeout(resolve, 220));
    const after = canvas.toDataURL();
    return { media: matchMedia('(prefers-reduced-motion: reduce)').matches,
      visibility: document.visibilityState, pixelsChanged: before !== after, canvas: [canvas.width, canvas.height],
      motion: document.documentElement.dataset.motion || null, ignore: window.NoxOrb.ignoreSystemMotion };
  })()`);
  result.motion = { emulatedReduce: await canvasMotion() };
  await key('5', ['control']);
  await js('document.querySelector(\'[data-setting="motion"]\').click()');
  result.motion.generalSettingPersistedOff = await when('window.jarvis.getSettings().then((s) => s.motion === false)');
  await key('1', ['control']);
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await wait(230);
  result.motion.generalMotionOff = await canvasMotion();
  await key('5', ['control']);
  await js('document.querySelector(\'[data-local="orbAnim"]\').click()');
  result.motion.orbSettingOff = await when('document.documentElement.dataset.motion === "off"');
  await key('1', ['control']);
  await wait(230);
  result.motion.orbMotionOff = await canvasMotion();
  if (process.argv[4] === 'workspace') {
    const state = () => js(`window.jarvis.workspacesList().then(({ selected, spaces }) => ({
      selected, spaces: spaces.map(({ id, name }) => ({ id, name })),
      visible: Boolean(document.querySelector('#workspaceCreate').getClientRects().length),
      view: document.body.dataset.view, draft: document.querySelector('#chatInput').value,
      message: document.querySelector('#toasts').innerText,
    }))`);
    const nox = await state();
    if (!nox.visible) {
      await key('5', ['control']);
      await js('document.querySelector("#openClassic").click()');
      await when('document.body.dataset.view === "dialog"');
    }
    const before = await state();
    await focus('#workspaceCreate');
    await key('Enter');
    await modal('workspaceDialog', 'workspaceCreate');
    const afterCancel = await state();
    await focus('#workspaceCreate');
    await key('Enter');
    if (!await when('document.querySelector("#workspaceDialog").open')) throw new Error('Workspace dialog did not reopen');
    await js(`document.querySelector('#workspaceName').value = 'Пространство проверки';
      document.querySelector('#workspaceForm').requestSubmit(); true`);
    const created = await when(`window.jarvis.workspacesList().then(({ selected }) => selected !== 'default')`);
    const afterCreate = await state();
    await js(`(() => {
      const input = document.querySelector('#chatInput');
      input.value = 'Черновик для проверки';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const picker = document.querySelector('#workspacePicker');
      picker.value = 'default';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await wait(220);
    const refusedWithDraft = await state();
    await js(`(() => {
      const input = document.querySelector('#chatInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const picker = document.querySelector('#workspacePicker');
      picker.value = 'default';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const returned = await when(`window.jarvis.workspacesList().then(({ selected }) => selected === 'default')`);
    result.workspace = { nox, before, afterCancel, created, afterCreate, refusedWithDraft, returned, afterReturn: await state() };
  }
  if (ownDebugger) wc.debugger.detach();
  write();
  console.log(JSON.stringify({ tag, scale, layouts: result.layouts.length, errors: result.errors.length, root }));
  app.quit();
}

app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => inspect(win).catch(fail));
});
app.whenReady().then(() => require(path.join(appDir, 'main.js'))).catch(fail);
setTimeout(() => fail(new Error('Accessibility probe timed out')), 120000).unref();
