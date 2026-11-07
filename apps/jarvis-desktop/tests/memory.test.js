'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { MemoryStore, stem, memoryContext, profileNote, backgroundBrief } = require('../src/memory/store');
const { memoryTools } = require('../src/tools/memory');
const { ToolRegistry } = require('../src/tools/registry');
const { runMission } = require('../src/missions/runner');

const DAY = 24 * 60 * 60 * 1000;
// Записи со старыми датами пишем прямо в файл: add ставит сегодняшнюю дату.
function writeItems(file, items) {
  fs.writeFileSync(file, JSON.stringify({ items }), 'utf8');
}
function daysAgo(n) {
  return new Date(Date.now() - n * DAY).toISOString();
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Файл-источник внутри рабочей папки (папка создаётся, если её нет).
function writeFileIn(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('add создаёт запись с id, kind по умолчанию и createdAt; list отдаёт новые сверху', (t) => {
  const file = path.join(tempDir(t), 'nested', 'memory.json');
  const store = new MemoryStore(file);
  assert.deepEqual(store.list(), [], 'до первой записи файла может не быть');

  const first = store.add({ text: 'первая заметка' });
  const second = store.add({ text: 'вторая заметка', kind: 'fact' });

  assert.equal(typeof first.id, 'string');
  assert.notEqual(first.id, second.id);
  assert.equal(first.kind, 'note');
  assert.equal(second.kind, 'fact');
  assert.equal(new Date(first.createdAt).toISOString(), first.createdAt);
  assert.deepEqual(store.list().map((r) => r.text), ['вторая заметка', 'первая заметка']);
  assert.equal(store.list(1).length, 1);
});

test('add отклоняет пустой и пробельный текст', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  assert.throws(() => store.add({ text: '' }), /пустой/);
  assert.throws(() => store.add({ text: '   \n\t ' }), /пустой/);
  assert.throws(() => store.add({}), /пустой/);
  assert.deepEqual(store.list(), []);
});

test('text обрезается до 500 символов, эмодзи не рвутся', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const long = store.add({ text: 'а'.repeat(600) });
  assert.equal(long.text.length, 500);

  const emoji = store.add({ text: '😀'.repeat(600) });
  assert.equal(Array.from(emoji.text).length, 500);
  assert.equal(emoji.text, '😀'.repeat(500));
});

test('search: больше совпавших слов выше, при равенстве новее выше, регистр не важен', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Любимый напиток кофе' });   // 2 слова из запроса
  store.add({ text: 'кофе без сахара' });        // 1 слово, старше
  store.add({ text: 'любимый фильм' });          // 1 слово, новее
  store.add({ text: 'кофе утром' });             // 1 слово, самая новая

  const found = store.search('ЛЮБИМЫЙ Кофе');
  assert.deepEqual(found.map((r) => r.text), [
    'Любимый напиток кофе',
    'кофе утром',
    'любимый фильм',
    'кофе без сахара',
  ]);
  assert.equal(store.search('ЛЮБИМЫЙ Кофе', 2).length, 2);
  assert.deepEqual(store.search('космос'), [], 'слова есть, но ничего не совпало');
});

test('search: формы слова находят друг друга (день/дня, сон/сна, окно/окна, файлы/файл)', (t) => {
  const dir = tempDir(t);
  const pairs = [['день', 'дня'], ['дня', 'день'], ['сон', 'сна'], ['сна', 'сон'], ['окно', 'окна'], ['файлы', 'файл']];
  pairs.forEach(([query, text], i) => {
    const store = new MemoryStore(path.join(dir, `${i}.json`));
    store.add({ text: `Заметка про ${text}` });
    assert.equal(store.search(query).length, 1, `«${query}» должно найти «${text}»`);
  });
});

test('search: короткие разные слова не совпадают, английские не трогаются', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'дым от костра' });
  store.add({ text: 'the day is long' });
  assert.deepEqual(store.search('дом'), [], '«дом» не должен найти «дым»');
  assert.deepEqual(store.search('days'), [], 'английское слово не режется до основы');
  assert.equal(stem('days'), 'days');
  assert.equal(stem('day'), 'day');
  assert.notEqual(stem('дом'), stem('дым'));
});

test('search без слов (пусто или одна буква) возвращает последние записи', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  for (const text of ['раз', 'два', 'три']) store.add({ text });

  assert.deepEqual(store.search('').map((r) => r.text), ['три', 'два', 'раз']);
  assert.deepEqual(store.search('а', 2).map((r) => r.text), ['три', 'два']);
});

test('remove возвращает true для существующей записи и false для остальных', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const rec = store.add({ text: 'удали меня' });

  assert.equal(store.remove('нет-такого-id'), false);
  assert.equal(store.remove(rec.id), true);
  assert.equal(store.remove(rec.id), false);
  assert.deepEqual(store.list(), []);
});

test('данные сохраняются между экземплярами MemoryStore на одном файле', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const first = new MemoryStore(file);
  const rec = first.add({ text: 'Сестру зовут Аня', kind: 'fact' });

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].id, rec.id);

  const second = new MemoryStore(file);
  assert.equal(second.list()[0].id, rec.id);

  second.add({ text: 'вторая запись' });
  assert.equal(first.list().length, 2, 'первый экземпляр видит запись второго');
  assert.equal(first.remove(rec.id), true);
  assert.equal(second.list().length, 1, 'второй экземпляр видит удаление первого');
});

test('запись атомарная: после неё в папке только основной файл', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  store.add({ text: 'первая' });
  store.add({ text: 'вторая' });
  assert.deepEqual(fs.readdirSync(dir), ['memory.json']);
});

test('больше 2000 записей: удаляются самые старые', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const createdAt = new Date(0).toISOString();
  const items = [];
  for (let i = 0; i < 2000; i++) {
    items.push({ id: `old-${i}`, text: `запись ${i}`, kind: 'note', createdAt });
  }
  fs.writeFileSync(file, JSON.stringify({ items }), 'utf8');

  const store = new MemoryStore(file);
  store.add({ text: 'самая новая' });

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.items.length, 2000);
  assert.equal(data.items[0].id, 'old-1', 'старейшая запись удалена');
  assert.equal(data.items[1999].text, 'самая новая');
});

test('повреждённый файл не перезаписывается', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const store = new MemoryStore(file);

  assert.throws(() => store.add({ text: 'новая' }), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json');
});

test('memoryTools: четыре инструмента, remember, recall и memory_about — T0, forget — T2', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const tools = memoryTools(store);

  assert.deepEqual(tools.map((tool) => tool.name), ['remember', 'recall', 'forget', 'memory_about']);
  assert.deepEqual(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.risk])),
    { remember: 'T0', recall: 'T0', memory_about: 'T0', forget: 'T2' }
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.parameters.type, 'object');
  }

  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  assert.equal(registry.list().length, 4);
});

test('инструменты: remember -> recall -> forget', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const [remember, recall, forget] = memoryTools(store);

  const saved = await remember.run({ text: 'Любимый чай — зелёный', kind: 'preference' });
  assert.equal(saved.ok, true);
  assert.equal(saved.summary, 'запомнил');

  const found = await recall.run({ query: 'чай' });
  assert.equal(found.ok, true);
  assert.equal(found.summary, 'найдено записей: 1');
  assert.deepEqual(Object.keys(found.data[0]).sort(), ['createdAt', 'kind', 'text']);
  assert.equal(found.data[0].text, 'Любимый чай — зелёный');
  assert.equal(found.data[0].kind, 'preference');

  const gone = await forget.run({ id: saved.data.id });
  assert.equal(gone.ok, true);
  assert.equal(gone.summary, 'удалил');

  const again = await forget.run({ id: saved.data.id });
  assert.equal(again.ok, false);
  assert.equal(again.summary, 'такой записи нет');
});

test('инструменты возвращают {ok: false} на ошибках ввода', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const [remember, recall, forget] = memoryTools(store);

  const emptyText = await remember.run({ text: '   ' });
  assert.equal(emptyText.ok, false);
  assert.equal(typeof emptyText.summary, 'string');

  const badKind = await remember.run({ text: 'x', kind: 'что-то' });
  assert.equal(badKind.ok, false);

  for (const query of ['', '   ']) {
    const res = await recall.run({ query });
    assert.equal(res.ok, false, `пустой запрос ${JSON.stringify(query)} должен отклоняться`);
  }
  assert.equal((await recall.run({})).ok, false);
  assert.equal((await recall.run({ query: 'чай', limit: 0 })).ok, false);

  const noId = await forget.run({});
  assert.equal(noId.ok, false);
});

test('старый memory.json без новых полей читается как есть и не теряется', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  // Дата свежая (час назад): старая заметка по новому сроку давности уже протухла бы и пропала из поиска.
  const old = { items: [{ id: 'old-1', text: 'Сестру зовут Аня', kind: 'fact', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }] };
  fs.writeFileSync(file, JSON.stringify(old), 'utf8');

  const store = new MemoryStore(file);
  assert.deepEqual(store.list(), old.items);
  assert.deepEqual(store.search('Аня'), old.items);
  assert.match(memoryContext(store, 'как зовут сестру'), /Аня/);

  store.add({ text: 'новая запись', about: 'Иван' });
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data.items[0], old.items[0], 'старая запись не изменилась');
  assert.equal(data.items[1].about, 'Иван');
});

test('срок: просроченная запись не отдаётся в поиске и контексте, пока не попросили', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Скидка у Ивана на кофе', until: '2020-01-01' });
  store.add({ text: 'Скидка у Ивана на чай', until: '2999-01-01' });

  assert.deepEqual(store.search('скидка').map((r) => r.text), ['Скидка у Ивана на чай']);
  assert.equal(store.search('скидка', 5, { includeExpired: true }).length, 2);
  assert.deepEqual(memoryContext(store, 'скидка у Ивана').split('\n').length, 2);
  assert.throws(() => store.add({ text: 'x', until: 'не дата' }), /срок/);
});

test('recall и memory_about: просроченные скрыты, memory_about помечает их expired', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const [remember, recall, , about] = memoryTools(store);
  await remember.run({ text: 'Пропуск в офис', about: 'офис', until: '2020-05-05' });

  assert.equal((await recall.run({ query: 'пропуск' })).data.length, 0);
  const withOld = await recall.run({ query: 'пропуск', includeExpired: true });
  assert.equal(withOld.data.length, 1);
  assert.equal(withOld.data[0].until, '2020-05-05');

  const info = await about.run({ name: 'офис' });
  assert.equal(info.ok, true);
  assert.equal(info.data[0].expired, true);
  assert.equal(typeof info.data[0].id, 'string');
});

test('связи: поиск по about приносит связанные записи на один шаг, не дальше', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Ведёт переговоры про поставку', about: 'Иван Петров', links: ['Проект Альфа'] });
  store.add({ text: 'Дедлайн в конце месяца', about: 'Проект Альфа', links: ['Склад'] });
  store.add({ text: 'Склад на Ленина', about: 'Склад' });
  store.add({ text: 'Не связано вообще', about: 'Кухня' });

  const found = store.search('Иван').map((r) => r.about);
  assert.deepEqual(found, ['Иван Петров', 'Проект Альфа'], 'через один шаг, но не Склад');

  // Про Альфу: своя запись, запись Ивана (он ссылается на Альфу) и запись про Склад (Альфа ссылается на Склад).
  const about = store.about('Проект Альфа').map((r) => r.text).sort();
  assert.deepEqual(about, ['Ведёт переговоры про поставку', 'Дедлайн в конце месяца', 'Склад на Ленина']);
  assert.equal(store.about('Иван').length, 2);
});

test('контекст проекта находит решение и документ по явным связям после перезапуска', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const store = new MemoryStore(file);
  store.add({ text: 'Цель — выпуск приложения', about: 'Проект Альфа', links: ['Решение Анкер'] });
  store.add({ text: 'Выбран автономный режим', about: 'Решение Анкер', links: ['Документ Бета'] });
  store.add({ text: 'Требования записаны в плане', about: 'Документ Бета' });
  store.add({ text: 'Чужая отдельная задача', about: 'Проект Гамма' });
  const context = memoryContext(new MemoryStore(file), 'Расскажи про проект Альфа');
  assert.match(context, /Цель — выпуск приложения/);
  assert.match(context, /Выбран автономный режим/);
  assert.match(context, /Требования записаны в плане/);
  assert.match(context, /Решение Анкер/);
  assert.doesNotMatch(context, /Чужая отдельная задача/);
  assert.doesNotMatch(memoryContext(store, 'расскажи про проект'), /Требования записаны в плане/);
});

test('чувствительные и устаревшие записи не раскрываются и не служат мостом в графе', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Работа над проектом', about: 'Проект Альфа', links: ['Данные владельца', 'Старое решение'] });
  store.add({ text: 'Чувствительные сведения', about: 'Данные владельца', links: ['Закрытый материал'], sensitive: true });
  store.add({ text: 'Секретный переход', about: 'Закрытый материал' });
  store.add({ text: 'Устаревшее решение', about: 'Старое решение', links: ['Старый документ'], until: '2020-01-01' });
  store.add({ text: 'Старый документ', about: 'Старый документ' });
  const context = memoryContext(store, 'Что известно о проекте Альфа?');
  assert.match(context, /Работа над проектом/);
  assert.doesNotMatch(context, /Чувствительные сведения|Секретный переход|Устаревшее решение|Старый документ/);
  const about = memoryTools(store).find((tool) => tool.name === 'memory_about');
  const response = await about.run({ name: 'Проект Альфа' });
  assert.equal(response.data.some((item) => item.text === 'Чувствительные сведения'), false);
  assert.equal((await about.run({ name: 'Данные владельца' })).data.some((item) => item.text === 'Чувствительные сведения'), false);
});

test('граф не смешивает проекты, решения и материалы с разными номерами', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Первая версия', about: 'Проект Альфа 1', links: ['Решение релиз 1'] });
  store.add({ text: 'Вторая версия', about: 'Проект Альфа 2', links: ['Решение релиз 2'] });
  store.add({ text: 'Решение первой версии', about: 'Решение релиз 1' });
  store.add({ text: 'Решение второй версии', about: 'Решение релиз 2' });
  const context = memoryContext(store, 'Проект Альфа 1');
  assert.match(context, /Первая версия/);
  assert.match(context, /Решение первой версии/);
  assert.doesNotMatch(context, /Вторая версия|Решение второй версии/);
  assert.deepEqual(store.about('Проект Альфа 1').map((item) => item.text).sort(), ['Первая версия', 'Решение первой версии'].sort());
});

test('циклические связи не повторяют записи и соблюдают лимит контекста', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Основа', about: 'Проект Дельта', links: ['Решение Альфа'] });
  store.add({ text: 'Решение', about: 'Решение Альфа', links: ['Документ Бета', 'Проект Дельта'] });
  store.add({ text: 'Документ', about: 'Документ Бета', links: ['Проект Дельта'] });
  const items = store.relevant('Проект Дельта', 2);
  assert.equal(items.length, 2);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
});

test('противоречие: та же тема (about) и близкий текст дают предупреждение со старым id, старая запись остаётся', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const [remember, recall] = memoryTools(store);
  const first = await remember.run({ text: 'Иван живёт в Москве', about: 'Иван', kind: 'fact' });
  assert.equal(first.data.warning, undefined);

  const second = await remember.run({ text: 'Иван живёт в Питере', about: 'Иван', kind: 'fact' });
  assert.equal(second.ok, true);
  assert.match(second.data.warning, new RegExp(first.data.id));
  assert.equal(store.list().length, 2, 'старая не стёрта');
  assert.equal(store.get(first.data.id).text, 'Иван живёт в Москве');

  const other = await remember.run({ text: 'Кофе без сахара', about: 'Иван' });
  assert.equal(other.data.warning, undefined, 'другая тема не противоречие');
  assert.equal((await recall.run({ query: 'живёт' })).data.length, 2);
});

test('sensitive: контекст не подставляет такие записи, на явный вопрос подставляет; recall без флага скрывает', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const [remember, recall] = memoryTools(store);
  await remember.run({ text: 'Паспорт серия 1234 номер 567890', about: 'Владелец', sensitive: true });

  assert.equal(memoryContext(store, 'покажи паспорт'), '', 'без вопроса не подставляет');
  assert.match(memoryContext(store, 'какой у меня паспорт?'), /1234/, 'на явный вопрос подставляет');
  assert.equal((await recall.run({ query: 'паспорт' })).data.length, 0);
  const explicit = await recall.run({ query: 'паспорт', includeSensitive: true });
  assert.equal(explicit.data[0].sensitive, true);
});

test('пароль и ключ API не записываются', async (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  const [remember] = memoryTools(store);

  assert.throws(() => store.add({ text: 'пароль: qwerty123' }), /пароль или ключ/);
  assert.throws(() => store.add({ text: 'API key = abcd1234' }), /пароль или ключ/);
  assert.throws(() => store.add({ text: 'ключ sk-proj-AbC123xyz789QwErTy' }), /пароль или ключ/);
  assert.throws(() => store.add({ text: 'Z9xQ7mKp2LwR8tYv3NcB1d' }), /пароль или ключ/);

  const res = await remember.run({ text: 'пароль: hunter22', about: 'почта' });
  assert.equal(res.ok, false);
  assert.deepEqual(store.list(), []);

  store.add({ text: 'Пароль от почты лежит в менеджере' });
  assert.equal(store.list().length, 1, 'сама мысль о пароле без значения записывается');
});

test('профиль и договорённости не протухают по давности, обычная заметка старше 90 дней — протухает', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  writeItems(file, [
    { id: 'p1', text: 'Обращаться на вы, по имени-отчеству', kind: 'profile', createdAt: daysAgo(400) },
    { id: 'a1', text: 'Отчёты присылать по утрам', kind: 'agreement', createdAt: daysAgo(400) },
    { id: 'n1', text: 'Кафе на Ленина работает до девяти', kind: 'note', createdAt: daysAgo(120) },
  ]);
  const store = new MemoryStore(file);

  assert.deepEqual(store.profile().map((r) => r.id), ['p1', 'a1'], 'профиль и договорённость видны всегда');
  assert.match(profileNote(store), /Обращаться на вы/);
  assert.deepEqual(store.search('кафе'), [], 'заметка, которую давно не вспоминали, не отдаётся');
  assert.equal(store.search('кафе', 5, { includeExpired: true }).length, 1, 'но открыть её можно явно');
});

test('заметку, которую вспоминали недавно, не протухает; вспоминание отмечается в файле', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  writeItems(file, [
    { id: 'n1', text: 'Любимый чай зелёный', kind: 'note', createdAt: daysAgo(200), usedAt: daysAgo(10) },
    { id: 'n2', text: 'Кофе без сахара', kind: 'note', createdAt: daysAgo(30) },
  ]);
  const store = new MemoryStore(file);

  assert.deepEqual(store.search('чай').map((r) => r.id), ['n1'], 'вспоминали 10 дней назад — жива, хоть создана 200 дней назад');
  store.search('кофе');
  const stamped = JSON.parse(fs.readFileSync(file, 'utf8')).items.find((i) => i.id === 'n2').usedAt;
  assert.ok(stamped && Date.now() - Date.parse(stamped) < DAY, 'найденная заметка получила свежую отметку usedAt');
});

test('профиль не протухает и не попадает в заметки по словам; в профиле не бывает чувствительного', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  store.add({ text: 'Пишу по-русски, коротко', kind: 'profile' });
  store.add({ text: 'Паспорт серия 1234', about: 'Владелец', sensitive: true, kind: 'profile' });

  assert.equal(store.profile().length, 1, 'чувствительное в профиль не идёт');
  assert.equal(store.search('паспорт').length, 0);
  assert.equal(backgroundBrief(store, 'паспорт').includes('1234'), false, 'фон не получает чувствительное');
});

test('контекст: до 8 заметок по 300 символов', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  for (let i = 0; i < 10; i++) store.add({ text: `Проект номер ${i} ${'я'.repeat(400)}` });

  const lines = memoryContext(store, 'проект').split('\n');
  assert.equal(lines.length, 9, 'заголовок и ровно 8 заметок');
  for (const line of lines.slice(1)) {
    assert.equal(Array.from(line.slice(2)).length, 300, 'каждая заметка обрезана до 300 символов');
  }
});

test('профиль идёт не больше 12 записей', (t) => {
  const store = new MemoryStore(path.join(tempDir(t), 'memory.json'));
  for (let i = 0; i < 15; i++) store.add({ text: `Договорённость ${i}`, kind: 'agreement' });
  assert.equal(store.profile().length, 12);
  assert.equal(store.profile().at(-1).text, 'Договорённость 14', 'самые новые');
});

test('фоновый промпт содержит профиль владельца в каждом запросе', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  store.add({ text: 'Владельца зовут Николай Андреевич, обращаться на вы', kind: 'profile' });
  const sent = [];
  const brain = {
    async chat({ messages }) {
      sent.push(messages[0].content);
      return { content: 'Готово', reasoningContent: null, toolCalls: [] };
    },
  };
  await runMission({ id: 'm1', goal: 'Проверить папку отчётов' }, {
    brain,
    tools: new ToolRegistry(),
    journal: { append() {} },
    workspace: dir,
    reportsDir: path.join(dir, 'reports'),
    memory: store,
  });

  assert.ok(sent.length > 0, 'модель вызвана');
  assert.ok(sent.every((text) => text.includes('обращаться на вы')), 'профиль есть в системном промпте фона');
  assert.ok(sent.every((text) => text.includes('Сейчас:')), 'время осталось на месте');
});

test('повреждённая память не ломает промпт и фон: блока нет, ход идёт', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const store = new MemoryStore(file);
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });

  assert.equal(profileNote(store), '');
  assert.equal(backgroundBrief(store, 'проверить папку'), '');
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json', 'файл не перезаписан');
});

test('remember с источником: сохраняет путь, sha256, размер, время и цитату; verify подтверждает', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);
  const content = '# План\nВыпуск в декабре.\n';
  const abs = writeFileIn(dir, 'notes/plan.md', content);

  const saved = await remember.run(
    { text: 'Выпуск намечен на декабрь', kind: 'fact', about: 'Проект Альфа', source: 'notes/plan.md', quote: 'Выпуск в декабре.' },
    { workspace: dir }
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.data.source.path, 'notes/plan.md');
  assert.equal(saved.data.source.size, Buffer.byteLength(content));
  assert.equal(saved.data.source.sha256, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
  assert.equal(new Date(saved.data.source.at).toISOString(), saved.data.source.at, 'время источника — настоящая дата');
  assert.equal(saved.data.source.quote, 'Выпуск в декабре.');

  const stored = store.get(saved.data.id);
  assert.deepEqual(stored.source, saved.data.source);
  assert.equal(stored.text, 'Выпуск намечен на декабрь');

  const verdict = await remember.verify({}, saved, { workspace: dir });
  assert.equal(verdict.status, 'confirmed');
  assert.match(verdict.evidence, /sha256/);
});

test('recall и memory_about показывают источник и его проверку; контекст даёт короткую ссылку', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember, recall, , about] = memoryTools(store);
  writeFileIn(dir, 'notes/plan.md', 'Утверждён план на декабрь');
  const saved = await remember.run({ text: 'План на декабрь утверждён', about: 'Проект Альфа', source: 'notes/plan.md' }, { workspace: dir });
  assert.equal(saved.ok, true);

  const found = await recall.run({ query: 'план' }, { workspace: dir });
  assert.equal(found.ok, true);
  assert.equal(found.data[0].source.path, 'notes/plan.md');
  assert.equal(found.data[0].sourceState.state, 'unchanged');
  assert.match(found.data[0].sourceState.summary, /на месте, не менялся/);
  assert.equal(found.data[0].text, 'План на декабрь утверждён', 'текст записи не подменяется состоянием файла');

  const info = await about.run({ name: 'Проект Альфа' }, { workspace: dir });
  assert.equal(info.data[0].source.path, 'notes/plan.md');
  assert.equal(info.data[0].sourceState.state, 'unchanged');
  assert.match(info.data[0].sourceState.summary, /на месте/);

  assert.match(memoryContext(store, 'что с планом'), /источник: notes\/plan\.md/);
});

test('изменённый файл-источник: recall говорит «файл изменился», verify провален', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember, recall] = memoryTools(store);
  writeFileIn(dir, 'notes/plan.md', 'План: выпуск в декабре');
  const saved = await remember.run({ text: 'Выпуск в декабре', source: 'notes/plan.md' }, { workspace: dir });

  writeFileIn(dir, 'notes/plan.md', 'План: выпуск перенесён на январь');

  const found = await recall.run({ query: 'выпуск' }, { workspace: dir });
  assert.equal(found.data[0].sourceState.state, 'changed');
  assert.match(found.data[0].sourceState.summary, /изменился/);
  assert.equal(found.data[0].text, 'Выпуск в декабре', 'факт из записи не подменяется');

  const verdict = await remember.verify({}, saved, { workspace: dir });
  assert.equal(verdict.status, 'failed');
  assert.match(verdict.evidence, /изменился/);
});

test('пропавший файл-источник: recall говорит «файла нет», verify провален', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember, recall] = memoryTools(store);
  const abs = writeFileIn(dir, 'notes/plan.md', 'План: выпуск в декабре');
  const saved = await remember.run({ text: 'Выпуск в декабре', source: 'notes/plan.md' }, { workspace: dir });
  fs.rmSync(abs);

  const found = await recall.run({ query: 'выпуск' }, { workspace: dir });
  assert.equal(found.data[0].sourceState.state, 'missing');
  assert.match(found.data[0].sourceState.summary, /файла нет/);

  const verdict = await remember.verify({}, saved, { workspace: dir });
  assert.equal(verdict.status, 'failed');
  assert.match(verdict.evidence, /файла-источника нет/);
});

test('источник вне рабочей папки: отказ, запись не создаётся', async (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'чужое', 'utf8');
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);

  for (const source of [`../${path.basename(outside)}/secret.md`, path.join(outside, 'secret.md')]) {
    const res = await remember.run({ text: 'чужой файл', source }, { workspace: dir });
    assert.equal(res.ok, false, source);
    assert.match(res.summary, /вне рабочей папки/, source);
  }
  assert.deepEqual(store.list(), [], 'ни одной записи не появилось');
});

test('источник — ссылка: отказ, запись не создаётся', async (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'чужое', 'utf8');
  const link = path.join(dir, 'link.md');
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), link, 'file');
  } catch (err) {
    // Windows без режима разработчика и без прав администратора не создаёт symlink на файл.
    return t.skip(`ОС не дала создать symlink на файл: ${err.code || err.message}`);
  }
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);

  const res = await remember.run({ text: 'по ссылке', source: 'link.md' }, { workspace: dir });
  assert.equal(res.ok, false);
  assert.match(res.summary, /ссылка/);
  assert.deepEqual(store.list(), [], 'запись не создана');
});

test('источник через junction наружу: отказ, запись не создаётся', async (t) => {
  const dir = tempDir(t);
  const outside = tempDir(t);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'чужое', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(dir, 'jn'), 'junction');
  } catch (err) {
    // Junction доступен не везде; symlink на файл проверен выше.
    return t.skip(`ОС не дала создать junction: ${err.code || err.message}`);
  }
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);

  const res = await remember.run({ text: 'через junction', source: 'jn/secret.md' }, { workspace: dir });
  assert.equal(res.ok, false);
  assert.match(res.summary, /за пределы рабочей папки/);
  assert.deepEqual(store.list(), [], 'запись не создана');
});

test('файл-источник больше 8 МБ: отказ, запись не создаётся', async (t) => {
  const dir = tempDir(t);
  const big = path.join(dir, 'big.txt');
  const fd = fs.openSync(big, 'w');
  try {
    fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1);
  } finally {
    fs.closeSync(fd);
  }
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);

  const res = await remember.run({ text: 'большой файл', source: 'big.txt' }, { workspace: dir });
  assert.equal(res.ok, false);
  assert.match(res.summary, /больше 8 МБ/);
  assert.deepEqual(store.list(), [], 'запись не создана');
});

test('память хранит ссылку и хеш, а не содержимое файла', async (t) => {
  const dir = tempDir(t);
  const content = 'Секретная строка содержимого: выпуск переносится на январь.';
  writeFileIn(dir, 'notes/plan.md', content);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);
  await remember.run({ text: 'Выпуск переносится на январь', source: 'notes/plan.md' }, { workspace: dir });

  const raw = fs.readFileSync(path.join(dir, 'memory.json'), 'utf8');
  assert.doesNotMatch(raw, /Секретная строка содержимого/);
  assert.match(raw, /notes\/plan\.md/);
  assert.equal(store.list()[0].source.size, Buffer.byteLength(content));
});

test('старая запись без source читается и работает; source не появляется сам', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'memory.json');
  // Дата свежая (час назад): старая заметка по новому сроку давности уже протухла бы и пропала из поиска.
  const old = {
    items: [{
      id: 'old-1',
      text: 'Сестру зовут Аня',
      kind: 'fact',
      about: 'Аня',
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }],
  };
  fs.writeFileSync(file, JSON.stringify(old), 'utf8');
  const store = new MemoryStore(file);
  const [, recall, , about] = memoryTools(store);

  assert.deepEqual(store.list(), old.items);
  const found = await recall.run({ query: 'Аня' }, { workspace: dir });
  assert.equal(found.data[0].text, 'Сестру зовут Аня');
  assert.equal(found.data[0].source, undefined);
  assert.equal(found.data[0].sourceState, undefined);

  const info = await about.run({ name: 'Аня' }, { workspace: dir });
  assert.equal(info.data[0].source, undefined);
  assert.equal(info.data[0].sourceState, undefined);
});

test('неверная форма source при чтении не выдаётся за источник, другие поля целы', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'memory.json');
  const item = {
    id: 'broken-1',
    text: 'Факт со ссылкой',
    kind: 'fact',
    about: 'Тема',
    createdAt: new Date().toISOString(),
    extra: 'постороннее поле',
    source: { path: '../outside.md', sha256: 'нет', size: 'много' },
  };
  fs.writeFileSync(file, JSON.stringify({ items: [item] }), 'utf8');
  const store = new MemoryStore(file);

  const loaded = store.get('broken-1');
  assert.equal(loaded.source, undefined, 'непроверяемая ссылка не показывается');
  assert.equal(loaded.extra, 'постороннее поле', 'остальные поля не потеряны');
  assert.equal(loaded.about, 'Тема');
});

test('store.add: неверная форма source отклоняется, правильная сохраняется', (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const at = new Date().toISOString();

  assert.throws(() => store.add({ text: 'x', source: { path: 'a.md' } }), /источник/);
  assert.throws(
    () => store.add({ text: 'x', source: { path: '/abs/a.md', sha256: 'a'.repeat(64), size: 1, at } }),
    /источник/,
    'абсолютный путь не храним'
  );
  assert.throws(
    () => store.add({ text: 'x', source: { path: 'a.md', sha256: 'short', size: 1, at } }),
    /источник/,
    'sha256 проверяется по форме'
  );

  const saved = store.add({
    text: 'правильная ссылка',
    source: { path: 'notes\\a.md', sha256: 'b'.repeat(64), size: 12, at, quote: 'цитата' },
  });
  assert.equal(saved.source.path, 'notes/a.md', 'путь хранится через «/»');
  assert.equal(saved.source.quote, 'цитата');
  assert.equal(store.get(saved.id).source.path, 'notes/a.md');
});

test('verify: без источника запись подтверждается, при недоступной проверке — unknown', async (t) => {
  const dir = tempDir(t);
  const store = new MemoryStore(path.join(dir, 'memory.json'));
  const [remember] = memoryTools(store);

  const plain = await remember.run({ text: 'купить чай' });
  assert.equal((await remember.verify({}, plain, { workspace: dir })).status, 'confirmed');

  writeFileIn(dir, 'notes/a.md', 'текст');
  const linked = await remember.run({ text: 'факт из файла', source: 'notes/a.md' }, { workspace: dir });
  const unchecked = await remember.verify({}, linked, {});
  assert.equal(unchecked.status, 'unknown');
  assert.match(unchecked.evidence, /не удалось|нет рабочей папки/);
});

// ── API просмотра и правки памяти (этап 3) ────────────────────────────────────
// Экран памяти получит list/update/remove/clear от main.js; сами функции живут в store,
// чтобы их можно было проверить без окна и IPC.

test('update: правка меняет перечисленные поля, id и createdAt остаются, запись переживает перезапуск', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const store = new MemoryStore(file);
  const created = store.add({ text: 'Живу в Бишкеке', kind: 'profile', about: 'город' });

  const updated = store.update(created.id, { text: 'Живу в Оше', kind: 'fact', about: 'город2', links: ['работа'], until: '2027-01-01', sensitive: false });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.text, 'Живу в Оше');
  assert.equal(updated.kind, 'fact');
  assert.equal(updated.about, 'город2');
  assert.deepEqual(updated.links, ['работа']);
  assert.equal(updated.until, '2027-01-01');
  assert.equal(updated.sensitive, undefined);
  assert.equal(new Date(updated.updatedAt).toISOString(), updated.updatedAt, 'правка помечена временем');

  const restarted = new MemoryStore(file);
  assert.equal(restarted.get(created.id).text, 'Живу в Оше', 'правка сохранена на диск');
  assert.equal(store.update('нет-такого', { text: 'x' }), null);
});

test('update: пустой текст, секрет и плохая дата отклоняются, файл не меняется', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const store = new MemoryStore(file);
  const created = store.add({ text: 'Факт' });
  const before = fs.readFileSync(file, 'utf8');

  assert.throws(() => store.update(created.id, { text: '  ' }), /пустой/);
  assert.throws(() => store.update(created.id, { text: 'пароль: qwerty123' }), /пароль или ключ/);
  assert.throws(() => store.update(created.id, { until: 'не дата' }), /срок/);
  assert.throws(() => store.update(created.id, null), /объект/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'после отказа файл не переписан');
  assert.equal(store.get(created.id).text, 'Факт');
});

test('update: чувствительное можно пометить и снять; после правки поиск снова видит запись', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const store = new MemoryStore(file);
  const created = store.add({ text: 'Заметка о встрече' });
  store.update(created.id, { sensitive: true });
  assert.equal(store.search('встрече').length, 0, 'помеченная запись скрыта от поиска');
  store.update(created.id, { sensitive: false });
  assert.equal(store.search('встрече').length, 1, 'снятая пометка возвращает запись в поиск');
});

test('clear: очищает память одного пространства и не трогает соседнее; отсутствие файла — пусто', (t) => {
  const dir = tempDir(t);
  const commonFile = path.join(dir, 'memory.json');
  const spaceFile = path.join(dir, 'workspaces', 'ws-1', 'memory.json');
  const common = new MemoryStore(commonFile);
  const space = new MemoryStore(spaceFile);
  common.add({ text: 'общая заметка' });
  common.add({ text: 'вторая общая' });
  space.add({ text: 'заметка пространства' });

  assert.equal(space.clear(), 1);
  assert.equal(space.count(), 0);
  assert.equal(common.count(), 2, 'очистка одного файла не задевает другой');
  assert.equal(common.clear(), 2);
  assert.equal(common.count(), 0);

  const missing = new MemoryStore(path.join(dir, 'no-such-memory.json'));
  assert.equal(missing.clear(), 0, 'нет файла — нечего чистить, исключения нет');
  assert.equal(fs.existsSync(path.join(dir, 'no-such-memory.json')), false, 'пустой файл не создаётся');
});

test('clear: повреждённый файл не перезаписывается', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  fs.writeFileSync(file, '{не json', 'utf8');
  const store = new MemoryStore(file);
  assert.throws(() => store.clear(), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{не json');
});

test('list: по умолчанию видны все записи, явные флаги прячут чувствительное и просроченное', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  writeItems(file, [
    { id: 'n1', text: 'обычная', kind: 'note', createdAt: new Date().toISOString() },
    { id: 's1', text: 'паспорт 1234', kind: 'note', sensitive: true, createdAt: new Date().toISOString() },
    { id: 'e1', text: 'старая', kind: 'note', createdAt: daysAgo(200) },
  ]);
  const store = new MemoryStore(file);

  assert.deepEqual(store.list().map((r) => r.id).sort(), ['e1', 'n1', 's1'], 'без флагов отдаётся всё');
  assert.deepEqual(store.list(10, { includeSensitive: false }).map((r) => r.id).sort(), ['e1', 'n1']);
  assert.deepEqual(store.list(10, { includeExpired: false }).map((r) => r.id).sort(), ['n1', 's1']);
  assert.deepEqual(store.list(10, { includeSensitive: false, includeExpired: false }).map((r) => r.id), ['n1']);
  assert.equal(store.count(), 3);
});

test('память: здоровье, платёж и код с пометкой sensitive скрыты от поиска и контекста', (t) => {
  const file = path.join(tempDir(t), 'memory.json');
  const store = new MemoryStore(file);
  // Явная запись хранит такие факты только по решению владельца (флаг sensitive);
  // авто-память их не пишет вовсе — это проверяет tests/memory-learn.test.js.
  store.add({ text: 'Диабет второго типа', sensitive: true });
  store.add({ text: 'Перевод за квартиру 5000 рублей', sensitive: true });
  store.add({ text: 'Код от домофона 4821', sensitive: true });

  assert.equal(store.search('диабет').length, 0);
  assert.equal(store.search('перевод').length, 0);
  assert.equal(store.search('домофон').length, 0);
  assert.equal(store.search('диабет', 5, { includeSensitive: true }).length, 1);
  assert.equal(store.list(10, { includeSensitive: false }).length, 0);
});
