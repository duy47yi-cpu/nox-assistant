'use strict';

// electron scripts/voice-qa.js <rev directory> <output directory> [--live | --reminder]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { app, BrowserWindow, net, globalShortcut } = require('electron');
const { wavFromPcm } = require('../src/voice/stt');

const [rev, out] = process.argv.slice(2);
const live = process.argv.includes('--live');
const reminderCheck = process.argv.includes('--reminder');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-voice-qa-'));
const dir = path.join(temp, 'voice-test');
fs.mkdirSync(dir);
fs.mkdirSync(out, { recursive: true });
for (const key of Object.keys(process.env)) {
  if (/^(NOX_|JARVIS_|TELEGRAM_|FISH_|DEEPSEEK_)/i.test(key)) delete process.env[key];
}
process.env.NOX_DATA_DIR = dir;
require('../src/config/paths').projectRoot = () => temp;
app.setPath('userData', path.join(temp, 'profile'));
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
function fixturePcm(file) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
}
if (live || reminderCheck) {
  const pcm = fixturePcm(path.join(rev, '_probe', 'cmd', 's1.wav'));
  const source = path.join(temp, 'microphone.wav');
  fs.writeFileSync(source, wavFromPcm(Buffer.concat([Buffer.alloc(16000), pcm, Buffer.alloc(128000)])));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', source);
}

const settingsPath = path.join(dir, 'settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({
  seededBrief: true, motion: false, mode: 'full', uiShell: 'aether', dictation: true,
  voice: true, voiceEngine: 'system', voiceLatency: 'quality',
  ...(live ? { sttModelFolder: path.join(rev, '_models', 'gigaam') } : {}),
  ...(reminderCheck ? { sttEngine: 'cloud' } : {}),
}));
const journalPath = path.join(dir, 'journal.jsonl');
function journal() {
  if (!fs.existsSync(journalPath)) return [];
  return fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 16000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = await fn();
    if (found) return found;
    await wait(90);
  }
  throw new Error('Не дождались: ' + label);
}

let server;
let online = reminderCheck;
let requests = 0;
let fail = false;
const result = {};
const speechEvents = [];
const cloudRequests = [];
async function main() {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/speech') {
        cloudRequests.push(JSON.parse(Buffer.concat(chunks)).input);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wavFromPcm(Buffer.alloc(3200)));
        return;
      }
      requests++;
      res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
      const text = reminderCheck
        ? requests === 1 ? 'Напомни через час позвонить маме.' : 'Что у меня сегодня?'
        : 'который час';
      res.end(JSON.stringify({ text }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  process.env.NOX_STT_URL = origin + '/transcriptions';
  process.env.NOX_STT_MODEL = 'test';
  process.env.NOX_TTS_URL = origin + '/speech';
  process.env.NOX_TTS_MODEL = 'test';
  process.env.NOX_TTS_VOICE = 'test';
  net.isOnline = () => online;
  const output = require('../src/voice/output');
  const makeProvider = output.cloudSpeech;
  output.cloudSpeech = (config) => makeProvider({ ...config, play: async (file) => {
    assert.equal(fs.readFileSync(file).toString('ascii', 8, 12), 'WAVE');
    speechEvents.push('WAV');
  } });
  require('../main.js');
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/aether/index.html')), 'основное окно');
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await until(() => js("!!document.querySelector('.ae-nav-btn[data-route=settings], .lx-hdr-icon-btn[title=Настройки]')"), 'навигация');
  await js("document.querySelector('.ae-nav-btn[data-route=settings], .lx-hdr-icon-btn[title=Настройки]').click()");
  await until(() => js("!document.querySelector('#aeSettingsView').hidden"), 'настройки');
  win.show();

  const settings = () => js('window.jarvis.getSettings()');
  const set = (key, value) => js(`window.jarvis.setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
  const preview = () => js('window.jarvis.voiceTest()');
  if (reminderCheck) {
    const started = Date.now();
    await js("window.jarvis.dictationMode('listening')");
    result.reminder = await until(() => js("window.jarvis.remindersList().then(r => r.items?.find(item => item.text.includes('позвонить маме')))"),
      'создание напоминания голосом', 32000);
    result.dueMinutes = Math.round((Date.parse(result.reminder.dueAt) - started) / 60000);
    assert.equal(result.dueMinutes, 60);
    result.briefingPhrase = await until(() => js("window.jarvis.chatHistory().then(r => JSON.stringify(r).toLowerCase().includes('что у меня сегодня'))"),
      'фраза сводки дошла до чата', 30000);
    await js("window.jarvis.dictationMode('off')");
    const shifted = await js(`window.jarvis.remindersUpdate(${JSON.stringify(result.reminder.id)}, { dueAt: new Date().toISOString() })`);
    assert.equal(shifted.ok, true);
    result.fired = await until(() => js(`window.jarvis.remindersList({ includeDone: true })
      .then(r => r.items?.find(item => item.id === ${JSON.stringify(result.reminder.id)} && item.done && item.firedAt))`),
    'срабатывание напоминания после переноса на текущее время', 45000);
    result.transcription = 'loopback fixture';
    result.journal = journal();
    return;
  }
  const fixture = path.join(temp, 'reading.txt');
  fs.writeFileSync(fixture, 'Первый фрагмент. Второй фрагмент.');
  const reader = require('../src/tools/desktop').desktopTools.find((tool) => tool.name === 'read_clipboard_aloud');
  const read = () => reader.run({ source: 'file', path: fixture });
  assert.equal((await settings()).voiceOutput, 'off');
  assert.equal((await set('voice', true)).ok, false);
  for (const legacy of ['system', 'local', 'realistic', 'cloud']) {
    assert.equal((await set('voiceEngine', legacy)).ok, false);
    assert.equal((await set('voiceOutput', legacy)).ok, legacy === 'cloud');
    if (legacy === 'cloud') await set('voiceOutput', 'off');
  }
  assert.equal((await set('voiceLatency', 'low')).ok, false);
  const disabled = await preview();
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /Озвучка выключена/u);
  assert.match((await read()).summary, /Озвучка выключена/u);
  assert.deepEqual(cloudRequests, []);
  result.legacySettingsSilent = true;

  for (const [width, height] of [[1200, 720], [864, 520]]) {
    win.setContentSize(width, height);
    for (const [section, name] of [['voice', 'voice-input'], ['speech', 'speech-output']]) {
      await js(`document.querySelector('[data-section="${section}"]').click()`);
      await wait(180);
      const shot = await win.webContents.capturePage();
      assert.deepEqual(shot.getSize(), { width, height });
      fs.writeFileSync(path.join(out, `${name}-${width}x${height}.png`), shot.toPNG());
    }
  }
  result.screens = 4;
  if (live) {
    await js("document.querySelector('[data-section=workshop]').click()");
    const before = journal().length;
    await set('prefixMode', true);
    await set('wakeWords', 'эй нокс');
    await js("window.jarvis.dictationMode('listening')");
    await until(() => js('window.jarvis.dictationState().then(s => s.recording)'), 'аудиопоток микрофона');
    const local = await until(() => journal().slice(before).find((row) => row.tool === 'распознавание речи' && row.ok), 'локальное распознавание', 32000);
    assert.match(local.summary, /локальный.*сверни все окна/u);
    result.local = local.summary;
    await js("window.jarvis.dictationMode('off')");

    online = true;
    assert.equal(requests, 0);
    await js("Promise.all([window.jarvis.setSetting('wakeWords', 'эй нокс'), window.jarvis.setSetting('sttCloudAllowed', true)])");
    await js("window.jarvis.dictationMode('listening')");
    const cloud = await until(() => journal().find((row) => row.ok && row.tool === 'распознавание речи' && row.summary.startsWith('облачный')), 'HTTP-распознавание');
    result.cloud = cloud.summary;
    const historyHasTime = () => js("window.jarvis.chatHistory().then(x => JSON.stringify(x).includes('который час'))");
    assert.equal(await historyHasTime(), false);
    result.prefixRequired = true;
    await js("window.jarvis.setSetting('prefixMode', false)");
    await until(historyHasTime, 'команда без префикса');
    result.noPrefix = true;
    result.silentReply = speechEvents.length === 0;
    assert.equal(result.silentReply, true);
    await js("window.jarvis.setSetting('prefixMode', true)");
    fail = true;
    const fallback = await until(() => journal().find((row) => row.decision === 'fallback'), 'отказ облачного HTTP');
    result.cloudFailure = fallback.summary;
    const after = journal().length;
    online = false;
    const offlineIndex = await until(() => {
      const index = journal().findIndex((row, index) => index >= after && row.decision === 'fallback' && !row.summary.includes('мс'));
      return index < 0 ? null : index;
    }, 'обнаружение отключённой сети');
    await until(() => journal().slice(offlineIndex + 1).find((row) => row.ok && row.tool === 'распознавание речи' && row.summary.startsWith('локальный')), 'локальный результат после потери сети');
    await js("window.jarvis.dictationMode('off')");
    result.offlineFallback = true;
    result.requests = requests;
    const failure = js(`(async () => {
      const message = new Promise((resolve) => {
        const unsubscribe = window.jarvis.onDictationEvent((event) => {
          if (event.type === 'error') { unsubscribe(); resolve(event.message); }
        });
      });
      await window.jarvis.setSetting('microphone', 'missing-voice-qa-device');
      await window.jarvis.dictationMode('listening');
      return message;
    })()`);
    result.micError = await until(() => Promise.race([failure, wait(90)]), 'сообщение о недоступном микрофоне');
    await js("window.jarvis.dictationMode('off')");
    result.journal = journal().filter((row) => row.tool === 'распознавание речи');
  }

  // Проверяем выбор в интерфейсе и все три выхода через ядро: образец, ответ и чтение.
  await js("document.querySelector('[data-section=speech]').click()");
  await js(`(() => {
    const select = document.querySelector('#aeSettingsView select');
    select.value = 'cloud';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(async () => (await settings()).voiceOutput === 'cloud', 'сохранение облачной озвучки');
  assert.equal((await preview()).ok, true);
  const answer = await js("window.jarvis.send('который час')");
  assert.equal(answer.ok, true);
  await until(() => speechEvents.length === 2, 'облачная озвучка ответа');
  assert.match(cloudRequests[1], /\d/u);
  await set('quiet', true);
  assert.match((await preview()).error, /тихий режим/u);
  assert.match((await read()).summary, /тихий режим/u);
  assert.equal(speechEvents.length, 2);
  await set('quiet', false);
  const resultRead = await read();
  assert.equal(resultRead.ok, true);
  const finished = await until(async () => {
    const status = await reader.run({ action: 'status' });
    return status.data.state === 'done' && status;
  }, 'чтение вслух закончилось');
  assert.equal(finished.data.total, 2);
  assert.deepEqual(cloudRequests.slice(2), ['Первый фрагмент.', 'Второй фрагмент.']);
  assert.equal(speechEvents.length, 4);
  result.cloudOutput = { preview: true, reply: cloudRequests[1], quiet: true, readAloud: finished.summary, wavFiles: speechEvents.length };
  await set('voiceOutput', 'off');
  assert.equal((await preview()).ok, false);
  assert.equal(speechEvents.length, 4);
}

main().then(() => done(0)).catch((error) => { result.error = error.stack; done(1); });
async function done(code) {
  server?.close();
  const report = live ? 'voice-live.json' : reminderCheck ? 'reminder.json' : 'voice-screens.json';
  fs.writeFileSync(path.join(out, report), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.exit(code);
}
