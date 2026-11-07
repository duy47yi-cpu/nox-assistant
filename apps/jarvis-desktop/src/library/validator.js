'use strict';

// Проверка библиотеки команд: манифесты, описания в скриптах, доступ к файлам.
// Возвращает список проблем. Пустой список — библиотека согласована с политикой access.js.
const fs = require('fs');
const path = require('path');
const { validate, MAX_MANIFEST_BYTES } = require('./index');
const {
  VERIFIED_SANDBOX, VERIFIED_READONLY, ENABLED, DISABLED, touchesFiles, absolutePaths, SANDBOX_ENV,
} = require('./access');

// Скрипты без записи в манифесте. Известны и не считаются новой проблемой. Новые — ошибка.
const KNOWN_ORPHANS = ['apps/open_github.py'];

// Признаки доступа к домашним папкам. Для проверенных скриптов запрещены.
const OUTSIDE_MARKERS = /expanduser|USERPROFILE|OneDrive|Documents|Downloads|Desktop|Рабочий|Загрузки|Документы/;

// Описание из argparse: Parser(description='...') или "...".
function pythonDescription(source) {
  const m = source.match(/description=(?:'([^'\n]*)'|"([^"\n]*)")/);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function readManifests(commandsDir) {
  const files = fs.readdirSync(commandsDir).filter((f) => /^manifest-.*\.json$/.test(f));
  const entries = [];
  const problems = [];
  for (const file of files) {
    let list;
    try {
      const filePath = path.join(commandsDir, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        problems.push(`${file}: манифест должен быть файлом`);
        continue;
      }
      if (stat.size > MAX_MANIFEST_BYTES) {
        problems.push(`${file}: манифест больше ${Math.round(MAX_MANIFEST_BYTES / 1024)} КБ`);
        continue;
      }
      list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      problems.push(`${file}: не читается как JSON (${err.message})`);
      continue;
    }
    if (!Array.isArray(list)) {
      problems.push(`${file}: корень должен быть массивом`);
      continue;
    }
    for (const raw of list) entries.push({ raw, file });
  }
  return { entries, problems };
}

function listScripts(commandsDir) {
  const out = [];
  for (const dir of fs.readdirSync(commandsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(commandsDir, dir.name))) {
      if (f.endsWith('.py')) out.push(`${dir.name}/${f}`);
    }
  }
  return out;
}

// policy: сверять ли библиотеку с реестром access.js (ENABLED, DISABLED и известные сироты).
// Для произвольных каталогов в тестах policy = false.
function checkLibrary({ commandsDir, policy = true }) {
  const problems = [];
  const info = { entries: 0, enabled: 0, disabled: 0, unverified: 0, verified: 0, orphans: [] };
  if (!fs.existsSync(commandsDir)) return { problems: [`папка библиотеки не найдена: ${commandsDir}`], info };

  const { entries, problems: manifestProblems } = readManifests(commandsDir);
  problems.push(...manifestProblems);
  info.entries = entries.length;

  const ids = new Map();
  const referenced = new Set();
  for (const { raw, file } of entries) {
    const entry = validate(raw, commandsDir);
    const id = raw && raw.id;
    if (!entry) {
      problems.push(`${file}: запись «${id}» не проходит проверку (id, title, risk или путь к скрипту)`);
      continue;
    }
    if (ids.has(entry.id)) {
      problems.push(`${file}: дубль id «${entry.id}» (уже в ${ids.get(entry.id)})`);
      continue;
    }
    ids.set(entry.id, file);
    referenced.add(path.normalize(path.relative(commandsDir, entry.script)));

    const source = fs.readFileSync(entry.script, 'utf8');
    const desc = pythonDescription(source);
    if (desc === null) {
      problems.push(`${entry.id}: в скрипте нет Parser(description=...)`);
    } else if (desc !== entry.description) {
      problems.push(`${entry.id}: описание в скрипте («${desc}») не совпадает с манифестом («${entry.description}»)`);
    }

    const isEnabled = ENABLED.includes(entry.id);
    const isDisabled = DISABLED.includes(entry.id);
    if (isEnabled && isDisabled) problems.push(`${entry.id}: одновременно в ENABLED и в DISABLED`);

    if (VERIFIED_SANDBOX.includes(entry.id) || VERIFIED_READONLY.includes(entry.id)) {
      info.verified += 1;
    }
    if (VERIFIED_SANDBOX.includes(entry.id)) {
      if (OUTSIDE_MARKERS.test(source)) problems.push(`${entry.id}: проверенный скрипт обращается к домашним папкам`);
      // Путь на диске владельца в проверенном скрипте — это либо выход из песочницы,
      // либо зашитый путь разработчика. Песочницу скрипт получает из переменной окружения.
      for (const p of absolutePaths(source)) {
        problems.push(`${entry.id}: абсолютный путь вместо ${SANDBOX_ENV}: ${p}`);
      }
    }
    if (VERIFIED_READONLY.includes(entry.id) && touchesFiles(source)) {
      problems.push(`${entry.id}: проверенная команда «только чтение» обращается к файлам`);
    }
    if (!isEnabled && !isDisabled && touchesFiles(source)) {
      problems.push(`${entry.id}: обращается к файлам, но не включена и не выключена явно (см. access.js)`);
    }
    if (isEnabled) info.enabled += 1;
    else if (isDisabled) info.disabled += 1;
    else info.unverified += 1;
  }

  for (const id of policy ? [...ENABLED, ...DISABLED] : []) {
    if (!ids.has(id)) problems.push(`access.js: id «${id}» нет ни в одном манифесте (устаревшая запись)`);
  }

  info.orphans = listScripts(commandsDir).filter((s) => !referenced.has(path.normalize(s)));
  for (const orphan of info.orphans) {
    if (!KNOWN_ORPHANS.includes(orphan)) problems.push(`${orphan}: скрипт не подключён ни одним манифестом`);
  }
  for (const known of policy ? KNOWN_ORPHANS : []) {
    if (!info.orphans.includes(known)) problems.push(`${known}: в KNOWN_ORPHANS, но теперь подключён — убрать из списка`);
  }
  return { problems, info };
}

module.exports = { checkLibrary, pythonDescription, KNOWN_ORPHANS };
