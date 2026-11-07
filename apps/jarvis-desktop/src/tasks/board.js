'use strict';

const STATUS_WORDS = {
  done: 'готово',
  blocked: 'заблокирована',
  paused: 'на паузе',
  running: 'в работе',
  waiting_approval: 'ждёт подтверждения',
  queued: 'в очереди',
  unverified: 'выполнено, не проверено',
  cancelled: 'отменена',
};

const ACTIVE_STATUSES = new Set(['running', 'waiting_approval']);
const ERROR_STATUSES = new Set(['blocked', 'cancelled']);
const REPORT_STATUSES = new Set(['done', 'unverified']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function attentionFor(attention, id) {
  if (!Array.isArray(attention)) return [];
  return attention.filter((entry) => entry && typeof entry === 'object'
    && String(entry.taskId ?? entry.id ?? '') === id);
}

function rowOf(task, { attention = [], now = Date.now() } = {}) {
  // Некорректные записи превращаем в пустую задачу: сводка должна пережить повреждённый элемент.
  const source = task && typeof task === 'object' && !Array.isArray(task) ? task : {};
  const id = source.id == null ? '' : String(source.id);
  const status = source.status == null ? '' : String(source.status);
  const related = attentionFor(attention, id);
  const directReport = nonEmptyString(source.report);
  const attentionReport = related.map((entry) => nonEmptyString(entry.report) || nonEmptyString(entry.reportPath)).find(Boolean) || null;
  const reportPath = directReport || attentionReport;
  const reportReady = REPORT_STATUSES.has(status) && Boolean(reportPath);
  const reason = nonEmptyString(source.reason);
  const active = ACTIVE_STATUSES.has(status);
  const error = ERROR_STATUSES.has(status) || (!REPORT_STATUSES.has(status) && Boolean(reason));
  const updatedAt = Number.isFinite(source.updatedAt) ? source.updatedAt : null;
  // now предусмотрен API для будущих вычислений возраста; строка не подменяет отсутствующие данные текущим временем.
  void now;

  return {
    id,
    title: source.title == null ? '' : String(source.title),
    status,
    statusHuman: Object.prototype.hasOwnProperty.call(STATUS_WORDS, status) ? STATUS_WORDS[status] : status,
    reason: reason ? reason.slice(0, 300) : null,
    reportReady,
    active,
    error,
    updatedAt,
  };
}

function boardRows(tasks, opts) {
  if (!Array.isArray(tasks)) return [];
  const priority = (row) => row.active ? 0 : row.error ? 1 : row.reportReady ? 2 : 3;
  return tasks.map((task) => rowOf(task, opts))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => priority(a.row) - priority(b.row)
      || (b.row.updatedAt ?? -Infinity) - (a.row.updatedAt ?? -Infinity)
      || a.index - b.index)
    .map(({ row }) => row);
}

function boardSummary(rows) {
  // Некорректные элементы не считаем ни в total, ни в категориях: иначе «всего» расходится с суммой.
  const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object');
  const summary = { total: safeRows.length, working: 0, queued: 0, errors: 0, ready: 0, line: '' };
  for (const row of safeRows) {
    if (row.active === true) summary.working += 1;
    if (row.status === 'queued') summary.queued += 1;
    if (row.error === true) summary.errors += 1;
    if (row.reportReady === true) summary.ready += 1;
  }
  summary.line = summary.total === 0
    ? 'задач нет'
    : `в работе ${summary.working}, в очереди ${summary.queued}, ошибок ${summary.errors}, готово ${summary.ready}`;
  return summary;
}

module.exports = { boardRows, boardSummary, STATUS_WORDS, rowOf };


