'use strict';

// Каталог MCP-серверов: статические данные, строгая проверка записей, фильтр, конфиг без секретов
// и сверка окна «Популярные» (renderer/connections.js) с каталогом: список не должен разойтись.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  CATALOG,
  CATEGORIES,
  validateCatalog,
  listCatalog,
  catalogCategories,
  getCatalogEntry,
  toServerConfig,
} = require('../src/mcp/catalog');
const { normalizeServerConfig, validateName, validateCommand, validateArgs } = require('../src/mcp/client');

const APP = path.join(__dirname, '..');

// Валидная запись для проверки испорченных вариантов.
function baseEntry() {
  return {
    id: 'base',
    title: 'База',
    description: 'Проверочная запись.',
    category: 'files',
    transport: 'stdio',
    command: 'npx.cmd',
    args: ['-y', 'pkg'],
    verified: true,
  };
}

test('каталог: 30–40 реальных записей, поля на месте, секретов в данных нет', () => {
  assert.ok(CATALOG.length >= 30, `записей ${CATALOG.length}, нужно не меньше 30`);
  assert.ok(CATALOG.length <= 40, `записей ${CATALOG.length}, нужно не больше 40`);
  for (const entry of CATALOG) {
    for (const field of ['id', 'title', 'description', 'category', 'transport', 'verified']) {
      assert.ok(entry[field] !== undefined, `${entry.id || '?'}: нет поля ${field}`);
    }
    assert.ok(['stdio', 'http'].includes(entry.transport), `${entry.id}: транспорт ${entry.transport}`);
    assert.ok(Array.isArray(entry.args), `${entry.id}: args — список`);
    assert.ok(Array.isArray(entry.envKeys), `${entry.id}: envKeys — список`);
    // Значений секретов в каталоге нет: только имена ключей и только для stdio.
    assert.equal(entry.env, undefined, `${entry.id}: значение env попало в каталог`);
    assert.equal(entry.headers, undefined, `${entry.id}: заголовки попадают в каталог`);
    if (entry.transport === 'stdio') {
      assert.equal(validateCommand(entry.command).ok, true, `${entry.id}: команда`);
      assert.equal(validateArgs(entry.args).ok, true, `${entry.id}: аргументы`);
    } else {
      assert.equal(entry.command, undefined, `${entry.id}: у http-записи не должно быть команды`);
      assert.equal(normalizeServerConfig({ url: entry.url }).ok, true, `${entry.id}: адрес`);
      assert.equal(entry.envKeys.length, 0, `${entry.id}: у http-записи не должно быть env-ключей`);
    }
    if (entry.docs !== undefined) assert.match(entry.docs, /^https?:\/\//, `${entry.id}: ссылка на документацию`);
  }
  assert.equal(validateCatalog(CATALOG), true);
});

test('каталог: обещанные серверы есть (файлы, git, sqlite, github, playwright, fetch, memory, time, sequential-thinking)', () => {
  for (const id of ['filesystem', 'git', 'sqlite', 'github', 'playwright', 'fetch', 'memory', 'time', 'sequential-thinking']) {
    assert.ok(getCatalogEntry(id), `нет записи «${id}»`);
  }
});

test('каталог: id уникальны, в нижнем регистре и годятся как имена сервисов MCP', () => {
  const ids = CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'id повторяются');
  for (const id of ids) {
    assert.equal(validateName(id).ok, true, `имя «${id}» не пройдёт проверку клиента`);
    assert.equal(id, id.toLowerCase(), `id «${id}» должен быть в нижнем регистре`);
  }
});

test('категории: известные, подписаны и сходятся по числу записей', () => {
  const categories = catalogCategories();
  assert.ok(Array.isArray(categories) || typeof categories === 'object');
  assert.equal(categories.length, CATEGORIES.length);
  const ids = new Set();
  let total = 0;
  for (const category of categories) {
    assert.equal(ids.has(category.id), false, `категория «${category.id}» повторяется`);
    ids.add(category.id);
    assert.ok(String(category.title || '').trim(), `у категории «${category.id}» нет подписи`);
    assert.equal(category.count, listCatalog({ category: category.id }).length, `счётчик «${category.id}» расходится со списком`);
    total += category.count;
  }
  assert.equal(total, CATALOG.length);
  for (const entry of CATALOG) assert.ok(ids.has(entry.category), `неизвестная категория «${entry.category}»`);
});

test('фильтр: по тексту, категории и вместе; регистр не важен, неизвестное — пустой список', () => {
  assert.equal(listCatalog().length, CATALOG.length);
  assert.equal(listCatalog({}).length, CATALOG.length);
  assert.equal(listCatalog({ category: 'all' }).length, CATALOG.length);
  assert.ok(listCatalog({ query: 'playwright' }).some((entry) => entry.id === 'playwright'));
  assert.ok(listCatalog({ query: 'БРАУЗЕР' }).length > 0, 'поиск по подписи категории');
  assert.ok(listCatalog({ query: '@modelcontextprotocol/server-memory' }).some((entry) => entry.id === 'memory'), 'поиск по аргументам');
  const data = listCatalog({ category: 'data' });
  assert.ok(data.length > 0);
  assert.ok(data.every((entry) => entry.category === 'data'));
  assert.deepEqual(listCatalog({ category: 'нет-такой' }), []);
  assert.deepEqual(listCatalog({ query: 'такого-сервера-точно-нет-987' }), []);
  assert.deepEqual(listCatalog({ query: 'playwright', category: 'data' }), []);
  assert.ok(listCatalog({ query: 'playwright', category: 'browser' }).some((entry) => entry.id === 'playwright'));
  assert.equal(Object.isFrozen(listCatalog()), true, 'результат не должен меняться снаружи');
  assert.throws(() => listCatalog('playwright'), /фильтр/);
  assert.throws(() => listCatalog({ query: 5 }), /query/);
  assert.throws(() => listCatalog({ category: 5 }), /category/);
});

test('getCatalogEntry: известная запись неизменяема, неизвестная — null', () => {
  const entry = getCatalogEntry('filesystem');
  assert.equal(entry.id, 'filesystem');
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(getCatalogEntry('нет-такой'), null);
  assert.equal(getCatalogEntry(null), null);
  assert.equal(getCatalogEntry(''), null);
});

test('toServerConfig: конфиг проходит проверку клиента и не содержит значений секретов', () => {
  for (const entry of CATALOG) {
    const config = toServerConfig(entry);
    const checked = normalizeServerConfig(config);
    assert.equal(checked.ok, true, `${entry.id}: ${checked.error}`);
    assert.equal(config.headers, undefined, `${entry.id}: заголовки с секретами`);
    if (entry.transport === 'stdio') {
      assert.equal(config.command, entry.command);
      assert.deepEqual(config.args, entry.args);
      if (entry.envKeys.length) {
        assert.deepEqual(Object.keys(config.env).sort(), entry.envKeys.slice().sort(), `${entry.id}: имена env-ключей`);
        for (const value of Object.values(config.env)) {
          assert.equal(value, '', `${entry.id}: значение секрета подставлено`);
        }
      } else {
        assert.equal(config.env, undefined, `${entry.id}: лишние env`);
      }
    } else {
      assert.equal(config.url, entry.url);
    }
    // Никаких длинных значений, похожих на готовый ключ.
    for (const value of Object.values(config)) {
      if (typeof value === 'string') assert.ok(value.length <= 400, `${entry.id}: подозрительно длинное значение`);
    }
  }
  assert.throws(() => toServerConfig('нет-такой'), /неизвестная запись/);
  // Посторонние поля и значения из объекта-клона не попадают в конфиг.
  assert.deepEqual(
    toServerConfig({ id: 'filesystem', command: 'злая-команда', env: { SECRET: 'готовый-ключ' } }),
    toServerConfig('filesystem'),
  );
});

test('пометки честные: verified:false означает «не проверено», имена ключей видны в описании', () => {
  for (const entry of CATALOG) {
    if (entry.verified !== true) {
      assert.match(entry.description, /не проверено/, `${entry.id}: у непроверенной записи нет пометки`);
    }
    for (const key of entry.envKeys) {
      assert.ok(entry.description.includes(key), `${entry.id}: ключ ${key} не упомянут в описании`);
    }
  }
});

test('строгая проверка ловит испорченные записи', () => {
  const good = baseEntry();
  assert.equal(validateCatalog([good]), true);
  const bad = (change) => () => validateCatalog([{ ...baseEntry(), ...change }]);
  assert.throws(() => validateCatalog([]), /непустой список/);
  assert.throws(bad({ id: 'Плохое Имя' }), /id/);
  assert.throws(bad({ id: 'BASE' }), /id/);
  assert.throws(bad({ transport: 'sse' }), /transport/);
  assert.throws(bad({ command: '' }), /команда/);
  assert.throws(bad({ command: 'node & calc' }), /символ оболочки/);
  assert.throws(bad({ args: ['-y', 'a&b'] }), /символ оболочки/);
  assert.throws(bad({ category: 'нет-такой' }), /категория/);
  assert.throws(bad({ verified: 'да' }), /verified/);
  assert.throws(bad({ url: 'https://example.com/mcp' }), /адрес не нужен/);
  assert.throws(bad({ env: { SECRET: 'значение' } }), /неизвестное поле «env»/);
  assert.throws(bad({ envKeys: ['плохое имя'] }), /переменной окружения/);
  assert.throws(bad({ envKeys: ['GOOD_KEY'] }), /не упомянуто в description/);
  assert.throws(bad({ docs: 'ftp://example.com/page' }), /адрес только http/);
  assert.throws(bad({ title: '' }), /title/);
  assert.throws(bad({ description: '' }), /description/);
  // http: без адреса нельзя, с командой тоже.
  assert.throws(() => validateCatalog([{ ...baseEntry(), transport: 'http', command: undefined, args: undefined }]), /нужен адрес/);
  assert.throws(() => validateCatalog([{ ...baseEntry(), transport: 'http', url: 'https://example.com/mcp' }]), /команда не нужна/);
  // Дубль id и дубль запуска ловятся отдельно.
  assert.throws(() => validateCatalog([good, { ...baseEntry(), args: ['-y', 'другой'] }]), /повторяется/);
  assert.throws(() => validateCatalog([good, { ...baseEntry(), id: 'base2' }]), /такой же запуск/);
});

test('настройки по умолчанию: каталог раскладывается в mcpServers без дублей', () => {
  // main.js читает settings.mcpServers, по умолчанию {}. Проверяем, что весь каталог
  // ложится в настройки уникальными именами и каждый конфиг принимается клиентом.
  const servers = {};
  for (const entry of CATALOG) {
    assert.equal(servers[entry.id], undefined, `имя «${entry.id}» занято дважды`);
    const checked = normalizeServerConfig(toServerConfig(entry));
    assert.equal(checked.ok, true, `${entry.id}: ${checked.error}`);
    servers[entry.id] = checked.config;
  }
  assert.equal(Object.keys(servers).length, CATALOG.length);
  assert.equal(Object.keys(servers).every((name) => validateName(name).ok), true);
});

test('окно «Популярные» сверено с каталогом: id, команда и аргументы не разошлись, секретов нет', () => {
  const source = fs.readFileSync(path.join(APP, 'renderer', 'connections.js'), 'utf8');
  // Список размечен комментариями, чтобы тест не читал чужие данные окна.
  const block = source.match(/\/\/ ── начало списка популярных([\s\S]*?)\/\/ ── конец списка популярных/);
  assert.ok(block, 'в renderer/connections.js нет размеченного списка популярных');
  const items = [...block[1].matchAll(/\{\s*id:\s*'([^']+)',\s*title:\s*'([^']+)',\s*hint:\s*'[^']*',\s*target:\s*'([^']+)',\s*args:\s*'([^']*)'\s*\}/g)]
    .map((match) => ({ id: match[1], title: match[2], target: match[3], args: match[4] }));
  assert.ok(items.length > 0, 'список популярных пуст');
  assert.equal(new Set(items.map((item) => item.id)).size, items.length, 'в популярных повторяются id');
  for (const item of items) {
    const entry = getCatalogEntry(item.id);
    assert.ok(entry, `в популярных есть «${item.id}», которого нет в каталоге`);
    assert.ok(item.title.trim(), `${item.id}: пустая подпись`);
    // Кнопка «Добавить» не должна подставлять ключи: в популярные попадают только записи без env.
    assert.equal(entry.envKeys.length, 0, `${item.id}: сервис с ключами не место в популярных`);
    assert.equal(entry.verified, true, `${item.id}: непроверенный сервис не место в популярных`);
    const config = toServerConfig(entry);
    assert.equal(config.command, item.target, `${item.id}: команда в окне разошлась с каталогом`);
    assert.equal(config.args.join(' '), item.args, `${item.id}: аргументы в окне разошлись с каталогом`);
  }
  // Добавление идёт через существующий мост mcp:add, а не новым каналом.
  assert.match(source, /api\.mcpAdd\(/, 'кнопка «Добавить» должна вызывать mcpAdd');
  assert.ok(source.includes('Популярные'), 'нет подписи раздела «Популярные»');
});
