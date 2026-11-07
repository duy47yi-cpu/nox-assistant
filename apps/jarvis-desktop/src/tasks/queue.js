'use strict';

// Очередь задач. Одна задача выполняется за раз (JARVIS-DECISIONS J-9).
// Остальные стоят в очереди по приоритету, затем по времени создания.
// Задачу с мандатом ведёт исполнитель (executor.js): она ставится в очередь и запускается без плана,
// план исполнитель составляет после старта.
const model = require('./model');

// Причина паузы задачи, которая при стопе стояла в очереди (после причины стопа).
const QUEUED_STOP_NOTE = 'задача в очереди ждёт вашего решения';

function taskError(message, code = 'task_error') {
  return Object.assign(new Error(message), { code });
}

class TaskQueue {
  // onStatus(task, prevStatus) — необязательный слушатель смены статуса (например, отмена ожидающих подтверждений
  // задачи, ушедшей в blocked, paused, cancelled или done). Его сбой не мешает смене статуса.
  constructor({ tasks = [], now = () => Date.now(), onStatus = null } = {}) {
    this.now = now;
    this.onStatus = typeof onStatus === 'function' ? onStatus : null;
    this._tasks = new Map(tasks.map((t) => [t.id, t]));
  }

  get(id) {
    return this._tasks.get(id) || null;
  }

  list() {
    return [...this._tasks.values()];
  }

  running() {
    return this.list().find((t) => t.status === 'running' || t.status === 'waiting_approval') || null;
  }

  _set(task) {
    const prev = this._tasks.get(task.id);
    this._tasks.set(task.id, task);
    if (this.onStatus && prev && prev.status !== task.status) {
      try {
        this.onStatus(task, prev.status);
      } catch (err) {
        console.error(`задачи: обработчик смены статуса: ${err && err.message ? err.message : err}`);
      }
    }
    return task;
  }

  _need(id) {
    const task = this.get(id);
    if (!task) throw taskError(`задача «${id}» не найдена`);
    return task;
  }

  // Новая задача — черновик.
  add(task) {
    if (this._tasks.has(task.id)) throw taskError(`задача «${task.id}» уже есть`);
    return this._set(task);
  }

  addNote(id, note) {
    const task = this._need(id);
    return this._set({ ...task, notes: [...(Array.isArray(task.notes) ? task.notes : []), note], updatedAt: this.now() });
  }

  // План меняется только до старта (проверяет model.setPlan), здесь — только запись.
  // criteria — критерии приёмки нового плана исполнителя (см. criteria.js); не передан — критерии не меняются.
  replacePlan(id, plan, { criteria } = {}) {
    const task = this._need(id);
    const next = { ...task, plan, updatedAt: this.now(), log: [...task.log, { at: this.now(), event: `план: ${plan.length} шагов` }] };
    if (Array.isArray(criteria)) {
      next.criteria = JSON.parse(JSON.stringify(criteria));
      next.log = [...next.log, { at: this.now(), event: `критерии приёмки: ${criteria.length}` }];
    }
    return this._set(next);
  }

  // Результаты проверки критериев приёмки (исполнитель проверяет их после всех шагов). Статус не меняется.
  setCriteriaResults(id, evaluated) {
    const task = this._need(id);
    return this._set(model.setCriteriaResults(task, evaluated, { now: this.now() }));
  }

  // Отметка шага; три неудачи подряд блокируют задачу (см. model.markStep). result — итог шага для отчёта.
  markStep(id, stepId, status, { summary, now, result } = {}) {
    const task = this._need(id);
    return this._set(model.markStep(task, stepId, status, { summary, now: now || this.now(), result }));
  }

  // Расход задачи: активное время, выполненные инструменты, токены. Статус не меняется.
  addUsage(id, usage = {}) {
    const task = this._need(id);
    return this._set(model.addUsage(task, usage, { now: this.now() }));
  }

  // Шаг выполнен без объективной проверки: в отчёте он будет в списке непроверенных.
  addUnverifiedStep(id, stepId) {
    const task = this._need(id);
    return this._set(model.addUnverifiedStep(task, stepId, { now: this.now() }));
  }

  // Факты шага для итога задачи: отказы мандата и действия с побочным эффектом (см. model.addStepFacts).
  addStepFacts(id, stepId, facts) {
    const task = this._need(id);
    return this._set(model.addStepFacts(task, stepId, facts, { now: this.now() }));
  }

  // Черновик ставим в очередь. Задача с планом становится «в очереди»; задача с мандатом — и без плана.
  enqueue(id) {
    const task = this._need(id);
    if (!task.plan.length && !model.hasMandate(task)) throw taskError('сначала задайте план');
    return this._set(model.transition(task, 'queued', { now: this.now() }));
  }

  // Следующая к запуску: самая приоритетная из «в очереди», при равенстве — самая старая.
  // filter(task) — необязательный отбор (например, только задачи с мандатом).
  next(filter = null) {
    const queued = this.list().filter((t) => t.status === 'queued' && (typeof filter !== 'function' || filter(t)));
    queued.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return queued[0] || null;
  }

  // Запуск: только если ничего не выполняется и не ждёт подтверждения.
  start(id) {
    const busy = this.running();
    if (busy && busy.id !== id) {
      throw taskError(`уже выполняется задача «${busy.title}»`, 'task_busy');
    }
    const task = this._need(id);
    if (!task.plan.length && !model.hasMandate(task)) throw taskError('у задачи нет плана');
    return this._set(model.transition(task, 'running', { now: this.now() }));
  }

  waitApproval(id) {
    const task = this._need(id);
    return this._set(model.transition(task, 'waiting_approval', { now: this.now() }));
  }

  resolveApproval(id) {
    const task = this._need(id);
    return this._set(model.transition(task, 'running', { now: this.now() }));
  }

  pause(id, reason) {
    const task = this._need(id);
    return this._set(model.transition(task, 'paused', { reason, now: this.now() }));
  }

  // Ошибка, которую не исправить повтором шага (например, план так и не составлен).
  block(id, reason) {
    const task = this._need(id);
    return this._set(model.transition(task, 'blocked', { reason, now: this.now() }));
  }

  // Пауза снята: задача снова в очереди, а не сразу в работе. Запуск — отдельный шаг.
  resume(id) {
    const task = this._need(id);
    return this._set(model.transition(task, 'queued', { now: this.now() }));
  }

  // Все шаги выполнены: задача завершена. Незавершённые шаги не дают ее закрыть.
  // Задача с мандатом «завершена» только по итогу model.taskVerdict: все действия подтверждены проверкой
  // и хотя бы одно такое есть; у задачи с критериями приёмки — ещё и все критерии подтверждены проверкой.
  // Иначе — markUnverified. Итог {code, status, reason, criteria} записывается в задачу (verdict).
  complete(id) {
    const task = this._need(id);
    if (task.plan.some((s) => s.status !== 'done' && s.status !== 'skipped')) {
      throw taskError('не все шаги выполнены');
    }
    if (!model.hasMandate(task)) return this._set(model.transition(task, 'done', { now: this.now() }));
    const v = model.taskVerdict(task);
    if (v.status !== 'done') {
      throw taskError(v.modelOnly.length
        ? 'есть шаги без проверки: задача выполнена, но не проверена'
        : `«завершено» нельзя: ${v.reason}`);
    }
    return this._set({ ...model.transition(task, 'done', { now: this.now() }), verdict: model.verdictRecord(v, 'done') });
  }

  // Все шаги выполнены, но не все проверены объективно (или проверять было нечего):
  // «выполнено, но не проверено» (конечный статус). У задачи с мандатом записывается итог verdict.
  markUnverified(id) {
    const task = this._need(id);
    if (task.plan.some((s) => s.status !== 'done' && s.status !== 'skipped')) {
      throw taskError('не все шаги выполнены');
    }
    const next = model.transition(task, 'unverified', { now: this.now() });
    if (!model.hasMandate(task)) return this._set(next);
    const v = model.taskVerdict(task);
    const verdict = v.status === 'unverified'
      ? model.verdictRecord(v, 'unverified')
      : model.verdictRecord({ ...v, code: 'unverified', reason: 'отмечено «выполнено, но не проверено» вызывающим кодом, хотя проверки подтверждены' }, 'unverified');
    return this._set({ ...next, verdict });
  }

  cancel(id) {
    const task = this._need(id);
    return this._set(model.transition(task, 'cancelled', { now: this.now() }));
  }

  // Аварийный стоп: выполняющаяся или ждущая подтверждения задача уходит на паузу. Ничего не запускается.
  // Задача с мандатом «в очереди» тоже уходит на паузу: стоп не переживает перезапуск (он внутри процесса),
  // а задачу «в очереди» на диске исполнитель нового процесса взял бы сам. После паузы её запускает только
  // владелец (возобновление с подтверждением). Задачи без мандата в очереди не трогаем: их ведёт ход чата.
  // Возвращает id задач, которые остановлены.
  stopAll(reason = 'аварийный стоп') {
    const stopped = [];
    for (const task of this.list()) {
      if (task.status === 'running' || task.status === 'waiting_approval') {
        this._set(model.transition(task, 'paused', { reason, now: this.now() }));
        stopped.push(task.id);
      } else if (task.status === 'queued' && model.hasMandate(task)) {
        this._set(model.transition(task, 'paused', { reason: `${reason}: ${QUEUED_STOP_NOTE}`, now: this.now() }));
        stopped.push(task.id);
      }
    }
    return stopped;
  }
}

// Причины паузы после перезапуска приложения.
const RESTART_RUNNING_REASON = 'перезапуск приложения: проверьте состояние и запустите снова';
const RESTART_QUEUED_REASON = `перезапуск приложения: ${QUEUED_STOP_NOTE}`;

// После перезапуска приложения задача, которая выполнялась или ждала подтверждения, становится на паузу.
// Сама она не продолжается: владелец запускает её снова, а шаги без проверки состояния не повторяются.
// Задача с мандатом «в очереди» тоже уходит на паузу: старая очередь после перезапуска сама не запускается,
// и новое поручение её не подхватывает (исполнитель берёт из очереди только задачи «в очереди», а не «на паузе»).
// Продолжить такую задачу — только явное действие владельца: task_resume с подтверждением.
// Задачи без мандата в очереди не трогаем: их ведёт ход чата, сам он их не запускает.
// Задачи на паузе (в том числе поставленные туда стопом из очереди) остаются на паузе.
function recoverAfterRestart(tasks, { now = Date.now() } = {}) {
  return tasks.map((t) => {
    if (t.status === 'running' || t.status === 'waiting_approval') {
      return model.transition(t, 'paused', { reason: RESTART_RUNNING_REASON, now });
    }
    if (t.status === 'queued' && model.hasMandate(t)) {
      return model.transition(t, 'paused', { reason: RESTART_QUEUED_REASON, now });
    }
    return t;
  });
}

module.exports = { TaskQueue, recoverAfterRestart, QUEUED_STOP_NOTE, RESTART_RUNNING_REASON, RESTART_QUEUED_REASON };
