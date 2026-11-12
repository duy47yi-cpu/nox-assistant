'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, globalShortcut, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-quick-qa-'));
const profile = path.join(root, 'profile');
const data = path.join(root, 'data');
fs.mkdirSync(profile); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ voice: false, backgroundModelRuns: false, desktopOverlay: false, mode: 'ask' }));
app.setPath('userData', profile);
for (const key of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
process.env.NOX_DATA_DIR = data;
require('../src/config/paths').projectRoot = () => root;
const shortcuts = new Map();
globalShortcut.register = (key, cb) => { if (shortcuts.has(key)) return false; shortcuts.set(key, cb); return true; };
globalShortcut.unregister = (key) => shortcuts.delete(key);
globalShortcut.unregisterAll = () => shortcuts.clear();
// --busy: клавишу быстрого чата до запуска заняла «другая программа».
const busyStart = process.argv.includes('--busy');
if (busyStart) shortcuts.set('Control+Alt+Space', () => {});
const out = path.resolve(process.argv[2] || path.join(root, 'shots'));
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('QUICK_QA timeout'); app.exit(1); }, 120000);
async function run() {
  let main, mini;
  for (let i = 0; i < 100 && (!main || !mini); i++) {
    await sleep(400);
    main = BrowserWindow.getAllWindows().find((w) => /index\.html/.test(w.webContents.getURL()));
    mini = BrowserWindow.getAllWindows().find((w) => /mini\.html/.test(w.webContents.getURL()));
  }
  if (!main || !mini) throw new Error('Окна не созданы');
  if (busyStart) {
    let status = '';
    for (let i = 0; i < 40 && !/занято/.test(status); i++) { await sleep(250); status = await main.webContents.executeJavaScript("document.querySelector('#quickHotkeyStatus').textContent"); }
    const hotkey = await main.webContents.executeJavaScript('window.jarvis.quickHotkey()');
    const ok = /занято/.test(status) && hotkey.registered === false && !main.isDestroyed();
    console.log('QUICK_QA_BUSY ' + JSON.stringify({ ok, status, hotkey }));
    clearTimeout(deadline); app.exit(ok ? 0 : 1); return;
  }
  const open = shortcuts.get('Control+Alt+Space');
  if (!open) throw new Error('Сочетание не зарегистрировано');
  open(); await sleep(600);
  const initial = await mini.webContents.executeJavaScript(`({ visible: !document.hidden, focus: document.activeElement.id, errors: document.querySelector('#fatalBox')?.innerText || '' })`);
  await mini.webContents.executeJavaScript("window.JarvisTheme.apply('dark')");
  await sleep(300);
  fs.writeFileSync(path.join(out, 'quick-dark.png'), (await mini.webContents.capturePage()).toPNG());
  await mini.webContents.executeJavaScript("window.JarvisTheme.apply('light')");
  await sleep(300);
  fs.writeFileSync(path.join(out, 'quick-light.png'), (await mini.webContents.capturePage()).toPNG());
  await mini.webContents.executeJavaScript("document.querySelector('#quickInput').value='какая погода'; document.querySelector('#quickInput').focus()");
  mini.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  mini.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await mini.webContents.executeJavaScript("!!(document.querySelector('#quickReply').textContent || document.querySelector('#quickError').textContent)")) break;
  }
  const state = await mini.webContents.executeJavaScript(`({ reply: document.querySelector('#quickReply').textContent, error: document.querySelector('#quickError').textContent, work: !document.querySelector('#quickWork').hidden, fatal: document.querySelector('#fatalBox')?.innerText || '' })`);
  const mainText = await main.webContents.executeJavaScript('document.body.innerText');
  const common = mainText.includes('какая погода');
  const originalChat = await main.webContents.executeJavaScript('(async () => (await window.jarvis.chatList()).activeId)()');
  shortcuts.set('Control+Alt+X', () => {});
  const conflict = await main.webContents.executeJavaScript("(async () => { const result = await window.jarvis.setQuickHotkey('Ctrl+Alt+X'); const state = await window.jarvis.quickHotkey(); return result.ok === false && state.registered && state.key === 'Control+Alt+Space'; })()");
  // То же через кнопку в Настройках: отказ виден словами.
  const conflictText = await main.webContents.executeJavaScript("(async () => { document.querySelector('#quickHotkeyInput').value = 'Ctrl+Alt+X'; document.querySelector('#quickHotkeySave').click(); await new Promise((r) => setTimeout(r, 500)); return document.querySelector('#quickHotkeyStatus').textContent; })()");
  async function send(text) {
    mini.focus();
    await mini.webContents.executeJavaScript(`document.querySelector('#quickInput').value=${JSON.stringify(text)}; document.querySelector('#quickForm').requestSubmit()`);
  }
  async function until(expression, seconds = 15) {
    for (let i = 0; i < seconds * 4; i++) {
      await sleep(250);
      if (await mini.webContents.executeJavaScript(expression)) return true;
    }
    return false;
  }
  async function click(selector) {
    const pos = await mini.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2)}; })()`);
    mini.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pos });
    mini.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pos });
  }
  await until("document.querySelector('#miniStop').hidden");
  await sleep(400);
  await send('проверка разрешения отклонить');
  const shown = await until("!document.querySelector('#miniApproval').hidden && !document.querySelector('#approvalAllow').disabled");
  let exact = false, rejected = false, allowed = false, expired = false, stopped = false, resumed = false, escapeStopped = false, allowDetail = null;
  if (shown) {
    exact = await mini.webContents.executeJavaScript("document.querySelector('#approvalArgs').textContent.includes('Точный тестовый текст')");
    fs.writeFileSync(path.join(out, 'quick-approval.png'), (await mini.webContents.capturePage()).toPNG());
    await click('#approvalReject');
    rejected = await until("document.querySelector('#miniApproval').hidden");
    await until("document.querySelector('#miniStop').hidden");
    await send('проверка разрешения разрешить');
    if (await until("!document.querySelector('#miniApproval').hidden && !document.querySelector('#approvalAllow').disabled")) {
      await click('#approvalAllow');
      for (let i = 0; i < 60 && !fs.existsSync(path.join(root, 'workspace', 'quick-qa.txt')); i++) await sleep(250);
      allowed = fs.existsSync(path.join(root, 'workspace', 'quick-qa.txt')) && fs.readFileSync(path.join(root, 'workspace', 'quick-qa.txt'), 'utf8') === 'Точный тестовый текст';
      allowDetail = await mini.webContents.executeJavaScript("({error:document.querySelector('#approvalError').textContent, pending:!document.querySelector('#miniApproval').hidden, reply:document.querySelector('#quickReply').textContent, status:document.querySelector('#quickStatus').textContent})");
    }
  }
  if (!process.argv.includes('--fast')) {
    await until("document.querySelector('#miniStop').hidden");
    await send('проверка разрешения ожидание');
    if (await until("!document.querySelector('#miniApproval').hidden && !document.querySelector('#approvalAllow').disabled")) {
      expired = await until("document.querySelector('#miniApproval').hidden", 35);
      expired = expired && !fs.existsSync(path.join(root, 'workspace', 'quick-timeout.txt'));
    }
  }
  await until("document.querySelector('#miniStop').hidden");
  await send('проверка остановка');
  if (await until("!document.querySelector('#miniStop').hidden")) {
    await click('#miniStop');
    stopped = await until("document.querySelector('#quickReply').textContent.includes('Остановлено')");
  }
  await until("document.querySelector('#miniStop').hidden");
  await sleep(400);
  await send('проверка остановка ещё раз');
  if (await until("!document.querySelector('#miniStop').hidden")) {
    open(); await sleep(400);
    const wasHidden = !mini.isVisible();
    open(); await sleep(400);
    resumed = wasHidden && await mini.webContents.executeJavaScript("!document.querySelector('#miniStop').hidden");
    mini.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    mini.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(400);
    const escapeHidden = !mini.isVisible();
    open(); await sleep(400);
    escapeStopped = escapeHidden && await until("document.querySelector('#quickReply').textContent.includes('Остановлено')");
  }
  mini.webContents.send('agent:event', { type: 'approval_request', id: 'qa-gate-a', name: 'workspace_write', args: { content: 'первый' } });
  mini.webContents.send('agent:event', { type: 'approval_request', id: 'qa-gate-b', name: 'workspace_write', args: { content: 'второй' } });
  await sleep(300);
  mini.webContents.send('agent:event', { type: 'approval_closed', id: 'qa-gate-a' });
  await sleep(300);
  const gateWorks = await mini.webContents.executeJavaScript("!document.querySelector('#approvalNext').hidden && document.querySelector('#approvalAllow').disabled");
  mini.webContents.send('agent:event', { type: 'approval_closed', id: 'qa-gate-b' });
  mini.webContents.send('agent:event', { type: 'done', status: 'succeeded' });
  await sleep(200);
  mini.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  mini.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await sleep(400);
  const hidden = !mini.isVisible();
  await until("document.querySelector('#miniStop').hidden");
  await main.webContents.executeJavaScript('window.jarvis.chatNew()');
  open(); await sleep(500);
  await mini.webContents.executeJavaScript("document.querySelector('#miniExpand').click()");
  let reopened = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await main.webContents.executeJavaScript(`(async () => (await window.jarvis.chatList()).activeId === ${JSON.stringify(originalChat)})()`)) { reopened = true; break; }
  }
  const ok = initial.visible && initial.focus === 'quickInput' && !initial.errors && state.work && !!state.reply && !state.error && !state.fatal && common && hidden && reopened && conflict && /недоступно/.test(conflictText) && shown && exact && rejected && allowed && (expired || process.argv.includes('--fast')) && stopped && resumed && escapeStopped && gateWorks;
  console.log('QUICK_QA ' + JSON.stringify({ ok, initial, state, common, hidden, reopened, conflict, conflictText, shown, exact, rejected, allowed, expired, stopped, resumed, escapeStopped, gateWorks, allowDetail, out }));
  clearTimeout(deadline); app.exit(ok ? 0 : 1);
}
const server = require('http').createServer((req, res) => {
  let raw = '';
  req.on('data', (part) => { raw += part; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const messages = body.messages || [];
    const lastUser = messages.findLastIndex((m) => m.role === 'user');
    const user = lastUser >= 0 ? String(messages[lastUser].content || '') : '';
    const needsTool = user.includes('проверка разрешения') && !messages.slice(lastUser + 1).some((m) => m.role === 'tool');
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Тестовый ответ' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (user.includes('проверка остановка')) {
      let count = 0;
      const timer = setInterval(() => {
        if (res.destroyed || ++count > 40) { clearInterval(timer); if (!res.destroyed) res.end('data: [DONE]\n\n'); return; }
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Ожидание. ' }, finish_reason: null }] }) + '\n\n');
      }, 200);
      res.on('close', () => clearInterval(timer));
      return;
    }
    const file = user.includes('ожидание') ? 'quick-timeout.txt' : 'quick-qa.txt';
    const delta = needsTool ? { tool_calls: [{ index: 0, id: 'qa-write', type: 'function', function: { name: 'workspace_write', arguments: JSON.stringify({ path: file, content: 'Точный тестовый текст' }) } }] } : { content: 'Тестовый ответ.' };
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: needsTool ? 'tool_calls' : 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
server.listen(0, '127.0.0.1', () => {
  process.env.NOX_BRAIN_KEY = 'local-test-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${server.address().port}/v1`;
  app.whenReady().then(() => run().catch((err) => { console.error(err.stack); clearTimeout(deadline); app.exit(1); }));
  require('../main');
});
