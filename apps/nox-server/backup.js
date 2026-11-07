'use strict';

// Резервная копия базы сервера: node backup.js [путь к копии]
// VACUUM INTO снимает цельный снимок вместе с WAL. Существующий файл не перезаписывается.
// Восстановление: остановить сервер, положить копию на место NOX_DB (обычно apps/nox-server/nox.db), запустить сервер.
const path = require('path');
const { Store } = require('./store');

const dbFile = process.env.NOX_DB || path.join(__dirname, 'nox.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = process.argv[2] || path.join(__dirname, `nox-backup-${stamp}.db`);

const store = new Store(dbFile);
try {
  const done = store.backupTo(target);
  console.log(`Копия готова: ${done.file} (${done.bytes} байт).`);
  console.log(`Восстановление: остановите сервер и положите копию на место ${dbFile}.`);
} finally {
  store.close();
}
