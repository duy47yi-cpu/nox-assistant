'use strict';

// P0-5 (F-3): приватность снимков экрана.
// 1. Автоснимок после действия запрещён поверх защищённого окна (HARD_WINDOW) и при сбое ui_windows.
// 2. Факт автоснимка и отказа пишется в журнал без байтов картинки.
// 3. screen_look управляется через allowed() («по просьбе»), в main.js включается только на время хода.
// 4. Состав снимка (buildScene, regionTools, screenTools) не хранит временные файлы, не держит область дольше показа и скрывает секреты в полях.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScreenAgent } = require('../src/screen/agent');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const modes = require('../src/policy/modes');
const { screenTools, regionTools, REGION_TTL_MS } = require('../src/tools/screen');
const { buildScene } = require('../src/perception/scene');

const call = (name, args = {}, id) => ({ id: id || `c${Math.random()}`, name, args });
function brainOf(step) {
  const brain = { calls: 0, async chat() { brain.calls += 1; return step(brain.calls); } };
  return brain;
}

function setupPrivacy(t, windowsProvider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-privacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let lookCalls = 0;
  const reg = new ToolRegistry();
  reg.register({
    name: 'ui_click', risk: 'T1', description: '', parameters: { type: 'object', properties: {} },
    async run() { return { ok: true, summary: 'нажал' }; },
    async verify() { return { status: 'confirmed', evidence: 'ok' }; },
  });
  if (windowsProvider !== null) {
    reg.register({
      name: 'ui_windows', risk: 'T0', description: '',
      async run() { return windowsProvider(); },
    });
  }
  const look = {
    name: 'screen_look', risk: 'T1', description: '',
    async run() {
      lookCalls += 1;
      return { ok: true, summary: `снимок ${lookCalls}`, image: `data:image/jpeg;base64,SHOT_${lookCalls}` };
    },
  };
  const journalPath = path.join(dir, 'journal.jsonl');
  const brain = brainOf((n) => (n === 1
    ? { toolCalls: [call('screen_look')] }
    : n === 2
      ? { toolCalls: [call('ui_click', { window: 'Блокнот', name: 'Файл' })] }
      : { content: 'Готово.' }));
  const agent = new ScreenAgent({
    brain, tools: reg, look, policy: modes, approvals: new ApprovalBroker(),
    journal: new Journal(journalPath), emit: () => {}, mode: 'full', workspace: dir,
  });
  const readJournal = () => fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { agent, readJournal, journalPath, getLookCalls: () => lookCalls };
}

describe('F-3: автоснимок и защищённые окна', () => {
  test('автоснимок не делается, когда поверх окно мессенджера (Telegram)', async (t) => {
    const { agent, readJournal, journalPath, getLookCalls } = setupPrivacy(t, () => ({
      ok: true, summary: 'окна', data: { windows: [{ title: 'Telegram — Иван', process: 'Telegram', handle: 1, active: true }] },
    }));
    const res = await agent.run('нажми Файл');
    assert.equal(res.outcome, 'answer');
    assert.equal(getLookCalls(), 1, 'после действия снимок не сделан');
    const images = agent.history.filter((m) => m.image);
    assert.equal(images.length, 1, 'в истории только начальный снимок');
    const auto = readJournal().find((r) => r.tool === 'screen_look' && r.args && r.args.auto);
    assert.ok(auto, 'в журнале есть запись об автоснимке');
    assert.equal(auto.decision, 'deny');
    assert.equal(auto.ok, false);
    const raw = fs.readFileSync(journalPath, 'utf8');
    assert.doesNotMatch(raw, /SHOT_/, 'картинка не пишется в journal.jsonl');
  });

  test('автоснимок не делается поверх банка, почты и менеджера паролей', async (t) => {
    for (const title of ['Сбербанк Онлайн — Chrome', 'KeePassXC — База', '1Password', 'Входящие — Gmail']) {
      const { agent, readJournal, getLookCalls } = setupPrivacy(t, () => ({
        ok: true, summary: 'окна', data: { windows: [{ title, active: true }] },
      }));
      await agent.run('нажми');
      assert.equal(getLookCalls(), 1, `для «${title}» автоснимок запрещён`);
      const auto = readJournal().find((r) => r.tool === 'screen_look' && r.args && r.args.auto);
      assert.equal(auto.decision, 'deny', `для «${title}» в журнале deny`);
    }
  });

  test('автоснимок делается, когда впереди целевое окно (Блокнот)', async (t) => {
    const { agent, readJournal, journalPath, getLookCalls } = setupPrivacy(t, () => ({
      ok: true, summary: 'окна', data: { windows: [{ title: 'Блокнот', process: 'notepad', handle: 2, active: true }] },
    }));
    const res = await agent.run('нажми Файл');
    assert.equal(res.outcome, 'answer');
    assert.equal(getLookCalls(), 2, 'начальный + автоснимок после действия');
    const images = agent.history.filter((m) => m.image);
    assert.equal(images.length, 2, 'оба снимка дошли до модели');
    const auto = readJournal().find((r) => r.tool === 'screen_look' && r.args && r.args.auto);
    assert.ok(auto);
    assert.equal(auto.decision, 'allow');
    assert.equal(auto.ok, true);
    const raw = fs.readFileSync(journalPath, 'utf8');
    assert.doesNotMatch(raw, /SHOT_/, 'в журнал пишется факт снимка, не байты картинки');
  });

  test('снимок не сделан, если окна не прочитаны (ошибка или отсутствие ui_windows)', async (t) => {
    for (const provider of [() => { throw new Error('UIA сбой'); }, null]) {
      const { agent, readJournal, getLookCalls } = setupPrivacy(t, provider);
      const res = await agent.run('нажми');
      assert.equal(res.outcome, 'answer', 'ход не падает при сбое чтения окон');
      assert.equal(getLookCalls(), 1, 'privacy-default: без подтверждения переднего окна автоснимка нет');
      const auto = readJournal().find((r) => r.tool === 'screen_look' && r.args && r.args.auto);
      assert.equal(auto.decision, 'deny');
    }
  });
});

describe('F-3: режим «по просьбе» и связка в main.js', () => {
  test('screenTools: allowed=false блокирует снимок до вызова capture, allowed=true разрешает', async () => {
    let allow = false;
    let captures = 0;
    let savedPath = '';
    const [look] = screenTools({
      allowed: () => allow,
      capture: async (_script, env) => {
        captures += 1;
        savedPath = env.JARVIS_SHOT;
        fs.writeFileSync(savedPath, Buffer.from('jpeg-bytes'));
        return { ok: true, summary: 'ok' };
      },
    });
    const denied = await look.run({}, {});
    assert.equal(denied.ok, false);
    assert.match(denied.summary, /по просьбе/);
    assert.equal(captures, 0);

    allow = true;
    const allowed = await look.run({}, {});
    assert.equal(allowed.ok, true);
    assert.equal(captures, 1);
    assert.match(allowed.image, /^data:image\/jpeg;base64,/);
    assert.equal(fs.existsSync(savedPath), false, 'временный файл снимка удаляется сразу после чтения');
  });

  test('main.js: screenAllowed включается только на время screenJob и сбрасывается в finally', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const idx = mainSrc.indexOf('const screenJob = screenTask(phrase);');
    assert.ok(idx > 0, 'ветка screenJob найдена в main.js');
    const block = mainSrc.slice(idx, idx + 2000);
    assert.match(block, /screenAllowed\s*=\s*true;/);
    assert.match(block, /look:\s*screenTools\(\{\s*allowed:\s*\(\)\s*=>\s*screenAllowed\s*\}\)\[0\]/);
    assert.match(block, /\.finally\(\(\)\s*=>\s*\{[\s\S]*?screenAllowed\s*=\s*false;/);
  });
});

describe('F-3: privacy-тест на состав снимка', () => {
  test('buildScene: секреты в полях, url и буфере скрыты; screenshot хранит только размеры, не пиксели', () => {
    const secret = 'sk-live-supersecret1234567890';
    const pwd = 'password=mySecretPwd99';
    const scene = buildScene({
      window: { title: 'Браузер', process: 'msedge', handle: 10 },
      url: `https://example.com?token=${secret}`,
      clipboard: `ключ ${pwd}`,
      screenshot: { width: 1280, height: 720, bytes: 12345, data: 'BASE64_SHOULD_NOT_BE_IN_SCENE' },
      elements: [
        { name: 'Токен', type: 'Edit', value: `api_key=${secret}` },
        { name: 'Пароль', type: 'Edit', value: pwd },
      ],
    });
    const serialized = JSON.stringify(scene);
    assert.ok(!serialized.includes(secret), 'токен скрыт из сцены');
    assert.ok(!serialized.includes('mySecretPwd99'), 'пароль скрыт из сцены');
    assert.ok(!serialized.includes('BASE64_SHOULD_NOT_BE_IN_SCENE'), 'пиксели не попадают в сцену');
    assert.deepEqual(scene.screenshot, { width: 1280, height: 720, bytes: 12345 });
  });

  test('regionTools: вырезает только обведённую область, сбрасывается после показа и протухает по TTL', async () => {
    let cleared = 0;
    let nowMs = 1000;
    let current = {
      at: 1000,
      label: 'форма',
      pixels: { x: 10, y: 20, width: 300, height: 200 },
      shot: {
        crop(rect) {
          assert.deepEqual(rect, { x: 10, y: 20, width: 300, height: 200 });
          return {
            getSize: () => ({ width: 300, height: 200 }),
            toJPEG: () => Buffer.from('region-jpg'),
          };
        },
      },
    };
    const [regionTool] = regionTools({
      take: () => current,
      clear: () => { cleared += 1; current = null; },
      now: () => nowMs,
    });

    const ok = await regionTool.run({});
    assert.equal(ok.ok, true);
    assert.equal(cleared, 1, 'после показа область очищена из памяти');
    assert.equal(ok.data.width, 300);
    assert.equal(ok.data.height, 200);

    const second = await regionTool.run({});
    assert.equal(second.ok, false, 'повторное чтение без нового выделения невозможно');

    // Проверка TTL протухания области.
    current = { at: 1000, pixels: { x: 0, y: 0, width: 10, height: 10 }, shot: { crop() { throw new Error('не должно вызываться'); } } };
    nowMs = 1000 + REGION_TTL_MS + 1;
    const expired = await regionTool.run({});
    assert.equal(expired.ok, false);
    assert.match(expired.summary, /устарела/);
  });
});
