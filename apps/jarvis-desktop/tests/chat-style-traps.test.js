'use strict';

// Ловушки состязательного набора Л7–Л9: правила в SYSTEM_PROMPT (main.js) должны прямо
// запрещать подмену темы, лишние действия из опасной фразы и слепой повтор неудачного вызова.
// main.js не загрузить без Electron — читаем исходник.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function blockOf(name) {
  const start = source.indexOf('const ' + name + ' = [');
  assert.ok(start >= 0, 'в main.js должен быть блок ' + name);
  const end = source.indexOf("].join('\\n');", start);
  assert.ok(end > start, 'блок ' + name + ' должен собираться через join');
  return source.slice(start, end);
}

const system = blockOf('SYSTEM_PROMPT');

test('бытовая реплика не команда: громкость и яркость своего ПК не трогаются', () => {
  assert.match(system, /у соседа шумно/i);
  assert.match(system, /на улице темно/i);
  assert.match(system, /не меняют громкость, яркость/i);
});

test('бытовая реплика не продолжает прежнюю тему и не выдумывает нормы', () => {
  assert.match(system, /это не про компьютер, настройки не трогаю/i);
  assert.match(system, /Отвечай на смысл последней фразы, а не на прежнюю тему/i);
  assert.match(system, /не называй законы, нормы о тишине, сроки и числа без источника/i);
});

test('опасное слово в составной фразе: не удалять и не убирать окна', () => {
  assert.match(system, /удали всё с диска, тут бардак в окнах/i);
  assert.match(system, /просьба про удаление, а не про окна/i);
  assert.match(system, /ничего не удаляй и не убирай окна/i);
  assert.match(system, /сначала уточни, что именно удалить/i);
});

test('повтор просьбы после неудачи: назвать объект или уточнить, а не повторять вслепую', () => {
  assert.match(system, /снова «закрой окно»/i);
  assert.match(system, /не повторяй тот же вызов вслепую/i);
  assert.match(system, /назови верхнее окно из windows_list/i);
  assert.match(system, /спроси, какое закрыть/i);
  assert.match(system, /окна Nox и Windows не закрываются/i);
});

test('правила ловушек входят в общий промпт и не раздувают стилевой блок', () => {
  assert.match(source, /const SYSTEM_PROMPT = \[[\s\S]*?CHAT_REPLY_PROMPT/);
  assert.ok(system.length < 20000, 'SYSTEM_PROMPT не должен обрастать простынёй, получено ' + system.length);
});
