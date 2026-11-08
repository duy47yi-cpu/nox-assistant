'use strict';

// Единый контекст вызова инструмента (идея Pydantic AI): один неизменяемый набор полей прогона.
// Инструменты читают отсюда режим, заражение, фон и ход, а не собирают объект на месте;
// политика получает те же поля отдельно, как и раньше.
function makeToolContext({
  workspace = '',
  signal = null,
  mode = '',
  tainted = false,
  handsTainted = false,
  background = false,
  runId = null,
  taskId = null,
  step = null,
} = {}) {
  return Object.freeze({
    workspace: String(workspace || ''),
    signal: signal || null,
    mode: String(mode || ''),
    tainted: tainted === true,
    handsTainted: handsTainted === true,
    background: background === true,
    runId: runId === null || runId === undefined ? null : String(runId),
    taskId: taskId === null || taskId === undefined ? null : String(taskId),
    step: Number.isInteger(step) ? step : null,
  });
}

module.exports = { makeToolContext };
