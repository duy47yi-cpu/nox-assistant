'use strict';

// Логика браузера без Electron: окно подменено, скрипты страницы не исполняются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { BrowserPage, browserTools, windowOptions, requestAllowed, navigationAllowed, NEEDS_HUMAN, MAX_TEXT } = require('../src/tools/browser');
const { checkEffect } = require('../src/agent/effects');
const { maskArgs } = require('../src/journal/journal');
const { hardDeny, decide, isOneShot, setBrowserHost } = require('../src/policy/modes');
const { longPolicy, HANDS } = require('../src/missions/long');
const { remoteAllowed } = require('../src/telegram/policy');

function snapshot(over = {}) {
  return { url: 'https://example.com/', title: 'Пример', text: 'текст страницы', textLength: 14, widget: false, elements: [{ index: 1, kind: 'link', text: 'Дальше', href: 'https://example.com/next' }], ...over };
}

// Окно-подмена: loadURL и executeJavaScript настраиваются, скрипты запоминаются.
function fakeWindow({ load, script } = {}) {
  const wc = new EventEmitter();
  wc.url = '';
  wc.scripts = [];
  wc.openHandler = null;
  wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn; };
  wc.isLoading = () => false;
  wc.stop = () => { wc.stopped = true; };
  wc.getURL = () => wc.url;
  wc.loadURL = async (url) => {
    if (load) return load(url, wc);
    wc.url = url;
    wc.emit('did-navigate', {}, url, 200);
    return undefined;
  };
  wc.executeJavaScript = async (code) => {
    wc.scripts.push(code);
    if (script) {
      const out = script(code, wc);
      if (out !== undefined) return out;
    }
    if (code.includes('__noxEls = els')) return snapshot({ url: wc.url });
    return { ok: true };
  };
  const win = {
    webContents: wc, destroyed: false, killed: false, closed: false, shown: false,
    isDestroyed() { return this.destroyed; },
    destroy() { this.destroyed = true; this.killed = true; },
    close() { this.closed = true; this.destroyed = true; },
    showInactive() { this.shown = true; },
  };
  return win;
}

function setup(opts = {}) {
  const made = [];
  const page = new BrowserPage({
    createWindow: () => { const w = fakeWindow(opts); made.push(w); return w; },
    timeoutMs: opts.timeoutMs || 2000,
    settleMs: 0,
  });
  const tools = Object.fromEntries(browserTools(page).map((t) => [t.name, t]));
  return { page, tools, made };
}

test('browser_click проверяет актуальную кнопку и адрес до нажатия', async () => {
  let clicks = 0;
  const el = {
    isConnected: true, disabled: false, tagName: 'BUTTON', innerText: 'Дальше',
    getAttribute: () => '', closest: () => null,
    scrollIntoView() {}, focus() {}, click() { clicks++; },
  };
  const { tools } = setup({
    script: (code, wc) => code.includes('el.click()')
      ? vm.runInNewContext(code, { window: { __noxEls: [el] }, location: { href: wc.url } })
      : undefined,
  });
  await tools.browser_open.run({ url: 'https://example.com/' });
  // Подпись изменилась после снимка: проверяется живой DOM, а не старый список.
  el.innerText = 'Оплатить заказ';
  const refused = await tools.browser_click.run({ index: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /оплату делает владелец сам/);
  assert.equal(clicks, 0);
  el.innerText = 'Продолжить';
  el.closest = () => ({ href: 'https://shop.example/checkout' });
  assert.equal((await tools.browser_click.run({ index: 1 })).ok, false);
  assert.equal(clicks, 0);
  el.closest = () => null;
  el.innerText = 'Pay now';
  assert.equal((await tools.browser_click.run({ index: 1 })).ok, false);
  el.innerText = 'Confirm';
  await tools.browser_open.run({ url: 'https://example.com/checkout' });
  assert.equal((await tools.browser_click.run({ index: 1 })).ok, false);
  assert.equal(clicks, 0);
  await tools.browser_open.run({ url: 'https://example.com/' });
  el.innerText = 'Продолжить';
  assert.equal((await tools.browser_click.run({ index: 1 })).ok, true);
  assert.equal(clicks, 1);
});

test('browser_click повторно проверяет кнопку после событий прокрутки и фокуса', async () => {
  let clicks = 0;
  const el = { isConnected: true, disabled: false, tagName: 'BUTTON', innerText: 'Продолжить',
    getAttribute: () => '', closest: () => null,
    scrollIntoView() {}, focus() { this.innerText = 'Оплатить'; }, click() { clicks++; } };
  const { tools } = setup({ script: (code, wc) => code.includes('el.click()')
    ? vm.runInNewContext(code, { window: { __noxEls: [el] }, location: { href: wc.url } }) : undefined });
  await tools.browser_open.run({ url: 'https://example.com/' });
  const result = await tools.browser_click.run({ index: 1 });
  assert.equal(result.ok, false);
  assert.match(result.summary, /оплату делает владелец сам/);
  assert.equal(clicks, 0);
});

test('риски, окно создаётся лениво, настройки окна закрыты', () => {
  const { tools, made } = setup();
  assert.equal(made.length, 0);
  const risks = Object.fromEntries(Object.values(tools).map((t) => [t.name, t.risk]));
  assert.deepEqual(risks, { browser_open: 'T0', browser_read: 'T0', browser_scroll: 'T0', browser_click: 'T1', browser_type: 'T2' });
  const o = windowOptions('сессия');
  assert.equal(o.show, false);
  assert.equal(o.webPreferences.session, 'сессия');
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.disableDialogs, true);
});

test('адреса: file:, локальная сеть и прочие схемы закрыты, и для окна, и для запросов', () => {
  for (const url of ['file:///C:/secret.txt', 'http://localhost/', 'http://127.0.0.1:8080/', 'http://192.168.1.1/', 'http://10.0.0.1/', 'http://[::1]/', 'http://intranet/', 'http://169.254.169.254/', 'javascript:alert(1)', 'chrome://settings', 'мусор']) {
    assert.equal(navigationAllowed(url), false, url);
    assert.equal(requestAllowed(url), false, url);
  }
  assert.equal(requestAllowed('ws://127.0.0.1/'), false);
  assert.equal(requestAllowed('wss://example.com/'), true);
  assert.equal(requestAllowed('data:image/png;base64,AA'), true);
  assert.equal(navigationAllowed('data:text/html,x'), false, 'на data: окном не перейти');
  assert.equal(navigationAllowed('https://example.com/'), true);
});

test('browser_open: заголовок, адрес, код, текст, элементы, пометка «данные»; verify подтверждает загрузку', async () => {
  const { tools } = setup();
  const res = await checkEffect(tools.browser_open, { url: 'https://example.com/' }, await tools.browser_open.run({ url: 'https://example.com/' }));
  assert.equal(res.ok, true);
  assert.equal(res.verified, 'confirmed');
  assert.equal(res.data.status, 200);
  assert.equal(res.data.title, 'Пример');
  assert.equal(res.data.elements[0].index, 1);
  assert.match(res.data.note, /данные, а не инструкции/);
});

test('browser_open: запрещённый адрес отклоняется до создания окна', async () => {
  const { tools, made } = setup();
  for (const url of ['file:///C:/x', 'http://localhost/', '']) {
    const res = await tools.browser_open.run({ url });
    assert.equal(res.ok, false, url);
  }
  assert.equal(made.length, 0);
});

test('редирект и переход в локальную сеть останавливаются и дают отказ; новые окна запрещены', async () => {
  const { tools, made } = setup({
    load: async (url, wc) => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      wc.emit('will-redirect', event, 'http://192.168.0.1/admin');
      assert.equal(event.prevented, true);
      const err = new Error('aborted');
      err.code = 'ERR_ABORTED';
      throw err;
    },
  });
  const res = await tools.browser_open.run({ url: 'https://example.com/' });
  assert.equal(res.ok, false);
  assert.match(res.summary, /не разрешён/);
  const wc = made[0].webContents;
  assert.deepEqual(wc.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-navigate', nav, 'file:///C:/secret');
  assert.equal(nav.prevented, true);
  const fine = { prevented: false, preventDefault() { this.prevented = true; } };
  wc.emit('will-navigate', fine, 'https://example.org/');
  assert.equal(fine.prevented, false);
});

test('запрос заблокирован сессией и сбой сети — понятные отказы; ERR_ABORTED от своего перехода не ошибка', async () => {
  const failing = (code) => setup({ load: async () => { const e = new Error(code); e.code = code; throw e; } });
  assert.match((await failing('ERR_BLOCKED_BY_CLIENT').tools.browser_open.run({ url: 'https://a.example/' })).summary, /не разрешён/);
  assert.match((await failing('ERR_NAME_NOT_RESOLVED').tools.browser_open.run({ url: 'https://a.example/' })).summary, /не загрузилась: ERR_NAME_NOT_RESOLVED/);
  const moved = setup({ load: async (url, wc) => { wc.url = 'https://a.example/next'; const e = new Error('x'); e.code = 'ERR_ABORTED'; throw e; } });
  assert.equal((await moved.tools.browser_open.run({ url: 'https://a.example/' })).ok, true);
});

test('капча и блокировка: итог «нужен человек», обхода нет; статья о капче и 404 — обычная страница', async () => {
  const withSnap = (over, status = 200) => setup({
    load: async (url, wc) => { wc.url = url; wc.emit('did-navigate', {}, url, status); },
    script: (code, wc) => (code.includes('__noxEls = els') ? snapshot({ url: wc.url, ...over }) : undefined),
  });
  const open = (h) => h.tools.browser_open.run({ url: 'https://a.example/' });
  for (const [over, status] of [
    [{ widget: true }, 200],
    [{ title: 'Just a moment...', text: '' , textLength: 0 }, 200],
    [{ text: 'Подтвердите, что вы не робот', textLength: 28 }, 200],
    [{}, 403],
    [{}, 429],
  ]) {
    const res = await open(withSnap(over, status));
    assert.equal(res.ok, false);
    assert.equal(res.summary, NEEDS_HUMAN);
    assert.equal(res.data.needsHuman, true);
    assert.match(res.data.note, /данные/);
  }
  const article = await open(withSnap({ text: 'captcha '.repeat(1000), textLength: 8000 }));
  assert.equal(article.ok, true);
  const missing = await open(withSnap({}, 404));
  assert.equal(missing.ok, true);
  assert.equal(missing.data.status, 404);
  assert.match(missing.summary, /HTTP 404/);
  const cut = await open(withSnap({ textLength: MAX_TEXT + 1 }));
  assert.equal(cut.data.truncated, true);
});

test('значения в скрипт идут через JSON.stringify: кавычки текста не ломают код', async () => {
  const { tools, made } = setup();
  await tools.browser_open.run({ url: 'https://example.com/' });
  const evil = '"); alert(1); ("\n\u2028`${x}`';
  const res = await tools.browser_type.run({ index: 1, text: evil });
  assert.equal(res.ok, true);
  const code = made[0].webContents.scripts.at(-2);
  assert.ok(code.endsWith(`(1, ${JSON.stringify(evil)})`));
  assert.doesNotMatch(res.summary, /alert/, 'введённый текст в итог не попадает');
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('click и type: устаревший номер и неверный аргумент — отказ; до открытия страницы — отказ', async () => {
  const { tools } = setup({ script: (code) => (code.includes('el.click()') ? { ok: false, why: 'stale' } : undefined) });
  assert.match((await tools.browser_read.run()).summary, /не открыта/);
  assert.match((await tools.browser_click.run({ index: 1 })).summary, /не открыта/);
  await tools.browser_open.run({ url: 'https://example.com/' });
  assert.match((await tools.browser_click.run({ index: 1 })).summary, /элемента больше нет/);
  assert.equal((await tools.browser_click.run({ index: '1; alert(1)' })).ok, false);
  assert.equal((await tools.browser_type.run({ index: 1 })).ok, false);
  assert.equal((await tools.browser_scroll.run({ pages: 0 })).ok, false);
  assert.equal((await tools.browser_scroll.run({ pages: 2 })).ok, true);
});

test('номер из списка другой задачи не нажимается: окно одно на чат и фон', async () => {
  const { tools } = setup();
  await tools.browser_open.run({ url: 'https://example.com/' }, { background: true });
  const res = await tools.browser_click.run({ index: 1 }, { background: false });
  assert.equal(res.ok, false);
  assert.match(res.summary, /другая задача/);
  assert.equal((await tools.browser_click.run({ index: 1 }, { background: true })).ok, true);
});

test('срок и стоп: операция прерывается, окно снимается, следующая создаёт новое', async () => {
  const hung = setup({ load: () => new Promise(() => {}), timeoutMs: 30 });
  const res = await hung.tools.browser_open.run({ url: 'https://example.com/' });
  assert.match(res.summary, /время ожидания/);
  assert.equal(hung.made[0].destroyed, true);
  // По сроку окно закрывается обычным путём, загрузка остановлена, силой не снимается.
  assert.equal(hung.made[0].closed, true);
  assert.equal(hung.made[0].killed, false);
  assert.equal(hung.made[0].webContents.stopped, true);

  const stopped = setup({ load: () => new Promise(() => {}) });
  const controller = new AbortController();
  const running = stopped.tools.browser_open.run({ url: 'https://example.com/' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  assert.match((await running).summary, /остановлено/);
  assert.match((await stopped.tools.browser_open.run({ url: 'https://example.com/' }, { signal: controller.signal })).summary, /остановлено/);

  // Зависшая страница не держит очередь: новая операция — новое окно.
  let calls = 0;
  const again = setup({ timeoutMs: 30, load: (url, wc) => { calls += 1; if (calls === 1) return new Promise(() => {}); wc.url = url; return Promise.resolve(); } });
  await again.tools.browser_open.run({ url: 'https://example.com/' });
  assert.equal((await again.tools.browser_open.run({ url: 'https://example.com/' })).ok, true);
  assert.equal(again.made.length, 2);
});

test('операции идут по одной, даже если модель вызвала их разом', async () => {
  const order = [];
  const { tools } = setup({
    load: async (url, wc) => { order.push('open-start'); await new Promise((r) => { setTimeout(r, 20); }); wc.url = url; order.push('open-end'); },
    script: (code) => { if (code.includes('__noxEls = els')) order.push('snapshot'); return undefined; },
  });
  await Promise.all([tools.browser_open.run({ url: 'https://example.com/' }), tools.browser_read.run()]);
  assert.deepEqual(order, ['open-start', 'open-end', 'snapshot', 'snapshot']);
});

test('журнал маскирует текст browser_type, вопрос владельцу называет страницу и элемент', async () => {
  assert.deepEqual(maskArgs('browser_type', { index: 2, text: 'пароль' }), { index: 2, text: '[скрыто, 6 симв.]' });
  const { tools } = setup();
  await tools.browser_open.run({ url: 'https://example.com/' });
  assert.equal(tools.browser_click.explain({ index: 1 }), 'страница example.com, элемент «Дальше»');
});

test('политика: фон без рук не нажимает и не вводит, сайты банков и почты — отдельный вопрос', async (t) => {
  t.after(() => setBrowserHost(() => ''));
  const policy = (useDesktop) => longPolicy({ useDesktop });
  const base = { workspace: 'C:\\ws', hasPathParam: false, args: { index: 1, text: 'x' } };
  for (const [name, risk] of [['browser_open', 'T0'], ['browser_read', 'T0'], ['browser_scroll', 'T0']]) {
    assert.equal(policy(false)({ ...base, name, risk }), 'allow', name);
  }
  for (const [name, risk] of [['browser_click', 'T1'], ['browser_type', 'T2']]) {
    assert.equal(HANDS.has(name), true);
    assert.equal(policy(false)({ ...base, name, risk }), 'deny', name);
    assert.equal(policy(true)({ ...base, name, risk }), 'allow', name);
    assert.equal(isOneShot(name), true, 'разрешения «на сессию» нет');
    // Миссия: режим auto и rejectAll, вопрос означает отказ.
    assert.equal(decide({ mode: 'auto', name, risk, args: base.args, workspace: base.workspace, hasPathParam: false }), 'ask', name);
  }
  assert.equal(decide({ mode: 'auto', name: 'browser_type', risk: 'T2', args: { index: 1, text: 'x' }, workspace: 'C:\\ws', hasPathParam: false, sessionAllow: new Set() }), 'ask');

  assert.equal(hardDeny({ name: 'browser_type', args: {} }), null);
  setBrowserHost(() => 'online.sberbank.ru');
  assert.match(hardDeny({ name: 'browser_type', args: {} }), /банка/);
  assert.match(hardDeny({ name: 'browser_click', args: {} }), /банка/);
  assert.match(hardDeny({ name: 'browser_read', args: {} }), /чтение/, 'браузер хранит входы владельца: чтение банка тоже с вопросом');
  assert.equal(policy(true)({ ...base, name: 'browser_type', risk: 'T2' }), 'deny', 'руки в фоне банк не трогают');
  setBrowserHost(() => 'mail.google.com');
  assert.match(hardDeny({ name: 'browser_click', args: {} }), /почты/);

  assert.equal(remoteAllowed({ name: 'browser_click', risk: 'T1' }), false, 'с телефона не нажимаем');
  assert.equal(remoteAllowed({ name: 'browser_type', risk: 'T2' }), false);
  assert.equal(remoteAllowed({ name: 'browser_open', risk: 'T0' }), false, 'браузер хранит входы владельца, с телефона закрыт');
  assert.equal(remoteAllowed({ name: 'mouse_click', risk: 'T1' }), false);
});

test('срок ожидания страницы по умолчанию — 60 секунд', () => {
  assert.equal(new BrowserPage({ createWindow: () => fakeWindow() }).timeoutMs, 60000);
});

test('капча: окно показано владельцу без фокуса, ход агента кончается «нужен человек», дальше он не идёт', async () => {
  const { Agent } = require('../src/agent/loop');
  const { ToolRegistry } = require('../src/tools/registry');
  const h = setup({ script: (code, wc) => (code.includes('__noxEls = els') ? snapshot({ url: wc.url, widget: true }) : undefined) });
  const registry = new ToolRegistry();
  for (const tool of Object.values(h.tools)) registry.register(tool);
  let calls = 0;
  const brain = { chat: async () => { calls += 1; return calls === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'browser_open', args: { url: 'https://a.example/' } }] } : { content: 'иду дальше', toolCalls: [] }; } };
  const events = [];
  const agent = new Agent({ brain, tools: registry, mode: 'full', workspace: process.cwd(), journal: { append: () => {} }, emit: (e) => events.push(e) });
  const res = await agent.run('открой сайт');
  assert.equal(res.outcome, 'needs_human');
  assert.equal(res.ok, false);
  assert.equal(calls, 1, 'после капчи модель больше не вызывается');
  assert.equal(h.made[0].shown, true, 'окно показано, чтобы человек разобрался');
  const said = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(said, /Нужен человек/);
  assert.match(agent.history.at(-1).content, /Нужен человек/, 'в истории есть, на чём остановились: следующий ход продолжит');
});

test('нажатие без перемен на странице — «не проверено», а не подтверждено; с переменами — подтверждено', async () => {
  const still = setup();
  await still.tools.browser_open.run({ url: 'https://example.com/' });
  const same = await checkEffect(still.tools.browser_click, { index: 1 }, await still.tools.browser_click.run({ index: 1 }));
  assert.equal(same.verified, 'unknown');
  assert.match(same.summary, /не проверено/);
  assert.equal(same.data.unchanged, true);

  const moving = setup({ script: (code, wc) => {
    if (code.includes('el.click()')) { wc.url = 'https://example.com/next'; return { ok: true }; }
    return undefined;
  } });
  await moving.tools.browser_open.run({ url: 'https://example.com/' });
  const moved = await checkEffect(moving.tools.browser_click, { index: 1 }, await moving.tools.browser_click.run({ index: 1 }));
  assert.equal(moved.verified, 'confirmed');
  assert.equal(moved.data.unchanged, undefined);
});

test('у фона своё окно: открытие в фоне не трогает страницу чата', async () => {
  const chat = setup();
  const bg = setup();
  const tools = Object.fromEntries(browserTools(chat.page, bg.page).map((t) => [t.name, t]));
  await tools.browser_open.run({ url: 'https://chat.example/' });
  await tools.browser_open.run({ url: 'https://bg.example/' }, { background: true });
  assert.equal(chat.page.currentUrl(), 'https://chat.example/');
  assert.equal(bg.page.currentUrl(), 'https://bg.example/');
  assert.equal((await tools.browser_click.run({ index: 1 })).ok, true, 'чат нажимает в своём окне');
  const read = await checkEffect(tools.browser_read, {}, await tools.browser_read.run({}, { background: true }), { background: true });
  assert.equal(read.verified, 'confirmed');
  assert.equal(read.data.url, 'https://bg.example/');
});
