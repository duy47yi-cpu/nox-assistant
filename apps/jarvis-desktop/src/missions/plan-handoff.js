'use strict';

const fs = require('fs');
const path = require('path');
const { Agent } = require('../agent/loop');
const { TurnPlans } = require('../agent/plan');
const { planTools } = require('../tools/plan');
const { ToolRegistry } = require('../tools/registry');
const { writeTarget } = require('../tools/workspace');

const WRITES = new Set(['workspace_write', 'document_write']);
const READS = new Set(['workspace_search', 'workspace_list', 'workspace_read', 'document_read', 'document_batch',
  'web_search', 'web_fetch', 'web_wiki', 'web_research', 'web_check_claims']);

function stamp(file) {
  try {
    const info = fs.lstatSync(file, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

function planReport(item) {
  const { plan, pending } = item.handoff;
  return [
    '# ' + item.goal,
    '',
    ...plan.steps.map((step, index) => `${index + 1}. ${step.status === 'done' ? 'Готово' : 'Осталось'} — ${step.text}`
      + (step.files?.length ? ` (${step.files.join(', ')})` : '')),
    ...(pending ? ['', `Нужно проверить файл: ${pending.path}`] : []),
  ].join('\n') + '\n';
}

async function runPlanHandoff({ item, signal, resolve, patch, finish, brain, stop, journal, now, policy }) {
  const { index, tools } = resolve(item.handoff.workspaceId);
  const handoff = item.handoff;
  const update = (changes) => {
    patch({ handoff: { ...handoff, ...changes } });
    Object.assign(handoff, changes);
  };
  const refresh = () => fs.writeFileSync(item.report, planReport(item), 'utf8');
  const sameFile = (a, b) => {
    const key = (file) => path.normalize(file).toLowerCase();
    return a && b && key(a) === key(b);
  };
  const store = {
    get: () => handoff.plan,
    put(plan) {
      const saved = plan.steps.some((step, i) => step.status === 'done' && handoff.plan.steps[i]?.status !== 'done' &&
        step.files?.some((file) => sameFile(file, handoff.pending?.path)));
      update({ plan, ...(saved ? { pending: null } : {}) });
      refresh();
    },
  };
  const registry = new ToolRegistry();
  const plans = new TurnPlans({ store, now, retainCompleted: true });
  for (const tool of planTools(plans)) if (tool.name !== 'plan_set') registry.register(tool);
  for (const tool of tools) {
    if (READS.has(tool.name)) registry.register(tool);
    if (WRITES.has(tool.name)) registry.register({
      ...tool,
      async run(args, ctx) {
        if (handoff.pending) return { ok: false, summary: 'сначала проверьте и закройте предыдущий шаг записи' };
        const file = path.relative(index.rootDir, writeTarget(index, args.path, null)).split(path.sep).join('/');
        const target = index.resolveInside(file);
        const before = stamp(target);
        const overwrite = args.overwrite === true && file.startsWith('reports/');
        if (before && !overwrite) return { ok: false, summary: 'в фоне можно обновлять только отчёты с явной перезаписью' };
        update({ pending: { path: file, before } });
        const out = await tool.run({ ...args, path: file, overwrite }, ctx);
        if (!out.ok && stamp(target) === before) update({ pending: null });
        return out;
      },
    });
  }

  if (handoff.plan.steps.every((step) => step.status === 'done')) {
    refresh();
    return finish('done', 'все шаги плана подтверждены');
  }
  if (handoff.pending) {
    if (stamp(writeTarget(index, handoff.pending.path, null)) !== handoff.pending.before) {
      refresh();
      return finish('needs_human', `запись прервалась около файла ${handoff.pending.path}, нужен осмотр владельцем`);
    }
    update({ pending: null });
  }
  if (signal.aborted || stop?.isStopped()) return finish('stopped', 'остановлено владельцем');
  if (now().getTime() >= Date.parse(item.deadline)) return finish('deadline', 'срок поручения истёк');
  const agent = new Agent({
    brain, tools: registry, plans, chatId: handoff.chatId, workspaceId: handoff.workspaceId,
    workspace: index.rootDir, background: true, stop, journal, maxSteps: 30,
    turnDeadlineMs: Math.min(240000, Date.parse(item.deadline) - now().getTime()),
    policy,
    systemPrompt: 'Продолжай существующий план. Уже подтверждённые шаги не повторяй. Для каждого нового результата выполняй только один шаг и закрывай его через plan_done. Доступны поиск, создание файлов и явная перезапись в reports. Если нужен пользователь, управление окнами или отправка, остановись через turn_stop. Итог определяет сохранённый план.',
  });
  const cancel = () => agent.stop();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const left = Date.parse(item.deadline) - now().getTime();
      if (signal.aborted || stop?.isStopped() || left <= 0) break;
      const before = handoff.plan.steps.filter((step) => step.status === 'done').length;
      agent.turnDeadlineMs = Math.min(240000, left);
      await agent.run('Продолжай');
      const after = handoff.plan.steps.filter((step) => step.status === 'done').length;
      if (handoff.pending || after <= before || after === handoff.plan.steps.length) break;
    }
  } finally { signal.removeEventListener('abort', cancel); }
  refresh();
  if (handoff.plan.steps.every((step) => step.status === 'done')) return finish('done', 'все шаги плана подтверждены');
  if (signal.aborted || stop?.isStopped()) return finish('stopped', 'остановлено владельцем');
  if (handoff.pending) return finish('needs_human', `нужно проверить результат записи ${handoff.pending.path}`);
  if (now().getTime() >= Date.parse(item.deadline)) return finish('deadline', 'срок поручения истёк');
  return finish('needs_human', 'часть плана осталась открытой и требует решения владельца');
}

module.exports = { planReport, runPlanHandoff };
