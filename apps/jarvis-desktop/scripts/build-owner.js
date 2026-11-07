'use strict';

// Сборка владельца: вшивает build-info.json с OWNER_BUILD: true и собирает установщик (npm run dist).
// После сборки файл удаляется: обычная (покупательская) сборка и запуск из папки идут без него.
// --keep — оставить файл, чтобы и `npm start` из этой папки работал как сборка владельца.
const fs = require('fs');
const { spawnSync } = require('child_process');
const { BUILD_INFO } = require('../src/config/build');

const keep = process.argv.includes('--keep');
fs.writeFileSync(BUILD_INFO, JSON.stringify({ OWNER_BUILD: true, builtAt: new Date().toISOString() }, null, 2));
let code = 0;
try {
  if (!process.argv.includes('--no-build')) {
    code = spawnSync('npm', ['run', 'dist'], { cwd: require('path').dirname(BUILD_INFO), stdio: 'inherit', shell: true }).status ?? 1;
  }
} finally {
  if (!keep) fs.rmSync(BUILD_INFO, { force: true });
}
process.exit(code);
