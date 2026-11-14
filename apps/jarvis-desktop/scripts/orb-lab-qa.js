'use strict';
// Проверка отдельного демо: Node запускает scripts/run-orb-lab-qa.cjs.
const electron = require('electron');
const electronBinary = typeof electron === 'string' ? electron : null;
const { app, BrowserWindow } = electronBinary ? {} : electron;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OUT = process.env.NOX_ORB_QA_OUT || path.join(os.tmpdir(), 'nox-orb-lab-captures');
const timer = setTimeout(() => finish(new Error('Таймаут 60 секунд')), 60000);
let win, done = false;
function finish(error, report) {
  if (done) return; done = true; clearTimeout(timer);
  if (error) console.error('ORB_QA_ERROR ' + error.stack);
  else console.log('ORB_QA_OK ' + JSON.stringify(report));
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  app.setPath('userData', path.join(OUT, 'electron-profile'));
  fs.mkdirSync(OUT, { recursive: true });
  win = new BrowserWindow({ width: 1320, height: 900, show: true, backgroundColor: '#101112', webPreferences: { sandbox: false } });
  await win.loadFile(path.join(__dirname, '..', 'demo', 'orb-lab', 'index.html'));
  await wait(1500);
  assert.equal(await win.webContents.executeJavaScript('typeof orbDemo'), 'object');
  const results = [];
  for (const id of ['flux', 'membrane', 'resonance']) {
    await win.webContents.executeJavaScript('orbDemo.chooseVariant("' + id + '")');
    await wait(800);
    assert.equal(await win.webContents.executeJavaScript('orbDemo.orb.variant'), id);
    fs.writeFileSync(path.join(OUT, id + '.png'), (await win.webContents.capturePage()).toPNG());
    results.push(await win.webContents.executeJavaScript('orbDemo.snapshot()'));
    console.log('CAPTURE ' + id);
  }
  fs.writeFileSync(path.join(OUT, 'phase.json'), JSON.stringify({stage:'states', results}, null, 2));
  console.log('VARIANTS_DONE');
  for (const state of ['listening', 'thinking', 'speaking', 'success', 'error']) {
    await win.webContents.executeJavaScript('orbDemo.chooseState("' + state + '")');
    await wait(500);
    const actual = await win.webContents.executeJavaScript('orbDemo.orb.state');
    console.log('STATE ' + state + ' ACTUAL ' + actual); console.log('SELECTED ' + await win.webContents.executeJavaScript('document.querySelector(`[data-state=${state}]`).ariaPressed'));
    assert.equal(actual, state);
    console.log('LABEL ' + await win.webContents.executeJavaScript('document.getElementById("stateLabel").textContent'));
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("stateLabel").textContent'), { listening: 'Слушает', thinking: 'Думает', speaking: 'Отвечает', success: 'Готово', error: 'Ошибка' }[state]);
  }
  await win.webContents.executeJavaScript('document.getElementById("voice").click()');
  await wait(500);
  assert.ok(await win.webContents.executeJavaScript('orbDemo.orb.voiceTarget > 0'));
  await win.webContents.executeJavaScript('document.getElementById("voice").click()');
  await win.webContents.executeJavaScript('document.getElementById("reduce").click()');
  assert.equal(await win.webContents.executeJavaScript('orbDemo.snapshot().animated'), false);
  const phase = await win.webContents.executeJavaScript('orbDemo.orb.phase');
  await wait(350);
  assert.equal(await win.webContents.executeJavaScript('orbDemo.orb.phase'), phase);
  await win.webContents.executeJavaScript('document.getElementById("reduce").click()');
  await win.setSize(680, 840);
  await wait(500);
  const mobile = await win.webContents.executeJavaScript('({ width: innerWidth, scroll: document.documentElement.scrollWidth })');
  assert.equal(mobile.width, mobile.scroll);
  fs.writeFileSync(path.join(OUT, 'mobile.png'), (await win.webContents.capturePage()).toPNG());
  await win.setSize(1320, 900);
  await win.webContents.executeJavaScript('orbDemo.chooseVariant("flux");orbDemo.chooseState("thinking")');
  await wait(5000);
  const perf = await win.webContents.executeJavaScript('orbDemo.snapshot()');
  assert.ok(perf.frames > 100);
  const report = { variants: results.map(({variant, lines, vertices}) => ({variant, lines, vertices})), mobile, perf };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  finish(null, report);
}).catch(finish);
process.on('uncaughtException', finish);
process.on('unhandledRejection', (error) => finish(error instanceof Error ? error : new Error(String(error))));
if (electronBinary) {
  const { spawn } = require('node:child_process');
  const child = spawn(electronBinary, [__filename], { env: process.env, stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code || 0; });
}