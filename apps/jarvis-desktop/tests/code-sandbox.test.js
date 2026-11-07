'use strict';

// Границы инструментов кода (code_*): реальный путь внутри папок кода мандата. «..», абсолютные пути наружу,
// соседняя папка с тем же префиксом, junction и symlink наружу, путь по умолчанию, пробелы по краям,
// несуществующие родительские папки. Всё — во временных папках os.tmpdir(), не в workspace владельца.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCodePath, CODE_TOOL_NAMES, BUILTIN_DENY_DIRS, codeTools } = require('../src/tools/code');
const { createMandate, checkTool, summarize, isHardBanned, ALLOWED_TOOLS } = require('../src/tasks/mandate');
const { hardDeny } = require('../src/policy/modes');

const NOW = Date.UTC(2026, 9, 31, 12, 0);

// Как на диске владельца: проект, в нём песочница workspace; рядом — чужая папка и соседняя «workspace2».
function layout(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-code-sb-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const sandbox = path.join(project, 'workspace');
  const outside = path.join(base, 'outside');
  const sibling = path.join(project, 'workspace2');
  for (const d of [path.join(sandbox, 'notes'), path.join(project, 'src'), outside, sibling]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'notes', 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(project, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(outside, 'secret.js'), 'секрет');
  fs.writeFileSync(path.join(sibling, 'x.js'), 'чужое');
  return { base, project, sandbox, outside, sibling };
}

// Инструментам кода нужен явный список папок: по умолчанию здесь — сама песочница, указанная явно.
const codeMandate = (sandbox, over = {}) => createMandate({
  goal: 'Поправить исходники', tools: ['code_read', 'code_write', 'code_edit'], sandboxRoot: sandbox, now: NOW, folders: [sandbox], ...over,
});

const check = (m, name, p) => checkTool(m, { name, args: { path: p }, now: NOW });

// Junction (Windows) или symlink на папку; на других ОС тип 'junction' игнорируется и создаётся обычная ссылка.
function makeJunction(target, link) {
  fs.symlinkSync(target, link, 'junction');
}

test('«..» в пути: наружу — отказ, внутри разрешённой папки — можно', (t) => {
  const { sandbox } = layout(t);
  assert.throws(() => resolveCodePath([sandbox], '../../outside/secret.js'), /вне разрешённых папок/);
  assert.throws(() => resolveCodePath([sandbox], 'notes/../../src/app.js'), /вне разрешённых папок/);
  assert.throws(() => resolveCodePath([sandbox], '..\\src\\app.js'), /вне разрешённых папок/);
  const ok = resolveCodePath([sandbox], 'notes/../notes/a.js');
  assert.equal(ok.rel, 'notes/a.js');
  assert.equal(ok.exists, true);
});

test('абсолютный путь вне папки — отказ; абсолютный внутри — можно', (t) => {
  const { sandbox, outside, project } = layout(t);
  assert.throws(() => resolveCodePath([sandbox], path.join(outside, 'secret.js')), /вне разрешённых папок/);
  assert.throws(() => resolveCodePath([sandbox], path.join(project, 'src', 'app.js')), /вне разрешённых папок/);
  assert.equal(resolveCodePath([sandbox], path.join(sandbox, 'notes', 'a.js')).rel, 'notes/a.js');
});

test('соседняя папка с тем же префиксом («workspace2» для «workspace») — отказ', (t) => {
  const { sandbox, sibling } = layout(t);
  assert.throws(() => resolveCodePath([sandbox], path.join(sibling, 'x.js')), /вне разрешённых папок/);
  assert.throws(() => resolveCodePath([sandbox], '../workspace2/x.js'), /вне разрешённых папок/);
  const m = codeMandate(sandbox);
  assert.equal(check(m, 'code_read', path.join(sibling, 'x.js')).ok, false);
});

test('junction наружу: чтение через неё, новый файл в ней и правка — отказ; мандат тоже отказывает', (t) => {
  const { sandbox, outside } = layout(t);
  const link = path.join(sandbox, 'jn');
  try {
    makeJunction(outside, link);
  } catch (err) {
    t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
    return;
  }
  assert.throws(() => resolveCodePath([sandbox], 'jn/secret.js'), /symlink, junction.*за пределы/);
  assert.throws(() => resolveCodePath([sandbox], 'jn/new/deep/file.js'), /за пределы/, 'несуществующий хвост за junction');
  const m = codeMandate(sandbox, { tools: [...CODE_TOOL_NAMES] });
  for (const name of CODE_TOOL_NAMES) {
    const v = check(m, name, 'jn/secret.js');
    assert.equal(v.ok, false, name);
    assert.match(v.reason, /за пределы разрешённых папок/);
  }
});

test('junction внутри разрешённой папки на её же подпапку — можно', (t) => {
  const { sandbox } = layout(t);
  const link = path.join(sandbox, 'alias');
  try {
    makeJunction(path.join(sandbox, 'notes'), link);
  } catch (err) {
    t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
    return;
  }
  assert.equal(resolveCodePath([sandbox], 'alias/a.js').rel, 'notes/a.js', 'проверяется и показывается реальный путь');
});

test('junction в никуда (цель удалена): отказ, ничего не создаётся снаружи', (t) => {
  const { base, sandbox } = layout(t);
  const gone = path.join(base, 'gone');
  fs.mkdirSync(gone);
  const link = path.join(sandbox, 'dangling');
  try {
    makeJunction(gone, link);
  } catch (err) {
    t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
    return;
  }
  fs.rmdirSync(gone);
  assert.throws(() => resolveCodePath([sandbox], 'dangling/new.js'), /несуществующее место/);
  assert.equal(fs.existsSync(gone), false);
});

test('symlink на файл снаружи — отказ (если ОС разрешает создать symlink)', (t) => {
  const { sandbox, outside } = layout(t);
  const link = path.join(sandbox, 'notes', 'link.js');
  try {
    fs.symlinkSync(path.join(outside, 'secret.js'), link, 'file');
  } catch (err) {
    // Windows без режима разработчика и без прав администратора не создаёт symlink (EPERM). Junction проверены выше.
    t.skip(`ОС не дала создать symlink на файл: ${err.code || err.message} (нужен режим разработчика или администратор)`);
    return;
  }
  assert.throws(() => resolveCodePath([sandbox], 'notes/link.js'), /за пределы разрешённых папок/);
  assert.equal(check(codeMandate(sandbox), 'code_edit', 'notes/link.js').ok, false);
});

test('symlink на папку снаружи — отказ (если ОС разрешает создать symlink)', (t) => {
  const { sandbox, outside } = layout(t);
  const link = path.join(sandbox, 'dirlink');
  try {
    fs.symlinkSync(outside, link, 'dir');
  } catch (err) {
    t.skip(`ОС не дала создать symlink на папку: ${err.code || err.message} (нужен режим разработчика или администратор)`);
    return;
  }
  assert.throws(() => resolveCodePath([sandbox], 'dirlink/secret.js'), /за пределы разрешённых папок/);
  assert.throws(() => resolveCodePath([sandbox], 'dirlink/new.js'), /за пределы разрешённых папок/);
});

test('code_* без явных folders — ошибка мандата; папки кода — это folders мандата, проект не разрешён', (t) => {
  const { sandbox, project } = layout(t);
  for (const over of [{ folders: undefined }, { folders: null }]) {
    assert.throws(() => codeMandate(sandbox, over), /для инструментов кода .* нужен явный непустой список папок folders/);
  }
  assert.throws(() => codeMandate(sandbox, { folders: [] }), /хотя бы одна папка/);
  for (const tools of [['code_read'], ['code_write'], ['workspace_read', 'code_edit']]) {
    assert.throws(() => createMandate({ goal: 'г', tools, sandboxRoot: sandbox, now: NOW }), /нужен явный непустой список папок folders/, tools.join());
  }
  const m = codeMandate(sandbox);
  assert.equal(Object.hasOwn(m, 'codeFolders'), false, 'отдельных папок кода нет');
  assert.equal(check(m, 'code_read', 'notes/a.js').ok, true, 'относительный путь — от песочницы');
  assert.equal(check(m, 'code_write', 'notes/new.js').ok, true);
  for (const p of [path.join(project, 'src', 'app.js'), '../src/app.js', project]) {
    assert.equal(check(m, 'code_read', p).ok, false, p);
  }
  // Подпапка мандата: код только в ней.
  const narrow = codeMandate(sandbox, { folders: ['notes'] });
  assert.deepEqual(narrow.folders, [path.join(sandbox, 'notes')]);
  // Относительный путь — от корня песочницы (как у workspace_* и проверок шагов), а не от папки мандата.
  assert.equal(check(narrow, 'code_read', 'notes/a.js').ok, true, 'относительный путь — от корня песочницы');
  assert.match(check(narrow, 'code_read', 'a.js').reason, /вне разрешённых папок/, 'от корня песочницы «a.js» — вне папки мандата');
  assert.equal(check(narrow, 'code_read', 'notes/notes/a.js').ok, true, 'вложенный путь — тоже от корня, папка notes/notes внутри мандата');
  assert.equal(check(narrow, 'code_read', path.join(sandbox, 'other.js')).ok, false);
  // Пустой путь — отказ: инструменту кода нужен файл.
  assert.match(check(m, 'code_read', '   ').reason, /нужен путь к файлу/);
  assert.match(checkTool(m, { name: 'code_read', args: {}, now: NOW }).reason, /нужен путь к файлу/);
});

test('папки вне песочницы (проект, корень диска) — отказ мандата; параметра codeFolders нет', (t) => {
  const { sandbox, project, base } = layout(t);
  for (const folder of ['..', '../src', project, path.join(project, 'src'), path.parse(base).root, `${sandbox}2`]) {
    assert.throws(() => codeMandate(sandbox, { folders: [folder] }), /вне песочницы/, folder);
  }
  assert.throws(() => codeMandate(sandbox, { folders: ['notes'], codeFolders: [path.join(project, 'src')] }), /неизвестный параметр мандата «codeFolders»/);
  // Строка подтверждения: инструменты кода по-русски и папки мандата.
  const m = codeMandate(sandbox, { folders: ['notes'] });
  const text = summarize(m);
  assert.match(text, /Инструменты: чтение исходников \(code_read\), создание исходников \(code_write\), правка исходников \(code_edit\)/);
  assert.ok(text.includes(`Код (без запуска, только в папках мандата: ${path.join(sandbox, 'notes')}): чтение — code_read; `
    + 'изменение — code_write, code_edit, без отдельного подтверждения каждого вызова: разрешение — этот мандат'), text);
  assert.ok(text.includes(`Папки: ${path.join(sandbox, 'notes')}`));
  assert.match(summarize(codeMandate(sandbox, { tools: ['code_read'], folders: ['notes'] })), /Код \(без запуска, .*\): чтение — code_read$/m);
});

test('мандат без code_* не меняется; поле codeFolders старого мандата не читается — только folders', (t) => {
  const { sandbox, project } = layout(t);
  const plain = createMandate({ goal: 'г', tools: ['workspace_read'], sandboxRoot: sandbox, now: NOW });
  assert.equal(Object.hasOwn(plain, 'codeFolders'), false);
  assert.doesNotMatch(summarize(plain), /Код \(без запуска/);
  // Старая запись с codeFolders на проект: код всё равно только в folders.
  const legacy = { ...codeMandate(sandbox, { folders: ['notes'] }), codeFolders: [path.join(project, 'src')] };
  assert.equal(check(legacy, 'code_read', path.join(project, 'src', 'app.js')).ok, false);
  assert.equal(check(legacy, 'code_read', 'notes/a.js').ok, true);
  const broken = { ...codeMandate(sandbox), folders: [] };
  assert.match(check(broken, 'code_read', 'notes/a.js').reason, /нет папок/);
  // Инструмента нет в мандате — отказ, даже если путь верный.
  const readOnly = codeMandate(sandbox, { tools: ['code_read'] });
  assert.match(check(readOnly, 'code_write', 'notes/b.js').reason, /нет в мандате/);
  assert.match(check(createMandate({ goal: 'г', tools: ['workspace_read'], sandboxRoot: sandbox, now: NOW }), 'code_read', 'notes/a.js').reason, /нет в мандате/);
});

test('папка мандата — junction внутри песочницы на проект: отказ кода, хотя путь «внутри»', (t) => {
  const { sandbox, project } = layout(t);
  const link = path.join(sandbox, 'proj');
  try {
    makeJunction(path.join(project, 'src'), link);
  } catch (err) {
    t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
    return;
  }
  const m = codeMandate(sandbox, { folders: ['proj'] });
  const v = check(m, 'code_read', 'app.js');
  assert.equal(v.ok, false);
  assert.match(v.reason, /папка мандата .* после раскрытия ссылок .* за пределы песочницы/);
});

test('пробелы по краям пути обрезаются: проверяется тот путь, который откроет инструмент', (t) => {
  const { sandbox } = layout(t);
  const loc = resolveCodePath([sandbox], '   notes/a.js \t');
  assert.equal(loc.rel, 'notes/a.js');
  assert.equal(loc.exists, true);
  assert.equal(check(codeMandate(sandbox), 'code_read', '  notes/a.js  ').ok, true);
  assert.throws(() => resolveCodePath([sandbox], '  ../../outside/secret.js  '), /вне разрешённых папок/);
});

test('несуществующая родительская папка: внутри разрешённой — можно, снаружи — нет', (t) => {
  const { sandbox, base } = layout(t);
  const loc = resolveCodePath([sandbox], 'new/deep/dir/a.js');
  assert.equal(loc.exists, false);
  assert.equal(loc.rel, 'new/deep/dir/a.js');
  assert.throws(() => resolveCodePath([sandbox], '../../nowhere/deep/a.js'), /вне разрешённых папок/);
  assert.throws(() => resolveCodePath([sandbox], path.join(base, 'nowhere', 'a.js')), /вне разрешённых папок/);
  assert.equal(fs.existsSync(path.join(sandbox, 'new')), false, 'проверка пути ничего не создаёт');
  assert.equal(fs.existsSync(path.join(base, 'nowhere')), false);
});

test('расширения, точечные папки, node_modules, потоки файла и служебные папки — отказ', (t) => {
  const { sandbox } = layout(t);
  for (const p of ['a.exe', 'run.ps1', 'run.bat', 'Makefile', 'notes/a.js.bak', '.env', 'x.sh']) {
    assert.throws(() => resolveCodePath([sandbox], p), /не разрешено|закрыты/, p);
  }
  for (const p of ['a.JS', 'b.ts', 'c.py', 'd.md', 'e.json', 'f.txt', 'g.css', 'h.html', 'i.yml', 'j.toml', 'k.rs']) {
    assert.doesNotThrow(() => resolveCodePath([sandbox], p), p);
  }
  for (const p of ['.git/config.txt', 'notes/.hidden/a.js', 'node_modules/x/index.js', '.env.json']) {
    assert.throws(() => resolveCodePath([sandbox], p), /закрыты/, p);
  }
  if (process.platform === 'win32') {
    assert.throws(() => resolveCodePath([sandbox], 'notes/a.txt:evil.js'), /альтернативные потоки/);
    assert.throws(() => resolveCodePath([sandbox], '\\\\?\\C:\\x.js'), /пути устройств/);
  }
  const closed = path.join(sandbox, 'private');
  assert.throws(() => resolveCodePath([sandbox], 'private/a.js', { denyDirs: [closed] }), /служебной папке/);
  assert.doesNotThrow(() => resolveCodePath([sandbox], 'notes/a.js', { denyDirs: [closed] }));
  // Данные Джарвиса (корень проекта\data) закрыты всегда. Сравнение путей без обращения к диску.
  assert.deepEqual([...BUILTIN_DENY_DIRS], [path.resolve(__dirname, '..', '..', '..', 'data')]);
});

test('разрешённые папки: пустой список и относительные пути — отказ; инструменты без roots не собираются', () => {
  assert.throws(() => resolveCodePath([], 'a.js'), /нет разрешённых папок/);
  assert.throws(() => resolveCodePath(['relative/dir'], 'a.js'), /абсолютным путём/);
  assert.throws(() => resolveCodePath([os.tmpdir()], 42), /строкой/);
  assert.throws(() => codeTools(), /нужны разрешённые папки/);
});

test('имена code_* в белом списке и не попадают под жёсткие запреты; запреты не ослаблены', () => {
  for (const name of CODE_TOOL_NAMES) {
    assert.ok(ALLOWED_TOOLS.includes(name), name);
    assert.equal(isHardBanned(name), false, name);
    assert.equal(hardDeny({ name, args: {} }), null, name);
  }
  for (const name of ['code_delete', 'code_remove', 'code_send', 'code_push', 'code_upload', 'shell_run', 'library_run', 'code_buy', 'code_pay']) {
    assert.equal(isHardBanned(name), true, name);
  }
  assert.equal(ALLOWED_TOOLS.some((n) => /run|exec|shell|spawn/.test(n)), false, 'произвольного запуска кода в белом списке нет: code_test — только тесты');
});
