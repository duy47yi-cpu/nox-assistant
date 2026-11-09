'use strict';

// Агент экрана: снимок → модель выбирает один шаг → шаг → проверка (verify) → свежий снимок → следующий шаг.
// Цикл, политика (decide), журнал и стоп — общие из Agent. Своё здесь: до 40 шагов на ход и обязательное
// подтверждение опасного шага (отправка, оплата, удаление, установка, Enter после ввода текста) — через общий
// брокер подтверждений (ApprovalBroker). Отказ владельца = needs_human: шаг не выполняется и не повторяется.
const { Agent } = require('../agent/loop');
const { ToolRegistry } = require('../tools/registry');

const SCREEN_TOOL_NAMES = ['screen_look', 'ui_elements', 'ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'app_open', 'ui_wait'];
const MAX_SCREEN_STEPS = 40;
// Безопасные шаги, которые можно выполнить подряд одним ответом модели (до 3): код выполнит их
// по очереди и остановится после первой ошибки. Опасные шаги (отправка, оплата, удаление,
// установка, Enter после ввода) в серию не собираются: они всегда идут отдельным ответом с вопросом.
const SAFE_BATCH = new Set(['ui_click', 'ui_type', 'ui_keys', 'ui_focus']);
const MAX_SAFE_BATCH = 3;
const TASK_PHRASE = /^сделай на экране[\s:,—-]*([\s\S]*)$/i;
// Подпись статуса, пока ждём подтверждения: та же, что в Agent, но здесь она своя, чтобы не менять loop.js.
const WAITING_WORDS = 'жду вашего решения';

const SCREEN_PROMPT = [
  'Ты Джарвис и работаешь на экране владельца по шагам.',
  'Начни со снимка экрана (screen_look). Дальше за один ответ делай один шаг: найди элементы (ui_elements), нажми (ui_click), введи текст (ui_type), нажми клавиши (ui_keys), переключи окно (ui_focus), запусти программу (app_open) или подожди (ui_wait).',
  'Если шаги очевидны и безопасны (нажатия, ввод, клавиши, переключение окна), можно отдать 2–3 таких шага одним ответом: код выполнит их по порядку и остановится после первой ошибки. Опасные шаги — отправка, оплата, удаление, установка, Enter после ввода текста — выполняются только отдельным ответом: подтверждение спросит код, после отказа не повторяй шаг.',
  'После действия ты получаешь свежий снимок экрана: сверь по нему, что шаг сработал, и только потом выбирай следующий.',
  'Оплату не делай. Если не уверен, что шаг сработал, не повторяй его, а скажи владельцу.',
  'Перед отправкой, оплатой, удалением, установкой и Enter после ввода текста подтверждение спросит код: после отказа не повторяй шаг и скажи, что остановился.',
  'Когда задача выполнена, коротко скажи, что сделано и что видно на экране.',
].join('\n');

const UNSURE_TEXT = 'Не уверен, что последний шаг сработал: проверка его не подтвердила. Дальше не иду, чтобы не повторить вслепую. Посмотрите на экран и скажите, продолжать ли.';
const NO_SCREEN_TEXT = 'Не удалось получить снимок экрана. Останавливаюсь: проверьте экран и скажите, как продолжить.';

// Опасная подпись элемента: отправка, оплата, удаление, установка. Оплату и так запрещает политика (deny),
// остальные слова в «Полном доступе» политика пропустила бы молча — их ловит агент экрана.
const DANGER_ELEMENT = /отправ|пересл|\bsend\b|\bsubmit\b|удал|\bdelete\b|\bremove\b|установ|\binstall\b|оплат|\bpay\b|\bbuy\b|куп|покупк|оформить\s+(?:заказ|покупк)/i;
// Enter после ввода текста может отправить сообщение: такой шаг спрашивается отдельно.
const DANGER_KEYS = new Set(['enter']);

// «сделай на экране: открой блокнот» → «открой блокнот»; иначе null.
function screenTask(text) {
  const m = TASK_PHRASE.exec(String(text || '').trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

// Клавиши разбираются так же, как в src/tools/ui.js: через пробел, запятую или «+» внутри сочетания.
function keyTokens(keys) {
  return String(keys == null ? '' : keys)
    .toLowerCase()
    .replace(/\s*\+\s*/g, '+')
    .split(/[\s,;]+/)
    .filter(Boolean);
}

// Опасный ли шаг: нажатие/ввод в элемент с опасной подписью или Enter после ввода текста в этом же ходу.
// typed — в этом ходу уже был успешный ui_type. Проверка политики не заменяет: она спрашивает по режиму.
function isDangerousStep(name, args, { typed = false } = {}) {
  const n = String(name || '');
  const a = args || {};
  if (n === 'ui_click' || n === 'ui_type') {
    return typeof a.name === 'string' && DANGER_ELEMENT.test(a.name);
  }
  if (n === 'ui_keys') return Boolean(typed) && keyTokens(a.keys).some((t) => DANGER_KEYS.has(t));
  return false;
}

// Подпись шага для вопроса и отказа: имя элемента (экрана) в кавычках или понятное описание клавиш.
// Длина ограничена: подпись приходит с экрана, в текст владельцу она не должна попадать простынёй.
function dangerLabel(name, args) {
  const n = String(name || '');
  if (n === 'ui_keys') return 'Enter после ввода текста';
  const a = args || {};
  const label = typeof a.name === 'string' ? a.name.trim().slice(0, 120) : '';
  return label ? `«${label}»` : (n || 'шаг');
}

// Текст честного отказа: ход кончается вопросом к владельцу, шаг не выполнен и не повторяется.
function dangerDenyText(label) {
  return `Шаг не выполнен: ${label} — опасное действие (отправка, оплата, удаление или установка), а вы его не подтвердили. Останавливаюсь и не повторяю шаг. Скажите, если нужно попробовать снова.`;
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
  // maxSteps — предел шагов на ход; по умолчанию MAX_SCREEN_STEPS, тесты задают меньше.
  constructor({ look, tools, maxSteps = MAX_SCREEN_STEPS, ...opts } = {}) {
    super({
      ...opts,
      tools: screenRegistry(tools, look),
      systemPrompt: SCREEN_PROMPT,
      history: [],
      maxSteps: maxSteps > 0 ? maxSteps : MAX_SCREEN_STEPS,
      lookFirst: true,
    });
    this.look = look;
    this._failed = false;
    this._noScreen = false;
    this._typed = false; // в этом ходу уже вводили текст: Enter после него спрашиваем
    this._denied = false; // владелец отказал в опасном шаге: ход кончается needs_human
    this._deniedLabel = '';
  }

  run(text, options) {
    this._failed = false;
    this._noScreen = false;
    this._typed = false;
    this._denied = false;
    this._deniedLabel = '';
    return super.run(text, options);
  }

  // Исход шага не подтверждён (готовая пометка «исход неизвестен», проверка сказала «нет») или владелец
  // отказал в опасном шаге: модель больше не зовём и шаг не повторяем.
  _unsure() {
    return this._failed || this._noScreen || this._denied || this._unknownCalls.size > 0;
  }

  // Политика решает по режиму; опасный шаг агент экрана спрашивает всегда, даже в «Полном доступе».
  // Запрет политики (оплата, запреты modes.js) остаётся запретом: вопросом его не заменяем.
  _verdict(tool, args) {
    // Исход предыдущего шага неизвестен (снимка нет, проверка не прошла, отказ): остальные шаги
    // серии не выполняем, чтобы не действовать вслепую.
    if (this._unsure()) return 'deny';
    const verdict = super._verdict(tool, args);
    if (verdict !== 'allow') return verdict;
    return isDangerousStep(tool.name, args, { typed: this._typed }) ? 'ask' : verdict;
  }

  async _callModel(round, answerOnly, signal) {
    if (this._unsure()) {
      this._streamedChars = 0;
      const content = this._denied
        ? dangerDenyText(this._deniedLabel)
        : this._noScreen ? NO_SCREEN_TEXT : UNSURE_TEXT;
      return { content, toolCalls: [] };
    }
    const res = await super._callModel(round, answerOnly, signal);
    // Безопасные шаги (до 3) можно выполнить подряд одним ответом: код выполнит их по порядку и
    // остановится после первой ошибки. Опасный шаг или чтение (снимок, поиск элементов, запуск)
    // остаются по одному за ответ — им нужен свежий результат до следующего выбора.
    if (res && Array.isArray(res.toolCalls) && res.toolCalls.length > 1) {
      let n = 0;
      while (n < res.toolCalls.length && n < MAX_SAFE_BATCH) {
        const call = res.toolCalls[n];
        if (!call || !SAFE_BATCH.has(call.name) || isDangerousStep(call.name, call.args, { typed: this._typed })) break;
        n += 1;
      }
      if (n === 0) n = 1;
      if (n < res.toolCalls.length) return { ...res, toolCalls: res.toolCalls.slice(0, n) };
    }
    return res;
  }

  // Опасный шаг: то же подтверждение через брокер, но без «на сессию» — каждое такое действие отдельное.
  async _askDanger(tool, call, signal, info = {}) {
    if (!this.approvals) return 'reject';
    const label = dangerLabel(call.name, call.args);
    const payload = {
      // id совпадает с id вызова: интерфейс сводит запрос и шаг в одну запись истории.
      id: call.id,
      name: tool.name,
      args: call.args,
      risk: tool.risk,
      reason: `опасный шаг на экране: ${label} — отправка, оплата, удаление или установка; такое действие подтверждается каждый раз`,
      allowSession: false,
    };
    this._status('waiting_approval', {
      status: 'awaiting_approval', step: info.step, label: WAITING_WORDS,
      ...(info.target ? { target: info.target } : {}), ...(info.startedAt ? { startedAt: info.startedAt } : {}),
    });
    // Сначала регистрируем запрос, потом сообщаем окну: быстрый ответ не потеряется.
    const waiting = this.approvals.request(payload);
    const onAbort = () => this.approvals.respond(payload.id, 'reject');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    this._emit({
      type: 'approval_request', ...payload,
      ...(this._runId ? { runId: this._runId } : {}), step: info.step, status: 'awaiting_approval',
      label: WAITING_WORDS, ...(info.target ? { target: info.target } : {}), ...(info.startedAt ? { startedAt: info.startedAt } : {}),
    });
    try {
      return await waiting;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // Отказ владельца на опасном шаге: запоминаем и завершаем ход, шаг не выполняется и не повторяется.
  async _askApproval(tool, call, signal, info = {}) {
    const danger = isDangerousStep(tool.name, call.args, { typed: this._typed });
    const decision = danger
      ? await this._askDanger(tool, call, signal, info)
      : await super._askApproval(tool, call, signal, info);
    if (danger && decision === 'reject') {
      this._denied = true;
      this._deniedLabel = dangerLabel(call.name, call.args);
    }
    return decision;
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
    // Ввод текста в этом ходу: Enter после него может отправить сообщение — дальше такой шаг спрашивается.
    if (tool.name === 'ui_type' && out.ok) this._typed = true;
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

  // Снимок после серии действий: модели хватает последнего состояния, промежуточные картинки
  // не нужны (каждый шаг всё равно получил свою проверку). Это заметно короче запрос.
  _flushImages() {
    if (this._pendingImages.length > 1) this._pendingImages = this._pendingImages.slice(-1);
    super._flushImages();
  }

  _endTurn() {
    if (this._turn && this._turn.outcome === 'answer' && this._unsure()) this._turn.outcome = 'needs_human';
    super._endTurn();
  }
}

module.exports = {
  ScreenAgent, screenTask, SCREEN_TOOL_NAMES, MAX_SCREEN_STEPS, UNSURE_TEXT,
  isDangerousStep, dangerLabel,
};
