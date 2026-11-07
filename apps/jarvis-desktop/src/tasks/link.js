'use strict';

// Связь подтверждений с задачами чата: пока выполняющаяся задача ждёт вашего решения, её статус «ждёт подтверждения».
// Вызывается из main.js при запросе подтверждения и при ответе. Возвращает true, если статус задачи изменился.
//
// Задачи с мандатом (t.mandate) здесь пропускаются: их подтверждения ведёт сам исполнитель (executor.js) —
// ставит «ждёт подтверждения» перед своим запросом и снимает после ответа. Иначе запрос подтверждения из чата
// во время работы исполнителя перевёл бы его задачу в «ждёт подтверждения», и исполнитель остановил бы её,
// а ответ на чужой запрос снял бы статус с задачи, которая ещё ждёт своего.
const { hasMandate } = require('./model');

const isChatTask = (t) => !hasMandate(t);

function requestedApproval(queue) {
  const running = queue.list().find((t) => t.status === 'running' && isChatTask(t));
  if (!running) return false;
  queue.waitApproval(running.id);
  return true;
}

function resolvedApproval(queue) {
  const waiting = queue.list().find((t) => t.status === 'waiting_approval' && isChatTask(t));
  if (!waiting) return false;
  queue.resolveApproval(waiting.id);
  return true;
}

module.exports = { requestedApproval, resolvedApproval };
