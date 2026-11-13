import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EXT = new URL('../../../apps/nox-browser-extension/', import.meta.url);
const BRIDGE = new URL('../../../apps/nox-browser-bridge/', import.meta.url);

const ID = 'a'.repeat(32);
const EXT_ORIGIN = `chrome-extension://${ID}`;
let messageListener = null;
const tabListeners = {};

globalThis.chrome = {
  runtime: {
    id: ID,
    getURL: p => {
      const rel = String(p).replace(/^\//, '');
      return rel ? `${EXT_ORIGIN}/${rel}` : `${EXT_ORIGIN}/`;
    },
    onMessage: { addListener: fn => { messageListener = fn; } },
  },
  tabs: {
    onUpdated: { addListener: fn => { tabListeners.updated = fn; } },
    onRemoved: { addListener: fn => { tabListeners.removed = fn; } },
    onActivated: { addListener: fn => { tabListeners.activated = fn; } },
  },
};

await import('../../../apps/nox-browser-extension/background.mjs');

function sendToWorker(message, sender) {
  return new Promise(resolve => {
    let answered = false;
    const returned = messageListener(message, sender, response => {
      answered = true;
      resolve({ returned, answered, response });
    });
    if (returned === false) resolve({ returned, answered });
  });
}

test('SG-01 worker messaging gate accepts only the extension popup page', async () => {
  const popupUrl = `${EXT_ORIGIN}/popup.html`;
  const cases = [
    [{ id: ID, url: 'https://evil.test/' }, false],
    [{ id: 'b'.repeat(32), url: popupUrl }, false],
    [{ id: ID, url: `${popupUrl}#fragment` }, false],
    [{ id: ID, url: `${EXT_ORIGIN}/other.html` }, false],
    [{ id: ID }, false],
    [{ id: ID, url: popupUrl }, true],
  ];
  for (const [sender, accepted] of cases) {
    const result = await sendToWorker({ type: 'status' }, sender);
    assert.equal(result.returned, accepted, JSON.stringify(sender));
    if (accepted) {
      assert.equal(result.answered, true);
      assert.equal(result.response.connection, 'disconnected');
      assert.equal(result.response.access, 'revoked');
    }
  }
  assert.equal(typeof tabListeners.updated, 'function');
  assert.equal(typeof tabListeners.removed, 'function');
  assert.equal(typeof tabListeners.activated, 'function');
});

test('SG-02 audited sources do not log, persist, fetch or write page text', async () => {
  const extensionFiles = ['background.mjs', 'background-core.mjs', 'client.mjs', 'page.mjs', 'popup.mjs', 'messages.mjs'];
  for (const file of extensionFiles) {
    const src = await readFile(new URL(file, EXT), 'utf8');
    assert.equal(/\bconsole\.(log|info|debug|warn|error)\b/.test(src), false, `${file}: console`);
    assert.equal(/\b(chrome\.storage|localStorage|sessionStorage|indexedDB)\b/.test(src), false, `${file}: storage`);
    assert.equal(/\b(fetch\s*\(|XMLHttpRequest|sendBeacon)\b/.test(src), false, `${file}: network api`);
  }
  const bridgeFiles = ['bridge.js', 'protocol.js', 'client.mjs'];
  for (const file of bridgeFiles) {
    const src = await readFile(new URL(file, BRIDGE), 'utf8');
    assert.equal(/\bconsole\.(log|info|debug|warn|error)\b/.test(src), false, `${file}: console`);
    assert.equal(/\b(require\(['"]node:fs|require\(['"]fs|writeFileSync|appendFileSync|createWriteStream)\b/.test(src), false, `${file}: fs write`);
  }
  const manifest = JSON.parse(await readFile(new URL('manifest.json', EXT), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.background.type, 'module');
  const messages = await import(new URL('messages.mjs', EXT));
  assert.equal(messages.SNAPSHOT_TRANSPORT_ENABLED, false);
  const popup = await readFile(new URL('popup.html', EXT), 'utf8');
  assert.match(popup, /передано модели Nox/);
  assert.match(popup, /однократно/);
  assert.match(popup, /Клики и ввод отключены/);
});

test('SG-03 page extractor excludes forms, editable, hidden and private text', async () => {
  const { extractPage, prepareAction } = await import(new URL('page.mjs', EXT));
  const root = { parentElement: null };
  const element = ({ secret = false, style = {} } = {}) => ({
    parentElement: root,
    closest: () => secret,
    style,
  });
  const hiddenAncestor = { parentElement: root, closest: () => false, style: { display: 'none', visibility: 'visible' } };
  const elementUnderHidden = { parentElement: hiddenAncestor, closest: () => false, style: { display: 'block', visibility: 'visible' } };
  const nodes = [
    { parentElement: element(), nodeValue: '  Public \n text  ' },
    { parentElement: element({ secret: true }), nodeValue: 'password' },
    { parentElement: elementUnderHidden, nodeValue: 'hidden secret' },
    { parentElement: element({ secret: true }), nodeValue: 'private data' },
    { parentElement: element(), nodeValue: '  ' },
    { parentElement: element(), nodeValue: 'Second' },
  ];
  globalThis.document = { body: root, title: 'Заголовок', createTreeWalker: () => ({ nextNode: () => nodes.shift() ?? null }) };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = el => el.style || { display: 'block', visibility: 'visible' };
  try {
    assert.deepEqual(extractPage(), { title: 'Заголовок', text: 'Public text\nSecond' });
    assert.equal(prepareAction('click').ok, false);
    assert.equal(prepareAction('type').ok, false);
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
    delete globalThis.getComputedStyle;
  }

  // Byte cap: 100 000 Cyrillic characters (200 000 bytes) must be cut to <= 49 280 bytes.
  const longNodes = [{ parentElement: element(), nodeValue: 'Я'.repeat(100000) }];
  globalThis.document = { body: root, title: 'T'.repeat(2000), createTreeWalker: () => ({ nextNode: () => longNodes.shift() ?? null }) };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = el => el.style || { display: 'block', visibility: 'visible' };
  try {
    const out = extractPage();
    assert.ok(Buffer.byteLength(out.text, 'utf8') <= 49280);
    assert.ok(Buffer.byteLength(out.title, 'utf8') <= 600);
    assert.equal('Я'.repeat(100000).startsWith(out.text), true);
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
    delete globalThis.getComputedStyle;
  }
});

test('SG-04 UTF-8 truncation fuzz: byte cap, prefix property, surrogate safety', async () => {
  const { truncateUtf8, utf8Bytes, MAX_TEXT_BYTES, MAX_TITLE_BYTES } = await import(new URL('messages.mjs', EXT));
  const pool = ['A', 'Я', '😀', '\uD83D', '\uDE00', '\uD800', '"', '\\', '\u0000', '\n', '𝄞', 'e\u0301', 'Ж', 'ß'];
  let seed = 0x12345678;
  const rand = n => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const hasUnpairedTrailingHigh = s => {
    if (!s) return false;
    const last = s.charCodeAt(s.length - 1);
    return last >= 0xd800 && last <= 0xdbff;
  };
  for (let round = 0; round < 400; round += 1) {
    let str = '';
    const length = rand(40);
    for (let i = 0; i < length; i += 1) str += pool[rand(pool.length)];
    const limit = [0, 1, 2, 3, 4, 5, 7, 9, 16, 64, 512, 1024, 49152][rand(13)];
    const out = truncateUtf8(str, limit);
    assert.ok(utf8Bytes(out.text) <= limit, `bytes ${utf8Bytes(out.text)} > ${limit}`);
    assert.equal(str.startsWith(out.text), true);
    assert.equal(hasUnpairedTrailingHigh(out.text), false);
    assert.equal(typeof out.truncated, 'boolean');
    if (out.text !== str) assert.equal(out.truncated, true);
  }
  assert.equal(truncateUtf8('', 0).text, '');
  assert.equal(truncateUtf8('abc', 3).truncated, false);
  assert.equal(truncateUtf8('abc', 2).text, 'ab');
  assert.equal(truncateUtf8('😀', 3).text, '');
  assert.equal(truncateUtf8('😀', 4).text, '😀');
  assert.ok(MAX_TEXT_BYTES === 49152 && MAX_TITLE_BYTES === 512);
});

test('SG-05 signed read_result frame budget holds for hostile text', async () => {
  const { fitReadResultFrame, utf8Bytes, MAX_TEXT_BYTES, MAX_TITLE_BYTES } = await import(new URL('messages.mjs', EXT));
  const texts = [
    '"'.repeat(49152),
    '\u0000'.repeat(49152),
    '\\'.repeat(49152),
    'Я'.repeat(30000),
    '😀'.repeat(20000),
    '',
  ];
  for (const text of texts) {
    const fitted = fitReadResultFrame({
      seq: 1,
      requestId: 'a'.repeat(64),
      origin: 'https://example.test',
      title: 'Title',
      text,
      truncated: false,
    });
    assert.ok(utf8Bytes(fitted.text) <= MAX_TEXT_BYTES);
    assert.ok(utf8Bytes(fitted.title) <= MAX_TITLE_BYTES);
    assert.equal(text.startsWith(fitted.text), true);
    const frame = JSON.stringify({
      type: 'read_result',
      seq: 1,
      requestId: 'a'.repeat(64),
      ok: true,
      origin: 'https://example.test',
      title: fitted.title,
      text: fitted.text,
      truncated: fitted.truncated,
      proof: 'f'.repeat(64),
    });
    assert.ok(utf8Bytes(frame) <= 65536, `frame ${utf8Bytes(frame)} for ${text.slice(0, 3)}`);
    assert.equal(fitted.truncated, text.length > fitted.text.length);
  }
});
