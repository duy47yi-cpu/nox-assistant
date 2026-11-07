'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { ApprovalBroker } = require('../src/policy/approvals');
const { decide, hasSecretEgress } = require('../src/policy/modes');
const { isTaintSource, isForeignTextSource, isEgress, isHandsAction, TAINT_SOURCES, EGRESS_TOOLS, HAND_ACTIONS } = require('../src/policy/taint');

function scriptedBrain(steps) {
  let i = 0;
  return {
    async chat() {
      const s = steps[i++];
      if (!s) throw new Error('сценарий закончился');
      return { content: s.content || '', reasoningContent: null, toolCalls: s.toolCalls || [] };
    },
  };
}

function tool(name, risk, run) {
  return { name, risk, description: name, parameters: { type: 'object', properties: {} }, run };
}

function registry(...tools) {
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return reg;
}

describe('заражение контекста: правила', () => {
  test('страница, экран, файл и MCP считаются недоверенным текстом', () => {
    for (const name of ['web_fetch', 'web_search', 'web_research', 'agents_parallel', 'project_brief', 'project_diagnostics', 'browser_read', 'screen_look', 'desktop_observe', 'workspace_read', 'document_read', 'clipboard_get', 'ui_elements']) {
      assert.equal(isTaintSource(name, null), true, name);
    }
    assert.equal(isTaintSource('mcp_some_tool', 'mcp'), true);
    assert.equal(isTaintSource('echo', null), false);
  });

  test('исходящими считаются почта, PowerShell, браузер, ссылка и буфер', () => {
    for (const name of ['mail_send', 'shell_run', 'browser_type', 'browser_open', 'url_open', 'clipboard_set']) {
      assert.equal(isEgress(name), true, name);
    }
    assert.equal(isEgress('ui_click'), false);
    assert.ok(TAINT_SOURCES.size > 0 && EGRESS_TOOLS.size > 0);
  });

  test('руками считаются клики и ввод, а не прокрутка', () => {
    for (const name of ['desktop_click', 'desktop_type', 'ui_click', 'ui_type', 'ui_keys', 'ui_set_toggle', 'mouse_click', 'browser_click']) {
      assert.equal(isHandsAction(name), true, name);
    }
    assert.equal(isHandsAction('mouse_scroll'), false);
    assert.equal(isHandsAction('ui_click'), true, 'клик — рука, хотя он и не исходящий');
    assert.ok(HAND_ACTIONS.size > 0);
  });

  test('чужой текст — страница и файл, свой снимок экрана — нет', () => {
    for (const name of ['web_fetch', 'web_research', 'agents_parallel', 'project_brief', 'project_diagnostics', 'workspace_read', 'document_read', 'clipboard_get']) {
      assert.equal(isForeignTextSource(name, null), true, name);
    }
    for (const name of ['screen_look', 'desktop_observe', 'ui_elements']) {
      // Снимок нужен рукам каждый раз: после него клик молча, иначе руки встали бы.
      assert.equal(isForeignTextSource(name, null), false, name);
    }
    assert.equal(isForeignTextSource('mcp_some_tool', 'mcp'), true);
  });

  test('в «Полном доступе» руки после чужого текста добавляют вопрос, но не запрет', () => {
    const click = { mode: 'full', name: 'ui_click', risk: 'T1', args: { window: 'Блокнот', name: 'ОК' } };
    assert.equal(decide({ ...click, handsTainted: false }), 'allow', 'свой текст: клик молча');
    assert.equal(decide({ ...click, handsTainted: true }), 'ask', 'чужой текст: клик с вопросом');
    assert.equal(decide({ mode: 'full', name: 'mouse_scroll', risk: 'T1', args: {}, handsTainted: true }), 'allow', 'прокрутка — не рука');
    // Оплата по-прежнему запрещена, чужая страница её не смягчает.
    assert.equal(decide({ mode: 'full', name: 'pay_now', risk: 'T3', args: {}, handsTainted: true }), 'deny');
  });

  test('в «Полном доступе» заражение добавляет вопрос, но не запрет', () => {
    assert.equal(decide({ mode: 'full', name: 'mail_send', risk: 'T2', args: { to: 'a@b.c', body: 'привет' }, tainted: false }), 'allow');
    assert.equal(decide({ mode: 'full', name: 'mail_send', risk: 'T2', args: { to: 'a@b.c', body: 'привет' }, tainted: true }), 'ask');
    assert.equal(decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command: 'Get-Date' }, tainted: true }), 'ask');
    assert.equal(decide({ mode: 'full', name: 'echo', risk: 'T0', args: {}, tainted: true }), 'allow');
    // Оплата по-прежнему запрещена, заражение её не смягчает.
    assert.equal(decide({ mode: 'full', name: 'pay_now', risk: 'T3', args: {}, tainted: true }), 'deny');
  });

  test('секрет в исходящем аргументе спрашивает даже в «Полном доступе»', () => {
    const secretMail = { to: 'a@b.c', body: 'вот пароль: hunter2' };
    const cleanMail = { to: 'a@b.c', body: 'созвонимся в пять' };
    assert.equal(hasSecretEgress({ name: 'mail_send', args: secretMail }), true);
    assert.equal(hasSecretEgress({ name: 'mail_send', args: { to: 'a@b.c', password: 'hunter2' } }), true);
    assert.equal(hasSecretEgress({ name: 'mail_send', args: cleanMail }), false);
    assert.equal(decide({ mode: 'full', name: 'mail_send', risk: 'T2', args: secretMail }), 'ask');
    assert.equal(decide({ mode: 'full', name: 'mail_send', risk: 'T2', args: cleanMail }), 'allow');
    assert.equal(decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command: 'echo sk-abcdefghijklmnopqrst' } }), 'ask');
    // Обычная команда с длинным именем — не секрет: широкое правило здесь не годится.
    assert.equal(decide({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command: 'Get-CimInstance Win32_OperatingSystem' } }), 'allow');
    // Запись в файл — не исходящее: секрет в тексте не повод спрашивать.
    assert.equal(hasSecretEgress({ name: 'workspace_write', args: { text: 'пароль: hunter2' } }), false);
  });
});

describe('заражение контекста: цикл агента', () => {
  async function run(mode, script, tools) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-taint-'));
    const events = [];
    const approvals = new ApprovalBroker({ timeoutMs: 1000 });
    const agent = new Agent({
      brain: scriptedBrain(script),
      tools: registry(...tools),
      approvals,
      emit: (e) => {
        events.push(e);
        if (e.type === 'approval_request') approvals.respond(e.id, 'once');
      },
      mode,
      workspace: dir,
    });
    await agent.run('сделай');
    fs.rmSync(dir, { recursive: true, force: true });
    return events;
  }

  test('после чтения страницы почта спрашивает и выполняется только после согласия', async () => {
    let mailed = 0;
    const events = await run('full', [
      { toolCalls: [{ id: 't1', name: 'web_fetch', args: { url: 'https://example.com' } }] },
      { toolCalls: [{ id: 't2', name: 'mail_send', args: { to: 'a@b.c', body: 'текст' } }] },
      { content: 'Готово' },
    ], [
      tool('web_fetch', 'T0', async () => ({ ok: true, summary: 'страница прочитана', data: { text: 'недоверенный текст' } })),
      tool('mail_send', 'T2', async () => { mailed += 1; return { ok: true, summary: 'письмо отправлено', data: {} }; }),
    ]);
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 1);
    assert.equal(mailed, 1);
  });

  test('без недоверенного текста почта в «Полном доступе» идёт без вопроса', async () => {
    let mailed = 0;
    const events = await run('full', [
      { toolCalls: [{ id: 't1', name: 'mail_send', args: { to: 'a@b.c', body: 'текст' } }] },
      { content: 'Готово' },
    ], [
      tool('mail_send', 'T2', async () => { mailed += 1; return { ok: true, summary: 'письмо отправлено', data: {} }; }),
    ]);
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
    assert.equal(mailed, 1);
  });

  test('после чужой страницы клик спрашивает, после своего снимка — молча', async () => {
    let clicked = 0;
    const events = await run('full', [
      { toolCalls: [{ id: 't1', name: 'web_fetch', args: { url: 'https://example.com' } }] },
      { toolCalls: [{ id: 't2', name: 'ui_click', args: { window: 'Блокнот', name: 'Отправить' } }] },
      { content: 'Готово' },
    ], [
      tool('web_fetch', 'T0', async () => ({ ok: true, summary: 'страница прочитана', data: {} })),
      tool('ui_click', 'T1', async () => { clicked += 1; return { ok: true, summary: 'нажато', data: {} }; }),
    ]);
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 1);
    assert.equal(clicked, 1);

    let shotClicked = 0;
    const shotEvents = await run('full', [
      { toolCalls: [{ id: 't1', name: 'desktop_observe', args: {} }] },
      { toolCalls: [{ id: 't2', name: 'ui_click', args: { window: 'Блокнот', name: 'ОК' } }] },
      { content: 'Готово' },
    ], [
      tool('desktop_observe', 'T0', async () => ({ ok: true, summary: 'снимок', data: {} })),
      tool('ui_click', 'T1', async () => { shotClicked += 1; return { ok: true, summary: 'нажато', data: {} }; }),
    ]);
    assert.equal(shotEvents.filter((e) => e.type === 'approval_request').length, 0);
    assert.equal(shotClicked, 1);
  });

  test('заражение сбрасывается к следующему ходу', async () => {
    let mailed = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-taint-'));
    const events = [];
    const approvals = new ApprovalBroker({ timeoutMs: 1000 });
    const brain = scriptedBrain([
      { toolCalls: [{ id: 't1', name: 'web_fetch', args: {} }] },
      { content: 'прочитал' },
      { toolCalls: [{ id: 't2', name: 'mail_send', args: {} }] },
      { content: 'отправил' },
    ]);
    const agent = new Agent({
      brain,
      tools: registry(
        tool('web_fetch', 'T0', async () => ({ ok: true, summary: 'страница', data: {} })),
        tool('mail_send', 'T2', async () => { mailed += 1; return { ok: true, summary: 'письмо', data: {} }; }),
      ),
      approvals,
      emit: (e) => {
        events.push(e);
        if (e.type === 'approval_request') approvals.respond(e.id, 'once');
      },
      mode: 'full',
      workspace: dir,
    });
    await agent.run('первый');
    await agent.run('второй');
    fs.rmSync(dir, { recursive: true, force: true });
    // В первом ходу было только чтение; во втором заражения уже нет — почта прошла без вопроса.
    assert.equal(events.filter((e) => e.type === 'approval_request').length, 0);
    assert.equal(mailed, 1);
  });
});
