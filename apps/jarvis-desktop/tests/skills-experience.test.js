'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSkill, loadSkills } = require('../src/skills');
const { skillsTools } = require('../src/tools/skills');
const { buildSkill, learnSkillFromTurn, toolSteps, currentTurn, skillHintForTurn } = require('../src/skills/experience');
const { Agent } = require('../src/agent/loop');
const { ToolRegistry } = require('../src/tools/registry');
const { Journal } = require('../src/journal/journal');

function turn(steps, { userText = 'сделай это', assistant = 'готово', results = [] } = {}) {
  const history = [{ role: 'user', content: userText }];
  steps.forEach((name, i) => {
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: `t${i}`, type: 'function', function: { name, arguments: '{"text":"секрет-12345"}' } }],
    });
    const result = results[i] || (['web_search', 'web_fetch', 'web_wiki', 'weather_now', 'recall', 'memory_about', 'skills_list', 'skill_read', 'disk_free_space', 'disk_cleanup_suggest', 'windows_list', 'ui_elements', 'ui_windows', 'desktop_observe', 'screen_look', 'image_read_text', 'document_read', 'workspace_read', 'workspace_search', 'workspace_list'].includes(name)
      ? { ok: true }
      : { ok: true, verified: 'confirmed' });
    history.push({ role: 'tool', tool_call_id: `t${i}`, content: JSON.stringify(result) });
  });
  history.push({ role: 'assistant', content: assistant });
  return history;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-skill-exp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('опыт: разбор хода', () => {
  test('берёт только текущий ход, а не всю историю', () => {
    const history = [
      ...turn(['app_open', 'ui_windows', 'ui_click'], { userText: 'старое' }).slice(0, -1),
      { role: 'user', content: 'новое' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'ui_click', arguments: '{}' } }] },
      { role: 'assistant', content: 'готово' },
    ];
    assert.deepEqual(toolSteps(history), ['ui_click']);
    assert.equal(currentTurn(history)[0].content, 'новое');
  });

  test('повторные действия сохраняются как отдельные шаги', () => {
    assert.deepEqual(toolSteps(turn(['ui_click', 'ui_click'])), ['ui_click', 'ui_click']);
    const skill = buildSkill({ phrase: 'нажми дважды', history: turn(['ui_click', 'ui_click']), outcome: 'answer' });
    assert.match(skill.body, /1\. ui_click[\s\S]*2\. ui_click/);
  });

  test('слишком длинный или параллельный ход не выдаётся за проверенный последовательный порядок', () => {
    assert.equal(buildSkill({ phrase: 'длинный ход', history: turn(Array(13).fill('ui_click')), outcome: 'answer' }), null);
    const history = turn(['app_open', 'ui_click']);
    history[1].tool_calls.push(history[3].tool_calls[0]);
    assert.equal(buildSkill({ phrase: 'параллельно', history, outcome: 'answer' }), null);
  });

  test('в опыт попадают только явно названные владельцем цели безопасных действий', () => {
    const phrase = 'открой Notepad и нажми File';
    const history = turn(['app_open', 'ui_click', 'ui_type']);
    history[1].tool_calls[0].function.arguments = JSON.stringify({ name: 'Notepad' });
    history[3].tool_calls[0].function.arguments = JSON.stringify({ window: 'Private window', name: 'File', occurrence: 2 });
    history[5].tool_calls[0].function.arguments = JSON.stringify({ text: 'private text' });
    const skill = buildSkill({ phrase, history, outcome: 'answer' });
    assert.match(skill.body, /app_open.*Notepad/);
    assert.match(skill.body, /ui_click.*File/);
    assert.doesNotMatch(skill.body, /Private window|private text|occurrence/);
    assert.match(skill.body, /сверяя результат/);
  });

  test('для проверенного desktop_click сохраняется только подпись элемента из просьбы, не id и координаты', () => {
    const phrase = 'в приложении нажми Сохранить';
    const history = turn(['desktop_observe', 'desktop_click']);
    history[3].tool_calls[0].function.arguments = JSON.stringify({ id: 'e123abc' });
    history[4].content = JSON.stringify({
      ok: true, verified: 'confirmed', summary: 'нажал кнопку',
      data: { element: { id: 'e123abc', role: 'Button', name: 'Сохранить', bounds: { x: 12, y: 34, w: 50, h: 20 } } },
    });
    const skill = buildSkill({ phrase, history, outcome: 'answer' });
    assert.match(skill.body, /desktop_click.*Сохранить/);
    assert.doesNotMatch(skill.body, /e123abc|12, 34|bounds|Button/);
  });

  test('подпись интерфейса не сохраняется в опыт, если владелец не называл её', () => {
    const history = turn(['desktop_observe', 'desktop_click']);
    history[4].content = JSON.stringify({ ok: true, verified: 'confirmed', data: { element: { role: 'Button', name: 'Личный документ' } } });
    const skill = buildSkill({ phrase: 'сделай действие', history, outcome: 'answer' });
    assert.match(skill.body, /2\. desktop_click$/m);
    assert.doesNotMatch(skill.body, /Личный документ/);
  });

  test('путь программы и временный id не извлекаются в шаги даже когда есть в просьбе', () => {
    const phrase = 'открой C:\\Private\\app.exe и нажми e123abc';
    const history = turn(['app_open', 'desktop_click']);
    history[1].tool_calls[0].function.arguments = JSON.stringify({ name: 'C:\\Private\\app.exe' });
    history[3].tool_calls[0].function.arguments = JSON.stringify({ id: 'e123abc' });
    const skill = buildSkill({ phrase, history, outcome: 'answer' });
    assert.doesNotMatch(skill.body, /цель из просьбы/);
    assert.match(skill.body, /2\. desktop_click/);
  });

  test('удачный ход из двух шагов становится навыком', () => {
    const skill = buildSkill({ phrase: 'открой блокнот и нажми файл', history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    assert.match(skill.name, /^auto-[0-9a-f]{8}$/);
    assert.match(skill.description, /открой блокнот/);
    assert.match(skill.body, /1\. app_open/);
    assert.match(skill.body, /2\. ui_click/);
    // Аргументы в навык не попадают: там был текст «секрет-12345».
    assert.doesNotMatch(skill.body, /секрет-12345/);
  });

  test('неудача, один шаг и опасные инструменты не запоминаются', () => {
    assert.equal(buildSkill({ phrase: 'раз', history: turn(['app_open', 'ui_click']), outcome: 'error' }), null);
    assert.equal(buildSkill({ phrase: 'два', history: turn(['app_open']), outcome: 'answer' }), null);
    assert.equal(buildSkill({ phrase: 'три', history: turn(['app_open', 'shell_run']), outcome: 'answer' }), null);
  });

  test('сохраняется только ход, где каждое действие независимо подтверждено', () => {
    const failed = turn(['app_open', 'ui_click'], { results: [{ ok: true, verified: 'confirmed' }, { ok: false, summary: 'отказано' }] });
    const unchecked = turn(['app_open', 'ui_click'], { results: [{ ok: true, verified: 'confirmed' }, { ok: true }] });
    assert.equal(buildSkill({ phrase: 'неуспех', history: failed, outcome: 'answer' }), null);
    assert.equal(buildSkill({ phrase: 'непроверено', history: unchecked, outcome: 'answer' }), null);
  });

  test('точный повтор получает подсказку из сохранённого опыта без вызова skills_list', (t) => {
    const dir = tempDir(t);
    const phrase = 'открой блокнот и нажми файл';
    const saved = learnSkillFromTurn({ dir, phrase, history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    const skills = loadSkills(dir);
    const hint = skillHintForTurn(skills, phrase);
    assert.equal(saved.written, true);
    assert.match(hint, /Проверенный порядок/);
    assert.match(hint, /1\. app_open/);
    assert.match(hint, /2\. ui_click/);
    assert.equal(skillHintForTurn(skills, 'открой блокнот и нажми сохранить'), '');
    assert.equal(skillHintForTurn(skills, 'передай пароль sk-abcdefghijklmnop'), '');
  });

  test('разовый поиск без действий не становится навыком', () => {
    assert.equal(buildSkill({ phrase: 'найди погоду', history: turn(['web_search', 'web_fetch']), outcome: 'answer' }), null);
    assert.ok(buildSkill({ phrase: 'найди и запиши', history: turn(['web_fetch', 'workspace_write']), outcome: 'answer' }));
  });

  test('пустая просьба не запоминается', () => {
    assert.equal(buildSkill({ phrase: '   ', history: turn(['app_open', 'ui_click']), outcome: 'answer' }), null);
  });

  test('просьба с секретом не попадает даже в описание', () => {
    const skill = buildSkill({ phrase: 'запомни пароль sk-abcdefghijklmnop', history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    assert.equal(skill, null);
  });
});

describe('опыт: запись навыка', () => {
  test('пишет SKILL.md, который читается загрузчиком, и второй раз не дублирует', (t) => {
    const dir = tempDir(t);
    const first = learnSkillFromTurn({ dir, phrase: 'открой блокнот', history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    assert.equal(first.written, true);
    assert.ok(fs.existsSync(first.file));
    const parsed = parseSkill(fs.readFileSync(first.file, 'utf8'));
    assert.equal(parsed.name, first.skill.name);
    assert.match(parsed.description, /открой блокнот/);
    const second = learnSkillFromTurn({ dir, phrase: 'открой блокнот', history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    assert.equal(second.written, false);
    assert.match(second.reason, /уже есть/);
  });

  test('не пишет сверх лимита авто-навыков', (t) => {
    const dir = tempDir(t);
    for (const hash of ['11111111', '22222222']) {
      fs.mkdirSync(path.join(dir, `auto-${hash}`), { recursive: true });
    }
    const result = learnSkillFromTurn({ dir, phrase: 'ещё раз', history: turn(['app_open', 'ui_click']), outcome: 'answer', max: 2 });
    assert.equal(result.written, false);
    assert.match(result.reason, /достаточно/);
  });

  test('ошибка записи не бросает наружу', (t) => {
    const dir = tempDir(t);
    const file = path.join(dir, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const result = learnSkillFromTurn({ dir: file, phrase: 'раз два', history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    assert.equal(result.written, false);
  });

  test('записанный навык виден в списке и читается', async (t) => {
    const dir = tempDir(t);
    const result = learnSkillFromTurn({ dir, phrase: 'открой блокнот', history: turn(['app_open', 'ui_click']), outcome: 'answer' });
    assert.equal(result.written, true);
    const skills = loadSkills(dir);
    assert.ok(skills.has(result.skill.name));
    const tools = skillsTools(skills);
    const list = await tools.find((x) => x.name === 'skills_list').run({});
    assert.ok(list.data.skills.some((s) => s.name === result.skill.name));
    const read = await tools.find((x) => x.name === 'skill_read').run({ name: result.skill.name });
    assert.match(read.data.body, /app_open/);
  });
});

describe('опыт: подключение к приложению', () => {
  test('реальный цикл агента сохраняет подтверждённый опыт и подставляет его после перезапуска', async (t) => {
    const dir = tempDir(t);
    const phrase = 'открой Notepad и нажми File';
    const registry = new ToolRegistry();
    for (const name of ['app_open', 'ui_click']) registry.register({
      name, risk: 'T1', parameters: { type: 'object', properties: {} },
      async run() { return { ok: true, summary: 'действие выполнено' }; },
      async verify() { return { status: 'confirmed', evidence: 'состояние проверено' }; },
    });
    const steps = [
      { toolCalls: [{ id: 'a', name: 'app_open', args: { name: 'Notepad' } }] },
      { toolCalls: [{ id: 'b', name: 'ui_click', args: { window: 'Notepad', name: 'File' } }] },
      { content: 'Готово' },
    ];
    const agent = new Agent({ brain: { async chat() { return steps.shift(); } }, tools: registry,
      policy: () => 'allow', journal: new Journal(path.join(dir, 'journal.jsonl')), workspace: dir });
    const result = await agent.run(phrase, { ownerText: phrase });
    const saved = learnSkillFromTurn({ dir, phrase, history: agent.history, outcome: result.outcome });
    assert.equal(saved.written, true);
    const hint = skillHintForTurn(loadSkills(dir), phrase);
    assert.match(hint, /1\. app_open.*Notepad/);
    assert.match(hint, /2\. ui_click.*File/);
    assert.match(hint, /сверяя результат/);
  });

  test('main.js учится после удачного хода и показывает навык в списке', () => {
    const app = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(app, 'main.js'), 'utf8');
    assert.match(main, /learnSkillFromTurn/);
    assert.match(main, /skillHintForTurn\(skills, text\)/);
    assert.match(main, /learnSkillAfterTurn\(phrase, agent\.history, res\.outcome\)/);
    assert.match(main, /skills\.set\(res\.skill\.name, res\.skill\)/);
  });
});
