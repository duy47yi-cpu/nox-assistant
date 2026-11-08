'use strict';

// Паки команд: готовые наборы для монтажа, игр и браузера. Пак — это данные, а не новый формат:
// его команды сохраняются обычным store.js (схема v2: папка, коллекции, происхождение sample)
// и выгружаются обычным файлом команд, который окно импортирует через previewCommandImport.
//
// Команды работают в активном окне программы. ui_keys без window отправляет клавиши туда, где
// сейчас фокус, поэтому окно редактора, игры или браузера владелец активирует сам: команда
// не ищет окно и не переключает его.
//
// Клавиши берутся только из белого списка src/tools/ui.js (KEY_MAP). Все клавиши паков в нём есть;
// shift+delete в KEY_MAP есть, но политика спрашивает подтверждение, если владелец не просил удалить в ходе.
// Намеренно вне списка: alt+f4, ctrl+alt+delete, win+r и delete без shift.
const { exportCommandJson, normalize } = require('./store');
const { KEY_MAP, parseKeys } = require('../tools/ui');

// Общая коллекция в редакторе команд: по ней видно, что команда пришла из пака.
const PACK_COLLECTION = 'Паки';

// Нажатия без window: работает в активном окне. Один шаг — одно нажатие.
const keys = (value) => [{ tool: 'ui_keys', args: { keys: value } }];

const PACKS = [
  {
    id: 'montage',
    title: 'Монтаж',
    description: 'Монтаж: нажатия в активном окне Premiere, CapCut или DaVinci Resolve. Окно редактора должно быть на переднем плане — команда не ищет его сама.',
    commands: [
      {
        name: 'Монтаж: разрезать в Premiere',
        phrases: ['разрежь клип', 'сделай разрез', 'разрежь на монтаже'],
        steps: keys('ctrl+k'),
      },
      {
        name: 'Монтаж: разрезать в CapCut и DaVinci',
        phrases: ['разрежь клип в capcut', 'разрежь клип в davinci', 'сделай разрез в capcut'],
        // В CapCut и DaVinci Resolve разрез — Ctrl+B; Ctrl+K — только в Premiere.
        steps: keys('ctrl+b'),
      },
      {
        name: 'Монтаж: удалить со сдвигом',
        phrases: ['удали со сдвигом', 'сотри клип со сдвигом'],
        steps: keys('shift+delete'),
      },
      {
        name: 'Монтаж: метка входа',
        phrases: ['поставь метку входа', 'метка входа на монтаже'],
        steps: keys('i'),
      },
      {
        name: 'Монтаж: метка выхода',
        phrases: ['поставь метку выхода', 'метка выхода на монтаже'],
        steps: keys('o'),
      },
      {
        name: 'Монтаж: экспорт',
        phrases: ['экспортируй видео', 'экспорт монтажа'],
        steps: keys('ctrl+m'),
      },
      {
        name: 'Монтаж: отменить',
        phrases: ['отмени в монтаже', 'верни действие в монтаже'],
        steps: keys('ctrl+z'),
      },
      {
        name: 'Монтаж: сохранить',
        phrases: ['сохрани монтаж', 'сохрани проект'],
        steps: keys('ctrl+s'),
      },
      {
        name: 'Монтаж: сохранить как',
        phrases: ['сохрани монтаж как'],
        steps: keys('ctrl+shift+s'),
      },
      {
        name: 'Монтаж: воспроизвести',
        phrases: ['воспроизведи в монтаже', 'пауза в монтаже'],
        steps: keys('space'),
      },
      {
        name: 'Монтаж: в начало',
        phrases: ['в начало монтажа'],
        steps: keys('home'),
      },
      {
        name: 'Монтаж: в конец',
        phrases: ['в конец монтажа'],
        steps: keys('end'),
      },
      {
        name: 'Монтаж: кадр назад',
        phrases: ['кадр назад в монтаже'],
        steps: keys('left'),
      },
      {
        name: 'Монтаж: кадр вперёд',
        phrases: ['кадр вперёд в монтаже'],
        steps: keys('right'),
      },
      {
        name: 'Монтаж: выделить всё',
        phrases: ['выдели всё на таймлайне'],
        steps: keys('ctrl+a'),
      },
      {
        name: 'Монтаж: копировать клип',
        phrases: ['скопируй клип'],
        steps: keys('ctrl+c'),
      },
      {
        name: 'Монтаж: вставить клип',
        phrases: ['вставь клип'],
        steps: keys('ctrl+v'),
      },
    ],
  },
  {
    id: 'games',
    title: 'Игры',
    description: 'Игры: нажатия в активном окне игры с управлением как в Minecraft. Окно игры должно быть на переднем плане — команда не ищет его сама.',
    commands: [
      {
        name: 'Игры: инвентарь',
        phrases: ['открой инвентарь', 'инвентарь в игре'],
        steps: keys('e'),
      },
      {
        name: 'Игры: выбросить предмет',
        phrases: ['выбрось предмет'],
        steps: keys('q'),
      },
      {
        name: 'Игры: вид от третьего лица',
        phrases: ['вид от третьего лица'],
        steps: keys('f5'),
      },
      {
        name: 'Игры: чат',
        phrases: ['открой чат в игре'],
        steps: keys('enter'),
      },
      {
        name: 'Игры: меню',
        phrases: ['меню игры', 'пауза в игре'],
        steps: keys('escape'),
      },
      {
        name: 'Игры: прыжок',
        phrases: ['прыжок в игре', 'прыгни в игре'],
        steps: keys('space'),
      },
      {
        name: 'Игры: список игроков',
        phrases: ['список игроков в игре'],
        steps: keys('tab'),
      },
    ],
  },
  {
    id: 'browser',
    title: 'Браузер',
    description: 'Браузер: вкладки и адресная строка в активном окне браузера. Окно браузера должно быть на переднем плане — команда не ищет его сама.',
    commands: [
      {
        name: 'Браузер: новая вкладка',
        phrases: ['новая вкладка', 'открой новую вкладку'],
        steps: keys('ctrl+t'),
      },
      {
        name: 'Браузер: закрыть вкладку',
        phrases: ['закрой вкладку', 'закрой текущую вкладку'],
        steps: keys('ctrl+w'),
      },
      {
        name: 'Браузер: следующая вкладка',
        phrases: ['следующая вкладка'],
        steps: keys('ctrl+tab'),
      },
      {
        name: 'Браузер: адресная строка',
        phrases: ['адресная строка', 'перейди в адресную строку'],
        steps: keys('ctrl+l'),
      },
      {
        name: 'Браузер: перезагрузить страницу',
        phrases: ['перезагрузи страницу', 'обнови страницу'],
        // Ctrl+L выделяет адрес, Enter переходит по нему: так Enter не уходит в произвольное поле.
        steps: [...keys('ctrl+l'), ...keys('enter')],
      },
      {
        name: 'Браузер: скопировать адрес',
        phrases: ['скопируй адрес страницы'],
        steps: [...keys('ctrl+l'), ...keys('ctrl+c')],
      },
      {
        name: 'Браузер: открыть ссылку из буфера',
        phrases: ['открой ссылку из буфера'],
        steps: [...keys('ctrl+l'), ...keys('ctrl+v'), ...keys('enter')],
      },
    ],
  },
];

// Токены строки клавиш так же, как их режет parseKeys: "ctrl + shift+s" → ['ctrl+shift+s'].
function keyTokens(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/\s*\+\s*/g, '+')
    .split(/[\s,;]+/)
    .filter(Boolean);
}

function getPack(id) {
  return PACKS.find((pack) => pack.id === id) || null;
}

function resolvePack(packOrId) {
  const pack = typeof packOrId === 'string' ? getPack(packOrId) : packOrId;
  if (!pack || !Array.isArray(pack.commands)) throw new Error(`пак не найден: ${packOrId}`);
  return pack;
}

// Клавиши команды, которых нет в белом списке ui.js. Пусто — команду можно сохранять и запускать.
function missingKeys(command) {
  const missing = [];
  for (const step of command.steps || []) {
    if (!step || step.tool !== 'ui_keys') continue;
    const value = step.args && step.args.keys;
    if (parseKeys(value).ok) continue;
    const tokens = keyTokens(value);
    let unsupported = 0;
    for (const token of tokens) {
      if (Object.prototype.hasOwnProperty.call(KEY_MAP, token)) continue;
      if (!missing.includes(token)) missing.push(token);
      unsupported += 1;
    }
    // parseKeys отказал не из-за отдельной клавиши (например, пустая строка): показываем как есть.
    if (unsupported === 0 && !missing.includes(String(value == null ? '' : value))) {
      missing.push(String(value == null ? '' : value));
    }
  }
  return missing;
}

function isCommandSupported(command) {
  return missingKeys(command).length === 0;
}

// Команды пака, которые сейчас реально выполнимы (все клавиши из белого списка).
function availableCommands(packOrId) {
  return resolvePack(packOrId).commands.filter(isCommandSupported);
}

// Объявленные, но пока невыполнимые команды с точным списком недостающих клавиш.
// Нужны окну и тестам, чтобы честно показывать ограничение, а не молчать.
function unsupportedCommands(packOrId) {
  return resolvePack(packOrId).commands
    .filter((command) => !isCommandSupported(command))
    .map((command) => ({ name: command.name, missing: missingKeys(command) }));
}

// Запись команды для store.js: происхождение sample, своя папка пака, общая коллекция.
function commandDraft(pack, command) {
  return {
    name: command.name,
    phrases: command.phrases.slice(),
    steps: command.steps.map((step) => ({ tool: step.tool, args: { ...step.args } })),
    enabled: true,
    origin: 'sample',
    folder: pack.title,
    collections: [PACK_COLLECTION],
  };
}

// JSON файла команд Nox для одного пака: его окно принимает через previewCommandImport.
// Команды с невыполнимыми клавишами не выгружаются — импорт не должен обещать то, чего нет.
function buildPackCommandJson(packId) {
  const pack = resolvePack(packId);
  return exportCommandJson(availableCommands(pack).map((command) => commandDraft(pack, command)));
}

// Добавляет недостающие команды паков. Существующие команды с тем же именем не трогает:
// владелец мог их изменить. Если нужная фраза уже занята другой командой, эту команду
// пропускает молча — это обычная ситуация при первом запуске, а не ошибка.
// Возвращает имена добавленных команд.
function seedPackCommands(store, packIds = PACKS.map((pack) => pack.id)) {
  if (!store || typeof store.list !== 'function' || typeof store.save !== 'function') {
    throw new Error('seedPackCommands: нужно хранилище команд');
  }
  if (!Array.isArray(packIds)) throw new Error('seedPackCommands: packIds — массив id паков');
  // Неизвестный пак проверяем до записи, чтобы не добавлять половину.
  const packs = packIds.map((id) => resolvePack(id));
  const items = store.list();
  const names = new Set(items.map((item) => item.name));
  const phrases = new Set();
  for (const item of items) {
    for (const phrase of item.phrases || []) phrases.add(normalize(phrase));
  }
  const added = [];
  for (const pack of packs) {
    for (const command of availableCommands(pack)) {
      if (names.has(command.name)) continue;
      if (command.phrases.some((phrase) => phrases.has(normalize(phrase)))) continue;
      const saved = store.save(commandDraft(pack, command));
      names.add(saved.name);
      for (const phrase of saved.phrases || []) phrases.add(normalize(phrase));
      added.push(saved.name);
    }
  }
  return added;
}

module.exports = {
  PACKS,
  PACK_COLLECTION,
  getPack,
  availableCommands,
  unsupportedCommands,
  buildPackCommandJson,
  seedPackCommands,
  isCommandSupported,
  missingKeys,
};
