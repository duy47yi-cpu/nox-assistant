'use strict';

// Три примерных сценария из концепции (docs/NOX-CONCEPT-SCENARIOS.md). Фраза из чата запускает их без модели.
// Программы берутся по имени: если программы нет, шаг завершится ошибкой и сценарий честно остановится.
// Сценарии добавляются один раз: если команда с таким именем уже есть, её не трогаем (владелец мог её изменить).
// shortcut: адрес страницы для «Работы» зашит, поля настроек под него пока нет; вынести в настройки, когда появится.
const WORK_PAGE = 'https://ya.ru';

// Отбой: голос звучит до выключения звука (speak ждёт окончания), иначе фраза прозвучала бы в тишине.
// Время вслух не называем: шаги команды статичны, а инструмента времени нет.
const BASE_COMMANDS = [
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
  // Рабочий режим: задержки между шагами — это шаги wait (до 10 с), а не отдельное поле команды.
  // Программы не закрываем: app_close в сохранённой команде запрещён.
  {
    name: 'Рабочий режим',
    phrases: ['рабочий режим'],
    steps: [
      { tool: 'windows_minimize_all', args: {} },
      { tool: 'wait', args: { ms: 1500 } },
      { tool: 'url_open', args: { url: WORK_PAGE } },
      { tool: 'wait', args: { ms: 2000 } },
      { tool: 'app_open', args: { name: 'code' } },
      { tool: 'volume_set', args: { percent: 30 } },
      { tool: 'speak', args: { text: 'Рабочий режим включён' } },
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

// Группа «Windows»: системные сочетания клавиш и открытие программ одним словом.
// Только реальные инструменты: ui_keys (whitelist в src/tools/ui.js, win-сочетания идут кодами
// виртуальных клавиш), windows_minimize_all и app_open. shell_run, pc_shutdown и app_close не берём:
// такие действия в сохранённой команде запрещены (DANGEROUS_TOOLS в store.js).
// Окна влево/вправо/развернуть/свернуть образцом не даём: windows_snap двигает только окно, названное в title,
// а у команды нет поля для названия. Инструмент доступен в чате отдельно.
// Панельные сочетания (Win+V, Win+., Win+L, Win+Ctrl+D, Win+«+») системные и от переднего окна не зависят.
const WINDOWS_COMMANDS = [
  {
    name: 'Новый рабочий стол',
    folder: 'Windows',
    phrases: ['новый рабочий стол', 'создай новый рабочий стол'],
    steps: [{ tool: 'ui_keys', args: { keys: 'win+ctrl+d' } }],
  },
  {
    name: 'Панель эмодзи',
    folder: 'Windows',
    phrases: ['панель эмодзи', 'вставь эмодзи'],
    steps: [{ tool: 'ui_keys', args: { keys: 'win+.' } }],
  },
  {
    name: 'Буфер обмена',
    folder: 'Windows',
    phrases: ['буфер обмена', 'история буфера обмена'],
    steps: [{ tool: 'ui_keys', args: { keys: 'win+v' } }],
  },
  {
    name: 'Экранная лупа',
    folder: 'Windows',
    phrases: ['экранная лупа', 'включи лупу'],
    steps: [{ tool: 'ui_keys', args: { keys: 'win+plus' } }],
  },
  {
    name: 'Блокировка экрана',
    folder: 'Windows',
    phrases: ['блокировка экрана', 'заблокируй экран', 'заблокируй компьютер'],
    steps: [{ tool: 'ui_keys', args: { keys: 'win+l' } }],
  },
  {
    name: 'Свернуть все окна',
    folder: 'Windows',
    phrases: ['свернуть все окна', 'сверни все окна', 'покажи рабочий стол'],
    steps: [{ tool: 'windows_minimize_all', args: {} }],
  },
  {
    // Проводник и Диспетчер задач — обычные программы Windows: app_open находит их по имени.
    // Пауза после Проводника: окно должно появиться, прежде чем открывать вторую программу.
    name: 'Проводник и диспетчер задач',
    folder: 'Windows',
    phrases: ['проводник и диспетчер задач', 'открой проводник и диспетчер'],
    steps: [
      { tool: 'app_open', args: { name: 'explorer' } },
      { tool: 'wait', args: { ms: 1000 } },
      { tool: 'app_open', args: { name: 'taskmgr' } },
    ],
  },
];

const SAMPLE_COMMANDS = [...BASE_COMMANDS, ...WINDOWS_COMMANDS];

// Добавляет недостающие примерные сценарии. Возвращает имена добавленных.
function seedSampleCommands(store) {
  const existing = new Set(store.list().map((c) => c.name));
  const added = [];
  for (const sample of SAMPLE_COMMANDS) {
    if (existing.has(sample.name)) continue;
    store.save({
      name: sample.name,
      phrases: sample.phrases,
      steps: sample.steps,
      enabled: true,
      origin: 'sample',
      ...(sample.folder ? { folder: sample.folder } : {}),
    });
    added.push(sample.name);
  }
  return added;
}

module.exports = { SAMPLE_COMMANDS, WINDOWS_COMMANDS, seedSampleCommands };
