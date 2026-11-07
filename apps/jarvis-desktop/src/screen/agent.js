'use strict';

// Агент экрана: снимок → модель выбирает один шаг → шаг → проверка (verify) → свежий снимок → следующий шаг.
// Цикл, политика (decide), подтверждения, журнал и стоп — общие из Agent: своих правил здесь нет.
const { Agent } = require('../agent/loop');
const { ToolRegistry } = require('../tools/registry');

const SCREEN_TOOL_NAMES = ['screen_look', 'ui_elements', 'ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'app_open', 'ui_wait'];
const MAX_SCREEN_STEPS = 20;
const TASK_PHRASE = /^сделай на экране[\s:,—-]*([\s\S]*)$/i;

const SCREEN_PROMPT = [
  'Ты Джарвис и работаешь на экране владельца по одному шагу.',
  'Начни со снимка экрана (screen_look). Потом за один ответ делай ровно один шаг: найди элементы (ui_elements), нажми (ui_click), введи текст (ui_type), нажми клавиши (ui_keys), переключи окно (ui_focus), запусти программу (app_open) или подожди (ui_wait).',
  'После каждого действия ты получаешь свежий снимок экрана: сверь по нему, что шаг сработал, и только потом выбирай следующий.',
  'Оплату не делай. Если не уверен, что шаг сработал, не повторяй его, а скажи владельцу.',
  'Когда задача выполнена, коротко скажи, что сделано и что видно на экране.',
].join('\n');

const UNSURE_TEXT = 'Не уверен, что последний шаг сработал: проверка его не подтвердила. Дальше не иду, чтобы не повторить вслепую. Посмотрите на экран и скажите, продолжать ли.';
const NO_SCREEN_TEXT = 'Не удалось получить снимок экрана. Останавливаюсь: проверьте экран и скажите, как продолжить.';

// «сделай на экране: открой блокнот» → «открой блокнот»; иначе null.
function screenTask(text) {
  const m = TASK_PHRASE.exec(String(text || '').trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

// Только инструменты экрана. Снимок свой: владелец сам попросил работу на экране.
function screenRegistry(source, look) {
  const reg = new ToolRegistry();
  reg.register(look);
  for (const name of SCREEN_TOOL_NAMES) {
    if (name === 'screen_look') continue;
    const tool = source.get(name);
    if (tool) reg.register(tool);
  }
  return reg;
}

class ScreenAgent extends Agent {
  // look — инструмент screen_look; tools — общий реестр, из него берутся только инструменты экрана.
  constructor({ look, tools, ...opts } = {}) {
    super({ ...opts, tools: screenRegistry(tools, look), systemPrompt: SCREEN_PROMPT, history: [], maxSteps: MAX_SCREEN_STEPS, lookFirst: true });
    this.look = look;
    this._failed = false;
    this._noScreen = false;
  }

  run(text, options) {
    this._failed = false;
    this._noScreen = false;
    return super.run(text, options);
  }

  // Исход шага не подтверждён (готовая пометка «исход неизвестен» или проверка сказала «нет»): модель больше не зовём.
  _unsure() {
    return this._failed || this._noScreen || this._unknownCalls.size > 0;
  }

  async _callModel(round, answerOnly, signal) {
    if (this._unsure()) {
      this._streamedChars = 0;
      return { content: this._noScreen ? NO_SCREEN_TEXT : UNSURE_TEXT, toolCalls: [] };
    }
    const res = await super._callModel(round, answerOnly, signal);
    // Один шаг за раз: остальное модель решит заново по свежему снимку.
    if (res && Array.isArray(res.toolCalls) && res.toolCalls.length > 1) return { ...res, toolCalls: res.toolCalls.slice(0, 1) };
    return res;
  }

  async _execute(tool, args, signal) {
    const out = await super._execute(tool, args, signal);
    if (tool.name === 'screen_look') {
      if (!out.ok || !out.image) {
        this._noScreen = true;
        return { ...out, ok: false, summary: 'не удалось получить снимок экрана' };
      }
      return out;
    }
    if (tool.risk === 'T0') return out;
    if (out.verified === 'failed') this._failed = true;
    if (signal.aborted || this._unsure() || out.verified === 'unknown' || out.thrown) return out;
    // Свежий снимок после действия: по нему модель сверяет результат и выбирает следующий шаг.
    try {
      const shot = await this.look.run({}, { workspace: this.workspace, signal });
      if (shot && shot.ok && shot.image) out.image = shot.image;
      else this._noScreen = true;
    } catch {
      this._noScreen = true;
    }
    return out;
  }

  _endTurn() {
    if (this._turn && this._turn.outcome === 'answer' && this._unsure()) this._turn.outcome = 'needs_human';
    super._endTurn();
  }
}

module.exports = { ScreenAgent, screenTask, SCREEN_TOOL_NAMES, MAX_SCREEN_STEPS, UNSURE_TEXT };
