'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { createServer } = require('../server');

test('учебный приёмник хранит только материалы владельца, переживает перезапуск и удаляет только подтверждённое', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-server-inbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = 'fixture-key-with-at-least-thirty-two-characters';
  const messages = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1xkAAAAASUVORK5CYII=', 'base64');
  const update = (id, owner, data) => ({
    update_id: id, message: { from: { id: owner }, chat: { type: 'private', id: owner }, ...data },
  });
  const updates = [
    update(1, 666, { text: 'На учёбу: чужое' }),
    update(2, 555, { text: 'Включи музыку' }),
    update(3, 555, { text: 'На учёбу: закон Ома' }),
    update(4, 555, { caption: 'На учёбу: Физика', photo: [{ file_id: 'photo' }] }),
  ];
  const get = async (url, options) => {
    if (url.includes('/file/bot')) return new Response(png);
    const request = JSON.parse(options.body);
    if (url.endsWith('/getUpdates')) return Response.json({ ok: true, result: updates.filter((item) => item.update_id >= request.offset) });
    if (url.endsWith('/getFile')) return Response.json({ ok: true, result: { file_path: 'photos/fixture.png', file_size: png.length } });
    assert.equal(request.chat_id, '555');
    messages.push(request.text);
    return Response.json({ ok: true, result: {} });
  };
  const config = {
    dbFile: path.join(dir, 'local.db'),
    models: { fast: { url: 'http://local', key: '', model: 'fixture', price: { inputPerM: 0, outputPerM: 0 } } },
    studyInbox: { token: 'fixture', owner: '555', key, file: path.join(dir, 'inbox.json'), fetchImpl: get, poll: false },
  };
  const start = async () => {
    const current = createServer(config);
    current.server.listen(0, '127.0.0.1');
    await once(current.server, 'listening');
    return { ...current, url: `http://127.0.0.1:${current.server.address().port}/v1/study-inbox`,
      close: () => new Promise((resolve) => current.server.close(resolve)) };
  };
  const first = await start();
  try {
    await first.studyInbox.pollOnce();
    assert.equal(messages.filter((text) => text.includes('Сохранено в очереди')).length, 2);
    assert.equal((await fetch(first.url)).status, 401);
  } finally { await first.close(); }

  const next = await start();
  try {
    const headers = { Authorization: `Bearer ${key}` };
    const getItem = async () => (await (await fetch(next.url, { headers })).json()).item;
    const ack = (id) => fetch(`${next.url}/ack?id=${id}`, { method: 'POST', headers });
    await next.studyInbox.pollOnce();
    const note = await getItem();
    assert.equal(note.text, 'закон Ома');
    assert.equal((await ack(note.id)).status, 200);
    const photo = await getItem();
    assert.deepEqual(Buffer.from(photo.photo, 'base64'), png);
    await ack(note.id);
    assert.equal((await getItem()).id, photo.id);
    await ack(photo.id);
    assert.equal(await getItem(), null);
  } finally { await next.close(); }
});
