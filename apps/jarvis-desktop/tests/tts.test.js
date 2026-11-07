'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { SpeechClient, ReplySpeech } = require('../src/voice/tts');

// Фейковый процесс: stdin принимает строки JSON, stdout отдаёт ответы.
// behavior(req, proc) решает, что ответить; ничего не отвечая, можно проверить таймаут.
class FakeProcess extends EventEmitter {
  constructor(behavior, index) {
    super();
    this.behavior = behavior;
    this.index = index;
    this.received = [];
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new EventEmitter();
    this.stdin.write = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        this.received.push(req);
        this.behavior(req, this);
      }
      return true;
    };
  }

  reply(obj) {
    setImmediate(() => this.stdout.write(JSON.stringify(obj) + '\n'));
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function answerOk(req, proc) {
  proc.reply({ id: req.id, ok: true, file: `C:\\out\\${req.id}.wav` });
}

function fakeSpawn(behavior = answerOk) {
  const spawned = [];
  const spawnImpl = (command, args) => {
    const proc = new FakeProcess(behavior, spawned.length);
    spawned.push({ command, args, proc });
    return proc;
  };
  return { spawnImpl, spawned };
}

test('начало диктовки прерывает именно озвучку ответа, включая воспроизведение', async (t) => {
  const { spawnImpl } = fakeSpawn();
  let started;
  const playing = new Promise((resolve) => { started = resolve; });
  let playbackAborted = false;
  const voice = new SpeechClient({ spawnImpl, timeoutMs: 1000, playFn: (_file, { signal }) => new Promise((resolve) => {
    started();
    signal.addEventListener('abort', () => { playbackAborted = true; resolve({ ok: false, summary: 'остановлено' }); }, { once: true });
  }) });
  t.after(() => voice.stop());
  const errors = [];
  const reply = new ReplySpeech({ voice, onError: (e) => errors.push(e) });
  const talking = reply.speak('ответ');
  await playing;
  reply.stop();
  await talking;
  assert.equal(playbackAborted, true);
  assert.deepEqual(errors, []);
});

test('новый ответ заменяет старый, а при включённом микрофоне ответ не озвучивается', async () => {
  const signals = [];
  let listening = false;
  const voice = { speak(_text, { signal }) {
    signals.push(signal);
    return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } };
  const reply = new ReplySpeech({ voice, isListening: () => listening });
  const first = reply.speak('первый');
  const second = reply.speak('второй');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  await first;
  listening = true;
  await reply.speak('третий');
  assert.equal(signals.length, 2);
  reply.stop();
  await second;
  assert.equal(signals[1].aborted, true);
});

test('synthesize возвращает путь из ответа и переиспользует процесс', async (t) => {
  const { spawnImpl, spawned } = fakeSpawn();
  const client = new SpeechClient({ spawnImpl, timeoutMs: 1000 });
  t.after(() => client.stop());

  const file = await client.synthesize('Привет, мир');
  const sent = spawned[0].proc.received[0];
  assert.equal(file, `C:\\out\\${sent.id}.wav`);
  assert.equal(sent.text, 'Привет, мир');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'python');
  assert.equal(spawned[0].args[1], '--out-dir');

  await client.synthesize('Ещё раз');
  assert.equal(spawned.length, 1, 'второй вызов не запускает новый процесс');
});

test('очередь: второй запрос уходит только после ответа на первый', async (t) => {
  const log = [];
  const { spawnImpl } = fakeSpawn((req, proc) => {
    log.push(`старт ${req.text}`);
    setTimeout(() => {
      log.push(`конец ${req.text}`);
      proc.reply({ id: req.id, ok: true, file: `C:\\out\\${req.id}.wav` });
    }, 20);
  });
  const client = new SpeechClient({ spawnImpl, timeoutMs: 1000 });
  t.after(() => client.stop());

  const [a, b] = await Promise.all([client.synthesize('первый'), client.synthesize('второй')]);
  assert.deepEqual(log, ['старт первый', 'конец первый', 'старт второй', 'конец второй']);
  assert.notEqual(a, b);
});

test('пустой текст отказывает без запуска процесса', async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const client = new SpeechClient({ spawnImpl });

  await assert.rejects(client.synthesize('   '), /пустой текст/);
  await assert.rejects(client.synthesize(undefined), /пустой текст/);
  assert.equal(spawned.length, 0);
});

test('ошибка сервера превращается в Error', async (t) => {
  const { spawnImpl } = fakeSpawn((req, proc) => {
    proc.reply({ id: req.id, ok: false, error: 'модель не загрузилась' });
  });
  const client = new SpeechClient({ spawnImpl, timeoutMs: 1000 });
  t.after(() => client.stop());

  await assert.rejects(
    client.synthesize('текст'),
    (err) => err instanceof Error && /модель не загрузилась/.test(err.message)
  );
});

test('таймаут: молчащий процесс даёт ошибку и убивается', async (t) => {
  const { spawnImpl, spawned } = fakeSpawn(() => {});
  const client = new SpeechClient({ spawnImpl, timeoutMs: 30 });
  t.after(() => client.stop());

  await assert.rejects(
    client.synthesize('текст'),
    (err) => err instanceof Error && /таймаут 30 мс/.test(err.message)
  );
  assert.equal(spawned[0].proc.killed, true);
});

test('после таймаута локальный голос выключается до перезапуска и не ждёт снова', async () => {
  const { spawnImpl, spawned } = fakeSpawn(() => {});
  const client = new SpeechClient({ spawnImpl, timeoutMs: 20 });
  await assert.rejects(client.synthesize('текст'), /таймаут/);
  assert.match(client.disabledReason(), /не отвечает/);
  assert.equal(client.isInstalled(), false, 'повторно голос не включается');
  await assert.rejects(client.synthesize('ещё'), /не отвечает/);
  assert.equal(spawned.length, 1, 'новый процесс синтеза не запускается');
});

test('упавший процесс поднимается заново при следующем вызове', async (t) => {
  const { spawnImpl, spawned } = fakeSpawn((req, proc) => {
    if (proc.index === 0) {
      proc.emit('exit', 1);
      return;
    }
    answerOk(req, proc);
  });
  const client = new SpeechClient({ spawnImpl, timeoutMs: 1000 });
  t.after(() => client.stop());

  await assert.rejects(client.synthesize('первый'), /код 1/);
  const file = await client.synthesize('второй');
  assert.equal(spawned.length, 2, 'после падения процесс запущен заново');
  assert.equal(file, `C:\\out\\${spawned[1].proc.received[0].id}.wav`);
});

test('отменённый сигнал не запускает процесс', async () => {
  const { spawnImpl, spawned } = fakeSpawn();
  const client = new SpeechClient({ spawnImpl });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(client.synthesize('текст', { signal: controller.signal }), /отменён/);
  assert.equal(spawned.length, 0);
});

test('speak синтезирует и передаёт путь в play', async (t) => {
  const { spawnImpl } = fakeSpawn();
  const played = [];
  const client = new SpeechClient({
    spawnImpl,
    timeoutMs: 1000,
    playFn: async (file) => {
      played.push(file);
      return { ok: true, summary: 'готово' };
    },
  });
  t.after(() => client.stop());

  const file = await client.speak('привет');
  assert.deepEqual(played, [file]);
});

test('play с ok:false бросает ошибку с причиной', async () => {
  const client = new SpeechClient({
    spawnImpl: fakeSpawn().spawnImpl,
    playFn: async () => ({ ok: false, summary: 'код выхода 1' }),
  });

  await assert.rejects(client.play('C:\\out\\a.wav'), /код выхода 1/);
});

test('isInstalled: false для несуществующих путей, true когда скрипт и python на месте', () => {
  const missingDir = path.join(__dirname, 'no-such-dir');
  const missing = new SpeechClient({
    command: path.join(missingDir, 'python.exe'),
    scriptPath: path.join(missingDir, 'silero_server.py'),
  });
  assert.equal(missing.isInstalled(), false);

  const noScript = new SpeechClient({
    command: process.execPath,
    scriptPath: path.join(missingDir, 'silero_server.py'),
  });
  assert.equal(noScript.isInstalled(), false);

  // Существующие файлы: сам этот тест и бинарник node. Python при этом не запускается.
  const present = new SpeechClient({ command: process.execPath, scriptPath: __filename });
  assert.equal(present.isInstalled(), true);
});
