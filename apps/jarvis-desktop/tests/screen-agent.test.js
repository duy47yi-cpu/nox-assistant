'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScreenAgent, screenTask, SCREEN_TOOL_NAMES, SCREEN_PROMPT, MAX_SCREEN_STEPS, UNSURE_TEXT, isDangerousStep } = require('../src/screen/agent');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');
const { ApprovalBroker } = require('../src/policy/approvals');
const { StopSwitch } = require('../src/control/stop');
const modes = require('../src/policy/modes');

// Подменные инструменты: настоящих кликов нет, только счётчики.
function fakeTools(verdict = 'confirmed') {
  const runs = [];
  const verifies = [];
  const windowCalls = [];
  const reg = new ToolRegistry();
  const action = (name) => ({
    name, risk: 'T1', description: name, parameters: { type: 'object', properties: {} },
    async run(args) { runs.push({ name, args }); return { ok: true, summary: `${name} выполнено` }; },
    async verify(args) { verifies.push({ name, args }); return { status: verdict, evidence: 'подмена' }; },
  });
  for (const n of ['ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'app_open', 'shell_run']) reg.register(action(n));
  reg.register({ name: 'ui_elements', risk: 'T0', description: '', async run() { runs.push({ name: 'ui_elements' }); return { ok: true, summary: 'элементы' }; } });
  // F-3: перед автоснимком агент экрана проверяет переднее окно через ui_windows; без него срабатывает privacy-default (запрет снимка).
  reg.register({
    name: 'ui_windows', risk: 'T0', description: '',
    async run() {
      windowCalls.push('ui_windows');
      return { ok: true, summary: 'окна', data: { windows: [{ title: 'Блокнот', process: 'notepad', handle: 1, active: true }] } };
    },
  });
  const look = { name: 'screen_look', risk: 'T1', description: '', async run() { runs.push({ name: 'screen_look' }); return { ok: true, summary: 'снимок', image: 'data:image/jpeg;base64,AA==' }; } };
  return { reg, look, runs, verifies, windowCalls };
}

function setup(t, { brain, verdict, mode = 'full', stop = null, maxSteps } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-screen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { reg, look, runs, verifies } = fakeTools(verdict);
  const events = [];
  const approvals = new ApprovalBroker();
  const agent = new ScreenAgent({
    brain, tools: reg, look, policy: modes, approvals, journal: new Journal(path.join(dir, 'journal.jsonl')),
    emit: (e) => events.push(e), mode, workspace: dir, stop, ...(maxSteps ? { maxSteps } : {}),
  });
  const journal = () => fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { agent, runs, verifies, events, approvals, journal };
}

// Ждём событие, не занимая поток: цикл агента живёт на setImmediate-микрозадачах.
async function waitFor(check, tries = 1000) {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return false;
}

// Мозг: первый ответ — снимок, дальше вызовы по функции step(номер).
function brainOf(step) {
  const brain = { calls: 0, async chat() { brain.calls += 1; return step(brain.calls); } };
  return brain;
}
const call = (name, args = {}, id) => ({ id: id || `c${Math.random()}`, name, args });

test('фраза «сделай на экране» даёт задачу', () => {
  assert.equal(screenTask('Сделай на экране: открой блокнот'), 'открой блокнот');
  assert.equal(screenTask('сделай на экране открой блокнот'), 'открой блокнот');
  assert.equal(screenTask('открой блокнот'), null);
  assert.equal(screenTask('сделай на экране:'), null);
});

test('видны только инструменты экрана', (t) => {
  const { agent } = setup(t, { brain: brainOf(() => ({})) });
  const names = agent.tools.list().map((x) => x.name).sort();
  assert.deepEqual(names, ['app_open', 'screen_look', 'ui_click', 'ui_elements', 'ui_focus', 'ui_keys', 'ui_type', 'ui_windows']);
});

test('SCREEN_TOOL_NAMES включает ui_windows, а SCREEN_PROMPT не раскрывает внутренности и не трогает окно Nox', () => {
  assert.equal(SCREEN_TOOL_NAMES.includes('ui_windows'), true);
  assert.equal(SCREEN_TOOL_NAMES.includes('ui_wait'), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-screen-win-'));
  try {
    const reg = new ToolRegistry();
    reg.register({ name: 'ui_windows', risk: 'T0', description: '', async run() { return { ok: true, summary: 'окна' }; } });
    reg.register({ name: 'shell_run', risk: 'T2', description: '', async run() { return { ok: true, summary: 'shell' }; } });
    const look = { name: 'screen_look', risk: 'T1', description: '', async run() { return { ok: true, summary: 'ok', image: 'data:image/jpeg;base64,AA==' }; } };
    const agent = new ScreenAgent({
      brain: brainOf(() => ({ content: 'ok' })),
      tools: reg,
      look,
      policy: modes,
      approvals: new ApprovalBroker(),
      journal: new Journal(path.join(dir, 'journal.jsonl')),
      mode: 'full',
      workspace: dir,
    });
    assert.deepEqual(agent.tools.list().map((x) => x.name).sort(), ['screen_look', 'ui_windows']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.match(SCREEN_PROMPT, /ui_windows/);
  assert.match(SCREEN_PROMPT, /Собственным окном Nox/i);
  assert.match(SCREEN_PROMPT, /Никогда не называй владельцу внутренние имена инструментов/i);
  assert.doesNotMatch(SCREEN_PROMPT, /спросит код/i);
  assert.match(SCREEN_PROMPT, /система сама запросит подтверждение/i);
});

test('лимит 40 шагов', async (t) => {
  const brain = brainOf((n) => ({ toolCalls: [n === 1 ? call('screen_look') : call('ui_keys', { keys: `k${n}` })] }));
  const { agent, runs, journal } = setup(t, { brain });
  const res = await agent.run('жми клавиши');
  assert.equal(res.outcome, 'limit');
  assert.equal(MAX_SCREEN_STEPS, 40);
  // F-3: каждый автоснимок после действия теперь честно пишется в журнал (args.auto = true),
  // поэтому на 40 шагов модели (1 screen_look + 39 ui_keys) приходится 39 записей автоснимков = 79.
  const entries = journal();
  const modelEntries = entries.filter((r) => !(r.tool === 'screen_look' && r.args && r.args.auto));
  const autoShots = entries.filter((r) => r.tool === 'screen_look' && r.args && r.args.auto);
  assert.equal(modelEntries.length, 40);
  assert.equal(autoShots.length, 39);
  assert.equal(entries.length, 79);
  assert.ok(runs.filter((r) => r.name === 'ui_keys').length <= 39);
});

test('предел шагов задаётся в конструкторе (тесты берут меньше)', async (t) => {
  const brain = brainOf((n) => ({ toolCalls: [n === 1 ? call('screen_look') : call('ui_keys', { keys: `k${n}` })] }));
  const { agent, runs, journal } = setup(t, { brain, maxSteps: 5 });
  const res = await agent.run('жми клавиши');
  assert.equal(res.outcome, 'limit');
  // F-3: 5 шагов модели (1 screen_look + 4 ui_keys) + 4 записи автоснимка в журнале = 9.
  const entries = journal();
  const modelEntries = entries.filter((r) => !(r.tool === 'screen_look' && r.args && r.args.auto));
  const autoShots = entries.filter((r) => r.tool === 'screen_look' && r.args && r.args.auto);
  assert.equal(modelEntries.length, 5);
  assert.equal(autoShots.length, 4);
  assert.equal(entries.length, 9);
  assert.equal(runs.filter((r) => r.name === 'ui_keys').length, 4);
});

test('признаки опасного шага: отправка, оплата, удаление, установка и Enter после ввода', () => {
  for (const label of ['Отправить', 'Отправить сообщение', 'Send', 'Submit', 'Оплатить', 'Удалить', 'Установить', 'Купить', 'Оформить заказ']) {
    assert.equal(isDangerousStep('ui_click', { name: label }), true, `«${label}» — опасный шаг`);
  }
  for (const label of ['Файл', 'Сохранить', 'Отмена', 'Оформить', 'Заказать звонок', 'Поиск', 'Правка']) {
    assert.equal(isDangerousStep('ui_click', { name: label }), false, `«${label}» — безопасный шаг`);
  }
  // Enter опасен только после ввода текста в этом же ходу.
  assert.equal(isDangerousStep('ui_keys', { keys: 'enter' }), false);
  assert.equal(isDangerousStep('ui_keys', { keys: 'tab tab' }, { typed: true }), false);
  assert.equal(isDangerousStep('ui_keys', { keys: 'enter' }, { typed: true }), true);
  assert.equal(isDangerousStep('ui_keys', { keys: 'ctrl+s' }, { typed: true }), false);
});

test('опасный клик в полном доступе спрашивает и выполняется после согласия', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, 'send-ok')] } : { content: 'Сообщение отправлено.' }));
  const { agent, runs, events, approvals, journal } = setup(t, { brain, mode: 'full' });
  const turn = agent.run('отправь сообщение');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'send-ok')), 'владельца спросили');
  const request = events.find((e) => e.type === 'approval_request' && e.callId === 'send-ok');
  // «На сессию» для отправки не предлагаем: каждое действие — отдельное согласие.
  assert.equal(request.allowSession, false);
  approvals.respond(request.id, 'once');
  const res = await turn;
  assert.equal(res.outcome, 'answer');
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 1);
  assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'once');
});

test('отказ на опасном клике: шаг не выполнен, ход needs_human, повтора нет', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, `send-${n}`)] }));
  const { agent, runs, events, approvals, journal } = setup(t, { brain, mode: 'full' });
  const turn = agent.run('отправь сообщение');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.name === 'ui_click')), 'владельца спросили');
  const request = events.find((e) => e.type === 'approval_request' && e.name === 'ui_click');
  approvals.respond(request.id, 'reject');
  const res = await turn;
  assert.equal(res.outcome, 'needs_human');
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0, 'шаг не выполнен');
  assert.equal(brain.calls, 2, 'после отказа модель больше не зовут: шаг не повторяется');
  assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'reject');
  assert.ok(events.some((e) => e.type === 'text' && /не подтвердили/.test(e.delta)));
});

test('безопасный клик не спрашивает', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_click', { window: 'Блокнот', name: 'Файл' }, 'file')] } : { content: 'Меню открыто.' }));
  const { agent, runs, events, journal } = setup(t, { brain, mode: 'full' });
  const res = await agent.run('открой меню Файл');
  assert.equal(res.outcome, 'answer');
  assert.equal(events.some((e) => e.type === 'approval_request'), false);
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 1);
  assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'allow');
});

test('Enter после ввода текста спрашивает и выполняется после согласия', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_type', { window: 'Telegram', name: 'Сообщение', text: 'привет' })] }
      : n === 3 ? { toolCalls: [call('ui_keys', { window: 'Telegram', keys: 'enter' }, 'enter-ok')] }
        : { content: 'Сообщение отправлено.' }));
  const { agent, runs, events, approvals, journal } = setup(t, { brain, mode: 'full' });
  const turn = agent.run('напиши и отправь');
  assert.ok(await waitFor(() => events.some((e) => e.type === 'approval_request' && e.callId === 'enter-ok')), 'владельца спросили перед Enter');
  const request = events.find((e) => e.type === 'approval_request' && e.callId === 'enter-ok');
  approvals.respond(request.id, 'once');
  const res = await turn;
  assert.equal(res.outcome, 'answer');
  assert.deepEqual(
    runs.filter((r) => r.name === 'ui_type' || r.name === 'ui_keys').map((r) => r.name),
    ['ui_type', 'ui_keys']
  );
  assert.equal(journal().find((r) => r.tool === 'ui_keys').decision, 'once');
});

test('Enter без ввода текста не спрашивает', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_keys', { window: 'Блокнот', keys: 'enter' }, 'plain-enter')] } : { content: 'Нажал Enter.' }));
  const { agent, runs, events } = setup(t, { brain, mode: 'full' });
  const res = await agent.run('нажми enter');
  assert.equal(res.outcome, 'answer');
  assert.equal(events.some((e) => e.type === 'approval_request'), false);
  assert.equal(runs.filter((r) => r.name === 'ui_keys').length, 1);
});

test('один шаг за ответ модели и снимок после действия', async (t) => {
  const brain = brainOf((n) => (n === 1
    ? { toolCalls: [call('screen_look'), call('ui_click', { window: 'Блокнот', name: 'Файл' })] }
    : n === 2 ? { toolCalls: [call('ui_click', { window: 'Блокнот', name: 'Файл' }), call('ui_type', { window: 'Блокнот', text: 'x' })] } : { content: 'Готово' }));
  const { agent, runs, journal } = setup(t, { brain });
  const res = await agent.run('нажми Файл');
  assert.equal(res.outcome, 'answer');
  assert.deepEqual(runs.map((r) => r.name), ['screen_look', 'ui_click', 'screen_look']);
  // F-3: автоснимок после действия больше не идёт мимо журнала — запись ложится перед завершением шага в _runCall.
  const entries = journal();
  assert.deepEqual(entries.map((r) => r.tool), ['screen_look', 'screen_look', 'ui_click']);
  const autoShot = entries.find((r) => r.tool === 'screen_look' && r.args && r.args.auto);
  assert.ok(autoShot, 'в журнале есть запись автоснимка');
  assert.equal(autoShot.decision, 'allow');
  assert.ok(agent.history.some((m) => m.image && m.fromTool));
});

for (const failure of ['ошибка', 'без картинки']) {
  test(`после действия нет нового снимка (${failure}): следующий шаг не выполняется`, async (t) => {
    const brain = brainOf((n) => ({ toolCalls: [n === 1 ? call('screen_look') : call('ui_click', { name: `кнопка ${n}` })] }));
    const { agent, runs, events } = setup(t, { brain });
    const original = agent.look.run;
    let calls = 0;
    agent.look.run = async (...args) => {
      calls += 1;
      if (calls === 1) return original(...args);
      if (failure === 'ошибка') throw new Error('нет экрана');
      return { ok: true, summary: 'без картинки' };
    };
    const result = await agent.run('нажимай кнопки');
    assert.equal(result.outcome, 'needs_human');
    assert.equal(runs.filter((item) => item.name === 'ui_click').length, 1);
    assert.equal(brain.calls, 2);
    assert.ok(events.some((item) => item.type === 'text' && /снимок экрана/i.test(item.delta)));
  });
}

test('если первый снимок не содержит картинки, действия не начинаются', async (t) => {
  const brain = brainOf((n) => ({ toolCalls: [n === 1 ? call('screen_look') : call('ui_click', { name: 'Сохранить' })] }));
  const { agent, runs, events } = setup(t, { brain });
  agent.look.run = async () => ({ ok: true, summary: 'снимок без картинки' });
  const result = await agent.run('сохрани');
  assert.equal(result.outcome, 'needs_human');
  assert.equal(runs.filter((item) => item.name === 'ui_click').length, 0);
  assert.equal(brain.calls, 1);
  assert.ok(events.some((item) => item.type === 'text' && /снимок экрана/i.test(item.delta)));
});

test('сценарий «сделай на экране: открой блокнот»: снимок → шаг → проверка', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('app_open', { name: 'notepad' })] } : { content: 'Блокнот открыт, вижу его окно.' }));
  const { agent, runs, verifies, journal, events } = setup(t, { brain });
  const task = screenTask('сделай на экране: открой блокнот');
  assert.equal(task, 'открой блокнот');
  const res = await agent.run(task);
  assert.equal(res.outcome, 'answer');
  // Первый шаг — снимок, затем действие и свежий снимок для сверки результата.
  assert.deepEqual(runs.map((r) => r.name), ['screen_look', 'app_open', 'screen_look']);
  assert.deepEqual(runs[1].args, { name: 'notepad' });
  // Проверка эффекта — ровно один раз, по самому действию.
  assert.deepEqual(verifies.map((v) => v.name), ['app_open']);
  const step = journal().find((r) => r.tool === 'app_open');
  assert.equal(step.decision, 'allow');
  assert.equal(step.verified, 'confirmed');
  // Снимок после шага ушёл модели как картинка, а не только текстом.
  assert.ok(agent.history.some((m) => m.image && m.fromTool && /Снимок экрана/.test(m.content)));
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'Блокнот открыт, вижу его окно.'));
});

test('опасная кнопка спрашивает владельца', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_click', { window: 'Telegram', name: 'Отправить' }, 'tg')] } : { content: 'Не стал' }));
  const { agent, runs, events, approvals, journal } = setup(t, { brain, mode: 'auto' });
  const turn = agent.run('отправь сообщение');
  // В «Авто» снимок тоже спрашивает: разрешаем его, на кнопку отказываем.
  const asked = (id) => events.some((e) => e.type === 'approval_request' && e.callId === id);
  for (let i = 0; i < 200 && !asked('tg'); i += 1) {
    const shot = events.find((e) => e.type === 'approval_request' && e.name === 'screen_look' && !e.answered);
    if (shot) { shot.answered = true; approvals.respond(shot.id, 'once'); }
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(events.some((e) => e.type === 'approval_request' && e.name === 'ui_click'));
  approvals.respond(events.find((e) => e.type === 'approval_request' && e.callId === 'tg').id, 'reject');
  await turn;
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0);
  assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'reject');
});

test('кнопка оплаты запрещена и в полном доступе', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_click', { window: 'Магазин', name: 'Оплатить' })] } : { content: 'Оплату делаете вы' }));
  const { agent, runs, journal } = setup(t, { brain, mode: 'full' });
  await agent.run('оплати');
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0);
  assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'deny');
});

test('кнопки оплаты, покупки и подписки запрещены и в полном доступе', async (t) => {
  // «Подписаться» сюда не входит: формы «подписаться» нет в признаках оплаты (src/policy/modes.js:31).
  // Это вопрос владельцу в отчёте, а не повод менять политику тестом.
  for (const name of ['Оплатить', 'Купить', 'Оформить подписку', 'Оформить заказ']) {
    const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
      : n === 2 ? { toolCalls: [call('ui_click', { window: 'Магазин', name }, `pay-${name}`)] } : { content: 'Оплату делаете вы' }));
    const { agent, runs, journal } = setup(t, { brain, mode: 'full' });
    await agent.run('нажми кнопку');
    assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0, `кнопка «${name}» не нажата`);
    assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'deny', `кнопка «${name}» запрещена`);
  }
});

test('стоп посреди цикла: шаг, ждущий подтверждения, не выполняется', async (t) => {
  const stop = new StopSwitch();
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : { toolCalls: [call('ui_type', { window: 'Блокнот', text: 'секрет' }, 'type1')] }));
  const { agent, runs, events, approvals } = setup(t, { brain, mode: 'ask', stop });
  const turn = agent.run('впиши');
  // «Спрашивать»: подтверждаем снимок, затем ждём вопрос про ввод и жмём стоп.
  for (let i = 0; i < 200; i += 1) {
    const shot = events.find((e) => e.type === 'approval_request' && e.name === 'screen_look' && !e.answered);
    if (shot) { shot.answered = true; approvals.respond(shot.id, 'once'); }
    const typing = events.find((e) => e.type === 'approval_request' && e.name === 'ui_type' && !e.answered);
    if (typing) { typing.answered = true; stop.trigger('тест'); break; }
    await new Promise((r) => setImmediate(r));
  }
  const res = await turn;
  assert.equal(res.outcome, 'stopped');
  assert.equal(runs.filter((r) => r.name === 'ui_type').length, 0);
  assert.ok(events.some((e) => e.type === 'status' && e.state === 'idle'));
});

test('стоп останавливает цикл', async (t) => {
  const stop = new StopSwitch();
  const brain = brainOf((n) => {
    if (n === 3) stop.trigger('тест');
    return { toolCalls: [n === 1 ? call('screen_look') : call('ui_keys', { keys: `k${n}` })] };
  });
  const { agent, runs } = setup(t, { brain, stop });
  const res = await agent.run('жми');
  assert.equal(res.outcome, 'stopped');
  assert.equal(runs.filter((r) => r.name === 'ui_keys').length, 1);
  assert.ok(brain.calls <= 3);
});

test('неподтверждённый шаг не повторяется: ход кончается вопросом', async (t) => {
  const brain = brainOf((n) => ({ toolCalls: [n === 1 ? call('screen_look') : call('ui_click', { window: 'Блокнот', name: 'Сохранить' })] }));
  const { agent, runs, events } = setup(t, { brain, verdict: 'unknown' });
  const res = await agent.run('сохрани');
  assert.equal(res.outcome, 'needs_human');
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 1);
  assert.equal(brain.calls, 2); // после неизвестного исхода модель больше не зовут
  assert.ok(events.some((e) => e.type === 'text' && e.delta === UNSURE_TEXT));
});

test('проверка сказала «не сработало»: тоже стоп с вопросом', async (t) => {
  const brain = brainOf((n) => ({ toolCalls: [n === 1 ? call('screen_look') : call('ui_type', { window: 'Блокнот', text: `t${n}` })] }));
  const { agent, runs } = setup(t, { brain, verdict: 'failed' });
  const res = await agent.run('впиши');
  assert.equal(res.outcome, 'needs_human');
  assert.equal(runs.filter((r) => r.name === 'ui_type').length, 1);
});

test('действие раньше снимка запрещено: сначала экран, потом открытие блокнота', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('app_open', { name: 'notepad' })] }
    : n === 2 ? { toolCalls: [call('screen_look')] }
      : n === 3 ? { toolCalls: [call('app_open', { name: 'notepad' })] } : { content: 'Блокнот открыт.' }));
  const { agent, runs, verifies, journal } = setup(t, { brain });
  const res = await agent.run(screenTask('сделай на экране: открой блокнот'));
  assert.equal(res.outcome, 'answer');
  assert.deepEqual(runs.map((r) => r.name), ['screen_look', 'app_open', 'screen_look']);
  assert.deepEqual(verifies.map((v) => v.name), ['app_open']);
  assert.equal(journal().find((r) => r.tool === 'app_open').decision, 'deny');
});

test('кнопка оплаты: решение политики «запрет» в любом режиме, без вопроса', () => {
  for (const mode of ['full', 'ask', 'auto']) {
    for (const name of ['Оплатить', 'Купить', 'Оформить подписку', 'Оформить заказ', 'Подтвердить заказ', 'Перейти к оплате', 'Купить сейчас', 'Place order', 'Complete the purchase']) {
      const verdict = modes.decide({ mode, name: 'ui_click', risk: 'T1', args: { window: 'Магазин', name }, workspace: os.tmpdir() });
      assert.equal(verdict, 'deny', `${mode}: кнопка «${name}»`);
    }
  }
  assert.equal(modes.describe({ name: 'ui_click', args: { window: 'Магазин', name: 'Оплатить' } }), 'оплату делает владелец сам');
});

test('безопасные кнопки «Оформить» и «Заказать звонок» не считаются оплатой', () => {
  for (const name of ['Оформить', 'Заказать звонок']) {
    assert.equal(modes.isPayment({ name: 'ui_click', args: { window: 'Магазин', name } }), false, name);
    assert.equal(modes.describe({ name: 'ui_click', args: { window: 'Магазин', name } }), null, name);
    for (const mode of ['full', 'ask', 'auto']) {
      const verdict = modes.decide({ mode, name: 'ui_click', risk: 'T1', args: { window: 'Магазин', name }, workspace: os.tmpdir() });
      assert.notEqual(verdict, 'deny', `${mode}: кнопка «${name}» не должна считаться оплатой`);
    }
  }
});

test('кнопка оплаты в «Спрашивать»: отказ сразу, владельца не спрашивают', async (t) => {
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('ui_click', { window: 'Магазин', name: 'Оплатить' }, 'pay')] } : { content: 'Оплату делаете вы' }));
  const { agent, runs, events, approvals, journal } = setup(t, { brain, mode: 'ask' });
  let done = false;
  const turn = agent.run('оплати').then((r) => { done = true; return r; });
  // Снимок в «Спрашивать» тоже спрашивает: разрешаем его и ждём конца хода.
  for (let i = 0; i < 200 && !done; i += 1) {
    const shot = events.find((e) => e.type === 'approval_request' && e.name === 'screen_look' && !e.answered);
    if (shot) { shot.answered = true; approvals.respond(shot.id, 'once'); }
    await new Promise((r) => setImmediate(r));
  }
  await turn;
  assert.equal(events.some((e) => e.type === 'approval_request' && e.name === 'ui_click'), false);
  assert.equal(runs.filter((r) => r.name === 'ui_click').length, 0);
  assert.equal(journal().find((r) => r.tool === 'ui_click').decision, 'deny');
});

test('стоп до начала хода: ни одного шага и ни одного вызова модели', async (t) => {
  const stop = new StopSwitch();
  stop.trigger('тест');
  const brain = brainOf(() => ({ toolCalls: [call('ui_keys', { keys: 'enter' })] }));
  const { agent, runs } = setup(t, { brain, stop });
  const res = await agent.run(screenTask('сделай на экране: нажми enter'));
  assert.equal(res.outcome, 'stopped');
  assert.equal(brain.calls, 0);
  assert.equal(runs.length, 0);
});

test('стоп во время шага: следующий шаг не начинается', async (t) => {
  const stop = new StopSwitch();
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] } : { toolCalls: [call('ui_keys', { keys: `k${n}` })] }));
  const { agent, runs } = setup(t, { brain, stop });
  // Стоп приходит изнутри первого нажатия: этот шаг уже сделан, второй не должен начаться.
  const keys = agent.tools.get('ui_keys');
  const runKeys = keys.run;
  keys.run = async (args, ctx) => { const r = await runKeys(args, ctx); stop.trigger('тест'); return r; };
  const res = await agent.run('жми');
  assert.equal(res.outcome, 'stopped');
  assert.deepEqual(runs.map((r) => r.name), ['screen_look', 'ui_keys']);
  assert.equal(brain.calls, 2);
});

test('интеграция _loop: прогресс «Шаг N из M» в status-событиях', async (t) => {
  const { Agent } = require('../src/agent/loop');
  assert.notEqual(ScreenAgent.prototype._loop, Agent.prototype._loop, 'ScreenAgent переопределяет _loop');
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : n === 2 ? { toolCalls: [call('app_open', { name: 'notepad' })] }
      : { content: 'Готово.' }));
  const { agent, events } = setup(t, { brain, maxSteps: 10 });
  const res = await agent.run('открой блокнот');
  assert.equal(res.outcome, 'answer');
  const labels = events.filter((e) => e.type === 'status' && typeof e.label === 'string').map((e) => e.label);
  assert.ok(labels.some((l) => /^Шаг 1 из 10\b/.test(l)), `ожидали «Шаг 1 из 10», получили: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => /^Шаг 2 из 10\b/.test(l)), `ожидали «Шаг 2 из 10», получили: ${JSON.stringify(labels)}`);
});

test('интеграция _loop: Esc/стоп посреди зависшего шага — поздний результат помечается late и afterStop', async (t) => {
  const stop = new StopSwitch();
  let release = null;
  const brain = brainOf((n) => (n === 1 ? { toolCalls: [call('screen_look')] }
    : { toolCalls: [call('ui_click', { window: 'Блокнот', name: 'Файл' }, 'slow-1')] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-screen-late-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { reg, look } = fakeTools('confirmed');
  reg.get('ui_click').run = async () => {
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, summary: 'поздно нажал' };
  };
  const events = [];
  const journalPath = path.join(dir, 'journal.jsonl');
  const agent = new ScreenAgent({
    brain, tools: reg, look, policy: modes, approvals: new ApprovalBroker(),
    journal: new Journal(journalPath), emit: (e) => events.push(e),
    mode: 'full', workspace: dir, stop, stopGraceMs: 15,
  });
  const turn = agent.run('нажми Файл');
  assert.ok(await waitFor(() => typeof release === 'function'));
  stop.trigger('Esc');
  const res = await turn;
  assert.equal(res.outcome, 'stopped');
  release();
  assert.ok(await waitFor(() => events.some((e) => e.type === 'tool_result' && e.late === true && e.afterStop === true)));
  const entries = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.some((r) => r.tool === 'ui_click' && r.late === true && r.afterStop === true));
});
