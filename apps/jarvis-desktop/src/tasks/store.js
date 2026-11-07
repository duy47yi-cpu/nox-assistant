'use strict';

// Хранилище задач: один JSON-файл, запись через временный файл и переименование (атомарно).
// Состояние задач — не Markdown: это машинные данные (JARVIS-DECISIONS J-4). SQLite — позже, в P3.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Файл без списка tasks повреждён: пустой список поверх него при следующей записи стёр бы задачи,
// поэтому здесь ошибка, а не []. Вызывающий код откладывает такой файл как <файл>.corrupt-<время>.
function readTasks(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  if (!data || !Array.isArray(data.tasks)) throw new Error('файл задач повреждён: нет списка tasks');
  return data.tasks;
}

function writeTasks(file, tasks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { readTasks, writeTasks };
