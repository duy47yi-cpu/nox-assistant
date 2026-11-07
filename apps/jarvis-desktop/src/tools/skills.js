'use strict';

// Инструменты навыков: список и чтение инструкции. Только чтение, риск T0.
function skillsTools(skills) {
  return [
    {
      name: 'skills_list',
      description: 'Список навыков Джарвиса: как делать типовые дела (имя и описание). Загляни сюда перед брифингом, поиском с источниками или работой с файлами.',
      risk: 'T0',
      parameters: { type: 'object', properties: {} },
      async run() {
        const list = [...skills.values()].map((s) => ({ name: s.name, description: s.description }));
        return { ok: true, summary: `навыков: ${list.length}`, data: { skills: list } };
      },
    },
    {
      name: 'skill_read',
      description: 'Прочитать инструкцию навыка по имени (имя из skills_list).',
      risk: 'T0',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 40 } },
        required: ['name'],
      },
      async run(args) {
        const name = String((args && args.name) || '').trim();
        const skill = skills.get(name);
        if (!skill) return { ok: false, summary: `навык «${name}» не найден; список — skills_list`, data: {} };
        return { ok: true, summary: `навык ${name}`, data: { name, body: skill.body } };
      },
    },
  ];
}

module.exports = { skillsTools };
