'use strict';

// План хода на диске: переживает перезапуск, шаг закрывается проверкой, а не словами модели.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TurnPlans, PlanStore, planResumeAnswer, isResumePhrase, observableResult, MAX_PLAN_ITEMS,
} = require('../src/agent/plan');
const { planTools } = require('../src/tools/plan');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');

const obj = { type: 'object', properties: {} };
const say = (content) => ({ content, toolCalls: [] });
const call = (id, name, args = {}) => ({ content: '', toolCalls: [{ id, name, args }] });

function scripted(steps) {
  const seen = [];
  const requests = [];
  return {
    seen,
    requests,
    chat: async ({ messages }) => {
      requests.push(messages);
      const last = messages[messages.length - 1];
      if (last && last.role === 'tool') seen.push(JSON.parse(last.content));
      return steps.shift() || say('всё');
    },
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-disk-'));
}

// Запись файла с проверкой эффекта — как у настоящего workspace_write: confirmed только по байтам на диске.
function writeTool(root) {
  return {
    name: 'workspace_write',
    risk: 'T1',
    description: 'записать файл',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async run(args = {}) {
      const abs = path.join(root, String(args.path || ''));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(args.content ?? ''), 'utf8');
      return { ok: true, summary: 'записал', data: { path: String(args.path || '') } };
    },
    async verify(args = {}, result = {}) {
      try {
        const onDisk = fs.readFileSync(path.join(root, result.data.path), 'utf8');
        return onDisk === String(args.content ?? '')
          ? { status: 'confirmed', evidence: 'файл совпадает с записью' }
          : { status: 'failed', evidence: 'файл отличается от записи' };
      } catch {
        return { status: 'failed', evidence: 'файла нет на диске' };
      }
    },
  };
}

function echoTool() {
  return { name: 'echo', risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'эхо' }) };
}

function makeAgent({ root, plans, brain, chatId = 'chat-1', workspaceId = 'space-1', tools = [], extra = {} }) {
  const registry = new ToolRegistry();
  for (const tool of planTools(plans)) registry.register(tool);
  for (const tool of [...tools]) registry.register(tool);
  return new Agent({
    brain, tools: registry, policy: () => 'allow', journal: { append: () => {} }, mode: 'full',
    workspace: root, plans, chatId, workspaceId, chatReplies: true, ...extra,
  });
}

const lastAssistant = (agent) => [...agent.history].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');

test('план переживает перезапуск: шаг 1 закрыт подтверждением, шаг 2 ждёт, «продолжай» поднимает план с диска', async () => {
  const root = tempRoot();
  const file = path.join(root, 'plans.json');
  const store1 = new PlanStore(file);
  const plans1 = new TurnPlans({ store: store1 });
  const brain1 = scripted([
    call('1', 'plan_set', { steps: ['создать файл plans-live.md с первой строкой', 'дописать вторую строку в plans-live.md'] }),
    call('2', 'workspace_write', { path: 'plans-live.md', content: 'первая строка' }),
    call('3', 'plan_done', { step: 1, evidence: 'файл plans-live.md записан' }),
    say('Шаг 1 готов: файл plans-live.md создан.'),
  ]);
  const agent1 = makeAgent({ root, plans: plans1, brain: brain1, tools: [writeTool(root)] });
  const result1 = await agent1.run('сделай два шага');
  assert.equal(result1.outcome, 'unsure'); // остался незакрытый шаг: «готово» не выдаём

  // Файл на диске и отметка шага — до перезапуска.
  assert.equal(fs.readFileSync(path.join(root, 'plans-live.md'), 'utf8'), 'первая строка');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.items.length, 1);
  const item = saved.items[0];
  assert.equal(item.chatId, 'chat-1');
  assert.equal(item.workspaceId, 'space-1');
  assert.equal(item.request, 'сделай два шага');
  assert.equal(item.steps[0].status, 'done');
  assert.equal(item.steps[1].status, 'pending');
  assert.match(item.steps[0].evidence, /plans-live\.md/);
  assert.ok(item.steps[0].files.some((p) => p.endsWith('plans-live.md')), JSON.stringify(item.steps[0].files));
  assert.ok(item.artifacts.some((p) => p.endsWith('plans-live.md')), JSON.stringify(item.artifacts));

  // «Перезапуск»: новые экземпляры хранилища и планов читают тот же файл.
  const store2 = new PlanStore(file);
  const plans2 = new TurnPlans({ store: store2 });
  const loaded = store2.get({ chatId: 'chat-1', workspaceId: 'space-1' });
  assert.equal(loaded.steps[0].status, 'done');
  assert.equal(loaded.steps[1].status, 'pending');
  assert.equal(loaded.request, 'сделай два шага');

  const brain2 = scripted([say('Сделано: шаг 1, файл plans-live.md. Следующий шаг — дописать вторую строку в plans-live.md.')]);
  const agent2 = makeAgent({ root, plans: plans2, brain: brain2, tools: [writeTool(root)] });
  const result2 = await agent2.run('продолжай');
  const request = JSON.stringify(brain2.requests[0]);
  assert.match(request, /Продолжаем прошлый план/);
  assert.match(request, /Сделано: 1\)/);
  assert.match(request, /plans-live\.md/);
  assert.match(request, /Следующий шаг: 2\)/);

  // В текущем ходе план поднят с теми же отметками: шаг 1 done, шаг 2 pending.
  const current = plans2.get(agent2._runId);
  assert.equal(current.steps[0].status, 'done');
  assert.equal(current.steps[1].status, 'pending');
  assert.equal(result2.outcome, 'unsure'); // шаг 2 ещё не закрыт: «готово» не выдаём
  const answer = lastAssistant(agent2).content;
  assert.match(answer, /plans-live\.md/);
  assert.match(answer, /следующ/i);
});

test('аудит: «создать файл» без действий и без файла не закрывается', async () => {
  const root = tempRoot();
  for (const evidence of ['файл существует', 'файл reports/report.md существует']) {
    const plans = new TurnPlans();
    const brain = scripted([
      call('1', 'plan_set', { steps: ['создать файл отчёта', 'проверить отчёт'] }),
      call('2', 'plan_done', { step: 1, evidence }),
      say('Отчёт готов.'),
    ]);
    const agent = makeAgent({ root, plans, brain });
    await agent.run('сделай отчёт');
    const plan = plans.get(agent._runId);
    assert.equal(plan.steps[0].status, 'pending', evidence);
    const refusal = brain.seen.find((item) => item && typeof item.summary === 'string' && item.summary.includes('подразумевает'));
    assert.ok(refusal, `нет отказа на «${evidence}»: ${JSON.stringify(brain.seen)}`);
    assert.match(refusal.summary, /файл/);
  }
});

test('положительно: подтверждённая запись файла и настоящий путь закрывают шаг', async () => {
  const root = tempRoot();
  const plans = new TurnPlans();
  const brain = scripted([
    call('1', 'plan_set', { steps: ['создать файл result.md', 'проверить отчёт'] }),
    call('2', 'workspace_write', { path: 'result.md', content: 'данные' }),
    call('3', 'plan_done', { step: 1, evidence: 'файл result.md записан' }),
    say('Файл на месте.'),
  ]);
  const agent = makeAgent({ root, plans, brain, tools: [writeTool(root)] });
  await agent.run('сделай файл');
  const plan = plans.get(agent._runId);
  assert.equal(plan.steps[0].status, 'done');
  assert.ok(plan.steps[0].files.some((p) => p.endsWith('result.md')));
});

test('подтверждённое действие этого хода закрывает шаг без файла, а просто слова — нет', async () => {
  const root = tempRoot();
  const plans = new TurnPlans();
  plans.start('r1', { chatId: '', workspaceId: '', root });
  plans.set('r1', ['записать результат в память']);
  assert.throws(() => plans.done('r1', 1, 'записал', { root }), /подразумевает|подтверждён/);
  assert.equal(plans.get('r1').steps[0].status, 'pending');
  plans.observe('r1', { name: 'remember', verified: 'confirmed', summary: 'запомнил' });
  const plan = plans.done('r1', 1, 'записал и подтвердил', { root });
  assert.equal(plan.steps[0].status, 'done');
});

test('шаг без наблюдаемого результата закрывается текстом, как раньше', () => {
  const plans = new TurnPlans();
  plans.set('r1', ['обдумать подход', 'решить, что дальше']);
  const plan = plans.done('r1', 1, 'подумал, план есть');
  assert.equal(plan.steps[0].status, 'done');
  assert.equal(observableResult('обдумать подход').needed, false);
  assert.equal(observableResult('решить, что дальше').needed, false);
  assert.equal(observableResult('создать файл').needed, true);
  assert.equal(observableResult('найти файл').needed, false);
});

test('пустой файл доказательством не считается, а существующий непустой — считается', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'empty.txt'), '', 'utf8');
  fs.writeFileSync(path.join(root, 'full.txt'), 'данные', 'utf8');
  const plans = new TurnPlans();
  plans.start('r1', { chatId: '', workspaceId: '', root });
  plans.set('r1', ['создать файл empty.txt']);
  assert.throws(() => plans.done('r1', 1, 'файл empty.txt', { root }), /существующего непустого файла/);
  plans.set('r2', ['создать файл full.txt']);
  const plan = plans.done('r2', 1, 'файл full.txt', { root });
  assert.equal(plan.steps[0].status, 'done');
  assert.ok(plan.steps[0].files.some((p) => p.endsWith('full.txt')));
});

test('PlansStore: ключ — чат и пространство, старые планы убираются, план закрытого дела снимается', () => {
  const root = tempRoot();
  const file = path.join(root, 'plans.json');
  let now = 1_700_000_000_000;
  const store = new PlanStore(file, { now: () => new Date(now), maxItems: 2, maxAgeMs: 60_000 });
  const step = (text) => [{ id: 's1', text, status: 'pending', evidence: null, doneAt: null }];
  store.put({ chatId: 'a', workspaceId: 'w', request: 'план a', steps: step('раз') });
  assert.equal(store.get({ chatId: 'a', workspaceId: 'w' }).request, 'план a');
  assert.equal(store.get({ chatId: 'a', workspaceId: 'other' }), null);
  assert.equal(store.get({ chatId: 'b', workspaceId: 'w' }), null);
  now += 10;
  store.put({ chatId: 'b', workspaceId: 'w', request: 'план b', steps: step('два') });
  now += 10;
  store.put({ chatId: 'c', workspaceId: 'w', request: 'план c', steps: step('три') });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(data.items.length <= 2, String(data.items.length));
  assert.equal(store.get({ chatId: 'a', workspaceId: 'w' }), null);
  assert.ok(store.get({ chatId: 'c', workspaceId: 'w' }));
  // Старый план по возрасту убирается при следующей записи.
  now += 120_000;
  store.put({ chatId: 'd', workspaceId: 'w', request: 'план d', steps: step('четыре') });
  assert.equal(store.get({ chatId: 'b', workspaceId: 'w' }), null);
  assert.ok(store.get({ chatId: 'd', workspaceId: 'w' }));
  // Запись атомарная: временного файла рядом не остаётся.
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(MAX_PLAN_ITEMS >= 2, true);
});

test('TurnPlans: закрытый план убирается с диска, смена чата не поднимает чужой план', async () => {
  const root = tempRoot();
  const file = path.join(root, 'plans.json');
  const store = new PlanStore(file);
  const plans = new TurnPlans({ store });
  const brain = scripted([
    call('1', 'plan_set', { steps: ['обдумать первый шаг', 'обдумать второй шаг'] }),
    call('2', 'plan_done', { step: 1, evidence: 'подумал' }),
    call('3', 'plan_done', { step: 2, evidence: 'подумал' }),
    say('Оба шага обдуманы.'),
  ]);
  const agent = makeAgent({ root, plans, brain });
  await agent.run('подумай');
  assert.equal(plans.get(agent._runId).steps.every((s) => s.status === 'done'), true);
  assert.equal(store.get({ chatId: 'chat-1', workspaceId: 'space-1' }), null);

  // Новый план на другом чате не поднимается в этом.
  const brain2 = scripted([call('1', 'plan_set', { steps: ['создать файл чужого чата.md'] }), say('Начал.')]);
  const agent2 = makeAgent({ root, plans, brain: brain2, chatId: 'chat-2', workspaceId: 'space-1' });
  await agent2.run('начни');
  assert.ok(store.get({ chatId: 'chat-2', workspaceId: 'space-1' }));
  const brain3 = scripted([say('Продолжать нечего.')]);
  const agent3 = makeAgent({ root, plans, brain: brain3, chatId: 'chat-1', workspaceId: 'space-1' });
  await agent3.run('продолжай');
  assert.doesNotMatch(JSON.stringify(brain3.requests[0]), /Продолжаем прошлый план/);
});

test('planResumeAnswer дописывает только недостающее; isResumePhrase понимает просьбы вернуться', () => {
  const plan = {
    steps: [
      { id: 's1', text: 'создать файл п.md', status: 'done', files: ['п.md'], evidence: 'записан' },
      { id: 's2', text: 'дописать вывод', status: 'pending', files: [] },
    ],
    artifacts: ['п.md'],
  };
  const full = planResumeAnswer(plan, '');
  assert.match(full, /сделано/);
  assert.match(full, /файл: п\.md/);
  assert.match(full, /следующий шаг — 2\)/);
  assert.equal(planResumeAnswer(plan, 'Создать файл п.md — сделано, файл п.md. Дописать вывод — следующий шаг.'), '');
  assert.equal(isResumePhrase('продолжай'), true);
  assert.equal(isResumePhrase('Продолжим с того места'), true);
  assert.equal(isResumePhrase('Где остановились?'), true);
  assert.equal(isResumePhrase('Вернёмся к плану'), true);
  assert.equal(isResumePhrase('продолжительная работа'), false);
  assert.equal(isResumePhrase('сделай отчёт'), false);
});

test('сбой файла планов не рвёт чат: ход идёт, план работает в памяти', async () => {
  const root = tempRoot();
  const file = path.join(root, 'plans.json');
  fs.writeFileSync(file, '{ это не json', 'utf8');
  const store = new PlanStore(file);
  assert.throws(() => store.get({ chatId: 'chat-1', workspaceId: 'space-1' }), /повреждён/);
  const plans = new TurnPlans({ store });
  const brain = scripted([
    call('1', 'plan_set', { steps: ['обдумать шаг'] }),
    call('2', 'plan_done', { step: 1, evidence: 'подумал' }),
    say('Готово.'),
  ]);
  const agent = makeAgent({ root, plans, brain });
  const result = await agent.run('подумай');
  assert.equal(result.outcome, 'answer');
  assert.match(plans.lastError, /повреждён/);
});

test('незакрытый план сохраняется и при лимите шагов (конец хода, а не ответ)', async () => {
  const root = tempRoot();
  const file = path.join(root, 'plans.json');
  const store = new PlanStore(file);
  const plans = new TurnPlans({ store });
  const brain = scripted([
    call('1', 'plan_set', { steps: ['собрать данные', 'написать отчёт'] }),
    call('2', 'echo'),
  ]);
  const agent = makeAgent({ root, plans, brain, tools: [echoTool()], extra: { maxSteps: 1 } });
  await agent.run('подготовь отчёт');
  const saved = store.get({ chatId: 'chat-1', workspaceId: 'space-1' });
  assert.ok(saved, 'план сохранён на диск');
  assert.equal(saved.steps[0].status, 'pending');
  assert.equal(saved.request, 'подготовь отчёт');
});

test('план отдан в фон: запись с диска убирается', async () => {
  const root = tempRoot();
  const file = path.join(root, 'plans.json');
  const store = new PlanStore(file);
  const plans = new TurnPlans({ store });
  const brain = scripted([call('1', 'plan_set', { steps: ['обдумать шаг'] }), say('Начал.')]);
  const agent = makeAgent({ root, plans, brain });
  await agent.run('подумай');
  assert.ok(store.get({ chatId: 'chat-1', workspaceId: 'space-1' }));
  agent.dropSavedPlan();
  assert.equal(store.get({ chatId: 'chat-1', workspaceId: 'space-1' }), null);
});
test('план пространства: ключ — чат пространства, после перезапуска «продолжай» поднимает план', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-plan-space-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { WorkspaceBook } = require('../src/workspaces/book');
  const { WorkspaceChat } = require('../src/workspaces/chat');
  const opts = { defaultRoot: path.join(dir, 'workspace'), spacesRoot: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data') };
  fs.mkdirSync(opts.defaultRoot);
  fs.mkdirSync(opts.dataDir);
  const file = path.join(opts.dataDir, 'plans.json');
  const makePlans = () => new TurnPlans({ store: new PlanStore(file) });
  const say = (text) => ({ content: text, toolCalls: [] });
  const tool = (id, name, args) => ({ content: '', toolCalls: [{ id, name, args }] });
  const brain = () => {
    const queue = [
      tool('1', 'plan_set', { steps: ['создать файл отчёт-пространства.md', 'проверить отчёт'] }),
      tool('2', 'workspace_write', { path: 'отчёт-пространства.md', content: 'данные' }),
      tool('3', 'plan_done', { step: 1, evidence: 'файл отчёт-пространства.md записан' }),
      say('Файл готов.'),
    ];
    const requests = [];
    return {
      requests,
      async chat({ messages }) {
        requests.push(messages);
        return queue.shift() || say('всё');
      },
    };
  };
  const book = new WorkspaceBook(opts);
  const space = book.create('QA');
  const plans = makePlans();
  const brainA = brain();
  const chatA = new WorkspaceChat({
    book, brain: brainA, mode: 'full', plans, commonTools: planTools(plans),
    policy: require('../src/policy/modes'), journal: { append() {} }, memoryAuto: () => false,
  });
  chatA.select(space.id);
  const chatId = chatA.chatList().activeId;
  await chatA.run('сделай файл в пространстве', { ownerText: 'сделай файл в пространстве' });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].chatId, chatId);
  assert.equal(saved.items[0].workspaceId, space.id);
  assert.equal(saved.items[0].steps[0].status, 'done');
  assert.equal(saved.items[0].steps[1].status, 'pending');

  // Перезапуск: тот же файл разговоров пространства и новый хранитель планов.
  const plansB = makePlans();
  const brainB = brain();
  const chatB = new WorkspaceChat({
    book: new WorkspaceBook(opts), brain: brainB, mode: 'full', plans: plansB, commonTools: planTools(plansB),
    policy: require('../src/policy/modes'), journal: { append() {} }, memoryAuto: () => false,
  });
  chatB.select(space.id);
  await chatB.run('продолжай', { ownerText: 'продолжай' });
  assert.match(JSON.stringify(brainB.requests[0]), /Продолжаем прошлый план/);
  assert.match(JSON.stringify(brainB.requests[0]), /отчёт-пространства\.md/);
});
