'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVad, voicePhrase, voiceInputSettings } = require('../src/voice/input');
const { parseWakeWords } = require('../src/voice/wake');
const { parseApprovalAnswer } = require('../src/policy/approvals');
const { createSttRouter, cloudProvider, wavFromPcm } = require('../src/voice/stt');
const { resolveLocalTurnAsync } = require('../src/shortcuts/scenarios');

test('editable wake phrases match a whole prefix, including case and ё', () => {
  const words = parseWakeWords('Джарвис, Алёша, сэр, аЛЕша, ');
  assert.deepEqual(words, ['джарвис', 'алеша', 'сэр']);
  assert.deepEqual(voicePhrase('«АЛЁША, сверни все окна!»', { words, prefixMode: true }),
    { command: 'сверни все окна', addressed: true });
  assert.equal(voicePhrase('алёшкин сверни все окна', { words, prefixMode: true }), null);
  assert.equal(voicePhrase('сверни все окна', { words, prefixMode: true }), null);
  assert.equal(voicePhrase('сверни все окна', { words, mode: 'quiet' }), null);
  assert.equal(voicePhrase('сэр сверни все окна', { words, mode: 'off' }), null);
  assert.equal(voicePhrase('сверни все окна', { words: [], prefixMode: true }).command, 'сверни все окна');
  assert.equal(voicePhrase('сверни все окна').command, 'сверни все окна');
  assert.equal(voicePhrase('жарвис, сверни все окна').command, 'сверни все окна');
  assert.equal(voicePhrase('джарвиз сверни все окна', { prefixMode: true }).command, 'сверни все окна');
  assert.equal(voicePhrase('джарвизов сверни все окна', { prefixMode: true }), null);
  assert.equal(voicePhrase('джарвиз сверни все окна', { words: ['сэр'], prefixMode: true }), null);
});

test('spoken command separators are editable and still require complete commands on both sides', async () => {
  const context = { linkWords: ['переходи дальше'] };
  const result = await resolveLocalTurnAsync('сверни все окна переходи дальше ярче', context);
  assert.equal(result.steps.length, 2);
  const without = await resolveLocalTurnAsync('сверни все окна переходи дальше ярче', { linkWords: [] });
  assert.equal(without, null);
});

test('spoken confirmations support editable phrases and reject ambiguous answers', () => {
  const defaults = voiceInputSettings({});
  const options = { yes: defaults.voiceYes, no: defaults.voiceNo };
  assert.equal(parseApprovalAnswer('Да, подтверждаю!', options), 'once');
  assert.equal(parseApprovalAnswer('Нет, отмена.', options), 'reject');
  assert.equal(parseApprovalAnswer('да нет', options), null);
  assert.equal(parseApprovalAnswer('добро даю', { yes: 'добро даю', no: 'не согласен' }), 'once');
  assert.equal(parseApprovalAnswer('не согласен', { yes: 'да', no: 'не согласен' }), 'reject');
  assert.equal(parseApprovalAnswer('да', { yes: 'да', no: 'да' }), null);
  assert.equal(parseApprovalAnswer('да', { yes: '' }), null);
});

test('VAD reports speech after 60 ms and releases a phrase after 600 ms of silence', () => {
  const state = [];
  const vad = createVad({ onStart: () => state.push('start'), onPhrase: (pcm) => state.push(pcm) });
  const silence = Buffer.alloc(640);
  const voice = Buffer.alloc(640);
  for (let i = 0; i < voice.length; i += 2) voice.writeInt16LE(1200, i);
  for (let i = 0; i < 12; i++) vad(silence);
  vad(Buffer.concat([voice, voice, voice]));
  assert.deepEqual(state, ['start']);
  for (let i = 0; i < 8; i++) vad(voice);
  vad(Buffer.alloc(29 * 640));
  assert.equal(state.length, 1);
  vad(silence);
  assert.equal(state.length, 2);
  assert.ok(state[1].includes(voice));
});

test('automatic STT needs explicit consent, handles offline mode and logs fallback', async () => {
  const seen = [];
  let connected = true;
  let failCloud = false;
  const local = { name: 'локальный', transcribe: async () => ({ text: 'локально' }) };
  const cloud = { name: 'облачный', isAvailable: () => true, transcribe: async () => {
    if (failCloud) throw new Error('internal provider error');
    return { text: 'облако' };
  } };
  const router = createSttRouter({ local, cloud, online: () => connected, log: (entry) => seen.push(entry) });
  const samples = Buffer.alloc(640);
  assert.equal((await router.transcribe(samples, { engine: 'auto' })).text, 'локально');
  assert.equal((await router.transcribe(samples, { engine: 'local', allowCloud: true })).text, 'локально');
  assert.equal((await router.transcribe(samples, { engine: 'auto', allowCloud: true })).text, 'облако');
  assert.equal((await router.transcribe(samples, { engine: 'cloud' })).text, 'облако');
  failCloud = true;
  assert.equal((await router.transcribe(samples, { engine: 'auto', allowCloud: true })).text, 'локально');
  connected = false;
  assert.equal((await router.transcribe(samples, { engine: 'cloud' })).text, 'локально');
  assert.deepEqual(seen.map(({ name, fallback }) => [name, fallback]), [
    ['локальный', undefined], ['локальный', undefined], ['облачный', undefined], ['облачный', undefined],
    ['облачный', 'локальный'], ['локальный', undefined], ['облачный', 'локальный'], ['локальный', undefined],
  ]);
});

test('aborted recognition never switches providers or dispatches a stale result', async () => {
  const controller = new AbortController();
  const local = { transcribe: () => assert.fail('Called an engine after cancellation') };
  const cloud = { isAvailable: () => true, transcribe: async () => {
    controller.abort();
    return { text: 'устарело' };
  } };
  const router = createSttRouter({ local, cloud, online: () => true });
  await assert.rejects(router.transcribe(Buffer.alloc(640), { engine: 'cloud' }, controller.signal), { name: 'AbortError' });
});

test('configured cloud receives a mono 16 kHz WAV and omits the automatic language field', async () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const provider = cloudProvider({ url: 'https://example.invalid/asr', model: 'fixture', request: async (_, options) => {
    const form = options.body;
    assert.equal(form.get('language'), null);
    assert.equal(form.get('model'), 'fixture');
    const wav = Buffer.from(await form.get('file').arrayBuffer());
    assert.deepEqual(wav, wavFromPcm(pcm));
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.deepEqual(wav.subarray(44), pcm);
    return { ok: true, json: async () => ({ text: 'проверка' }) };
  } });
  assert.equal((await provider.transcribe(pcm, { language: 'auto' })).text, 'проверка');
});
