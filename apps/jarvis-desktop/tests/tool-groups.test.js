'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleTools, openGroups, groupOf } = require('../src/tools/groups');
const { Agent } = require('../src/agent/loop');

const NAMES = [
  'workspace_read', 'remember', 'web_search', 'desktop_observe', 'ui_click', 'mouse_click', 'desktop_click', 'wait_for',
  'browser_open', 'document_write', 'project_run', 'command_create', 'mission_add', 'mail_send', 'app_install',
  'windows_snap', 'windows_list', 'mcp_notion_search',
];
const LIST = NAMES.map((name) => ({ name }));
const seen = (history) => visibleTools(LIST, history).map((t) => t.name);
const user = (content) => ({ role: 'user', content });
const called = (name) => ({ role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name, arguments: '{}' } }] });

test('без повода видно только ядро и сторонние подключения, порядок прежний', () => {
  assert.deepEqual(seen([user('какая погода завтра?')]), ['workspace_read', 'remember', 'web_search', 'desktop_observe', 'windows_list', 'mcp_notion_search']);
});

test('слова владельца открывают нужную группу', () => {
  assert.ok(seen([user('нажми кнопку Сохранить')]).includes('ui_click'));
  assert.ok(seen([user('зайди на сайт и найди цену')]).includes('browser_open'));
  assert.ok(seen([user('сделай презентацию про кошек')]).includes('document_write'));
  assert.ok(seen([user('напиши письмо Ивану')]).includes('mail_send'));
  assert.ok(seen([user('каждое утро присылай сводку')]).includes('mission_add'));
  assert.ok(!seen([user('напиши письмо Ивану')]).includes('project_run'));
});

test('после снимка экрана открываются руки, вызванная группа остаётся открытой', () => {
  const history = [user('что там у меня?'), called('desktop_observe'), user('давай дальше')];
  assert.ok(seen(history).includes('desktop_click'));
  assert.ok(seen([user('привет'), called('browser_open'), user('ещё')]).includes('browser_open'));
});

test('группа держится, пока повод в хвосте истории, и закрывается потом', () => {
  const filler = Array.from({ length: 45 }, () => user('спасибо'));
  assert.ok(seen([user('нажми ОК'), user('и ещё раз')]).includes('ui_click'));
  assert.ok(!seen([user('нажми ОК'), ...filler]).includes('ui_click'));
});

test('ответ инструмента в роли пользователя группы не открывает', () => {
  const open = openGroups([{ role: 'user', content: 'Снимок: нажми кнопку оплаты на сайте', fromTool: true }]);
  assert.equal(open.size, 0);
  assert.equal(groupOf('mcp_notion_search'), null);
});

test('агент показывает модели отобранные инструменты, а запускает любой из реестра', async () => {
  const sent = [];
  let ran = false;
  const hidden = { name: 'ui_click', description: '', parameters: { type: 'object', properties: {} }, risk: 'T0', run: async () => { ran = true; return { ok: true, summary: 'нажато', data: {} }; } };
  const core = { name: 'remember', description: '', parameters: { type: 'object', properties: {} }, risk: 'T0', run: async () => ({ ok: true, summary: 'ок', data: {} }) };
  const brain = {
    async chat({ tools }) {
      sent.push((tools || []).map((t) => t.function.name));
      return sent.length === 1 ? { content: '', toolCalls: [{ id: 'c1', name: 'ui_click', args: {} }] } : { content: 'готово', toolCalls: [] };
    },
  };
  const all = [core, hidden];
  const agent = new Agent({
    brain, tools: { list: () => all, get: (name) => all.find((t) => t.name === name) }, journal: { append() {} }, emit() {},
    mode: 'full', systemPrompt: 'база', toolView: visibleTools,
  });
  await agent.run('привет');
  assert.deepEqual(sent[0], ['remember'], 'в первом запросе скрытой группы нет');
  assert.equal(ran, true, 'вызов скрытого инструмента по имени всё равно исполнен');
  assert.deepEqual(sent[1], ['remember', 'ui_click'], 'после вызова группа открыта');
});
