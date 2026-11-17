'use strict';

// P0-4 (D-2, E-1..E-4, C-1, C-2): отмена, таймаут, потолки, зависание, перезапуск и повтор.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScreenAgent, NO_ANSWER_TEXT, STOPPED_TEXT, SCREEN_TURN_DEADLINE_MS } = require('../src/screen/agent');
const { Agent, repairToolHistory } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');
const modes = require('../src/policy/modes');
const { uiTools } = require('../src/tools/ui');
const { observeTools } = require('../src/tools/observe');

function makeTempDir(t, prefix = 'jarvis-p04-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const call = (name, args = {}, id) => ({ id: id || `c${Math.random()}`, name, args });
function brainOf(step) {
  const brain = { calls: 0, async chat() { brain.calls += 1; return step(brain.calls); } };
  return brain;
}

function fakeScreenTools({ slowMs = 0, ignoreAbort = false } = {}) {
  const runs = [];
  const reg = new ToolRegistry();
  const action = (name) => ({
    name, risk: 'T1', description: name, parameters: { type: 'object', properties: {} },
    async run(args, ctx) {
      if (slowMs > 0) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, slowMs);
          if (!ignoreAbort && ctx && ctx.signal) {
            ctx.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          }
        });
        if (!ignoreAbort && ctx && ctx.signal && ctx.signal.aborted) {
          return { ok: false, summary: 'остановлено', verified: 'unknown', evidence: 'остановлено во время действия' };
        }
      }
      runs.push({ name, args });
      return { ok: true, summary: `${name} выполнено` };
    },
    async verify() { return { status: 'confirmed', evidence: 'подмена' }; },
  });
  for (const n of ['ui_click', 'ui_type', 'ui_keys']) reg.register(action(n));
  reg.register({
    name: 'ui_windows', risk: 'T0', description: '',
    async run() { return { ok: true, summary: 'окна', data: { windows: [{ title: 'Блокнот', process: 'notepad', handle: 1, active: true }] } }; },
  });
  reg.register({
    name: 'ui_elements', risk: 'T0', description: '',
    async run() { return { ok: true, summary: 'элементы', data: { elements: [] } }; },
  });
  const look = {
    name: 'screen_look', risk: 'T1', description: '',
    async run() { runs.push({ name: 'screen_look' }); return { ok: true, summary: 'снимок', image: 'data:image/jpeg;base64,AA==' }; },
  };
  return { reg, look, runs };
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function waitFor(check, tries = 1000) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

describe('D-2: три исхода подтверждения — автоотмена, стоп, отказ', () => {
  test('автоотмена подтверждения: NO_ANSWER_TEXT, _denied=false, _timedOut=true, журнал timeout', async (t) => {
    const dir = makeTempDir(t);
    const { reg, look, runs } = fakeScreenTools();
    const events = [];
    const journalPath = path.join(dir, 'journal.jsonl');
    const approvals = new ApprovalBroker({ autoCancelMs: 15 });
    const brain = brainOf((n) => (n === 1
      ? { toolCalls: [call('screen_look')] }
      : { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, 'send-timeout')] }));
    const agent = new ScreenAgent({
      brain, tools: reg, look, policy: modes, approvals,
      journal: new Journal(journalPath), emit: (e) => events.push(e), mode: 'full', workspace: dir,
    });

    const res = await agent.run('отправь сообщение');
    assert.equal(res.outcome, 'needs_human');
    assert.equal(agent._denied, false, 'автоотмена — не отказ владельца');
    assert.equal(agent._timedOut, true);
    assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0);
    assert.ok(events.some((e) => e.type === 'text' && e.delta === NO_ANSWER_TEXT));
    assert.ok(!events.some((e) => e.type === 'text' && /не подтвердили/.test(e.delta)));
    const entry = readJsonl(journalPath).find((r) => r.tool === 'ui_click');
    assert.equal(entry.decision, 'timeout');
  });

  test('стоп во время ожидания: _denied=false, _stoppedBefore=true, журнал stop, без текста отказа', async (t) => {
    const dir = makeTempDir(t);
    const { reg, look, runs } = fakeScreenTools();
    const events = [];
    const journalPath = path.join(dir, 'journal.jsonl');
    const approvals = new ApprovalBroker({ autoCancelMs: null });
    const brain = brainOf((n) => (n === 1
      ? { toolCalls: [call('screen_look')] }
      : { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, 'send-stop')] }));
    const agent = new ScreenAgent({
      brain, tools: reg, look, policy: modes, approvals,
      journal: new Journal(journalPath), emit: (e) => events.push(e), mode: 'full', workspace: dir,
    });

    const turn = agent.run('отправь сообщение');
    assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'send-stop')));
    agent.stop();
    const res = await turn;
    assert.equal(res.outcome, 'stopped');
    assert.equal(agent._denied, false);
    assert.equal(agent._stoppedBefore, true);
    assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0);
    assert.ok(!events.some((e) => e.type === 'text' && /не подтвердили/.test(e.delta)));
    const entry = readJsonl(journalPath).find((r) => r.tool === 'ui_click');
    assert.equal(entry.decision, 'stop');
  });

  test('отмена ожидания с причиной «остановлено» без abort даёт STOPPED_TEXT', async (t) => {
    const dir = makeTempDir(t);
    const { reg, look } = fakeScreenTools();
    const events = [];
    const approvals = new ApprovalBroker({ autoCancelMs: null });
    const brain = brainOf((n) => (n === 1
      ? { toolCalls: [call('screen_look')] }
      : { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, 'send-cancel')] }));
    const agent = new ScreenAgent({
      brain, tools: reg, look, policy: modes, approvals,
      journal: new Journal(path.join(dir, 'journal.jsonl')), emit: (e) => events.push(e), mode: 'full', workspace: dir,
    });
    const turn = agent.run('отправь');
    assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'send-cancel')));
    const req = events.find((e) => e.type === 'approval_request' && e.callId === 'send-cancel');
    approvals.cancel(req.id, 'остановлено');
    const res = await turn;
    assert.equal(res.outcome, 'needs_human');
    assert.equal(agent._denied, false);
    assert.equal(agent._stoppedBefore, true);
    assert.ok(events.some((e) => e.type === 'text' && e.delta === STOPPED_TEXT));
  });

  test('явный отказ: _denied=true, needs_human, прежний текст отказа', async (t) => {
    const dir = makeTempDir(t);
    const { reg, look, runs } = fakeScreenTools();
    const events = [];
    const journalPath = path.join(dir, 'journal.jsonl');
    const approvals = new ApprovalBroker({ autoCancelMs: null });
    const brain = brainOf((n) => (n === 1
      ? { toolCalls: [call('screen_look')] }
      : { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, 'send-reject')] }));
    const agent = new ScreenAgent({
      brain, tools: reg, look, policy: modes, approvals,
      journal: new Journal(journalPath), emit: (e) => events.push(e), mode: 'full', workspace: dir,
    });
    const turn = agent.run('отправь');
    assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'send-reject')));
    approvals.respond(events.find((e) => e.callId === 'send-reject').id, 'reject');
    const res = await turn;
    assert.equal(res.outcome, 'needs_human');
    assert.equal(agent._denied, true);
    assert.equal(agent._timedOut, false);
    assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0);
    assert.ok(events.some((e) => e.type === 'text' && /не подтвердили/.test(e.delta)));
    assert.equal(readJsonl(journalPath).find((r) => r.tool === 'ui_click').decision, 'reject');
  });
});

describe('E-1 и E-2: потолок хода и остановка в полёте', () => {
  test('потолок хода у ScreenAgent по умолчанию 8 минут (480000 мс) и срабатывает по таймеру', async (t) => {
    const dir = makeTempDir(t);
    const { reg, look } = fakeScreenTools();
    const baseAgent = new ScreenAgent({
      brain: brainOf(() => ({ content: 'ok' })), tools: reg, look, policy: modes,
      approvals: new ApprovalBroker(), journal: new Journal(path.join(dir, 'j1.jsonl')), mode: 'full', workspace: dir,
    });
    assert.equal(SCREEN_TURN_DEADLINE_MS, 480000);
    assert.equal(baseAgent.turnDeadlineMs, 480000);

    const events = [];
    const slowBrain = {
      calls: 0,
      async chat() {
        slowBrain.calls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return { toolCalls: [call(slowBrain.calls === 1 ? 'screen_look' : 'ui_keys', { keys: 'a' })] };
      },
    };
    const fastDeadline = new ScreenAgent({
      brain: slowBrain, tools: reg, look, policy: modes,
      approvals: new ApprovalBroker(), journal: new Journal(path.join(dir, 'j2.jsonl')),
      emit: (e) => events.push(e), mode: 'full', workspace: dir, turnDeadlineMs: 10,
    });
    const res = await fastDeadline.run('жми');
    assert.equal(res.outcome, 'timeout');
    assert.ok(events.some((e) => e.type === 'text' && /Ход занял больше/.test(e.delta)));
  });

  test('E-2: uiTools при остановке во время действия возвращает verified=unknown, а не failed', async () => {
    const ac = new AbortController();
    const runner = async (_script, _env, opts) => {
      ac.abort();
      assert.equal(opts.signal.aborted, true);
      return { ok: false, summary: 'остановлено', data: {} };
    };
    const tools = uiTools({ runner, selfPid: 99999 });
    const click = tools.find((t) => t.name === 'ui_click');
    const res = await click.run({ window: 'Блокнот', name: 'Отправить' }, { signal: ac.signal });
    assert.equal(res.ok, false);
    assert.equal(res.verified, 'unknown');
    assert.match(res.evidence, /успело ли оно — неизвестно/);
  });

  test('E-2: Esc/stop посреди действия даёт unverified в журнале и verification.unverified >= 1', async (t) => {
    const dir = makeTempDir(t);
    const events = [];
    const journalPath = path.join(dir, 'journal.jsonl');
    const stop = new StopSwitch();
    let sideEffect = 0;
    const reg = new ToolRegistry();
    reg.register({
      name: 'slow_click', risk: 'T1', description: '', parameters: { type: 'object', properties: {} },
      async run(_args, ctx) {
        sideEffect += 1;
        await new Promise((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
        return { ok: false, summary: 'остановлено', verified: 'unknown', evidence: 'успело ли оно — неизвестно' };
      },
    });
    const agent = new Agent({
      brain: brainOf(() => ({ toolCalls: [call('slow_click', {}, 'sc1')] })),
      tools: reg, policy: () => 'allow', approvals: new ApprovalBroker(),
      journal: new Journal(journalPath), emit: (e) => events.push(e), mode: 'full', workspace: dir, stop,
    });
    const turn = agent.run('нажми');
    assert.ok(await waitFor(() => sideEffect === 1));
    stop.trigger('Esc');
    const res = await turn;
    assert.equal(res.outcome, 'stopped');
    const stepEv = events.find((e) => e.type === 'tool_result' && e.id === 'sc1');
    assert.equal(stepEv.afterStop, true);
    assert.equal(stepEv.status, 'unverified', 'остановленное в полёте действие не считается failed');
    assert.equal(stepEv.verifiedStatus, 'unverified');
    const entry = readJsonl(journalPath).find((r) => r.tool === 'slow_click');
    assert.equal(entry.status, 'unverified');
    assert.equal(entry.verifiedStatus, 'unverified');
  });
});

describe('E-3, E-4, C-1, C-2: зависшие руки, перезапуск, устаревшая сцена, повтор', () => {
  test('E-3: зависшее действие держит руки до позднего завершения', async (t) => {
    const dir = makeTempDir(t);
    const events = [];
    let releaseHung = null;
    const reg = new ToolRegistry();
    reg.register({
      name: 'ui_click', risk: 'T1', description: '', parameters: { type: 'object', properties: {} },
      async run() {
        await new Promise((resolve) => { releaseHung = resolve; });
        return { ok: true, summary: 'поздно нажал' };
      },
      async verify() { return { status: 'confirmed', evidence: 'ok' }; },
    });
    const journal = new Journal(path.join(dir, 'journal.jsonl'));
    const a1 = new Agent({
      brain: brainOf(() => ({ toolCalls: [call('ui_click', { window: 'Окно', name: 'А' }, 'hung-1')] })),
      tools: reg, policy: () => 'allow', approvals: new ApprovalBroker(),
      journal, emit: (e) => events.push(e), mode: 'full', workspace: dir, stopGraceMs: 15,
    });
    const t1 = a1.run('нажми А');
    assert.ok(await waitFor(() => typeof releaseHung === 'function'));
    a1.stop();
    const r1 = await t1;
    assert.equal(r1.outcome, 'stopped');

    // Пока зависший вызов не завершился, новый агент не может запускать руки.
    const events2 = [];
    const a2 = new Agent({
      brain: brainOf((n) => (n === 1 ? { toolCalls: [call('ui_click', { window: 'Окно', name: 'Б' }, 'blocked-2')] } : { content: 'Жду.' })),
      tools: reg, policy: () => 'allow', approvals: new ApprovalBroker(),
      journal, emit: (e) => events2.push(e), mode: 'full', workspace: dir,
    });
    await a2.run('нажми Б');
    const blockedRes = events2.find((e) => e.type === 'tool_result' && e.id === 'blocked-2');
    assert.equal(blockedRes.ok, false);
    assert.match(blockedRes.summary, /предыдущее действие на рабочем столе не ответило/);

    // После позднего завершения замок снимается; после чтения состояния (C-2) новый вызов проходит.
    releaseHung();
    assert.ok(await waitFor(() => events.some((e) => e.type === 'tool_result' && e.late === true && e.afterStop === true)));
    const events3 = [];
    const reg3 = new ToolRegistry();
    reg3.register({
      name: 'ui_elements', risk: 'T0', description: '', parameters: { type: 'object', properties: {} },
      async run() { return { ok: true, summary: 'элементы' }; },
    });
    reg3.register({
      name: 'ui_click', risk: 'T1', description: '', parameters: { type: 'object', properties: {} },
      async run() { return { ok: true, summary: 'нажато' }; },
      async verify() { return { status: 'confirmed', evidence: 'ok' }; },
    });
    const a3 = new Agent({
      brain: brainOf((n) => (n === 1
        ? { toolCalls: [call('ui_elements', { window: 'Окно' }, 'read-3')] }
        : n === 2 ? { toolCalls: [call('ui_click', { window: 'Окно', name: 'В' }, 'ok-3')] } : { content: 'Готово.' })),
      tools: reg3, policy: () => 'allow', approvals: new ApprovalBroker(),
      journal, emit: (e) => events3.push(e), mode: 'full', workspace: dir,
    });
    await a3.run('нажми В');
    assert.equal(events3.find((e) => e.type === 'tool_result' && e.id === 'ok-3').ok, true);
  });

  test('C-2: повтор после перезапуска — журнал блокирует внешнее действие до чтения состояния', async (t) => {
    const dir = makeTempDir(t);
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new Journal(journalPath);
    journal.append({
      tool: 'desktop_click', args: { id: 'e12ab34cdef01' }, risk: 'T1', mode: 'full',
      decision: 'allow', ok: true, status: 'unverified', verifiedStatus: 'unverified', summary: 'клик без проверки',
    });

    let clicks = 0;
    const reg = new ToolRegistry();
    reg.register({
      name: 'ui_click', risk: 'T1', description: '', parameters: { type: 'object', properties: {} },
      async run() { clicks += 1; return { ok: true, summary: 'нажал' }; },
      async verify() { return { status: 'confirmed', evidence: 'ok' }; },
    });
    reg.register({
      name: 'ui_elements', risk: 'T0', description: '', parameters: { type: 'object', properties: {} },
      async run() { return { ok: true, summary: 'элементы' }; },
    });

    // Первый ход: сразу рука → отказ по журналу; затем чтение ui_elements; затем рука проходит.
    const events = [];
    const agent = new Agent({
      brain: brainOf((n) => (n === 1
        ? { toolCalls: [call('ui_click', { window: 'Окно', name: 'Отправить' }, 'try-1')] }
        : n === 2
          ? { toolCalls: [call('ui_elements', { window: 'Окно' }, 'read-1')] }
          : n === 3
            ? { toolCalls: [call('ui_click', { window: 'Окно', name: 'Отправить' }, 'try-2')] }
            : { content: 'Готово.' })),
      tools: reg, policy: () => 'allow', approvals: new ApprovalBroker(),
      journal, emit: (e) => events.push(e), mode: 'full', workspace: dir,
    });
    await agent.run('продолжай');
    const first = events.find((e) => e.type === 'tool_result' && e.id === 'try-1');
    const second = events.find((e) => e.type === 'tool_result' && e.id === 'try-2');
    assert.equal(first.ok, false);
    assert.match(first.summary, /в прошлом ходу действие на экране осталось без подтверждения/);
    assert.equal(second.ok, true);
    assert.equal(clicks, 1);
  });

  test('E-4: desktop_type без id на устаревшей сцене (> 2 с) отказывает, на свежей — вводит', async () => {
    const origNow = Date.now;
    let clock = origNow();
    Date.now = () => clock;
    try {
      const typed = [];
      const windows = { name: 'ui_windows', async run() { return { ok: true, summary: 'окна', data: { windows: [{ title: 'Блокнот', process: 'notepad', handle: 1, active: true }] } }; } };
      const elements = { name: 'ui_elements', async run() { return { ok: true, summary: 'эл', data: { elements: [{ name: 'Поле', type: 'Edit', value: '' }] } }; } };
      const uiType = { name: 'ui_type', async run(args) { typed.push(args.text); return { ok: true, summary: 'введено' }; } };
      const tools = observeTools([windows, elements, uiType]);
      const observe = tools.find((t) => t.name === 'desktop_observe');
      const dType = tools.find((t) => t.name === 'desktop_type');

      await observe.run({ window: 'Блокнот' });
      clock += 2500;
      const stale = await dType.run({ text: 'привет' });
      assert.equal(stale.ok, false);
      assert.match(stale.summary, /устарел/);
      assert.equal(typed.length, 0);

      await observe.run({ window: 'Блокнот' });
      clock = origNow() + 500;
      const fresh = await dType.run({ text: 'привет' });
      assert.equal(fresh.ok, true);
      assert.deepEqual(typed, ['привет']);
    } finally {
      Date.now = origNow;
    }
  });

  test('C-1: повтор с новым id того же элемента не обходит лимит MAX_REPEATS (intentKey)', async (t) => {
    const dir = makeTempDir(t);
    const id1 = 'e111111111111';
    const id2 = 'e222222222222';
    const id3 = 'e333333333333';
    let currentScene = {
      window: { title: 'Блокнот', handle: 1, process: 'notepad' },
      elements: [{ id: id1, role: 'Button', name: 'Сохранить', automationId: 'btnSave', bounds: { x: 10, y: 20, w: 80, h: 30 } }],
    };
    modes.setSceneSource(() => currentScene);
    t.after(() => modes.setSceneSource(null));

    let clicks = 0;
    const reg = new ToolRegistry();
    reg.register({
      name: 'desktop_click', risk: 'T1', description: '', parameters: { type: 'object', properties: { id: { type: 'string' } } },
      async run() { clicks += 1; return { ok: true, summary: 'нажато' }; },
      async verify() { return { status: 'confirmed', evidence: 'ok' }; },
    });
    const events = [];
    const agent = new Agent({
      brain: brainOf((n) => {
        if (n === 1) return { toolCalls: [call('desktop_click', { id: id1 }, 'k1')] };
        if (n === 2) {
          currentScene = { ...currentScene, elements: [{ ...currentScene.elements[0], id: id2 }] };
          return { toolCalls: [call('desktop_click', { id: id2 }, 'k2')] };
        }
        if (n === 3) {
          currentScene = { ...currentScene, elements: [{ ...currentScene.elements[0], id: id3 }] };
          return { toolCalls: [call('desktop_click', { id: id3 }, 'k3')] };
        }
        return { content: 'Не вышло.' };
      }),
      tools: reg, policy: () => 'allow', approvals: new ApprovalBroker(),
      journal: new Journal(path.join(dir, 'journal.jsonl')), emit: (e) => events.push(e), mode: 'full', workspace: dir,
    });

    await agent.run('нажми сохранить');
    assert.equal(clicks, 2, 'третий вызов с новым id того же элемента не выполняется');
    const r3 = events.find((e) => e.type === 'tool_result' && e.id === 'k3');
    assert.equal(r3.ok, false);
    assert.match(r3.summary, /повтор/);
  });

  test('E-4: repairToolHistory помечает прерванный вызов как verified=unknown', () => {
    const history = [
      { role: 'user', content: 'отправь' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'lost-1', type: 'function', function: { name: 'desktop_click', arguments: '{}' } }] },
    ];
    const repaired = repairToolHistory(history);
    assert.equal(repaired.length, 3);
    assert.equal(repaired[2].role, 'tool');
    assert.equal(repaired[2].tool_call_id, 'lost-1');
    const payload = JSON.parse(repaired[2].content);
    assert.equal(payload.ok, false);
    assert.equal(payload.verified, 'unknown');
    assert.match(payload.summary, /неизвестно/);
  });
});
