'use strict';

// Видимые имена: инструменты показываются названиями, коды риска словами, код и адреса не трогаем.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// shared.js рассчитан на браузер: для чистых функций хватает пустых window и document.
function loadUi() {
  const window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/shared.js'), 'utf8'), { window, document: {}, Set, Map, Date, console });
  return window.JarvisUI;
}

test('неизвестное имя инструмента показывается как «Действие», а не сырым именем', () => {
  const U = loadUi();
  assert.equal(U.toolTitle('ui_type'), 'Ввод текста в окне');
  assert.equal(U.toolTitle('ui_zzz_new'), 'Действие');
  assert.equal(U.toolTitle(''), 'Действие');
  assert.equal(U.toolTitle(undefined), 'Действие');
  // Подписи задач и дел — обычный текст, его не подменяем.
  assert.equal(U.toolTitle('Найти отели в Риге'), 'Найти отели в Риге');
});

test('названия команд библиотеки остаются после registerTitles', () => {
  const U = loadUi();
  assert.equal(U.toolTitle('lib_weather'), 'Действие');
  U.registerTitles({ lib_weather: 'Погода на завтра' });
  assert.equal(U.toolTitle('lib_weather'), 'Погода на завтра');
  assert.equal(U.humanize('запусти lib_weather'), 'запусти «Погода на завтра»');
});

test('список поисковых запросов показывается обычным текстом', () => {
  const U = loadUi();
  assert.equal(U.argsBrief({ queries: ['первый запрос', 'второй запрос'] }), 'первый запрос, второй запрос');
});

test('каждый инструмент из src/ имеет подпись', () => {
  const U = loadUi();
  const names = new Set();
  const dirs = ['tools', 'tasks', 'commands', 'library', 'skills', 'deals', 'missions'];
  for (const d of dirs) {
    const dir = path.join(__dirname, '../src', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      for (const [, n] of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/name: '([a-z][a-z0-9]*_[a-z0-9_]+)'/g)) names.add(n);
    }
  }
  const missing = [...names].filter((n) => U.toolTitle(n) === 'Действие');
  assert.deepEqual(missing, []);
});

test('имя инструмента в тексте заменяется названием в ёлочках', () => {
  const U = loadUi();
  assert.equal(U.humanize('Сейчас вызову ui_type и потом web_search.'), 'Сейчас вызову «Ввод текста в окне» и потом «Поиск в интернете».');
  assert.equal(U.humanize('`web_search`'), '«Поиск в интернете»');
  assert.equal(U.humanize('ui_qwerty_x'), '«действие»');
  assert.equal(U.humanize('my_ui_type и обычный_текст'), 'my_ui_type и обычный_текст');
});

test('код в блоках, адреса и пути не меняются', () => {
  const U = loadUi();
  const code = '```js\nawait ui_type(1)\n```';
  assert.equal(U.humanize(code), code);
  assert.equal(U.humanize('см. https://example.com/web_search?x=ui_type'), 'см. https://example.com/web_search?x=ui_type');
  assert.equal(U.humanize('файл D:\\nox\\web_search.js'), 'файл D:\\nox\\web_search.js');
  assert.equal(U.humanize('в ```ui_type'), 'в ```ui_type');
});

test('имя, пришедшее двумя частями потока, даёт верный итог по накопленному тексту', () => {
  const U = loadUi();
  const parts = ['Открываю ui_', 'ty', 'pe в окне.'];
  let buf = '';
  const shown = [];
  for (const p of parts) {
    buf += p;
    shown.push(U.humanize(buf));
  }
  assert.equal(shown[0], 'Открываю ui_');
  assert.equal(shown[2], 'Открываю «Ввод текста в окне» в окне.');
});

test('код риска не показывается, причина очищается', () => {
  const U = loadUi();
  assert.equal(U.riskWord('T0'), 'чтение');
  assert.equal(U.riskWord('T1'), 'действие');
  assert.equal(U.riskWord('T2'), 'важное действие');
  assert.equal(U.riskWord('T3'), 'необратимое');
  assert.equal(U.riskWord('T9'), '');
  assert.equal(U.cleanSummary('режим «auto», риск T1'), 'режим «auto»');
  assert.equal(U.scrub('режим «ask», риск T2'), 'режим «ask»');
});
