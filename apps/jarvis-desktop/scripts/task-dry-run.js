'use strict';

// ТЕСТОВЫЙ сквозной прогон автономной задачи: без настоящей модели, без сети и без расходов.
// Модель подставная: готовый сценарий ответов (план из двух шагов с проверками file_contains,
// две записи файла через workspace_write, «шаг сделан»), и к каждому ответу — usage, как у DeepSeekClient.
// Остальное настоящее: createRuntime, страж бюджета и учёт стоимости (по ценам prices.js), очередь, мандат,
// исполнитель, инструменты рабочей папки, объективные проверки и отчёт. Песочница и файлы данных — во временной папке.
// Мандат одобряет подставной брокер ответом «один раз».
// Код выхода 0 — только если задача «завершено» (done) и отчёт говорит «проверено».
//
// Запуск: node scripts/task-dry-run.js [--keep] [--tmp <папка>]
//   --keep — не удалять временную папку после прогона (посмотреть отчёт и файлы);
//   --tmp  — где создать временную папку (по умолчанию системная временная папка).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntime } = require('../src/tasks/runtime');
const { WorkspaceIndex } = require('../src/rag/index');
const { workspaceTools } = require('../src/tools/workspace');
const { ToolRegistry } = require('../src/tools/registry');
const { StopSwitch } = require('../src/control/stop');
const { Journal } = require('../src/journal/journal');
const { priceFor } = require('../src/cost/prices');
const { costOf } = require('../src/cost/meter');
const { humanStatus } = require('../src/tasks/model');

// ID модели нужен только для цены: к провайдеру запросов нет.
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
// usage одного ответа подставной модели: 1500 токенов входа (500 из кэша), 120 выхода.
const USAGE = Object.freeze({ promptTokens: 1500, cachedTokens: 500, completionTokens: 120, reasoningTokens: 0 });
const GOAL = 'Записать заметку об улуне в notes/tea.md и сводку с упоминанием улуна в reports/tea-summary.md';

// Сценарий: что «ответит» модель на каждый запрос исполнителя, по порядку.
const SCRIPT = [
  {
    toolCalls: [{
      name: 'task_plan_submit',
      args: {
        steps: [
          { title: 'Записать заметку о чае', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } },
          { title: 'Записать сводку', check: { kind: 'file_contains', path: 'reports/tea-summary.md', text: 'улун' } },
        ],
        criteria: [
          { requirement: 'Записать заметку об улуне в notes/tea.md', text: 'В заметке упомянут улун', check: { kind: 'file_contains', path: 'notes/tea.md', text: 'улун' } },
          { requirement: 'Записать сводку с упоминанием улуна в reports/tea-summary.md', text: 'В сводке упомянут улун', check: { kind: 'file_contains', path: 'reports/tea-summary.md', text: 'улун' } },
        ],
      },
    }],
  },
  // Проверка file_contains учитывает регистр: в заметке должно быть именно «улун».
  { toolCalls: [{ name: 'workspace_write', args: { path: 'notes/tea.md', content: '# Чай\n\nСорта: улун, пуэр, сенча.\n' } }] },
  { toolCalls: [{ name: 'step_done', args: { summary: 'заметка записана' } }] },
  { toolCalls: [{ name: 'workspace_write', args: { path: 'reports/tea-summary.md', content: '# Сводка\n\nВ notes/tea.md записана заметка о чае: улун, пуэр, сенча.\n' } }] },
  { toolCalls: [{ name: 'step_done', args: { summary: 'сводка записана' } }] },
];

function errText(err) {
  return (err && err.message) || String(err);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// Подставная модель: отвечает по сценарию и после каждого ответа сообщает onUsage, как DeepSeekClient.
function testBrain(script) {
  const brain = {
    model: MODEL,
    calls: 0,
    async chat(args = {}) {
      const step = script[brain.calls];
      brain.calls += 1;
      if (!step) throw new Error('сценарий подставной модели исчерпан');
      if (typeof args.onUsage === 'function') {
        args.onUsage({
          model: MODEL,
          purpose: args.purpose,
          ok: true,
          usage: { ...USAGE },
          requestChars: JSON.stringify(args.messages || []).length,
          attempts: 1,
        });
      }
      return {
        content: '',
        reasoningContent: null,
        toolCalls: step.toolCalls.map((c, i) => ({ id: `dry${brain.calls}_${i}`, name: c.name, args: c.args, argsError: null })),
        stats: { ...USAGE },
      };
    },
  };
  return brain;
}

// Подставной брокер подтверждений: на любой запрос отвечает «один раз» и запоминает, что спросили.
function approveOnce() {
  const asked = [];
  return {
    asked,
    request(payload) {
      asked.push({ ...payload });
      return Promise.resolve('once');
    },
    respond: () => false,
    cancelAll: () => 0,
    list: () => [],
  };
}

function indent(text, prefix = '  ') {
  return String(text).split('\n').map((line) => `${prefix}${line}`).join('\n');
}

async function main() {
  const keep = process.argv.includes('--keep');
  const parent = argValue('--tmp') || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const base = fs.mkdtempSync(path.join(parent, 'jarvis-dry-run-'));
  const root = path.join(base, 'workspace');
  const dataDir = path.join(base, 'data');
  for (const dir of ['inbox', 'notes', 'reports']) fs.mkdirSync(path.join(root, dir), { recursive: true });

  console.log('=== ТЕСТОВЫЙ ПРОГОН автономной задачи ===');
  console.log('Модель подставная (готовый сценарий ответов), сеть не используется, денег не тратится.');
  console.log(`Временная папка: ${base}`);

  let runtime = null;
  let passed = false;
  try {
    const index = new WorkspaceIndex(root);
    const registry = new ToolRegistry();
    for (const tool of workspaceTools(index)) registry.register(tool);
    const brain = testBrain(SCRIPT);
    const broker = approveOnce();
    const stop = new StopSwitch();
    const events = [];
    runtime = createRuntime({
      brain,
      model: MODEL,
      tasksFile: path.join(dataDir, 'tasks.json'),
      budgetFile: path.join(dataDir, 'budget.json'),
      sandboxRoot: root,
      reportsDir: 'reports',
      dailyLimitUsd: 1,
      toolRegistry: registry,
      approvals: broker,
      stop,
      journal: new Journal(path.join(dataDir, 'journal.jsonl')),
      emit: (event) => events.push(event),
      resolve: (rel) => index.resolveInside(rel),
    });

    const res = await runtime.submitTask({
      title: 'Заметка о чае (тестовый прогон)',
      goal: GOAL,
      tools: ['workspace_read', 'workspace_write'],
      folders: ['notes', 'reports'],
      expiresInHours: 1,
      budgetUsd: 0.1,
    });
    const mandateAsk = broker.asked.find((a) => String(a.id).startsWith('mandate:'));
    if (mandateAsk) {
      console.log('\nМандат, который одобрил подставной брокер ответом «один раз»:');
      console.log(indent(mandateAsk.args['мандат']));
    }
    console.log(`\nПоручение: ${res.summary}`);
    if (!res.ok) throw new Error(`поручение не принято: ${res.summary}`);

    await runtime.whenIdle();

    const task = runtime.queue.get(res.data.id);
    const reportFile = path.join(root, 'reports', `task-${task.id}.md`);
    const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : null;
    const spent = runtime.meter.spentForTask(task.id);
    const perCall = costOf(USAGE, priceFor(MODEL));

    console.log(`\nСтатус задачи: ${humanStatus(task)} (${task.status})${task.reason ? `, причина: ${task.reason}` : ''}`);
    console.log(`Шаги: ${task.plan.map((s) => `${s.id} ${s.status}${s.result && s.result.verification ? `/${s.result.verification}` : ''}`).join(', ')}`);
    console.log(`Отчёт: ${report === null ? 'не найден' : reportFile}`);
    if (report !== null) {
      console.log('----- отчёт -----');
      console.log(report.trimEnd());
      console.log('----- конец отчёта -----');
    }
    console.log(`Запросов к подставной модели: ${brain.calls} (все через стража бюджета)`);
    console.log(`Потрачено задачей: $${spent.toFixed(6)} — по ценам prices.js для ${MODEL} и usage подставной модели,`);
    console.log(`  за ответ: $${perCall.toFixed(6)} (вход ${USAGE.promptTokens - USAGE.cachedTokens} + из кэша ${USAGE.cachedTokens} + выход ${USAGE.completionTokens} токенов); настоящих денег не потрачено`);
    console.log(`Подтверждений спрошено: ${broker.asked.length}; событий для окна: ${events.length}`);

    passed = task.status === 'done' && report !== null && /\*\*Итог: проверено\*\*/.test(report);
    console.log(passed
      ? '\nИтог прогона: УСПЕХ — задача завершена, отчёт говорит «проверено».'
      : '\nИтог прогона: НЕУДАЧА — задача не завершена или отчёт не говорит «проверено».');
  } catch (err) {
    console.error(`\nИтог прогона: СБОЙ — ${errText(err)}`);
    passed = false;
  } finally {
    if (runtime) runtime.close();
    if (keep) {
      console.log(`Временная папка оставлена: ${base}`);
    } else {
      fs.rmSync(base, { recursive: true, force: true });
      console.log('Временная папка удалена (запустите с --keep, чтобы её оставить).');
    }
  }
  process.exitCode = passed ? 0 : 1;
}

main();
