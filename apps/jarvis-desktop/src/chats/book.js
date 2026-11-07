'use strict';

// Вкладки чатов. У каждого чата своя история; активная — тот же массив, что agent.history.
const { randomUUID } = require('crypto');

const TITLE_MAX = 32;
const NEW_TITLE = 'Новый чат';

const makeChat = (history = []) => ({ id: randomUUID(), history });

function titleOf(chat) {
  const first = chat.history.find((m) => m.role === 'user' && !m.fromTool && typeof m.content === 'string' && m.content.trim());
  if (!first) return NEW_TITLE;
  const line = first.content.trim().split('\n')[0];
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

class ChatBook {
  // data — содержимое файла разговора: новый вид {activeId, chats} или старый {history} одного разговора.
  constructor(data) {
    const stored = data && Array.isArray(data.chats) ? data.chats : [];
    this.chats = stored
      .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.history))
      .map((c) => ({ id: c.id, history: c.history }));
    if (!this.chats.length) this.chats.push(makeChat(data && Array.isArray(data.history) ? data.history : []));
    this.activeId = this.chats.some((c) => c.id === data?.activeId) ? data.activeId : this.chats[0].id;
  }

  active() {
    return this.chats.find((c) => c.id === this.activeId);
  }

  list() {
    return { activeId: this.activeId, chats: this.chats.map((c) => ({ id: c.id, title: titleOf(c) })) };
  }

  // Пустой чат уже есть — переходим в него, а не копим одинаковые вкладки.
  create() {
    const empty = this.chats.find((c) => c.history.length === 0);
    const chat = empty || makeChat();
    if (!empty) this.chats.push(chat);
    this.activeId = chat.id;
    return chat;
  }

  select(id) {
    if (!this.chats.some((c) => c.id === id)) return false;
    this.activeId = id;
    return true;
  }

  // Закрыт активный — становится активным сосед; закрыт последний — остаётся новый пустой.
  close(id) {
    const at = this.chats.findIndex((c) => c.id === id);
    if (at < 0) return false;
    this.chats.splice(at, 1);
    if (!this.chats.length) this.chats.push(makeChat());
    if (this.activeId === id) this.activeId = this.chats[Math.min(at, this.chats.length - 1)].id;
    return true;
  }

  toJSON(mapHistory = (h) => h) {
    return { activeId: this.activeId, chats: this.chats.map((c) => ({ id: c.id, history: mapHistory(c.history) })) };
  }
}

module.exports = { ChatBook, NEW_TITLE };
