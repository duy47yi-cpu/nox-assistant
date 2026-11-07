'use strict';

// Навыки Джарвиса: папка skills/<имя>/SKILL.md. Формат как у Claude Code: шапка с name и description,
// дальше текст инструкции. Имя папки должно совпадать с name. Пользовательские навыки в data/skills
// перекрывают встроенные.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_BODY = 6000;

// Разбирает SKILL.md. Нет шапки или неверное имя — null.
function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const name = meta.name || '';
  if (!NAME_RE.test(name) || !meta.description) return null;
  return { name, description: meta.description.slice(0, 300), body: m[2].trim().slice(0, MAX_BODY) };
}

// Читает все навыки из папок. Папка без корректного SKILL.md или с другим именем пропускается.
function readSkillsDir(dir, into) {
  let entries = [];
  try {
    const root = fs.lstatSync(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) return into;
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return into;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const folder = path.join(dir, e.name);
      const folderStat = fs.lstatSync(folder);
      const file = path.join(folder, 'SKILL.md');
      const fileStat = fs.lstatSync(file);
      if (!folderStat.isDirectory() || folderStat.isSymbolicLink() || !fileStat.isFile() || fileStat.isSymbolicLink()) continue;
      const skill = parseSkill(fs.readFileSync(file, 'utf8'));
      if (skill && skill.name === e.name) into.set(skill.name, skill);
    } catch {
      // Файла нет или он не читается: навык пропускаем.
    }
  }
  return into;
}

// Встроенные навыки, затем пользовательские (они перекрывают встроенные с тем же именем).
function loadSkills(...dirs) {
  const skills = new Map();
  for (const dir of dirs) readSkillsDir(dir, skills);
  return skills;
}

module.exports = { parseSkill, loadSkills, NAME_RE, MAX_BODY };
