'use strict';

// Проверка связей приложения: require в main.js, имена экспортов, каналы IPC preload → main, пути к данным.
// Работает по тексту файлов, без запуска Electron.
const fs = require('fs');
const path = require('path');

function resolveRequire(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Имена из module.exports = { a, b, c: value }. Если экспорт не объект, возвращает null.
function exportedNames(source) {
  const m = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\};?/);
  if (!m) return null;
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return body.split(',').map((part) => part.split(':')[0].trim()).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

// Все локальные require и то, что из них деструктурируется.
function localRequires(source) {
  const out = [];
  const re = /const\s*\{([^}]*)\}\s*=\s*require\(\s*'(\.[^']*)'\s*\)/g;
  let m;
  while ((m = re.exec(source))) {
    const names = m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
    out.push({ spec: m[2], names });
  }
  // Bare require без деструктуризации: деструктурированные уже учтены, их убираем из текста.
  const rest = source.replace(/const\s*\{[^}]*\}\s*=\s*require\(\s*'\.[^']*'\s*\)/g, '');
  const bare = /require\(\s*'(\.[^']*)'\s*\)/g;
  while ((m = bare.exec(rest))) out.push({ spec: m[1], names: [] });
  return out;
}

function checkRequires(file) {
  const problems = [];
  const source = fs.readFileSync(file, 'utf8');
  const seen = new Set();
  for (const { spec, names } of localRequires(source)) {
    const target = resolveRequire(file, spec);
    if (!target) {
      problems.push(`${path.basename(file)}: require('${spec}') — файла нет`);
      continue;
    }
    if (!names.length) continue;
    const exported = exportedNames(fs.readFileSync(target, 'utf8'));
    if (!exported) {
      // Экспорт не объектом: имена не проверяем, но и не выдаём за проверенные.
      continue;
    }
    for (const name of names) {
      if (!exported.includes(name) && !seen.has(`${spec}:${name}`)) {
        seen.add(`${spec}:${name}`);
        problems.push(`${path.basename(file)}: из '${spec}' берётся «${name}», которого нет в module.exports`);
      }
    }
  }
  return problems;
}

function ipcChannels(source, pattern) {
  const out = new Set();
  let m;
  while ((m = pattern.exec(source))) out.add(m[1]);
  return out;
}

// Каналы, которые preload вызывает через invoke, должны иметь обработчик в main.js.
function checkIpc(appDir) {
  const preload = fs.readFileSync(path.join(appDir, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  const invoked = ipcChannels(preload, /ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g);
  const handled = new Set([
    ...ipcChannels(main, /ipcMain\.handle\(\s*'([^']+)'/g),
    ...ipcChannels(main, /ipcMain\.on\(\s*'([^']+)'/g),
  ]);
  const problems = [];
  for (const ch of invoked) {
    if (!handled.has(ch)) problems.push(`preload.js: канал «${ch}» вызывается, но в main.js нет обработчика`);
  }
  return problems;
}

// Методы моста, которыми пользуется renderer/connections.js, должны быть в preload.js,
// а id элементов и разделы — в index.html. Иначе экран «Подключения» молча не оживёт.
function checkRendererBridge(appDir) {
  const problems = [];
  const rendererFile = path.join(appDir, 'renderer', 'connections.js');
  const preloadFile = path.join(appDir, 'preload.js');
  const htmlFile = path.join(appDir, 'renderer', 'index.html');
  if (!fs.existsSync(rendererFile) || !fs.existsSync(preloadFile) || !fs.existsSync(htmlFile)) return problems;

  const source = fs.readFileSync(rendererFile, 'utf8');
  const preload = fs.readFileSync(preloadFile, 'utf8');
  const exposed = new Set([...preload.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1]));
  const used = new Set([...source.matchAll(/(?:window\.jarvis|api)\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
  for (const name of used) {
    if (!exposed.has(name)) problems.push(`renderer/connections.js: мост окна не даёт метод «${name}»`);
  }

  const html = fs.readFileSync(htmlFile, 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, id] of source.matchAll(/getElementById\('([^']+)'\)/g)) {
    if (!ids.has(id)) problems.push(`renderer/connections.js: элемента «${id}» нет в renderer/index.html`);
  }
  const views = new Set([...html.matchAll(/\bdata-view="([^"]+)"/g)].map((match) => match[1]));
  for (const [, view] of source.matchAll(/\[data-view="([^"]+)"\]/g)) {
    if (!views.has(view)) problems.push(`renderer/connections.js: раздела «${view}» нет в renderer/index.html`);
  }
  return problems;
}

// Пути к данным, которые main.js строит, должны существовать. Библиотека лежит внутри приложения.
function checkDataPaths(appDir) {
  const main = fs.readFileSync(path.join(appDir, 'main.js'), 'utf8');
  const problems = [];
  if (/LIBRARY_DIR\s*=\s*path\.join\(__dirname,\s*'scripts',\s*'commands'\)/.test(main)) {
    const dir = path.join(appDir, 'scripts', 'commands');
    if (!fs.existsSync(dir)) problems.push(`main.js: LIBRARY_DIR указывает на несуществующую папку ${dir}`);
    else if (!fs.readdirSync(dir).some((f) => /^manifest-.*\.json$/.test(f))) {
      problems.push(`main.js: в ${dir} нет ни одного manifest-*.json`);
    }
  } else {
    problems.push('main.js: не найдено объявление LIBRARY_DIR в ожидаемом виде — проверка путей не выполнена');
  }
  return problems;
}

function checkConnections({ appDir }) {
  const problems = [];
  for (const file of ['main.js', 'preload.js']) {
    const full = path.join(appDir, file);
    if (!fs.existsSync(full)) {
      problems.push(`${file}: файла нет`);
      continue;
    }
    problems.push(...checkRequires(full));
  }
  problems.push(...checkIpc(appDir));
  problems.push(...checkRendererBridge(appDir));
  problems.push(...checkDataPaths(appDir));
  return problems;
}

module.exports = { checkConnections, checkRendererBridge, exportedNames, localRequires };
