'use strict';

// Реестр пространств. Старое общее пространство не переносим; остальные получают отдельные
// каталоги файлов и памяти. Здесь нет переключения работающего агента или фоновых задач.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { WorkspaceIndex } = require('../rag/index');
const { MemoryStore } = require('../memory/store');
const { GoalStore } = require('../goals/store');

const DEFAULT = Object.freeze({ id: 'default', name: 'Общее' });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SPACES = 100;

function inside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

// Раскрываем существующие части пути, включая junction; несуществующий хвост сохраняем.
function realish(value) {
  let probe = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error('не удалось проверить путь пространства');
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  return path.join(fs.realpathSync(probe), ...tail);
}

function checkDir(dir, create = false) {
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('папка пространства должна быть настоящей папкой, не ссылкой');
}

function checkFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('файл пространства не должен быть ссылкой');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function nameOf(value) {
  if (typeof value !== 'string') throw new Error('нужно название пространства');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('название пространства: от 1 до 80 символов');
  return name;
}

class WorkspaceBook {
  constructor({ defaultRoot, spacesRoot, dataDir } = {}) {
    for (const dir of [defaultRoot, spacesRoot, dataDir]) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('нужны абсолютные пути пространств');
    }
    this.defaultRoot = path.resolve(defaultRoot);
    this.spacesRoot = path.resolve(spacesRoot);
    this.dataDir = path.resolve(dataDir);
    this.spaceDataRoot = path.join(this.dataDir, 'workspaces');
    this.file = path.join(this.dataDir, 'workspaces.json');
    checkDir(this.defaultRoot);
    checkDir(this.dataDir);
    this._checkRoots();
    this._load(); // повреждённый реестр нельзя молча заменить пустым
  }

  _checkRoots() {
    const roots = [this.defaultRoot, this.spacesRoot, this.dataDir].map(realish);
    for (let i = 0; i < roots.length; i += 1) {
      for (let j = i + 1; j < roots.length; j += 1) {
        if (inside(roots[i], roots[j]) || inside(roots[j], roots[i])) throw new Error('папки файлов и данных пространств должны быть раздельными');
      }
    }
  }

  _load() {
    this._checkRoots();
    checkFile(this.file);
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return { version: 1, selected: DEFAULT.id, spaces: [] }; throw err; }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('реестр пространств повреждён'); }
    if (!data || data.version !== 1 || !Array.isArray(data.spaces) || data.spaces.length > MAX_SPACES) throw new Error('реестр пространств повреждён');
    const ids = new Set([DEFAULT.id]);
    const names = new Set([DEFAULT.name.toLocaleLowerCase()]);
    for (const item of data.spaces) {
      let name;
      try { name = nameOf(item && item.name); } catch { throw new Error('реестр пространств повреждён'); }
      if (!item || !ID.test(item.id) || name !== item.name || ids.has(item.id) || names.has(name.toLocaleLowerCase())) throw new Error('реестр пространств повреждён');
      ids.add(item.id); names.add(name.toLocaleLowerCase());
    }
    if (!ids.has(data.selected)) throw new Error('реестр пространств повреждён');
    return data;
  }

  _save(data) {
    checkFile(this.file);
    const tmp = path.join(this.dataDir, `.workspaces.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tmp, this.file);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  list() {
    const data = this._load();
    return { selected: data.selected, spaces: [{ ...DEFAULT }, ...data.spaces.map(({ id, name }) => ({ id, name }))] };
  }

  current() {
    const list = this.list();
    return list.spaces.find((item) => item.id === list.selected);
  }

  create(value) {
    const name = nameOf(value);
    const data = this._load();
    if ([DEFAULT, ...data.spaces].some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('пространство с таким названием уже существует');
    if (data.spaces.length >= MAX_SPACES) throw new Error('достигнут предел пространств');
    checkDir(this.spacesRoot, true);
    checkDir(this.spaceDataRoot, true);
    const item = { id: randomUUID(), name };
    // Создаём только новые папки; совпадение id никогда не перезаписывает существующие данные.
    fs.mkdirSync(path.join(this.spacesRoot, item.id));
    fs.mkdirSync(path.join(this.spaceDataRoot, item.id));
    this._save({ ...data, spaces: [...data.spaces, item] });
    return { ...item };
  }

  select(id) {
    const data = this._load();
    if (id !== DEFAULT.id && !data.spaces.some((item) => item.id === id)) throw new Error('пространство не найдено');
    // Сначала проверяем папки: нельзя сохранить выбор, который не удастся открыть.
    this.open(id);
    this._save({ ...data, selected: id });
    return this.current();
  }

  open(id) {
    const item = this.list().spaces.find((entry) => entry.id === id);
    if (!item) throw new Error('пространство не найдено');
    let root = this.defaultRoot;
    let memoryFile = path.join(this.dataDir, 'memory.json');
    if (id !== DEFAULT.id) {
      checkDir(this.spacesRoot);
      checkDir(this.spaceDataRoot);
      root = path.join(this.spacesRoot, id);
      const spaceData = path.join(this.spaceDataRoot, id);
      checkDir(root);
      checkDir(spaceData);
      memoryFile = path.join(spaceData, 'memory.json');
    }
    checkFile(memoryFile);
    const goalFile = path.join(path.dirname(memoryFile), 'goals.json');
    checkFile(goalFile);
    const index = new WorkspaceIndex(root);
    index.denyWrite = [this.dataDir];
    return { ...item, root, index, memory: new MemoryStore(memoryFile), goals: new GoalStore(goalFile) };
  }
}

module.exports = { WorkspaceBook };
