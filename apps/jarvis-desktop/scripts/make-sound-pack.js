'use strict';

// Генерация встроенного звукового пака для проверки: пишет WAV в <данные>/sound-packs/nox.
// Данные берутся из NOX_DATA_DIR, иначе из data/ в корне проекта. Печатает пути и размеры.
const fs = require('fs');
const path = require('path');
const { ensureBuiltinPack, DEFAULT_PACK_ID, STATE_TITLES } = require('../src/voice/packs');

const APP_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(APP_DIR, '..', '..');
const DATA_DIR = process.env.NOX_DATA_DIR ? path.resolve(process.env.NOX_DATA_DIR) : path.join(ROOT, 'data');
const PACK_DIR = path.join(DATA_DIR, 'sound-packs', DEFAULT_PACK_ID);

const result = ensureBuiltinPack(PACK_DIR);
console.log(`Звуковой пак «${DEFAULT_PACK_ID}»: ${result.dir}`);
for (const state of Object.keys(result.sounds)) {
  const file = result.sounds[state];
  const size = fs.statSync(file).size;
  console.log(`  ${state} (${STATE_TITLES[state] || state}): ${file} — ${size} Б`);
}
console.log(result.created.length > 0
  ? `Создано файлов: ${result.created.length}`
  : 'Все файлы уже были на месте, ничего не перезаписано.');
