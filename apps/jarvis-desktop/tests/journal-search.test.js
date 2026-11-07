'use strict';

// История действий (этап 3): чтение/поиск/фильтры, честный статус и маскирование секретов
// до записи. Формат файла прежний: JSONL, одна запись на строку, поля вызывающего сохраняются.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Journal,
  maskSecrets,
  maskSecretText,
  historyStatus,
  readJournal,
  searchJournal,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
} = require('../src/journal/journal');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-journal-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function writeLines(file, records) {
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
}

// ── Маскирование секретов до записи ──────────────────────────────────────────

test('append: секретные поля аргументов не попадают в файл, остальные поля целы', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  const journal = new Journal(file);
  const args = { window: 'Вход', password: 'hunter22', apiKey: 'abcd1234', login: 'owner' };
  const returned = journal.append({ tool: 'settings_save', args, ok: true });

  const [entry] = lines(file);
  assert.deepEqual(entry.args, {
    window: 'Вход',
    password: '[скрыто, 8 симв.]',
    apiKey: '[скрыто, 8 симв.]',
    login: 'owner',
  });
  assert.equal(JSON.stringify(entry).includes('hunter22'), false, 'пароля нет в файле');
  assert.equal(JSON.stringify(entry).includes('abcd1234'), false, 'ключ API не записан');
  assert.deepEqual(args, { window: 'Вход', password: 'hunter22', apiKey: 'abcd1234', login: 'owner' }, 'аргументы вызывающего не меняются');
  assert.deepEqual(returned.args, entry.args, 'append возвращает уже обезличенную запись');
});

test('append: метка «пароль: …» в свободном тексте маскируется до записи', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  new Journal(file).append({ tool: 'workspace_write', args: { path: 'notes.txt', content: 'пароль: hunter22, позвонить Маше' }, ok: true });

  const [entry] = lines(file);
  assert.equal(JSON.stringify(entry).includes('hunter22'), false);
  assert.match(entry.args.content, /пароль: \[скрыто\]/);
  assert.match(entry.args.content, /позвонить Маше/, 'обычный текст не теряется');
});

test('append: ключи и приватные ключи в итоге и доказательстве не записываются', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  const key = 'sk-abcdefghijklmnop123456';
  const block = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
  new Journal(file).append({ tool: 'shell_run', summary: `ключ ${key} не сохранён`, evidence: block, ok: false });

  const [entry] = lines(file);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(key), false, 'sk-ключ не записан');
  assert.equal(raw.includes('MIIEow'), false, 'приватный ключ не записан');
  assert.match(entry.summary, /\[скрыто/);
  assert.match(entry.evidence, /\[скрыто/);
});

test('append: неизвестные поля сохраняются, формат JSONL и ts журнала не меняются', (t) => {
  const file = path.join(tempDir(t), 'nested', 'journal.jsonl');
  const journal = new Journal(file);
  journal.append({ tool: 'memory_about', ok: true, runId: 'run-7', step: 3, callId: 'call-1', custom: { a: 1 }, ts: 'подменено' });

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.trim().split('\n').length, 1, 'одна запись — одна строка');
  const [entry] = lines(file);
  assert.equal(entry.runId, 'run-7', 'runId — связь хода с проверкой — сохранён');
  assert.equal(entry.step, 3);
  assert.equal(entry.callId, 'call-1');
  assert.deepEqual(entry.custom, { a: 1 });
  assert.equal(new Date(entry.ts).toISOString(), entry.ts, 'время ставит журнал');
});

test('append: набранный текст по-прежнему скрывается длиной, затем общая маскировка не портит вид', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  new Journal(file).append({ tool: 'ui_type', args: { window: 'Вход', text: 'пароль-XyZ-987' }, ok: true });
  const [entry] = lines(file);
  assert.deepEqual(entry.args, { window: 'Вход', text: '[скрыто, 14 симв.]' });
});

test('maskSecrets: глубокая копия без секретов, исходный объект цел, глубина ограничена', () => {
  const input = { user: 'owner', credentials: { token: 't0ken-value', note: 'обычный' }, list: [{ secret: 'x' }, 'текст'] };
  const masked = maskSecrets(input);
  assert.equal(masked.credentials.token, '[скрыто, 11 симв.]');
  assert.equal(masked.credentials.note, 'обычный');
  assert.equal(masked.user, 'owner');
  assert.equal(masked.list[0].secret, '[скрыто, 1 симв.]');
  assert.equal(masked.list[1], 'текст');
  assert.equal(input.credentials.token, 't0ken-value', 'вход не изменён');

  let deep = 'значение';
  for (let i = 0; i < 12; i++) deep = { level: deep };
  assert.match(JSON.stringify(maskSecrets(deep)), /слишком глубоко/);
  const when = new Date('2026-11-07T00:00:00Z');
  assert.equal(maskSecrets({ when }).when, when, 'Date и другие объекты с чужим прототипом не теряются');
  assert.equal(maskSecretText(null), null);
  assert.equal(maskSecretText(''), '');
});

// ── Честный статус записи ────────────────────────────────────────────────────

test('historyStatus: не проверенный результат не выглядит выполненным', () => {
  assert.equal(historyStatus({ ok: true, verified: 'confirmed' }), 'confirmed');
  assert.equal(historyStatus({ ok: true, verified: 'unknown' }), 'unverified', 'verify вернул unknown — «не проверено»');
  assert.equal(historyStatus({ ok: true, verified: null }), 'done', 'инструмент без проверки — «выполнено», не «подтверждено»');
  assert.equal(historyStatus({ ok: true, verified: 'failed' }), 'failed');
  assert.equal(historyStatus({ ok: false, summary: 'провал' }), 'error');
  assert.equal(historyStatus({ ok: false, summary: 'отклонено' }), 'refused');
  assert.equal(historyStatus({ decision: 'deny', ok: false }), 'refused');
  assert.equal(historyStatus({ tool: 'модель' }), 'unverified', 'запись без итога не выдаётся за выполненную');
  assert.equal(historyStatus(null), 'error');
});

// ── Чтение, поиск, фильтры ──────────────────────────────────────────────────

function historyFile(t) {
  const file = path.join(tempDir(t), 'journal.jsonl');
  writeLines(file, [
    { ts: '2026-11-01T10:00:00.000Z', tool: 'app_open', ok: true, verified: 'confirmed', evidence: 'окно появилось', source: 'chat' },
    { ts: '2026-11-02T10:00:00.000Z', tool: 'workspace_write', ok: true, verified: 'unknown', summary: 'запись сделана', source: 'chat' },
    { ts: '2026-11-03T10:00:00.000Z', tool: 'shell_run', ok: false, summary: 'код 1', source: 'task' },
    { ts: '2026-11-04T10:00:00.000Z', tool: 'mail_send', ok: false, decision: 'deny', summary: 'отклонено', source: 'chat' },
    { ts: '2026-11-05T10:00:00.000Z', tool: 'web_fetch', ok: true, verified: 'failed', evidence: 'страница не та', source: 'mission' },
    { ts: '2026-11-06T10:00:00.000Z', tool: 'модель' },
  ]);
  return file;
}

test('readJournal: новые сверху, статус вычислен, отсутствие файла — пустое состояние', (t) => {
  const file = historyFile(t);
  const { items, total, skipped, problem } = readJournal(file);
  assert.equal(problem, null);
  assert.equal(skipped, 0);
  assert.equal(total, 6);
  assert.deepEqual(items.map((item) => item.tool), ['модель', 'web_fetch', 'mail_send', 'shell_run', 'workspace_write', 'app_open']);
  assert.deepEqual(items.map((item) => item.status), ['unverified', 'failed', 'refused', 'error', 'unverified', 'confirmed']);

  const missing = readJournal(path.join(path.dirname(file), 'нет.jsonl'));
  assert.deepEqual(missing, { items: [], total: 0, skipped: 0, problem: null }, 'нет файла — пусто, без падения');
});

test('readJournal: битые строки пропускаются, остальные читаются; файл не меняется', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  fs.writeFileSync(file, '{битая строка\n{"ts":"2026-11-01T10:00:00.000Z","tool":"app_open","ok":true}\n[1,2]\n', 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  const result = readJournal(file);
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 2, 'битая строка и не-объект посчитаны');
  assert.equal(result.items[0].tool, 'app_open');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'чтение не переписывает журнал');
});

test('readJournal: страницы offset/limit и пределы', (t) => {
  const file = historyFile(t);
  const first = readJournal(file, { limit: 2 });
  assert.deepEqual(first.items.map((item) => item.tool), ['модель', 'web_fetch']);
  assert.equal(first.total, 6);
  const second = readJournal(file, { limit: 2, offset: 2 });
  assert.deepEqual(second.items.map((item) => item.tool), ['mail_send', 'shell_run']);
  assert.equal(readJournal(file, { limit: 0 }).items.length, 6, 'негодный limit берёт значение по умолчанию');
  assert.ok(readJournal(file, { limit: 100000 }).items.length <= MAX_HISTORY_LIMIT);
});

test('searchJournal: поиск по итогу, действию и доказательству; фильтры по типу, источнику, статусу', (t) => {
  const file = historyFile(t);
  assert.deepEqual(searchJournal(file, { query: 'ОКНО' }).items.map((item) => item.tool), ['app_open'], 'регистр не важен');
  assert.deepEqual(searchJournal(file, { query: 'код 1' }).items.map((item) => item.tool), ['shell_run']);
  assert.deepEqual(searchJournal(file, { query: 'страница не та' }).items.map((item) => item.tool), ['web_fetch']);

  assert.deepEqual(searchJournal(file, { status: 'unverified' }).items.map((item) => item.tool), ['модель', 'workspace_write']);
  assert.deepEqual(searchJournal(file, { status: 'all' }).total, 6);
  assert.deepEqual(searchJournal(file, { tool: 'mail_send' }).items.map((item) => item.status), ['refused']);
  assert.deepEqual(searchJournal(file, { source: 'mission' }).items.map((item) => item.tool), ['web_fetch']);
  assert.deepEqual(searchJournal(file, { source: 'mission', status: 'failed' }).total, 1);
  assert.deepEqual(searchJournal(file, { source: 'mission', status: 'confirmed' }).total, 0);
  assert.throws(() => searchJournal(file, { status: 'выполнено' }), /статус/);
});

test('searchJournal: фильтр по дате и страницы; неверный диапазон — понятная ошибка', (t) => {
  const file = historyFile(t);
  assert.deepEqual(
    searchJournal(file, { from: '2026-11-03T00:00:00Z', to: '2026-11-04T23:59:59Z' }).items.map((item) => item.tool),
    ['mail_send', 'shell_run']
  );
  assert.equal(searchJournal(file, { from: '2026-11-04T00:00:00Z' }).total, 3);
  assert.equal(searchJournal(file, { to: '2026-11-02T23:59:59Z' }).total, 2);

  const page = searchJournal(file, { limit: 2, offset: 1 });
  assert.deepEqual(page.items.map((item) => item.tool), ['web_fetch', 'mail_send']);
  assert.equal(page.total, 6);

  assert.throws(() => searchJournal(file, { from: 'не дата' }), /с даты/);
  assert.throws(() => searchJournal(file, { to: '2026-13-40' }), /по дату/);
  assert.throws(() => searchJournal(file, { from: '2026-11-05T00:00:00Z', to: '2026-11-01T00:00:00Z' }), /диапазон/);
});

test('searchJournal: поиск идёт по уже обезличенным аргументам', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  const journal = new Journal(file);
  journal.append({ tool: 'settings_save', args: { password: 'hunter22', note: 'сменить пароль в пятницу' }, ok: true });
  assert.equal(searchJournal(file, { query: 'hunter22' }).total, 0, 'секрета нет и в поиске');
  assert.equal(searchJournal(file, { query: 'пятницу' }).total, 1);
});

test('searchJournal: связь с заданием видна и фильтруется по taskId', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  writeLines(file, [
    { ts: '2026-11-01T10:00:00.000Z', tool: 'workspace_write', taskId: 'task-A', ok: true, verified: 'unknown' },
    { ts: '2026-11-02T10:00:00.000Z', tool: 'workspace_write', taskId: 'task-B', ok: true },
  ]);
  assert.deepEqual(searchJournal(file, { taskId: 'task-A' }).items.map((item) => item.status), ['unverified']);
  assert.equal(searchJournal(file, { taskId: 'task-A' }).total, 1);
  assert.equal(searchJournal(file, { query: 'task-b' }).total, 1, 'задание находится и общим поиском');
  assert.equal(searchJournal(file, { taskId: 'нет' }).total, 0);
});

test('searchJournal: история не смешивает пространства, старые записи считаются «Общим»', (t) => {
  const file = path.join(tempDir(t), 'journal.jsonl');
  const space = '11111111-1111-4111-8111-111111111111';
  writeLines(file, [
    { ts: '2026-11-01T10:00:00.000Z', tool: 'app_open', ok: true },
    { ts: '2026-11-02T10:00:00.000Z', tool: 'workspace_write', workspaceId: space, ok: true },
  ]);
  assert.deepEqual(searchJournal(file, { workspaceId: 'default' }).items.map((item) => item.tool), ['app_open']);
  assert.deepEqual(searchJournal(file, { workspaceId: space }).items.map((item) => item.tool), ['workspace_write']);
});

test('searchJournal: файла нет — пустой результат без исключения', (t) => {
  const file = path.join(tempDir(t), 'нет-журнала.jsonl');
  assert.deepEqual(searchJournal(file), { items: [], total: 0, skipped: 0, problem: null });
});

test('readJournal: нечитаемый путь отдаётся как problem, а не исключение', (t) => {
  const dir = tempDir(t);
  const result = readJournal(dir);
  assert.equal(result.items.length, 0);
  assert.ok(result.problem, 'причина в problem');
  assert.equal(searchJournal(dir).problem, result.problem);
});
