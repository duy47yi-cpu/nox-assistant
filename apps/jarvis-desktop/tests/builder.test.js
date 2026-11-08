'use strict';

// Сборка сценария из описания словами: проверка ответа модели без сети, времени и случайности.
// Модель и набор инструментов подменяются: ни одного настоящего вызова здесь нет.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateDraft,
  buildCommandFromText,
  dryRunCommand,
  MAX_STEPS_DRAFT,
} = require('../src/commands/builder');

const TOOLS = ['app_open', 'ui_keys', 'ui_type', 'ui_click', 'wait', 'speak', 'volume_set', 'url_open'];

// Заглушка модели: отдаёт заготовленные ответы по порядку и запоминает запросы.
function fakeModel(replies) {
  const calls = [];
  const fn = async (prompt, info = {}) => {
    calls.push({ prompt, attempt: info.attempt });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof reply === 'function' ? reply() : reply;
  };
  fn.calls = calls;
  return fn;
}

const json = (value) => JSON.stringify(value);

const DRAFT_OK = {
  name: 'Утро',
  phrases: ['Доброе утро!', 'Запусти утро.'],
  steps: [
    { tool: 'app_open', args: { name: 'notepad' } },
    { tool: 'ui_keys', args: { keys: 'ctrl+n' } },
  ],
};

const text = 'утром открой блокнот и создай новый документ';

test('валидный ответ модели даёт команду схемы v2 с нормализованными фразами', async () => {
  const model = fakeModel([json({ ...DRAFT_OK, hotkey: 'ctrl+alt+y' })]);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });

  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(res.attempts, 1);
  assert.deepEqual(res.questions, []);
  const command = res.command;
  assert.equal(command.schemaVersion, 2);
  assert.equal(command.name, 'Утро');
  assert.deepEqual(command.phrases, ['доброе утро', 'запусти утро']);
  assert.equal(command.steps.length, 2);
  assert.deepEqual(command.steps[0], { tool: 'app_open', args: { name: 'notepad' } });
  assert.equal(command.enabled, true);
  assert.equal(command.hotkey, 'Control+Alt+Y');
  assert.equal(command.folder, null);
  assert.deepEqual(command.collections, []);
  assert.equal(command.origin, 'ai');
  // Хранилище само ставит id и дату: модуль их не выдумывает.
  assert.equal(command.id, undefined);
  assert.equal(command.createdAt, undefined);
});

test('неизвестный инструмент — честная ошибка, модель получает один повтор', async () => {
  const draft = { name: 'X', phrases: ['открой'], steps: [{ tool: 'notepad_open', args: {} }] };
  const model = fakeModel([json(draft)]);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });

  assert.equal(res.ok, false);
  assert.equal(res.command, null);
  assert.match(res.error, /notepad_open/);
  assert.equal(res.attempts, 2);
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].prompt, /Прошлая попытка не подошла/);
});

test('опасные инструменты не попадают в сценарий', () => {
  for (const tool of ['shell_run', 'pc_shutdown', 'app_close', 'mail_send', 'app_install']) {
    const res = validateDraft(
      { name: 'X', phrases: ['сделай'], steps: [{ tool, args: {} }] },
      { tools: [...TOOLS, tool] },
    );
    assert.equal(res.ok, false, `должен быть отказ для ${tool}`);
    assert.equal(res.command, null);
    assert.match(res.error, new RegExp(tool));
    assert.ok(res.questions.length >= 1);
  }
});

test('пустые шаги — отказ и вопрос владельцу', () => {
  const res = validateDraft({ name: 'X', phrases: ['сделай'], steps: [] }, { tools: TOOLS });
  assert.equal(res.ok, false);
  assert.match(res.error, /хотя бы один шаг/);
  assert.ok(res.questions.length >= 1);
});

test('пустые фразы — отказ и вопрос владельцу', () => {
  const res = validateDraft({ name: 'X', phrases: [], steps: [{ tool: 'wait', args: { ms: 100 } }] }, { tools: TOOLS });
  assert.equal(res.ok, false);
  assert.match(res.error, /хотя бы одна фраза/);
  assert.ok(res.questions.length >= 1);
});

test('больше 12 шагов — отказ', () => {
  const steps = Array.from({ length: MAX_STEPS_DRAFT + 1 }, () => ({ tool: 'wait', args: { ms: 100 } }));
  const res = validateDraft({ name: 'X', phrases: ['сделай'], steps }, { tools: TOOLS });
  assert.equal(res.ok, false);
  assert.match(res.error, new RegExp(`не больше ${MAX_STEPS_DRAFT}`));
});

test('предел шагов можно задать снаружи (maxSteps)', async () => {
  const draft = {
    name: 'X',
    phrases: ['сделай'],
    steps: Array.from({ length: 4 }, () => ({ tool: 'wait', args: { ms: 100 } })),
  };
  const model = fakeModel([json(draft)]);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS, maxSteps: 3 });
  assert.equal(res.ok, false);
  assert.match(res.error, /не больше 3/);
});

test('больше 5 фраз — отказ', () => {
  const res = validateDraft(
    { name: 'X', phrases: ['1', '2', '3', '4', '5', '6'], steps: [{ tool: 'wait', args: { ms: 1 } }] },
    { tools: TOOLS },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /не больше 5/);
});

test('дубли фраз после нормализации — отказ', () => {
  const res = validateDraft(
    { name: 'X', phrases: ['Открой блокнот', 'открой блокнот!'], steps: [{ tool: 'app_open', args: { name: 'notepad' } }] },
    { tools: TOOLS },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /повторяется/);
});

test('модель вернула не-JSON — ошибка без падения, две попытки', async () => {
  const model = fakeModel(['Конечно, сейчас всё сделаю. Вот как-нибудь так.']);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });
  assert.equal(res.ok, false);
  assert.match(res.error, /не JSON/);
  assert.equal(res.attempts, 2);
  assert.equal(model.calls.length, 2);
});

test('JSON в ```-блоке принимается', async () => {
  const model = fakeModel(['Вот сценарий:\n```json\n' + json(DRAFT_OK) + '\n```\nГотово.']);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(res.command.steps.length, 2);
});

test('повтор после ошибки: второй правильный ответ принимается', async () => {
  const model = fakeModel(['это не JSON', json(DRAFT_OK)]);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[0].attempt, 1);
  assert.equal(model.calls[1].attempt, 2);
});

test('сбой модели возвращается ошибкой, а не исключением', async () => {
  const model = async () => {
    throw new Error('нет связи с сервером');
  };
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });
  assert.equal(res.ok, false);
  assert.match(res.error, /нет связи с сервером/);
  assert.equal(res.attempts, 1);
});

test('модель просит уточнить — вопросы отдаются владельцу без повтора', async () => {
  const model = fakeModel([json({ questions: ['Какую программу открыть?', 'Что ввести в поле?'] })]);
  const res = await buildCommandFromText({ text, modelCall: model, tools: TOOLS });
  assert.equal(res.ok, false);
  assert.equal(res.command, null);
  assert.deepEqual(res.questions, ['Какую программу открыть?', 'Что ввести в поле?']);
  assert.equal(res.attempts, 1);
  assert.equal(model.calls.length, 1);
});

test('пустое описание: модели не зовём, просим описать словами', async () => {
  const model = fakeModel([json(DRAFT_OK)]);
  const res = await buildCommandFromText({ text: '   ', modelCall: model, tools: TOOLS });
  assert.equal(res.ok, false);
  assert.match(res.error, /описание сценария словами/);
  assert.equal(res.attempts, 0);
  assert.equal(model.calls.length, 0);
});

test('аргументы шага должны быть объектом', () => {
  const res = validateDraft(
    { name: 'X', phrases: ['открой'], steps: [{ tool: 'app_open', args: 'notepad' }] },
    { tools: TOOLS },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /args должен быть объектом/);
});

test('пустое имя — отказ', () => {
  const res = validateDraft(
    { name: '   ', phrases: ['открой'], steps: [{ tool: 'app_open', args: { name: 'notepad' } }] },
    { tools: TOOLS },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /имя/);
});

test('происхождение всегда «ai», модель его не подменяет', () => {
  const res = validateDraft(
    { ...DRAFT_OK, origin: 'manual', schemaVersion: 99 },
    { tools: TOOLS },
  );
  assert.equal(res.ok, true);
  assert.equal(res.command.origin, 'ai');
  assert.equal(res.command.schemaVersion, 2);
});

test('описания инструментов: обязательное поле не теряется', () => {
  const tools = [
    { name: 'app_open', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  ];
  const res = validateDraft(
    { name: 'X', phrases: ['открой'], steps: [{ tool: 'app_open', args: {} }] },
    { tools },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /обязательное поле/);
});

test('dryRunCommand даёт человеческие подписи и ничего не выполняет', () => {
  const command = {
    name: 'Утро',
    phrases: ['доброе утро'],
    steps: [
      { tool: 'app_open', args: { name: 'notepad' } },
      { tool: 'ui_keys', args: { keys: 'ctrl+n' } },
      { tool: 'ui_type', args: { text: 'привет' } },
    ],
  };
  const res = dryRunCommand(command, { tools: TOOLS });
  assert.equal(res.ok, true);
  assert.equal(res.saved, false);
  assert.equal(res.executed, false);
  assert.equal(res.steps.length, 3);
  assert.match(res.text, /Сценарий «Утро»/);
  assert.match(res.text, /Открыть программу/);
  assert.match(res.text, /Нажать клавиши/);
  assert.match(res.text, /Ввести текст/);
  assert.match(res.text, /«notepad»/);
  assert.match(res.steps[1].text, /^2\. /);
});

test('dryRunCommand помечает шаг, которого нет в наборе инструментов', () => {
  const res = dryRunCommand(
    { name: 'X', phrases: ['сделай'], steps: [{ tool: 'notepad_open', args: {} }] },
    { tools: TOOLS },
  );
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((note) => /нет в текущем наборе/.test(note)));
});

test('детерминизм: одинаковый вход даёт одинаковую команду', async () => {
  const build = () => buildCommandFromText({ text, modelCall: fakeModel([json(DRAFT_OK)]), tools: TOOLS });
  const first = await build();
  const second = await build();
  assert.equal(first.ok, true);
  assert.deepEqual(first.command, second.command);
  assert.equal(JSON.stringify(first.command), JSON.stringify(second.command));
});
