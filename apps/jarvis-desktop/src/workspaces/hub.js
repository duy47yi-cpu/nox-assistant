'use strict';

// Управляет сменой контекста чата. Общий чат живёт в существующем приложении;
// отдельный чат создаётся заново после каждого выхода в общее пространство.
class WorkspaceHub {
  constructor({ book, makeChat, saveDefault, isBusy }) {
    this.book = book;
    this.makeChat = makeChat;
    this.saveDefault = saveDefault;
    this.isBusy = isBusy;
    this.active = book.current().id === 'default' ? null : makeChat();
  }

  current() { return this.book.current(); }
  list() { return this.book.list(); }
  chat() { return this.active; }

  create(name) {
    if (this.isBusy()) throw new Error('Джарвис занят: остановите текущий ход');
    return this.book.create(name);
  }

  select(id) {
    if (this.isBusy()) throw new Error('Джарвис занят: остановите текущий ход');
    if (this.current().id === id) return this.list();
    if (this.active) {
      this.active.select(id);
      if (id === 'default') this.active = null;
    } else {
      if (this.saveDefault() === false) throw new Error('не удалось сохранить общий разговор');
      const next = this.makeChat();
      next.select(id);
      this.active = next;
    }
    return this.list();
  }
}

module.exports = { WorkspaceHub };
