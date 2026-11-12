'use strict';

// Снимки настоящего окна во всех стилях ответа. Модель — только локальный HTTP-сервер.
// Запуск: npx electron scripts/reply-style-shot.js <папка для снимков>.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, globalShortcut } = require('electron');

const outDir = path.resolve(process.argv[2] || os.tmpdir());
fs.mkdirSync(outDir, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-reply-style-'));
for (const key of Object.keys(process.env)) if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
process.env.NOX_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.NOX_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.NOX_DATA_DIR, 'settings.json'), JSON.stringify({
  voice: false, backgroundModelRuns: false, alwaysListen: false, dictation: false, desktopOverlay: false,
  motion: false, seededBrief: true, clipboardHistory: false, quiet: true, keepAwake: 'off',
  replyStyle: 'rich', modelTier: 'fast', thinking: 'low',
}));
app.setPath('userData', path.join(root, 'profile'));
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};

const tex = String.raw;
const REPLY = [
  'Средняя плотность Стрельца A* примерно в **708 раз** выше солнечной.',
  '',
  '**Объём и плотность:**',
  tex`$$V = \frac{4\pi R^3}{3} \approx 8{,}58 \times 10^{30}\ \text{м}^3, \quad \bar{\rho} = \frac{M}{V} = \frac{8{,}55 \times 10^{36}}{8{,}58 \times 10^{30}} \approx 9{,}97 \times 10^5\ \text{кг/м}^3$$`,
  '',
  '**Сравнение масс:**',
  tex`$$\frac{M_\odot}{M_J} \approx 1048, \quad \frac{M_{A^*}}{M_\odot} = 4{,}30\ \text{млн}, \quad \frac{M_{A^*}}{M_J} \approx 4{,}50\ \text{млрд}$$`,
  '',
  tex`Юпитер уступает ей в **752 раза**, а скорость убегания $v = \sqrt{2GM/R}$ равна скорости света. Цена вопроса — $5, не формула.`,
  '',
  '* Плотность чёрной дыры здесь — **масса, делённая на объём внутри горизонта**, а не плотность вещества.',
].join('\n');

let prompt = '';
let brainServer = null;
function startBrain() {
  return new Promise((resolve, reject) => {
    brainServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* запрос без тела */ }
        prompt = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
        const msg = { role: 'assistant', content: REPLY };
        const model = body.model || 'local-reply-style';
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'local', object: 'chat.completion', model, choices: [{ index: 0, message: msg, finish_reason: 'stop' }], usage }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const write = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
        write({ id: 'local', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: msg, finish_reason: null }] });
        write({ id: 'local', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        write({ id: 'local', object: 'chat.completion.chunk', model, choices: [], usage });
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    brainServer.once('error', reject);
    brainServer.listen(0, '127.0.0.1', () => resolve(brainServer.address().port));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function probe(win) {
  win.webContents.setBackgroundThrottling(false);
  const js = (src) => win.webContents.executeJavaScript(src, true);
  const when = async (src) => {
    for (let i = 0; i < 300; i += 1) {
      if (await js(src)) return;
      await sleep(50);
    }
    throw new Error('не дождался: ' + src);
  };
  await when('Boolean(window.jarvis && document.querySelector("#chatInput"))');
  const results = [];
  for (const view of ['nox', 'dialog']) {
    for (const style of (view === 'nox' ? ['rich', 'plain', 'notes'] : ['rich'])) {
      for (const [width, height] of [[1200, 720], [864, 520]]) {
        await js(`(async () => {
          await window.jarvis.setReplyStyle(${JSON.stringify(style)});
          document.body.dataset.replyStyle = ${JSON.stringify(style)};
          const select = document.querySelector('#setReplyStyle'); if (select) select.value = ${JSON.stringify(style)};
          window.JarvisNox.show('nox');
          const fresh = document.querySelector('#noxNewChat'); if (fresh) fresh.click();
        })()`);
        win.setContentSize(width, height);
        win.show();
        await sleep(250);
        await js(`(() => { const i = document.querySelector('#chatInput'); i.value = 'Сравни плотность чёрной дыры и Солнца'; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#chatSend').click(); })()`);
        await when('document.querySelectorAll(".md .math").length > 0 && document.querySelector("#chatStop").hidden');
        if (view === 'dialog') await js(`window.JarvisNox.show('dialog')`);
        await sleep(300);
        const facts = await js(`(() => { const md = [...document.querySelectorAll('.md')].at(-1); return {
          style: document.body.dataset.replyStyle, view: document.body.dataset.view, math: md.querySelectorAll('.math').length,
          blocks: md.querySelectorAll('.math-block').length, fracs: md.querySelectorAll('.m-frac').length,
          strong: md.querySelectorAll('strong').length, rawDollar: /\\$5/.test(md.innerText),
          leftover: /\\\\frac|\\$\\$/.test(md.innerText), select: document.querySelector('#setReplyStyle')?.value,
          size: [innerWidth, innerHeight] }; })()`);
        facts.promptHasStyle = style === 'plain' || new RegExp(`Оформление ответа «${style === 'rich' ? 'Выразительный' : 'Конспект'}»`).test(prompt);
        const file = path.join(outDir, `reply-style-${view}-${style}-${width}x${height}.png`);
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        results.push({ ...facts, file });
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.promptHasStyle || !r.rawDollar || r.leftover)) app.exitCode = 1;
  if (brainServer) brainServer.close();
  app.exit(app.exitCode || 0);
}

const fail = (err) => {
  console.error(err.stack || err);
  if (brainServer) brainServer.close();
  app.exit(1);
};
app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => probe(win).catch(fail)));
app.whenReady().then(() => startBrain()).then((port) => {
  process.env.NOX_BRAIN_KEY = 'reply-style-local-fake-key';
  process.env.NOX_BRAIN_URL = `http://127.0.0.1:${port}/v1`;
  require(path.join(__dirname, '..', 'main.js'));
}).catch(fail);
setTimeout(() => fail(new Error('таймаут')), 180000).unref();
