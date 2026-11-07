'use strict';

// Опыт: после удачного хода записываем порядок инструментов в навык (data/skills/auto-<хеш>/SKILL.md).
// В навык идут слова владельца, имена инструментов и некоторые цели действий, прямо названные владельцем.
// Тексты ввода, содержимое окон, координаты и временные идентификаторы не сохраняются.
// Навык — подсказка для модели, а не готовая команда: повтор всё равно идёт через проверки и политику.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { NAME_RE, parseSkill, MAX_BODY } = require('./index');
const { looksSecret } = require('../memory/store');

const MAX_STEPS = 12;
const MAX_AUTO = 80;
const MAX_DESC = 160;
// Эти шаги не превращаем в навык: отправка, удаление, оплата, установка, команды и сырой PowerShell.
const FORBIDDEN = new Set([
  'shell_run', 'mail_send', 'remember', 'forget', 'clipboard_set', 'clipboard_get',
  'windows_close_all', 'pc_shutdown', 'app_install', 'command_create', 'command_run',
  'long_task_start', 'task_create', 'task_submit', 'mission_create',
]);
// Только чтение — это не порядок действий, а разовый запрос. Такой ход навыком не становится.
const READ_ONLY = new Set([
  'web_search', 'web_fetch', 'web_wiki', 'web_research', 'weather_now', 'recall', 'memory_about',
  'skills_list', 'skill_read', 'disk_free_space', 'disk_cleanup_suggest',
  'windows_list', 'ui_elements', 'ui_windows', 'desktop_observe', 'screen_look',
  'image_read_text', 'document_read', 'workspace_read', 'workspace_search', 'workspace_list', 'project_brief', 'project_diagnostics',
]);

function normalizePhrase(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function hashOf(text) {
  return crypto.createHash('sha1').update(normalizePhrase(text), 'utf8').digest('hex').slice(0, 8);
}

// История агента: только текущий ход, начиная с последнего сообщения владельца (не из инструмента).
function currentTurn(history) {
  const list = Array.isArray(history) ? history : [];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m && m.role === 'user' && !m.fromTool) {
      start = i;
      break;
    }
  }
  return list.slice(start);
}

function toolResults(history) {
  const results = new Map();
  for (const m of currentTurn(history)) {
    if (!m || m.role !== 'tool' || typeof m.tool_call_id !== 'string') continue;
    try {
      const result = JSON.parse(String(m.content || ''));
      if (result && typeof result === 'object' && !Array.isArray(result)) results.set(m.tool_call_id, result);
    } catch {
      // Повреждённый или неполный ответ инструмента делает ход непригодным для обучения.
    }
  }
  return results;
}

// Учим только на действиях, которые прошли свою независимую verify. Для чтения достаточно ok:true.
function turnActionsVerified(history) {
  const turn = currentTurn(history);
  const results = toolResults(history);
  let count = 0;
  for (const m of turn) {
    if (!m || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const name = call && call.function && call.function.name;
      if (typeof name !== 'string' || !name) continue;
      count += 1;
      const result = results.get(call.id);
      if (!result || result.ok !== true) return false;
      if (!READ_ONLY.has(name) && result.verified !== 'confirmed') return false;
    }
  }
  return count > 0;
}

// Точная совпавшая просьба: отдаём короткую подсказку в уже существующий контекст хода,
// не заставляя модель тратить отдельные вызовы на skills_list и skill_read.
function skillHintForTurn(skills, phrase) {
  const goal = normalizePhrase(phrase);
  if (!goal || looksSecret(goal) || !(skills instanceof Map)) return '';
  const skill = skills.get(`auto-${hashOf(goal)}`);
  if (!skill || typeof skill.body !== 'string' || !skill.body) return '';
  // Защита от даже теоретической коллизии короткого хеша: в теле должен быть тот же запрос.
  if (!skill.body.startsWith(`Когда владелец просит: «${goal}»`)) return '';
  return `Подсказка из успешного опыта для этой точной просьбы:\n${skill.body}`.slice(0, MAX_BODY + 120);
}

function toolCalls(history) {
  const calls = [];
  for (const m of currentTurn(history)) {
    if (!m || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const name = call && call.function && call.function.name;
      if (typeof name !== 'string' || !name) continue;
      calls.push(call);
    }
  }
  return calls;
}

// Повторные вызовы — отдельные действия, в том числе два нажатия одной кнопки.
function toolSteps(history) {
  return toolCalls(history).map((call) => call.function.name);
}

// Сохраняем только цель, прямо названную владельцем. Подпись desktop_click берём
// из уже подтверждённого результата; id, координаты, значения полей и заголовки окон не копируем.
function explicitTarget(call, goal, results) {
  const name = call.function.name;
  let target = '';
  if (['app_open', 'ui_click'].includes(name)) {
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return ''; }
    target = args && args.name;
  } else if (name === 'desktop_click') {
    const result = results && results.get(call.id);
    target = result && result.verified === 'confirmed' && result.data && result.data.element
      ? result.data.element.name
      : '';
  } else {
    return '';
  }
  if (typeof target !== 'string' || target !== target.trim() || target.length < 2 || target.length > 80
      || /[\\/:\x00-\x1f]/.test(target) || looksSecret(target)
      || !goal.toLocaleLowerCase().includes(target.toLocaleLowerCase())) return '';
  return ` (цель из просьбы: ${JSON.stringify(target)})`;
}

function buildSkill({ phrase, history, outcome } = {}) {
  if (outcome !== 'answer') return null;
  const goal = normalizePhrase(phrase);
  if (!goal) return null;
  // Не учимся на ответе модели: каждый инструмент должен завершиться без отказа,
  // а у действия должна быть независимая проверка эффекта.
  if (!turnActionsVerified(history)) return null;
  // В описании навыка повторяется просьба: секреты в неё не пускаем.
  if (looksSecret(goal)) return null;
  const turn = currentTurn(history);
  // Параллельные вызовы не задают последовательный порядок. Половина длинного хода — тоже не навык.
  if (turn.some((m) => m && Array.isArray(m.tool_calls) && m.tool_calls.length > 1)) return null;
  const calls = toolCalls(history);
  const steps = calls.map((call) => call.function.name);
  if (steps.length < 2 || steps.length > MAX_STEPS) return null;
  if (steps.every((name) => READ_ONLY.has(name))) return null;
  if (steps.some((name) => FORBIDDEN.has(name))) return null;
  const hash = hashOf(goal);
  const description = goal.slice(0, MAX_DESC).replace(/[\r\n]+/g, ' ');
  const results = toolResults(history);
  const lines = calls.map((call, i) => `${i + 1}. ${call.function.name}${explicitTarget(call, goal, results)}`);
  const body = [
    `Когда владелец просит: «${goal}»`,
    '',
    `Проверенный порядок (${steps.length} шагов):`,
    ...lines,
    '',
    'Повторяй по одному шагу, сверяя результат. Если окно или данные отличаются — не копируй вслепую: сначала прочитай состояние.',
    'Кроме явно названных в просьбе целей аргументы и текст не сохранены: возьми их из текущей просьбы.',
  ].join('\n').slice(0, MAX_BODY);
  return { name: `auto-${hash}`, description, body, hash, steps };
}

function atomicWrite(file, text) {
  const folder = path.dirname(file);
  const root = path.dirname(folder);
  try { fs.mkdirSync(root); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('папка навыков недоступна');
  try { fs.mkdirSync(folder); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const folderStat = fs.lstatSync(folder);
  if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) throw new Error('папка навыка недоступна');
  const tmp = path.join(folder, `.SKILL.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function autoSkillCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^auto-[0-9a-f]{8}$/.test(e.name)).length;
  } catch {
    return 0;
  }
}

// Возвращает {written, skill} или {written:false, reason}. Никогда не бросает: опыт не должен ломать ход.
function learnSkillFromTurn({ dir, phrase, history, outcome, max = MAX_AUTO } = {}) {
  try {
    const skill = buildSkill({ phrase, history, outcome });
    if (!skill) return { written: false, reason: 'нечего запоминать' };
    if (!dir) return { written: false, reason: 'нет папки навыков' };
    if (!NAME_RE.test(skill.name)) return { written: false, reason: 'плохое имя' };
    if (autoSkillCount(dir) >= max) return { written: false, reason: 'достаточно навыков' };
    const file = path.join(dir, skill.name, 'SKILL.md');
    try { fs.lstatSync(file); return { written: false, reason: 'уже есть' }; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const text = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`;
    const parsed = parseSkill(text);
    if (!parsed) return { written: false, reason: 'навык не разобрался' };
    atomicWrite(file, text);
    return { written: true, skill: parsed, file };
  } catch (err) {
    return { written: false, reason: err && err.message ? err.message : String(err) };
  }
}

module.exports = { buildSkill, learnSkillFromTurn, toolSteps, toolResults, turnActionsVerified, skillHintForTurn, currentTurn, hashOf, FORBIDDEN, MAX_AUTO };
