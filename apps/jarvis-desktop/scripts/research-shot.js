// Настоящее окно: компактный поиск и источники на синтетических событиях, без сети и модели.
// Запуск из apps/jarvis-desktop: npx electron scripts/research-shot.js <папка-снимков>
'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'nox-research-shot'));
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-research-profile-'));
process.env.NOX_DATA_DIR = profile;
process.env.NOX_SERVER_URL = '';
process.env.NOX_BRAIN_KEY = '';
process.env.NOX_SMART_KEY = '';
process.env.NOX_DISABLE_BACKGROUND_MODEL_RUNS = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let win;
const report = [];

async function js(code) {
  return win.webContents.executeJavaScript(code, true);
}
async function shot(name) {
  const image = await win.webContents.capturePage();
  const file = path.join(out, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}
function emit(event) {
  win.webContents.send('agent:event', event);
}
async function resize(w, h) {
  win.setContentSize(w, h);
  win.show();
  win.focus();
  await sleep(250);
}

async function run() {
  try {
    await js(`window.JarvisNox.show('nox'); document.body.dataset.replyStyle = 'rich'; true`);
    await resize(1200, 720);
    emit({ type: 'tool_start', id: 'skill', runId: 'demo', step: 1, name: 'skills_list', args: {} });
    emit({ type: 'tool_result', id: 'skill', runId: 'demo', step: 1, ok: true, summary: 'навыков: 4', status: 'succeeded' });
    emit({ type: 'tool_start', id: 'research', runId: 'demo', step: 2, name: 'web_research', args: { queries: ['Anthropic company founders funding valuation'] } });
    await sleep(350);

    const running = await js(`(() => {
      const box = document.querySelector('.turn-acts');
      const word = document.querySelector('.search-word');
      return { research: box.classList.contains('is-research'), open: box.open,
        label: box.querySelector('.acts-sum').textContent, rawRows: box.querySelectorAll('.act-row').length,
        shimmer: getComputedStyle(word).animationName,
        dots: [...box.querySelectorAll('.search-dots span')].map((n) => getComputedStyle(n).animationName),
        height: Math.round(box.getBoundingClientRect().height) };
    })()`);
    assert.equal(running.research, true);
    assert.equal(running.open, false);
    assert.equal(running.rawRows, 0);
    assert.match(running.label, /Ищу/);
    assert.notEqual(running.shimmer, 'none');
    assert.ok(running.dots.every((name) => name !== 'none'));
    report.push({ state: 'running', ...running, file: await shot('research-running-1200x720') });

    const sources = [
      ['Anthropic — Wikipedia', 'https://en.wikipedia.org/wiki/Anthropic'],
      ['Anthropic — официальный сайт', 'https://www.anthropic.com/company'],
      ['Anthropic raises funding — Reuters', 'https://www.reuters.com/technology/anthropic-example'],
      ['Dario Amodei — Britannica', 'https://www.britannica.com/biography/Dario-Amodei'],
      ['AI safety research — arXiv', 'https://arxiv.org/abs/2204.05862'],
      ['Constitutional AI — Anthropic', 'https://www.anthropic.com/research/constitutional-ai'],
    ].map(([title, url]) => ({ title, url, host: new URL(url).hostname, status: 'read' }));
    emit({ type: 'tool_result', id: 'research', runId: 'demo', step: 2, ok: true,
      summary: 'источников найдено: 15, прочитано: 6; researchId: research_secret_internal', status: 'succeeded', sources });
    emit({ type: 'text', delta: 'Собрал свежую справку. Ниже — главное, а ссылки спрятаны под кнопкой **«Источники»**.' });
    emit({ type: 'done', runId: 'demo', outcome: 'succeeded' });
    await sleep(350);

    const closed = await js(`(() => {
      const box = document.querySelector('.turn-acts');
      const sum = box.querySelector('.acts-sum').getBoundingClientRect();
      return { open: box.open, label: box.querySelector('.acts-sum').textContent,
        sources: box.querySelectorAll('.research-source').length, rawRows: box.querySelectorAll('.act-row').length,
        technical: /researchId|Anthropic company founders|Сбор и чтение/.test(box.textContent),
        width: Math.round(sum.width), height: Math.round(sum.height) };
    })()`);
    assert.equal(closed.open, false);
    assert.equal(closed.label, 'Источники · 6');
    assert.equal(closed.sources, 6);
    assert.equal(closed.rawRows, 0);
    assert.equal(closed.technical, false);
    assert.ok(closed.height <= 30 && closed.width < 180);
    report.push({ state: 'closed', ...closed, file: await shot('research-closed-1200x720') });

    await js(`document.querySelector('.turn-acts .acts-sum').click(); true`);
    await sleep(250);
    const opened = await js(`(() => {
      const box = document.querySelector('.turn-acts');
      return { open: box.open, visible: [...box.querySelectorAll('.research-source-link')].filter((n) => n.getBoundingClientRect().height > 0).length,
        titles: [...box.querySelectorAll('.research-source-title')].map((n) => n.textContent),
        rawRows: box.querySelectorAll('.act-row').length };
    })()`);
    assert.equal(opened.open, true);
    assert.equal(opened.visible, 6);
    assert.equal(opened.rawRows, 0);
    assert.match(opened.titles[0], /Wikipedia/);
    report.push({ state: 'opened', ...opened, file: await shot('research-open-1200x720') });

    await js(`document.querySelector('.turn-acts').open = false; true`);
    await resize(864, 520);
    report.push({ state: 'closed-small', file: await shot('research-closed-864x520') });
    const smallOpen = await js(`document.querySelector('.turn-acts .acts-sum').click(); document.querySelector('.turn-acts').open`);
    await sleep(350);
    assert.equal(smallOpen, true);
    report.push({ state: 'opened-small', open: smallOpen, file: await shot('research-open-864x520') });

    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.map(({ file, ...item }) => item), null, 2));
    app.exitCode = 0;
  } catch (error) {
    console.error(error.stack || error);
    app.exitCode = 1;
  } finally {
    app.exit(app.exitCode);
  }
}

app.on('browser-window-created', (_event, created) => {
  win = created;
  win.webContents.once('did-finish-load', () => setTimeout(run, 600));
});
app.whenReady().then(() => require('../main.js'));
