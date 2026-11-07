'use strict';

// Планировщик фоновых задач: раз в intervalMs берёт созревшие задачи и запускает их по одной.
const { runMission, checkExpected } = require('./runner');

const VERDICT_TITLE = {
  failed: 'Джарвис: задача не выполнена',
  blocked_desktop: 'Джарвис: рабочий стол был занят, задача не выполнена',
  unverified: 'Джарвис: отчёт готов, результат не проверен',
  stopped: 'Джарвис: задача прервана',
};

class MissionScheduler {
  constructor({ store, run, notify, now = () => new Date(), intervalMs = 60000, stop = null, probe = null } = {}) {
    if (!store || typeof store.due !== 'function') throw new Error('MissionScheduler: нужен MissionStore');
    if (typeof run !== 'function') throw new Error('MissionScheduler: нужна функция run');
    this.store = store;
    this.run = run; // run(mission) → Promise<{report, file}>
    this.notify = notify || (() => {});
    this.now = now;
    this.intervalMs = intervalMs;
    this.stopSwitch = stop; // StopSwitch: при стопе новые задачи не стартуют
    this.probe = probe; // чтение настоящего состояния для сверки
    this._timer = null;
    this._busy = false;
  }

  _stopped() {
    return Boolean(this.stopSwitch && this.stopSwitch.isStopped());
  }

  // Запускает созревшие задачи последовательно. Возвращает число выполненных.
  async tick() {
    if (this._busy) return 0;
    if (this._stopped()) return 0;
    this._busy = true;
    let done = 0;
    try {
      await this._starting; // сначала сверка прерванных, иначе новая отметка «идёт» смешается со старой
      // Устаревшие daily сдвигаются до выборки созревших; due() после этого только читает.
      if (typeof this.store.skipStale === 'function') this.store.skipStale(this.now());
      for (const mission of this.store.due(this.now())) {
        // Стоп мог прийти во время предыдущей задачи: следующие не стартуют и остаются созревшими.
        if (this._stopped()) break;
        let result;
        // Пока шла предыдущая задача, эту могли отменить или выключить.
        const started = this.store.markStart(mission.id, { now: this.now() });
        if (started === null || (started && started.enabled === false)) continue;
        try {
          const out = await this.run(mission);
          result = out.report;
          if (this._stopped()) {
            // Стоп пришёл во время задачи: она прервана. Помечаем как прерванную, чтобы после возобновления
            // не запустилась сама (см. P0: возобновление не повторяет прерванное).
            this.store.markRun(mission.id, { now: this.now(), result: `прервано аварийным стопом: ${result.slice(0, 1500)}`, verdict: 'stopped' });
            this._notify(mission, { title: 'Джарвис: задача прервана стопом', body: mission.goal ? String(mission.goal).slice(0, 200) : '' });
            done += 1;
            break;
          }
          this.store.markRun(mission.id, { now: this.now(), result: result.slice(0, 2000), verdict: out.verdict });
          this._notify(mission, { title: VERDICT_TITLE[out.verdict] || 'Джарвис: задача выполнена', body: result.slice(0, 200), file: out.file });
        } catch (err) {
          result = `ошибка: ${err && err.message ? err.message : err}`;
          this.store.markRun(mission.id, { now: this.now(), result, verdict: 'failed' });
          this._notify(mission, { title: 'Джарвис: задача не выполнена', body: result.slice(0, 200) });
        }
        done += 1;
      }
    } finally {
      this._busy = false;
    }
    return done;
  }

  // После падения: сверяем с настоящим состоянием и сообщаем. Сами не повторяем: часть действий могла уже пройти.
  async reconcile() {
    for (const mission of this.store.interrupted()) {
      const check = await checkExpected(mission.expect, (spec, since) => this.probe(spec, since, mission), mission.runStartedAt);
      const verdict = check.met === true ? 'done' : 'interrupted';
      const result = check.met === true
        ? `запуск оборвался, но результат на месте (${check.evidence})`
        : `запуск оборвался, повтора не было. ${check.evidence}`;
      this.store.closeInterrupted(mission.id, { now: this.now(), result, verdict });
      if (verdict === 'interrupted') this._notify(mission, { title: 'Джарвис: задача оборвалась', body: `${String(mission.goal).slice(0, 120)}. ${check.evidence}` });
    }
  }

  start() {
    if (this._timer) return;
    this._starting = this.reconcile().catch((err) => console.error(`сверка задач: ${err && err.message ? err.message : err}`));
    this._background();
    this._timer = setInterval(() => this._background(), this.intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _background() {
    this.tick().catch((err) => console.error(`задачи: ${err && err.message ? err.message : err}`));
  }

  _safeNotify(payload) {
    try {
      this.notify(payload);
    } catch (err) {
      console.error(`уведомление о задаче: ${err && err.message ? err.message : err}`);
    }
  }

  _notify(mission, payload) {
    this._safeNotify({ ...payload, workspaceId: mission && mission.workspaceId ? mission.workspaceId : 'default' });
  }
}

module.exports = { MissionScheduler, runMission };
