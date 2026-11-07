'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceBook } = require('../src/workspaces/book');
const { WorkspaceChat } = require('../src/workspaces/chat');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-space-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { defaultRoot: path.join(dir, 'workspace'), spacesRoot: path.join(dir, 'workspaces'), dataDir: path.join(dir, 'data') };
  fs.mkdirSync(opts.defaultRoot); fs.mkdirSync(opts.dataDir);
  return { opts, book: new WorkspaceBook(opts) };
}

test('сводка непрочитанных доступна по запросу в пространстве и не попадает в историю другого', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const { mailTools } = require('../src/tools/mail');
  let calls = 0;
  const gmail = { async listUnread() { calls++; return { ok: true, items: [{ subject: 'Личное письмо' }], hasMore: false, failed: 0 }; } };
  let step = 0;
  const brain = { async chat() {
    if (step++ === 0) return { content: '', toolCalls: [{ id: 'read-mail', name: 'mail_unread', args: {} }] };
    return { content: 'Есть личное письмо', toolCalls: [] };
  } };
  const chat = new WorkspaceChat({ book, brain, commonTools: mailTools(gmail), policy: () => 'allow', journal: { append() {} }, memoryAuto: () => false });
  chat.select(work.id);
  assert.equal(typeof chat.tools().get('mail_send').run, 'function');
  await chat.run('Покажи непрочитанные письма');
  assert.equal(calls, 1);
  assert.match(JSON.stringify(chat.history()), /Личное письмо/);
  chat.select(study.id);
  assert.doesNotMatch(JSON.stringify(chat.history()), /Личное письмо|личное письмо/);
});

test('полный доступ работает с файлами выбранного пространства и переключается вместе с режимом', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const session = new WorkspaceChat({ book, mode: 'full', brain: { async chat() { return { content: 'готово', toolCalls: [] }; } }, journal: { append() {} } });
  for (const space of [work, study]) {
    const root = book.open(space.id).root;
    fs.writeFileSync(path.join(root, 'note.md'), 'прежний текст');
  }
  session.select(work.id);
  const workWrite = session.tools().get('workspace_write');
  assert.equal((await workWrite.run({ path: 'note.md', content: 'изменено' })).ok, true);
  assert.equal(fs.readFileSync(path.join(book.open(study.id).root, 'note.md'), 'utf8'), 'прежний текст');
  session.setMode('auto');
  assert.equal((await workWrite.run({ path: 'note.md', content: 'не записывать' })).ok, false);
  session.select(study.id);
  assert.equal((await session.tools().get('workspace_write').run({ path: 'note.md', content: 'не записывать' })).ok, false);
  session.setMode('full');
  assert.equal((await session.tools().get('workspace_write').run({ path: 'note.md', content: 'учёба' })).ok, true);
  session.select(work.id);
  assert.equal((await session.tools().get('workspace_write').run({ path: 'note.md', content: 'снова работа' })).ok, true);
});

test('действия компьютера в пространстве проходят политику выбранного режима', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const seen = [];
  const shell = { name: 'shell_run', risk: 'T2', parameters: { type: 'object', properties: { command: { type: 'string' } } },
    async run(_args, ctx) { seen.push(ctx.workspace); return { ok: true, summary: 'выполнено' }; } };
  let step = 0;
  const brain = { async chat() {
    if (step++ % 2 === 0) return { toolCalls: [{ id: `shell-${step}`, name: 'shell_run', args: { command: 'Get-Date' } }] };
    return { content: 'готово', toolCalls: [] };
  } };
  const session = new WorkspaceChat({ book, brain, commonTools: [shell], mode: 'full', policy: require('../src/policy/modes'), journal: { append() {} }, memoryAuto: () => false });
  session.select(work.id);
  await session.run('Проверь дату', { ownerText: 'Проверь дату' });
  assert.deepEqual(seen, [book.open(work.id).root]);
  session.setMode('ask');
  await session.run('Проверь дату ещё раз', { ownerText: 'Проверь дату ещё раз' });
  assert.equal(seen.length, 1, 'без подтверждения второй вызов не исполняется');
});

test('в авто чат может исправить исходник своего пространства; в режиме вопросов ждёт согласия', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  for (const space of [work, study]) fs.writeFileSync(path.join(book.open(space.id).root, 'app.js'), 'const answer = 1;\n');
  let step = 0;
  const brain = { async chat() {
    if (step++ % 2 === 0) return { toolCalls: [{ id: `edit-${step}`, name: 'code_edit', args: { path: 'app.js', old_string: 'answer = 1', new_string: 'answer = 2' } }] };
    return { content: 'готово', toolCalls: [] };
  } };
  const session = new WorkspaceChat({ book, brain, mode: 'auto', policy: require('../src/policy/modes'), journal: { append() {} }, memoryAuto: () => false });
  session.select(work.id);
  await session.run('Исправь app.js', { ownerText: 'Исправь app.js' });
  assert.match(fs.readFileSync(path.join(book.open(work.id).root, 'app.js'), 'utf8'), /answer = 2/);
  session.select(study.id);
  session.setMode('ask');
  await session.run('Исправь app.js', { ownerText: 'Исправь app.js' });
  assert.match(fs.readFileSync(path.join(book.open(study.id).root, 'app.js'), 'utf8'), /answer = 1/);
});

test('правку кода в чате можно отменить из резервной копии в авто-режиме', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const root = book.open(work.id).root;
  fs.writeFileSync(path.join(root, 'app.js'), 'const n = 1;\n');
  const session = new WorkspaceChat({ book, mode: 'auto', brain: { async chat() { return { content: 'готово', toolCalls: [] }; } }, journal: { append() {} } });
  session.select(work.id);
  const edit = await session.tools().get('code_edit').run({ path: 'app.js', old_string: 'n = 1', new_string: 'n = 2' });
  assert.equal(edit.ok, true);
  assert.match(edit.data.backup, /^backups\//);
  const restore = session.tools().get('workspace_restore');
  const list = await restore.run({ path: 'app.js', list: true });
  assert.equal(list.data.copies[0].backup, edit.data.backup);
  assert.equal((await restore.run({ path: 'app.js', backup: edit.data.backup })).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'const n = 1;\n');
});

test('ошибка создания копии не перезаписывает исходник', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const root = book.open(work.id).root;
  fs.writeFileSync(path.join(root, 'app.js'), 'const n = 1;\n');
  fs.writeFileSync(path.join(root, 'backups'), 'не папка');
  const session = new WorkspaceChat({ book, mode: 'auto', brain: { async chat() { return { content: 'готово', toolCalls: [] }; } } });
  session.select(work.id);
  const result = await session.tools().get('code_edit').run({ path: 'app.js', old_string: 'n = 1', new_string: 'n = 2' });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'const n = 1;\n');
});

test('настоящий цикл агента пишет в выбранное пространство и не подмешивает чужую память и историю', async (t) => {
  const { opts, book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  book.open(work.id).memory.add({ text: 'Проект Звезда: рабочая тайна' });
  book.open(study.id).memory.add({ text: 'Проект Звезда: учебная заметка' });
  const requests = [];
  let phase = 0;
  const brain = { async chat(request) {
    requests.push(request);
    if (phase++ % 2 === 0) return { content: '', toolCalls: [{ id: `call-${phase}`, name: 'workspace_write', args: { path: 'notes/result.md', content: phase === 1 ? 'работа' : 'учёба' } }] };
    return { content: 'Готово', toolCalls: [] };
  } };
  const session = new WorkspaceChat({ book, brain, policy: () => 'allow', journal: { append() {} } });
  session.select(work.id);
  await session.run('Проект Звезда: сделай рабочее');
  session.select(study.id);
  await session.run('Проект Звезда: сделай учебное');
  const flattened = JSON.stringify(requests[2].messages);
  assert.match(flattened, /учебная заметка/);
  assert.doesNotMatch(flattened, /рабочая тайна|сделай рабочее/);
  assert.equal(fs.readFileSync(path.join(book.open(work.id).root, 'notes/result.md'), 'utf8'), 'работа');
  assert.equal(fs.readFileSync(path.join(book.open(study.id).root, 'notes/result.md'), 'utf8'), 'учёба');
  const restarted = new WorkspaceChat({ book: new WorkspaceBook(opts), brain, policy: () => 'allow', journal: { append() {} } });
  assert.equal(restarted.current().id, study.id);
  assert.match(JSON.stringify(restarted.history()), /сделай учебное/);
  assert.doesNotMatch(JSON.stringify(restarted.history()), /сделай рабочее/);
  restarted.select(work.id);
  assert.match(JSON.stringify(restarted.history()), /сделай рабочее/);
});

test('во время активного хода переключение запрещено, после завершения разрешено', async (t) => {
  const { book } = setup(t);
  const other = book.create('Учёба');
  let finish;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const brain = { chat: () => { started(); return new Promise((resolve) => { finish = resolve; }); } };
  const session = new WorkspaceChat({ book, brain, journal: { append() {} } });
  const turn = session.run('ожидание');
  await running;
  assert.throws(() => session.select(other.id), /занят/);
  assert.equal(book.current().id, 'default');
  finish({ content: 'Готово', toolCalls: [] });
  await turn;
  session.select(other.id);
  assert.equal(session.current().id, other.id);
});

test('глобальные инструменты задач и подменённые файловые инструменты не попадают в отдельный чат', (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const fake = (name) => ({ name, risk: 'T0', parameters: { type: 'object', properties: {} }, async run() { return { ok: true, summary: 'fake' }; } });
  const commonTools = [fake('task_list'), fake('goal_list'), fake('workspace_read'), fake('recall'), fake('web_search')];
  const session = new WorkspaceChat({ book, brain: { async chat() { return { content: 'ok', toolCalls: [] }; } }, commonTools, journal: { append() {} } });
  session.select(work.id);
  const names = session.tools().list().map((item) => item.name);
  assert.equal(names.includes('task_list'), false);
  assert.equal(names.includes('goal_list'), true);
  assert.notEqual(session.tools().get('goal_list'), commonTools[1]);
  assert.equal(names.includes('web_search'), true);
  assert.notEqual(session.tools().get('workspace_read'), commonTools[2]);
  assert.notEqual(session.tools().get('recall'), commonTools[3]);
});

test('инструменты задач создаются для выбранного пространства, а не берутся из общего чата', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const seen = [];
  const session = new WorkspaceChat({ book, brain: { async chat() { return { content: 'ok', toolCalls: [] }; } },
    scopedTools: (space) => [{ name: 'task_list', risk: 'T0', parameters: { type: 'object', properties: {} },
      async run() { seen.push(space.id); return { ok: true, summary: 'ok' }; } }], journal: { append() {} } });
  session.select(work.id);
  await session.tools().get('task_list').run({});
  assert.deepEqual(seen, [work.id]);
});

test('отдельный чат привязывает инструменты напоминаний к своему пространству', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const { ReminderStore } = require('../src/schedule/store');
  const { remindersTools } = require('../src/tools/reminders');
  const store = new ReminderStore(path.join(path.dirname(book.file), 'reminders.json'));
  const session = new WorkspaceChat({
    book,
    brain: { async chat() { return { content: 'готово', toolCalls: [] }; } },
    scopedTools: (space) => remindersTools(store, { workspaceId: space.id }),
    journal: { append() {} },
  });
  session.select(work.id);
  const added = await session.tools().get('remind_in').run({ minutes: 10, text: 'рабочее напоминание' });
  session.select(study.id);
  assert.deepEqual((await session.tools().get('list_reminders').run()).data, []);
  assert.match((await session.tools().get('cancel_reminder').run({ id: added.data.id })).summary, /такого напоминания нет/);
});

test('дела и обещания пространств изолированы и сохраняются после перезапуска', (t) => {
  const { book, opts } = setup(t);
  const { WorkspaceDeals } = require('../src/workspaces/deals');
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const task = (id, workspaceId) => ({ id, workspaceId, title: id, status: 'queued' });
  const tasks = [task('work-task', work.id), task('study-task', study.id), task('common-task', undefined)];
  const { ReminderStore } = require('../src/schedule/store');
  const reminders = new ReminderStore(path.join(opts.dataDir, 'reminders.json'));
  reminders.add({ text: 'Срок работы', dueAt: '2026-11-06T12:00:00Z', workspaceId: work.id });
  reminders.add({ text: 'Срок учёбы', dueAt: '2026-11-06T12:00:00Z', workspaceId: study.id });
  const spaces = new WorkspaceDeals({ book, tasks: () => tasks, reminders: () => reminders.list() });
  const workStore = spaces.refresh(work.id);
  workStore.upsert({ ref: 'promise:w', title: 'Рабочее обещание', source: 'promise', state: 'promised' });
  const studyStore = spaces.refresh(study.id);
  assert.deepEqual(workStore.list().map((item) => item.ref).sort(), ['promise:w', `reminder:${reminders.list()[0].id}`, 'task:work-task'].sort());
  assert.deepEqual(studyStore.list().map((item) => item.title).sort(), ['Срок учёбы', 'study-task'].sort());
  assert.equal(studyStore.clear('promise:w'), null);
  const restarted = new WorkspaceDeals({ book: new WorkspaceBook(opts), tasks: () => tasks, reminders: () => reminders.list() });
  assert.deepEqual(restarted.refresh(work.id).list().map((item) => item.title).sort(), ['Рабочее обещание', 'Срок работы', 'work-task'].sort());
});

test('ответ без модели сохраняется в истории только выбранного пространства', (t) => {
  const { book, opts } = setup(t);
  const work = book.create('Работа');
  const brain = { async chat() { throw new Error('модель не должна вызываться'); } };
  const chat = new WorkspaceChat({ book, brain });
  chat.select(work.id);
  chat.remember('Что повисло?', 'Есть одно рабочее дело.');
  const restarted = new WorkspaceChat({ book: new WorkspaceBook(opts), brain });
  assert.match(JSON.stringify(restarted.history()), /Есть одно рабочее дело/);
  restarted.select('default');
  assert.doesNotMatch(JSON.stringify(restarted.history()), /Есть одно рабочее дело/);
});

test('цели создаются и подсказываются только внутри своего пространства, в том числе после перезапуска', async (t) => {
  const { book, opts } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const prompts = [];
  const brain = { async chat(req) { prompts.push(JSON.stringify(req.messages)); return { content: 'Понял', toolCalls: [] }; } };
  const chat = new WorkspaceChat({ book, brain, policy: () => 'allow', journal: { append() {} } });
  chat.select(work.id);
  const created = await chat.tools().get('goal_create').run({ title: 'Рабочий проект', steps: ['Подготовить отчёт'] });
  assert.equal(created.ok, true, created.summary);
  assert.equal((await chat.tools().get('goal_create').verify({}, created)).status, 'confirmed');
  chat.select(study.id);
  assert.deepEqual((await chat.tools().get('goal_list').run({})).data.goals, []);
  assert.equal((await chat.tools().get('goal_next').run({ id: created.data.goal.id })).ok, false);
  await chat.run('Что дальше?');
  assert.doesNotMatch(prompts.at(-1), /Рабочий проект|Подготовить отчёт/);
  const restarted = new WorkspaceChat({ book: new WorkspaceBook(opts), brain, policy: () => 'allow', journal: { append() {} } });
  restarted.select(work.id);
  assert.equal((await restarted.tools().get('goal_list').run({})).data.goals[0].title, 'Рабочий проект');
  await restarted.run('Что дальше?');
  assert.match(prompts.at(-1), /Рабочий проект/);
  assert.match(prompts.at(-1), /Подготовить отчёт/);
});

test('автопамять отдельного пространства изучает только слова владельца и уважает выключатель', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  let enabled = true;
  const chat = new WorkspaceChat({ book, brain: { async chat() { return { content: 'Меня зовут Выдумка', toolCalls: [] }; } },
    memoryAuto: () => enabled, journal: { append() {} } });
  chat.select(work.id);
  await chat.run('Меня зовут Андрей', { ownerText: 'Меня зовут Андрей' });
  assert.match(JSON.stringify(book.open(work.id).memory.list()), /Андрей/);
  assert.doesNotMatch(JSON.stringify(book.open(work.id).memory.list()), /Выдумка/);
  chat.select(study.id);
  assert.doesNotMatch(JSON.stringify(book.open(study.id).memory.list()), /Андрей/);
  enabled = false;
  await chat.run('Меня зовут Борис', { ownerText: 'Меня зовут Борис' });
  assert.doesNotMatch(JSON.stringify(book.open(study.id).memory.list()), /Борис/);
  enabled = true;
  await chat.run('Меня зовут Борис', { ownerText: '' });
  assert.doesNotMatch(JSON.stringify(book.open(study.id).memory.list()), /Борис/, 'пустой текст владельца не подменяется содержимым вложения');
});

test('успешный сценарий учится в своём пространстве и подсказывается при точном повторе', async (t) => {
  const { opts, book } = setup(t);
  const work = book.create('Работа');
  const phrase = 'открой Notepad и нажми Save';
  const requests = [];
  let phase = 0;
  const brain = { async chat(request) {
    requests.push(request);
    if (phase++ === 0) return { content: '', toolCalls: [{ id: 'open', name: 'app_open', args: { name: 'Notepad' } }] };
    if (phase === 2) return { content: '', toolCalls: [{ id: 'click', name: 'ui_click', args: { window: 'Notepad', name: 'Save' } }] };
    return { content: 'Готово', toolCalls: [] };
  } };
  const confirmable = (name) => ({
    name, risk: 'T1', parameters: { type: 'object', properties: {} },
    async run() { return { ok: true, summary: 'действие выполнено' }; },
    async verify() { return { status: 'confirmed', evidence: 'эффект проверен' }; },
  });
  const session = new WorkspaceChat({ book, brain, policy: () => 'allow',
    scopedTools: () => [confirmable('app_open'), confirmable('ui_click')], journal: { append() {} } });
  session.select(work.id);
  const first = await session.run(phrase, { ownerText: phrase });
  assert.equal(first.outcome, 'answer');
  const saved = await session.tools().get('skill_read').run({ name: `auto-${require('../src/skills/experience').hashOf(phrase)}` });
  assert.equal(saved.ok, true);
  assert.match(saved.data.body, /1\. app_open/);
  assert.match(saved.data.body, /2\. ui_click.*Save/);

  const restarted = new WorkspaceChat({ book: new WorkspaceBook(opts), brain,
    scopedTools: () => [confirmable('app_open'), confirmable('ui_click')], journal: { append() {} } });
  const second = await restarted.run(phrase, { ownerText: phrase });
  assert.equal(second.outcome, 'answer');
  assert.match(JSON.stringify(requests.at(-1).messages), /Подсказка из успешного опыта/);
  restarted.select('default');
  assert.equal((await restarted.tools().get('skills_list').run({})).data.skills.some((skill) => skill.name.startsWith('auto-')), false);
});

test('повреждённая история пространства не заменяется пустой и не меняет текущий выбор', (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  const file = path.join(path.dirname(book.open(work.id).memory.filePath), 'conversation.json');
  const damaged = JSON.stringify({ activeId: 'bad', chats: [{ id: 42, history: [] }] });
  fs.writeFileSync(file, damaged);
  const session = new WorkspaceChat({ book, brain: { async chat() { return { content: 'ok', toolCalls: [] }; } }, journal: { append() {} } });
  assert.throws(() => session.select(work.id), /поврежд/);
  assert.equal(book.current().id, 'default');
  assert.equal(session.current().id, 'default');
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});

test('обычный режим не выполняет запись без подтверждения', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  let calls = 0;
  const brain = { async chat() {
    if (calls++ === 0) return { content: '', toolCalls: [{ id: 'w', name: 'workspace_write', args: { path: 'notes/a.md', content: 'текст' } }] };
    return { content: 'отказано', toolCalls: [] };
  } };
  const session = new WorkspaceChat({ book, brain, journal: { append() {} }, mode: 'ask' });
  session.select(work.id);
  await session.run('сохрани');
  assert.equal(fs.existsSync(path.join(book.open(work.id).root, 'notes/a.md')), false);
});

test('вкладки внутри пространства сохраняются независимо от других пространств', async (t) => {
  const { opts, book } = setup(t);
  const work = book.create('Работа');
  const study = book.create('Учёба');
  const brain = { async chat() { return { content: 'ответ', toolCalls: [] }; } };
  const session = new WorkspaceChat({ book, brain, journal: { append() {} } });
  session.select(work.id);
  await session.run('первый рабочий чат');
  const first = session.chatList().activeId;
  session.newChat();
  await session.run('второй рабочий чат');
  const second = session.chatList().activeId;
  session.select(study.id);
  assert.equal(session.chatList().chats.length, 1);
  assert.equal(session.history().length, 0);
  session.select(work.id);
  assert.equal(session.chatList().chats.length, 2);
  session.selectChat(first);
  assert.match(JSON.stringify(session.history()), /первый рабочий чат/);
  session.closeChat(second);
  const restarted = new WorkspaceChat({ book: new WorkspaceBook(opts), brain, journal: { append() {} } });
  assert.equal(restarted.chatList().chats.length, 1);
  assert.match(JSON.stringify(restarted.history()), /первый рабочий чат/);
});

test('остановка прерывает ход и позволяет после этого сменить пространство', async (t) => {
  const { book } = setup(t);
  const work = book.create('Работа');
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const brain = { chat: ({ signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
  }) };
  const session = new WorkspaceChat({ book, brain, journal: { append() {} } });
  const turn = session.run('долгий ход');
  await ready;
  session.stop();
  await turn;
  session.select(work.id);
  assert.equal(session.current().id, work.id);
});
