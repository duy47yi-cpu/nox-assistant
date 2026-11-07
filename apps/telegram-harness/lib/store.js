'use strict';

// Небольшое хранилище состояния бота: настройки и сессии.
// Пишем через временный файл и переименование, чтобы падение не портило JSON.

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

class Store {
  constructor(file, defaults) {
    this.file = file;
    const loaded = readJson(file, null);
    this.data = Object.assign({}, defaults, loaded || {});
    if (!loaded) this.save();
  }

  get(key, fallback) {
    return this.data[key] === undefined ? fallback : this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    writeJson(this.file, this.data);
  }
}

module.exports = { Store, readJson, writeJson };
