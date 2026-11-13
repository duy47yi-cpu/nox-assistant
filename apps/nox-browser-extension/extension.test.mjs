import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowedOrigin, prepareAction, extractPage } from './page.mjs';
import { fitReadResultFrame, truncateUtf8, utf8Bytes, MAX_FRAME_BYTES, MAX_TEXT_BYTES } from './messages.mjs';

test('manifest grants only temporary selected-tab access', async () => {
  const manifest = JSON.parse((await readFile(new URL('./manifest.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test('only web origins are accepted and actions are disabled (Privacy 18)', () => {
  assert.equal(allowedOrigin('https://example.com/a'), 'https://example.com');
  for (const url of ['file:///a', 'chrome://settings', 'javascript:alert(1)', 'bad']) {
    assert.equal(allowedOrigin(url), null);
  }
  assert.equal(prepareAction('click').ok, false);
  assert.equal(prepareAction('type').ok, false);
});

test('extractor excludes form, editable, private and hidden text', () => {
  const body = { parentElement: null };
  const element = (exclude = false, hidden = false) => ({ parentElement: body, closest: () => exclude, hidden });
  const visible = element();
  const secret = element(true);
  const hidden = element(false, true);
  const nodes = [
    { parentElement: visible, nodeValue: 'Public text' },
    { parentElement: secret, nodeValue: 'password' },
    { parentElement: hidden, nodeValue: 'hidden secret' },
  ];
  globalThis.document = { body, title: 'Page', createTreeWalker: () => ({ nextNode: () => nodes.shift() }) };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible' });
  try {
    assert.deepEqual(extractPage(), { title: 'Page', text: 'Public text' });
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
    delete globalThis.getComputedStyle;
  }
});

test('P1.12: UTF-8 truncation and 64 KiB frame budgeting preserve valid surrogate boundaries', () => {
  const emojis = '😀'.repeat(20); // 80 UTF-8 bytes
  const cut = truncateUtf8(emojis, 10);
  assert.equal(cut.truncated, true);
  assert.equal(utf8Bytes(cut.text), 8);
  assert.equal(cut.text, '😀😀');

  const fitted = fitReadResultFrame({
    seq: 1,
    requestId: 'a'.repeat(64),
    origin: 'https://example.com',
    title: 'Заголовок',
    text: '"'.repeat(MAX_TEXT_BYTES),
    truncated: false,
  });
  assert.equal(fitted.truncated, true);
  const frameSize = utf8Bytes(
    JSON.stringify({
      type: 'read_result',
      seq: 1,
      requestId: 'a'.repeat(64),
      ok: true,
      ...fitted,
      proof: '0'.repeat(64),
    })
  );
  assert.ok(frameSize <= MAX_FRAME_BYTES);
});

test('Privacy 15/17: popup shows explicit model-sharing notice and extension avoids logging or persistence', async () => {
  const popupHtml = await readFile(new URL('./popup.html', import.meta.url), 'utf8');
  assert.match(popupHtml, /передано модели Nox/i);
  assert.match(popupHtml, /Разрешить и прочитать/);
  assert.match(popupHtml, /Клики и ввод отключены/i);

  for (const file of ['background.mjs', 'background-core.mjs', 'client.mjs', 'page.mjs', 'popup.mjs', 'messages.mjs']) {
    const src = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.equal(/\bconsole\.(log|info|debug|warn|error)\b/.test(src), false, `${file} must not log`);
    assert.equal(/\b(chrome\.storage|localStorage|sessionStorage|indexedDB)\b/.test(src), false, `${file} must not persist`);
  }
});

test('extension client authenticates the bridge and rejects a wrong secret', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../nox-browser-bridge/bridge.js', import.meta.url));
  const { createBridge } = require('./bridge');
  const WebSocket = require('ws');
  const { connectBridge } = await import('./client.mjs');
  const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const bridge = createBridge({ origin });
  const port = await bridge.listen();
  class BrowserSocket extends WebSocket {
    constructor(url) {
      super(url, { origin });
    }
  }
  try {
    const pairing = bridge.pair();
    const connection = await connectBridge({ port, origin, pairing, WebSocketClass: BrowserSocket });
    await connection.ping();
    connection.close();
    await assert.rejects(
      connectBridge({ port, origin, pairing: { ...pairing, secret: 'f'.repeat(64) }, WebSocketClass: BrowserSocket })
    );
  } finally {
    await bridge.close();
  }
});
