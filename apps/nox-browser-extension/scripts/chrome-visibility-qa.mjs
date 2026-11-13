#!/usr/bin/env node
// Live visibility QA: launches Chrome for Testing with this extension loaded from disk
// (manifest unchanged), pairs it with the real loopback bridge, reads a page containing all six
// hiding techniques from the C5 audit and verifies that only visible text reaches the owner.
// Also measures extractor time on large pages. Uses node builtins and the ws package already
// vendored in ../nox-browser-bridge; nothing is installed.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extractPage } from '../page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..');
const BRIDGE_DIR = path.resolve(EXT_DIR, '..', 'nox-browser-bridge');
const RESULT_DIR = path.resolve(EXT_DIR, '../../docs/audits/c5-p1-5');
const RESULT_FILE = path.join(RESULT_DIR, 'chrome-qa-result.json');
const requireBridge = createRequire(path.join(BRIDGE_DIR, 'package.json'));
const WebSocket = requireBridge('ws');
const { createBridge } = requireBridge('./bridge.js');

const VISIBLE_MARKERS = ['VISIBLE_MARKER', 'BOTTOM_MARKER', 'VISIBLE_GRADIENT', 'VISIBLE_STROKE', 'VISIBLE_SHADOW', 'VISIBLE_SUMMARY'];
const HIDDEN_MARKERS = [
  'HID_OPACITY',
  'HID_FONT0',
  'HID_COLOR',
  'HID_OFFSCREEN',
  'HID_HEIGHT0',
  'HID_CLIP',
  'HID_VISIBILITY',
  'HID_DISPLAY',
  'HID_ARIA',
  'HID_FILL_TRANSPARENT',
  'HID_FILTER',
  'HID_DETAILS',
  'HID_SECURITY',
];
const PRIVATE_MARKERS = ['SEC_PASSWORD', 'SEC_EDIT', 'SEC_PRIVATE'];
const CAPPED_BYTES = 49280 - 512;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [];
  if (process.env.NOX_CHROME_BIN) candidates.push(process.env.NOX_CHROME_BIN);
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  const puppeteerRoot = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(puppeteerRoot)) {
    for (const entry of fs.readdirSync(puppeteerRoot)) {
      candidates.push(path.join(puppeteerRoot, entry, 'chrome-win64', 'chrome.exe'));
      candidates.push(path.join(puppeteerRoot, entry, 'chrome-linux64', 'chrome'));
    }
  }
  candidates.push('C:/Users/abdut/AppData/Local/Chromium/Application/chrome.exe');
  candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
  candidates.push('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe');
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome for Testing not found; set NOX_CHROME_BIN');
}

function hiddenPageHtml() {
  const filler = Array.from({ length: 120 }, (_, index) =>
    `<p>Обычный абзац статьи номер ${index + 1}. Видимый текст для проверки длинной страницы.</p>`
  ).join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Nox visibility QA</title></head><body>
<h1>Видимая статья</h1>
<p>VISIBLE_MARKER</p>
<p>Обычный видимый текст статьи, который владелец читает на странице.</p>
<div style="opacity:0">HID_OPACITY</div>
<div style="font-size:0">HID_FONT0</div>
<div style="color:transparent">HID_COLOR</div>
<div style="-webkit-text-fill-color:transparent">HID_FILL_TRANSPARENT</div>
<div style="position:absolute;left:-9999px">HID_OFFSCREEN</div>
<div style="height:0;overflow:hidden">HID_HEIGHT0</div>
<div style="clip-path:inset(100%)">HID_CLIP</div>
<div style="filter:opacity(0)">HID_FILTER</div>
<div style="visibility:hidden">HID_VISIBILITY</div>
<div style="display:none">HID_DISPLAY</div>
<div aria-hidden="true">HID_ARIA</div>
<details><summary>VISIBLE_SUMMARY</summary>HID_DETAILS</details>
<div style="-webkit-text-security:disc">HID_SECURITY</div>
<div style="background-image:linear-gradient(red,blue);-webkit-background-clip:text;background-clip:text;color:transparent">VISIBLE_GRADIENT</div>
<div style="-webkit-text-stroke:1px black;color:transparent">VISIBLE_STROKE</div>
<div style="color:transparent;text-shadow:0 0 2px black">VISIBLE_SHADOW</div>
<input type="password" value="SEC_PASSWORD">
<div contenteditable="true">SEC_EDIT</div>
<div data-private="1">SEC_PRIVATE</div>
${filler}
<p>BOTTOM_MARKER</p>
</body></html>`;
}

function largePageHtml(count, hidden) {
  const style = hidden ? ' style="opacity:0"' : '';
  const paragraphs = Array.from({ length: count }, (_, index) =>
    `<p${style}>Абзац ${index + 1}: длинный видимый текст статьи для замера извлечения, включая слова и цифры ${index * 7}.</p>`
  ).join('\n');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Nox large QA</title></head><body>
<h1>Большая страница</h1>
${paragraphs}
<p>TAIL_MARKER</p>
</body></html>`;
}

function startPageServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/large') {
      res.end(largePageHtml(6000, false));
      return;
    }
    if (req.url === '/large-hidden') {
      res.end(largePageHtml(3000, true));
      return;
    }
    res.end(hiddenPageHtml());
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitForDevToolsPort(userDataDir, timeoutMs = 20000) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      try {
        const lines = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        if (lines.length >= 2) return { port: lines[0].trim(), path: lines[1].trim() };
      } catch {
        // Chrome still holds the file on Windows; retry.
      }
    }
    await sleep(100);
  }
  throw new Error('DevToolsActivePort was not created');
}

async function connectCdp(cdpInfo) {
  const socket = new WebSocket(`ws://127.0.0.1:${cdpInfo.port}${cdpInfo.path}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  const cdp = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { socket, cdp };
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new Error(details.exception?.description || details.text || 'Runtime.evaluate failed');
  }
  return response.result ? response.result.value : undefined;
}

async function main() {
  const chromeBinary = findChrome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c5-visibility-'));
  const profileDir = path.join(root, 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const { server: pageServer, port: pagePort } = await startPageServer();
  const pageBase = `http://127.0.0.1:${pagePort}`;
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestHash = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  const extractPageSource = extractPage.toString();

  let chromeProc = null;
  let connection = null;
  let bridge = null;
  const result = {
    ok: false,
    chrome: { binary: chromeBinary, product: null },
    manifest: {
      hash: manifestHash,
      permissions: manifest.permissions,
      hostPermissions: manifest.host_permissions ?? null,
      contentScripts: manifest.content_scripts ?? null,
      modifiedBeforeLoad: false,
    },
    extensionOrigin: null,
    pairing: null,
    popup: null,
    bridgeRead: null,
    markers: { visible: {}, hidden: {}, private: {} },
    performance: null,
    failures: [],
  };

  function checkMarkers(text, label) {
    const found = { visible: {}, hidden: {}, private: {} };
    for (const marker of VISIBLE_MARKERS) {
      found.visible[marker] = text.includes(marker);
      if (!found.visible[marker]) result.failures.push(`${label}: visible marker ${marker} is missing`);
    }
    for (const marker of HIDDEN_MARKERS) {
      found.hidden[marker] = text.includes(marker);
      if (found.hidden[marker]) result.failures.push(`${label}: hidden marker ${marker} leaked`);
    }
    for (const marker of PRIVATE_MARKERS) {
      found.private[marker] = text.includes(marker);
      if (found.private[marker]) result.failures.push(`${label}: private marker ${marker} leaked`);
    }
    return found;
  }

  try {
    chromeProc = spawn(chromeBinary, [
      `--user-data-dir=${profileDir}`,
      '--headless=new',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-extensions-with-background-pages',
      '--remote-debugging-port=0',
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      `${pageBase}/hidden`,
    ], { stdio: 'ignore' });

    const cdpInfo = await waitForDevToolsPort(profileDir);
    connection = await connectCdp(cdpInfo);
    const { cdp } = connection;
    result.chrome.product = (await cdp('Browser.getVersion')).product;

    const listTargets = async () => {
      const { targetInfos } = await cdp('Target.getTargets', {
        filter: [{ type: 'tab' }, { type: 'page' }, { type: 'service_worker' }],
      });
      return targetInfos || [];
    };

    let extensionOrigin = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const worker = (await listTargets()).find(target =>
        typeof target.url === 'string' && /^chrome-extension:\/\/[a-p]{32}\/background\.mjs$/.test(target.url)
      );
      if (worker) {
        extensionOrigin = `${new URL(worker.url).protocol}//${new URL(worker.url).host}`;
        break;
      }
      await sleep(100);
    }
    if (!extensionOrigin) throw new Error('extension service worker was not discovered');
    result.extensionOrigin = extensionOrigin;
    const extensionId = new URL(extensionOrigin).host;

    bridge = createBridge({ origin: extensionOrigin });
    const bridgePort = await bridge.listen();

    const findPageTarget = async () => {
      const targets = await listTargets();
      return targets.find(target => target.type === 'page' && String(target.url || '').startsWith(`${pageBase}/hidden`))
        || targets.find(target => target.type === 'page');
    };
    const pageTarget = await findPageTarget();
    if (!pageTarget) throw new Error('page target not found');
    const { sessionId: pageSession } = await cdp('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
    await cdp('Page.enable', {}, pageSession);
    await cdp('Page.navigate', { url: `${pageBase}/hidden` }, pageSession);
    await sleep(800);

    const targetsAfterNavigate = await listTargets();
    const tabTarget = targetsAfterNavigate.find(target =>
      target.type === 'tab' && String(target.url || '').startsWith(pageBase)
    ) || targetsAfterNavigate.find(target => target.type === 'tab');
    if (!tabTarget) {
      throw new Error(`tab target for Extensions.triggerAction not found: ${JSON.stringify(targetsAfterNavigate.map(target => ({ type: target.type, url: target.url })))}`);
    }

    await cdp('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    let popupTarget = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      popupTarget = (await listTargets()).find(target => String(target.url || '').endsWith('/popup.html'));
      if (popupTarget) break;
      await sleep(100);
    }
    if (!popupTarget) throw new Error('popup.html target was not opened by Extensions.triggerAction');
    const { sessionId: popupSession } = await cdp('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
    const popupReady = await evaluate(cdp, popupSession, `(async () => {
      for (let i = 0; i < 100; i += 1) {
        if (document.readyState === 'complete' && document.getElementById('connect')) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    })()`);
    if (!popupReady) throw new Error('popup.html did not become ready');

    const pairing = bridge.pair();
    const paired = await evaluate(cdp, popupSession, `(async () => {
      document.getElementById('port').value = ${JSON.stringify(String(bridgePort))};
      document.getElementById('pair-id').value = ${JSON.stringify(pairing.id)};
      document.getElementById('secret').value = ${JSON.stringify(pairing.secret)};
      document.getElementById('expires').value = ${JSON.stringify(String(pairing.expires))};
      document.getElementById('connect').click();
      for (let i = 0; i < 100; i += 1) {
        if (document.getElementById('connection').textContent.includes('Мост подтверждён')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return {
        connection: document.getElementById('connection').textContent,
        secretCleared: document.getElementById('secret').value === '',
      };
    })()`);
    result.pairing = { connection: paired.connection, secretCleared: paired.secretCleared };
    if (!paired.connection.includes('Мост подтверждён') || !paired.secretCleared) {
      throw new Error(`pairing failed: ${JSON.stringify(paired)}`);
    }

    const allowed = await evaluate(cdp, popupSession, `(async () => {
      document.getElementById('allow').click();
      for (let i = 0; i < 100; i += 1) {
        if (document.getElementById('grant').textContent.includes('Одноразовый доступ')) {
          return { ok: true, grant: document.getElementById('grant').textContent, output: document.getElementById('output').textContent };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { ok: false, grant: document.getElementById('grant').textContent, output: document.getElementById('output').textContent };
    })()`);
    if (!allowed.ok) throw new Error(`popup read failed: ${JSON.stringify({ grant: allowed.grant })}`);
    const popupBytes = new TextEncoder().encode(allowed.output).byteLength;
    result.popup = { ok: true, characters: allowed.output.length, bytes: popupBytes, capped: popupBytes >= CAPPED_BYTES };
    result.markers = checkMarkers(allowed.output, 'popup');

    const bridgeRead = await bridge.readPage({ timeoutMs: 15000 });
    const bridgeBytes = bridgeRead.ok ? new TextEncoder().encode(bridgeRead.text).byteLength : 0;
    result.bridgeRead = { ok: Boolean(bridgeRead.ok), characters: bridgeRead.text ? bridgeRead.text.length : 0, bytes: bridgeBytes };
    if (!bridgeRead.ok) throw new Error(`bridge read failed: ${bridgeRead.error}`);
    const bridgeMarkers = checkMarkers(bridgeRead.text, 'bridge');
    for (const group of Object.keys(bridgeMarkers)) {
      for (const [marker, value] of Object.entries(bridgeMarkers[group])) {
        result.markers[group][marker] = value;
      }
    }

    const measure = async (url, runs) => {
      await cdp('Page.navigate', { url }, pageSession);
      await sleep(900);
      return evaluate(cdp, pageSession, `(() => {
        const extractPage = ${extractPageSource};
        const times = [];
        let last = null;
        for (let run = 0; run < ${runs}; run += 1) {
          const started = performance.now();
          last = extractPage();
          times.push(performance.now() - started);
        }
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let textNodes = 0;
        while (walker.nextNode()) textNodes += 1;
        return {
          times: times.map(value => Math.round(value * 10) / 10),
          best: Math.round(Math.min(...times) * 10) / 10,
          textNodes,
          paragraphs: document.querySelectorAll('p').length,
          extractedCharacters: last.text.length,
          extractedBytes: new TextEncoder().encode(last.text).byteLength,
          capped: new TextEncoder().encode(last.text).byteLength >= ${CAPPED_BYTES},
        };
      })()`);
    };

    result.performance = {
      largeVisible: await measure(`${pageBase}/large`, 3),
      largeHidden: await measure(`${pageBase}/large-hidden`, 2),
    };

    try { await cdp('Browser.close'); } catch { /* already closing */ }
    result.ok = result.failures.length === 0;
  } catch (error) {
    result.failures.push(String(error && error.stack ? error.stack : error));
  } finally {
    try { connection?.socket.terminate(); } catch { /* ignore */ }
    try { chromeProc?.kill('SIGKILL'); } catch { /* ignore */ }
    try { if (bridge) await bridge.close(); } catch { /* ignore */ }
    await new Promise(resolve => {
      try { pageServer.closeAllConnections?.(); } catch { /* ignore */ }
      pageServer.close(resolve);
    });
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n', 'utf8');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }

  console.log(JSON.stringify({
    ok: result.ok,
    chrome: result.chrome.product,
    popupCharacters: result.popup?.characters ?? null,
    bridgeCharacters: result.bridgeRead?.characters ?? null,
    performance: result.performance,
    failures: result.failures,
    resultFile: RESULT_FILE,
  }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
