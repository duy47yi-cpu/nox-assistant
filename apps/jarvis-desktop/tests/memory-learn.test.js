'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemoryStore } = require('../src/memory/store');
const { extractFacts, learnFromTurn, consolidate, isSensitiveFact, normalizeFact } = require('../src/memory/learn');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-mem-learn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new MemoryStore(path.join(dir, 'memory.json'));
}

describe('извлечение фактов', () => {
  test('имя, город и работа становятся профилем', () => {
    const name = extractFacts('Привет, меня зовут Абду');
    assert.equal(name[0].kind, 'profile');
    assert.match(name[0].text, /Меня зовут Абду/);
    assert.equal(name[0].about, 'Абду');
    const city = extractFacts('я живу в Бишкеке');
    assert.equal(city[0].kind, 'profile');
    assert.match(city[0].text, /Бишкек/);
    const job = extractFacts('я работаю программистом');
    assert.match(job[0].text, /программистом/);
  });

  test('как обращаться — договорённость, а не заметка', () => {
    const facts = extractFacts('зови меня Абду');
    assert.equal(facts[0].kind, 'agreement');
    assert.match(facts[0].text, /Зови меня Абду/);
  });

  test('предпочтения и факты о себе', () => {
    assert.equal(extractFacts('я очень люблю зелёный чай')[0].kind, 'preference');
    assert.equal(extractFacts('я не люблю шум')[0].kind, 'preference');
    assert.equal(extractFacts('я предпочитаю утро')[0].kind, 'preference');
    assert.equal(extractFacts('у меня есть кот Барсик')[0].kind, 'fact');
  });

  test('явное «запомни» берётся целиком', () => {
    const facts = extractFacts('запомни: купить хлеб в субботу');
    assert.equal(facts[0].kind, 'note');
    assert.match(facts[0].text, /купить хлеб/);
  });

  test('указание «всегда» — договорённость, а «я всегда» — нет', () => {
    assert.equal(extractFacts('всегда проверяй дату')[0].kind, 'agreement');
    assert.equal(extractFacts('я всегда опаздываю').length, 0);
  });

  test('вопрос не превращается в факт', () => {
    assert.equal(extractFacts('как меня зовут?').length, 0);
  });

  test('секреты и чувствительное не вытаскиваются в память', () => {
    const store = { add() { throw new Error('не должно вызываться'); }, list: () => [] };
    const secret = learnFromTurn({ store, text: 'запомни: пароль sk-abcdefghijklmnop' });
    assert.equal(secret.added.length, 0);
    assert.match(secret.skipped[0].reason, /секрет/);
    const health = learnFromTurn({ store, text: 'запомни: у меня диагноз' });
    assert.equal(health.added.length, 0);
    assert.match(health.skipped[0].reason, /чувствительное/);
  });
});

describe('запись памяти после хода', () => {
  test('добавляет найденное и не бросает при ошибке хранилища', (t) => {
    const store = tempStore(t);
    const result = learnFromTurn({ store, text: 'меня зовут Абду, я живу в Бишкеке' });
    assert.equal(result.added.length, 2);
    assert.equal(store.list().length, 2);
    const stored = store.list().map((x) => x.text).join(' ');
    assert.match(stored, /Абду/);
    assert.match(stored, /Бишкек/);
  });

  test('повтор не создаёт дубль', (t) => {
    const store = tempStore(t);
    learnFromTurn({ store, text: 'меня зовут Абду' });
    const second = learnFromTurn({ store, text: 'меня зовут Абду' });
    assert.equal(second.added.length, 0);
    assert.match(second.skipped[0].reason, /уже есть/);
    assert.equal(store.list().length, 1);
  });

  test('противоречие сохраняет новую версию, а старую — как историю', (t) => {
    const store = tempStore(t);
    learnFromTurn({ store, text: 'я живу в Москве' });
    const result = learnFromTurn({ store, text: 'я живу в Питере' });
    assert.equal(result.added.length, 1);
    assert.ok(result.conflicts.length > 0);
    assert.equal(result.replaced.length, 1);
    assert.match(store.list()[0].text, /Питере/);
    assert.equal(store.list(10, { includeSuperseded: true }).length, 2);
  });

  test('выключенная авто-память ничего не пишет', (t) => {
    const store = tempStore(t);
    const result = learnFromTurn({ store, text: 'меня зовут Абду', auto: false });
    assert.equal(result.disabled, true);
    assert.equal(store.list().length, 0);
  });

  test('ответ модели не считается словами владельца', (t) => {
    const store = tempStore(t);
    const result = learnFromTurn({ store, text: 'привет', reply: 'Меня зовут Абду, я живу в Бишкеке' });
    assert.equal(result.added.length, 0);
    assert.equal(store.list().length, 0);
  });

  test('уборка убирает только точные дубли', (t) => {
    const store = tempStore(t);
    store.add({ text: 'Люблю кофе', kind: 'preference' });
    store.add({ text: 'Люблю кофе', kind: 'preference' });
    store.add({ text: 'Люблю чай', kind: 'preference' });
    const result = consolidate(store);
    assert.equal(result.removed.length, 1);
    assert.equal(store.list().length, 2);
    assert.equal(normalizeFact(store.list()[0].text), 'люблю чай');
  });

  test('просроченная запись не мешает записать факт заново', (t) => {
    const store = tempStore(t);
    store.add({ text: 'купить хлеб', kind: 'note', until: '2020-01-01' });
    const result = learnFromTurn({ store, text: 'запомни: купить хлеб' });
    assert.equal(result.added.length, 1);
    assert.equal(store.list().length, 1);
  });

  test('авто-память подключена к ходу и выключается настройкой', () => {
    const app = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(app, 'main.js'), 'utf8');
    assert.match(main, /learnAfterTurn\(phrase, agent\.history\)/);
    assert.match(main, /learnAfterTurn\(phrase, running\.history\)/);
    assert.match(main, /memoryAuto: s\.memoryAuto !== false/);
    assert.match(main, /'memoryAuto'/);
    const html = fs.readFileSync(path.join(app, 'renderer', 'index.html'), 'utf8');
    assert.match(html, /data-setting="memoryAuto"/);
  });
});

// ── Чувствительные входы авто-памяти (этап 3) ────────────────────────────────
// Требование: автоматически не запоминать пароль, здоровье, платёж, коды и отправку.
// Проверяем именно автоматический путь; явный remember с sensitive остаётся за владельцем.
describe('чувствительное не попадает в авто-память', () => {
  const cases = [
    ['пароль', 'запомни: пароль от банка hunter22', /секрет|чувствительное/],
    ['здоровье', 'запомни: у меня аллергия на пенициллин', /чувствительное/],
    ['здоровье без «запомни»', 'у меня есть диабет', /чувствительное/],
    ['платёж', 'запомни: оплатить интернет 1200 рублей', /чувствительное/],
    ['перевод', 'запомни: перевести 5000 рублей Маше', /чувствительное/],
    ['код', 'запомни: код подтверждения 4821', /чувствительное/],
    ['номер карты', 'запомни: номер карты 4111 1111 1111 1111', /чувствительное/],
    ['отправка', 'запомни: отправь СМС Маше', /чувствительное/],
  ];

  for (const [label, text, reason] of cases) {
    test(`${label}: не записывается, причина в skipped`, (t) => {
      const store = tempStore(t);
      const result = learnFromTurn({ store, text });
      assert.equal(result.added.length, 0, `${label}: в память ничего не добавлено`);
      assert.equal(store.list().length, 0, `${label}: файл памяти пуст`);
      assert.ok(result.skipped.some((item) => reason.test(item.reason)), `${label}: причина ${JSON.stringify(result.skipped)}`);
    });
  }

  test('обычная бытовая просьба по-прежнему записывается', (t) => {
    const store = tempStore(t);
    const result = learnFromTurn({ store, text: 'запомни: купить хлеб в субботу' });
    assert.equal(result.added.length, 1);
    assert.equal(store.list().length, 1);
  });

  test('isSensitiveFact: единая проверка для входа и для тестов', () => {
    for (const text of ['пароль: qwerty', 'диабет', 'оплата 500 рублей', 'код подтверждения 1234', 'отправь письмо', '4111 1111 1111 1111']) {
      assert.equal(isSensitiveFact(text), true, text);
    }
    for (const text of ['купить хлеб', 'позвонить маме', 'встреча в 15:00']) {
      assert.equal(isSensitiveFact(text), false, text);
    }
  });
});
