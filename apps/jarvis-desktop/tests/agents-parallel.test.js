'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parallelAgentTools } = require('../src/tools/agents');
const { ApprovalBroker } = require('../src/policy/approvals');
const modes = require('../src/policy/modes');

function toolByName(tools, name) { return tools.find((tool) => tool.name === name); }

test('агенты-исследователь и аналитик работают одновременно с разными наборами инструментов', async () => {
  let active = 0;
  let maxActive = 0;
  const requests = [];
  const brain = { async chat(request) {
    requests.push(request);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { content: `итог ${requests.length}`, toolCalls: [] };
  } };
  const available = ['web_search', 'workspace_read', 'workspace_write', 'document_read'];
  const tools = parallelAgentTools({
    brain,
    buildTools: () => available.map((name) => ({ name, risk: 'T0', parameters: { type: 'object', properties: {} }, async run() { return { ok: true }; } })),
  });
  const result = await toolByName(tools, 'agents_parallel').run({ tasks: [
    { role: 'research', task: 'Найди источники и выдели факты.' },
    { role: 'analysis', task: 'Проведи независимый анализ вопроса.' },
  ] });
  assert.equal(maxActive, 2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.workers.map((worker) => worker.role), ['research', 'analysis']);
  const offered = requests.map((request) => request.tools.map((tool) => tool.function.name));
  assert.deepEqual(offered[0], ['web_search']);
  assert.deepEqual(offered[1], ['web_search', 'workspace_read', 'document_read']);
});

test('агент по файлам запускается после параллельных читателей и получает их заметки', async () => {
  const starts = [];
  const brain = { async chat(request) {
    const role = request.messages[0].content.match(/Роль: ([^\n]+)/)?.[1];
    starts.push(role);
    return { content: role === 'редактор файлов' ? 'Файл подготовлен с учётом анализа.' : `${role} нашёл основания.`, toolCalls: [] };
  } };
  const tools = parallelAgentTools({
    brain,
    buildTools: () => ['workspace_read', 'workspace_write'].map((name) => ({ name, risk: 'T0', parameters: { type: 'object', properties: {} }, async run() { return { ok: true }; } })),
  });
  const result = await toolByName(tools, 'agents_parallel').run({ tasks: [
    { role: 'research', task: 'Собери факты.' },
    { role: 'analysis', task: 'Оцени задачу.' },
    { role: 'files', task: 'Создай отчёт по исходному запросу.' },
  ] });
  assert.deepEqual(starts.slice(0, 2).sort(), ['аналитик', 'исследователь']);
  assert.equal(starts[2], 'редактор файлов');
  assert.match(result.data.workers[2].answer, /подготовлен с учётом анализа/);
});

test('файловая роль выполняет запись через инструмент и сохраняет независимую проверку эффекта', async () => {
  let wrote = false;
  let asked = false;
  const journal = [];
  const approvals = new ApprovalBroker();
  const brain = { async chat(request) {
    const role = request.messages[0].content.match(/Роль: ([^\n]+)/)?.[1];
    if (role === 'редактор файлов' && !wrote) {
      wrote = true;
      return { content: '', toolCalls: [{ id: 'write-1', name: 'workspace_write', args: { path: 'out.md', content: 'проверенное содержимое' } }] };
    }
    return { content: 'Отчёт готов.', toolCalls: [] };
  } };
  const fileWrite = {
    name: 'workspace_write', risk: 'T1', parameters: { type: 'object', properties: {} },
    async run() { return { ok: true, summary: 'записано' }; },
    async verify() { return { status: 'confirmed', evidence: 'содержимое прочитано обратно' }; },
  };
  const tool = toolByName(parallelAgentTools({
    brain,
    policy: modes,
    approvals,
    journal: { append: (entry) => journal.push(entry) },
    getMode: () => 'ask',
    emit(event) {
      if (event.type === 'approval_request') {
        asked = true;
        approvals.respond(event.id, 'once');
      }
    },
    buildTools: () => [fileWrite],
  }), 'agents_parallel');
  const result = await tool.run({ tasks: [
    { role: 'analysis', task: 'Подготовь критерии.' },
    { role: 'files', task: 'Создай файл out.md.' },
  ] }, { workspace: 'D:\\workspace' });
  assert.equal(result.ok, true);
  assert.equal(asked, true, 'вложенная запись отдельно спрашивает подтверждение');
  assert.ok(journal.some((entry) => entry.workerRole === 'files' && entry.tool === 'workspace_write'));
  assert.deepEqual(result.data.workers[1].actions, [{
    name: 'workspace_write', ok: true, summary: 'записано', verified: 'confirmed', evidence: 'содержимое прочитано обратно',
  }]);
});

test('отклоняет одинаковые роли, секреты и больше трёх поручений до запуска модели', async () => {
  let calls = 0;
  const tool = toolByName(parallelAgentTools({ brain: { async chat() { calls += 1; return { content: 'x', toolCalls: [] }; } }, buildTools: () => [] }), 'agents_parallel');
  for (const tasks of [
    [{ role: 'research', task: 'найди' }, { role: 'research', task: 'поищи' }],
    [{ role: 'analysis', task: 'используй ключ sk-abcdefghijklmnop' }, { role: 'research', task: 'найди' }],
    [{ role: 'research', task: 'a' }, { role: 'analysis', task: 'b' }, { role: 'files', task: 'c' }, { role: 'research', task: 'd' }],
  ]) assert.equal((await tool.run({ tasks })).ok, false);
  assert.equal(calls, 0);
});

test('verify подтверждает сбор отчётов от всех ролей, а не истинность их выводов', async () => {
  const tool = toolByName(parallelAgentTools({ brain: { async chat() { return { content: 'готово', toolCalls: [] }; } }, buildTools: () => [] }), 'agents_parallel');
  const args = { tasks: [
    { role: 'research', task: 'найди информацию' },
    { role: 'analysis', task: 'проанализируй' },
  ] };
  const result = await tool.run(args);
  const check = await tool.verify(args, result);
  assert.equal(check.status, 'confirmed');
  assert.match(check.evidence, /отчёты получены/);
  assert.doesNotMatch(check.evidence, /факты верны/);
});
