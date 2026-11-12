'use strict';

// План хода: шаги модели, закрытие с доказательством, честные остановки.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TurnPlans, planNote, planBrief, STOP_WORDS } = require('../src/agent/plan');
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
      if (last.role === 'tool') seen.push(JSON.parse(last.content));
      return steps.shift() || say('всё');
    },
  };
}

function agentWith(tools, brain, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
  return new Agent({ brain, tools, policy: () => 'allow', journal: { append: () => {} }, mode: 'full', workspace: dir, plans: extra.plans || new TurnPlans(), ...extra });
}
test('TurnPlans: шаг закрывается только с доказательством, чужой ход не видит план', () => {
  const plans = new TurnPlans();
  const plan = plans.set('run-1', ['найти файл', 'переименовать']);
  assert.equal(plan.steps.length, 2);
  assert.throws(() => plans.done('run-1', 1, ''), /доказательство/);
  assert.throws(() => plans.done('run-1', 3, 'сделано'), /шага 3 нет/);
  assert.throws(() => plans.done('run-2', 1, 'сделано'), /план не задан/);
  const done = plans.done('run-1', 1, 'файл найден: reports/a.md');
  assert.equal(done.steps[0].status, 'done');
  assert.match(done.steps[0].evidence, /reports/);
  assert.equal(plans.summary(done).unfinished, 1);
  assert.match(planNote(plans.summary(done)), /Не закрыто: шаг 2/);
});

test('TurnPlans: seed для «продолжай» сохраняет закрытые шаги', () => {
  const plans = new TurnPlans();
  plans.set('run-1', ['раз', 'два']);
  plans.done('run-1', 1, 'сделано');
  const seeded = plans.seed('run-2', plans.get('run-1'));
  assert.equal(seeded.steps[0].status, 'done');
  assert.equal(seeded.steps[1].status, 'pending');
  assert.match(planBrief(seeded), /План прошлого хода/);
});

test('инструменты плана работают только внутри хода', async () => {
  const [set, done, stop] = planTools(new TurnPlans());
  assert.equal((await set.run({ steps: ['шаг'] }, {})).ok, false);
  const ctx = { runId: 'r1' };
  assert.equal((await set.run({ steps: ['шаг'] }, ctx)).ok, true);
  assert.equal((await done.run({ step: 1, evidence: 'готово' }, ctx)).ok, true);
  const refused = await stop.run({ kind: 'невозможно', reason: 'так нельзя' }, ctx);
  assert.equal(refused.ok, false);
  const impossible = await stop.run({ kind: 'impossible', reason: 'нет программы' }, ctx);
  assert.deepEqual(impossible.data.turnStop, { kind: 'impossible', reason: 'нет программы' });
  assert.equal(STOP_WORDS.unsure, 'Не уверен в результате');
});

test('ответ с незакрытым планом: код дописывает «Не закрыто» и итог — не уверен', async () => {
  const plans = new TurnPlans();
  const tools = new ToolRegistry();
  for (const tool of planTools(plans)) tools.register(tool);
  let echo = 0;
  tools.register({ name: 'echo', risk: 'T0', description: 'x', parameters: obj, run: async () => { echo += 1; return { ok: true, summary: `эхо ${echo}` }; } });
  const brain = scripted([
    call('1', 'plan_set', { steps: ['прочитать файл', 'переписать файл'] }),
    call('2', 'echo'),
    call('3', 'plan_done', { step: 1, evidence: 'файл прочитан' }),
    say('Файл прочитал.'),
  ]);
  const agent = agentWith(tools, brain, { plans });
  const result = await agent.run('сделай');
  assert.equal(result.outcome, 'unsure');
  const last = [...agent.history].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string');
  assert.match(last.content, /Не закрыто: шаг 2 — переписать файл/);
});

test('«продолжай» поднимает план прошлого хода и не начинает заново', async () => {
  const plans = new TurnPlans();
  const tools = new ToolRegistry();
  for (const tool of planTools(plans)) tools.register(tool);
  tools.register({ name: 'echo', risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'эхо' }) });
  const brain = scripted([
    call('1', 'plan_set', { steps: ['первый шаг', 'второй шаг'] }),
    call('2', 'plan_done', { step: 1, evidence: 'готово' }),
    say('Первый готов.'),
    call('3', 'plan_done', { step: 2, evidence: 'тоже готово' }),
    say('Всё готово.'),
  ]);
  const agent = agentWith(tools, brain, { plans });
  await agent.run('сделай два дела');
  const result = await agent.run('продолжай');
  assert.equal(result.outcome, 'answer');
  const request = brain.requests[brain.requests.length - 2];
  const text = JSON.stringify(request);
  assert.match(text, /План прошлого хода/);
  assert.match(text, /первый шаг/);
  assert.match(text, /второй шаг/);
});

test('turn_stop: три вида остановки доходят до итога и текста', async () => {
  for (const [kind, words] of [['impossible', 'Невозможно'], ['needs_human', 'Нужен человек'], ['unsure', 'Не уверен в результате']]) {
    const tools = new ToolRegistry();
    for (const tool of planTools(new TurnPlans())) tools.register(tool);
    const brain = scripted([
      call('1', 'turn_stop', { kind, reason: 'так вышло' }),
      say('лишнее'),
    ]);
    const events = [];
    const agent = agentWith(tools, brain, { emit: (e) => events.push(e) });
    const result = await agent.run('сделай');
    assert.equal(result.outcome, kind, kind);
    const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    assert.ok(text.includes(`${words}: так вышло`), `${kind}: ${text}`);
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.outcome, kind);
    assert.equal(done.status, kind === 'unsure' ? 'unverified' : 'failed');
  }
});

test('смена разговора забывает план: «продолжай» не поднимает чужой план', async () => {
  const plans = new TurnPlans();
  const tools = new ToolRegistry();
  for (const tool of planTools(plans)) tools.register(tool);
  const brain = scripted([
    call('1', 'plan_set', { steps: ['раз', 'два'] }),
    say('Начал.'),
    say('Нечего продолжать.'),
  ]);
  const agent = agentWith(tools, brain, { plans });
  await agent.run('сделай');
  agent.forgetPlan();
  await agent.run('продолжай');
  const lastRequest = brain.requests[brain.requests.length - 1];
  assert.doesNotMatch(JSON.stringify(lastRequest), /План прошлого хода/);
});

test('лимит шагов с незакрытым планом: предложение доделать в фоне и цель для поручения', async () => {
  const build = (name) => {
    const plans = new TurnPlans();
    const tools = new ToolRegistry();
    for (const tool of planTools(plans)) tools.register(tool);
    tools.register({ name, risk: 'T0', description: 'x', parameters: obj, run: async () => ({ ok: true, summary: 'ок' }) });
    const brain = scripted([call('1', 'plan_set', { steps: ['собрать данные', 'написать отчёт'] }), call('2', name), call('3', name)]);
    const events = [];
    return { agent: agentWith(tools, brain, { plans, maxSteps: 2, backgroundOffer: true, emit: (e) => events.push(e) }), events };
  };
  const text = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

  const files = build('echo');
  assert.equal((await files.agent.run('подготовь отчёт по продажам')).outcome, 'limit');
  assert.match(text(files.events), /продолжай в фоне/);
  const goal = files.agent.backgroundGoal();
  assert.match(goal, /подготовь отчёт по продажам/);
  assert.match(goal, /написать отчёт — осталось/);

  // План, который уже работал руками, в фон без владельца не уходит.
  const hands = build('ui_click');
  assert.equal((await hands.agent.run('нажми кнопки')).outcome, 'limit');
  assert.doesNotMatch(text(hands.events), /продолжай в фоне/);
  assert.equal(hands.agent.backgroundGoal(), null);
});

test('turn_stop попадает в дела своим словом, а не безликим провалом', () => {
  const { closeTurn } = require('../src/deals/deals');
  const saved = [];
  const store = { get: () => ({ title: 'дело' }), upsert: (deal) => { saved.push(deal); return true; } };
  closeTurn(store, 'ref', 'needs_human');
  closeTurn(store, 'ref', 'impossible');
  closeTurn(store, 'ref', 'unsure');
  assert.match(saved[0].reason, /нужен человек/);
  assert.match(saved[1].reason, /нельзя довести/);
  assert.match(saved[2].reason, /не подтверждён/);
});
