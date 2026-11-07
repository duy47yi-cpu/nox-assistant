'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { decide, allowKey } = require('../src/policy/modes');

const WS = path.resolve('jarvis-workspace');
const INSIDE = { path: path.join('sub', 'file.txt') };
const OUTSIDE_REL = { path: path.join('..', 'escape.txt') };
const OUTSIDE_ABS = { path: path.resolve(WS, '..', 'other', 'x.txt') };

// Правило владельца (31.10.2026): в «Полном доступе» всё разрешено; в «Спрашивать» спрашиваем только
// про удаление, отправку и оплату; остальное — сразу.

describe('режим full', () => {
  test('всё разрешено, включая T3 и неизвестный риск', () => {
    for (const risk of ['T0', 'T1', 'T2', 'T3', 'T9', undefined]) {
      assert.equal(decide({ mode: 'full', name: 'x', risk, args: OUTSIDE_ABS, workspace: WS }), 'allow', `risk=${risk}`);
    }
  });

  test('в «Полном доступе»: отправка без вопроса, удаление спрашивает, оплата запрещена', () => {
    assert.equal(decide({ mode: 'full', name: 'delete_file', risk: 'T2', args: {}, workspace: WS }), 'ask');
    assert.equal(decide({ mode: 'full', name: 'send_message', risk: 'T2', args: {}, workspace: WS }), 'allow');
    assert.equal(decide({ mode: 'full', name: 'pay_invoice', risk: 'T3', args: {}, workspace: WS }), 'deny');
  });
});

describe('режим ask (Спрашивать)', () => {
  test('чтение (T0) без вопроса', () => {
    assert.equal(decide({ mode: 'ask', name: 'x', risk: 'T0', args: INSIDE, workspace: WS }), 'allow');
  });

  test('любое действие, которое что-то меняет (T1–T3), спрашивает — как ручной режим Claude Code', () => {
    for (const risk of ['T1', 'T2', 'T3']) {
      assert.equal(decide({ mode: 'ask', name: 'x', risk, args: INSIDE, workspace: WS }), 'ask', `risk=${risk}`);
    }
  });

  test('после «на сессию» то же действие проходит без вопроса', () => {
    const sessionAllow = new Set([allowKey('x', INSIDE)]);
    assert.equal(decide({ mode: 'ask', name: 'x', risk: 'T1', args: INSIDE, workspace: WS, sessionAllow }), 'allow');
  });

  test('удаление и отправка спрашивают, оплата запрещена', () => {
    assert.equal(decide({ mode: 'ask', name: 'delete_file', risk: 'T1', args: {}, workspace: WS }), 'ask');
    assert.equal(decide({ mode: 'ask', name: 'send_message', risk: 'T1', args: {}, workspace: WS }), 'ask');
    assert.equal(decide({ mode: 'ask', name: 'pay_invoice', risk: 'T3', args: {}, workspace: WS }), 'deny');
  });

  test('удаление через shell_run спрашивает; выключение компьютера тоже спрашивает (T2 в ручном режиме)', () => {
    assert.equal(decide({ mode: 'ask', name: 'shell_run', risk: 'T2', args: { command: 'Remove-Item x' }, workspace: WS }), 'ask');
    assert.equal(decide({ mode: 'ask', name: 'shell_run', risk: 'T2', args: { command: 'Stop-Computer -Force' }, workspace: WS }), 'ask');
  });
});

describe('режим auto (Авто-умный)', () => {
  test('T0 авто', () => {
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T0', args: {}, workspace: WS }), 'allow');
  });

  test('T1 внутри workspace авто', () => {
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: INSIDE, workspace: WS }), 'allow');
  });

  test('T1 путь самой рабочей папки считается внутри', () => {
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: { path: '.' }, workspace: WS }), 'allow');
  });

  test('T1 с относительным путём наружу → ask', () => {
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: OUTSIDE_REL, workspace: WS }), 'ask');
  });

  test('T1 с абсолютным путём наружу → ask', () => {
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: OUTSIDE_ABS, workspace: WS }), 'ask');
  });

  test('T1 с общим префиксом соседней папки (ws vs ws-evil) → ask', () => {
    const args = { path: path.join(WS + 'evil', 'f.txt') };
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args, workspace: WS }), 'ask');
  });

  test('T1 без поля path → ask', () => {
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: {}, workspace: WS }), 'ask');
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: null, workspace: WS }), 'ask');
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args: INSIDE, workspace: '' }), 'ask');
  });

  test('T2 и T3 → ask даже внутри workspace', () => {
    for (const risk of ['T2', 'T3']) {
      assert.equal(decide({ mode: 'auto', name: 'x', risk, args: INSIDE, workspace: WS }), 'ask', `risk=${risk}`);
    }
  });

  test('на Windows сравнение путей без учёта регистра', { skip: process.platform !== 'win32' }, () => {
    const args = { path: path.join(WS.toUpperCase(), 'f.txt') };
    assert.equal(decide({ mode: 'auto', name: 'x', risk: 'T1', args, workspace: WS }), 'allow');
  });
});

describe('неизвестный риск и sessionAllow', () => {
  test('неизвестный риск: в «Спрашивать» и «Авто» — ask, в full — allow', () => {
    for (const risk of ['T9', '', undefined, null]) {
      assert.equal(decide({ mode: 'ask', name: 'x', risk, args: {}, workspace: WS }), 'ask');
      assert.equal(decide({ mode: 'auto', name: 'x', risk, args: INSIDE, workspace: WS }), 'ask');
      assert.equal(decide({ mode: 'full', name: 'x', risk, args: {}, workspace: WS }), 'allow');
    }
  });

  test('неизвестный режим → ask', () => {
    assert.equal(decide({ mode: 'weird', name: 'x', risk: 'T0', args: {}, workspace: WS }), 'ask');
  });

  test('sessionAllow (Set): одобрение того же вызова разрешает его в auto, для любого риска', () => {
    const sessionAllow = new Set([allowKey('mystery_tool', {})]);
    assert.equal(decide({ mode: 'auto', name: 'mystery_tool', risk: 'T2', args: {}, workspace: WS, sessionAllow }), 'allow');
    assert.equal(decide({ mode: 'auto', name: 'mystery_tool', risk: 'T3', args: {}, workspace: WS, sessionAllow }), 'allow');
  });

  test('sessionAllow не переносится на другие аргументы (режим auto)', () => {
    const sessionAllow = new Set([allowKey('url_open', { url: 'https://a' })]);
    assert.equal(decide({ mode: 'auto', name: 'url_open', risk: 'T2', args: { url: 'https://b' }, workspace: WS, sessionAllow }), 'ask');
  });

  test('sessionAllow (массив) работает так же', () => {
    const sessionAllow = [allowKey('url_open', {})];
    assert.equal(decide({ mode: 'auto', name: 'url_open', risk: 'T2', args: {}, workspace: WS, sessionAllow }), 'allow');
  });

  test('sessionAllow не влияет на другие инструменты (режим auto)', () => {
    const sessionAllow = new Set([allowKey('url_open', {})]);
    assert.equal(decide({ mode: 'auto', name: 'mystery_tool', risk: 'T2', args: {}, workspace: WS, sessionAllow }), 'ask');
  });

  test('sessionAllow перекрывает неизвестный риск в auto', () => {
    const sessionAllow = new Set([allowKey('mystery', {})]);
    assert.equal(decide({ mode: 'auto', name: 'mystery', risk: undefined, args: {}, workspace: WS, sessionAllow }), 'allow');
  });
});
