'use strict';

// «Интеллект проектов»: разбор папки проекта без запуска, подсказка команд и проверяемый запуск
// только найденной команды — без выхода за рабочую папку.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { WorkspaceIndex } = require('../src/rag/index');
const { projectTools } = require('../src/tools/project');

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-project-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'ws');
  fs.mkdirSync(root, { recursive: true });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  };
  const tools = projectTools(new WorkspaceIndex(root), options);
  return {
    root,
    write,
    tools,
    tool: tools.find((item) => item.name === 'project_brief'),
    diagnostics: tools.find((item) => item.name === 'project_diagnostics'),
    commands: tools.find((item) => item.name === 'project_commands'),
    run: tools.find((item) => item.name === 'project_run'),
  };
}

// Подменный запуск: запоминает запросы и отвечает заданным результатом (или бросает ошибку).
// Настоящие сборки в тестах не запускаются: это отдельная проверка, а не часть юнит-теста.
function recordingRunner(reply) {
  const calls = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return typeof reply === 'function' ? reply(request) : reply;
    },
  };
}

test('разбор журнала находит ошибки с номерами строк и не утверждает, что сборка запущена', async (t) => {
  const { write, diagnostics } = setup(t);
  write('proj/build.log', 'начало сборки\nsrc/app.ts:12:3 - error TS123: ошибка типа\nwarning: проверка\nFAIL tests/app.test.js\n');
  const result = await diagnostics.run({ path: 'proj/build.log' });
  assert.equal(result.ok, true);
  assert.equal(result.data.diagnostics.length, 2);
  assert.equal(result.data.diagnostics[0].line, 2);
  assert.match(result.data.diagnostics[0].text, /src\/app.ts:12:3/);
  assert.match(result.data.diagnostics[1].text, /FAIL/);
  assert.match(result.data.note, /не запускал/);
});

test('разбирает вывод настоящего упавшего теста Node', async (t) => {
  const { root, write, diagnostics } = setup(t);
  write('proj/fail.test.js', "const { test } = require('node:test'); test('probe', () => { throw new Error('sample failure'); });\n");
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT; // Иначе Node считает вложенный запуск рекурсией и пропускает тест.
  const child = spawnSync(process.execPath, ['--test', 'fail.test.js'], { cwd: path.join(root, 'proj'), encoding: 'utf8', env: childEnv });
  assert.notEqual(child.status, 0, child.stderr);
  write('proj/build.log', `${child.stdout}\n${child.stderr}`);
  const result = await diagnostics.run({ path: 'proj/build.log' });
  assert.equal(result.ok, true);
  assert.ok(result.data.diagnostics.some((line) => /fail|error|not ok/i.test(line.text)));
});

test('журнал без распознанных ошибок не подтверждает успешность сборки', async (t) => {
  const { write, diagnostics } = setup(t);
  write('proj/build.log', 'сборка началась\n0 errors\n');
  const result = await diagnostics.run({ path: 'proj/build.log' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.diagnostics, []);
  assert.match(result.summary, /не подтверждает/);
});

test('длинный журнал читается с конца, секретные строки не передаются, номера не выдумываются', async (t) => {
  const { write, diagnostics } = setup(t);
  write('proj/build.log', 'обычная строка\n'.repeat(30000) + 'ERROR password=abcd1234\nERROR visible failure\n');
  const result = await diagnostics.run({ path: 'proj/build.log' });
  assert.equal(result.ok, true);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.secretLines, 1);
  assert.equal(result.data.diagnostics[0].line, null);
  assert.doesNotMatch(JSON.stringify(result), /abcd1234/);
  assert.match(result.data.diagnostics[0].text, /visible failure/);
});

test('разбор журнала ограничен рабочей папкой и обычными текстовыми файлами', async (t) => {
  const { write, diagnostics } = setup(t);
  write('proj/.env', 'error пароль');
  write('proj/build.bin', 'error данные');
  for (const file of ['../elsewhere.log', 'proj/.env', 'proj/build.bin', '']) {
    assert.equal((await diagnostics.run({ path: file })).ok, false, file);
  }
});

test('project_brief не читает package.json через ссылку на чужой файл', async (t) => {
  const { root, write, tool } = setup(t);
  write('proj/readme.txt', 'описание');
  const outside = path.join(path.dirname(root), 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ scripts: { test: 'PRIVATE_MARKER' } }));
  try { fs.symlinkSync(outside, path.join(root, 'proj', 'package.json'), 'file'); }
  catch { return t.skip('создание файловой ссылки недоступно'); }
  const result = await tool.run({ path: 'proj' });
  assert.equal(result.ok, true);
  assert.equal(result.data.tests, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MARKER/);
});

test('project_brief: имя, файлы, типы, папки и подсказка про тесты', async (t) => {
  const { write, tool } = setup(t);
  write('proj/package.json', JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }));
  write('proj/README.md', '# Демо\n');
  write('proj/src/index.js', 'module.exports = 1;\n');
  write('proj/src/util.js', 'module.exports = 2;\n');
  write('proj/docs/guide.md', '# Как пользоваться\n'.repeat(20));
  write('proj/node_modules/x/index.js', 'мусор не считаем');
  write('proj/.git/config', 'служебное не считаем');

  const res = await tool.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.equal(res.data.name, 'proj');
  assert.equal(res.data.files, 5, 'node_modules и точечные папки не считаются');
  assert.deepEqual(res.data.dirs, ['docs', 'src']);
  assert.equal(res.data.tests, 'npm test');
  assert.equal(res.data.readme, true);
  assert.equal(res.data.docs, true);
  assert.equal(res.data.truncated, false);
  assert.match(res.summary, /«proj»: файлов 5/);
  assert.match(res.summary, /тесты: npm test/);
  assert.match(res.summary, /README: есть/);
  // Самые частые типы идут первыми: двух .js больше, чем остальных.
  assert.equal(res.data.ext[0][0], '.js');
  assert.equal(res.data.ext[0][1], 2);
});

test('project_brief: за последнюю неделю — только свежие файлы', async (t) => {
  const { root, write, tool } = setup(t);
  write('proj/old.js', 'старое');
  write('proj/new.js', 'новое');
  const old = path.join(root, 'proj', 'old.js');
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, monthAgo, monthAgo);

  const res = await tool.run({ path: 'proj' });
  assert.equal(res.ok, true);
  const recent = res.data.recent.map((f) => f.path);
  assert.ok(recent.includes('new.js'), 'свежий файл в списке изменений');
  assert.equal(recent.includes('old.js'), false, 'месячной давности файл не выдаётся за свежий');
});

test('project_brief: без пути разбирает корень рабочей папки', async (t) => {
  const { write, tool } = setup(t);
  write('notes.md', 'заметки');
  write('Cargo.toml', '[package]\nname = "demo"\n');
  const res = await tool.run({});
  assert.equal(res.ok, true);
  assert.equal(res.data.tests, 'cargo test');
  assert.ok(res.data.recent.some((f) => f.path === 'notes.md'));
  assert.match(res.summary, /README: нет/);
});

test('project_brief: чужая папка и несуществующая папка отклоняются', async (t) => {
  const { tool } = setup(t);
  const outside = await tool.run({ path: '../вне' });
  assert.equal(outside.ok, false, 'выход за рабочую папку запрещён');
  const missing = await tool.run({ path: 'нет-такой' });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /нет/);
});

test('project_brief: битый package.json не ломает разбор', async (t) => {
  const { write, tool } = setup(t);
  write('proj/package.json', '{ это не json');
  write('proj/a.md', 'текст');
  const res = await tool.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.equal(res.data.tests, null, 'по битому файлу подсказки нет');
  assert.equal(res.data.files, 2);
});

test('project_brief: ссылка на папку документации не считается документацией проекта', async (t) => {
  const { root, write, tool } = setup(t);
  write('proj/a.md', 'текст');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-docs-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try {
    fs.symlinkSync(outside, path.join(root, 'proj', 'docs'), 'junction');
  } catch {
    return t.skip('junction на этой машине не создаётся');
  }
  const res = await tool.run({ path: 'proj' });
  assert.equal(res.ok, true, 'ссылка не ломает разбор');
  assert.equal(res.data.docs, false, 'документацией считается только настоящая папка');
});

// ---- project_commands: подсказка по файлам проекта, без запуска.

test('project_commands: package.json со скриптами и package-lock.json — команды npm', async (t) => {
  const { write, commands } = setup(t);
  write('proj/package.json', JSON.stringify({
    name: 'demo',
    scripts: {
      test: 'node --test',
      build: 'tsc -p .',
      lint: 'eslint .',
      start: 'node .',
      dev: 'node --watch .',
      install: 'node install.js', // установку не предлагаем
    },
  }));
  write('proj/package-lock.json', '{}');
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.equal(res.data.count, 5, 'только известные скрипты, без install');
  assert.match(res.summary, /по файлам проекта видно 5 команд \(это подсказка, а не запуск\)/);
  const byKind = Object.fromEntries(res.data.commands.map((item) => [item.kind, item]));
  assert.equal(byKind.test.command, 'npm test');
  assert.equal(byKind.build.command, 'npm run build');
  assert.equal(byKind.lint.command, 'npm run lint');
  assert.equal(byKind.start.command, 'npm start');
  assert.equal(byKind.dev.command, 'npm run dev');
  for (const item of res.data.commands) {
    assert.equal(item.source, 'package.json');
    assert.equal(typeof item.id, 'string');
  }
  assert.match(byKind.test.note, /scripts\.test: node --test/);
  assert.doesNotMatch(JSON.stringify(res), /install\.js/, 'скрипт установки не попадает в подсказку');
});

test('project_commands: менеджер пакетов по lock-файлу, только существующие скрипты', async (t) => {
  const { write, commands } = setup(t);
  write('proj/package.json', JSON.stringify({ scripts: { test: 'vitest', dev: 'vite' } }));
  write('proj/pnpm-lock.yaml', 'lockfileVersion: 1\n');
  const pnpm = await commands.run({ path: 'proj' });
  assert.equal(pnpm.ok, true);
  assert.deepEqual(pnpm.data.commands.map((item) => item.command), ['pnpm test', 'pnpm run dev']);
  assert.deepEqual(pnpm.data.commands.map((item) => item.id), ['pnpm:test', 'pnpm:dev']);

  write('proj/yarn.lock', '');
  const yarn = await commands.run({ path: 'proj' });
  assert.deepEqual(yarn.data.commands.map((item) => item.command), ['pnpm test', 'pnpm run dev'], 'первый найденный lock-файл и порядок не меняются');
});

test('project_commands: lock-файл bun даёт bun run для scripts.test', async (t) => {
  const { write, commands } = setup(t);
  write('proj/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  write('proj/bun.lockb', 'binary');
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.commands.map((item) => item.command), ['bun run test']);
});

test('project_commands: Cargo.toml даёт build, test и run', async (t) => {
  const { write, commands } = setup(t);
  write('proj/Cargo.toml', '[package]\nname = "demo"\n');
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.commands.map((item) => item.command), ['cargo build', 'cargo test', 'cargo run']);
  assert.deepEqual(res.data.commands.map((item) => item.kind), ['build', 'test', 'run']);
});

test('project_commands: go.mod даёт сборку, тесты и запуск', async (t) => {
  const { write, commands } = setup(t);
  write('proj/go.mod', 'module demo\n\ngo 1.22\n');
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.commands.map((item) => item.command), ['go build ./...', 'go test ./...', 'go run .']);
});

test('project_commands: цели Makefile build/test/run, без install и присваиваний', async (t) => {
  const { write, commands } = setup(t);
  write('proj/Makefile', [
    'CXX := g++',
    '.PHONY: build test run install',
    'build:',
    '\t$(CXX) -o app main.cpp',
    'test:',
    '\tnode --test',
    'run:',
    '\t./app',
    'install:',
    '\tnpm install',
    '',
  ].join('\n'));
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.commands.map((item) => item.command), ['make build', 'make test', 'make run']);
  assert.equal(res.data.commands.some((item) => /install/.test(item.command)), false);
});

test('project_commands: pytest и tsconfig дают проверку тестов и типов', async (t) => {
  const { write, commands } = setup(t);
  write('proj/pyproject.toml', '[tool.pytest.ini_options]\n');
  write('proj/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.commands.map((item) => item.command), ['pytest', 'npx tsc --noEmit']);
  assert.deepEqual(res.data.commands.map((item) => item.kind), ['test', 'typecheck']);
});

test('project_commands: .NET, gradle и maven по файлам проекта', async (t) => {
  const { write, commands } = setup(t);
  write('proj-dotnet/app.csproj', '<Project />');
  write('proj-dotnet/App.sln', '');
  const dotnet = await commands.run({ path: 'proj-dotnet' });
  assert.deepEqual(dotnet.data.commands.map((item) => item.command), ['dotnet build', 'dotnet test']);
  assert.deepEqual(dotnet.data.commands.map((item) => item.source), ['App.sln', 'App.sln']);

  write('proj-gradle/build.gradle', 'plugins { id "java" }');
  write('proj-gradle/gradlew.bat', '@echo off');
  const gradle = await commands.run({ path: 'proj-gradle' });
  assert.deepEqual(gradle.data.commands.map((item) => item.command), ['./gradlew build', './gradlew test']);
  assert.match(gradle.data.commands[0].note, /gradlew/);

  write('proj-maven/pom.xml', '<project />');
  const maven = await commands.run({ path: 'proj-maven' });
  assert.deepEqual(maven.data.commands.map((item) => item.command), ['mvn test']);
});

test('project_commands ничего не запускает и не читает package.json через ссылку', async (t) => {
  const runner = recordingRunner({ code: 0 });
  const { root, write, commands } = setup(t, { run: runner.run });
  write('proj/readme.txt', 'описание');
  const outside = path.join(path.dirname(root), 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ scripts: { test: 'PRIVATE_MARKER' } }));
  try { fs.symlinkSync(outside, path.join(root, 'proj', 'package.json'), 'file'); }
  catch { return t.skip('создание файловой ссылки недоступно'); }
  const res = await commands.run({ path: 'proj' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.commands, []);
  assert.equal(runner.calls.length, 0, 'project_commands ничего не запускает');
  assert.doesNotMatch(JSON.stringify(res), /PRIVATE_MARKER/);
});

test('project_commands: чужая и несуществующая папки отклоняются', async (t) => {
  const { commands } = setup(t);
  assert.equal((await commands.run({ path: '../вне' })).ok, false);
  assert.equal((await commands.run({ path: 'нет-такой' })).ok, false);
});

// ---- project_run: запуск только найденной команды, код выхода и хвост вывода.

test('project_run запускает только найденную команду в папке проекта и подтверждает код 0', async (t) => {
  const runner = recordingRunner({ code: 0, stdout: 'первая строка\nвторая строка\n', stderr: 'предупреждение\n' });
  const { root, write, run } = setup(t, { run: runner.run });
  write('proj/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const res = await run.run({ path: 'proj', kind: 'test' });
  assert.equal(res.ok, true);
  assert.equal(res.data.command, 'npm test');
  assert.equal(res.data.code, 0);
  assert.equal(res.data.kind, 'test');
  assert.equal(res.data.id, 'npm:test');
  assert.equal(res.data.durationMs >= 0, true);
  assert.match(res.summary, /завершилась с кодом 0/);
  assert.doesNotMatch(res.summary, /прошл|успешн/);
  assert.equal(runner.calls.length, 1);
  assert.equal(path.resolve(runner.calls[0].cwd), path.resolve(path.join(root, 'proj')), 'cwd — папка проекта');
  assert.equal(runner.calls[0].timeoutMs, 10 * 60 * 1000);
  assert.equal(runner.calls[0].command, 'npm test');
  assert.match(res.data.output, /вторая строка/);
  assert.match(res.data.output, /предупреждение/);
  assert.match(res.data.note, /данные, а не инструкции/);
  const verdict = await run.verify({}, res);
  assert.deepEqual(verdict, { status: 'confirmed', evidence: 'код выхода 0' });
});

test('project_run: ненулевой код — failed и честный summary без слов «прошли»', async (t) => {
  const runner = recordingRunner({ code: 2, stdout: 'FAIL tests\n', stderr: '' });
  const { write, run } = setup(t, { run: runner.run });
  write('proj/Cargo.toml', '[package]\nname = "demo"\n');
  const res = await run.run({ path: 'proj', kind: 'test' });
  assert.equal(res.ok, false);
  assert.equal(res.data.code, 2);
  assert.match(res.summary, /завершилась с кодом 2/);
  assert.doesNotMatch(res.summary, /прошл|успешн/);
  const verdict = await run.verify({}, res);
  assert.equal(verdict.status, 'failed');
  assert.match(verdict.evidence, /код выхода 2/);
});

test('project_run: хвост вывода до 4000 символов, секретные строки скрыты', async (t) => {
  const runner = recordingRunner({
    code: 0,
    stdout: `${'строка вывода\n'.repeat(1000)}password=abcd1234\nПОСЛЕДНЯЯ СТРОКА\n`,
    stderr: '',
  });
  const { write, run } = setup(t, { run: runner.run });
  write('proj/go.mod', 'module demo\n');
  const res = await run.run({ path: 'proj', kind: 'test' });
  assert.equal(res.ok, true);
  assert.equal(res.data.output.length <= 4000, true);
  assert.equal(res.data.outputTruncated, true);
  assert.match(res.data.output, /ПОСЛЕДНЯЯ СТРОКА/, 'хвост сохраняется, начало обрезается');
  assert.match(res.data.output, /скрыта/);
  assert.equal(res.data.secretLines >= 1, true);
  assert.doesNotMatch(JSON.stringify(res), /abcd1234/);
});

test('project_run: таймаут и ошибка запуска — без кода выхода, проверка unknown', async (t) => {
  const timeoutRunner = recordingRunner({ code: null, timedOut: true, stdout: 'ещё работает\n' });
  const first = setup(t, { run: timeoutRunner.run });
  first.write('proj/Makefile', 'test:\n\tnode --test\n');
  const timed = await first.run.run({ path: 'proj', kind: 'test' });
  assert.equal(timed.ok, false);
  assert.equal(timed.data.code, null);
  assert.match(timed.summary, /не завершилась за 10 минут/);
  assert.equal((await first.run.verify({}, timed)).status, 'unknown');

  const failing = recordingRunner(() => { throw new Error('нет доступа к оболочке'); });
  const second = setup(t, { run: failing.run });
  second.write('proj/Makefile', 'test:\n\tnode --test\n');
  const errored = await second.run.run({ path: 'proj', kind: 'test' });
  assert.equal(errored.ok, false);
  assert.match(errored.summary, /не удалось запустить/);
  assert.match(errored.summary, /нет доступа к оболочке/);
  assert.equal((await second.run.verify({}, errored)).status, 'unknown');
});

test('project_run отказывает произвольной команде, неизвестному виду и без выбора', async (t) => {
  const runner = recordingRunner({ code: 0 });
  const { write, run } = setup(t, { run: runner.run });
  write('proj/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const arbitrary = await run.run({ path: 'proj', command: 'rm -rf .' });
  assert.equal(arbitrary.ok, false);
  assert.match(arbitrary.summary, /произвольную команду/);
  const unknownKind = await run.run({ path: 'proj', kind: 'install' });
  assert.equal(unknownKind.ok, false);
  assert.match(unknownKind.summary, /не видно/);
  const unknownId = await run.run({ path: 'proj', id: 'npm:publish' });
  assert.equal(unknownId.ok, false);
  const missing = await run.run({ path: 'proj' });
  assert.equal(missing.ok, false);
  assert.equal(runner.calls.length, 0, 'ни одна команда не запущена');
});

test('project_run при нескольких командах одного вида требует id', async (t) => {
  const runner = recordingRunner({ code: 0 });
  const { write, run } = setup(t, { run: runner.run });
  write('proj/package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
  write('proj/Makefile', 'build:\n\ttsc\n');
  const ambiguous = await run.run({ path: 'proj', kind: 'build' });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.summary, /несколько команд/);
  assert.match(ambiguous.summary, /npm:build/);
  assert.match(ambiguous.summary, /make:build/);
  assert.equal(runner.calls.length, 0);
  const byId = await run.run({ path: 'proj', id: 'make:build' });
  assert.equal(byId.ok, true);
  assert.equal(runner.calls[0].command, 'make build');
});

test('project_run: отказ вне рабочей папки и для папки-ссылки', async (t) => {
  const runner = recordingRunner({ code: 0 });
  const { root, write, run } = setup(t, { run: runner.run });
  write('proj/package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
  const outside = await run.run({ path: '../outside', kind: 'test' });
  assert.equal(outside.ok, false, 'выход за рабочую папку запрещён');

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-project-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outsideDir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  let linked = true;
  try { fs.symlinkSync(outsideDir, path.join(root, 'linked'), 'junction'); }
  catch { linked = false; }
  if (linked) {
    const viaLink = await run.run({ path: 'linked', kind: 'test' });
    assert.equal(viaLink.ok, false, 'папка-ссылка не считается проектом внутри рабочей папки');
  }
  assert.equal(runner.calls.length, 0);
});
