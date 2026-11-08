'use strict';

// Изолированный ход чата: каждая сессия владеет историей, памятью и файловыми инструментами.
// В фоновые задачи она не передаёт свой набор инструментов и не меняет их корень.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Agent, repairToolHistory } = require('../agent/loop');
const { ToolRegistry } = require('../tools/registry');
const { workspaceTools } = require('../tools/workspace');
const { projectTools } = require('../tools/project');
const { documentTools } = require('../tools/documents');
const { memoryTools } = require('../tools/memory');
const { imageTools } = require('../tools/ocr');
const { waitTools } = require('../tools/wait');
const { chatCodeTools } = require('../tools/code');
const { memoryContext, profileNote } = require('../memory/store');
const { learnFromTurn } = require('../memory/learn');
const { loadSkills } = require('../skills');
const { learnSkillFromTurn, skillHintForTurn } = require('../skills/experience');
const { skillsTools } = require('../tools/skills');
const { goalTools } = require('../goals/tools');
const { goalsBrief } = require('../goals/store');
const { maskHistory } = require('../journal/journal');
const { ChatBook } = require('../chats/book');

// Общие инструменты компьютера и подключений проходят политику выбранного режима.
// Они действуют на общий компьютер и аккаунты; файлы, память и история принадлежат пространству.
// Картинки читаются инструментами самого пространства — их корень папки берётся из пространства.
const COMMON = new Set([
  'web_search', 'web_fetch', 'web_wiki', 'web_research', 'web_check_claims', 'weather_now', 'currency_rate',
  'screen_look', 'screen_region_look', 'desktop_observe', 'windows_list', 'mail_unread',
  'desktop_click', 'desktop_type', 'ui_windows', 'ui_elements', 'ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'ui_close_window', 'ui_set_toggle', 'ui_wait',
  'mouse_click', 'mouse_scroll', 'shell_run', 'app_search', 'app_install', 'app_open', 'app_close',
  'browser_open', 'browser_read', 'browser_scroll', 'browser_click', 'browser_type', 'url_open', 'mail_send',
  'youtube_play', 'windows_focus', 'windows_arrange', 'windows_minimize_all', 'windows_restore_all', 'windows_close_all',
  'organize_workspace', 'restore_workspace', 'clipboard_get', 'clipboard_set', 'media_control', 'volume_set', 'monitor_off', 'pc_shutdown',
  'apps_find', 'apps_scan', 'apps_usage', 'disk_free_space', 'disk_cleanup_suggest', 'wait', 'speak',
]);
const MAX_HISTORY = 80;

function trimHistory(history) {
  if (history.length <= MAX_HISTORY) return history;
  let start = history.length - MAX_HISTORY;
  while (start < history.length && history[start].role !== 'user') start += 1;
  return history.slice(start);
}

function regularFileOrAbsent(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('файл разговоров не должен быть ссылкой');
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function loadChats(file) {
  regularFileOrAbsent(file);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return new ChatBook(null); throw err; }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('файл разговоров повреждён'); }
  if (!data || (!Array.isArray(data.chats) && !Array.isArray(data.history))) throw new Error('файл разговоров повреждён');
  const validHistory = (history) => Array.isArray(history) && history.every((message) => message && typeof message === 'object' && typeof message.role === 'string');
  if (Array.isArray(data.chats)) {
    const ids = new Set();
    for (const chat of data.chats) {
      if (!chat || typeof chat.id !== 'string' || !chat.id || ids.has(chat.id) || !validHistory(chat.history)) throw new Error('файл разговоров повреждён');
      ids.add(chat.id);
    }
    if (data.activeId !== undefined && data.chats.length && !ids.has(data.activeId)) throw new Error('файл разговоров повреждён');
  } else if (!validHistory(data.history)) throw new Error('файл разговоров повреждён');
  const chats = new ChatBook(data);
  for (const chat of chats.chats) chat.history = repairToolHistory(trimHistory(chat.history));
  return chats;
}

function saveChats(file, chats) {
  regularFileOrAbsent(file);
  const tmp = path.join(path.dirname(file), `.conversation.${randomUUID()}.tmp`);
  const data = chats.toJSON((history) => maskHistory(trimHistory(history).map(({ image, ...message }) => message)));
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function toolsFor(space, commonTools, renderPdf, scopedTools, skills) {
  const registry = new ToolRegistry();
  for (const tool of [
    ...workspaceTools(space.index), ...projectTools(space.index), ...documentTools(space.index, { renderPdf }),
    ...memoryTools(space.memory), ...goalTools(space.goals), ...imageTools({ workspace: space.root }),
    ...waitTools({ resolveFile: (p) => space.index.resolveInside(p) }),
    ...chatCodeTools({ root: space.root, denyDirs: space.index.denyWrite, index: space.index }),
  ]) registry.register(tool);
  for (const tool of commonTools) if (tool && COMMON.has(tool.name)) registry.register(tool);
  for (const tool of typeof scopedTools === 'function' ? scopedTools(space) : []) registry.register(tool);
  for (const tool of skillsTools(skills)) registry.register(tool);
  return registry;
}

class WorkspaceChat {
  constructor({ book, brain, commonTools = [], scopedTools = null, renderPdf, builtinSkillsDir = null, systemPrompt = '', policy, approvals, journal, emit, mode = 'ask', stop, clock, turnsLog, memoryAuto = () => true, turnDeadlineMs = 0 } = {}) {
    if (!book || !brain) throw new Error('нужны реестр пространств и модель');
    this.book = book;
    this.options = { brain, commonTools, scopedTools, renderPdf, builtinSkillsDir, systemPrompt, policy, approvals, journal, emit, mode, stop, clock, turnsLog, memoryAuto, turnDeadlineMs };
    this.busy = false;
    this.session = this._open(book.current().id);
  }

  _open(id) {
    const space = this.book.open(id);
    // Индекс принадлежит этой сессии чата; фоновые задачи создают отдельные индексы.
    space.index.unrestricted = this.options.mode === 'full';
    const conversation = path.join(path.dirname(space.memory.filePath), 'conversation.json');
    const chats = loadChats(conversation);
    const skillsDir = path.join(path.dirname(space.memory.filePath), 'skills');
    const skills = loadSkills(...(this.options.builtinSkillsDir ? [this.options.builtinSkillsDir] : []), skillsDir);
    const registry = toolsFor(space, this.options.commonTools, this.options.renderPdf, this.options.scopedTools, skills);
    const prompt = () => {
      const base = typeof this.options.systemPrompt === 'function' ? this.options.systemPrompt(space) : this.options.systemPrompt;
      return [base, profileNote(space.memory), goalsBrief(space.goals)].filter(Boolean).join('\n');
    };
    const agent = new Agent({
      brain: this.options.brain, tools: registry, policy: this.options.policy, approvals: this.options.approvals,
      journal: typeof this.options.journal === 'function' ? this.options.journal(space) : this.options.journal,
      emit: this.options.emit, mode: this.options.mode, stop: this.options.stop,
      workspace: space.root, history: chats.active().history, systemPrompt: prompt,
      clock: this.options.clock, turnsLog: this.options.turnsLog, maxSteps: 24, stream: true, turnDeadlineMs: this.options.turnDeadlineMs || 0,
      context: (text) => [memoryContext(space.memory, text), skillHintForTurn(skills, text)].filter(Boolean).join('\n'),
    });
    return { space, conversation, chats, registry, agent, skills, skillsDir };
  }

  current() { return { id: this.session.space.id, name: this.session.space.name }; }
  root() { return this.session.space.root; }
  history() { return this.session.agent.history.slice(); }
  remember(text, reply) {
    if (this.busy || this.session.agent._controller) throw new Error('Джарвис занят');
    this.session.agent.remember(text, reply);
    saveChats(this.session.conversation, this.session.chats);
  }
  tools() { return this.session.registry; }
  chatList() { return this.session.chats.list(); }
  stop() { this.session.agent.stop(); }

  setMode(mode) {
    this.options.mode = mode;
    this.session.space.index.unrestricted = mode === 'full';
    this.session.agent.setMode(mode);
  }

  _changeChat(change) {
    if (this.busy || this.session.agent._controller) throw new Error('Джарвис занят: остановите текущий ход');
    const draft = new ChatBook(this.session.chats.toJSON((history) => history.slice()));
    if (change(draft) === false) throw new Error('чат не найден');
    // Ошибка записи не должна переключить историю только в памяти.
    saveChats(this.session.conversation, draft);
    this.session.chats = draft;
    this.session.agent.history = draft.active().history;
    return draft.list();
  }

  newChat() { return this._changeChat((draft) => draft.create()); }
  selectChat(id) { return this._changeChat((draft) => draft.select(id)); }
  closeChat(id) { return this._changeChat((draft) => draft.close(id)); }
  clearChat() { return this._changeChat((draft) => { draft.active().history.length = 0; }); }

  select(id) {
    if (this.busy || this.session.agent._controller) throw new Error('Джарвис занят: остановите текущий ход');
    if (this.session.space.id === id) return this.current();
    const next = this._open(id); // Ошибка открытия не меняет текущий выбор.
    saveChats(this.session.conversation, this.session.chats);
    this.book.select(id);
    this.session = next;
    return this.current();
  }

  async run(text, opts = {}) {
    if (this.busy) throw new Error('Джарвис занят');
    this.busy = true;
    try {
      const result = await this.session.agent.run(text, opts);
      try {
        if (this.options.memoryAuto()) {
          const ownerText = typeof opts.ownerText === 'string' ? opts.ownerText : text;
          learnFromTurn({ store: this.session.space.memory, text: ownerText });
          const learned = learnSkillFromTurn({ dir: this.session.skillsDir, phrase: ownerText, history: this.session.agent.history, outcome: result && result.outcome });
          if (learned.written) this.session.skills.set(learned.skill.name, learned.skill);
        }
      } catch { /* автоматическая память не должна прерывать ответ */ }
      return result;
    }
    finally {
      try { saveChats(this.session.conversation, this.session.chats); }
      finally { this.busy = false; }
    }
  }
}

module.exports = { WorkspaceChat, toolsFor, COMMON };
