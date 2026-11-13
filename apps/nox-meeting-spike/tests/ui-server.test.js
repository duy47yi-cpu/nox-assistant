'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSpikeServer } = require('../src/server/spike-server');

test('изолированный UI-сервер: состояние idle, отказ без согласия, цикл записи, конспект и удаление', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-c7-ui-'));
  const spike = createSpikeServer({ storageDir: tmpDir });

  try {
    const { url } = await spike.listen(0, '127.0.0.1');

    // 1. HTML отдаётся корректно и содержит статус «Не записывает»
    const htmlRes = await fetch(`${url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Не записывает/);

    // 2. Начальное состояние idle
    const initState = await (await fetch(`${url}/api/state`)).json();
    assert.equal(initState.state, 'idle');
    assert.equal(initState.honesty.realMicrophoneActive, false);
    assert.equal(initState.honesty.isSyntheticOnly, true);

    // 3. Запуск без согласия отклонён (403)
    const deniedRes = await fetch(`${url}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: 'standup', captureConsent: false }),
    });
    assert.equal(deniedRes.status, 403);
    const deniedBody = await deniedRes.json();
    assert.equal(deniedBody.code, 'CONSENT_REQUIRED');

    // 4. Запуск с явным согласием и хранением
    const startRes = await fetch(`${url}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenario: 'standup',
        captureConsent: true,
        storageConsent: true,
      }),
    });
    assert.equal(startRes.status, 200);
    const started = await startRes.json();
    assert.equal(started.state, 'recording');

    // 5. Пауза -> возобновление -> завершение
    await new Promise((r) => setTimeout(r, 150));
    const paused = await (await fetch(`${url}/api/session/pause`, { method: 'POST' })).json();
    assert.equal(paused.state, 'paused');

    const resumed = await (await fetch(`${url}/api/session/resume`, { method: 'POST' })).json();
    assert.equal(resumed.state, 'recording');

    const finished = await (await fetch(`${url}/api/session/finish`, { method: 'POST' })).json();
    assert.equal(finished.state, 'completed');
    assert.ok(finished.summary);
    assert.equal(finished.persistence.saved, true);

    // 6. Удаление тестовой сессии
    const deleted = await (await fetch(`${url}/api/session`, { method: 'DELETE' })).json();
    assert.equal(deleted.state, 'idle');
    assert.equal(deleted.savedSessions.length, 0);
  } finally {
    await spike.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
