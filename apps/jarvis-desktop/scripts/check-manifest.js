'use strict';

// Проверка библиотеки и связей приложения: npm run check-manifest.
// Код выхода 1, если есть проблемы. Запускается без Electron и без сети.
const path = require('path');
const { checkLibrary } = require('../src/library/validator');
const { checkConnections } = require('../src/validate/connections');

const appDir = path.resolve(__dirname, '..');
const commandsDir = path.resolve(appDir, 'scripts', 'commands');

const lib = checkLibrary({ commandsDir });
const conn = checkConnections({ appDir });
const problems = [...lib.problems, ...conn];

console.log(`манифестов записей: ${lib.info.entries}; включено: ${lib.info.enabled}; выключено: ${lib.info.disabled}; проверено живьём: ${lib.info.verified}; не проверено и не загружается: ${lib.info.unverified}`);
if (lib.info.orphans.length) console.log(`не подключённые скрипты: ${lib.info.orphans.join(', ')}`);
if (problems.length) {
  console.log(`проблем: ${problems.length}`);
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log('проблем нет');
