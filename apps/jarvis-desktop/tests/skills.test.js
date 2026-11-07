'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSkill, loadSkills, MAX_BODY } = require('../src/skills');
const { skillsTools } = require('../src/tools/skills');

const APP_SKILLS = path.join(__dirname, '..', 'skills');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(root, name, text) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), text, 'utf8');
}

test('шапка с name и description разбирается, тело — инструкция', () => {
  const s = parseSkill('---\nname: demo\ndescription: Пример навыка\n---\n\nШаг один.\n');
  assert.equal(s.name, 'demo');
  assert.equal(s.description, 'Пример навыка');
  assert.equal(s.body, 'Шаг один.');
});

test('без шапки, с плохим именем или без описания навык не принимается', () => {
  assert.equal(parseSkill('просто текст'), null);
  assert.equal(parseSkill('---\nname: Bad Name\ndescription: x\n---\nт'), null);
  assert.equal(parseSkill('---\nname: ok\n---\nт'), null);
});

test('длинная инструкция обрезается до лимита', () => {
  const s = parseSkill(`---\nname: long\ndescription: d\n---\n${'я'.repeat(MAX_BODY + 500)}`);
  assert.equal(s.body.length, MAX_BODY);
});

test('папка с другим именем, чем у навыка, пропускается; пользовательский навык перекрывает встроенный', (t) => {
  const builtin = tmpDir(t);
  const user = tmpDir(t);
  writeSkill(builtin, 'alpha', '---\nname: alpha\ndescription: встроенный\n---\nстарый');
  writeSkill(builtin, 'wrong', '---\nname: other\ndescription: x\n---\nнет');
  writeSkill(user, 'alpha', '---\nname: alpha\ndescription: свой\n---\nновый');
  const skills = loadSkills(builtin, user);
  assert.equal(skills.has('wrong'), false);
  assert.equal(skills.get('alpha').description, 'свой');
});

test('загрузчик навыков не читает папки-ссылки за пределами своей папки', (t) => {
  const root = tmpDir(t);
  const outside = tmpDir(t);
  writeSkill(outside, 'secret', '---\nname: secret\ndescription: чужой\n---\nвнешний текст');
  try { fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'linked'), 'junction'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip(`создание junction недоступно: ${err.code}`);
    throw err;
  }
  assert.equal(loadSkills(root).has('secret'), false);
});

test('skills_list и skill_read: список и чтение по имени, неизвестное имя — ошибка', async (t) => {
  const dir = tmpDir(t);
  writeSkill(dir, 'alpha', '---\nname: alpha\ndescription: описание\n---\nинструкция');
  const [list, read] = skillsTools(loadSkills(dir));
  const all = await list.run({}, {});
  assert.equal(all.ok, true);
  assert.deepEqual(all.data.skills, [{ name: 'alpha', description: 'описание' }]);
  const one = await read.run({ name: 'alpha' }, {});
  assert.equal(one.data.body, 'инструкция');
  const missing = await read.run({ name: 'zzz' }, {});
  assert.equal(missing.ok, false);
});

test('встроенные навыки проекта разбираются', () => {
  const skills = loadSkills(APP_SKILLS);
  for (const name of ['briefing', 'research', 'files']) {
    assert.ok(skills.has(name), `навык ${name} должен загружаться`);
    assert.ok(skills.get(name).body.length > 20);
  }
});
