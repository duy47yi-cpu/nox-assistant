'use strict';

// Команды «Общего» остаются в старом файле; у каждого отдельного пространства свой commands.json.
const fs = require('fs');
const path = require('path');
const { CommandStore } = require('../commands/store');

function checkCommandFile(file) {
  const dir = path.dirname(file);
  const parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('папка команд пространства должна быть настоящей папкой');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('файл команд пространства не должен быть ссылкой');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

// Общие файловые, памятные, библиотечные и «картиночные» инструменты в командах пространства
// берутся из его собственных наборов (с корнем папки пространства), а не из общего реестра.
// Иначе image_read_text/image_look регистрировались бы дважды — это уже ловилось на напоминаниях.
const SHARED_COMMAND_TOOL = /^(workspace_|document_|project_|memory_|remember$|recall$|forget$|goal_|remind_|list_reminders$|cancel_reminder$|wait_for|skills_|image_|lib_)/;

function toolsForWorkspaceCommands(tools = []) {
  return tools.filter((tool) => tool && typeof tool.name === 'string' && !SHARED_COMMAND_TOOL.test(tool.name));
}

class WorkspaceCommandStores {
  constructor({ book, defaultStore } = {}) {
    if (!book || !defaultStore) throw new Error('нужны реестр пространств и общий список команд');
    this.book = book;
    this.defaultStore = defaultStore;
    this.cache = new Map();
  }

  store(id = 'default') {
    if (id === 'default') return this.defaultStore;
    if (typeof id !== 'string' || !id) throw new Error('неверное пространство команд');
    const space = this.book.open(id);
    const file = path.join(path.dirname(space.memory.filePath), 'commands.json');
    checkCommandFile(file);
    if (!this.cache.has(id)) this.cache.set(id, new CommandStore(file));
    return this.cache.get(id);
  }
}

module.exports = { WorkspaceCommandStores, checkCommandFile, toolsForWorkspaceCommands };
