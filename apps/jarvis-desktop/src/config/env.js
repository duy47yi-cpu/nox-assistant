'use strict';

const fs = require('fs');
const path = require('path');

// Читает простой файл KEY=VALUE. Значения нигде не выводятся.
function loadEnvFile(file) {
  const env = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return env;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

// Значение из переменной окружения важнее значения из файла.
function makeConfig(rootDir) {
  const fileEnv = loadEnvFile(path.join(rootDir, '.env'));
  return (key) => process.env[key] || fileEnv[key] || '';
}

module.exports = { loadEnvFile, makeConfig };
