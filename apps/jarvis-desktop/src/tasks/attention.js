'use strict';

// Полоса «нужно внимание» в окне: какие задачи показать и как скрыть строку.
// Только отображение: задача, её статус, отчёт и данные не меняются и не удаляются.
// Скрытая строка появится снова, когда у задачи сменились статус или время последнего изменения.
const fs = require('fs');
const path = require('path');

const ATTENTION_STATUSES = ['blocked', 'paused', 'waiting_approval', 'unverified'];
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function isTaskId(id) {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

// Путь к отчёту строится из проверенного id внутри папки отчётов. Нет файла — null.
function reportPathFor(reportsDir, taskId) {
  if (!isTaskId(taskId)) return null;
  const file = path.join(reportsDir, `task-${taskId}.md`);
  return fs.existsSync(file) ? file : null;
}

// Битый или отсутствующий файл скрытых строк — ничего не скрыто (показываем лишнее, но не теряем задачи).
function readHidden(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeHidden(file, map) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function isHidden(hidden, task) {
  const entry = hidden[task.id];
  return Boolean(entry) && entry.status === task.status && entry.updatedAt === (task.updatedAt || null);
}

// Строки для окна: только задачи, которым нужно внимание, и не скрытые в своём текущем состоянии.
function attentionRows(tasks, hidden, reportsDir) {
  return tasks
    .filter((task) => ATTENTION_STATUSES.includes(task.status))
    .filter((task) => !isHidden(hidden, task))
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      reason: task.reason || '',
      updatedAt: task.updatedAt || null,
      report: typeof reportsDir === 'function' ? reportsDir(task) : reportPathFor(reportsDir, task.id),
      verdict: task.verdict && typeof task.verdict === 'object' ? { code: task.verdict.code || null, reason: task.verdict.reason || '' } : null,
    }));
}

// Новая карта скрытых строк с добавленной задачей. Исходную карту не меняем.
function withHidden(hidden, task) {
  return { ...hidden, [task.id]: { status: task.status, updatedAt: task.updatedAt || null } };
}

module.exports = { ATTENTION_STATUSES, isTaskId, reportPathFor, readHidden, writeHidden, attentionRows, withHidden };
