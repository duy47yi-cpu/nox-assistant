'use strict';

// Мандат автономной задачи: цель, инструменты, папки, срок, лимиты, бюджет и проверка каждого вызова.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceIndex } = require('../src/rag/index');
const {
  ALLOWED_TOOLS, DEFAULTS, MAX_EXPIRY_MS, MAX_STEPS, MAX_ACTIVE_MS, MAX_BUDGET_USD,
  createMandate, checkTool, isExpired, summarize, isHardBanned,
} = require('../src/tasks/mandate');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12, 0);
const DEFAULT_LIMITS = { maxSteps: 100, maxFailuresPerStep: 3, maxActiveMs: 4 * 60 * 60 * 1000, maxTokens: 300000 };
// Для проверок без диска: пути только сравниваются, папку создавать не нужно.
const ROOT = path.join(os.tmpdir(), 'jarvis-mandate', 'workspace');

// Настоящая песочница во временной папке и проверка путей, как в main.js. Рядом — соседняя «workspace2».
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mandate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(base, 'workspace2'), { recursive: true });
  fs.writeFileSync(path.join(base, 'workspace2', 'secret.md'), 'чужое');
  const index = new WorkspaceIndex(root);
  return { root, resolve: (rel) => index.resolveInside(rel) };
}

// Минимальные верные параметры мандата; over дополняет и переопределяет.
function params(over = {}) {
  return {
    goal: 'Собрать заметки о чае в reports/tea.md',
    tools: ['workspace_read', 'workspace_write'],
    sandboxRoot: ROOT,
    now: NOW,
    ...over,
  };
}

test('константы: белый список, значения по умолчанию и потолки', () => {
  assert.deepEqual([...ALLOWED_TOOLS], ['workspace_list', 'workspace_read', 'workspace_search', 'workspace_write', 'document_read', 'document_write', 'project_brief', 'project_diagnostics', 'web_search', 'web_fetch', 'web_wiki', 'web_research', 'web_check_claims', 'code_read', 'code_write', 'code_edit', 'code_test']);
  assert.deepEqual({ ...DEFAULTS }, { ...DEFAULT_LIMITS, budgetUsd: 0.25, expiresInMs: DAY });
  assert.equal(MAX_EXPIRY_MS, 7 * DAY);
  assert.equal(MAX_STEPS, 100);
  assert.equal(MAX_ACTIVE_MS, 4 * 60 * 60 * 1000);
  assert.equal(MAX_BUDGET_USD, 1);
  assert.throws(() => ALLOWED_TOOLS.push('shell_run'), TypeError, 'белый список не расширить на ходу');
  for (const name of ALLOWED_TOOLS) assert.equal(isHardBanned(name), false, name);
});

test('мандат по умолчанию: вся песочница, сутки, лимиты и бюджет из DEFAULTS, не подтверждён', () => {
  const tools = ['web_fetch', 'workspace_read', 'web_fetch'];
  const m = createMandate(params({ tools }));
  assert.equal(typeof m.id, 'string');
  assert.ok(m.id.length > 0);
  assert.equal(m.goal, 'Собрать заметки о чае в reports/tea.md');
  assert.deepEqual(m.tools, ['web_fetch', 'workspace_read'], 'дубли убраны');
  assert.deepEqual(m.folders, [ROOT]);
  assert.equal(m.createdAt, NOW);
  assert.equal(m.expiresAt, NOW + DAY);
  assert.deepEqual(m.limits, DEFAULT_LIMITS);
  assert.equal(m.budgetUsd, 0.25);
  assert.equal(m.budgetCheckedAgainstDaily, false, 'дневной бюджет не передан — не сверено');
  assert.equal(m.approvedBy, null);
  tools.push('shell_run');
  assert.deepEqual(m.tools, ['web_fetch', 'workspace_read'], 'мандат не делит массив с вызывающим кодом');
  assert.notEqual(createMandate(params()).id, m.id, 'у каждого мандата свой id');
});

test('shell_run отклоняется даже при явном указании', () => {
  assert.throws(() => createMandate(params({ tools: ['workspace_read', 'shell_run'] })), /«shell_run» запрещён/);
});

test('lib_time отклоняется: любые lib_* под запретом', () => {
  assert.throws(() => createMandate(params({ tools: ['lib_time'] })), /«lib_time» запрещён/);
});

test('send_message отклоняется: слово-действие в имени', () => {
  assert.throws(() => createMandate(params({ tools: ['send_message'] })), /«send_message» запрещён/);
});

test('task_plan отклоняется: управление задачами — не для модели', () => {
  assert.throws(() => createMandate(params({ tools: ['task_plan'] })), /«task_plan» запрещён/);
});

test('жёсткий запрет: library_run, task_*, слова-действия между «_» и при любом написании', () => {
  const banned = [
    'library_run', 'lib_notes_read', 'task_create', 'task_verify', 'web_post', 'file_delete', 'note_remove',
    'publish', 'git_push', 'upload_file', 'pay', 'pay_invoice', 'money_transfer', 'purchase_item', 'buy_ticket',
    'sendMessage', 'Send-Message', 'SHELL_RUN', 'Task_Plan', 'mcp__mail__send',
  ];
  for (const name of banned) {
    assert.equal(isHardBanned(name), true, name);
    assert.throws(() => createMandate(params({ tools: [name] })), /запрещён/, name);
  }
  // Слово должно стоять отдельно: «payload», «repost», «buyer», «postman» — это не pay, post и buy.
  for (const name of ['payload_read', 'repost', 'web_buyer', 'postman']) assert.equal(isHardBanned(name), false, name);
});

test('инструмент не из белого списка отклоняется, пустой список — тоже', () => {
  assert.throws(() => createMandate(params({ tools: ['clipboard_read'] })), /не входит в разрешённые/);
  assert.throws(() => createMandate(params({ tools: ['library_list'] })), /не входит в разрешённые/);
  assert.throws(() => createMandate(params({ tools: [] })), /список инструментов/);
  assert.throws(() => createMandate(params({ tools: 'web_fetch' })), /список инструментов/);
});

test('выход за папку через «..» отклоняется', () => {
  assert.throws(() => createMandate(params({ folders: ['../outside'] })), /вне песочницы/);
  assert.throws(() => createMandate(params({ folders: ['notes/../../outside'] })), /вне песочницы/);
  assert.throws(() => createMandate(params({ folders: [`${ROOT}/notes/../..`] })), /вне песочницы/);
});

test('соседняя папка с похожим именем (workspace2) отклоняется', () => {
  assert.throws(() => createMandate(params({ folders: [`${ROOT}2`] })), /вне песочницы/);
  assert.throws(() => createMandate(params({ folders: ['../workspace2/notes'] })), /вне песочницы/);
});

test('папки: внутри песочницы, относительные — от её корня, дубли убираются, пустой список — ошибка', () => {
  const m = createMandate(params({ folders: ['notes', path.join(ROOT, 'notes'), 'reports/', 'notes/../reports'] }));
  assert.deepEqual(m.folders, [path.join(ROOT, 'notes'), path.join(ROOT, 'reports')]);
  assert.deepEqual(createMandate(params({ folders: [ROOT] })).folders, [ROOT], 'сама песочница — можно');
  assert.throws(() => createMandate(params({ folders: [] })), /хотя бы одна папка/);
  assert.throws(() => createMandate(params({ folders: [''] })), /непустой строкой/);
  assert.throws(() => createMandate(params({ sandboxRoot: 'relative/workspace' })), /абсолютный путь к песочнице/);
});

test('на Windows регистр букв в путях папок не важен', { skip: process.platform !== 'win32' }, () => {
  const upper = path.join(ROOT.toUpperCase(), 'NOTES');
  assert.deepEqual(createMandate(params({ folders: [upper] })).folders, [upper]);
  assert.deepEqual(createMandate(params({ folders: ['notes', upper] })).folders, [path.join(ROOT, 'notes')], 'дубль в другом регистре убран');
  assert.throws(() => createMandate(params({ folders: [`${ROOT.toUpperCase()}2`] })), /вне песочницы/);
});

test('срок 8 дней отклоняется; 7 дней — потолок; нулевой, отрицательный и не число — ошибка', () => {
  assert.throws(() => createMandate(params({ expiresInMs: 8 * DAY })), /срок мандата/);
  assert.equal(createMandate(params({ expiresInMs: 7 * DAY })).expiresAt, NOW + 7 * DAY);
  assert.throws(() => createMandate(params({ expiresInMs: MAX_EXPIRY_MS + 1 })), /срок мандата/);
  assert.throws(() => createMandate(params({ expiresInMs: 0 })), /срок мандата/);
  assert.throws(() => createMandate(params({ expiresInMs: -DAY })), /срок мандата/);
  assert.throws(() => createMandate(params({ expiresInMs: '3600000' })), /срок мандата/);
});

test('бюджет больше $1 отклоняется; нулевой, отрицательный и не число — тоже', () => {
  assert.throws(() => createMandate(params({ budgetUsd: 1.01 })), /бюджет задачи/);
  assert.throws(() => createMandate(params({ budgetUsd: 0 })), /бюджет задачи/);
  assert.throws(() => createMandate(params({ budgetUsd: -0.1 })), /бюджет задачи/);
  assert.throws(() => createMandate(params({ budgetUsd: Number.NaN })), /бюджет задачи/);
  assert.equal(createMandate(params({ budgetUsd: 1 })).budgetUsd, 1);
});

test('бюджет больше дневного отклоняется; сверенный с дневным отмечается', () => {
  assert.throws(() => createMandate(params({ budgetUsd: 0.5, dailyBudgetUsd: 0.4 })), /больше дневного бюджета/);
  assert.throws(() => createMandate(params({ dailyBudgetUsd: 0 })), /больше дневного бюджета/, 'дневной исчерпан');
  assert.throws(() => createMandate(params({ dailyBudgetUsd: -1 })), /дневной бюджет/);
  const m = createMandate(params({ budgetUsd: 0.4, dailyBudgetUsd: 0.4 }));
  assert.equal(m.budgetUsd, 0.4);
  assert.equal(m.budgetCheckedAgainstDaily, true);
});

test('лимит шагов 41 отклоняется без тихой подмены; недостающие лимиты — из DEFAULTS', () => {
  assert.throws(() => createMandate(params({ limits: { maxSteps: 101 } })), /maxSteps.*от 1 до 100/);
  assert.throws(() => createMandate(params({ limits: { maxSteps: 0 } })), /maxSteps/);
  assert.throws(() => createMandate(params({ limits: { maxSteps: 2.5 } })), /maxSteps/);
  assert.throws(() => createMandate(params({ limits: { maxSteps: '10' } })), /maxSteps/);
  assert.throws(() => createMandate(params({ limits: { maxFailuresPerStep: 4 } })), /maxFailuresPerStep/);
  assert.throws(() => createMandate(params({ limits: { maxActiveMs: MAX_ACTIVE_MS + 1 } })), /maxActiveMs/);
  assert.throws(() => createMandate(params({ limits: { maxTokens: 1000001 } })), /maxTokens/);
  assert.throws(() => createMandate(params({ limits: { maxStep: 10 } })), /неизвестный лимит «maxStep»/);
  const m = createMandate(params({ limits: { maxSteps: 10, maxTokens: 1000000 } }));
  assert.deepEqual(m.limits, { ...DEFAULT_LIMITS, maxSteps: 10, maxTokens: 1000000 });
});

test('цель — непустая строка до 2000 символов; неизвестный параметр — ошибка', () => {
  assert.throws(() => createMandate(params({ goal: '   ' })), /нужна цель/);
  assert.throws(() => createMandate(params({ goal: undefined })), /нужна цель/);
  assert.throws(() => createMandate(params({ goal: 'x'.repeat(2001) })), /длиннее 2000/);
  assert.equal(createMandate(params({ goal: `  ${'x'.repeat(2000)}  ` })).goal.length, 2000, 'пробелы по краям не считаются');
  assert.throws(() => createMandate(params({ budget: 0.5 })), /неизвестный параметр мандата «budget»/);
  assert.throws(() => createMandate(params({ now: 'сейчас' })), /now/);
});

test('истёкший мандат отклоняется в checkTool', () => {
  const m = createMandate(params({ tools: ['web_fetch', 'workspace_read'], expiresInMs: 60 * 1000 }));
  const late = checkTool(m, { name: 'web_fetch', args: { url: 'https://example.com' }, now: NOW + 60 * 1000 });
  assert.equal(late.ok, false);
  assert.match(late.reason, /срок мандата истёк/);
  assert.equal(checkTool(m, { name: 'workspace_read', args: {}, now: NOW + DAY }).ok, false);
  assert.equal(isExpired(m, NOW + 60 * 1000 - 1), false);
  assert.equal(isExpired(m, NOW + 60 * 1000), true, 'на границе срок уже истёк');
  assert.equal(isExpired(null), true, 'нет мандата — как истёкший');
});

test('web_fetch разрешён в пределах срока: проверяются только имя и срок', () => {
  const m = createMandate(params({ tools: ['web_fetch'] }));
  assert.deepEqual(checkTool(m, { name: 'web_fetch', args: { url: 'https://ru.wikipedia.org/wiki/Чай' }, now: NOW }), { ok: true });
  assert.deepEqual(checkTool(m, { name: 'web_fetch', args: { url: 'https://example.com' }, now: NOW + DAY - 1 }), { ok: true });
  assert.equal(checkTool(m, { name: 'web_search', args: { query: 'чай' }, now: NOW }).ok, false, 'web_search в мандат не входил');
});

test('project_brief не выходит за разрешённые папки мандата', (t) => {
  const { root, resolve } = sandbox(t);
  fs.mkdirSync(path.join(root, 'other'));
  const m = createMandate(params({ tools: ['project_brief'], sandboxRoot: root, folders: ['notes'] }));
  assert.equal(checkTool(m, { name: 'project_brief', args: { path: 'notes' }, resolve, now: NOW }).ok, true);
  assert.equal(checkTool(m, { name: 'project_brief', args: { path: 'other' }, resolve, now: NOW }).ok, false);
  assert.equal(checkTool(m, { name: 'project_brief', args: {}, resolve, now: NOW }).ok, false);
  try { fs.symlinkSync(path.join(root, 'other'), path.join(root, 'notes', 'link'), 'junction'); }
  catch { return t.skip('junction не доступен'); }
  assert.equal(checkTool(m, { name: 'project_brief', args: { path: 'notes/link' }, resolve, now: NOW }).ok, false);
});

test('диагностика журнала требует мандат и не выходит за его папку', (t) => {
  const { root, resolve } = sandbox(t);
  fs.writeFileSync(path.join(root, 'notes', 'build.log'), 'ERROR failure');
  fs.writeFileSync(path.join(root, 'other.log'), 'ERROR outside');
  const m = createMandate(params({ tools: ['project_diagnostics'], sandboxRoot: root, folders: ['notes'] }));
  assert.equal(checkTool(m, { name: 'project_diagnostics', args: { path: 'notes/build.log' }, resolve, now: NOW }).ok, true);
  assert.equal(checkTool(m, { name: 'project_diagnostics', args: { path: 'other.log' }, resolve, now: NOW }).ok, false);
  const noTool = createMandate(params({ tools: ['project_brief'], sandboxRoot: root, folders: ['notes'] }));
  assert.equal(checkTool(noTool, { name: 'project_diagnostics', args: { path: 'notes/build.log' }, resolve, now: NOW }).ok, false);
});

test('исследование разрешается только если инструмент указан в подтверждённом мандате', () => {
  const plain = createMandate(params({ tools: ['web_search', 'web_fetch'] }));
  assert.equal(checkTool(plain, { name: 'web_research', args: {}, now: NOW }).ok, false);
  const research = createMandate(params({ tools: ['web_research'] }));
  assert.equal(checkTool(research, { name: 'web_research', args: {}, now: NOW }).ok, true);
});

test('workspace_write внутри песочницы разрешён', (t) => {
  const { root, resolve } = sandbox(t);
  const m = createMandate(params({ sandboxRoot: root, tools: ['workspace_write'] }));
  const at = NOW + 1;
  assert.deepEqual(checkTool(m, { name: 'workspace_write', args: { path: 'reports/tea.md', content: 'чай' }, resolve, now: at }), { ok: true });
  assert.deepEqual(checkTool(m, { name: 'workspace_write', args: { path: 'notes/a.md', content: 'чай' }, resolve, now: at }), { ok: true });
});

test('checkTool: выход за песочницу, соседняя папка и путь вне папок мандата — отказ с причиной', (t) => {
  const { root, resolve } = sandbox(t);
  const m = createMandate(params({ sandboxRoot: root, tools: ['workspace_read', 'workspace_write', 'workspace_list'], folders: ['notes'] }));
  const call = (name, p) => checkTool(m, { name, args: { path: p }, resolve, now: NOW + 1 });
  assert.deepEqual(call('workspace_read', 'notes/a.md'), { ok: true });
  assert.deepEqual(call('workspace_list', 'notes'), { ok: true }, 'сама папка мандата');
  const escape = call('workspace_read', '../workspace2/secret.md');
  assert.equal(escape.ok, false);
  assert.match(escape.reason, /не разрешён: путь вне рабочей папки/);
  assert.equal(call('workspace_read', path.join(root, '..', 'workspace2', 'secret.md')).ok, false, 'абсолютный путь наружу');
  const outside = call('workspace_write', 'reports/tea.md');
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /вне папок мандата/);
  assert.equal(call('workspace_read', 'notes2/a.md').ok, false, 'соседняя папка с похожим именем');
  assert.equal(call('workspace_list', 'notes/../reports').ok, false);
});

test('checkTool проверяет тот путь, который откроет инструмент: пробелы по краям обрезаются', (t) => {
  const { root, resolve } = sandbox(t);
  const m = createMandate(params({ sandboxRoot: root, tools: ['workspace_list'], folders: ['notes/sub'] }));
  // Без обрезки «notes/sub/.. » — папка «.. » внутри notes/sub; инструмент же обрежет пробел и откроет notes.
  const verdict = checkTool(m, { name: 'workspace_list', args: { path: 'notes/sub/.. ' }, resolve, now: NOW + 1 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /вне папок мандата/);
});

test('checkTool: инструмента нет в мандате, запрещённый, без resolve или путь не строкой — отказ', (t) => {
  const { root, resolve } = sandbox(t);
  const m = createMandate(params({ sandboxRoot: root, tools: ['workspace_read', 'workspace_search'] }));
  const at = NOW + 1;
  assert.match(checkTool(m, { name: 'workspace_write', args: { path: 'notes/a.md' }, resolve, now: at }).reason, /нет в мандате/);
  assert.match(checkTool(m, { name: 'shell_run', args: { command: 'dir' }, now: at }).reason, /запрещён/);
  const tampered = { ...m, tools: [...m.tools, 'shell_run', 'task_plan', 'library_run'] };
  for (const name of ['shell_run', 'task_plan', 'library_run']) {
    assert.equal(checkTool(tampered, { name, args: {}, now: at }).ok, false, `${name}: дописанный вручную мандат не помогает`);
  }
  assert.match(checkTool(m, { name: 'workspace_read', args: { path: 'notes/a.md' }, now: at }).reason, /нечем проверить/);
  assert.match(checkTool(m, { name: 'workspace_read', args: { path: 42 }, resolve, now: at }).reason, /строкой/);
  assert.equal(checkTool(null, { name: 'web_fetch', now: at }).ok, false);
});

test('без пути инструмент работает с корнем песочницы: мандат с одной папкой его не пускает, папка-корень — пускает', (t) => {
  const { root, resolve } = sandbox(t);
  const at = NOW + 1;
  // Регрессия: workspace_list {} раньше проходил мимо папок мандата и показывал всю песочницу.
  const narrow = createMandate(params({ sandboxRoot: root, tools: ['workspace_list', 'workspace_search'], folders: ['jarvis-acceptance/live-01'] }));
  for (const name of ['workspace_list', 'workspace_search']) {
    const verdict = checkTool(narrow, { name, args: name === 'workspace_list' ? {} : { query: 'чай' }, resolve, now: at });
    assert.equal(verdict.ok, false, name);
    assert.match(verdict.reason, /корень песочницы вне папок мандата/, name);
  }
  // Папка мандата внутри песочницы, но не корень: путь «jarvis-acceptance» (родитель) — тоже вне мандата.
  assert.match(checkTool(narrow, { name: 'workspace_list', args: { path: 'jarvis-acceptance' }, resolve, now: at }).reason, /вне папок мандата/);
  // Мандат, у которого папка — сама песочница, разрешает список и поиск без пути.
  const whole = createMandate(params({ sandboxRoot: root, tools: ['workspace_list', 'workspace_search'] }));
  assert.deepEqual(checkTool(whole, { name: 'workspace_list', args: {}, resolve, now: at }), { ok: true });
  assert.deepEqual(checkTool(whole, { name: 'workspace_search', args: { query: 'чай' }, resolve, now: at }), { ok: true });
  // Мандат без поля root (записан до этой проверки) — корень не докажешь: отказ.
  const { root: _unused, ...legacy } = whole;
  assert.equal(checkTool(legacy, { name: 'workspace_list', args: {}, resolve, now: at }).ok, false);
});

test('отсутствующая целевая папка внутри мандата: путь проверяется без её существования', (t) => {
  const { root, resolve } = sandbox(t);
  const m = createMandate(params({ sandboxRoot: root, tools: ['workspace_list', 'workspace_write'], folders: ['jarvis-acceptance/live-01'] }));
  const at = NOW + 1;
  assert.deepEqual(checkTool(m, { name: 'workspace_list', args: { path: 'jarvis-acceptance/live-01' }, resolve, now: at }), { ok: true });
  assert.deepEqual(checkTool(m, { name: 'workspace_write', args: { path: 'jarvis-acceptance/live-01/calculator-plan.md', content: 'x' }, resolve, now: at }), { ok: true });
  assert.equal(checkTool(m, { name: 'workspace_write', args: { path: 'jarvis-acceptance/live-02/x.md', content: 'x' }, resolve, now: at }).ok, false);
});

test('summarize: цель, инструменты, папки, срок, лимиты и бюджет по-русски', () => {
  const m = createMandate(params({ tools: ['workspace_read', 'web_fetch'], folders: ['notes'], budgetUsd: 0.3, dailyBudgetUsd: 1 }));
  const text = summarize(m);
  assert.match(text, /^Цель: Собрать заметки о чае в reports\/tea\.md$/m);
  assert.match(text, /^Инструменты: чтение файлов \(workspace_read\), чтение веб-страниц \(web_fetch\)$/m);
  assert.ok(text.includes(`Папки: ${path.join(ROOT, 'notes')}`), text);
  assert.match(text, /^Срок: до \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(24 ч\)$/m);
  assert.match(text, /шагов до 100, неудач подряд на шаге до 3, активной работы до 4 ч, токенов до 300 000/);
  assert.match(text, /^Бюджет: до \$0\.30, сверен с дневным бюджетом$/m);
  assert.match(summarize(createMandate(params({ expiresInMs: 7 * DAY }))), /\(7 сут\.\)/);
  assert.match(summarize(createMandate(params())), /с дневным бюджетом не сверен/);
});
