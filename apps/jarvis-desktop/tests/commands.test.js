'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CommandStore, normalize } = require('../src/commands/store');
const {
  COMMAND_SCHEMA_VERSION, TRANSFER_FORMAT, TRANSFER_VERSION, MAX_IMPORT_BYTES, MAX_IMPORT_DEPTH,
  exportCommandPack, exportCommandJson, parseCommandPack, previewCommandImport, applyCommandImport,
  MAX_STEPS,
} = require('../src/commands/store');
const { Journal } = require('../src/journal/journal');
const { runCommand, CommandRecorder } = require('../src/commands/runner');
const { ToolRegistry } = require('../src/tools/registry');
const { ApprovalBroker } = require('../src/policy/approvals');
const modes = require('../src/policy/modes');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(t) {
  const dir = setup(t);
  const file = path.join(dir, 'commands.json');
  return { dir, file, store: new CommandStore(file) };
}

function cmd(over = {}) {
  return {
    name: 'Ютуб',
    phrases: ['открой ютуб'],
    steps: [{ tool: 'open_url', args: { url: 'https://youtube.com' } }],
    ...over,
  };
}

function memoryJournal() {
  const entries = [];
  return { entries, append: (e) => { entries.push(e); return e; } };
}

test('локально выбранная команда учитывает внешний инструмент, удалённая не получает её разрешение', async (t) => {
  const dir = setup(t);
  const calls = [];
  const tools = new ToolRegistry();
  tools.register({ name: 'service_send', source: 'mcp', risk: 'T2', ownerAllowed: () => false,
    parameters: { type: 'object', properties: {} }, async run() { calls.push('sent'); return { ok: true, summary: 'готово' }; } });
  const deps = { tools, policy: modes, approvals: null, journal: memoryJournal(), workspace: dir, mode: 'full' };
  const command = { id: 'external', steps: [{ tool: 'service_send', args: {} }] };
  assert.equal((await runCommand(command, deps)).ok, false);
  assert.deepEqual(calls, []);
  assert.equal((await runCommand(command, { ...deps, ownerCommand: true })).ok, true);
  assert.deepEqual(calls, ['sent']);
  assert.equal((await runCommand(command, { ...deps, mode: 'auto', ownerCommand: true })).ok, false);
});

test('локальный запуск фиксирует шаги команды; оплата и удалённый запуск сохраняют ограничения', async (t) => {
  const dir = setup(t);
  const selected = { id: 'local', name: 'Уборка', steps: [{ tool: 'first', args: {} }, { tool: 'delete_file', args: { path: 'a.txt' } }] };
  const seen = [];
  const tools = new ToolRegistry();
  tools.register({ name: 'first', risk: 'T0', parameters: { type: 'object', properties: {} }, async run() { selected.steps[1].args.path = 'b.txt'; return { ok: true, summary: 'готово' }; } });
  tools.register({ name: 'delete_file', risk: 'T2', parameters: { type: 'object', properties: { path: { type: 'string' } } }, async run(args) { seen.push(args.path); return { ok: true, summary: 'готово' }; } });
  tools.register({ name: 'pay_invoice', risk: 'T3', parameters: { type: 'object', properties: {} }, async run() { seen.push('оплата'); return { ok: true, summary: 'готово' }; } });
  const deps = { tools, policy: modes, approvals: null, journal: memoryJournal(), emit: () => {}, workspace: dir, mode: 'full' };
  const local = await runCommand(selected, { ...deps, ownerCommand: true });
  assert.equal(local.ok, true);
  assert.deepEqual(seen, ['a.txt']);
  const remote = await runCommand({ id: 'remote', steps: [{ tool: 'delete_file', args: { path: 'a.txt' } }] }, deps);
  assert.equal(remote.ok, false);
  const paid = await runCommand({ id: 'pay', steps: [{ tool: 'pay_invoice', args: {} }] }, { ...deps, ownerCommand: true });
  assert.equal(paid.ok, false);
  assert.deepEqual(seen, ['a.txt']);
});

function spyTool(name, risk, result = { ok: true, summary: 'готово' }) {
  const spy = { name, risk, runs: 0 };
  spy.def = {
    name,
    risk,
    parameters: { type: 'object', properties: {} },
    run: async () => { spy.runs += 1; return result; },
  };
  return spy;
}

function registryOf(...spies) {
  const reg = new ToolRegistry();
  for (const s of spies) reg.register(s.def);
  return reg;
}

test('save, get, list, обновление и remove', (t) => {
  const { store } = makeStore(t);
  assert.deepEqual(store.list(), []);

  const b = store.save(cmd({ name: 'Б', phrases: [] }));
  const a = store.save(cmd({ name: 'А', phrases: ['открой почту'] }));

  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.equal(a.enabled, true);
  assert.equal(a.lastRunAt, null);
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.deepEqual(store.list().map((c) => c.name), ['А', 'Б']);
  assert.equal(store.get(a.id).name, 'А');
  assert.equal(store.get('нет-такого'), null);

  const updated = store.save({ ...a, name: 'Почта', steps: [{ tool: 'open_url', args: {} }] });
  assert.equal(updated.id, a.id);
  assert.equal(updated.createdAt, a.createdAt);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(a.id).name, 'Почта');

  assert.equal(store.remove(b.id), true);
  assert.equal(store.remove(b.id), false);
  assert.equal(store.get(b.id), null);
  assert.equal(store.list().length, 1);
});

test('нормализация фраз: регистр, ё, пробелы, точка на конце', (t) => {
  assert.equal(normalize('  Открой   Ёлку!  '), 'открой елку');
  assert.equal(normalize('Открой Ютуб.'), 'открой ютуб');
  assert.equal(normalize('ЁЖ?  '), 'еж');

  const { store } = makeStore(t);
  const saved = store.save(cmd({ phrases: ['  Открой   Ютуб. '] }));
  assert.deepEqual(saved.phrases, ['открой ютуб']);

  assert.equal(store.findByPhrase('Открой Ютуб.').id, saved.id);
  assert.equal(store.findByPhrase('ОТКРОЙ ЮТУБ').id, saved.id);
  assert.equal(store.findByPhrase('открой ютуба'), null);
  assert.equal(store.findByPhrase(''), null);
});

test('findByPhrase не находит отключённую команду', (t) => {
  const { store } = makeStore(t);
  store.save(cmd({ enabled: false }));
  assert.equal(store.findByPhrase('открой ютуб'), null);
});

test('фраза не может принадлежать двум командам', (t) => {
  const { store } = makeStore(t);
  const first = store.save(cmd({ name: 'Первая', phrases: ['открой ютуб'] }));

  assert.throws(
    () => store.save(cmd({ name: 'Вторая', phrases: ['Открой Ютуб.'] })),
    /фраза уже используется в команде «Первая»/,
  );
  // Собственная фраза при обновлении той же команды не конфликтует.
  assert.equal(store.save({ ...first, name: 'Первая 2' }).id, first.id);
  assert.equal(store.list().length, 1);
});

test('пустые name и steps отклоняются, файл не создаётся', (t) => {
  const { store, file } = makeStore(t);
  assert.throws(() => store.save(cmd({ name: '   ' })), /имя команды/);
  assert.throws(() => store.save(cmd({ steps: [] })), /шагов от 1 до 20/);
  assert.throws(() => store.save(cmd({ steps: undefined })), /шаги/);
  assert.throws(() => store.save(cmd({ phrases: ['', ' . '] })), /фраза: пустая строка/);
  assert.throws(() => store.save(cmd({ steps: [{ tool: '', args: {} }] })), /имя инструмента/);
  assert.equal(fs.existsSync(file), false);
});

test('повреждённый файл не перезаписывается', (t) => {
  const { store, file } = makeStore(t);
  const broken = '{"items": [';
  fs.writeFileSync(file, broken, 'utf8');

  assert.throws(() => store.list(), /файл команд повреждён/);
  assert.throws(() => store.save(cmd()), /файл команд повреждён/);
  assert.throws(() => store.remove('x'), /файл команд повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('markRun записывает lastRunAt и возвращает null для неизвестного id', (t) => {
  const { store } = makeStore(t);
  const saved = store.save(cmd());
  const when = new Date('2026-10-27T09:00:00Z');

  const marked = store.markRun(saved.id, when);
  assert.equal(marked.lastRunAt, '2026-10-27T09:00:00.000Z');
  assert.equal(store.get(saved.id).lastRunAt, '2026-10-27T09:00:00.000Z');
  assert.equal(store.markRun('нет-такого', when), null);
});

test('runCommand: T0-шаг выполняется без подтверждения', async (t) => {
  const dir = setup(t);
  const list = spyTool('windows_list', 'T0', { ok: true, summary: 'окон: 2' });
  const approvals = {
    request() { throw new Error('подтверждение не должно запрашиваться'); },
    respond() { return false; },
  };
  const journal = memoryJournal();
  const events = [];

  const result = await runCommand(
    { id: 'c1', name: 'Окна', steps: [{ tool: 'windows_list', args: {} }] },
    {
      tools: registryOf(list), policy: modes, approvals, journal,
      emit: (e) => events.push(e), workspace: dir, mode: 'auto',
      signal: new AbortController().signal,
    },
  );

  assert.deepEqual(result, { ok: true, results: [{ tool: 'windows_list', ok: true, summary: 'окон: 2' }] });
  assert.equal(list.runs, 1);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0].decision, 'allow');
  assert.equal(journal.entries[0].source, 'command');
  assert.equal(journal.entries[0].command, 'c1');
  assert.ok(events.some((e) => e.type === 'tool_start'));
  assert.ok(!events.some((e) => e.type === 'approval_request'));
});

test('runCommand: T1 в режиме ask ждёт подтверждения, reject останавливает команду', async (t) => {
  const dir = setup(t);
  const write = spyTool('file_write', 'T1');
  const list = spyTool('windows_list', 'T0');
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const journal = memoryJournal();
  const events = [];

  const result = await runCommand(
    {
      id: 'c2', name: 'Тест',
      steps: [{ tool: 'file_write', args: { path: '../a.txt' } }, { tool: 'windows_list', args: {} }],
    },
    {
      tools: registryOf(write, list), policy: modes, approvals, journal,
      emit: (e) => {
        events.push(e);
        if (e.type === 'approval_request') approvals.respond(e.id, 'reject');
      },
      workspace: dir, mode: 'auto',
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [{ tool: 'file_write', ok: false, summary: 'отклонено' }]);
  assert.equal(write.runs, 0);
  assert.equal(list.runs, 0);
  assert.equal(journal.entries[0].decision, 'reject');

  const req = events.find((e) => e.type === 'approval_request');
  assert.ok(req);
  assert.equal(req.name, 'file_write');
  assert.equal(req.risk, 'T1');
  assert.equal(req.reason, 'команда «Тест»');
});

test('runCommand: одобрение once выполняет шаг и команда идёт дальше', async (t) => {
  const dir = setup(t);
  const write = spyTool('file_write', 'T1');
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });

  const result = await runCommand(
    { id: 'c3', name: 'Запись', steps: [{ tool: 'file_write', args: { path: 'a.txt' } }] },
    {
      tools: registryOf(write), policy: modes, approvals, journal: memoryJournal(),
      emit: (e) => { if (e.type === 'approval_request') approvals.respond(e.id, 'once'); },
      workspace: dir, mode: 'auto',
    },
  );

  assert.equal(result.ok, true);
  assert.equal(write.runs, 1);
});

test('runCommand: неизвестный инструмент останавливает команду', async (t) => {
  const dir = setup(t);
  const list = spyTool('windows_list', 'T0');
  const journal = memoryJournal();

  const result = await runCommand(
    { id: 'c4', name: 'Битая', steps: [{ tool: 'нет_такого', args: {} }, { tool: 'windows_list', args: {} }] },
    { tools: registryOf(list), policy: modes, approvals: null, journal, emit: () => {}, workspace: dir, mode: 'auto' },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.results, [{ tool: 'нет_такого', ok: false, summary: 'неизвестный инструмент: нет_такого' }]);
  assert.equal(list.runs, 0);
  assert.equal(journal.entries.length, 1);
});

test('runCommand: mission_ и command_ запрещены', async (t) => {
  const dir = setup(t);
  const mission = spyTool('mission_add', 'T0');
  const command = spyTool('command_save', 'T0');
  const journal = memoryJournal();
  const deps = { tools: registryOf(mission, command), policy: modes, approvals: null, journal, emit: () => {}, workspace: dir, mode: 'auto' };

  const first = await runCommand({ id: 'c5', name: 'М', steps: [{ tool: 'mission_add', args: {} }] }, deps);
  const second = await runCommand({ id: 'c6', name: 'К', steps: [{ tool: 'command_save', args: {} }] }, deps);

  assert.deepEqual(first, { ok: false, results: [{ tool: 'mission_add', ok: false, summary: 'нельзя запускать из команды' }] });
  assert.deepEqual(second, { ok: false, results: [{ tool: 'command_save', ok: false, summary: 'нельзя запускать из команды' }] });
  assert.equal(mission.runs, 0);
  assert.equal(command.runs, 0);
  assert.equal(journal.entries[0].decision, 'deny');
});

test('runCommand: ошибка инструмента попадает в результат и останавливает команду', async (t) => {
  const dir = setup(t);
  const broken = {
    def: {
      name: 'windows_list', risk: 'T0', parameters: { type: 'object', properties: {} },
      run: async () => { throw new Error('сломано'); },
    },
  };
  const list = spyTool('system_info', 'T0');

  const result = await runCommand(
    { id: 'c7', name: 'Ошибка', steps: [{ tool: 'windows_list', args: {} }, { tool: 'system_info', args: {} }] },
    { tools: registryOf(broken, list), policy: modes, approvals: null, journal: memoryJournal(), emit: () => {}, workspace: dir, mode: 'auto' },
  );

  assert.deepEqual(result, { ok: false, results: [{ tool: 'windows_list', ok: false, summary: 'ошибка: сломано' }] });
  assert.equal(list.runs, 0);
});

test('runCommand: отменённый сигнал не запускает шаги', async (t) => {
  const dir = setup(t);
  const list = spyTool('windows_list', 'T0');
  const ac = new AbortController();
  ac.abort();

  const result = await runCommand(
    { id: 'c8', name: 'Отмена', steps: [{ tool: 'windows_list', args: {} }] },
    { tools: registryOf(list), policy: modes, approvals: null, journal: memoryJournal(), emit: () => {}, workspace: dir, mode: 'auto', signal: ac.signal },
  );

  assert.equal(result.ok, false);
  assert.equal(list.runs, 0);
});

// ── Схема команды, запись и перенос ────────────────────────────

test('схема: версия, происхождение и дата изменения сохраняются, будущая версия — отказ без записи', (t) => {
  const { store, file } = makeStore(t);
  const saved = store.save(cmd());
  assert.equal(saved.schemaVersion, COMMAND_SCHEMA_VERSION);
  assert.equal(saved.origin, 'manual');
  assert.ok(!Number.isNaN(Date.parse(saved.updatedAt)));
  assert.equal(saved.folder, null);
  assert.deepEqual(saved.collections, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items[0].schemaVersion, COMMAND_SCHEMA_VERSION);

  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.save({ ...saved, schemaVersion: COMMAND_SCHEMA_VERSION + 1 }), /версия схемы команды/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'файл не изменился');
});

test('аргументы шага: лимиты размера, вложенности и типов соблюдаются', (t) => {
  const { store, file } = makeStore(t);
  assert.throws(() => store.save(cmd({ steps: [{ tool: 'workspace_write', args: { text: 'x'.repeat(9000) } }] })), /длиннее 8000 символов/);
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  assert.throws(() => store.save(cmd({ steps: [{ tool: 'ui_keys', args: deep }] })), /вложенность/);
  assert.throws(() => store.save(cmd({ steps: [{ tool: 'ui_keys', args: { keys: () => {} } }] })), /не переносится/);
  assert.equal(fs.existsSync(file), false);
});

test('папка и коллекции: сохраняются, повтор коллекции и длинные имена отклоняются', (t) => {
  const { store } = makeStore(t);
  const saved = store.save(cmd({ folder: '  Утро ', collections: ['Работа', 'рутина'] }));
  assert.equal(saved.folder, 'Утро');
  assert.deepEqual(saved.collections, ['Работа', 'рутина']);
  assert.equal(store.save({ ...saved, folder: null }).folder, null);
  assert.throws(() => store.save({ ...saved, collections: ['Кино', 'кино'] }), /коллекция повторяется/);
  assert.throws(() => store.save({ ...saved, folder: 'ф'.repeat(61) }), /папка длиннее/);
});

test('экспорт: секреты, токены и согласия не выгружаются, время запуска не входит', (t) => {
  const { store } = makeStore(t);
  const saved = store.save(cmd({
    steps: [
      { tool: 'ui_type', args: { window: 'Блокнот', text: 'обычный текст' } },
      { tool: 'workspace_write', args: { path: 'a.txt', apiKey: 'sk-abcdefghijklmnop', token: 'abcdef123456' } },
      { tool: 'url_open', args: { url: 'https://example.com/?token=secret1234' } },
      { tool: 'wait', args: { ms: 10 } },
    ],
    folder: 'Файлы',
    collections: ['Утро'],
  }));
  store.markRun(saved.id, new Date('2026-11-07T00:00:00Z'));
  const pack = exportCommandPack(store.list(), { now: new Date('2026-11-07T10:00:00Z') });
  assert.equal(pack.format, TRANSFER_FORMAT);
  assert.equal(pack.version, TRANSFER_VERSION);
  assert.equal(pack.schemaVersion, COMMAND_SCHEMA_VERSION);
  assert.equal(pack.exportedAt, '2026-11-07T10:00:00.000Z');
  const [exported] = pack.commands;
  const text = JSON.stringify(pack);
  assert.ok(!text.includes('sk-abcdefghijklmnop'), 'ключ не выгружен');
  assert.ok(!text.includes('abcdef123456'), 'токен не выгружен');
  assert.ok(!text.includes('secret1234'), 'токен из адреса не выгружен');
  assert.ok(!text.includes('lastRunAt'), 'время запуска не выгружается');
  assert.ok(!('lastRunAt' in exported));
  assert.ok(!('consents' in exported) && !('approvals' in exported));
  assert.deepEqual(exported.folder, 'Файлы');
  assert.deepEqual(exported.collections, ['Утро']);
  assert.ok(pack.warnings.length >= 2, pack.warnings.join('\n'));
  // Второй шаг остался, но без секретных полей; обычный текст не скрыт.
  assert.deepEqual(exported.steps[1].args, { path: 'a.txt' });
  assert.deepEqual(exported.steps[0].args, { window: 'Блокнот', text: 'обычный текст' });
  assert.equal(exported.steps[3].args.ms, 10);
});

test('импорт: предпросмотр показывает добавится, изменится и без изменений', (t) => {
  const source = makeStore(t);
  const first = source.store.save(cmd({ name: 'Утро', phrases: ['утро'], steps: [{ tool: 'wait', args: { ms: 1 } }] }));
  const changed = source.store.save(cmd({ name: 'Кино', phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 2 } }] }));
  const pack = exportCommandPack(source.store.list());
  const target = makeStore(t);
  // Уже есть та же «Утро» и другая «Кино».
  target.store.save({ ...first, phrases: ['утро'], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  target.store.save({ ...changed, phrases: ['кино'], steps: [{ tool: 'wait', args: { ms: 99 } }] });
  const result = previewCommandImport(JSON.stringify(pack), target.store);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.preview.counts.unchanged, 1);
  assert.equal(result.preview.counts.update, 1);
  const update = result.preview.items.find((item) => item.action === 'update');
  assert.equal(update.name, 'Кино');
  assert.ok(update.changes.some((change) => change.field === 'steps'));
  const empty = previewCommandImport(JSON.stringify(pack), makeStore(t).store);
  assert.equal(empty.preview.counts.add, 2);
});

test('импорт: без подтверждения и при конфликте данные не меняются', (t) => {
  const source = makeStore(t);
  source.store.save(cmd({ name: 'Чужая', phrases: ['запуск'], steps: [{ tool: 'wait', args: { ms: 1 } }] }));
  const text = exportCommandJson(source.store.list());
  const target = makeStore(t);
  target.store.save(cmd({ name: 'Своя', phrases: ['запуск'], steps: [{ tool: 'wait', args: { ms: 5 } }] }));
  const before = fs.readFileSync(target.file, 'utf8');

  const notConfirmed = awaitOrSync(() => applyCommandImport(text, target.store));
  assert.equal(notConfirmed.ok, false);
  assert.match(notConfirmed.error, /подтвержд/);
  assert.equal(fs.readFileSync(target.file, 'utf8'), before);

  const preview = previewCommandImport(text, target.store);
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.applicable, false);
  assert.equal(preview.preview.counts.conflict, 1);
  const applied = applyCommandImport(text, target.store, { confirm: true });
  assert.equal(applied.ok, false);
  assert.match(applied.error, /фраза «запуск»/);
  assert.equal(fs.readFileSync(target.file, 'utf8'), before, 'конфликт не меняет файл');
});

test('импорт: повреждённый, чужой, огромный, глубокий и несовместимый файл отвергаются без записи', (t) => {
  const target = makeStore(t);
  target.store.save(cmd({ name: 'Своя', phrases: ['своя'], steps: [{ tool: 'wait', args: { ms: 5 } }] }));
  const before = fs.readFileSync(target.file, 'utf8');
  const check = (text, re) => {
    const result = applyCommandImport(text, target.store, { confirm: true });
    assert.equal(result.ok, false, String(text).slice(0, 80));
    assert.match(result.error, re);
    assert.equal(fs.readFileSync(target.file, 'utf8'), before);
  };
  check('{"команды": [', /не читается как JSON/);
  check(JSON.stringify({ format: 'другое', version: 1, commands: [] }), /не файл команд/);
  check(JSON.stringify({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION + 1, commands: [] }), /версия файла команд/);
  check(JSON.stringify({ format: TRANSFER_FORMAT, version: TRANSFER_VERSION, schemaVersion: COMMAND_SCHEMA_VERSION + 1, commands: [] }), /версия схемы команд/);
  check('x'.repeat(MAX_IMPORT_BYTES + 10), /больше 1024 КБ/);
  const deep = { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, commands: [] };
  let node = deep;
  for (let i = 0; i < MAX_IMPORT_DEPTH + 2; i += 1) { node.extra = {}; node = node.extra; }
  check(JSON.stringify(deep), /вложен глубже/);
});

test('импорт: одна негодная команда отменяет весь импорт (атомарно)', (t) => {
  const target = makeStore(t);
  target.store.save(cmd({ name: 'Своя', phrases: ['своя'], steps: [{ tool: 'wait', args: { ms: 5 } }] }));
  const before = fs.readFileSync(target.file, 'utf8');
  const pack = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commands: [
      { name: 'Годная', phrases: ['годная'], steps: [{ tool: 'wait', args: { ms: 1 } }] },
      { name: 'Опасная', phrases: ['опасная'], steps: [{ tool: 'mail_send', args: {} }] },
    ],
  };
  const result = applyCommandImport(JSON.stringify(pack), target.store, { confirm: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /нельзя сохранить в команде/);
  assert.equal(fs.readFileSync(target.file, 'utf8'), before);
  assert.equal(target.store.list().length, 1);
});

test('импорт: секретные аргументы вырезаются с предупреждением и не попадают в файл', (t) => {
  const target = makeStore(t);
  const pack = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commands: [{
      name: 'Вход',
      phrases: ['вход'],
      steps: [{ tool: 'workspace_write', args: { path: 'a.txt', password: 'hunter2hunter2', text: 'обычное' } }],
    }],
  };
  const result = applyCommandImport(JSON.stringify(pack), target.store, { confirm: true });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.added, 1);
  assert.ok(result.warnings.some((w) => w.includes('секрет')), result.warnings.join('\n'));
  const stored = target.store.findByPhrase('вход');
  assert.deepEqual(stored.steps[0].args, { path: 'a.txt', text: 'обычное' });
  assert.ok(!fs.readFileSync(target.file, 'utf8').includes('hunter2hunter2'));
});

test('экспорт и импорт: полный круг сохраняет шаги, фразы, папку и происхождение', (t) => {
  const source = makeStore(t);
  const saved = source.store.save(cmd({
    name: 'Круг',
    phrases: ['круг'],
    steps: [{ tool: 'app_open', args: { name: 'notepad' } }, { tool: 'wait', args: { ms: 3 } }],
    folder: 'Утро',
    collections: ['Рутина'],
    origin: 'recorded',
    hotkey: 'Ctrl+Alt+Y',
  }));
  const text = exportCommandJson(source.store.list());
  const target = makeStore(t);
  const preview = previewCommandImport(text, target.store);
  assert.equal(preview.preview.counts.add, 1, preview.error);
  const applied = applyCommandImport(text, target.store, { confirm: true });
  assert.equal(applied.ok, true, applied.error);
  const restored = target.store.findByPhrase('круг');
  assert.equal(restored.name, saved.name);
  assert.deepEqual(restored.steps, saved.steps);
  assert.equal(restored.folder, 'Утро');
  assert.deepEqual(restored.collections, ['Рутина']);
  assert.equal(restored.origin, 'recorded');
  assert.equal(restored.hotkey, 'Control+Alt+Y');
  // Повторный импорт того же файла ничего не меняет.
  const again = applyCommandImport(text, target.store, { confirm: true });
  assert.deepEqual(again, { ok: true, added: 0, updated: 0, unchanged: 1, warnings: [] });
});

test('runCommand: выключенная команда не выполняется', async (t) => {
  const dir = setup(t);
  const list = spyTool('windows_list', 'T0');
  const journal = memoryJournal();
  const result = await runCommand(
    { id: 'off', name: 'Выключена', enabled: false, steps: [{ tool: 'windows_list', args: {} }] },
    { tools: registryOf(list), policy: modes, approvals: null, journal, emit: () => {}, workspace: dir, mode: 'auto' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'команда выключена');
  assert.equal(list.runs, 0);
  assert.equal(journal.entries.length, 0);
});

test('журнал команды не содержит секретов аргументов', async (t) => {
  const dir = setup(t);
  const tool = spyTool('workspace_write', 'T0');
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  const result = await runCommand(
    { id: 'secret', name: 'Секрет', steps: [{ tool: 'workspace_write', args: { path: 'a.txt', password: 'hunter2hunter2', token: 'tok_live_123456' } }] },
    { tools: registryOf(tool), policy: modes, approvals: null, journal, emit: () => {}, workspace: dir, mode: 'full', ownerCommand: true },
  );
  assert.equal(result.ok, true, result.results[0] && result.results[0].summary);
  const raw = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  assert.ok(!raw.includes('hunter2hunter2'), raw);
  assert.ok(!raw.includes('tok_live_123456'), raw);
  assert.match(raw, /\[скрыто/);
});

test('parseCommandPack: лимит числа команд и шагов', (t) => {
  const many = { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, schemaVersion: COMMAND_SCHEMA_VERSION, commands: [] };
  for (let i = 0; i < 501; i += 1) {
    many.commands.push({ name: `К${i}`, phrases: [`ф${i}`], steps: [{ tool: 'wait', args: { ms: 1 } }] });
  }
  assert.throws(() => parseCommandPack(JSON.stringify(many)), /больше 500 команд/);
  const manySteps = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    commands: Array.from({ length: 201 }, (_, i) => ({
      name: `С${i}`,
      phrases: [`с${i}`],
      steps: Array.from({ length: MAX_STEPS }, () => ({ tool: 'wait', args: { ms: 1 } })),
    })),
  };
  assert.throws(() => parseCommandPack(JSON.stringify(manySteps)), /больше 4000 шагов/);
});

// ── Причина разрешения: офлайн-ярлык без name/id (дефект D1) ────

async function approvalReasonFor(t, command, toolDef) {
  const dir = setup(t);
  const approvals = new ApprovalBroker({ timeoutMs: 1000 });
  const events = [];
  const result = await runCommand(command, {
    tools: registryOf({ def: toolDef, runs: 0 }),
    policy: modes,
    approvals,
    journal: memoryJournal(),
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_request') approvals.respond(e.id, 'reject');
    },
    workspace: dir,
    mode: 'auto',
  });
  const request = events.find((e) => e.type === 'approval_request');
  return { request, result };
}

test('офлайн-команда без name/id: причина разрешения без «undefined», по названию ярлыка', async (t) => {
  const toolDef = { name: 'app_open', risk: 'T1', parameters: { type: 'object', properties: { name: { type: 'string' } } }, run: async () => ({ ok: true, summary: 'готово' }) };
  const { request, result } = await approvalReasonFor(t, { title: 'открыть калькулятор', steps: [{ tool: 'app_open', args: { name: 'calc' } }] }, toolDef);
  assert.ok(request, 'разрешение должно спрашиваться');
  assert.equal(request.reason, 'команда «открыть калькулятор»');
  assert.ok(!request.reason.includes('undefined'));
  assert.equal(result.ok, false, 'отказ не выполняет действие');
});

test('команда без name и title: причина по названию инструмента, не пустая', async (t) => {
  const toolDef = { name: 'app_open', risk: 'T1', parameters: { type: 'object', properties: { name: { type: 'string' } } }, run: async () => ({ ok: true, summary: 'готово' }) };
  const { request } = await approvalReasonFor(t, { steps: [{ tool: 'app_open', args: { name: 'calc' } }] }, toolDef);
  assert.ok(request);
  assert.equal(request.reason, 'команда «app_open»');
  assert.ok(!request.reason.includes('undefined'));
});

test('секрет в названии команды не попадает в причину разрешения', async (t) => {
  const toolDef = { name: 'app_open', risk: 'T1', parameters: { type: 'object', properties: { name: { type: 'string' } } }, run: async () => ({ ok: true, summary: 'готово' }) };
  const { request } = await approvalReasonFor(t, { name: 'пароль: hunter2', steps: [{ tool: 'app_open', args: { name: 'calc' } }] }, toolDef);
  assert.ok(request);
  assert.ok(!request.reason.includes('hunter2'), request.reason);
  assert.ok(!request.reason.includes('undefined'));
});

// ── Запись действий: явный старт/стоп, без секретов и автозапуска ─

test('запись: шаг без start отклоняется, stop без записи тоже', () => {
  const recorder = new CommandRecorder();
  assert.equal(recorder.capture({ tool: 'app_open', args: { name: 'calc' } }).ok, false);
  assert.match(recorder.capture({ tool: 'app_open', args: {} }).error, /start/);
  assert.equal(recorder.stop().ok, false);
  assert.equal(recorder.status().recording, false);
});

test('запись: старт, шаги, стоп и черновик без сохранения и запуска', (t) => {
  const recorder = new CommandRecorder();
  assert.equal(recorder.start().ok, true);
  assert.equal(recorder.capture({ tool: 'app_open', args: { name: 'notepad' } }).ok, true);
  assert.equal(recorder.capture({ tool: 'wait', args: { ms: 100 } }).ok, true);
  const stopped = recorder.stop();
  assert.equal(stopped.ok, true);
  const draft = stopped.draft;
  assert.equal(draft.origin, 'recorded');
  assert.equal(draft.saved, false);
  assert.deepEqual(draft.steps.map((s) => s.tool), ['app_open', 'wait']);
  assert.deepEqual(recorder.overview({ titleOf: (tool) => ({ app_open: 'Запуск программы', wait: 'Подождать' })[tool] }), [
    '1. Запуск программы: {"name":"notepad"}',
    '2. Подождать: {"ms":100}',
  ]);
  // Черновик сохраняется только явным вызовом store.save, и не запускается.
  const { store, file } = makeStore(t);
  assert.equal(fs.existsSync(file), false, 'запись сама ничего не сохраняет');
  const saved = store.save(recorder.toCommand({ name: 'Блокнот', phrases: ['блокнот'] }));
  assert.equal(saved.origin, 'recorded');
  assert.deepEqual(saved.steps.map((s) => s.tool), ['app_open', 'wait']);
});

test('запись: опасные и фоновые шаги отклоняются, набранный текст и секреты не пишутся', () => {
  const recorder = new CommandRecorder();
  recorder.start();
  assert.match(recorder.capture({ tool: 'shell_run', args: { command: 'dir' } }).error, /нельзя/);
  assert.match(recorder.capture({ tool: 'mission_add', args: {} }).error, /нельзя/);
  const typed = recorder.capture({ tool: 'ui_type', args: { window: 'Блокнот', text: 'пароль hunter2', token: 'tok_live_123456' } });
  assert.equal(typed.ok, true);
  const recorded = recorder.status();
  assert.deepEqual(recorded.warnings.filter((w) => w.includes('текст')).length, 1, recorded.warnings.join('\n'));
  const stopped = recorder.stop();
  const step = stopped.draft.steps.find((s) => s.tool === 'ui_type');
  assert.deepEqual(step.args, { window: 'Блокнот' });
  assert.ok(!JSON.stringify(stopped.draft).includes('hunter2'));
  assert.ok(!JSON.stringify(stopped.draft).includes('tok_live_123456'));
});

test('запись: предупреждает о координатах и активном окне', () => {
  const recorder = new CommandRecorder();
  recorder.start();
  recorder.capture({ tool: 'desktop_click', args: { x: 10, y: 20 } });
  recorder.capture({ tool: 'ui_click', args: { window: 'Калькулятор', name: '5' } });
  const warnings = recorder.status().warnings;
  assert.ok(warnings.some((w) => w.includes('координат')), warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes('активного окна')), warnings.join('\n'));
});

test('запись: лимит шагов соблюдается', () => {
  const recorder = new CommandRecorder({ maxSteps: 2 });
  recorder.start();
  assert.equal(recorder.capture({ tool: 'wait', args: { ms: 1 } }).ok, true);
  assert.equal(recorder.capture({ tool: 'wait', args: { ms: 2 } }).ok, true);
  const third = recorder.capture({ tool: 'wait', args: { ms: 3 } });
  assert.equal(third.ok, false);
  assert.match(third.error, /не больше 2/);
  assert.equal(recorder.stop().draft.steps.length, 2);
});



// Синхронный помощник: applyCommandImport синхронный, awaitOrSync делает тест единообразным.
function awaitOrSync(fn) {
  return fn();
}

