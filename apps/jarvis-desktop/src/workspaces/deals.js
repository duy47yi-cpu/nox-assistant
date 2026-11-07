'use strict';

// У каждого отдельного пространства свой журнал дел; очередь задач общая, но в журнал попадают только свои.
const fs = require('fs');
const path = require('path');
const { DealStore, syncDeals } = require('../deals/deals');

function checkFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('файл дел пространства не должен быть ссылкой');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

class WorkspaceDeals {
  constructor({ book, tasks, reminders = () => [] }) {
    if (!book || typeof tasks !== 'function') throw new Error('нужны реестр пространств и задачи');
    this.book = book;
    this.tasks = tasks;
    this.reminders = reminders;
    this.stores = new Map();
  }

  store(id) {
    if (!id || id === 'default') throw new Error('для общего пространства используется общий журнал дел');
    const space = this.book.open(id);
    const dir = path.dirname(space.memory.filePath);
    const events = path.join(dir, 'deals.jsonl');
    const snapshot = path.join(dir, 'deals.json');
    for (const file of [events, snapshot, `${snapshot}.tmp`]) checkFile(file);
    if (!this.stores.has(id)) this.stores.set(id, new DealStore(events, snapshot));
    return this.stores.get(id);
  }

  refresh(id) {
    const store = this.store(id);
    syncDeals(store, {
      tasks: this.tasks().filter((task) => task.workspaceId === id),
      reminders: this.reminders().filter((item) => item.workspaceId === id),
    });
    return store;
  }
}

module.exports = { WorkspaceDeals };
