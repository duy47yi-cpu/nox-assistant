'use strict';

// Telegram-бот, подключённый к DeepSeek Harness.
//
// Что делает:
// - принимает сообщения владельца и отправляет их агенту `dsh headless` (полный доступ к ПК);
// - держит несколько независимых сессий: у каждой своя история harness и своя рабочая папка,
//   сессии работают параллельно и не мешают друг другу;
// - пока агент работает, новые сообщения встают в очередь, а не теряются;
// - если написать «перебей / поменяй / исправь / заново …», текущий ход снимается и сразу
//   выполняется новое указание;
// - показывает экран рабочего стола: короткими роликами (по умолчанию) или снимками при изменении;
// - переживает перезапуск: сессии harness сохраняются на диске, бот продолжает разговор.
//
// Токен и номер чата владельца лежат в ~/.dsh/telegram-harness/config.json.
// Чужие чаты игнорируются. Токен не попадает в журнал.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TelegramClient, sleep, chunkText } = require('./lib/telegram');
const { runTurn, DEFAULT_EXE, DEFAULT_CLI } = require('./lib/dsh');
const { ScreenStreamer, RtmpStreamer } = require('./lib/screen');
const { Store } = require('./lib/store');

const HOME_DIR = path.join(os.homedir(), '.dsh', 'telegram-harness');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const STATE_FILE = path.join(HOME_DIR, 'state.json');
const LOG_FILE = path.join(HOME_DIR, 'log.txt');
const MEDIA_DIR = path.join(HOME_DIR, 'media');

const DEFAULTS = {
  token: '',
  ownerChatId: null,
  cwd: 'D:\\nox-release',
  exe: DEFAULT_EXE,
  cli: DEFAULT_CLI,
  permissionMode: 'danger-full-access',
  approvalPolicy: 'never',
  turnTimeoutMs: 30 * 60 * 1000,
  maxParallel: 3,
  autoScreen: true,
  ffmpeg: 'ffmpeg',
  screen: { intervalMs: 1500, idleResendMs: 12000, width: 1280, quality: 6 },
  rtmp: { fps: 15, width: 1280, bitrate: '2500k' },
  slowNoticeMs: 60000,
  promptPrefix: '[Telegram] Отвечай кратко, по-русски. Ты работаешь на этом ПК с полным доступом: открывай приложения (Claude, ChatGPT/Codex, Roblox Studio), запускай codex и claude в терминале, правь файлы. ',
};

const INTERRUPT_RE = /^(?:перебей|переделай|перепиши|заново|исправь|поменяй|отмени|стоп|хватит|stop|cancel|interrupt)\b/i;

fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

function rotateLog() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // журнала ещё нет — и хорошо
  }
}
rotateLog();

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* журнал не критичен */ }
}

// Один экземпляр: два бота с одним токеном конфликтуют в getUpdates (409 Conflict).
const LOCK_FILE = path.join(HOME_DIR, 'bot.pid');
function takeLock() {
  try {
    const other = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
    if (other && other !== process.pid) {
      try {
        process.kill(other, 0); // процесс жив — второй экземпляр не нужен
        console.log(`бот уже запущен (pid ${other})`);
        process.exit(0);
      } catch {
        // процесс мёртв: забираем замок
      }
    }
  } catch {
    // замка нет
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    const pid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim());
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    // уже нет
  }
}

function loadConfig() {
  const store = new Store(CONFIG_FILE, DEFAULTS);
  return store;
}

const configStore = loadConfig();
const config = configStore.data;
const token = String(config.token || process.env.NOX_TELEGRAM_TOKEN || '').trim();
if (!token) {
  log('нет токена бота: заполните token в config.json');
  console.error(`нет токена бота: заполните token в ${CONFIG_FILE}`);
  process.exit(1);
}

const state = new Store(STATE_FILE, {
  ownerChatId: null,
  ownerName: null,
  offset: 0,
  active: 'main',
  sessions: {},
});

if (!state.get('sessions') || typeof state.get('sessions') !== 'object') state.set('sessions', {});
if (!state.get('sessions').main) {
  const sessions = state.get('sessions');
  sessions.main = { name: 'main', dshSessionId: null, cwd: config.cwd, createdAt: new Date().toISOString(), lastUsedAt: null };
  state.set('sessions', sessions);
}

const tg = new TelegramClient(token, { log });
// имя сессии -> { queue: [], handle: turn|null, pumping: bool, abortRequested: bool }
const runtime = new Map();
let activeTurns = 0;
let stopRequested = false;

function ensureRuntime(name) {
  if (!runtime.has(name)) runtime.set(name, { queue: [], handle: null, pumping: false, abortRequested: false });
  return runtime.get(name);
}

function sessionBusy(rt) {
  return Boolean(rt && (rt.handle || rt.pumping || rt.queue.length));
}

function chatId() {
  return state.get('ownerChatId');
}

async function reply(text) {
  const to = chatId();
  if (!to) return;
  try {
    await tg.sendMessage(to, String(text == null ? '' : text));
  } catch (err) {
    log(`ответ не отправлен: ${err.message}`);
  }
}

// ── Сессии ───────────────────────────────────────────────────────────────────

function sessionList() {
  return state.get('sessions') || {};
}

function sessionNames() {
  return Object.keys(sessionList());
}

function newSession(name, cwd) {
  const list = sessionList();
  if (list[name]) return { ok: false, error: `сессия «${name}» уже есть` };
  const dir = cwd || config.cwd;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: `папки нет: ${dir}` };
  } catch {
    return { ok: false, error: `папки нет: ${dir}` };
  }
  list[name] = { name, dshSessionId: null, cwd: dir, createdAt: new Date().toISOString(), lastUsedAt: null };
  state.set('sessions', list);
  state.set('active', name);
  return { ok: true, session: list[name] };
}

function setSession(name, patch) {
  const list = sessionList();
  if (!list[name]) return false;
  list[name] = { ...list[name], ...patch };
  state.set('sessions', list);
  return true;
}

function activeSession() {
  const name = state.get('active');
  const list = sessionList();
  if (!list[name]) {
    const first = sessionNames()[0] || 'main';
    state.set('active', first);
    return list[first] || null;
  }
  return list[name];
}

// ── Ход агента ───────────────────────────────────────────────────────────────

function startTyping(to) {
  if (!to) return () => {};
  let alive = true;
  const tick = () => { if (alive) tg.sendChatAction(to, 'typing').catch(() => {}); };
  tick();
  const timer = setInterval(tick, 5000);
  return () => { alive = false; clearInterval(timer); };
}

async function acquireSlot() {
  while (activeTurns >= config.maxParallel) await sleep(400);
  activeTurns += 1;
}

function releaseSlot() {
  activeTurns = Math.max(0, activeTurns - 1);
}

async function runOne(name, item) {
  const rt = ensureRuntime(name);
  await acquireSlot();
  if (rt.abortRequested) {
    rt.abortRequested = false;
    releaseSlot();
    await reply('⏹ Остановил.');
    return;
  }
  const session = sessionList()[name];
  if (!session) {
    releaseSlot();
    return;
  }

  const to = chatId();
  let slowSent = 0;
  let slowTimer = null;
  let stopTyping = () => {};
  const started = Date.now();
  let result;

  // Живой ответ: первые слова уходят в чат сразу, дальше сообщение правится на месте.
  // Так человек видит, что работа идёт, а не ждёт молчания.
  let streamId = null;
  let streamText = '';
  let streamAt = 0;
  let streamBusy = false;
  const streamFlush = async () => {
    if (!to || streamBusy) return;
    streamBusy = true;
    try {
      const body = streamText.trim();
      if (!body) return;
      if (!streamId) {
        const message = await tg.sendMessage(to, body);
        streamId = message && message.message_id;
      } else {
        await tg.editText(to, streamId, body);
      }
      streamAt = Date.now();
    } catch (err) {
      log(`поток текста: ${err.message}`);
    } finally {
      streamBusy = false;
    }
  };
  const onEvent = (event) => {
    if (!event || event.type !== 'text' || typeof event.text !== 'string') return;
    streamText += event.text;
    if (!streamId || Date.now() - streamAt >= 1200) streamFlush().catch(() => {});
  };

  try {
    stopTyping = startTyping(to);
    if (config.slowNoticeMs > 0) {
      slowTimer = setInterval(() => {
        slowSent += 1;
        if (slowSent <= 3) reply('⏳ ещё работаю…').catch(() => {});
      }, config.slowNoticeMs);
    }

    const turn = runTurn({
      prompt: `${config.promptPrefix || ''}${item.prompt}`,
      sessionId: session.dshSessionId || null,
      cwd: session.cwd || config.cwd,
      exe: config.exe,
      cli: config.cli,
      permissionMode: config.permissionMode,
      approvalPolicy: config.approvalPolicy,
      timeoutMs: config.turnTimeoutMs,
      log,
      onProgress: () => {},
      onEvent,
    });
    rt.handle = turn;
    if (rt.abortRequested) {
      rt.abortRequested = false;
      turn.abort();
    }
    result = await turn.result();
  } finally {
    rt.handle = null;
    releaseSlot();
    stopTyping();
    if (slowTimer) clearInterval(slowTimer);
  }

  if (result.sessionId && session.dshSessionId !== result.sessionId) {
    setSession(name, { dshSessionId: result.sessionId, lastUsedAt: new Date().toISOString() });
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const finalText = (result.text || '').trim();
  if (result.aborted) {
    const tail = finalText ? `⏹ Остановил.\n\nЧастичный ответ:\n${finalText}` : '⏹ Остановил.';
    if (streamId) {
      try { await tg.editText(to, streamId, tail); } catch { await reply(tail); }
    } else {
      await reply(tail);
    }
    return;
  }
  if (result.error && !finalText) {
    const message = `⚠️ Ошибка harness: ${result.error}`;
    if (streamId) {
      try { await tg.editText(to, streamId, message); } catch { await reply(message); }
    } else {
      await reply(message);
    }
    return;
  }
  if (!finalText) {
    if (streamId) {
      try { await tg.editText(to, streamId, 'Готово.'); } catch { /* не критично */ }
    } else {
      await reply('Готово.');
    }
    return;
  }
  if (streamId) {
    // Итог дописываем в то же сообщение; что не влезло — уходит новыми.
    const parts = chunkText(finalText);
    try { await tg.editText(to, streamId, parts[0]); } catch (err) { log(`поток финал: ${err.message}`); }
    for (let i = 1; i < parts.length; i += 1) await reply(parts[i]);
  } else {
    await reply(finalText);
  }
  if (seconds > 120) log(`ход ${name}: ${seconds} c`);
}

async function pump(name) {
  const rt = ensureRuntime(name);
  if (rt.handle || rt.pumping) return;
  rt.pumping = true;
  try {
    while (rt.queue.length) {
      const item = rt.queue.shift();
      try {
        await runOne(name, item);
      } catch (err) {
        log(`ход ${name} упал: ${err && err.message}`);
        await reply(`⚠️ Ход не выполнен: ${err && err.message}`);
      }
      if (stopRequested) break;
    }
  } finally {
    rt.pumping = false;
  }
}

function interrupt(name) {
  const rt = ensureRuntime(name);
  const active = Boolean(rt.handle || rt.pumping);
  if (rt.handle) {
    try { rt.handle.abort(); } catch (err) { log(`прерывание: ${err.message}`); }
  }
  rt.abortRequested = active;
  rt.queue = [];
  if (active) log(`сессия ${name} прервана`);
  return active;
}

function enqueue(name, prompt, { front = false } = {}) {
  const rt = ensureRuntime(name);
  const item = { prompt, at: Date.now() };
  if (front) rt.queue.unshift(item);
  else rt.queue.push(item);
  const wasBusy = sessionBusy(rt);
  if (!rt.pumping) pump(name).catch((err) => log(`pump ${name}: ${err.message}`));
  return { busy: wasBusy, queued: rt.queue.length };
}

// ── Экран ────────────────────────────────────────────────────────────────────

// Живая картинка экрана: одно сообщение, которое обновляется на месте.
// Так нет потока новых видео в чате — кадр меняется в том же сообщении.
let liveMessageId = null;
let liveEdits = 0;

const screen = new ScreenStreamer({
  ffmpeg: config.ffmpeg,
  tmpDir: path.join(MEDIA_DIR, 'screen'),
  log,
  // Пока идёт ход агента, кадры не снимаем: иначе ffmpeg отнимает CPU у ответа.
  isBusy: () => activeTurns > 0,
  onLive: async (buf) => {
    const to = chatId();
    if (!to) return;
    try {
      if (liveMessageId) {
        await tg.editFrame(to, liveMessageId, buf);
        liveEdits += 1;
        if (liveEdits === 1 || liveEdits % 40 === 0) log(`экран: живая картинка обновляется (правок ${liveEdits})`);
      } else {
        liveMessageId = await tg.sendFrame(to, buf, { caption: '📺 экран' });
        liveEdits = 0;
        log(`экран: живая картинка в сообщении ${liveMessageId}`);
      }
    } catch (err) {
      // Сообщение удалили, оно устарело или правка не прошла — начнём новое.
      log(`экран: ${err.message}`);
      liveMessageId = null;
    }
  },
});

function screenStatus() {
  if (!screen.running) return 'выключен';
  return `включён (кадр раз в ${Math.round(screen.intervalMs / 100) / 10} c, одно сообщение)`;
}

async function startScreen() {
  try {
    screen.start(config.screen);
    liveMessageId = null;
    log(`экран включён: живая картинка`);
    return '📺 Экран показываю живой картинкой: одно сообщение обновляется само. Выключить — /screen off';
  } catch (err) {
    return `Экран не включился: ${err.message}`;
  }
}

function stopScreen() {
  screen.stop();
  liveMessageId = null;
  log('экран выключен');
}

// Настоящая трансляция в Telegram-эфир: адрес RTMP владелец берёт в Telegram
// (видеочат → «Начать трансляцию» → «Трансляция с помощью…»). Сюда уходит экран.
const rtmp = new RtmpStreamer({ ffmpeg: config.ffmpeg, log });

// ── Команды ──────────────────────────────────────────────────────────────────

const HELP = [
  'Напишите задачу — выполню на этом ПК через DeepSeek Harness.',
  '',
  'Сессии:',
  '/new имя [папка] — новая независимая сессия',
  '/use имя — переключиться',
  '/sessions — список и что сейчас работает',
  '/stop — прервать текущий ход',
  '/kill имя — прервать ход в сессии',
  '/cwd путь — рабочая папка активной сессии',
  '',
  'Экран:',
  '/screen on | off — живая картинка экрана (одно сообщение обновляется на месте)',
  '/shot — один снимок экрана',
  '/stream <rtmp-адрес> | off — настоящая трансляция в Telegram-эфир',
  '',
  'Перебивание: если написать «перебей …», «поменяй …», «исправь …», «заново …»,',
  'текущий ход снимается и сразу выполняется новое указание.',
].join('\n');

async function handleCommand(text) {
  const raw = text.replace(/@\w+/, '').trim();
  const [head, ...rest] = raw.split(/\s+/);
  const cmd = head.toLowerCase();
  const arg = rest.join(' ').trim();

  if (cmd === '/start' || cmd === '/help') { await reply(HELP); return true; }
  if (cmd === '/stop' || cmd === '/cancel') {
    const s = activeSession();
    if (!s) { await reply('Нет активной сессии.'); return true; }
    const was = interrupt(s.name);
    await reply(was ? `⏹ Прервал сессию «${s.name}».` : 'Сейчас ничего не выполняется.');
    return true;
  }
  if (cmd === '/new' || cmd === '/n') {
    const [name, dir] = [rest[0], rest.slice(1).join(' ')];
    if (!name) { await reply('Напишите: /new имя [папка]'); return true; }
    const made = newSession(name, dir || null);
    await reply(made.ok ? `✅ Сессия «${name}» создана (папка ${made.session.cwd}). Теперь пишите в неё.` : `Не вышло: ${made.error}`);
    return true;
  }
  if (cmd === '/use' || cmd === '/u') {
    if (!arg) { await reply('Напишите: /use имя'); return true; }
    if (!sessionList()[arg]) { await reply(`Нет сессии «${arg}». /sessions — список.`); return true; }
    state.set('active', arg);
    await reply(`→ Активная сессия: «${arg}»`);
    return true;
  }
  if (cmd === '/sessions' || cmd === '/list') {
    const list = sessionList();
    const active = state.get('active');
    const lines = Object.keys(list).map((name) => {
      const s = list[name];
      const rt = ensureRuntime(name);
      const stateWord = rt.handle ? '⏳ работает' : rt.pumping ? '⏳ запускается' : rt.queue.length ? `очередь ${rt.queue.length}` : 'свободна';
      const mark = name === active ? '*' : ' ';
      return `${mark} ${name} — ${stateWord}\n   ${s.cwd}${s.dshSessionId ? `\n   harness: ${s.dshSessionId}` : ''}`;
    });
    await reply(`Сессии (* активная):\n${lines.join('\n')}`);
    return true;
  }
  if (cmd === '/cwd') {
    const s = activeSession();
    if (!s) { await reply('Нет активной сессии.'); return true; }
    if (!arg) { await reply(`Рабочая папка «${s.name}»: ${s.cwd}`); return true; }
    try {
      if (!fs.existsSync(arg) || !fs.statSync(arg).isDirectory()) throw new Error('папки нет');
      setSession(s.name, { cwd: path.resolve(arg) });
      await reply(`📁 «${s.name}» теперь работает в ${path.resolve(arg)}`);
    } catch (err) {
      await reply(`Не сменил: ${err.message}`);
    }
    return true;
  }
  if (cmd === '/kill') {
    if (!arg) { await reply('Напишите: /kill имя'); return true; }
    if (!sessionList()[arg]) { await reply(`Нет сессии «${arg}».`); return true; }
    const was = interrupt(arg);
    await reply(was ? `⏹ Прервал «${arg}».` : `«${arg}» сейчас свободна.`);
    return true;
  }
  if (cmd === '/screen') {
    const what = (rest[0] || 'on').toLowerCase();
    if (what === 'off' || what === 'stop') {
      stopScreen();
      await reply('📺 Экран выключил.');
      return true;
    }
    if (what === 'on' || what === 'live' || what === 'photo' || what === 'video') {
      await reply(await startScreen());
      return true;
    }
    await reply(`Показ экрана: ${screenStatus()}\n/screen on | off`);
    return true;
  }
  if (cmd === '/stream' || cmd === '/rtmp') {
    const url = rest[0] || '';
    if (!url || url === 'off' || url === 'stop') {
      rtmp.stop();
      await reply('🛰 Трансляцию выключил.');
      return true;
    }
    try {
      rtmp.start(url, config.rtmp);
      log('трансляция включена');
      await reply('🛰 Трансляция включена: экран уходит в Telegram-эфир. Выключить — /stream off');
    } catch (err) {
      await reply(`Не получилось: ${err.message}`);
    }
    return true;
  }
  if (cmd === '/shot' || cmd === '/screen_shot') {    try {
      const buf = await screen.shot();
      await tg.sendPhoto(chatId(), buf, { fileName: 'shot.png', caption: new Date().toLocaleString('ru-RU') });
    } catch (err) {
      await reply(`Снимок не вышел: ${err.message}`);
    }
    return true;
  }
  await reply(`Не знаю команду ${cmd}. /help`);
  return true;
}

// ── Входящие сообщения ───────────────────────────────────────────────────────

const boundNote = () => (chatId() ? '' : '');
void boundNote;

async function onMessage(msg) {
  if (!msg || !msg.chat) return;
  const fromId = String(msg.chat.id);
  const kind = msg.chat.type;
  const owner = chatId();

  if (!owner) {
    if (kind !== 'private') {
      log(`чужой чат ${fromId} (${kind}) проигнорирован: владелец ещё не привязан`);
      return;
    }
    state.set('ownerChatId', fromId);
    state.set('ownerName', [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ') || '');
    log(`владелец привязан: ${fromId}`);
    await reply('🔗 Чат привязан к боту. Пишите задачу — выполняю на ПК через DeepSeek Harness.\n/help — что умею.');
    if (config.autoScreen) await startScreen();
    return;
  }

  if (fromId !== String(owner)) {
    log(`чужой чат ${fromId} проигнорирован`);
    return;
  }

  const text = typeof msg.text === 'string' ? msg.text.trim()
    : typeof msg.caption === 'string' ? msg.caption.trim() : '';
  const hasMedia = Boolean(msg.photo || msg.document || msg.voice || msg.video || msg.audio);
  if (!text && !hasMedia) return;

  if (text.startsWith('/')) {
    await handleCommand(text);
    return;
  }

  if (hasMedia && !text) {
    await reply('Пока принимаю только текст: файлы и голосовые не подключены. Опишите задачу словами.');
    return;
  }

  const session = activeSession();
  if (!session) { await reply('Нет активной сессии. /new имя'); return; }

  const rt = ensureRuntime(session.name);
  const busy = sessionBusy(rt);

  if (busy && INTERRUPT_RE.test(text)) {
    interrupt(session.name);
    enqueue(session.name, text, { front: true });
    await reply(`⏹ Перебил и делаю новое указание (сессия «${session.name}»).`);
    return;
  }

  const info = enqueue(session.name, text);
  if (info.busy || info.queued > 1) {
    await reply(`⏳ Принял, в очереди (${info.queued}). Закончу текущее — возьмусь.`);
  }
}

// ── Цикл опроса ──────────────────────────────────────────────────────────────

async function pollLoop() {
  let failures = 0;
  while (!stopRequested) {
    const offset = Number(state.get('offset') || 0);
    let updates;
    try {
      updates = await tg.getUpdates(offset, 25, AbortSignal.timeout(45000));
      failures = 0;
    } catch (err) {
      if (stopRequested) break;
      failures += 1;
      const wait = Math.min(2000 * failures, 15000);
      log(`опрос не удался (${failures}): ${err.message}; пауза ${wait} мс`);
      await sleep(wait);
      continue;
    }
    if (!Array.isArray(updates)) continue;
    for (const update of updates) {
      const next = Math.max(offset, Number(update.update_id) + 1);
      state.set('offset', next);
      const msg = update.message || update.edited_message;
      try {
        await onMessage(msg);
      } catch (err) {
        log(`сообщение не обработано: ${err && err.message}`);
        await reply(`⚠️ ${err && err.message}`);
      }
    }
    // Пауза между длинными опросами: без неё Telegram иногда отвечает 409 Conflict
    // (предыдущий опрос ещё не закрыт на его стороне).
    await sleep(400);
  }
}

async function main() {
  // Скрытая самопроверка: один ход агента с отправкой ответа владельцу, без опроса Telegram.
  if (process.argv[2] === '--selftest') {
    const prompt = process.argv.slice(3).join(' ') || 'Ответь одним словом: работает';
    log('самопроверка: ход агента');
    await runOne('main', { prompt });
    log('самопроверка: готово');
    return;
  }

  takeLock();
  log('бот запущен');
  try {
    await tg.call('setMyCommands', {
      commands: [
        { command: 'help', description: 'что умею' },
        { command: 'new', description: 'новая сессия' },
        { command: 'sessions', description: 'сессии и статус' },
        { command: 'use', description: 'переключить сессию' },
        { command: 'stop', description: 'прервать текущий ход' },
        { command: 'screen', description: 'показ экрана' },
        { command: 'shot', description: 'снимок экрана' },
      ],
    });
  } catch (err) {
    log(`меню команд не установлено: ${err.message}`);
  }

  const owner = chatId();
  if (owner && config.autoScreen) {
    try { await startScreen(); } catch (err) { log(`автопоказ экрана: ${err.message}`); }
  } else if (owner) {
    log('автопоказ экрана выключен в настройках');
  }

  await pollLoop();
}

function shutdown(signal) {
  stopRequested = true;
  log(`остановка по ${signal}`);
  screen.stop();
  rtmp.stop({ silent: true });
  for (const [name, rt] of runtime) {
    if (rt.handle) { try { rt.handle.abort(); } catch { /* уже остановлен */ } log(`сессия ${name}: ход снят при остановке`); }
  }
  releaseLock();
  setTimeout(() => process.exit(0), 1200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => log(`необработанная ошибка: ${err && err.stack}`));
process.on('unhandledRejection', (err) => log(`необработанный отказ: ${err && (err.stack || err)}`));

main().catch((err) => {
  log(`бот упал: ${err && err.stack}`);
  console.error(err);
  process.exit(1);
});
