'use strict';

// Карточка каталога в «Дополнениях» и снимок значков: поведение, которое легко сломать.
// Стиль как у aether-ui: статические проверки исходника + вызов чистых функций,
// которые компонент экспортирует через window.NoxAetherMcpView. Пакеты не нужны.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..');
const AETHER = path.join(APP, 'renderer', 'aether');
const VIEW_FILE = path.join(AETHER, 'components', 'mcp-view.js');
const LOGOS_FILE = path.join(AETHER, 'mcp-logos.js');
const VIEW = fs.readFileSync(VIEW_FILE, 'utf8');
const LOGOS = fs.readFileSync(LOGOS_FILE, 'utf8');

function loadView() {
  const sandbox = { window: {}, console };
  vm.runInNewContext(VIEW, sandbox, { filename: 'mcp-view.js', timeout: 5000 });
  assert.ok(sandbox.window.NoxAetherMcpView, 'mcp-view.js должен экспортировать window.NoxAetherMcpView');
  return sandbox.window.NoxAetherMcpView;
}

function loadLogos() {
  const sandbox = { window: {} };
  vm.runInNewContext(LOGOS, sandbox, { filename: 'mcp-logos.js', timeout: 5000 });
  assert.ok(sandbox.window.NoxMcpLogos, 'mcp-logos.js должен экспортировать window.NoxMcpLogos');
  return sandbox.window.NoxMcpLogos;
}

// Кусок исходника между двумя якорями: так тест не читает чужие части компонента.
function sliceBetween(source, startNeedle, endNeedle, from) {
  const start = source.indexOf(startNeedle, from || 0);
  assert.ok(start >= 0, 'нет якоря: ' + startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, 'нет второго якоря: ' + endNeedle);
  return source.slice(start, end);
}

test('карточка каталога раскрывается по клику и закрывается повторно', () => {
  assert.match(VIEW, /card\.tabIndex = 0/, 'карточка должна быть доступна с клавиатуры');
  assert.match(VIEW, /card\.setAttribute\('role', 'button'\)/);
  assert.match(VIEW, /card\.setAttribute\('aria-expanded', 'false'\)/, 'у карточки есть честное состояние раскрытия');
  assert.match(VIEW, /details\.hidden = true/, 'детали сначала скрыты');
  assert.match(VIEW, /details\.style\.display = 'none'/);
  assert.match(VIEW, /card\.addEventListener\('click'/, 'клик по карточке раскрывает её');
  assert.match(VIEW, /if \(event\.target\.closest\('button'\)\) return;/, 'кнопка внутри карточки не должна сворачивать её');
  assert.match(VIEW, /if \(details\.contains\(event\.target\)\) return;/, 'клик по тексту деталей не должен закрывать их');
  assert.match(VIEW, /const open = details\.hidden;/, 'переключение идёт по текущему состоянию');
  assert.match(VIEW, /details\.hidden = !open;/);
  assert.match(VIEW, /details\.style\.display = open \? 'flex' : 'none';/);
  assert.match(VIEW, /card\.setAttribute\('aria-expanded', String\(open\)\);/);
  assert.match(VIEW, /event\.key === 'Enter' \|\| event\.key === ' '/, 'Enter/Space тоже раскрывают карточку');
  // Детали добавляются именно в карточку, а не в отдельное окно.
  assert.match(VIEW, /card\.append\(details\);/);
});

test('в раскрытой карточке видны только ИМЕНА envKeys, без значений', () => {
  const view = loadView();
  assert.equal(view.envKeyNames(['GITLAB_PERSONAL_ACCESS_TOKEN']), 'GITLAB_PERSONAL_ACCESS_TOKEN');
  assert.equal(view.envKeyNames(['A_B', 'C_D']), 'A_B, C_D');
  assert.equal(view.envKeyNames([]), '');
  assert.equal(view.envKeyNames(undefined), '');
  assert.equal(view.envKeyNames(['OK', 5, '', null]), 'OK', 'в строку попадают только имена-строки');

  // Детали строятся из envKeys; значений env в компоненте нет вообще.
  assert.match(VIEW, /'Нужны ключи \(только имена\): ' \+ envKeyNames\(service\.envKeys\)/);
  assert.match(VIEW, /Значения в каталоге не хранятся/, 'должно быть сказано, что значений нет');
  assert.doesNotMatch(VIEW, /service\.env\b/, 'значения env не должны попадать в карточку');
  assert.doesNotMatch(VIEW, /entry\.env\b/, 'значения env не должны попадать в карточку');
  assert.doesNotMatch(VIEW, /Object\.values\([^)]*env/, 'значения env не должны перебираться для показа');
});

test('envKeys не пуст — «Добавить» нет, есть «Инструкция»; пуст — «Добавить» есть', () => {
  const view = loadView();
  assert.equal(view.needsKey({ envKeys: ['TOKEN'] }), true);
  assert.equal(view.needsKey({ envKeys: [] }), false);
  assert.equal(view.needsKey({}), false);
  assert.equal(view.needsKey(null), false);

  const footer = sliceBetween(VIEW, 'const footer = document.createElement', 'card.append(footer);');
  const keyBranchStart = footer.indexOf('else if (needsKey(service))');
  assert.ok(keyBranchStart >= 0, 'ветка сервиса с ключами должна проверять needsKey');
  const elseStart = footer.indexOf('} else {', keyBranchStart);
  assert.ok(elseStart > keyBranchStart, 'должна быть ветка для сервиса без ключей');
  const keyBranch = footer.slice(keyBranchStart, elseStart);
  const addBranch = footer.slice(elseStart);
  assert.match(keyBranch, /'нужен ключ'/, 'у сервиса с ключами должна быть честная пометка');
  assert.match(keyBranch, /'Инструкция ↗'/, 'у сервиса с ключами есть инструкция');
  assert.doesNotMatch(keyBranch, /if \(service\.docs\) \{/, 'инструкция должна быть и без ссылки (честный отказ)');
  assert.match(keyBranch, /Инструкция для этого сервиса недоступна/, 'без ссылки честно сказано, что инструкции нет');
  assert.doesNotMatch(keyBranch, /'Добавить'|'Подключить'|addBtn/, 'без ключа кнопки добавления быть не должно');
  assert.match(addBranch, /addBtn\.textContent = service\.transport === 'http' \? 'Подключить' : 'Добавить'/);
  assert.match(addBranch, /'Инструкция ↗'/, 'для сервиса без ключей инструкция тоже доступна');
  // Имена ключей в ветке с ключами — только через envKeyNames, не через значения.
  assert.match(keyBranch, /envKeyNames\(service\.envKeys\)/);
});

test('отметка «не проверено» показывается только для verified:false', () => {
  const view = loadView();
  assert.equal(view.verificationMark(false), 'не проверено');
  assert.equal(view.verificationMark(true), '');
  assert.equal(view.verificationMark(undefined), 'не проверено');

  assert.match(VIEW, /const verifiedMark = verificationMark\(service\.verified\);/);
  assert.match(VIEW, /if \(verifiedMark\) head\.append\(badge\(verifiedMark, 'warn'\)\);/, 'отметка добавляется условно');
  assert.doesNotMatch(VIEW, /if \(!service\.verified\)/, 'не должно быть старой безусловной ветки');
  // Единственная прямая пометка — строка «Мои подключения», и она тоже условная.
  assert.equal((VIEW.match(/badge\('не проверено'/g) || []).length, 1);
  assert.match(VIEW, /if \(catalogEntry && catalogEntry\.verified === false\) titleRow\.append\(badge\('не проверено', 'warn'\)\);/);
  assert.equal((VIEW.match(/verificationMark\(/g) || []).length >= 2, true);
});

test('mcp-logos.js: в снимке нет внешних URL и сетевых вызовов', () => {
  assert.doesNotMatch(LOGOS, /https?:\/\//i, 'в снимке не должно быть внешних URL');
  assert.doesNotMatch(LOGOS, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/, 'никаких сетевых API');
  assert.doesNotMatch(LOGOS, /\brequire\s*\(|\bimport\s*\(/, 'файл не должен ничего подгружать');
  assert.doesNotMatch(LOGOS, /<script|<img|src\s*=/i, 'никаких тегов, загружающих данные');
  assert.match(LOGOS, /CC0 1\.0/, 'должна быть лицензионная пометка');
  assert.match(LOGOS, /товарные знаки их владельцев/, 'должна быть пометка про товарные знаки');
  assert.match(LOGOS, /вручную не править/, 'файл сгенерированный');

  const logos = loadLogos();
  assert.equal(logos.services.length, 80);
  assert.equal(logos.categories.length, 13);
  for (const service of logos.services) {
    // Адреса в снимке — без схемы: https:// добавляет окно только при явном действии.
    if (service.url) assert.doesNotMatch(service.url, /^https?:\/\//i, service.id + ': url без схемы');
    if (service.docs) assert.doesNotMatch(service.docs, /^https?:\/\//i, service.id + ': docs без схемы');
    assert.equal(service.env, undefined, service.id + ': значений env в снимке нет');
    for (const key of service.envKeys) assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, service.id + ': только имя ');
  }
  assert.ok(Object.keys(logos.brands).length >= 40, 'большинство значков настоящие');
  assert.ok(Object.keys(logos.monograms).length > 0, 'для редких сервисов есть наши монограммы');
});

test('окно добавляет схему только в момент действия и не ходит в сеть само', () => {
  const view = loadView();
  assert.equal(view.withHttps('github.com/modelcontextprotocol/servers'), 'https://github.com/modelcontextprotocol/servers');
  assert.equal(view.withHttps('https://example.com/a'), 'https://example.com/a');
  assert.equal(view.withHttps(''), '');
  assert.match(VIEW, /withHttps\(entry\.docs\)/, 'инструкция открывается через явное действие');
  assert.match(VIEW, /withHttps\(service\.url\)/, 'облачный адрес восстанавливается перед добавлением');
  assert.doesNotMatch(VIEW, /\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?\.get\s*\(/, 'компонент не ходит в сеть');
});