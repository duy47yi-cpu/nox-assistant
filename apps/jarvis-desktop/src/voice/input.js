'use strict';

const { extractWake, parseWakeWords } = require('./wake');

const SETTINGS = {
  sttEngine: ['auto', 'local', 'cloud'],
  sttLanguage: ['ru', 'en', 'auto'],
};
const DEFAULT_WAKE_WORDS = ['джарвис', 'жарвис', 'сэр'];

function voiceInputSettings(settings) {
  return {
    ...Object.fromEntries(Object.entries(SETTINGS).map(([key, choices]) =>
      [key, choices.includes(settings[key]) ? settings[key] : choices[0]])),
    sttCloudAllowed: settings.sttCloudAllowed === true,
    sttModelFolder: typeof settings.sttModelFolder === 'string' ? settings.sttModelFolder : '',
    microphone: typeof settings.microphone === 'string' ? settings.microphone : '',
    commandOverlay: settings.commandOverlay !== false,
    voiceYes: settings.voiceYes ?? 'да, правильно, подтверждаю',
    voiceNo: settings.voiceNo ?? 'нет, отмена, отменить',
    voiceLinkWords: settings.voiceLinkWords ?? 'и, затем, потом, после этого',
  };
}

function voicePhrase(text, { words = DEFAULT_WAKE_WORDS, prefixMode = false, mode = 'listening' } = {}) {
  const variants = parseWakeWords(words);
  // Russian speech can voice the final consonant before the next word.
  const options = { words: variants.includes('джарвис') ? [...variants, 'джарвиз'] : variants };
  const wake = extractWake(text, options);
  if (!wake || mode === 'off') return null;
  if (wake.woke) return { command: wake.command, addressed: true };
  if ((prefixMode || mode === 'quiet') && options.words.length) return null;
  return { command: text.trim(), addressed: false };
}

// PCM frames are 20 ms at 16 kHz. Keep a little pre-roll and cut after 600 ms of silence.
function createVad({ onStart, onPhrase }) {
  const frameBytes = 640;
  let carry = Buffer.alloc(0);
  let frames = [];
  let voiced = 0;
  let silent = 0;
  let active = false;
  let noise = 0.002;
  return (chunk) => {
    const pcm = Buffer.concat([carry, chunk]);
    let offset = 0;
    for (; offset + frameBytes <= pcm.length; offset += frameBytes) {
      const frame = pcm.subarray(offset, offset + frameBytes);
      let power = 0;
      for (let index = 0; index < frame.length; index += 2) power += (frame.readInt16LE(index) / 32768) ** 2;
      const rms = Math.sqrt(power / 320);
      const speech = rms > Math.max(0.006, noise * 3);
      frames.push(frame);
      if (!active) {
        if (frames.length > 10) frames.shift();
        if (!speech) noise = 0.96 * noise + 0.04 * rms;
        voiced = speech ? voiced + 1 : 0;
        if (voiced < 3) continue;
        active = true;
        onStart();
      } else {
        if (speech) voiced++;
        silent = speech ? 0 : silent + 1;
      }
      if (silent < 30 && frames.length < 750) continue;
      if (voiced >= 5) onPhrase(Buffer.concat(frames.slice(0, frames.length - Math.max(0, silent - 5))));
      frames = [];
      active = false;
      voiced = 0;
      silent = 0;
    }
    carry = pcm.subarray(offset);
  };
}

module.exports = { createVad, voicePhrase, voiceInputSettings, SETTINGS, DEFAULT_WAKE_WORDS };
