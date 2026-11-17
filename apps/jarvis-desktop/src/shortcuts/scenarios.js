'use strict';

const { parseOffline } = require('./offline');
const { stripWake, hasWakePrefix, stripFillers, matchCommand, FILLER_WORDS } = require('../commands/match');
const { normalize: storeNormalize, DANGEROUS_TOOLS, TYPE_TO_TOOL, flattenStepTree } = require('../commands/store');
const { SAMPLE_COMMANDS } = require('../commands/samples');
const { MAX_MINUTES } = require('../tools/reminders');
const { screenTask } = require('../screen/agent');
const { resolveHint } = require('./hints');
const { isMusicRequest, cleanQuery, isResetServiceRequest, isPronounPlay, hasOtherSteps } = require('../music/intent');
const { isContextualMusicQuery, pickMusicPlan } = require('../music/context');

const SCENARIO_IDS = Object.freeze({
  LEAVE: 'leave',
  BOSS: 'boss',
  BREAK: 'break',
  TWO_WINDOWS: 'two_windows',
  WORK_MODE: 'work_mode',
});

const FORBIDDEN_PREFIXES = ['mission_', 'command_'];
const MAX_TEXT = 400;
const MAX_TOKENS = 60;
const MAX_PARTS = 10;
const MAX_STEPS = 12;

const VOLUME_PAUSE_STEP = Object.freeze({ tool: 'media_control', args: { action: 'pause', allowNoSession: true } });
const MINIMIZE_ALL_STEP = Object.freeze({ tool: 'windows_minimize_all', args: {} });
const MUTE_VOLUME_STEP = Object.freeze({ tool: 'volume_set', args: { percent: 0 } });
const LOCK_SCREEN_STEP = Object.freeze({ tool: 'ui_keys', args: { keys: 'win+l' } });
const TWO_WINDOWS_STEP = Object.freeze({ tool: 'windows_arrange', args: { layout: 'row', count: 2 } });

const SAFE_MUTE_PHRASES = new Set([
  'выключи звук',
  'отключи звук',
  'убери звук',
  'без звука',
]);

const FILLER_SET = new Set(FILLER_WORDS);

const LINK_SEQUENCES = Object.freeze([
  ['а', 'затем'],
  ['а', 'потом'],
  ['после', 'этого'],
  ['а', 'также'],
  ['затем'],
  ['потом'],
  ['и'],
]);

const LEADING_INTERROGATIVE_RE = /^(?:почему|зачем|откуда|куда|кто|кого|кому|кем|чего|чем|можно\s+ли|стоит\s+ли|правда\s+ли|объясни|расскажи|подскажи|когда|сколько|какой(?!-то|-нибудь|-либо)|какие(?!-то|-нибудь|-либо)|что(?!-то|-нибудь|-либо|\s+(?:то|нибудь|либо)))(?=$|\s|[^\p{L}\p{N}])|^как(?!-то)(?=$|\s|[^\p{L}\p{N}])|^какая(?!-то|-нибудь|-либо)(?!\s+погода(?=$|\s|[^\p{L}\p{N}]))(?=$|\s|[^\p{L}\p{N}])/iu;

const LEAVE_PHRASES = new Set([
  'я ухожу',
  'ухожу',
  'я ушел',
  'я ушла',
  'ухожу с рабочего места',
  'я пошел домой',
  'я пошла домой',
  'я домой',
  'ухожу домой',
]);

const BOSS_PHRASES = new Set([
  'босс идет',
  'начальник идет',
  'шеф идет',
  'кто то идет',
  'кто-то идет',
  'спрячь все',
  'быстро спрячь все',
  'скрой все',
  'быстро скрой все',
  'сверни все и замолчи',
  'режим босса',
]);

const TWO_WINDOWS_PHRASES = new Set([
  'два окна рядом',
  '2 окна рядом',
  'поставь два окна рядом',
  'поставь 2 окна рядом',
  'расположи два окна рядом',
  'расположи 2 окна рядом',
  'размести два окна рядом',
  'размести 2 окна рядом',
  'раздели экран на два окна',
  'раздели экран на 2 окна',
]);

const WORK_MODE_PHRASES = new Set([
  'режим работы',
  'рабочий режим',
  'начинаем работу',
  'работа',
  'включи режим работы',
  'включи рабочий режим',
  'включить режим работы',
  'включить рабочий режим',
  'запусти режим работы',
  'запусти рабочий режим',
  'запустить режим работы',
  'запустить рабочий режим',
  'активируй режим работы',
  'активируй рабочий режим',
  'открой рабочий режим',
  'переключи на рабочий режим',
  'перейди в рабочий режим',
  'перейти в рабочий режим',
  'старт работы',
]);

const BARE_BREAK_PHRASES = new Set([
  'перерыв',
  'я на перерыв',
  'ухожу на перерыв',
  'ушел на перерыв',
  'ушла на перерыв',
  'пошел на перерыв',
  'пошла на перерыв',
  'пойду на перерыв',
  'иду на перерыв',
  'делаю перерыв',
  'сделаю перерыв',
  'сделаю на перерыв',
  'делаю на перерыв',
  'возьму перерыв',
  'нужен перерыв',
]);

const BREAK_SPLIT_RE = /^(?:(?:я\s+)?(?:ухожу|ушел|ушла|пошел|пошла|пойду|иду|делаю|сделаю|хочу|возьму|сделать)\s+(?:на\s+)?|(?:я\s+на\s+)|(?:нужен\s+))?перерыв(?:\s+([\s\S]+))?$/i;

const RUSSIAN_UNITS = Object.freeze({
  один: 1,
  одна: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
});

const RUSSIAN_TEENS = Object.freeze({
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
});

const RUSSIAN_TENS = Object.freeze({
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
});

const RUSSIAN_HUNDREDS = Object.freeze({
  сто: 100,
  двести: 200,
  триста: 300,
  четыреста: 400,
  пятьсот: 500,
  шестьсот: 600,
  семьсот: 700,
  восемьсот: 800,
  девятьсот: 900,
});

const RUSSIAN_THOUSANDS = Object.freeze({
  тысяча: 1000,
  тысячи: 1000,
  тысячу: 1000,
  тысяч: 1000,
});

const SAMPLE_WORK_BY_NAME = new Map(
  SAMPLE_COMMANDS
    .filter((item) => item && (item.name === 'Работа' || item.name === 'Рабочий режим'))
    .map((item) => [item.name, item])
);

function cloneStep(step) {
  const args = step && step.args && typeof step.args === 'object' && !Array.isArray(step.args)
    ? JSON.parse(JSON.stringify(step.args))
    : {};
  return { tool: String(step && step.tool || ''), args };
}

function cloneStepTree(step) {
  if (!step || typeof step !== 'object') return { tool: '', args: {} };
  const rawArgs = (step.args && typeof step.args === 'object' && !Array.isArray(step.args))
    ? step.args
    : (step.params && typeof step.params === 'object' && !Array.isArray(step.params) ? step.params : {});
  const args = JSON.parse(JSON.stringify(rawArgs));
  const tool = String(step.tool || (step.type && TYPE_TO_TOOL[step.type]) || '');
  const out = { tool, args };
  if (Array.isArray(step.children) && step.children.length) {
    out.children = step.children.map(cloneStepTree);
  }
  return out;
}

function cloneStepTrees(steps) {
  return Array.isArray(steps) ? steps.map(cloneStepTree) : [];
}

function cloneSteps(steps) {
  return Array.isArray(steps) ? steps.map(cloneStep) : [];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isUntouchedSampleWorkCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return false;
  if (cmd.origin !== 'sample') return false;
  const template = SAMPLE_WORK_BY_NAME.get(cmd.name);
  if (!template) return false;
  const optionalCount = Array.isArray(cmd.optionalPhrases) ? cmd.optionalPhrases.length : 0;
  const tplOptionalCount = Array.isArray(template.optionalPhrases) ? template.optionalPhrases.length : 0;
  if (optionalCount !== tplOptionalCount) return false;

  const cmdPhrases = Array.isArray(cmd.phrases) ? cmd.phrases.map((p) => storeNormalize(String(p))) : [];
  const tplPhrases = Array.isArray(template.phrases) ? template.phrases.map((p) => storeNormalize(String(p))) : [];
  if (cmdPhrases.length !== tplPhrases.length) return false;
  for (let i = 0; i < tplPhrases.length; i += 1) {
    if (cmdPhrases[i] !== tplPhrases[i]) return false;
  }

  const cmdSteps = Array.isArray(cmd.steps) ? cmd.steps.map(cloneStep) : [];
  const tplSteps = template.steps.map(cloneStep);
  if (cmdSteps.length !== tplSteps.length) return false;
  return stableJson(cmdSteps) === stableJson(tplSteps);
}

function cleanBaseText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wakeOptsForCtx(ctx = {}) {
  if (ctx && ctx.wakeWords !== undefined) return { words: ctx.wakeWords };
  if (ctx && typeof ctx.wakeWord === 'string') return { word: ctx.wakeWord };
  return { word: 'джарвис' };
}

function cleanWithFillersStripped(text, wakeOpts) {
  const withoutWake = stripWake(String(text || ''), wakeOpts);
  const base = cleanBaseText(withoutWake);
  if (!base) return '';
  return stripFillers(base).replace(/\s+/g, ' ').trim();
}

function stripLeadingWakeAndFillers(text) {
  let out = String(text || '').trim();
  for (;;) {
    const next = out.replace(/^(?:джарвис|сэр|пожалуйста|пожалуста|пожалуйсто|пжлста|плиз)(?:[\s,!?;:.-]+|$)/iu, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function parseRussianNumberTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    const n = Number(tokens[0]);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }

  let total = 0;
  let current = 0;
  let seenHundred = false;
  let seenTen = false;
  let seenUnitOrTeen = false;
  let seenThousand = false;

  for (const raw of tokens) {
    const word = raw.toLowerCase().replace(/ё/g, 'е');
    if (word === 'ноль' || word === 'нуль') return null;
    if (Object.prototype.hasOwnProperty.call(RUSSIAN_THOUSANDS, word)) {
      if (seenThousand) return null;
      const mult = current === 0 ? 1 : current;
      total += mult * 1000;
      current = 0;
      seenThousand = true;
      seenHundred = false;
      seenTen = false;
      seenUnitOrTeen = false;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(RUSSIAN_HUNDREDS, word)) {
      if (seenHundred || seenTen || seenUnitOrTeen) return null;
      current += RUSSIAN_HUNDREDS[word];
      seenHundred = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(RUSSIAN_TENS, word)) {
      if (seenTen || seenUnitOrTeen) return null;
      current += RUSSIAN_TENS[word];
      seenTen = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(RUSSIAN_TEENS, word)) {
      if (seenTen || seenUnitOrTeen) return null;
      current += RUSSIAN_TEENS[word];
      seenUnitOrTeen = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(RUSSIAN_UNITS, word)) {
      if (seenUnitOrTeen) return null;
      current += RUSSIAN_UNITS[word];
      seenUnitOrTeen = true;
      continue;
    }
    return null;
  }

  const value = total + current;
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function parseBreakDuration(text) {
  if (typeof text !== 'string') return null;
  const cleaned = cleanWithFillersStripped(text);
  if (!cleaned) return null;

  const match = cleaned.match(BREAK_SPLIT_RE);
  if (!match || !match[1]) return null;

  let tail = match[1].trim();
  tail = tail.replace(/^на(?:\s+|$)/i, '').trim();
  if (!tail) return null;

  const words = tail.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const joined = words.join(' ');
  if (joined === 'полчаса' || joined === 'пол часа') return 30;
  if (joined === 'полтора часа') return 90;
  if (joined === 'час') return 60;
  if (joined === 'минуту' || joined === 'минута') return 1;

  const unit = words[words.length - 1];
  const countTokens = words.slice(0, -1);
  if (countTokens.length === 0) return null;

  let multiplier = 0;
  if (unit === 'минута' || unit === 'минуту' || unit === 'минуты' || unit === 'минут' || unit === 'мин') {
    multiplier = 1;
  } else if (unit === 'час' || unit === 'часа' || unit === 'часов' || unit === 'ч') {
    multiplier = 60;
  } else {
    return null;
  }

  const count = parseRussianNumberTokens(countTokens);
  if (count === null) return null;

  const minutes = count * multiplier;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return null;
  return minutes;
}

function isWholeReminderText(rawText) {
  const stripped = stripLeadingWakeAndFillers(rawText);
  return /^напомни(?=$|[\s,!?;:-])/i.test(stripped);
}

function getStoreCommands(store) {
  if (!store) return [];
  if (Array.isArray(store)) return store.filter(Boolean);
  if (typeof store.list === 'function') {
    const items = store.list();
    return Array.isArray(items) ? items.filter(Boolean) : [];
  }
  if (Array.isArray(store.items)) return store.items.filter(Boolean);
  if (Array.isArray(store.commands)) return store.commands.filter(Boolean);
  return [];
}

function getLibraryEntry(libraryByPhrase, phrase) {
  if (!libraryByPhrase || typeof phrase !== 'string' || !phrase.trim()) return null;
  const candidates = [];
  try {
    const direct = storeNormalize(phrase);
    if (direct) candidates.push(direct);
  } catch {}
  try {
    const stripped = storeNormalize(cleanWithFillersStripped(phrase));
    if (stripped && !candidates.includes(stripped)) candidates.push(stripped);
  } catch {}

  for (const key of candidates) {
    if (typeof libraryByPhrase.get === 'function') {
      const hit = libraryByPhrase.get(key);
      if (hit) return hit;
    } else if (typeof libraryByPhrase === 'object' && Object.prototype.hasOwnProperty.call(libraryByPhrase, key)) {
      const hit = libraryByPhrase[key];
      if (hit) return hit;
    }
  }
  return null;
}

function isStepAllowed(step, ctx = {}) {
  if (!step || typeof step !== 'object') return false;
  const toolName = String(step.tool || (step.type && TYPE_TO_TOOL[step.type]) || '').trim();
  if (!toolName) return false;
  const stepArgs = (step.args && typeof step.args === 'object' && !Array.isArray(step.args))
    ? step.args
    : (step.params && typeof step.params === 'object' && !Array.isArray(step.params) ? step.params : {});
  if (DANGEROUS_TOOLS.has(toolName)) return false;
  if (FORBIDDEN_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return false;

  if (typeof ctx.commandsToolCheck === 'function') {
    try {
      const res = ctx.commandsToolCheck(toolName, stepArgs, step);
      if (!res || (typeof res === 'object' && res.ok === false)) return false;
    } catch {
      return false;
    }
  }

  if (ctx.remoteAllowed === false) return false;
  if (typeof ctx.remoteAllowed === 'function') {
    try {
      const res = ctx.remoteAllowed(toolName, step);
      if (!res || (typeof res === 'object' && res.ok === false)) return false;
    } catch {
      return false;
    }
  }

  if (Array.isArray(step.children) && step.children.length > 0) {
    return step.children.every((child) => isStepAllowed(child, ctx));
  }

  return true;
}

function areStepsAllowed(steps, ctx = {}) {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps.every((step) => isStepAllowed(step, ctx));
}

function normalizeAppResult(res) {
  if (res === true) return true;
  if (!res || typeof res !== 'object') return false;
  if (typeof res.then === 'function') return false;
  if (res.available === true || res.found === true || res.ok === true) return true;
  return false;
}

function checkInventoryHasApp(inventory, appName) {
  if (!inventory || typeof inventory !== 'object' || !appName) return false;
  if (!inventory.scannedAt) return false;

  if (typeof inventory.resolveExe === 'function') {
    const resolved = inventory.resolveExe(appName);
    if (resolved) return true;
  }
  if (typeof inventory.find === 'function') {
    const found = inventory.find(appName);
    if (Array.isArray(found) && found.length > 0) return true;
    if (found && !Array.isArray(found) && typeof found === 'object') return true;
  }
  if (Array.isArray(inventory.entries) && inventory.entries.length > 0) {
    const needle = appName.trim().toLowerCase();
    return inventory.entries.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const name = String(entry.name || '').toLowerCase();
      const exe = String(entry.exe || '').toLowerCase();
      return (name && (name === needle || name.includes(needle)))
        || (exe && (exe === needle || exe.replace(/\.exe$/i, '') === needle || exe.includes(needle)));
    });
  }
  return false;
}

function isAppAvailableSync(appName, ctx = {}) {
  const clean = typeof appName === 'string' ? appName.trim() : '';
  if (!clean) return false;
  if (typeof ctx.isAppAvailable === 'function') {
    try {
      return normalizeAppResult(ctx.isAppAvailable(clean));
    } catch {
      return false;
    }
  }
  return checkInventoryHasApp(ctx.appInventory, clean);
}

async function isAppAvailableAsync(appName, ctx = {}) {
  const clean = typeof appName === 'string' ? appName.trim() : '';
  if (!clean) return false;
  if (typeof ctx.isAppAvailable === 'function') {
    try {
      const res = await ctx.isAppAvailable(clean);
      return normalizeAppResult(res);
    } catch {
      return false;
    }
  }
  return checkInventoryHasApp(ctx.appInventory, clean);
}

function validateSafeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname) return null;
    return trimmed;
  } catch {
    return null;
  }
}

function findCustomWorkCommand(phrase, ctx = {}) {
  const allCommands = getStoreCommands(ctx.store).filter((cmd) => cmd && cmd.enabled !== false);
  const workMode = ctx.workMode && typeof ctx.workMode === 'object' ? ctx.workMode : null;

  if (workMode && typeof workMode.commandId === 'string' && workMode.commandId.trim()) {
    const byId = allCommands.find((cmd) => cmd.id === workMode.commandId.trim());
    if (byId && !isUntouchedSampleWorkCommand(byId)) return byId;
  }

  const eligible = allCommands.filter((cmd) => !isUntouchedSampleWorkCommand(cmd));
  const hit = matchCommand(phrase, eligible);
  if (hit && hit.command) return hit.command;
  return null;
}

function isWorkModeConfigured(workMode) {
  if (!workMode || typeof workMode !== 'object') return false;
  const hasApps = Array.isArray(workMode.apps) && workMode.apps.some((a) => typeof a === 'string' && a.trim() !== '');
  const hasUrls = Array.isArray(workMode.urls) && workMode.urls.some((u) => typeof u === 'string' && u.trim() !== '');
  const hasMin = workMode.minimizeWindows === true;
  const hasVol = typeof workMode.volume === 'number' && Number.isFinite(workMode.volume) && workMode.volume >= 0 && workMode.volume <= 100;
  return hasApps || hasUrls || hasMin || hasVol;
}

function filterWorkCommandStepsSync(cmd, ctx) {
  const rawSteps = Array.isArray(cmd.steps) ? cmd.steps.map(cloneStep) : [];
  if (!areStepsAllowed(rawSteps, ctx)) return { disallowed: true };

  const notes = [];
  const kept = [];
  let skippedAny = false;

  for (const step of rawSteps) {
    if (step.tool === 'app_open') {
      const appName = String((step.args && (step.args.name || step.args.app || step.args.target)) || '').trim();
      if (!appName || !isAppAvailableSync(appName, ctx)) {
        skippedAny = true;
        notes.push(`Приложение «${appName || '?'}» не найдено — шаг пропущен.`);
        continue;
      }
      kept.push(step);
      continue;
    }
    if (step.tool === 'url_open') {
      const safeUrl = validateSafeUrl(step.args && step.args.url);
      if (!safeUrl) {
        skippedAny = true;
        notes.push(`Ссылка «${String(step.args && step.args.url || '')}» пропущена: некорректный или небезопасный адрес.`);
        continue;
      }
      kept.push({ tool: 'url_open', args: { ...step.args, url: safeUrl } });
      continue;
    }
    kept.push(step);
  }

  const actionable = kept.filter((s) => s.tool !== 'wait');
  const realActionable = kept.filter((s) => s.tool !== 'wait' && s.tool !== 'speak');
  if (actionable.length === 0 || (skippedAny && realActionable.length === 0)) {
    return {
      disallowed: false,
      result: {
        kind: 'reply',
        scenarioId: SCENARIO_IDS.WORK_MODE,
        title: 'Режим работы',
        text: 'Не удалось запустить режим работы: нужные программы или ссылки недоступны.',
        notes,
      },
    };
  }

  return {
    disallowed: false,
    result: {
      kind: 'command',
      scenarioId: SCENARIO_IDS.WORK_MODE,
      isSequence: false,
      title: cmd.name || 'Режим работы',
      name: cmd.name || 'Режим работы',
      source: 'command',
      ownerCommand: true,
      parts: [{
        title: cmd.name || 'Режим работы',
        source: 'command',
        commandId: cmd.id,
        commandName: cmd.name,
        steps: kept,
      }],
      steps: kept,
      notes,
    },
  };
}

async function filterWorkCommandStepsAsync(cmd, ctx) {
  const rawSteps = Array.isArray(cmd.steps) ? cmd.steps.map(cloneStep) : [];
  if (!areStepsAllowed(rawSteps, ctx)) return { disallowed: true };

  const notes = [];
  const kept = [];
  let skippedAny = false;

  for (const step of rawSteps) {
    if (step.tool === 'app_open') {
      const appName = String((step.args && (step.args.name || step.args.app || step.args.target)) || '').trim();
      if (!appName || !(await isAppAvailableAsync(appName, ctx))) {
        skippedAny = true;
        notes.push(`Приложение «${appName || '?'}» не найдено — шаг пропущен.`);
        continue;
      }
      kept.push(step);
      continue;
    }
    if (step.tool === 'url_open') {
      const safeUrl = validateSafeUrl(step.args && step.args.url);
      if (!safeUrl) {
        skippedAny = true;
        notes.push(`Ссылка «${String(step.args && step.args.url || '')}» пропущена: некорректный или небезопасный адрес.`);
        continue;
      }
      kept.push({ tool: 'url_open', args: { ...step.args, url: safeUrl } });
      continue;
    }
    kept.push(step);
  }

  const actionable = kept.filter((s) => s.tool !== 'wait');
  const realActionable = kept.filter((s) => s.tool !== 'wait' && s.tool !== 'speak');
  if (actionable.length === 0 || (skippedAny && realActionable.length === 0)) {
    return {
      disallowed: false,
      result: {
        kind: 'reply',
        scenarioId: SCENARIO_IDS.WORK_MODE,
        title: 'Режим работы',
        text: 'Не удалось запустить режим работы: нужные программы или ссылки недоступны.',
        notes,
      },
    };
  }

  return {
    disallowed: false,
    result: {
      kind: 'command',
      scenarioId: SCENARIO_IDS.WORK_MODE,
      isSequence: false,
      title: cmd.name || 'Режим работы',
      name: cmd.name || 'Режим работы',
      source: 'command',
      ownerCommand: true,
      parts: [{
        title: cmd.name || 'Режим работы',
        source: 'command',
        commandId: cmd.id,
        commandName: cmd.name,
        steps: kept,
      }],
      steps: kept,
      notes,
    },
  };
}

function buildWorkModeFromSettingsSync(workMode, ctx) {
  const steps = [];
  const notes = [];

  if (workMode.minimizeWindows === true) {
    steps.push(cloneStep(MINIMIZE_ALL_STEP));
  }
  if (typeof workMode.volume === 'number' && Number.isFinite(workMode.volume) && workMode.volume >= 0 && workMode.volume <= 100) {
    steps.push({ tool: 'volume_set', args: { percent: Math.round(workMode.volume) } });
  }
  if (Array.isArray(workMode.urls)) {
    for (const rawUrl of workMode.urls) {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
      const safeUrl = validateSafeUrl(rawUrl);
      if (!safeUrl) {
        notes.push(`Ссылка «${rawUrl.trim()}» пропущена: некорректный или небезопасный адрес.`);
        continue;
      }
      steps.push({ tool: 'url_open', args: { url: safeUrl } });
    }
  }
  if (Array.isArray(workMode.apps)) {
    for (const rawApp of workMode.apps) {
      if (typeof rawApp !== 'string' || !rawApp.trim()) continue;
      const appName = rawApp.trim();
      if (!isAppAvailableSync(appName, ctx)) {
        notes.push(`Приложение «${appName}» не найдено — шаг пропущен.`);
        continue;
      }
      steps.push({ tool: 'app_open', args: { name: appName } });
    }
  }

  if (steps.length === 0) {
    return {
      kind: 'reply',
      scenarioId: SCENARIO_IDS.WORK_MODE,
      title: 'Режим работы',
      text: 'Не удалось запустить режим работы: указанные программы или ссылки недоступны.',
      notes,
    };
  }
  if (!areStepsAllowed(steps, ctx)) return null;

  return {
    kind: 'command',
    scenarioId: SCENARIO_IDS.WORK_MODE,
    isSequence: false,
    title: 'Режим работы',
    name: 'Режим работы',
    source: 'scenario',
    ownerCommand: false,
    parts: [{ title: 'Режим работы', source: 'scenario', steps: cloneSteps(steps) }],
    steps,
    notes,
  };
}

async function buildWorkModeFromSettingsAsync(workMode, ctx) {
  const steps = [];
  const notes = [];

  if (workMode.minimizeWindows === true) {
    steps.push(cloneStep(MINIMIZE_ALL_STEP));
  }
  if (typeof workMode.volume === 'number' && Number.isFinite(workMode.volume) && workMode.volume >= 0 && workMode.volume <= 100) {
    steps.push({ tool: 'volume_set', args: { percent: Math.round(workMode.volume) } });
  }
  if (Array.isArray(workMode.urls)) {
    for (const rawUrl of workMode.urls) {
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
      const safeUrl = validateSafeUrl(rawUrl);
      if (!safeUrl) {
        notes.push(`Ссылка «${rawUrl.trim()}» пропущена: некорректный или небезопасный адрес.`);
        continue;
      }
      steps.push({ tool: 'url_open', args: { url: safeUrl } });
    }
  }
  if (Array.isArray(workMode.apps)) {
    for (const rawApp of workMode.apps) {
      if (typeof rawApp !== 'string' || !rawApp.trim()) continue;
      const appName = rawApp.trim();
      if (!(await isAppAvailableAsync(appName, ctx))) {
        notes.push(`Приложение «${appName}» не найдено — шаг пропущен.`);
        continue;
      }
      steps.push({ tool: 'app_open', args: { name: appName } });
    }
  }

  if (steps.length === 0) {
    return {
      kind: 'reply',
      scenarioId: SCENARIO_IDS.WORK_MODE,
      title: 'Режим работы',
      text: 'Не удалось запустить режим работы: указанные программы или ссылки недоступны.',
      notes,
    };
  }
  if (!areStepsAllowed(steps, ctx)) return null;

  return {
    kind: 'command',
    scenarioId: SCENARIO_IDS.WORK_MODE,
    isSequence: false,
    title: 'Режим работы',
    name: 'Режим работы',
    source: 'scenario',
    ownerCommand: false,
    parts: [{ title: 'Режим работы', source: 'scenario', steps: cloneSteps(steps) }],
    steps,
    notes,
  };
}

function unconfiguredWorkModeReply() {
  return {
    kind: 'reply',
    scenarioId: SCENARIO_IDS.WORK_MODE,
    title: 'Режим работы',
    text: 'Режим работы ещё не настроен: укажите программы или ссылки в настройках или создайте свою команду «Рабочий режим».',
    notes: [],
  };
}

function resolveWorkModeSync(phrase, ctx = {}) {
  const customCmd = findCustomWorkCommand(phrase, ctx);
  if (customCmd) {
    const out = filterWorkCommandStepsSync(customCmd, ctx);
    return out.disallowed ? null : out.result;
  }
  if (isWorkModeConfigured(ctx.workMode)) {
    return buildWorkModeFromSettingsSync(ctx.workMode, ctx);
  }
  return unconfiguredWorkModeReply();
}

async function resolveWorkModeAsync(phrase, ctx = {}) {
  const customCmd = findCustomWorkCommand(phrase, ctx);
  if (customCmd) {
    const out = await filterWorkCommandStepsAsync(customCmd, ctx);
    return out.disallowed ? null : out.result;
  }
  if (isWorkModeConfigured(ctx.workMode)) {
    return buildWorkModeFromSettingsAsync(ctx.workMode, ctx);
  }
  return unconfiguredWorkModeReply();
}

function resolveBuiltInNonWorkScenario(rawPhrase, ctx = {}) {
  const cleaned = cleanWithFillersStripped(rawPhrase);
  if (!cleaned) return null;

  if (TWO_WINDOWS_PHRASES.has(cleaned)) {
    const steps = [cloneStep(TWO_WINDOWS_STEP)];
    if (!areStepsAllowed(steps, ctx)) return { result: null, hardStop: true };
    return {
      result: {
        kind: 'command',
        scenarioId: SCENARIO_IDS.TWO_WINDOWS,
        isSequence: false,
        title: 'Два окна рядом',
        name: 'Два окна рядом',
        source: 'scenario',
        ownerCommand: false,
        parts: [{ title: 'Два окна рядом', source: 'scenario', steps: cloneSteps(steps) }],
        steps,
        notes: [],
      },
      hardStop: false,
    };
  }

  if (LEAVE_PHRASES.has(cleaned)) {
    const steps = [
      cloneStep(MINIMIZE_ALL_STEP),
      cloneStep(VOLUME_PAUSE_STEP),
      cloneStep(MUTE_VOLUME_STEP),
      cloneStep(LOCK_SCREEN_STEP),
    ];
    if (!areStepsAllowed(steps, ctx)) return { result: null, hardStop: true };
    return {
      result: {
        kind: 'command',
        scenarioId: SCENARIO_IDS.LEAVE,
        isSequence: false,
        title: 'Я ухожу',
        name: 'Я ухожу',
        source: 'scenario',
        ownerCommand: false,
        parts: [{ title: 'Я ухожу', source: 'scenario', steps: cloneSteps(steps) }],
        steps,
        notes: [],
      },
      hardStop: false,
    };
  }

  if (BOSS_PHRASES.has(cleaned)) {
    const steps = [
      cloneStep(MINIMIZE_ALL_STEP),
      cloneStep(VOLUME_PAUSE_STEP),
      cloneStep(MUTE_VOLUME_STEP),
    ];
    if (!areStepsAllowed(steps, ctx)) return { result: null, hardStop: true };
    return {
      result: {
        kind: 'command',
        scenarioId: SCENARIO_IDS.BOSS,
        isSequence: false,
        title: 'Босс идёт',
        name: 'Босс идёт',
        source: 'scenario',
        ownerCommand: false,
        parts: [{ title: 'Босс идёт', source: 'scenario', steps: cloneSteps(steps) }],
        steps,
        notes: [],
      },
      hardStop: false,
    };
  }

  if (BARE_BREAK_PHRASES.has(cleaned)) {
    const steps = [
      cloneStep(VOLUME_PAUSE_STEP),
      cloneStep(MINIMIZE_ALL_STEP),
    ];
    if (!areStepsAllowed(steps, ctx)) return { result: null, hardStop: true };
    return {
      result: {
        kind: 'command',
        scenarioId: SCENARIO_IDS.BREAK,
        isSequence: false,
        title: 'Перерыв',
        name: 'Перерыв',
        source: 'scenario',
        ownerCommand: false,
        parts: [{ title: 'Перерыв', source: 'scenario', steps: cloneSteps(steps) }],
        steps,
        notes: ['Напоминание не создано: длительность перерыва не указана.'],
      },
      hardStop: false,
    };
  }

  const breakMatch = cleaned.match(BREAK_SPLIT_RE);
  if (breakMatch) {
    const minutes = parseBreakDuration(cleaned);
    if (minutes === null) {
      return { result: null, hardStop: true };
    }
    const steps = [
      cloneStep(VOLUME_PAUSE_STEP),
      cloneStep(MINIMIZE_ALL_STEP),
      { tool: 'remind_in', args: { minutes, text: 'Перерыв закончился' } },
    ];
    if (!areStepsAllowed(steps, ctx)) return { result: null, hardStop: true };
    return {
      result: {
        kind: 'command',
        scenarioId: SCENARIO_IDS.BREAK,
        isSequence: false,
        title: `Перерыв (${minutes} мин)`,
        name: `Перерыв (${minutes} мин)`,
        source: 'scenario',
        ownerCommand: false,
        parts: [{ title: `Перерыв (${minutes} мин)`, source: 'scenario', steps: cloneSteps(steps) }],
        steps,
        notes: [],
      },
      hardStop: false,
    };
  }

  return null;
}

function tryOfflineSingle(text, ctx = {}) {
  const candidates = [String(text || '')];
  const stripped = stripLeadingWakeAndFillers(cleanWithoutDestroyingUrls(text));
  if (stripped && !candidates.includes(stripped)) candidates.push(stripped);

  for (const candidate of candidates) {
    const hit = parseOffline(candidate);
    if (!hit) continue;
    const steps = cloneSteps(hit.steps);
    if (!areStepsAllowed(steps, ctx)) return { result: null, blocked: true };
    return {
      result: {
        kind: 'command',
        isSequence: false,
        title: hit.title,
        name: hit.title,
        source: 'offline',
        ownerCommand: false,
        parts: [{ title: hit.title, source: 'offline', steps: cloneSteps(steps) }],
        steps,
        notes: [],
      },
      blocked: false,
    };
  }

  const cleanedMute = cleanWithFillersStripped(text);
  if (SAFE_MUTE_PHRASES.has(cleanedMute)) {
    const steps = [cloneStep(MUTE_VOLUME_STEP)];
    if (!areStepsAllowed(steps, ctx)) return { result: null, blocked: true };
    return {
      result: {
        kind: 'command',
        isSequence: false,
        title: 'выключить звук',
        name: 'выключить звук',
        source: 'offline',
        ownerCommand: false,
        parts: [{ title: 'выключить звук', source: 'offline', steps: cloneSteps(steps) }],
        steps,
        notes: [],
      },
      blocked: false,
    };
  }
  return null;
}

function cleanWithoutDestroyingUrls(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  const kept = [];
  for (const part of parts) {
    const trimmed = part.replace(/^[,;!?«»"']+|[,;!?«»"']+$/g, '');
    const lower = trimmed.toLowerCase().replace(/ё/g, 'е');
    if (!trimmed) continue;
    if (FILLER_SET.has(lower)) continue;
    kept.push(trimmed);
  }
  return kept.join(' ');
}

function matchUserCommandSingle(phrase, eligibleCommands, ctx = {}) {
  if (!eligibleCommands || eligibleCommands.length === 0) return null;
  const hit = matchCommand(phrase, eligibleCommands, wakeOptsForCtx(ctx));
  if (!hit || !hit.command) return null;
  const steps = cloneStepTrees(hit.command.steps);
  if (!areStepsAllowed(steps, ctx)) return { result: null, blocked: true };
  return {
    result: {
      kind: 'command',
      isSequence: false,
      title: hit.command.name,
      name: hit.command.name,
      source: 'command',
      ownerCommand: true,
      schemaVersion: hit.command.schemaVersion,
      confirm: hit.command.confirm === true,
      parts: [{
        title: hit.command.name,
        source: 'command',
        commandId: hit.command.id,
        commandName: hit.command.name,
        schemaVersion: hit.command.schemaVersion,
        steps: cloneStepTrees(steps),
      }],
      steps,
      notes: [],
    },
    blocked: false,
  };
}

function matchLibrarySingle(phrase, ctx = {}) {
  if (ctx.scoped) return null;
  const entry = getLibraryEntry(ctx.libraryByPhrase, phrase);
  if (!entry) return null;
  const rawSteps = Array.isArray(entry.steps) && entry.steps.length
    ? entry.steps
    : [{ tool: `lib_${entry.id}`, args: {} }];
  const steps = cloneSteps(rawSteps);
  if (!areStepsAllowed(steps, ctx)) return { result: null, blocked: true };
  const title = entry.title || entry.name || 'Команда библиотеки';
  return {
    result: {
      kind: 'command',
      isSequence: false,
      title,
      name: title,
      source: 'library',
      ownerCommand: false,
      parts: [{ title, source: 'library', steps: cloneSteps(steps) }],
      steps,
      notes: [],
    },
    blocked: false,
  };
}

function resolveSegmentSync(phrase, eligibleCommands, ctx = {}) {
  const cleaned = cleanWithFillersStripped(phrase);
  if (WORK_MODE_PHRASES.has(cleaned)) {
    const wm = resolveWorkModeSync(phrase, ctx);
    if (!wm || wm.kind !== 'command') return null;
    return wm;
  }

  const userHit = matchUserCommandSingle(phrase, eligibleCommands, ctx);
  if (userHit) return userHit.result;

  const scenHit = resolveBuiltInNonWorkScenario(phrase, ctx);
  if (scenHit) return scenHit.result;

  const offHit = tryOfflineSingle(phrase, ctx);
  if (offHit) return offHit.result;

  const libHit = matchLibrarySingle(phrase, ctx);
  if (libHit) return libHit.result;

  return null;
}

async function resolveSegmentAsync(phrase, eligibleCommands, ctx = {}) {
  const cleaned = cleanWithFillersStripped(phrase);
  if (WORK_MODE_PHRASES.has(cleaned)) {
    const wm = await resolveWorkModeAsync(phrase, ctx);
    if (!wm || wm.kind !== 'command') return null;
    return wm;
  }

  const userHit = matchUserCommandSingle(phrase, eligibleCommands, ctx);
  if (userHit) return userHit.result;

  const scenHit = resolveBuiltInNonWorkScenario(phrase, ctx);
  if (scenHit) return scenHit.result;

  const offHit = tryOfflineSingle(phrase, ctx);
  if (offHit) return offHit.result;

  const libHit = matchLibrarySingle(phrase, ctx);
  if (libHit) return libHit.result;

  return null;
}

function tokenizeForCompound(rawText) {
  const rawTokens = [];
  const chunks = String(rawText || '').trim().split(/\s+/).filter(Boolean);

  for (const chunk of chunks) {
    if (/^https?:\/\//i.test(chunk)) {
      let url = chunk;
      const trailingSeps = [];
      for (;;) {
        const m = url.match(/([,;!?»"')]+)$/);
        if (!m) break;
        const tail = m[1];
        url = url.slice(0, -tail.length);
        for (const ch of tail) {
          if (ch === ',' || ch === ';') trailingSeps.push({ kind: 'comma' });
        }
      }
      if (url) rawTokens.push({ kind: 'word', raw: url, lower: url.toLowerCase().replace(/ё/g, 'е') });
      for (const sep of trailingSeps) rawTokens.push(sep);
      continue;
    }

    let current = '';
    for (const ch of chunk) {
      if (ch === ',' || ch === ';') {
        if (current) {
          const cleaned = current.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
          if (cleaned) {
            const lower = cleaned.toLowerCase().replace(/ё/g, 'е');
            rawTokens.push({
              kind: FILLER_SET.has(lower) ? 'filler' : 'word',
              raw: cleaned,
              lower,
            });
          }
          current = '';
        }
        rawTokens.push({ kind: 'comma' });
      } else {
        current += ch;
      }
    }
    if (current) {
      const cleaned = current.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      if (cleaned) {
        const lower = cleaned.toLowerCase().replace(/ё/g, 'е');
        rawTokens.push({
          kind: FILLER_SET.has(lower) ? 'filler' : 'word',
          raw: cleaned,
          lower,
        });
      }
    }
  }

  // Collapse fillers adjacent to commas into transparent optional boundary tokens (<fcomma>)
  // and drop isolated bare fillers cleanly.
  const collapsed = [];
  let i = 0;
  while (i < rawTokens.length) {
    if (rawTokens[i].kind === 'word') {
      collapsed.push(rawTokens[i]);
      i += 1;
      continue;
    }

    // Scan contiguous block of comma / filler tokens
    let hasComma = false;
    let hasFiller = false;
    while (i < rawTokens.length && rawTokens[i].kind !== 'word') {
      if (rawTokens[i].kind === 'comma') hasComma = true;
      if (rawTokens[i].kind === 'filler') hasFiller = true;
      i += 1;
    }
    if (hasComma && !hasFiller) {
      collapsed.push({ kind: 'comma' });
    } else if (hasComma && hasFiller) {
      collapsed.push({ kind: 'fcomma' });
    }
    // Isolated filler(s) with no comma are simply omitted.
  }

  while (collapsed.length && collapsed[0].kind !== 'word') collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].kind !== 'word') collapsed.pop();
  return collapsed;
}

function compoundLinkSequences(words) {
  if (!Array.isArray(words)) return LINK_SEQUENCES;
  return words.map((word) => cleanBaseText(word).split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0).sort((a, b) => b.length - a.length);
}

function linkerWordLengthAt(tokens, index, links) {
  for (const seq of links) {
    if (index + seq.length > tokens.length) continue;
    let match = true;
    for (let k = 0; k < seq.length; k += 1) {
      const tok = tokens[index + k];
      if (!tok || tok.kind !== 'word' || tok.lower !== seq[k]) {
        match = false;
        break;
      }
    }
    if (match) return seq.length;
  }
  return 0;
}

// Returns array of valid next-segment start indices reachable from separator position `sepStart`.
function nextStartsFromSeparator(tokens, sepStart, links) {
  const results = [];
  if (sepStart >= tokens.length) return results;

  let idx = sepStart;
  let sawPunct = false;
  while (idx < tokens.length && (tokens[idx].kind === 'comma' || tokens[idx].kind === 'fcomma')) {
    sawPunct = true;
    idx += 1;
  }

  if (sawPunct && idx < tokens.length && tokens[idx].kind === 'word') {
    results.push(idx);
  }

  const linkLen = linkerWordLengthAt(tokens, idx, links);
  if (linkLen > 0) {
    let afterLink = idx + linkLen;
    while (afterLink < tokens.length && (tokens[afterLink].kind === 'comma' || tokens[afterLink].kind === 'fcomma')) {
      afterLink += 1;
    }
    if (afterLink < tokens.length && tokens[afterLink].kind === 'word') {
      if (!results.includes(afterLink)) results.push(afterLink);
    }
  }

  return results;
}

function buildChunkText(tokens, start, end) {
  const words = [];
  for (let i = start; i <= end; i += 1) {
    const tok = tokens[i];
    if (tok.kind === 'comma') return null; // never cross a hard comma/semicolon
    if (tok.kind === 'word') words.push(tok.raw);
  }
  return words.length ? words.join(' ') : null;
}

// Непонятый кусок фразы словами: без ведущих запятых и связок («, и найди…» → «найди…»).
// Нужен только для честной заметки «что не понято»: шагов из него не строим.
function unresolvedText(tokens, start, end, links) {
  let i = start;
  for (;;) {
    while (i <= end && (tokens[i].kind === 'comma' || tokens[i].kind === 'fcomma')) i += 1;
    const linkLen = linkerWordLengthAt(tokens, i, links);
    if (linkLen > 0 && i + linkLen <= end + 1) {
      i += linkLen;
      continue;
    }
    break;
  }
  const words = [];
  for (; i <= end && i < tokens.length; i += 1) {
    if (tokens[i].kind === 'word') words.push(tokens[i].raw);
    else if (words.length && words[words.length - 1] !== ',') words.push(',');
  }
  const text = words.join(' ').replace(/\s+,/g, ',').trim();
  return text || null;
}

// Сколько кусков во фразе и есть ли между ними разделитель. Куски — то, что разделено запятой
// или связкой; из них собирается составной план.
function compoundChunkInfo(tokens, links = LINK_SEQUENCES) {
  let chunks = 0;
  let words = 0;
  let sawSeparator = false;
  for (let i = 0; i < tokens.length;) {
    const tok = tokens[i];
    if (tok.kind === 'comma' || tok.kind === 'fcomma') {
      sawSeparator = true;
      if (words > 0) {
        chunks += 1;
        words = 0;
      }
      i += 1;
      continue;
    }
    const linkLen = linkerWordLengthAt(tokens, i, links);
    if (linkLen > 0 && words > 0) {
      sawSeparator = true;
      chunks += 1;
      words = 0;
      i += linkLen;
      continue;
    }
    words += 1;
    i += 1;
  }
  if (words > 0) chunks += 1;
  return { chunks, sawSeparator };
}

// Явно составная фраза: есть разделитель (запятая, «и», «затем», «потом») и не меньше двух кусков.
// Такую фразу составной разбор пробует раньше одиночных перехватов: иначе одна часть (курс)
// отвечает за всю фразу и остальные просьбы теряются (DEMO 1, 12-я фаза).
function looksLikeCompoundPhrase(rawText, links = LINK_SEQUENCES) {
  const tokens = tokenizeForCompound(rawText);
  if (tokens.length < 3) return false;
  const info = compoundChunkInfo(tokens, links);
  return info.sawSeparator && info.chunks >= 2;
}

function finalizeCompoundParts(parts, ctx = {}) {
  if (!parts || parts.length < 2 || parts.length > MAX_PARTS) return null;

  const steps = [];
  const flatParts = [];
  const notes = [];
  const sources = new Set();

  for (const part of parts) {
    sources.add(part.source);
    if (Array.isArray(part.notes)) notes.push(...part.notes);
    for (const p of part.parts) flatParts.push(p);
    for (const s of part.steps) {
      steps.push(cloneStepTree(s));
      if (flattenStepTree(steps).length > MAX_STEPS) return null;
    }
  }

  if (!areStepsAllowed(steps, ctx)) return null;

  const source = sources.size === 1 ? [...sources][0] : 'mixed';
  const ownerCommand = source === 'command';
  const title = flatParts.map((p) => p.title).filter(Boolean).join(', ');
  const maxSchemaVersion = parts.reduce((m, p) => Math.max(m, Number(p.schemaVersion) || 0), 0);

  return {
    kind: 'command',
    isSequence: true,
    title,
    name: title,
    source,
    ownerCommand,
    ...(maxSchemaVersion >= 3 ? { schemaVersion: maxSchemaVersion } : {}),
    parts: flatParts,
    steps,
    notes,
  };
}

// Частичный составной план: выполняем только то, что поняли, а непонятое честно называем.
// Выдуманных шагов нет: каждая часть — настоящий разобранный сценарий.
function finalizePartialCompoundParts(parts, unresolved, ctx = {}) {
  const unknown = (Array.isArray(unresolved) ? unresolved : []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!unknown.length) return null;
  const plan = finalizeCompoundParts(parts, ctx);
  if (!plan) return null;
  const note = `Не понято: «${unknown.join('», «')}». Это не выполнено — скажите иначе.`;
  return {
    ...plan,
    partial: true,
    unresolved: unknown,
    notes: [...(plan.notes || []), note],
    title: `${plan.title} (не всё понято)`,
    name: `${plan.title} (не всё понято)`,
  };
}

function resolveCompoundSync(rawText, eligibleCommands, ctx = {}) {
  const tokens = tokenizeForCompound(rawText);
  if (tokens.length < 2) return null;
  const links = compoundLinkSequences(ctx.linkWords);

  const segCache = new Map();
  const memo = new Map();

  function lookupSeg(start, end) {
    const key = `${start}:${end}`;
    if (segCache.has(key)) return segCache.get(key);
    const chunkText = buildChunkText(tokens, start, end);
    const resolved = chunkText ? resolveSegmentSync(chunkText, eligibleCommands, ctx) : null;
    segCache.set(key, resolved);
    return resolved;
  }

  function dfs(start, depth) {
    if (start >= tokens.length) return [];
    if (depth >= MAX_PARTS) return null;
    const memoKey = `${start}:${depth}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    for (let end = tokens.length - 1; end >= start; end -= 1) {
      if (tokens[end].kind !== 'word') continue;
      const candidate = lookupSeg(start, end);
      if (!candidate) continue;

      if (end === tokens.length - 1) {
        if (depth === 0) continue; // single-segment handled outside compound
        const found = [candidate];
        memo.set(memoKey, found);
        return found;
      }

      const nextStarts = nextStartsFromSeparator(tokens, end + 1, links);
      for (const nextStart of nextStarts) {
        const rest = dfs(nextStart, depth + 1);
        if (rest) {
          const found = [candidate, ...rest];
          memo.set(memoKey, found);
          return found;
        }
      }
    }

    memo.set(memoKey, null);
    return null;
  }

  const matchedParts = dfs(0, 0);
  return finalizeCompoundParts(matchedParts, ctx);
}

async function resolveCompoundAsync(rawText, eligibleCommands, ctx = {}) {
  const tokens = tokenizeForCompound(rawText);
  if (tokens.length < 2) return null;
  const links = compoundLinkSequences(ctx.linkWords);

  const segCache = new Map();
  const memo = new Map();

  async function lookupSeg(start, end) {
    const key = `${start}:${end}`;
    if (segCache.has(key)) return segCache.get(key);
    const chunkText = buildChunkText(tokens, start, end);
    const resolved = chunkText ? await resolveSegmentAsync(chunkText, eligibleCommands, ctx) : null;
    segCache.set(key, resolved);
    return resolved;
  }

  async function dfs(start, depth) {
    if (start >= tokens.length) return [];
    if (depth >= MAX_PARTS) return null;
    const memoKey = `${start}:${depth}`;
    if (memo.has(memoKey)) return memo.get(memoKey);

    for (let end = tokens.length - 1; end >= start; end -= 1) {
      if (tokens[end].kind !== 'word') continue;
      const candidate = await lookupSeg(start, end);
      if (!candidate) continue;

      if (end === tokens.length - 1) {
        if (depth === 0) continue;
        const found = [candidate];
        memo.set(memoKey, found);
        return found;
      }

      const nextStarts = nextStartsFromSeparator(tokens, end + 1, links);
      for (const nextStart of nextStarts) {
        const rest = await dfs(nextStart, depth + 1);
        if (rest) {
          const found = [candidate, ...rest];
          memo.set(memoKey, found);
          return found;
        }
      }
    }

    memo.set(memoKey, null);
    return null;
  }

  const matchedParts = await dfs(0, 0);
  return finalizeCompoundParts(matchedParts, ctx);
}

// Синхронный составной разбор, который не отменяет найденное из-за одной непонятой части:
// возвращает { parts, unresolved } и только потом превращается в план (не меньше двух частей).
function collectPartialCompoundSync(tokens, links, resolveSeg) {
  const memo = new Map();

  function dfs(start, depth) {
    if (start >= tokens.length) return { parts: [], unresolved: [] };
    if (depth >= MAX_PARTS) return null;
    const memoKey = `${start}:${depth}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    memo.set(memoKey, null);

    // Длинная часть важнее: «включи и игру» остаётся одной командой, а не двумя кусками.
    for (let end = tokens.length - 1; end >= start; end -= 1) {
      if (tokens[end].kind !== 'word') continue;
      const chunkText = buildChunkText(tokens, start, end);
      const candidate = chunkText ? resolveSeg(chunkText) : null;
      if (!candidate) continue;

      if (end === tokens.length - 1) {
        if (depth === 0) continue; // одна часть — это не составная фраза
        const found = { parts: [candidate], unresolved: [] };
        memo.set(memoKey, found);
        return found;
      }

      const nextStarts = nextStartsFromSeparator(tokens, end + 1, links);
      for (const nextStart of nextStarts) {
        const rest = dfs(nextStart, depth + 1);
        if (rest) {
          const found = { parts: [candidate, ...rest.parts], unresolved: rest.unresolved };
          memo.set(memoKey, found);
          return found;
        }
      }

      // Хвост за настоящим разделителем не разобрался: понятную часть оставляем, непонятое называем.
      // Без разделителя хвост — это часть той же просьбы («перерыв на 0 минут»), делить её нельзя.
      if (nextStarts.length > 0) {
        const tail = unresolvedText(tokens, nextStarts[0], tokens.length - 1, links);
        if (tail) {
          const found = { parts: [candidate], unresolved: [tail] };
          memo.set(memoKey, found);
          return found;
        }
      }
    }

    // С этого места часть не начинается: пропускаем кусок до ближайшего разделителя.
    for (let i = start; i < tokens.length; i += 1) {
      const starts = nextStartsFromSeparator(tokens, i, links);
      if (!starts.length) continue;
      const text = unresolvedText(tokens, start, i - 1, links);
      const rest = dfs(starts[0], depth);
      if (!rest) break;
      const found = {
        parts: rest.parts,
        unresolved: text ? [text, ...rest.unresolved] : rest.unresolved,
      };
      memo.set(memoKey, found);
      return found;
    }

    return null;
  }

  return dfs(0, 0);
}

function resolveCompoundPartialSync(rawText, eligibleCommands, ctx = {}) {
  const tokens = tokenizeForCompound(rawText);
  if (tokens.length < 3) return null;
  const links = compoundLinkSequences(ctx.linkWords);
  // Больше MAX_PARTS кусков — не разбираем: раньше такой предел давал null, и он остаётся.
  if (compoundChunkInfo(tokens, links).chunks > MAX_PARTS) return null;
  const segCache = new Map();
  const resolveSeg = (chunkText) => {
    if (segCache.has(chunkText)) return segCache.get(chunkText);
    const resolved = resolveSegmentSync(chunkText, eligibleCommands, ctx);
    segCache.set(chunkText, resolved);
    return resolved;
  };
  const found = collectPartialCompoundSync(tokens, links, resolveSeg);
  if (!found) return null;
  return finalizePartialCompoundParts(found.parts, found.unresolved, ctx);
}

// Асинхронный частичный разбор: тот же поиск, но каждая часть разрешается через await.
async function resolveCompoundPartialAsync(rawText, eligibleCommands, ctx = {}) {
  const tokens = tokenizeForCompound(rawText);
  if (tokens.length < 3) return null;
  const links = compoundLinkSequences(ctx.linkWords);
  // Больше MAX_PARTS кусков — не разбираем: раньше такой предел давал null, и он остаётся.
  if (compoundChunkInfo(tokens, links).chunks > MAX_PARTS) return null;
  const segCache = new Map();
  const memo = new Map();

  async function dfs(start, depth) {
    if (start >= tokens.length) return { parts: [], unresolved: [] };
    if (depth >= MAX_PARTS) return null;
    const memoKey = `${start}:${depth}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    memo.set(memoKey, null);

    for (let end = tokens.length - 1; end >= start; end -= 1) {
      if (tokens[end].kind !== 'word') continue;
      const chunkText = buildChunkText(tokens, start, end);
      if (!chunkText) continue;
      if (!segCache.has(chunkText)) {
        segCache.set(chunkText, await resolveSegmentAsync(chunkText, eligibleCommands, ctx));
      }
      const candidate = segCache.get(chunkText);
      if (!candidate) continue;

      if (end === tokens.length - 1) {
        if (depth === 0) continue;
        const found = { parts: [candidate], unresolved: [] };
        memo.set(memoKey, found);
        return found;
      }

      const nextStarts = nextStartsFromSeparator(tokens, end + 1, links);
      for (const nextStart of nextStarts) {
        const rest = await dfs(nextStart, depth + 1);
        if (rest) {
          const found = { parts: [candidate, ...rest.parts], unresolved: rest.unresolved };
          memo.set(memoKey, found);
          return found;
        }
      }

      if (nextStarts.length > 0) {
        const tail = unresolvedText(tokens, nextStarts[0], tokens.length - 1, links);
        if (tail) {
          const found = { parts: [candidate], unresolved: [tail] };
          memo.set(memoKey, found);
          return found;
        }
      }
    }

    for (let i = start; i < tokens.length; i += 1) {
      const starts = nextStartsFromSeparator(tokens, i, links);
      if (!starts.length) continue;
      const text = unresolvedText(tokens, start, i - 1, links);
      const rest = await dfs(starts[0], depth);
      if (!rest) break;
      const found = {
        parts: rest.parts,
        unresolved: text ? [text, ...rest.unresolved] : rest.unresolved,
      };
      memo.set(memoKey, found);
      return found;
    }

    return null;
  }

  const found = await dfs(0, 0);
  if (!found) return null;
  return finalizePartialCompoundParts(found.parts, found.unresolved, ctx);
}

function passesProseGuardrails(rawText) {
  if (typeof rawText !== 'string') return false;
  const trimmed = rawText.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_TEXT) return false;
  if (trimmed.includes('?')) return false;
  if (screenTask(trimmed)) return false;
  if (/^\s*продолжай\s+в\s+фоне(?=$|[\s,!?;:.-])/iu.test(trimmed)) return false;

  const tokens = cleanBaseText(trimmed).split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > MAX_TOKENS) return false;

  const cleaned = cleanWithFillersStripped(trimmed);
  if (!cleaned) return false;
  if (LEADING_INTERROGATIVE_RE.test(cleaned)) return false;

  return true;
}

function findWorkModeClauses(rawText) {
  const cleaned = cleanWithFillersStripped(rawText);
  if (!cleaned) return [];
  if (WORK_MODE_PHRASES.has(cleaned)) return [cleaned];

  const tokens = tokenizeForCompound(rawText);
  if (tokens.length === 0) return [];
  const clauses = [];
  for (let start = 0; start < tokens.length; start += 1) {
    if (tokens[start].kind !== 'word') continue;
    for (let end = start; end < tokens.length; end += 1) {
      if (tokens[end].kind === 'comma') break;
      if (tokens[end].kind !== 'word') continue;
      const chunkText = buildChunkText(tokens, start, end);
      if (!chunkText) continue;
      const cleanChunk = cleanWithFillersStripped(chunkText);
      if (cleanChunk && WORK_MODE_PHRASES.has(cleanChunk)) {
        clauses.push(cleanChunk);
      }
    }
  }
  return clauses;
}

function workModeNeedsAppCheck(rawText, ctx = {}) {
  const clauses = findWorkModeClauses(rawText);
  if (clauses.length === 0) return false;

  for (const clause of clauses) {
    const customCmd = findCustomWorkCommand(clause, ctx);
    if (customCmd) {
      if (Array.isArray(customCmd.steps) && customCmd.steps.some((s) => s && s.tool === 'app_open')) {
        return true;
      }
      continue;
    }
    const wm = ctx.workMode;
    if (wm && typeof wm === 'object' && Array.isArray(wm.apps) && wm.apps.some((a) => typeof a === 'string' && a.trim() !== '')) {
      return true;
    }
  }
  return false;
}

function resolveContextualMusicTurn(trimmed, ctx = {}) {
  if (!isMusicRequest(trimmed)) return null;
  if (hasOtherSteps(trimmed) || isResetServiceRequest(trimmed) || isPronounPlay(trimmed)) return null;
  const cleaned = cleanQuery(trimmed);
  if (!isContextualMusicQuery(trimmed, cleaned)) return null;

  const plan = pickMusicPlan({
    phrase: trimmed,
    history: Array.isArray(ctx.history) ? ctx.history : [],
    now: ctx.now,
    activeApps: Array.isArray(ctx.activeApps) ? ctx.activeApps : [],
    musicService: ctx.musicService || 'youtube',
    musicHistory: Array.isArray(ctx.musicHistory) ? ctx.musicHistory : [],
  });

  const steps = cloneSteps(plan.steps);
  if (!areStepsAllowed(steps, ctx)) return null;

  return {
    kind: 'command',
    isSequence: steps.length > 1,
    source: 'music-context',
    mood: plan.mood,
    musicQuery: plan.query,
    musicService: plan.service,
    softenVolume: plan.softenVolume,
    title: plan.label,
    name: plan.label,
    ownerCommand: false,
    parts: [{ title: plan.label, source: 'music-context', steps: cloneSteps(steps) }],
    steps,
    notes: [],
    summaryReply: plan.summaryReply,
  };
}

function resolveHintTurn(trimmed, ctx = {}) {
  const hint = resolveHint(trimmed);
  if (!hint) return null;
  const steps = cloneSteps(hint.steps);
  if (!areStepsAllowed(steps, ctx)) return null;
  return {
    ...hint,
    parts: [{ title: hint.title, source: 'hint', steps: cloneSteps(steps) }],
    steps,
  };
}

function resolveLocalTurn(text, ctx = {}) {
  if (!passesProseGuardrails(text)) return null;
  const rawTrimmed = text.trim();
  const wakeOpts = wakeOptsForCtx(ctx);
  if (ctx && ctx.prefixMode === true && !hasWakePrefix(rawTrimmed, wakeOpts)) {
    return null;
  }
  const trimmed = stripWake(rawTrimmed, wakeOpts).trim();
  if (!trimmed) return null;

  if (isWholeReminderText(trimmed)) {
    const off = tryOfflineSingle(trimmed, ctx);
    return off ? off.result : null;
  }

  const cleaned = cleanWithFillersStripped(trimmed, wakeOpts);
  if (WORK_MODE_PHRASES.has(cleaned)) {
    return resolveWorkModeSync(trimmed, ctx);
  }

  const eligibleCommands = getStoreCommands(ctx.store).filter((cmd) => cmd && !isUntouchedSampleWorkCommand(cmd));

  // Явно составная фраза: составной разбор идёт раньше одиночных перехватов. Иначе одна часть
  // (например «курс доллара») отвечает за всю фразу, а остальные просьбы теряются (DEMO 1, 12-я фаза).
  // Полный план — когда понятны все части; частичный — когда понятны не меньше двух, остальное честно названо.
  if (looksLikeCompoundPhrase(trimmed, compoundLinkSequences(ctx.linkWords))) {
    const compoundFirst = resolveCompoundSync(trimmed, eligibleCommands, ctx)
      || resolveCompoundPartialSync(trimmed, eligibleCommands, ctx);
    if (compoundFirst) return compoundFirst;
  }

  const userHit = matchUserCommandSingle(trimmed, eligibleCommands, ctx);
  if (userHit) return userHit.result;

  const scenHit = resolveBuiltInNonWorkScenario(trimmed, ctx);
  if (scenHit) return scenHit.result;

  const offHit = tryOfflineSingle(trimmed, ctx);
  if (offHit) return offHit.result;

  const libHit = matchLibrarySingle(trimmed, ctx);
  if (libHit) return libHit.result;

  const compoundHit = resolveCompoundSync(trimmed, eligibleCommands, ctx);
  if (compoundHit) return compoundHit;

  const musicCtxHit = resolveContextualMusicTurn(trimmed, ctx);
  if (musicCtxHit) return musicCtxHit;

  return resolveHintTurn(trimmed, ctx);
}

async function resolveLocalTurnAsync(text, ctx = {}) {
  if (!passesProseGuardrails(text)) return null;
  const rawTrimmed = text.trim();
  const wakeOpts = wakeOptsForCtx(ctx);
  if (ctx && ctx.prefixMode === true && !hasWakePrefix(rawTrimmed, wakeOpts)) {
    return null;
  }
  const trimmed = stripWake(rawTrimmed, wakeOpts).trim();
  if (!trimmed) return null;

  if (
    workModeNeedsAppCheck(trimmed, ctx)
    && !ctx.isAppAvailable
    && typeof ctx.ensureInventoryScanned === 'function'
    && (!ctx.appInventory || !ctx.appInventory.scannedAt)
  ) {
    await ctx.ensureInventoryScanned(ctx.appInventory);
  }

  if (isWholeReminderText(trimmed)) {
    const off = tryOfflineSingle(trimmed, ctx);
    return off ? off.result : null;
  }

  const cleaned = cleanWithFillersStripped(trimmed, wakeOpts);
  if (WORK_MODE_PHRASES.has(cleaned)) {
    return resolveWorkModeAsync(trimmed, ctx);
  }

  const eligibleCommands = getStoreCommands(ctx.store).filter((cmd) => cmd && !isUntouchedSampleWorkCommand(cmd));

  // См. resolveLocalTurn: явно составная фраза сначала разбирается как цепочка частей.
  if (looksLikeCompoundPhrase(trimmed, compoundLinkSequences(ctx.linkWords))) {
    const compoundFirst = (await resolveCompoundAsync(trimmed, eligibleCommands, ctx))
      || (await resolveCompoundPartialAsync(trimmed, eligibleCommands, ctx));
    if (compoundFirst) return compoundFirst;
  }

  const userHit = matchUserCommandSingle(trimmed, eligibleCommands, ctx);
  if (userHit) return userHit.result;

  const scenHit = resolveBuiltInNonWorkScenario(trimmed, ctx);
  if (scenHit) return scenHit.result;

  const offHit = tryOfflineSingle(trimmed, ctx);
  if (offHit) return offHit.result;

  const libHit = matchLibrarySingle(trimmed, ctx);
  if (libHit) return libHit.result;

  const compoundHit = await resolveCompoundAsync(trimmed, eligibleCommands, ctx);
  if (compoundHit) return compoundHit;

  const musicCtxHit = resolveContextualMusicTurn(trimmed, ctx);
  if (musicCtxHit) return musicCtxHit;

  return resolveHintTurn(trimmed, ctx);
}

module.exports = {
  resolveLocalTurn,
  resolveLocalTurnAsync,
  parseBreakDuration,
  isUntouchedSampleWorkCommand,
  SCENARIO_IDS,
};
