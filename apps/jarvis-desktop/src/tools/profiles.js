'use strict';

// Наборы инструментов по контексту. Автономные задачи (фон, миссии, команды) получают не всё.
//
// shell_run не ограничен папками: PowerShell может обратиться куда угодно, а границу песочницы
// задать для него нельзя. library_run и команды библиотеки (lib_*) запускают скрипты, которые
// ходят по домашнему каталогу. Поэтому всё это выключено в автономных задачах.
// В чате shell_run и library_run доступны только с подтверждением каждого вызова (см. policy/modes.js).
// project_run запускает команды, которые определены файлами самого проекта (npm test и подобные):
// это исполнение чужого кода, а владельца рядом в фоне нет. Поэтому он тоже выключен в автономных
// задачах; в чате project_run работает по обычной политике риска T2 (см. policy/modes.js).
const AUTONOMY_EXCLUDED = ['shell_run', 'library_run', 'project_run'];
const AUTONOMY_EXCLUDED_PREFIXES = ['lib_'];

function excludedFromAutonomy(name) {
  return AUTONOMY_EXCLUDED.includes(name) || AUTONOMY_EXCLUDED_PREFIXES.some((p) => String(name).startsWith(p));
}

function autonomousTools(list) {
  return list.filter((tool) => !excludedFromAutonomy(tool.name));
}

// Файловые инструменты (workspace_*, document_*, project_*) берём из своего индекса, а не из общего:
// общий в «Полном доступе» не ограничен, а автономная работа должна оставаться в песочнице.
// ownWorkspaceTools — инструменты от индекса, который всегда внутри рабочей папки.
const FILE_TOOL = /^(workspace|document|project|code)_/;

function withOwnWorkspace(list, ownWorkspaceTools) {
  return [...list.filter((tool) => !FILE_TOOL.test(String(tool.name))), ...ownWorkspaceTools];
}

function taskRegistryFor(shared, ownWorkspaceTools, taskCodeTools) {
  return {
    get(name) {
      const own = [...ownWorkspaceTools, ...taskCodeTools].find((tool) => tool.name === name);
      return own || (FILE_TOOL.test(String(name)) ? null : shared.get(name)) || null;
    },
    list: () => [...withOwnWorkspace(shared.list(), ownWorkspaceTools), ...taskCodeTools],
  };
}

module.exports = { autonomousTools, withOwnWorkspace, taskRegistryFor, AUTONOMY_EXCLUDED, excludedFromAutonomy };
