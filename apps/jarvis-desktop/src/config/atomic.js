'use strict';

// Запись файла без порчи: сначала временный файл рядом, затем переименование.
// Сбой посреди записи оставляет прежний файл целым.
const fs = require('fs');

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
