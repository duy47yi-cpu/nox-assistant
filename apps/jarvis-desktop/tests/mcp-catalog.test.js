'use strict';

// Каталог MCP-серверов: 80 записей, строгая проверка, фильтр, конфиг без секретов,
// сверка окна «Популярные» и сгенерированных значков/снимка каталога с ядром.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  CATALOG,
  CATEGORIES,
  FEATURED,
  MAX_ENTRIES,
  validateCatalog,
  listCatalog,
  catalogCategories,
  getCatalogEntry,
  toServerConfig,
} = require('../src/mcp/catalog');
const { normalizeServerConfig, validateName, validateCommand, validateArgs } = require('../src/mcp/client');

const APP = path.join(__dirname, '..');
const AETHER = path.join(APP, 'renderer', 'aether');
const LOGOS_FILE = path.join(AETHER, 'mcp-logos.js');
const VIEW_FILE = path.join(AETHER, 'components', 'mcp-view.js');
const FETCH_FILE = path.join(APP, 'scripts', 'fetch-mcp-logos.js');
const LOGOS_TEXT = fs.readFileSync(LOGOS_FILE, 'utf8');
const VIEW_TEXT = fs.readFileSync(VIEW_FILE, 'utf8');

// Значения секретов: длинные строки, похожие на готовые ключи. В каталоге их быть не должно.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]+KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

function assertNoSecrets(text, where) {
  for (const pattern of SECRET_PATTERNS) {
    assert.doesNotMatch(text, pattern, where + ': похоже на значение секрета');
  }
}

function loadLogos() {
  const sandbox = { window: {} };
  vm.runInNewContext(LOGOS_TEXT, sandbox, { filename: 'mcp-logos.js', timeout: 5000 });
  assert.ok(sandbox.window.NoxMcpLogos, 'mcp-logos.js должен выставить window.NoxMcpLogos');
  return sandbox.window.NoxMcpLogos;
}

function iconNames() {
  const source = fs.readFileSync(path.join(AETHER, 'icons.js'), 'utf8');
  const block = source.match(/const ICONS = \{([\s\S]*?)\n  \};/);
  assert.ok(block, 'в icons.js нет набора ICONS');
  return new Set([...block[1].matchAll(/^    (\w+): \[/gm)].map((match) => match[1]));
}

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

test('каталог: ровно 75 реальных записей, поля на месте, секретов в данных нет', () => {
  assert.equal(CATALOG.length, 75, 'в каталоге должно быть ровно 75 записей');
  assert.equal(MAX_ENTRIES, 75);
  for (const entry of CATALOG) {
    for (const field of ['id', 'title', 'description', 'category', 'transport', 'verified']) {
      assert.ok(entry[field] !== undefined, (entry.id || '?') + ': нет поля ' + field);
    }
    assert.ok(['stdio', 'http'].includes(entry.transport), entry.id + ': транспорт ' + entry.transport);
    assert.ok(Array.isArray(entry.args), entry.id + ': args — список');
    assert.ok(Array.isArray(entry.envKeys), entry.id + ': envKeys — список');
    // Значений секретов в каталоге нет: только имена ключей и только для stdio.
    assert.equal(entry.env, undefined, entry.id + ': значение env попало в каталог');
    assert.equal(entry.headers, undefined, entry.id + ': заголовки попадают в каталог');
    if (entry.transport === 'stdio') {
      assert.equal(validateCommand(entry.command).ok, true, entry.id + ': команда');
      assert.equal(validateArgs(entry.args).ok, true, entry.id + ': аргументы');
      assert.ok(['npx.cmd', 'uvx'].includes(entry.command), entry.id + ': запуск только npx.cmd или uvx');
      if (entry.command === 'npx.cmd') assert.equal(entry.args[0], '-y', entry.id + ': у npx первым идёт -y');
    } else {
      assert.equal(entry.command, undefined, entry.id + ': у http-записи не должно быть команды');
      assert.equal(normalizeServerConfig({ url: entry.url }).ok, true, entry.id + ': адрес');
      assert.equal(entry.envKeys.length, 0, entry.id + ': у http-записи не должно быть env-ключей');
    }
    if (entry.docs !== undefined) assert.match(entry.docs, /^https:\/\//, entry.id + ': ссылка на документацию');
    // Описание — по-русски; название может быть именем сервиса.
    assert.match(entry.description, /[А-Яа-яЁё]/, entry.id + ': description должен быть на русском');
  }
  assert.equal(validateCatalog(CATALOG), true);
  assertNoSecrets(JSON.stringify(CATALOG), 'каталог');
});

test('каталог: обещанные серверы есть (git, sqlite, github, playwright, fetch, memory, time, sequential-thinking)', () => {
  for (const id of ['git', 'sqlite', 'github', 'playwright', 'fetch', 'memory', 'time', 'sequential-thinking']) {
    assert.ok(getCatalogEntry(id), 'нет записи «' + id + '»');
  }
});

test('каталог: id уникальны, в нижнем регистре и годятся как имена сервисов MCP', () => {
  const ids = CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'id повторяются');
  for (const id of ids) {
    assert.equal(validateName(id).ok, true, 'имя «' + id + '» не пройдёт проверку клиента');
    assert.equal(id, id.toLowerCase(), 'id «' + id + '» должен быть в нижнем регистре');
  }
});

test('категории: известные, подписаны, все непустые и сходятся по числу записей', () => {
  const categories = catalogCategories();
  assert.equal(categories.length, CATEGORIES.length);
  const ids = new Set();
  let total = 0;
  for (const category of categories) {
    assert.equal(ids.has(category.id), false, 'категория «' + category.id + '» повторяется');
    ids.add(category.id);
    assert.ok(String(category.title || '').trim(), 'у категории «' + category.id + '» нет подписи');
    assert.ok(category.count > 0, 'категория «' + category.id + '» пустая');
    assert.equal(category.count, listCatalog({ category: category.id }).length, 'счётчик «' + category.id + '» расходится со списком');
    total += category.count;
  }
  assert.equal(total, CATALOG.length);
  for (const entry of CATALOG) assert.ok(ids.has(entry.category), 'неизвестная категория «' + entry.category + '»');
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
  const entry = getCatalogEntry('git');
  assert.equal(entry.id, 'git');
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(getCatalogEntry('нет-такой'), null);
  assert.equal(getCatalogEntry(null), null);
  assert.equal(getCatalogEntry(''), null);
});

test('toServerConfig: конфиг проходит проверку клиента и не содержит значений секретов', () => {
  for (const entry of CATALOG) {
    const config = toServerConfig(entry);
    const checked = normalizeServerConfig(config);
    assert.equal(checked.ok, true, entry.id + ': ' + checked.error);
    assert.equal(config.headers, undefined, entry.id + ': заголовки с секретами');
    if (entry.transport === 'stdio') {
      assert.equal(config.command, entry.command);
      assert.deepEqual(config.args, entry.args);
      if (entry.envKeys.length) {
        assert.deepEqual(Object.keys(config.env).sort(), entry.envKeys.slice().sort(), entry.id + ': имена env-ключей');
        for (const value of Object.values(config.env)) {
          assert.equal(value, '', entry.id + ': значение секрета подставлено');
        }
      } else {
        assert.equal(config.env, undefined, entry.id + ': лишние env');
      }
    } else {
      assert.equal(config.url, entry.url);
    }
    // Никаких длинных значений, похожих на готовый ключ.
    for (const value of Object.values(config)) {
      if (typeof value === 'string') assert.ok(value.length <= 400, entry.id + ': подозрительно длинное значение');
    }
  }
  assert.throws(() => toServerConfig('нет-такой'), /неизвестная запись/);
  // Посторонние поля и значения из объекта-клона не попадают в конфиг.
  assert.deepEqual(
    toServerConfig({ id: 'git', command: 'злая-команда', env: { SECRET: 'готовый-ключ' } }),
    toServerConfig('git'),
  );
});

test('пометки честные: verified:false означает «не проверено», имена ключей видны в описании', () => {
  let unverified = 0;
  for (const entry of CATALOG) {
    if (entry.verified !== true) {
      unverified += 1;
      assert.match(entry.description, /не проверено/, entry.id + ': у непроверенной записи нет пометки');
    }
    for (const key of entry.envKeys) {
      assert.ok(entry.description.includes(key), entry.id + ': ключ ' + key + ' не упомянут в описании');
    }
  }
  // 17.11.2026 все 80 записей сверены с реестрами npm/PyPI и HTTP-статусами (см. отчёт
  // и scripts/check-mcp-registry.js). Если появится запись без проверки, тест напомнит пометить её.
  assert.equal(unverified, 0, 'после сверки с реестрами непроверенных записей быть не должно');
});

test('формат запуска: npx.cmd -y <пакет>, uvx <пакет>, корректные адреса, без секретов', () => {
  const NPM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;
  const PYPI_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;
  for (const entry of CATALOG) {
    const label = entry.id;
    if (entry.transport === 'stdio') {
      assert.ok(['npx.cmd', 'uvx'].includes(entry.command), label + ': команда запуска');
      assert.ok(Array.isArray(entry.args) && entry.args.length > 0, label + ': нужен хотя бы один аргумент');
      for (const arg of entry.args) {
        assert.equal(typeof arg, 'string');
        assert.ok(arg.length > 0, label + ': пустой аргумент');
        assert.ok(arg.length <= 1000, label + ': слишком длинный аргумент');
        assert.doesNotMatch(arg, /[\u0000-\u001f\u007f]/, label + ': управляющий символ в аргументе');
        assert.doesNotMatch(arg, /[&|<>;`$%"'\r\n]/, label + ': недопустимый для запуска символ в аргументе');
      }
      if (entry.command === 'npx.cmd') {
        assert.equal(entry.args[0], '-y', label + ': у npx первым аргументом должно быть -y');
        assert.ok(entry.args[1], label + ': у npx должен быть пакет');
        assert.ok(NPM_SPEC.test(entry.args[1]), label + ': имя npm-пакета «' + entry.args[1] + '»');
        assert.ok(!entry.args[1].startsWith('-'), label + ': имя пакета не должно начинаться с «-»');
        assert.ok(entry.args[1].length <= 214, label + ': имя npm-пакета слишком длинное');
      } else {
        assert.ok(PYPI_SPEC.test(entry.args[0]), label + ': имя PyPI-пакета «' + entry.args[0] + '»');
        assert.ok(!entry.args[0].startsWith('-'), label + ': имя пакета не должно начинаться с «-»');
        assert.ok(entry.args[0].length <= 214, label + ': имя PyPI-пакета слишком длинное');
      }
      for (const key of entry.envKeys) {
        assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, label + ': имя переменной окружения');
      }
    } else {
      assert.equal(entry.transport, 'http');
      assert.equal(entry.command, undefined, label + ': у http-записи не должно быть команды');
      assert.equal(entry.args.length, 0, label + ': у http-записи не должно быть аргументов');
      assert.equal(entry.envKeys.length, 0, label + ': у http-записи не должно быть env-ключей');
      let url = null;
      try { url = new URL(entry.url); } catch (err) { assert.fail(label + ': адрес не разобран'); }
      assert.equal(url.protocol, 'https:', label + ': адрес только https');
      assert.equal(url.username, '', label + ': в адресе не должно быть логина');
      assert.equal(url.password, '', label + ': в адресе не должно быть пароля');
      assert.ok(url.hostname.includes('.') || url.hostname === 'localhost', label + ': в адресе нет имени хоста');
      assert.doesNotMatch(entry.url, /[\u0000-\u001f\u007f\s]/, label + ': управляющий символ или пробел в адресе');
    }
    assertNoSecrets([entry.id, entry.url || '', entry.args.join(' '), entry.description].join('\n'), label);
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
  assert.throws(bad({ command: 'node' }), /npx.cmd или uvx/);
  assert.throws(bad({ args: ['pkg'] }), /-y/);
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
  // Больше 80 записей каталог не принимает.
  const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, index) => ({
    ...baseEntry(),
    id: 'base' + index,
    args: ['-y', 'pkg' + index],
  }));
  assert.throws(() => validateCatalog(many), /не больше/);
});

test('настройки по умолчанию: каталог раскладывается в mcpServers без дублей', () => {
  const servers = {};
  for (const entry of CATALOG) {
    assert.equal(servers[entry.id], undefined, 'имя «' + entry.id + '» занято дважды');
    const checked = normalizeServerConfig(toServerConfig(entry));
    assert.equal(checked.ok, true, entry.id + ': ' + checked.error);
    servers[entry.id] = checked.config;
  }
  assert.equal(Object.keys(servers).length, CATALOG.length);
  assert.equal(Object.keys(servers).every((name) => validateName(name).ok), true);
});

test('FEATURED: окно «Популярные» берёт записи каталога, порядок для витрины стабилен', () => {
  assert.deepEqual(FEATURED.slice(0, 4).map((item) => item.id), ['github', 'gmail', 'linear', 'notion']);
  for (const item of FEATURED) {
    assert.ok(String(item.title || '').trim(), item.id + ': нет подписи');
    assert.ok(String(item.description || '').trim(), item.id + ': нет описания');
    assert.ok(Array.isArray(item.envKeys || []), item.id + ': envKeys не список');
    if (item.id === 'gmail') {
      assert.equal(item.integration, 'mail');
      continue;
    }
    const entry = getCatalogEntry(item.id);
    assert.ok(entry, 'витрина ссылается на запись «' + item.id + '», которой нет в каталоге');
    assert.equal(item.transport, entry.transport, item.id + ': транспорт разошёлся с каталогом');
    if (entry.transport === 'http') assert.equal(item.url, entry.url, item.id + ': адрес разошёлся с каталогом');
    else assert.equal(item.command, entry.command, item.id + ': команда разошлась с каталогом');
  }
  assertNoSecrets(JSON.stringify(FEATURED), 'витрина');
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
    assert.ok(entry, 'в популярных есть «' + item.id + '», которого нет в каталоге');
    assert.ok(item.title.trim(), item.id + ': пустая подпись');
    // Кнопка «Добавить» не должна подставлять ключи: в популярные попадают только записи без env.
    assert.equal(entry.envKeys.length, 0, item.id + ': сервис с ключами не место в популярных');
    assert.equal(entry.verified, true, item.id + ': непроверенный сервис не место в популярных');
    const config = toServerConfig(entry);
    assert.equal(config.command, item.target, item.id + ': команда в окне разошлась с каталогом');
    assert.equal(config.args.join(' '), item.args, item.id + ': аргументы в окне разошлись с каталогом');
  }
  assert.match(source, /api\.mcpAdd\(/, 'кнопка «Добавить» должна вызывать mcpAdd');
  assert.ok(source.includes('Популярные'), 'нет подписи раздела «Популярные»');
});

test('значки: mcp-logos.js — снимок всех 75 сервисов, лицензия CC0 и наши монограммы', () => {
  assert.match(LOGOS_TEXT, /Simple Icons/, 'нет упоминания Simple Icons');
  assert.match(LOGOS_TEXT, /CC0 1\.0/, 'нет лицензионной пометки CC0 1.0');
  assert.match(LOGOS_TEXT, /товарные знаки их владельцев/, 'нет пометки про авторские права и товарные знаки');
  assert.match(LOGOS_TEXT, /вручную не править/, 'файл должен быть помечен как сгенерированный');
  assertNoSecrets(LOGOS_TEXT, 'mcp-logos.js');
  assert.doesNotMatch(LOGOS_TEXT, /<script|javascript:/i, 'в данных значков не должно быть HTML или скриптов');
  // В рантайме сеть не нужна и запрещена строгим CSP: ни fetch, ни XHR, ни require.
  assert.doesNotMatch(LOGOS_TEXT, /\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps\.get\s*\(|\brequire\s*\(/, 'mcp-logos.js не должен ходить в сеть');

  const logos = loadLogos();
  assert.equal(logos.services.length, CATALOG.length, 'в снимке должны быть все записи каталога');
  assert.equal(logos.categories.length, CATEGORIES.length, 'категории снимка разошлись с каталогом');
  for (const category of CATEGORIES) {
    const copy = logos.categories.find((item) => item.id === category.id);
    assert.ok(copy, 'в снимке нет категории «' + category.id + '»');
    assert.equal(copy.title, category.title, 'подпись категории «' + category.id + '» разошлась');
  }

  let brands = 0;
  let monograms = 0;
  for (const entry of CATALOG) {
    const service = logos.service(entry.id);
    assert.ok(service, entry.id + ': нет записи в снимке значков');
    assert.equal(service.title, entry.title);
    assert.equal(service.description, entry.description);
    assert.equal(service.category, entry.category);
    assert.equal(service.transport, entry.transport);
    assert.equal(service.verified, entry.verified);
    assert.equal(JSON.stringify(service.envKeys), JSON.stringify(entry.envKeys));
    // В снимке окна адреса и инструкции хранятся без схемы: файл в рантайме не ходит в сеть.
    const withoutScheme = (value) => String(value || '').replace(/^https?:\/\//i, '');
    assert.equal(service.docs || undefined, entry.docs ? withoutScheme(entry.docs) : undefined);
    if (entry.transport === 'stdio') {
      assert.equal(service.command, entry.command);
      assert.equal(JSON.stringify(service.args), JSON.stringify(entry.args));
    } else {
      assert.equal(service.url, withoutScheme(entry.url));
      assert.equal(service.command, undefined);
    }
    const brand = logos.brand(entry.id);
    const mono = logos.monogram(entry.id);
    assert.ok(brand || mono, entry.id + ': нет ни значка, ни монограммы');
    assert.ok(!(brand && mono), entry.id + ': не должно быть значка и монограммы одновременно');
    if (brand) {
      brands += 1;
      assert.match(brand.slug, /^[a-z0-9-]+$/, entry.id + ': слаг значка');
      assert.match(brand.version, /^\d+\.\d+\.\d+$/, entry.id + ': версия Simple Icons');
      assert.match(brand.path, /^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\-\s]+$/, entry.id + ': путь значка');
      assert.ok(brand.path.length > 10 && brand.path.length < 12000, entry.id + ': длина пути значка');
    } else {
      monograms += 1;
      assert.equal(mono.letter.length, 1, entry.id + ': буква монограммы');
      assert.match(mono.color, /^#[0-9a-fA-F]{6}$/, entry.id + ': цвет монограммы');
    }
  }
  assert.ok(brands >= 40, 'настоящих значков должно быть большинство, сейчас ' + brands);
  assert.ok(monograms > 0, 'для редких сервисов должны быть наши монограммы');
  assert.ok(logos.brand('gmail'), 'у карточки почты должен быть настоящий значок');
  assert.match(logos.license, /CC0 1\.0/, 'в API должна быть лицензионная строка');

  // Глифы монограмм должны существовать в общем наборе иконок, иначе рисовать нечего.
  const names = iconNames();
  for (const mono of Object.values(logos.monograms)) {
    assert.ok(names.has(mono.glyph), 'глифа «' + mono.glyph + '» нет в icons.js');
  }
});

test('окно «Дополнения»: каталог со значками, честные действия и никакой сети', () => {
  assert.match(VIEW_TEXT, /mcp-logos\.js/, 'компонент должен подключать сгенерированные значки');
  assert.match(VIEW_TEXT, /NoxMcpLogos/, 'компонент должен использовать данные значков');
  assert.match(VIEW_TEXT, /data-service/, 'внешние сервисы должны быть размечены data-service');
  assert.match(VIEW_TEXT, /dataset\.service/, 'разметка data-service должна заполняться');
  assert.match(VIEW_TEXT, /bridge\.call\('mcpAdd', name, target/, 'добавление идёт позиционными аргументами mcpAdd');
  assert.match(VIEW_TEXT, /mcpApprove/, 'подтверждение изменений сервиса');
  assert.match(VIEW_TEXT, /mcpToggle/, 'включение и выключение сервиса');
  assert.match(VIEW_TEXT, /openSource/, 'инструкция открывается существующим каналом');
  assert.match(VIEW_TEXT, /Дополнения/, 'подпись раздела');
  assert.match(VIEW_TEXT, /type = 'search'/, 'должно быть поле поиска');
  assert.match(VIEW_TEXT, /CC0 1\.0/, 'должна быть пометка о лицензии значков');
  assert.match(VIEW_TEXT, /товарные знаки/, 'должна быть пометка про товарные знаки');
  // В окне нет сети: значки уже внутри файла, данные приходят мостом, ссылки открывает ядро.
  const external = (VIEW_TEXT.match(/https?:\/\/[a-z0-9][^\s'"]*/gi) || []).filter((url) => !url.startsWith('http://www.w3.org/'));
  assert.deepEqual(external, [], 'в компоненте не должно быть внешних адресов');
  assert.doesNotMatch(VIEW_TEXT, /\bfetch\s*\(|\bXMLHttpRequest\b/, 'компонент не должен ходить в сеть');
  assertNoSecrets(VIEW_TEXT, 'mcp-view.js');
});

test('генератор значков: CDN Simple Icons, карта service→slug, без npm-зависимостей', () => {
  const source = fs.readFileSync(FETCH_FILE, 'utf8');
  assert.match(source, /simple-icons/, 'генератор должен качать Simple Icons');
  assert.match(source, /cdn\.jsdelivr\.net/, 'нужен открытый CDN');
  assert.match(source, /CC0 1\.0/, 'должна быть лицензионная пометка');
  assert.match(source, /BRAND_SLUGS/, 'должна быть карта service→slug');
  assert.match(source, /mcp-logos\.js/, 'генератор должен писать mcp-logos.js');
  assert.match(source, /MONOGRAMS|монограмм/i, 'генератор должен делать наши монограммы');
  assert.match(source, /CATALOG/, 'снимок каталога должен браться из каталога ядра');
  const requires = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]);
  for (const name of requires) {
    assert.ok(['fs', 'path', 'https', '../src/mcp/catalog'].includes(name), 'лишняя зависимость генератора: ' + name);
  }
  assert.doesNotMatch(source, /npm install|node_modules/, 'генератор не должен ставить пакеты');
  assertNoSecrets(source, 'fetch-mcp-logos.js');
});

test('скрипт сверки с реестрами: только GET, без установок и запусков серверов', () => {
  const source = fs.readFileSync(path.join(APP, 'scripts', 'check-mcp-registry.js'), 'utf8');
  assert.match(source, /registry\.npmjs\.org/, 'нужен реестр npm');
  assert.match(source, /pypi\.org\/pypi/, 'нужен реестр PyPI');
  assert.match(source, /https\.get\(/, 'запросы только через GET');
  assert.match(source, /headersOnly/, 'для адресов читается только статус, без тела');
  assert.doesNotMatch(source, /child_process|spawn\s*\(|exec\s*\(|npm install|node_modules/, 'скрипт не должен ничего устанавливать или запускать');
  assert.doesNotMatch(source, /method:\s*'POST'/, 'никаких изменяющих запросов');
  assert.match(source, /--json/, 'должен быть машинный вывод для отчёта');
  assertNoSecrets(source, 'check-mcp-registry.js');
});