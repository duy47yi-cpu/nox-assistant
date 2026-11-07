'use strict';

// Песочница: единственная папка, в которую инструменты Джарвиса читают и пишут.
// Расположение внутри корня проекта не даёт доступа ко всему проекту: доступна только эта подпапка.
const path = require('path');

const SANDBOX_DIR = 'workspace';

function sandboxRoot(projectRoot) {
  return path.join(String(projectRoot), SANDBOX_DIR);
}

module.exports = { sandboxRoot, SANDBOX_DIR };
