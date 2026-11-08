'use strict';

// Паки команд: готовые наборы для монтажа, игр, браузера, окон, проводника, текста, музыки, сайтов и программ.
// Пак — это данные, а не новый формат: его команды сохраняются обычным store.js (схема v2: папка,
// коллекции, происхождение sample) и выгружаются обычным файлом команд, который окно импортирует через
// previewCommandImport.
//
// Шаги паков — только три инструмента (PACK_TOOLS):
// - ui_keys: клавиши из белого списка src/tools/ui.js (KEY_MAP). Без window уходят в активное окно:
//   программу владелец открывает и делает активной сам, команда ничего не ищет и не переключает.
//   Сочетания «Окна» действуют на окно сверху, медиа-клавиши «Музыки» — на плеер Windows.
// - url_open: только фиксированные https-адреса из пака «Сайты».
// - app_open: только программы Windows по имени из пака «Программы» и «Проводник».
// Политика (decide) по-прежнему спрашивает подтверждение на каждый шаг T1.
//
// Намеренно вне списка: alt+f4, ctrl+alt+delete, win+r, delete без shift, удаление файлов и любые
// команды оболочки.
const { exportCommandJson, normalize } = require('./store');
const { KEY_MAP, parseKeys } = require('../tools/ui');

// Общая коллекция в редакторе команд: по ней видно, что команда пришла из пака.
const PACK_COLLECTION = 'Паки';

// Инструменты, которые можно положить в шаг пака. Всё остальное отклоняется тестом и missingKeys.
const PACK_TOOLS = Object.freeze(['ui_keys', 'url_open', 'app_open']);

// Нажатия без window: работает в активном окне. Один шаг — одно нажатие.
const keys = (value) => [{ tool: 'ui_keys', args: { keys: value } }];
// Открыть сайт в браузере по умолчанию. Адрес только https и только из этого файла.
const site = (url) => [{ tool: 'url_open', args: { url } }];
// Запустить программу Windows по имени из списка.
const program = (name) => [{ tool: 'app_open', args: { name } }];

const PACKS = [
  {
    id: 'montage',
    title: 'Монтаж',
    description: 'Монтаж: нажатия в активном окне Premiere, CapCut или DaVinci Resolve. Окно редактора должно быть на переднем плане — команда не ищет его сама.',
    hint: 'Нужно окно редактора на переднем плане',
    activeWindow: true,
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
    hint: 'Нужно окно игры на переднем плане',
    activeWindow: true,
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
    description: 'Браузер: вкладки, адресная строка, назад и вперёд, масштаб в активном окне браузера. Окно браузера должно быть на переднем плане — команда не ищет его сама.',
    hint: 'Нужно окно браузера на переднем плане',
    activeWindow: true,
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
        name: 'Браузер: предыдущая вкладка',
        phrases: ['предыдущая вкладка'],
        steps: keys('ctrl+shift+tab'),
      },
      {
        name: 'Браузер: вернуть закрытую вкладку',
        phrases: ['верни закрытую вкладку', 'открой закрытую вкладку'],
        steps: keys('ctrl+shift+t'),
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
      {
        name: 'Браузер: назад по истории',
        phrases: ['назад по истории', 'страница назад'],
        steps: keys('alt+left'),
      },
      {
        name: 'Браузер: вперёд по истории',
        phrases: ['страница вперёд', 'вперёд по истории'],
        steps: keys('alt+right'),
      },
      {
        name: 'Браузер: найти на странице',
        phrases: ['найди на странице'],
        steps: keys('ctrl+f'),
      },
      {
        name: 'Браузер: увеличить страницу',
        phrases: ['увеличь страницу'],
        steps: keys('ctrl+plus'),
      },
      {
        name: 'Браузер: уменьшить страницу',
        phrases: ['уменьши страницу'],
        steps: keys('ctrl+minus'),
      },
      {
        name: 'Браузер: обычный размер страницы',
        phrases: ['обычный размер страницы'],
        steps: keys('ctrl+0'),
      },
    ],
  },
  {
    id: 'windows',
    title: 'Окна',
    description: 'Окна: прикрепить, развернуть и свернуть окно, которое сейчас сверху. Снимок области экрана и диспетчер задач.',
    hint: 'Действует на окно, которое сейчас сверху',
    activeWindow: true,
    commands: [
      {
        name: 'Окна: прикрепить влево',
        phrases: ['прикрепи окно влево', 'окно влево'],
        steps: keys('win+left'),
      },
      {
        name: 'Окна: прикрепить вправо',
        phrases: ['прикрепи окно вправо', 'окно вправо'],
        steps: keys('win+right'),
      },
      {
        name: 'Окна: развернуть',
        phrases: ['разверни окно', 'максимизируй окно'],
        steps: keys('win+up'),
      },
      {
        name: 'Окна: свернуть',
        phrases: ['сверни окно', 'минимизируй окно'],
        steps: keys('win+down'),
      },
      {
        name: 'Окна: снимок области',
        phrases: ['сними область экрана', 'скриншот области'],
        steps: keys('win+shift+s'),
      },
      {
        name: 'Окна: диспетчер задач',
        phrases: ['открой диспетчер задач', 'диспетчер задач'],
        steps: keys('ctrl+shift+escape'),
      },
    ],
  },
  {
    id: 'explorer',
    title: 'Проводник',
    description: 'Проводник: поиск, переименование, вырезать и вставить, папка выше в активном окне проводника. Удаление файлов в пак не входит.',
    hint: 'Действует на окно проводника на переднем плане',
    activeWindow: true,
    commands: [
      {
        name: 'Проводник: открыть',
        phrases: ['открой проводник', 'запусти проводник'],
        steps: program('explorer'),
      },
      {
        name: 'Проводник: папка выше',
        phrases: ['папка выше', 'на папку вверх'],
        steps: keys('alt+up'),
      },
      {
        name: 'Проводник: поиск',
        phrases: ['найди файл в проводнике', 'поиск в проводнике'],
        steps: keys('ctrl+e'),
      },
      {
        name: 'Проводник: переименовать',
        phrases: ['переименуй выделенное'],
        steps: keys('f2'),
      },
      {
        name: 'Проводник: новая папка',
        phrases: ['создай папку', 'новая папка'],
        steps: keys('ctrl+shift+n'),
      },
      {
        name: 'Проводник: вырезать файл',
        phrases: ['вырежь файл'],
        steps: keys('ctrl+x'),
      },
      {
        name: 'Проводник: скопировать файл',
        phrases: ['скопируй файл'],
        steps: keys('ctrl+c'),
      },
      {
        name: 'Проводник: вставить файл',
        phrases: ['вставь файл'],
        steps: keys('ctrl+v'),
      },
      {
        name: 'Проводник: обновить папку',
        phrases: ['обнови папку'],
        steps: keys('f5'),
      },
      {
        name: 'Проводник: выделить все файлы',
        phrases: ['выдели все файлы'],
        steps: keys('ctrl+a'),
      },
    ],
  },
  {
    id: 'text',
    title: 'Текст',
    description: 'Текст: правка, выделение, поиск, замена, курсив и жирный в активном окне документа. Сохранение спрашивается, если файл уже назван.',
    hint: 'Нужно окно документа на переднем плане',
    activeWindow: true,
    commands: [
      {
        name: 'Текст: новый документ',
        phrases: ['новый документ', 'создай документ'],
        steps: keys('ctrl+n'),
      },
      {
        name: 'Текст: сохранить',
        phrases: ['сохрани документ'],
        steps: keys('ctrl+s'),
      },
      {
        name: 'Текст: сохранить как',
        phrases: ['сохрани документ как'],
        steps: keys('ctrl+shift+s'),
      },
      {
        name: 'Текст: отменить правку',
        phrases: ['отмени правку'],
        steps: keys('ctrl+z'),
      },
      {
        name: 'Текст: повторить правку',
        phrases: ['повтори правку'],
        steps: keys('ctrl+y'),
      },
      {
        name: 'Текст: вырезать',
        phrases: ['вырежь текст'],
        steps: keys('ctrl+x'),
      },
      {
        name: 'Текст: скопировать',
        phrases: ['скопируй текст'],
        steps: keys('ctrl+c'),
      },
      {
        name: 'Текст: вставить',
        phrases: ['вставь текст'],
        steps: keys('ctrl+v'),
      },
      {
        name: 'Текст: выделить всё',
        phrases: ['выдели весь текст'],
        steps: keys('ctrl+a'),
      },
      {
        name: 'Текст: найти',
        phrases: ['найди в тексте'],
        steps: keys('ctrl+f'),
      },
      {
        name: 'Текст: заменить',
        phrases: ['замени в тексте'],
        steps: keys('ctrl+h'),
      },
      {
        name: 'Текст: курсив',
        phrases: ['сделай курсивом'],
        steps: keys('ctrl+i'),
      },
      {
        name: 'Текст: жирный',
        phrases: ['сделай жирным'],
        steps: keys('ctrl+b'),
      },
      {
        name: 'Текст: подчеркнуть',
        phrases: ['подчеркни текст'],
        steps: keys('ctrl+u'),
      },
      {
        name: 'Текст: в начало документа',
        phrases: ['в начало текста'],
        steps: keys('ctrl+home'),
      },
      {
        name: 'Текст: в конец документа',
        phrases: ['в конец текста'],
        steps: keys('ctrl+end'),
      },
      {
        name: 'Текст: в начало строки',
        phrases: ['в начало строки'],
        steps: keys('home'),
      },
      {
        name: 'Текст: в конец строки',
        phrases: ['в конец строки'],
        steps: keys('end'),
      },
    ],
  },
  {
    id: 'media',
    title: 'Музыка и звук',
    description: 'Пауза, следующий трек, громкость и звук. Работают с любым плеером Windows, окно плеера не нужно.',
    hint: 'Работает без окна: нажатие уходит плееру Windows',
    activeWindow: false,
    commands: [
      {
        name: 'Музыка: пауза или продолжить',
        phrases: ['пауза музыки', 'продолжи музыку', 'останови музыку'],
        steps: keys('media_playpause'),
      },
      {
        name: 'Музыка: следующий трек',
        phrases: ['следующий трек', 'следующая песня'],
        steps: keys('media_next'),
      },
      {
        name: 'Музыка: предыдущий трек',
        phrases: ['предыдущий трек', 'прошлая песня'],
        steps: keys('media_prev'),
      },
      {
        name: 'Звук: громче',
        phrases: ['прибавь громкость', 'громче'],
        steps: keys('volume_up'),
      },
      {
        name: 'Звук: тише',
        phrases: ['убавь громкость'],
        steps: keys('volume_down'),
      },
      {
        name: 'Звук: выключить или включить',
        phrases: ['выключи звук', 'включи звук'],
        steps: keys('volume_mute'),
      },
    ],
  },
  {
    id: 'sites',
    title: 'Сайты',
    description: 'Открывает сайт в браузере по умолчанию. Адреса фиксированы в команде: их можно поменять в файле команд, а не в фразе.',
    hint: 'Открывает сайт в браузере по умолчанию',
    activeWindow: false,
    commands: [
      {
        name: 'Сайт: ютуб',
        phrases: ['зайди на ютуб'],
        steps: site('https://www.youtube.com'),
      },
      {
        name: 'Сайт: почта',
        phrases: ['зайди в почту'],
        steps: site('https://mail.google.com'),
      },
      {
        name: 'Сайт: карты',
        phrases: ['зайди на карты'],
        steps: site('https://www.google.com/maps'),
      },
      {
        name: 'Сайт: календарь',
        phrases: ['зайди в календарь'],
        steps: site('https://calendar.google.com'),
      },
      {
        name: 'Сайт: погода',
        phrases: ['зайди на погоду'],
        steps: site('https://yandex.ru/pogoda'),
      },
      {
        name: 'Сайт: новости',
        phrases: ['зайди на новости'],
        steps: site('https://news.google.com'),
      },
      {
        name: 'Сайт: музыка',
        phrases: ['зайди в музыку'],
        steps: site('https://music.yandex.ru'),
      },
      {
        name: 'Сайт: телеграм',
        phrases: ['зайди в телеграм'],
        steps: site('https://web.telegram.org'),
      },
      {
        name: 'Сайт: википедия',
        phrases: ['зайди в википедию'],
        steps: site('https://ru.wikipedia.org'),
      },
    ],
  },
  {
    id: 'apps',
    title: 'Программы',
    description: 'Запускает программы Windows, которые есть на любом компьютере с Windows.',
    hint: 'Запускает программу Windows',
    activeWindow: false,
    commands: [
      {
        name: 'Программа: блокнот',
        phrases: ['запусти блокнот'],
        steps: program('notepad'),
      },
      {
        name: 'Программа: калькулятор',
        phrases: ['запусти калькулятор'],
        steps: program('calc'),
      },
      {
        name: 'Программа: paint',
        phrases: ['запусти paint', 'запусти рисование'],
        steps: program('mspaint'),
      },
      {
        name: 'Программа: ножницы',
        phrases: ['запусти ножницы'],
        steps: program('snippingtool'),
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

// Что в шаге не так: клавиши вне белого списка или инструмент вне PACK_TOOLS. Пусто — шаг можно сохранять.
function missingKeys(command) {
  const missing = [];
  for (const step of command.steps || []) {
    if (!step) continue;
    if (!PACK_TOOLS.includes(step.tool)) {
      if (!missing.includes(step.tool)) missing.push(step.tool);
      continue;
    }
    if (step.tool !== 'ui_keys') continue;
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

// Сводка для окна: сколько команд пака уже стоят в списке команд (по имени), и что внутри.
// storeItems — результат store.list(); чистая функция, без записи.
function describePacks(storeItems = []) {
  const have = new Set((storeItems || []).map((item) => item.name));
  return PACKS.map((pack) => {
    const commands = availableCommands(pack);
    const installed = commands.filter((command) => have.has(command.name)).length;
    return {
      id: pack.id,
      title: pack.title,
      description: pack.description,
      hint: pack.hint,
      total: commands.length,
      installed,
      commands: commands.map((command) => ({ name: command.name, phrase: command.phrases[0] })),
    };
  });
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
  PACK_TOOLS,
  getPack,
  availableCommands,
  unsupportedCommands,
  buildPackCommandJson,
  describePacks,
  seedPackCommands,
  isCommandSupported,
  missingKeys,
};
