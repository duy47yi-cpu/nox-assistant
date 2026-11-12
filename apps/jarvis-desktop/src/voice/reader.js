'use strict';

// Чтение вслух длинного текста с управлением: пауза, продолжение с того же места, остановка.
//
// Точной паузы у голоса нет: звук синтезируется в wav и играет до конца куска. Поэтому текст режется
// на предложения (не длиннее FRAGMENT_MAX), а местом остановки считается номер текущего куска.
// Пауза обрывает звук сразу и запоминает кусок; продолжение начинает этот же кусок с начала —
// прочитанные предложения не повторяются, оставшиеся не пропускаются. Если пауза пришлась
// на середину куска, он звучит заново целиком: это честная цена паузы без точной остановки в wav.
//
// Сеанс идёт в фоне: start() сразу отдаёт состояние, а чтение продолжается само.
// Его можно остановить (stop), поставить на паузу (pause) и продолжить (resume) откуда угодно.
const MAX_READ = 12000; // сколько символов вообще берём в чтение (дальше честно говорим «дальше не читаю»)
const FRAGMENT_MAX = 300; // длиннее куска не бывает: пауза стоит не больше одного куска

const IDLE = 'idle';
const PLAYING = 'playing';
const PAUSED = 'paused';
const STOPPED = 'stopped';
const DONE = 'done';
const ERROR = 'error';

// Пробелы, переводы строк и табуляции — к одному пробелу: голос читает одну ровную строку.
function normalizeReading(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

// Обрезка до предела — по границе предложения, если она не слишком далеко от предела.
function cutToLimit(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const head = text.slice(0, limit);
  let cut = -1;
  for (const mark of ['. ', '! ', '? ', '… ', '; ']) {
    const at = head.lastIndexOf(mark);
    if (at > cut) cut = at;
  }
  if (cut < limit * 0.6) {
    const space = head.lastIndexOf(' ');
    cut = space > 0 ? space : limit - 1;
  }
  return { text: head.slice(0, cut + 1).trim(), truncated: true };
}

// Предложения по концам фраз. Кавычки и скобки после точки остаются в предложении.
function splitSentences(text) {
  return text
    .split(/(?<=[.!?…])["»”’)\]]*\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

// Предложение длиннее куска режем по запятой, двоеточию, тире или пробелу.
function splitLongSentence(sentence, max) {
  const out = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const mark of [', ', '; ', ': ', ' — ', ' - ']) {
      const at = window.lastIndexOf(mark);
      if (at > cut) cut = at;
    }
    if (cut < max * 0.5) {
      const space = window.lastIndexOf(' ');
      cut = space > 0 ? space : max - 1;
    }
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

// Куски для чтения: одно предложение — один кусок. Так пауза повторяет не больше одного
// предложения, а прочитанные не повторяются вовсе. Длинное предложение режется по запятым.
// Склеенные через пробел куски дают ровно тот текст, который читаем (это проверяют тесты).
function splitForReading(text, { limit = MAX_READ, max = FRAGMENT_MAX } = {}) {
  const clean = normalizeReading(text);
  if (!clean) return { parts: [], chars: 0, truncated: false };
  const cut = cutToLimit(clean, limit);
  const parts = splitSentences(cut.text).flatMap((sentence) => (
    sentence.length > max ? splitLongSentence(sentence, max) : [sentence]
  ));
  return { parts, chars: clean.length, truncated: cut.truncated };
}

// Сеанс чтения. speak(текст, signal) — голос; onState(снимок) — сообщить окну о смене состояния.
function createReader({ speak, onState = () => {}, limits = {} } = {}) {
  if (typeof speak !== 'function') throw new Error('нужна функция голоса');
  let session = null;

  function emit() {
    try {
      onState(snapshot());
    } catch {
      // окно могло закрыться; чтение из-за этого не останавливаем
    }
  }

  function snapshot() {
    if (!session) {
      return { state: IDLE, index: 0, total: 0, label: null, error: null, truncated: false, chars: 0 };
    }
    const { state, index, parts, label, error, truncated, chars } = session;
    return {
      state,
      index: state === DONE ? parts.length : index,
      total: parts.length,
      label: label || null,
      error: error || null,
      truncated: Boolean(truncated),
      chars: chars || 0,
    };
  }

  // Один кусок: голос с собственным сигналом, чтобы пауза и стоп обрывали звук сразу.
  async function speakPart(s, controller) {
    await speak(s.parts[s.index], controller.signal);
  }

  async function run(s) {
    while (!s.stopped && s.index < s.parts.length) {
      if (s.paused) {
        await s.wake;
        continue;
      }
      const controller = new AbortController();
      s.controller = controller;
      try {
        await speakPart(s, controller);
        if (s.stopped || s.paused) continue; // кусок остаётся текущим: продолжим его же
        s.index += 1;
        s.failures = 0;
      } catch (err) {
        if (s.stopped || s.paused || controller.signal.aborted) continue;
        s.failures += 1;
        if (s.failures > 1) {
          // Дважды не получилось — не делаем вид, что прочитали: честно говорим, где встали.
          s.state = ERROR;
          s.error = err.message || 'голос не ответил';
          emit();
          return;
        }
        // одна повторная попытка на том же куске
      }
    }
    if (s.stopped) {
      s.state = STOPPED;
    } else if (!s.paused) {
      s.state = DONE;
      s.index = s.parts.length;
    }
    emit();
  }

  function start(text, { label = null } = {}) {
    if (session && (session.state === PLAYING || session.state === PAUSED)) stop();
    const { parts, chars, truncated } = splitForReading(text, limits);
    if (!parts.length) {
      session = { state: IDLE, index: 0, parts: [], label, error: null, truncated: false, chars: 0, stopped: true, paused: false, failures: 0, wake: Promise.resolve() };
      return snapshot();
    }
    const s = {
      state: PLAYING,
      index: 0,
      parts,
      label,
      error: null,
      truncated,
      chars,
      stopped: false,
      paused: false,
      failures: 0,
      controller: null,
      wake: Promise.resolve(),
      wakeUp: null,
    };
    session = s;
    emit();
    s.finished = run(s).catch((err) => {
      s.state = ERROR;
      s.error = err.message;
      emit();
    });
    return snapshot();
  }

  function pause() {
    const s = session;
    if (!s || s.state !== PLAYING) return snapshot();
    s.paused = true;
    s.state = PAUSED;
    s.wake = new Promise((resolve) => { s.wakeUp = resolve; });
    if (s.controller) s.controller.abort(); // звук обрывается сейчас же
    emit();
    return snapshot();
  }

  function resume() {
    const s = session;
    if (!s || s.state !== PAUSED) return snapshot();
    s.paused = false;
    s.state = PLAYING;
    const wake = s.wakeUp;
    s.wakeUp = null;
    if (wake) wake();
    emit();
    return snapshot();
  }

  function stop() {
    const s = session;
    if (!s || [STOPPED, DONE, IDLE].includes(s.state)) return snapshot();
    s.stopped = true;
    s.state = STOPPED;
    if (s.controller) s.controller.abort();
    const wake = s.wakeUp;
    s.wakeUp = null;
    if (wake) wake();
    emit();
    return snapshot();
  }

  return {
    start,
    pause,
    resume,
    stop,
    snapshot,
    // Обещание текущего сеанса: нужно проверкам, чтобы дождаться конца чтения.
    finished() {
      return (session && session.finished) || Promise.resolve();
    },
    get busy() {
      return Boolean(session && (session.state === PLAYING || session.state === PAUSED));
    },
  };
}

module.exports = {
  createReader,
  splitForReading,
  normalizeReading,
  MAX_READ,
  FRAGMENT_MAX,
  IDLE,
  PLAYING,
  PAUSED,
  STOPPED,
  DONE,
  ERROR,
};
