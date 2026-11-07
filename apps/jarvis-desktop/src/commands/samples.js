'use strict';

// Три примерных сценария из концепции (docs/NOX-CONCEPT-SCENARIOS.md). Фраза из чата запускает их без модели.
// Программы берутся по имени: если программы нет, шаг завершится ошибкой и сценарий честно остановится.
// Сценарии добавляются один раз: если команда с таким именем уже есть, её не трогаем (владелец мог её изменить).
// shortcut: адрес страницы для «Работы» зашит, поля настроек под него пока нет; вынести в настройки, когда появится.
const WORK_PAGE = 'https://ya.ru';

// Отбой: голос звучит до выключения звука (speak ждёт окончания), иначе фраза прозвучала бы в тишине.
// Время вслух не называем: шаги команды статичны, а инструмента времени нет.
const SAMPLE_COMMANDS = [
  {
    name: 'Работа',
    phrases: ['работа', 'начинаем работу', 'режим работы'],
    steps: [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'url_open', args: { url: WORK_PAGE } },
      { tool: 'volume_set', args: { percent: 30 } },
      { tool: 'speak', args: { text: 'Режим работы' } },
    ],
  },
  {
    name: 'Игра',
    phrases: ['игра', 'начинаем игру', 'игровой режим'],
    steps: [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'wait', args: { ms: 800 } },
      { tool: 'volume_set', args: { percent: 70 } },
    ],
  },
  {
    name: 'Отбой',
    phrases: ['отбой', 'спокойной ночи'],
    steps: [
      { tool: 'speak', args: { text: 'Спокойной ночи, владелец' } },
      { tool: 'volume_set', args: { percent: 0 } },
      { tool: 'monitor_off', args: {} },
    ],
  },
];

// Добавляет недостающие примерные сценарии. Возвращает имена добавленных.
function seedSampleCommands(store) {
  const existing = new Set(store.list().map((c) => c.name));
  const added = [];
  for (const sample of SAMPLE_COMMANDS) {
    if (existing.has(sample.name)) continue;
    store.save({ name: sample.name, phrases: sample.phrases, steps: sample.steps, enabled: true, origin: 'sample' });
    added.push(sample.name);
  }
  return added;
}

module.exports = { SAMPLE_COMMANDS, seedSampleCommands };
