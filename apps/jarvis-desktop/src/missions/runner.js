'use strict';

// Фоновая задача без владельца: отдельный агент, своя история, отчёт в файл.
// Подтверждений здесь нет: всё, что требует спросить (T2, T3, T1 вне рабочей папки),
// отклоняется сразу. Задача может читать и делать обратимые действия в рабочей папке.
const fs = require('fs');
const path = require('path');
const { Agent } = require('../agent/loop');
const modes = require('../policy/modes');
const { withClock } = require('../agent/prompt');
const { backgroundBrief } = require('../memory/store');
const { BLOCKED_DESKTOP } = require('../control/desktop-lock');

const AUTONOMOUS_PROMPT = [
  'Ты — Джарвис, работаешь в фоне без владельца. Выполни задачу ниже самостоятельно.',
  'Используй инструменты, если они нужны.',
  'Действия, которым нужно подтверждение владельца (внешние, необратимые, вне рабочей папки), будут отклонены. Не пытайся их обойти.',
  'В конце дай короткий отчёт по-русски: что сделано, что найдено, что требует решения владельца. Не выдумывай результаты.',
].join('\n');

// В фоне подтверждений нет: любой запрос сразу получает отказ.
const rejectAll = {
  request: async () => 'reject',
  respond: () => false,
};

const MISSION_MAX_STEPS = 30;
const MISSION_MAX_MINUTES = 30;

function reportFileName(mission, startedAt) {
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${mission.id}.md`;
}

// Сверка с настоящим состоянием: решает чтение, а не слова модели.
// probe(ожидание) → true, false или null, если прочитать не удалось.
async function checkExpected(expect, probe, since = null) {
  const list = Array.isArray(expect) ? expect : [];
  if (list.length === 0) return { met: null, evidence: 'ожидаемый результат не задан' };
  if (typeof probe !== 'function') return { met: null, evidence: 'проверить результат нечем' };
  let unknown = false;
  for (const item of list) {
    let seen = null;
    try {
      seen = await probe(item, since);
    } catch {
      seen = null;
    }
    const want = item.until !== 'gone';
    if (seen === null) unknown = true;
    else if (seen !== want) return { met: false, evidence: `не выполнено: ${item.kind} «${item.target}»` };
  }
  return unknown ? { met: null, evidence: 'часть условий прочитать не удалось' } : { met: true, evidence: `подтверждено условий: ${list.length}` };
}

// Итог задачи для расписания. ok-ход без подтверждения — это unverified, а не done.
function missionVerdict({ outcome, blockedDesktop, check }) {
  if (blockedDesktop) return BLOCKED_DESKTOP;
  if (outcome !== 'answer') return outcome === 'stopped' ? 'stopped' : 'failed';
  if (check.met === false) return 'failed';
  return check.met === true ? 'done' : 'unverified';
}

// Запускает задачу и возвращает {report, file, verdict}. Ошибки агента попадают в отчёт, не наружу.
async function runMission(mission, { brain, tools, journal, workspace, reportsDir, now = () => new Date(), stop = null, probe = null, mode = 'auto', memory = null }) {
  const startedAt = now();
  // Память фона: профиль и заметки к цели. Без store (тесты, старые вызовы) блока нет.
  const brief = backgroundBrief(memory, mission.goal);
  const limits = mission.limits || {};
  const tagged = {
    append: (entry) => journal.append({ ...entry, source: 'mission', mission: mission.id }),
  };
  const texts = [];
  let blockedDesktop = false;
  const agent = new Agent({
    brain,
    tools,
    stop,
    policy: modes,
    approvals: rejectAll,
    journal: tagged,
    emit: (e) => {
      if (e.type === 'text') texts.push(e.delta);
      if (e.type === 'error') texts.push(`[ошибка] ${e.message}`);
      if (e.type === 'tool_result' && String(e.summary || '').startsWith(BLOCKED_DESKTOP)) blockedDesktop = true;
    },
    // Режим владельца: в «Полном доступе» фон работает без вопросов, в остальных — по общим правилам.
    mode,
    workspace,
    background: true,
    // Фон по умолчанию на «Быстрой» с низким мышлением: «Умная» и «высокое» съедают лимит в разы быстрее.
    tier: mission.tier === 'smart' ? 'smart' : 'fast',
    thinking: 'low',
    // Утренний брифинг за 12 шагов не укладывался (см. missions.json: «лимит шагов»). Фоновой задаче шагов нужно больше.
    maxSteps: limits.maxSteps || MISSION_MAX_STEPS,
    systemPrompt: withClock(AUTONOMOUS_PROMPT, now, brief),
  });

  const maxMinutes = limits.maxMinutes || MISSION_MAX_MINUTES;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; agent.stop(); }, maxMinutes * 60000);
  if (timer.unref) timer.unref();
  let outcome;
  try {
    ({ outcome } = await agent.run(`Задача: ${mission.goal}`));
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    outcome = 'limit';
    texts.push(`\n[срок ${maxMinutes} мин истёк, задача прервана]`);
  }

  const check = await checkExpected(mission.expect, probe, startedAt);
  const verdict = missionVerdict({ outcome, blockedDesktop, check });
  const report = texts.join('').trim() || '(пустой отчёт)';
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, reportFileName(mission, startedAt));
  fs.writeFileSync(file, `# ${mission.goal}\n\nЗапуск: ${startedAt.toISOString()}\nИтог: ${verdict}. ${check.evidence}\n\n${report}\n`, 'utf8');
  const error = agent.lastError || (verdict === 'failed' && check.met === false ? check.evidence : undefined) || (verdict === BLOCKED_DESKTOP ? 'рабочий стол был занят или заблокирован' : undefined);
  return { report, file, outcome, verdict, evidence: check.evidence, error };
}

module.exports = { runMission, checkExpected, missionVerdict, AUTONOMOUS_PROMPT };
