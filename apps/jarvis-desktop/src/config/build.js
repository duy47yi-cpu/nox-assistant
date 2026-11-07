'use strict';

// Сборка владельца. Флаг вшивается при сборке: scripts/build-owner.js кладёт build-info.json рядом с приложением.
// Переменные окружения и настройки сюда не смотрят: покупатель не включит это переключателем.
// Нет файла или он битый — обычная сборка.
const fs = require('fs');
const path = require('path');

const BUILD_INFO = path.join(__dirname, '..', '..', 'build-info.json');

function readOwnerBuild(file = BUILD_INFO) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).OWNER_BUILD === true;
  } catch {
    return false;
  }
}

module.exports = { OWNER_BUILD: readOwnerBuild(), readOwnerBuild, BUILD_INFO };
