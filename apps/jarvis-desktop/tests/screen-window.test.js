'use strict';

// P0: снимок окна вместо всего экрана и честное поведение при менеджере паролей в кадре.
// 1. Заголовок окна передаётся скрипту переменной окружения, а не склейкой в текст.
// 2. Окно не найдено, окно свёрнуто или слишком мало — честный отказ, а не пустая картинка.
// 3. Менеджер паролей в переднем окне: предупреждение в ответе и вопрос в «Полном доступе».
// 4. Снимок названного окна не спрашивается: это осознанный выбор владельца.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { screenTools, CAPTURE_SCRIPT, MAX_WIDTH, frontWindowTitle } = require('../src/tools/screen');
const { decide } = require('../src/policy/modes');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

// capture-подмена: пишет файл и отдаёт JSON как настоящий скрипт.
function shotter(shot, { bytes = JPEG } = {}) {
  const calls = [];
  const capture = async (script, env) => {
    calls.push({ script, env });
    if (shot && shot.status === 'ok') fs.writeFileSync(env.JARVIS_SHOT, bytes);
    return { ok: true, summary: 'готово', data: { stdout: JSON.stringify(shot) } };
  };
  return { capture, calls };
}

const ok = (extra = {}) => ({ status: 'ok', front: 'Блокнот — блокнот', target: 'Блокнот', x: 10, y: 20, w: 800, h: 600, restored: false, ...extra });

const lookWith = (shot, opts = {}) => {
  const s = shotter(shot, opts);
  const [tool] = screenTools({ allowed: () => true, capture: s.capture, ...(opts.extra || {}) });
  return { tool, calls: s.calls };
};

test('скрипт постоянный: окно ищется по заголовку, управляющие символы не склеиваются в код', () => {
  assert.match(CAPTURE_SCRIPT, /JARVIS_WINDOW/);
  assert.match(CAPTURE_SCRIPT, /GetWindowRect/);
  assert.match(CAPTURE_SCRIPT, /ConvertTo-Json/);
  // Снимок всего экрана остаётся: без окна скрипт берёт PrimaryScreen.
  assert.match(CAPTURE_SCRIPT, /PrimaryScreen/);
  assert.match(CAPTURE_SCRIPT, new RegExp(`\\[Math\\]::Min\\(${MAX_WIDTH},`));
});

test('названное окно уходит переменной окружения, а не в тексте скрипта', async () => {
  const { tool, calls } = lookWith(ok());
  await tool.run({ window: '  Блокнот  ' }, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.JARVIS_WINDOW, 'Блокнот');
  assert.equal(CAPTURE_SCRIPT.includes('Блокнот'), false, 'текст владельца не попадает в постоянный скрипт');
});

test('снимок окна возвращает картинку, размеры и удаляет временный файл', async () => {
  const { tool, calls } = lookWith(ok());
  const res = await tool.run({ window: 'Блокнот' }, {});
  assert.equal(res.ok, true);
  assert.match(res.image, /^data:image\/jpeg;base64,/);
  assert.equal(res.data.width, 800);
  assert.equal(res.data.height, 600);
  assert.match(res.summary, /снимок окна «Блокнот»/);
  assert.equal(res.data.secretWindows, undefined, 'у снимка окна отдельного списка секретов нет');
  assert.equal(fs.existsSync(calls[0].env.JARVIS_SHOT), false);
});

test('окно не найдено — отказ с названием, без картинки и без файла', async () => {
  const { tool, calls } = lookWith({ status: 'no_window', front: 'Рабочий стол' });
  const res = await tool.run({ window: 'Биткоин' }, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /не найдено/);
  assert.equal(res.image, undefined);
  assert.equal(fs.existsSync(calls[0].env.JARVIS_SHOT), false);
});

test('свёрнутое или слишком маленькое окно — честный отказ', async () => {
  const { tool } = lookWith({ status: 'too_small', front: 'Блокнот', target: 'Блокнот' });
  const res = await tool.run({ window: 'Блокнот' }, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /свёрнуто|мало/);
});

test('окно развёрнуто для снимка — это сказано в ответе', async () => {
  const { tool } = lookWith(ok({ restored: true }));
  const res = await tool.run({ window: 'Блокнот' }, {});
  assert.equal(res.data.restored, true);
  assert.match(res.summary, /развёрнуто/);
});

test('менеджер паролей в переднем окне: предупреждение и список, но картинка отдаётся', async () => {
  const { tool } = lookWith(ok({ front: 'Bitwarden — хранилище', target: 'Bitwarden' }));
  const res = await tool.run({}, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.data.secretWindows, ['Bitwarden — хранилище']);
  assert.match(res.summary, /менеджер паролей/);
  assert.match(res.summary, /window=/);
});

test('без менеджера паролей в кадре предупреждения нет', async () => {
  const { tool } = lookWith(ok());
  const res = await tool.run({}, {});
  assert.equal(res.data.secretWindows, undefined);
  assert.doesNotMatch(res.summary, /менеджер паролей/);
});

test('переднее окно запоминается для правил доступа', async () => {
  const { tool } = lookWith(ok({ front: 'KeePass', target: 'KeePass' }));
  await tool.run({}, {});
  assert.equal(frontWindowTitle(), 'KeePass');
});

test('правила: снимок всего экрана при менеджере паролей спрашивается в «Полном доступе»', async () => {
  const { tool } = lookWith(ok({ front: 'Bitwarden', target: 'Bitwarden' }));
  await tool.run({}, {});
  const verdict = decide({ mode: 'full', name: 'screen_look', risk: 'T1', args: {}, workspace: os.tmpdir() });
  assert.equal(verdict, 'ask');
});

test('правила: названное окно и обычный экран в «Полном доступе» не спрашиваются', async () => {
  const args = { window: 'Bitwarden' };
  const named = decide({ mode: 'full', name: 'screen_look', risk: 'T1', args, workspace: os.tmpdir() });
  assert.equal(named, 'allow', 'суженный снимок — осознанный выбор, вопрос не нужен');

  const { tool } = lookWith(ok());
  await tool.run({}, {});
  const plain = decide({ mode: 'full', name: 'screen_look', risk: 'T1', args: {}, workspace: os.tmpdir() });
  assert.equal(plain, 'allow');
});

test('без разрешения захват не вызывается, даже когда окно названо', async () => {
  const { capture, calls } = shotter(ok());
  const [tool] = screenTools({ allowed: () => false, capture });
  const res = await tool.run({ window: 'Блокнот' }, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /по просьбе/);
  assert.equal(calls.length, 0);
});

test('слишком длинное название окна отклоняется до захвата', async () => {
  const { tool, calls } = lookWith(ok());
  const res = await tool.run({ window: 'я'.repeat(201) }, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /200/);
  assert.equal(calls.length, 0);
});

test('путь к временному файлу уникален и удаляется при сбое скрипта', async () => {
  const paths = [];
  const capture = async (_script, env) => {
    paths.push(env.JARVIS_SHOT);
    return { ok: false, summary: 'код выхода 1', data: {} };
  };
  const [tool] = screenTools({ allowed: () => true, capture });
  const res = await tool.run({}, {});
  assert.equal(res.ok, false);
  assert.match(res.summary, /не удалось снять экран/);
  assert.equal(new Set(paths).size, 1);
  assert.equal(fs.existsSync(paths[0]), false);
  assert.equal(path.basename(paths[0]).startsWith('jarvis-shot-'), true);
});
