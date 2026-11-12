'use strict';

// План хода: шаги, которые модель назвала сама, и их закрытие с доказательством.
// План живёт в памяти процесса по ключу хода (runId) и не пишется на диск: это часть одного
// разговора, а не обещание на будущее (для долгих целей есть src/goals/store.js).
const MAX_STEPS = 20;
const MAX_TEXT = 300;
const MAX_EVIDENCE = 500;
const MAX_PLANS = 20;
// Слова трёх честных остановок: их показывает и инструмент, и сам агент.
const STOP_WORDS = { impossible: 'Невозможно', needs_human: 'Нужен человек', unsure: 'Не уверен в результате' };

function cleanText(value, max, label) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`${label}: пусто`);
  if (text.length > max) throw new Error(`${label}: не больше ${max} символов`);
  return text;
}

class TurnPlans {
  constructor({ maxPlans = MAX_PLANS } = {}) {
    this.maxPlans = Math.max(1, Number(maxPlans) || MAX_PLANS);
    this.byRun = new Map();
  }

  _key(runId) {
    const key = String(runId || '').trim();
    if (!key) throw new Error('план доступен только внутри хода');
    return key;
  }

  set(runId, steps) {
    const list = Array.isArray(steps) ? steps : [];
    if (!list.length) throw new Error('план: нужен хотя бы один шаг');
    if (list.length > MAX_STEPS) throw new Error(`план: не больше ${MAX_STEPS} шагов`);
    const clean = list.map((item, i) => {
      const raw = typeof item === 'string' ? item : item && item.text;
      return { id: `s${i + 1}`, text: cleanText(raw, MAX_TEXT, `шаг ${i + 1}`), status: 'pending', evidence: null, doneAt: null };
    });
    const key = this._key(runId);
    const plan = { runId: key, steps: clean, createdAt: new Date().toISOString() };
    this.byRun.set(key, plan);
    while (this.byRun.size > this.maxPlans) this.byRun.delete(this.byRun.keys().next().value);
    return copyPlan(plan);
  }

  // «Продолжай»: тот же план переходит в новый ход. Закрытые шаги остаются закрытыми.
  seed(runId, previous) {
    const source = previous && Array.isArray(previous.steps) ? previous.steps : [];
    if (!source.length) throw new Error('план: нужен хотя бы один шаг');
    const key = this._key(runId);
    const plan = {
      runId: key,
      steps: source.map((s, i) => ({
        id: `s${i + 1}`,
        text: String(s.text || '').slice(0, MAX_TEXT),
        status: s.status === 'done' ? 'done' : 'pending',
        evidence: s.status === 'done' ? s.evidence || null : null,
        doneAt: s.status === 'done' ? s.doneAt || null : null,
      })),
      createdAt: new Date().toISOString(),
    };
    this.byRun.set(key, plan);
    while (this.byRun.size > this.maxPlans) this.byRun.delete(this.byRun.keys().next().value);
    return copyPlan(plan);
  }

  done(runId, step, evidence) {
    const key = this._key(runId);
    const plan = this.byRun.get(key);
    if (!plan) throw new Error('план не задан: сначала plan_set');
    const index = Number(step);
    if (!Number.isInteger(index) || index < 1 || index > plan.steps.length) {
      throw new Error(`шага ${step} нет: всего ${plan.steps.length}`);
    }
    const clean = cleanText(evidence, MAX_EVIDENCE, 'доказательство');
    const target = plan.steps[index - 1];
    target.status = 'done';
    target.evidence = clean;
    target.doneAt = new Date().toISOString();
    return copyPlan(plan);
  }

  get(runId) {
    const plan = this.byRun.get(String(runId || ''));
    return plan ? copyPlan(plan) : null;
  }

  // Сколько шагов закрыто и какие остались. Осталось — то, что ещё не сделано.
  summary(plan) {
    const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
    const done = steps.filter((s) => s.status === 'done').length;
    return {
      total: steps.length,
      done,
      unfinished: steps.length - done,
      left: steps.map((s, i) => ({ step: i + 1, status: s.status, text: s.text })).filter((s) => s.status !== 'done'),
    };
  }
}

function copyPlan(plan) {
  return { ...plan, steps: plan.steps.map((s) => ({ ...s })) };
}

// Строка для ответа: что осталось. Код дописывает её сам, чтобы «готово» не прятало незакрытое.
function planNote(summary, { maxItems = 3, maxText = 80 } = {}) {
  const left = summary && Array.isArray(summary.left) ? summary.left : [];
  if (!left.length) return '';
  const shown = left.slice(0, maxItems).map((item) => `шаг ${item.step} — ${String(item.text).slice(0, maxText)}`);
  const more = left.length > maxItems ? `; ещё ${left.length - maxItems}` : '';
  return `Не закрыто: ${shown.join('; ')}${more}`;
}

// Памятка для «продолжай»: весь план с состоянием шагов, чтобы модель не начинала заново.
function planBrief(plan, { maxItems = 10, maxText = 120 } = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) return '';
  const lines = steps.slice(0, maxItems).map((s, i) => {
    const state = s.status === 'done' ? `сделано${s.evidence ? ` (${String(s.evidence).slice(0, 60)})` : ''}` : 'осталось';
    return `${i + 1}) ${String(s.text).slice(0, maxText)} — ${state}`;
  });
  return ['План прошлого хода, продолжай с незакрытого:', ...lines].join('\n');
}

module.exports = { TurnPlans, planNote, planBrief, STOP_WORDS, MAX_STEPS, MAX_TEXT, MAX_EVIDENCE };
