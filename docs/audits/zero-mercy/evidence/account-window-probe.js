'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, globalShortcut } = require('electron');

const tag = process.argv[2] || '';
if (!/^account-window-[a-z0-9-]+$/.test(tag)) throw new Error('Expected account-window-* profile name');
const appRoot = path.resolve(__dirname, '../../../../apps/jarvis-desktop');
const root = path.join(__dirname, 'electron-temp', tag);
const data = path.join(root, 'data');
const profile = path.join(root, 'profile');
fs.mkdirSync(root);
fs.mkdirSync(data);
fs.mkdirSync(profile);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
  voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false,
  desktopOverlay: false, alwaysOnTop: false, motion: false, seededBrief: true,
  clipboardHistory: false, quiet: true, keepAwake: 'off',
}));
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = data;
require(path.join(appRoot, 'src/config/paths.js')).projectRoot = () => root;
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const account = {
  email: 'audit@example.invalid', plan: 'trial', planTitle: 'Пробный',
  limits: { session: { percent: 25 }, week: { percent: 12 } },
};
const requests = [];
let loginReply = 'success';
let meReply = 'success';
let stalled;
function respond(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  requests.push({ method: req.method, path: req.url, hasAuthorization: Boolean(req.headers.authorization) });
  req.resume();
  if (req.url === '/v1/auth/register') {
    await sleep(550);
    respond(res, 409, { error: { code: 'already_exists', message: 'Фикстура: такая почта уже зарегистрирована' } });
  } else if (req.url === '/v1/auth/login' && loginReply === 'partial') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    res.write('{"error":');
    stalled = { res, started: performance.now() };
  } else if (req.url === '/v1/auth/login') {
    respond(res, 200, { token: 'audit-local-test-token', account });
  } else if (req.url === '/v1/me' && meReply === 'success') {
    respond(res, 200, account);
  } else if (req.url === '/v1/me') {
    respond(res, meReply === 'offline' ? 503 : 401, { error: { message: 'Фикстура: аккаунт недоступен' } });
  } else if (req.url === '/v1/auth/logout') {
    respond(res, 200, { ok: true });
  } else {
    respond(res, 404, { error: { message: 'Unmapped fixture path' } });
  }
});

async function inspect(win) {
  const wc = win.webContents;
  const js = (source) => wc.executeJavaScript(source, true);
  const errors = [];
  wc.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const when = async (source) => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if (await js(source)) return;
      await sleep(50);
    }
    throw new Error('Timed out: ' + source);
  };
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const screenshot = async (name) => {
    await sleep(250);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(root, name), (await wc.capturePage()).toPNG());
  };
  const read = () => js(`(() => {
    const gate = document.querySelector('.account-gate');
    const card = gate.querySelector('.account-card');
    const e = card.querySelector('.account-error');
    const r = card.getBoundingClientRect();
    return { gate: !gate.hidden, title: card.querySelector('h1').innerText,
      busy: card.querySelector('button[type="submit"]').disabled, error: e.hidden ? '' : e.innerText,
      focus: document.activeElement?.id || null, screen: [innerWidth, innerHeight],
      cardBounds: [r.left, r.top, r.right, r.bottom], page: document.querySelector('#accountPage').innerText,
      pageVisible: document.body.dataset.view === 'account', accountPanel: !document.querySelector('#accountPage section').hidden,
      visibleMessages: [...document.querySelectorAll('[role=alert], #toasts')].filter(e => e.getClientRects().length).map(e => e.innerText).filter(Boolean) };
  })()`);
  const fillAndSubmit = () => js(`
    document.querySelector('#acEmail').value = 'audit@example.invalid';
    document.querySelector('#acPassword').value = 'synthetic-test-value';
    document.querySelector('.account-card').requestSubmit(); true`);
  win.setContentSize(864, 520);
  await when('Boolean(document.querySelector(".account-gate:not([hidden])"))');
  const initial = await read();
  await screenshot('onboarding-864.png');
  await fillAndSubmit();
  await when('document.querySelector(".account-card button[type=submit]").disabled');
  const registering = await read();
  await when('!document.querySelector(".account-error").hidden');
  const registrationError = await read();
  const keyboard = [];
  const keyboardFocus = () => js(`(() => {
    const focus = document.activeElement;
    return { id: focus.id || null, label: focus.getAttribute('aria-label') || focus.title || focus.textContent.trim().slice(0, 100),
      inGate: document.querySelector('.account-gate').contains(focus) };
  })()`);
  keyboard.push(await keyboardFocus());
  for (let i = 0; i < 4; i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(40);
    keyboard.push(await keyboardFocus());
  }
  await click('.account-card button[type=button]');
  await fillAndSubmit();
  await when('document.querySelector(".account-gate").hidden');
  await click('[data-nav=account]');
  await when('document.querySelector("#accountPage").innerText.includes("25 %")');
  const signedIn = await read();
  await screenshot('signed-in-864.png');

  meReply = 'offline';
  await click('[data-nav=nox]');
  await click('[data-nav=account]');
  const offlineBeforeRefresh = await read();
  wc.send('agent:event', { type: 'done' });
  await when('document.querySelector("#accountPage section").hidden');
  const offline = { ...await read(), state: await js('window.jarvis.accountState()') };
  await screenshot('offline-864.png');
  meReply = 'revoked';
  wc.send('agent:event', { type: 'done' });
  await when('!document.querySelector(".account-gate").hidden');
  const revoked = await read();

  loginReply = 'partial';
  await fillAndSubmit();
  while (!stalled) await sleep(20);
  const afterHeaders = await read();
  await sleep(15800);
  const afterTimeout = { ...await read(), elapsedMs: performance.now() - stalled.started, responseOpen: !stalled.res.destroyed };
  await screenshot('partial-response-864.png');
  stalled.res.end('{"message":"Фикстура: поздний ответ"}}');
  await when('!document.querySelector(".account-error").hidden && !document.querySelector(".account-card button[type=submit]").disabled');
  const afterBody = await read();

  const result = { initial, registering, registrationError, keyboard, signedIn, offlineBeforeRefresh, offline, revoked,
    afterHeaders, afterTimeout, afterBody, requests, errors };
  fs.writeFileSync(path.join(root, 'account.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ tag, requests: requests.length, afterTimeout, root }));
  app.quit();
}

const fail = (error) => {
  fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: String(error.stack || error) }, null, 2));
  console.error(error.stack || error);
  app.exit(1);
};
app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => inspect(win).catch(fail));
});
server.on('error', fail);
server.listen(0, '127.0.0.1', () => {
  process.env.NOX_SERVER_URL = 'http://127.0.0.1:' + server.address().port;
  app.whenReady().then(() => require(path.join(appRoot, 'main.js'))).catch(fail);
});
setTimeout(() => fail(new Error('Audit timeout')), 55000).unref();
