'use strict';

// Инструменты кода: code_read (T0), code_write (T1, только новый файл), code_edit (T1, ровно одно вхождение).
// Понятные summary, лимиты размера, отказ для бинарных, жёстких ссылок и путей наружу. В конце — через исполнитель
// задач: подтверждения на каждый вызов нет — разрешение даёт мандат (только его инструменты и папки); записи журнала.
// Относительные пути — от корня песочницы (base), как у workspace_* и проверок шагов.
// Запуск тестов (code_test) — в tests/code-test.test.js. Временные папки — в os.tmpdir().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { codeTools, EXEC_BLOCKER, MAX_READ_BYTES, MAX_WRITE_BYTES } = require('../src/tools/code');
const model = require('../src/tasks/model');
const { TaskQueue } = require('../src/tasks/queue');
const { createMandate } = require('../src/tasks/mandate');
const { createExecutor } = require('../src/tasks/executor');
const { StopSwitch } = require('../src/control/stop');
const { ApprovalBroker } = require('../src/policy/approvals');
const { WorkspaceIndex } = require('../src/rag/index');

const NOW = Date.UTC(2026, 9, 31, 12, 0);

function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-tools-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.js'), 'секрет');
  const [read, write, edit] = codeTools({ roots: [root], base: root });
  const file = (rel) => path.join(root, ...rel.split('/'));
  return { base, root, outside, read, write, edit, file };
}

test('описания: code_read — T0, code_write и code_edit — T1 без вопроса на каждый вызов (разрешение — мандат); в описании сказано, что сами они код не запускают', () => {
  const [read, write, edit] = codeTools({ roots: [os.tmpdir()], base: os.tmpdir() });
  assert.deepEqual([read.name, write.name, edit.name], ['code_read', 'code_write', 'code_edit']);
  assert.equal(read.risk, 'T0');
  assert.notEqual(read.requiresApproval, true);
  for (const tool of [write, edit]) {
    assert.equal(tool.risk, 'T1');
    assert.equal(tool.requiresApproval, false);
    assert.match(tool.description, /Разрешение — мандат задачи, подтверждённый владельцем: только если инструмент есть в мандате и только в его папках/);
    assert.doesNotMatch(tool.description, /Каждый вызов — с подтверждения/);
  }
  for (const tool of [read, write, edit]) {
    assert.ok(tool.description.includes(EXEC_BLOCKER), tool.name);
    assert.equal(typeof tool.run, 'function');
  }
  assert.match(EXEC_BLOCKER, /Этот инструмент код не запускает; проверить его можно только тестами через code_test/);
  // База относительных путей обязательна: без неё код считал бы пути от папки мандата, а проверки — от песочницы.
  assert.throws(() => codeTools({ roots: [os.tmpdir()] }), /нужна база относительных путей \(base\)/);
  assert.throws(() => codeTools({ roots: [os.tmpdir()], base: 'relative' }), /нужна база относительных путей/);
});

test('code_read: summary с размером и строками; не найден, папка, расширение, путь наружу — понятные отказы', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.file('src/a.js'), 'const a = 1;\nconst b = 2;\n');
  const r = await h.read.run({ path: ' src/a.js ' });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'src/a.js: прочитано 26 байт, строк 2');
  assert.equal(r.data.text, 'const a = 1;\nconst b = 2;\n');
  assert.equal(r.data.truncated, false);
  assert.equal(r.data.size, 26);

  assert.deepEqual(await h.read.run({ path: 'src/none.js' }), { ok: false, summary: 'файл «src/none.js» не найден', data: {} });
  fs.mkdirSync(h.file('src/dir.js'));
  assert.equal((await h.read.run({ path: 'src/dir.js' })).summary, 'src/dir.js: это не файл');
  assert.match((await h.read.run({ path: 'src/a.exe' })).summary, /^отказ: расширение «\.exe» не разрешено/);
  assert.match((await h.read.run({ path: '../outside/secret.js' })).summary, /^отказ: путь .* вне разрешённых папок/);
  assert.match((await h.read.run({ path: path.join(h.outside, 'secret.js') })).summary, /вне разрешённых папок/);
  assert.match((await h.read.run({})).summary, /отказ: путь должен быть строкой/);
});

test('code_read: больше 20 КБ — обрезка с пометкой; бинарный (NUL в первых 8 КБ) — отказ', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.file('src/big.txt'), 'я'.repeat(30 * 1024)); // 60 КБ, обрезка посреди двухбайтового символа
  const big = await h.read.run({ path: 'src/big.txt' });
  assert.equal(big.ok, true);
  assert.equal(big.data.truncated, true);
  assert.equal(big.summary, 'src/big.txt: показаны первые 20 КБ из 60 КБ (обрезано)');
  assert.ok(Buffer.byteLength(big.data.text) <= MAX_READ_BYTES);
  assert.equal(big.data.text.includes('�'), false, 'разорванный символ в конце убран');

  fs.writeFileSync(h.file('src/bin.js'), Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')]));
  const bin = await h.read.run({ path: 'src/bin.js' });
  assert.deepEqual([bin.ok, bin.summary], [false, 'src/bin.js: бинарный файл (NUL в первых 8 КБ), не читаю']);
});

test('code_write: создаёт новый файл и родительские папки; существующий не перезаписывает', async (t) => {
  const h = setup(t);
  const r = await h.write.run({ path: '  src/lib/deep/util.js ', content: 'export const x = 1;\n' });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'создан src/lib/deep/util.js: 20 байт, строк 1');
  assert.deepEqual([r.data.path, r.data.bytes, r.data.created], ['src/lib/deep/util.js', 20, true]);
  assert.equal(fs.readFileSync(h.file('src/lib/deep/util.js'), 'utf8'), 'export const x = 1;\n');

  const again = await h.write.run({ path: 'src/lib/deep/util.js', content: 'затёрто' });
  assert.deepEqual([again.ok, again.summary], [false, 'файл «src/lib/deep/util.js» уже есть: не перезаписываю, меняйте его через code_edit']);
  assert.equal(fs.readFileSync(h.file('src/lib/deep/util.js'), 'utf8'), 'export const x = 1;\n', 'файл не тронут');

  const empty = await h.write.run({ path: 'src/__init__.py', content: '' });
  assert.equal(empty.ok, true, 'пустой файл создать можно');
  assert.equal(empty.summary, 'создан src/__init__.py: 0 байт, строк 0');
});

test('code_write: больше 200 КБ, NUL, не строка, наружу (в том числе в несуществующую папку) — отказ, ничего не создано', async (t) => {
  const h = setup(t);
  const tooBig = await h.write.run({ path: 'src/big.js', content: 'a'.repeat(MAX_WRITE_BYTES + 1) });
  assert.deepEqual([tooBig.ok, tooBig.summary], [false, 'содержимое 200 КБ: больше 200 КБ не пишу']);
  const exact = await h.write.run({ path: 'src/exact.js', content: 'a'.repeat(MAX_WRITE_BYTES) });
  assert.equal(exact.ok, true, 'ровно 200 КБ — можно');
  const nul = await h.write.run({ path: 'src/nul.js', content: 'a\0b' });
  assert.deepEqual([nul.ok, nul.summary], [false, 'содержимое с NUL — бинарные данные не пишу']);
  assert.equal((await h.write.run({ path: 'src/x.js', content: 42 })).summary, 'содержимое должно быть строкой');
  const out = await h.write.run({ path: '../outside/newdir/evil.js', content: 'x' });
  assert.equal(out.ok, false);
  assert.match(out.summary, /вне разрешённых папок/);
  assert.equal(fs.existsSync(path.join(h.outside, 'newdir')), false);
  assert.equal(fs.existsSync(h.file('src/big.js')), false);
  assert.equal(fs.existsSync(h.file('src/nul.js')), false);
});

test('code_write и code_edit через junction наружу — отказ, снаружи ничего не изменено', async (t) => {
  const h = setup(t);
  try {
    fs.symlinkSync(h.outside, path.join(h.root, 'src', 'jn'), 'junction');
  } catch (err) {
    t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
    return;
  }
  const w = await h.write.run({ path: 'src/jn/planted.js', content: 'x' });
  assert.equal(w.ok, false);
  assert.match(w.summary, /за пределы разрешённых папок/);
  const e = await h.edit.run({ path: 'src/jn/secret.js', old_string: 'секрет', new_string: 'взлом' });
  assert.equal(e.ok, false);
  assert.match(e.summary, /за пределы разрешённых папок/);
  const r = await h.read.run({ path: 'src/jn/secret.js' });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(h.outside, 'planted.js')), false);
  assert.equal(fs.readFileSync(path.join(h.outside, 'secret.js'), 'utf8'), 'секрет');
});

test('жёсткая ссылка на файл снаружи: чтение и правка — отказ', async (t) => {
  const h = setup(t);
  try {
    fs.linkSync(path.join(h.outside, 'secret.js'), h.file('src/hl.js'));
  } catch (err) {
    t.skip(`ОС не дала создать жёсткую ссылку: ${err.code || err.message}`);
    return;
  }
  assert.match((await h.read.run({ path: 'src/hl.js' })).summary, /несколько жёстких ссылок/);
  assert.match((await h.edit.run({ path: 'src/hl.js', old_string: 'секрет', new_string: 'x' })).summary, /несколько жёстких ссылок/);
  assert.equal(fs.readFileSync(path.join(h.outside, 'secret.js'), 'utf8'), 'секрет');
});

test('code_edit: ровно одно вхождение — одна замена с понятным summary; временных файлов не остаётся', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.file('src/a.js'), 'function f() {\n  return 1;\n}\n');
  const r = await h.edit.run({ path: 'src/a.js', old_string: 'return 1;', new_string: 'return 2;' });
  assert.equal(r.ok, true);
  assert.equal(r.summary, 'изменён src/a.js: 1 замена (строка 2), было 29 байт, стало 29 байт');
  assert.deepEqual([r.data.replacements, r.data.line, r.data.bytesBefore, r.data.bytesAfter], [1, 2, 29, 29]);
  assert.equal(fs.readFileSync(h.file('src/a.js'), 'utf8'), 'function f() {\n  return 2;\n}\n');
  assert.deepEqual(fs.readdirSync(h.file('src')), ['a.js'], 'временных файлов нет');

  // «$&» и «$1» — буквально: склейка, а не String.replace.
  const s = await h.edit.run({ path: 'src/a.js', old_string: 'return 2;', new_string: 'return "$&$1";' });
  assert.equal(s.ok, true);
  assert.equal(fs.readFileSync(h.file('src/a.js'), 'utf8'), 'function f() {\n  return "$&$1";\n}\n');
  // Пустой new_string убирает фрагмент.
  assert.equal((await h.edit.run({ path: 'src/a.js', old_string: '  return "$&$1";\n', new_string: '' })).ok, true);
  assert.equal(fs.readFileSync(h.file('src/a.js'), 'utf8'), 'function f() {\n}\n');
});

test('code_edit: фрагмент не найден или встречается несколько раз (и перекрываясь) — отказ, файл не изменён', async (t) => {
  const h = setup(t);
  const text = 'let x = 1;\nlet x = 1;\nconst aaa = 0;\n';
  fs.writeFileSync(h.file('src/b.js'), text);
  const twice = await h.edit.run({ path: 'src/b.js', old_string: 'let x = 1;', new_string: 'let x = 2;' });
  assert.equal(twice.ok, false);
  assert.match(twice.summary, /встречается больше одного раза; нужно ровно одно вхождение/);
  const overlap = await h.edit.run({ path: 'src/b.js', old_string: 'aa', new_string: 'b' });
  assert.equal(overlap.ok, false, '«aa» в «aaa» — два перекрывающихся вхождения');
  const none = await h.edit.run({ path: 'src/b.js', old_string: 'нет такого', new_string: 'x' });
  assert.equal(none.summary, 'src/b.js: фрагмент old_string не найден; файл не изменён');
  assert.equal(fs.readFileSync(h.file('src/b.js'), 'utf8'), text);

  fs.writeFileSync(h.file('src/crlf.js'), 'a\r\nb\r\n');
  assert.match((await h.edit.run({ path: 'src/crlf.js', old_string: 'a\nb', new_string: 'c' })).summary, /CRLF/);
});

test('code_edit: неверные аргументы, нет файла, бинарный, не UTF-8, больше 200 КБ — понятные отказы', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.file('src/a.js'), 'abc');
  assert.equal((await h.edit.run({ path: 'src/a.js', old_string: '', new_string: 'x' })).summary, 'old_string — непустая строка');
  assert.equal((await h.edit.run({ path: 'src/a.js', old_string: 'a' })).summary, 'new_string должен быть строкой');
  assert.equal((await h.edit.run({ path: 'src/a.js', old_string: 'a', new_string: 'a' })).summary, 'old_string и new_string совпадают: менять нечего');
  assert.equal((await h.edit.run({ path: 'src/a.js', old_string: 'a', new_string: '\0' })).summary, 'new_string с NUL — бинарные данные не пишу');
  assert.equal((await h.edit.run({ path: 'src/new.js', old_string: 'a', new_string: 'b' })).summary, 'файл «src/new.js» не найден: новый файл создаётся через code_write');
  fs.writeFileSync(h.file('src/bin.js'), Buffer.from([0x61, 0, 0x62]));
  assert.match((await h.edit.run({ path: 'src/bin.js', old_string: 'a', new_string: 'b' })).summary, /бинарный файл/);
  fs.writeFileSync(h.file('src/latin.txt'), Buffer.from([0x63, 0xe9, 0x74])); // «cét» в latin1
  assert.match((await h.edit.run({ path: 'src/latin.txt', old_string: 'c', new_string: 'd' })).summary, /не в UTF-8/);
  fs.writeFileSync(h.file('src/huge.js'), 'x'.repeat(MAX_WRITE_BYTES + 10));
  assert.match((await h.edit.run({ path: 'src/huge.js', old_string: 'x', new_string: 'y' })).summary, /правлю только до 200 КБ/);
  fs.writeFileSync(h.file('src/edge.js'), `${'x'.repeat(MAX_WRITE_BYTES - 5)}MARK`);
  assert.match((await h.edit.run({ path: 'src/edge.js', old_string: 'MARK', new_string: 'y'.repeat(100) })).summary, /после правки .*больше 200 КБ не пишу/);
  assert.equal(fs.readFileSync(h.file('src/a.js'), 'utf8'), 'abc');
});

test('roots функцией: папки берутся по контексту вызова (папки кода мандата задачи)', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.file('src/a.js'), 'a');
  const byTask = { t1: [path.join(h.root, 'src')], t2: [h.outside] };
  const [read] = codeTools({ roots: (ctx) => byTask[ctx.taskId], base: h.root });
  // Путь — от корня песочницы (base), папка задачи — ограничение.
  const own = await read.run({ path: 'src/a.js' }, { taskId: 't1' });
  assert.deepEqual([own.ok, own.data.path], [true, 'src/a.js']);
  assert.match((await read.run({ path: 'a.js' }, { taskId: 't1' })).summary, /вне разрешённых папок/, 'от базы, а не от папки задачи');
  // Абсолютный путь — только внутри папки задачи; показывается от папки, раз файл вне базы.
  const abs = await read.run({ path: path.join(h.outside, 'secret.js') }, { taskId: 't2' });
  assert.deepEqual([abs.ok, abs.data.path], [true, 'secret.js']);
  assert.match((await read.run({ path: 'secret.js' }, { taskId: 't2' })).summary, /вне разрешённых папок/);
  assert.match((await read.run({ path: 'a.js' }, { taskId: 'нет' })).summary, /нет разрешённых папок/);
  // denyDirs закрывает служебную папку внутри разрешённой.
  const [read2] = codeTools({ roots: [h.root], base: h.root, denyDirs: [path.join(h.root, 'src')] });
  assert.match((await read2.run({ path: 'src/a.js' })).summary, /служебной папке/);
});

// ---- Через исполнитель задач: мандат (вопроса на каждый вызов нет), отказы мандата, журнал.

function scripted(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (i >= script.length) throw new Error('сценарий модели исчерпан');
      const next = script[i];
      i += 1;
      const toolCalls = (next.toolCalls || []).map((c, k) => {
        const args = c.name === 'task_plan_submit' && !c.args.criteria
          ? { ...c.args, criteria: [{ requirement: 'Поправить исходник', text: 'итог по словам модели', manual: { kind: 'model_only', reason: 'проверки в сценарии нет' } }] }
          : c.args;
        return { id: `call${calls.length}_${k}`, name: c.name, args, argsError: null };
      });
      return { content: '', reasoningContent: null, toolCalls, stats: { promptTokens: 10, completionTokens: 5 } };
    },
  };
}

const call = (name, args) => ({ toolCalls: [{ name, args }] });

test('исполнитель: code_read, code_write и code_edit в папке мандата — без вопроса владельцу; путь наружу — отказ мандата без вопроса; всё в журнале', async (t) => {
  const h = setup(t);
  fs.writeFileSync(h.file('src/a.js'), 'const v = 1;\n');
  const queue = new TaskQueue({ now: () => NOW });
  const index = new WorkspaceIndex(h.root);
  const tools = codeTools({ roots: (ctx) => (queue.get(ctx.taskId) || {}).mandate.folders, base: h.root });
  const runs = [];
  const runTool = async (name, args, ctx) => {
    runs.push(name);
    const tool = tools.find((x) => x.name === name);
    return tool ? tool.run(args, ctx) : { ok: false, summary: `нет инструмента ${name}` };
  };
  const brain = scripted([
    call('task_plan_submit', { steps: [{ title: 'Поправить исходник' }] }),
    call('code_read', { path: 'src/a.js' }),
    call('code_read', { path: path.join(h.outside, 'secret.js') }),
    call('code_write', { path: 'src/b.js', content: 'const w = 2;\n' }),
    call('code_edit', { path: 'src/a.js', old_string: 'v = 1', new_string: 'v = 3' }),
    call('step_done', { summary: 'исходники поправлены' }),
  ]);
  const approvals = new ApprovalBroker();
  const journal = [];
  const executor = createExecutor({
    queue,
    saveTasks: () => {},
    brain,
    runTool,
    toolSpecs: tools,
    approvals,
    stop: new StopSwitch(),
    journal: { append: (e) => journal.push(e) },
    resolve: (rel) => index.resolveInside(rel),
    emit: () => {},
    costOf: () => null,
    now: () => NOW,
    sandboxReportsDir: 'reports',
  });
  const m = createMandate({ goal: 'Поправить исходник', tools: ['code_read', 'code_write', 'code_edit'], folders: [h.root], sandboxRoot: h.root, now: NOW });
  m.approvedBy = 'владелец';
  queue.add(model.createTask({ id: 'c1', title: 'Код', goal: 'Поправить исходник', now: NOW, mandate: m }));
  const asked = [];
  const request = approvals.request.bind(approvals);
  approvals.request = (payload) => { asked.push(payload.name); return request(payload); };
  await executor.submit('c1');
  assert.deepEqual(asked, [], 'мандат подтверждён: на code_write и code_edit владельца не спрашивают');
  assert.deepEqual(approvals.list(), []);

  assert.equal(fs.readFileSync(h.file('src/b.js'), 'utf8'), 'const w = 2;\n');
  assert.equal(fs.readFileSync(h.file('src/a.js'), 'utf8'), 'const v = 3;\n');
  assert.deepEqual(runs, ['code_read', 'code_write', 'code_edit'], 'путь наружу до инструмента не дошёл');
  const decisions = (name) => journal.filter((e) => e.tool === name).map((e) => e.decision);
  assert.deepEqual(decisions('code_read'), ['allow', 'deny']);
  assert.deepEqual(decisions('code_write'), ['allow']);
  assert.deepEqual(decisions('code_edit'), ['allow']);
  const denied = journal.find((e) => e.tool === 'code_read' && e.decision === 'deny');
  assert.match(denied.summary, /^отказ: путь .* вне разрешённых папок/);
  const done = journal.filter((e) => e.decision === 'allow');
  assert.deepEqual(done.map((e) => e.summary), [
    'src/a.js: прочитано 13 байт, строк 1',
    'создан src/b.js: 13 байт, строк 1',
    'изменён src/a.js: 1 замена (строка 1), было 13 байт, стало 13 байт',
  ]);
  assert.ok(journal.every((e) => e.source === 'task' && e.taskId === 'c1'));
});
