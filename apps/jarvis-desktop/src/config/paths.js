'use strict';

// Пути, которые отличаются в установленном приложении.
const path = require('path');

// Корень проекта: в разработке папка репозитория (две выше приложения), в установленном — папка пользователя.
// От корня считаются .env, data/ и workspace/: в установленном приложении они не должны лежать в папке программы.
function projectRoot(app, appDir) {
  return app.isPackaged ? app.getPath('userData') : path.resolve(appDir, '..', '..');
}

// Python не читает app.asar: скрипты берутся из распакованной копии рядом (asarUnpack в package.json).
function unpacked(p) {
  return String(p).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

module.exports = { projectRoot, unpacked };
