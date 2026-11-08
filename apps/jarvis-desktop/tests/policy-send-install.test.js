'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/policy/modes');

test('полный доступ: «установи» названный пакет в команде — без вопроса, другой пакет — вопрос', () => {
  const cmd = (command) => ({ mode: 'full', name: 'shell_run', risk: 'T2', args: { command } });
  assert.equal(decide({ ...cmd('python -m pip install python-pptx --quiet'), ownerText: 'установи python-pptx' }), 'allow');
  assert.equal(decide({ ...cmd('winget install --id VideoLAN.VLC -e'), ownerText: 'установи VideoLAN.VLC' }), 'allow');
  assert.equal(decide({ ...cmd('python -m pip install requests'), ownerText: 'установи python-pptx' }), 'ask');
  // Без просьбы установить — вопрос, даже если установка похожа на нужную.
  assert.equal(decide({ ...cmd('python -m pip install python-pptx'), ownerText: 'сделай презентацию' }), 'ask');
});

test('полный доступ: прямая просьба написать в мессенджер проходит после чтения страниц', () => {
  const typing = { mode: 'full', name: 'ui_type', risk: 'T2', args: { text: 'привет', window: 'WhatsApp' }, tainted: true, handsTainted: true };
  assert.equal(decide({ ...typing, ownerText: 'напиши маме в ватсап привет' }), 'allow');
  assert.equal(decide({ ...typing, ownerText: 'что такое отправка сообщений?' }), 'ask');
  assert.equal(decide({ ...typing, ownerText: '' }), 'ask');
});

test('полный доступ: письмо без названного адреса или на другой адрес — вопрос', () => {
  const mail = (ownerText, to = 'new@example.com') => decide({ mode: 'full', name: 'mail_send', source: 'mail', risk: 'T2', args: { to, subject: 's', body: 'b' }, ownerText, tainted: true });
  assert.equal(mail('Отправь письмо на new@example.com'), 'allow');
  assert.equal(mail('Отправь письмо Васе'), 'ask');
  assert.equal(mail('Отправь письмо на other@example.com'), 'ask');
});

test('секрет в исходящем спрашивается даже по прямой просьбе в полном доступе', () => {
  const r = decide({ mode: 'full', name: 'mail_send', source: 'mail', risk: 'T2', args: { to: 'new@example.com', subject: 's', body: 'пароль: hunter2' }, ownerText: 'Отправь письмо на new@example.com' });
  assert.equal(r, 'ask');
});
