'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseOffline } = require('../src/shortcuts/offline');
const { runCommand } = require('../src/commands/runner');
const { cannotVerify } = require('../src/agent/effects');
const modes = require('../src/policy/modes');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReminderStore } = require('../src/schedule/store');
const { Scheduler } = require('../src/schedule/scheduler');
const { remindersTools } = require('../src/tools/reminders');

const journal = { append() {} };

test('«звук на 10» и «поставь звук 10%» ставят уровень 10, «тише на 10» не трогается', () => {
  for (const phrase of ['звук на 10', 'поставь звук 10', 'сделай громкость на 10%']) {
    const call = parseOffline(phrase);
    assert.deepEqual(call.steps, [{ tool: 'volume_set', args: { percent: 10 } }], phrase);
  }
  assert.equal(parseOffline('сделай звук тише на 10'), null);
});

test('громкость 50 разбирается в volume_set 50', () => {
  const call = parseOffline('громкость 50');
  assert.deepEqual(call.steps, [{ tool: 'volume_set', args: { percent: 50 } }]);
});

test('громкость 150 не распознаётся, фраза уходит к модели', () => {
  assert.equal(parseOffline('громкость 150'), null);
});

test('фраза без совпадения возвращает null', () => {
  assert.equal(parseOffline('расскажи анекдот'), null);
  assert.equal(parseOffline('открой отчёт.docx'), null);
});

test('опасные фразы не разбираются здесь', () => {
  assert.equal(parseOffline('удали все файлы'), null);
  assert.equal(parseOffline('выключи компьютер'), null);
  assert.equal(parseOffline('открой ютуб и отправь письмо'), null);
});

test('окна, таймер и открытие из списка разбираются', () => {
  assert.equal(parseOffline('окна свернуть').steps[0].tool, 'windows_minimize_all');
  assert.deepEqual(parseOffline('таймер 5 минут').steps[0], { tool: 'remind_in', args: { minutes: 5, text: 'таймер на 5 мин' } });
  assert.equal(parseOffline('Открой ЮТУБ').steps[0].tool, 'url_open');
  assert.equal(parseOffline('открой калькулятор').steps[0].tool, 'app_open');
  assert.equal(parseOffline('открой неизвестную программу'), null);
});

test('напоминание по фразе сохраняет текст, единицы и ограничение срока', () => {
  assert.deepEqual(parseOffline('Джарвис, напомни через час позвонить Маме!').steps[0], { tool: 'remind_in', args: { minutes: 60, text: 'позвонить Маме!' } });
  assert.deepEqual(parseOffline('напомни мне через 2 дня: оплатить счёт').steps[0], { tool: 'remind_in', args: { minutes: 2880, text: 'оплатить счёт' } });
  assert.deepEqual(parseOffline('напомни через двадцать пять минут Позвонить').steps[0], { tool: 'remind_in', args: { minutes: 25, text: 'Позвонить' } });
  assert.deepEqual(parseOffline('напомни через полчаса сделать чай').steps[0], { tool: 'remind_in', args: { minutes: 30, text: 'сделать чай' } });
  assert.equal(parseOffline('напомни через миллион минут позвонить'), null);
  assert.equal(parseOffline('напомни через 8 дней позвонить'), null);
  assert.equal(parseOffline('напомни через 0 минут позвонить'), null);
  assert.equal(parseOffline('напомни через 5 минут'), null);
  assert.equal(parseOffline('не напомни через 5 минут позвонить'), null);
});

test('напоминание по фразе проходит политику, сохраняется и доставляется планировщиком', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-offline-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date('2026-10-27T10:00:00Z');
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  const tools = remindersTools(store, { now: () => now });
  const call = parseOffline('напомни через 5 минут Позвонить Маме');
  const out = await runCommand(call, { tools: { get: (name) => tools.find((item) => item.name === name) }, policy: modes, journal, mode: 'full', workspace: dir });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].verified, 'confirmed');
  const delivered = [];
  await new Scheduler({ store, now: () => new Date('2026-10-27T10:05:00Z'), notify: (item) => delivered.push(item.text) }).tick();
  assert.deepEqual(delivered, ['Позвонить Маме']);
  assert.deepEqual(store.list(), []);
});

test('офлайн-напоминание использует реестр выбранного пространства', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-scoped-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ReminderStore(path.join(dir, 'reminders.json'));
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const tools = remindersTools(store, { now: () => new Date('2026-10-27T10:00:00Z'), workspaceId: first });
  const out = await runCommand(parseOffline('напомни через пять минут встреча'), { tools: { get: (name) => tools.find((item) => item.name === name) }, policy: modes, journal, mode: 'full', workspace: dir });
  assert.equal(out.ok, true);
  assert.equal(out.results[0].verified, 'confirmed');
  assert.deepEqual(store.list({ workspaceId: first }).map((item) => item.text), ['встреча']);
  assert.deepEqual(store.list({ workspaceId: second }), []);
  assert.deepEqual(store.list({ workspaceId: 'default' }), []);
});

test('раскладка окон разбирается без модели', () => {
  assert.deepEqual(parseOffline('разложи окна').steps[0], { tool: 'windows_arrange', args: { layout: 'grid' } });
  assert.deepEqual(parseOffline('Размести окна красиво!').steps[0], { tool: 'windows_arrange', args: { layout: 'grid' } });
  assert.deepEqual(parseOffline('окна рядом').steps[0], { tool: 'windows_arrange', args: { layout: 'row' } });
  assert.deepEqual(parseOffline('окна каскадом').steps[0], { tool: 'windows_arrange', args: { layout: 'cascade' } });
  assert.deepEqual(parseOffline('окна сеткой').steps[0], { tool: 'windows_arrange', args: { layout: 'grid' } });
  // неопределённые раскладки к модели не попадают как офлайн-фраза
  assert.equal(parseOffline('размести окна как-нибудь'), null);
});

test('шаг идёт через политику и проверку результата', async () => {
  let ran = 0;
  const tools = {
    get: (name) => (name === 'volume_set'
      ? { name, risk: 'T0', run: async () => { ran += 1; return { ok: true, summary: 'громкость ~50%', data: {} }; }, verify: cannotVerify('нет счётчика') }
      : undefined),
  };
  const call = parseOffline('громкость 50');
  const out = await runCommand(call, { tools, policy: modes, journal, mode: 'full', workspace: process.cwd() });
  assert.equal(ran, 1);
  assert.equal(out.ok, true);
  assert.equal(out.results[0].verified, 'unknown');
});

test('отказ политики не даёт выполнить шаг', async () => {
  let ran = 0;
  const tools = { get: () => ({ name: 'volume_set', risk: 'T0', run: async () => { ran += 1; return { ok: true, summary: '', data: {} }; } }) };
  const policy = { decide: () => 'deny' };
  const out = await runCommand(parseOffline('громкость 20'), { tools, policy, journal, mode: 'ask', workspace: process.cwd() });
  assert.equal(ran, 0);
  assert.equal(out.ok, false);
});
