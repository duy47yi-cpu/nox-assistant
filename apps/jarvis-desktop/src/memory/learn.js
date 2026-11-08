'use strict';

// Автоматическая память: после хода вытаскиваем из слов владельца то, что стоит помнить,
// и складываем в MemoryStore. Без вызова модели: только явные обороты и факты о себе.
// Правила нарочно узкие — лучше пропустить, чем записать случайную фразу.
const { looksSecret, looksSensitive, isExpired, MAX_TEXT } = require('./store');

const MAX_FACT = Math.min(240, MAX_TEXT);
const MAX_ADD = 3;
// Проверка чувствительного — в store.js (одна точка правды): здоровье, документы, деньги, коды и отправка
// автоматически не записываются, владелец скажет отдельно.
const isSensitiveFact = looksSensitive;

// Сравнение без регистра, «ё» и знаков: для дублей и проверки «слова владельца».
function normalizeFact(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function wordSet(text) {
  return new Set(normalizeFact(text).split(' ').filter((w) => w.length >= 3));
}

function similarity(a, b) {
  if (normalizeFact(a) === normalizeFact(b)) return 1;
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

function cleanClause(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.!?—–-]+/, '')
    .replace(/[\s,;:.!?—–-]+$/, '')
    .replace(/^что\s+/iu, '')
    .replace(/\s+пожалуйста$/iu, '')
    .slice(0, MAX_FACT)
    .trim();
}

// Обороты, из которых видно, что это факт о владельце, а не случайная фраза.
const RULES = [
  {
    kind: 'profile',
    re: /(?:^|[.!?;,:]\s*)меня зовут\s+([\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,2})/iu,
    text: (m) => `Меня зовут ${m[1]}`,
    about: (m) => m[1],
  },
  {
    kind: 'agreement',
    re: /(?:^|[.!?;,:]\s*)зови меня\s+([\p{L}][\p{L}-]*(?:\s+[\p{L}][\p{L}-]*){0,2})/iu,
    text: (m) => `Зови меня ${m[1]}`,
  },
  {
    kind: 'profile',
    re: /(?:^|[.!?;,:]\s*)я живу в\s+([^.!?;,\n]{2,60})/iu,
    text: (m) => `Я живу в ${m[1]}`,
    about: () => 'адрес',
  },
  {
    kind: 'profile',
    re: /(?:^|[.!?;,:]\s*)я работаю\s+([^.!?;,\n]{2,80})/iu,
    text: (m) => `Я работаю ${m[1]}`,
    about: () => 'работа',
  },
  {
    kind: 'profile',
    re: /(?:^|[.!?;,:]\s*)мне\s+(\d{1,2})\s+(?:лет|года|год)/iu,
    text: (m) => `Мне ${m[1]} лет`,
  },
  {
    kind: 'profile',
    re: /(?:^|[.!?;,:]\s*)мой день рождения\s*[—–:-]?\s*([^.!?;,\n]{2,40})/iu,
    text: (m) => `Мой день рождения ${m[1]}`,
  },
  {
    kind: 'preference',
    re: /(?:^|[.!?;,:]\s*)я (?:очень )?(?:люблю|обожаю)\s+([^.!?;,\n]{2,80})/iu,
    text: (m) => `Я люблю ${m[1]}`,
  },
  {
    kind: 'preference',
    re: /(?:^|[.!?;,:]\s*)я не (?:очень )?(?:люблю|переношу|терплю)\s+([^.!?;,\n]{2,80})/iu,
    text: (m) => `Я не люблю ${m[1]}`,
  },
  {
    kind: 'preference',
    re: /(?:^|[.!?;,:]\s*)я предпочитаю\s+([^.!?;,\n]{2,80})/iu,
    text: (m) => `Я предпочитаю ${m[1]}`,
  },
  {
    kind: 'fact',
    re: /(?:^|[.!?;,:]\s*)у меня есть\s+([^.!?;,\n]{2,80})/iu,
    text: (m) => `У меня есть ${m[1]}`,
  },
  {
    kind: 'agreement',
    // «я всегда опаздываю» — факт о себе, а не указание; поэтому lookbehind.
    re: /(?:^|[.!?;,:]\s*)(?<!я\s)(всегда|никогда)\s+([^.!?;,\n]{2,100})/iu,
    text: (m) => `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`,
  },
  {
    kind: 'agreement',
    re: /(?:^|[.!?;,:]\s*)не делай\s+([^.!?;,\n]{2,100})/iu,
    text: (m) => `Не делай ${m[1]}`,
  },
  {
    kind: 'agreement',
    re: /(?:^|[.!?;,:]\s*)не (?:надо|стоит|нужно)\s+([^.!?;,\n]{2,100})/iu,
    text: (m) => `Не надо ${m[1]}`,
  },
  {
    // Явная просьба запомнить: тут можно взять фразу целиком.
    kind: 'note',
    re: /(?:^|[.!?;,:]\s*)(?:запомни|не забудь)(?:,?\s*что)?\s*[:\-—]?\s*([^.!?;,\n]{3,200})/iu,
    text: (m) => cleanClause(m[1]),
  },
];

// Слова профиля и договорённости должны быть словами владельца из этого же сообщения.
function wordsOfOwner(owner, candidate) {
  const ownerWords = new Set(normalizeFact(owner).split(' '));
  return normalizeFact(candidate).split(' ').every((w) => w.length < 2 || ownerWords.has(w));
}

function extractFacts(text, { ownerText = text } = {}) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const found = [];
  const seen = new Set();
  for (const rule of RULES) {
    const m = rule.re.exec(source);
    if (!m) continue;
    const body = cleanClause(rule.text(m));
    if (!body || body.length < 3) continue;
    const key = normalizeFact(body);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let kind = rule.kind;
    // Профиль и договорённость — только если это действительно слова владельца, а не пересказ.
    if ((kind === 'profile' || kind === 'agreement') && !wordsOfOwner(ownerText, body)) kind = 'note';
    const candidate = { text: body, kind };
    if (rule.about) {
      const about = cleanClause(rule.about(m));
      if (about) candidate.about = about;
    }
    found.push(candidate);
    if (found.length >= MAX_ADD) break;
  }
  return found;
}

function findSimilar(items, candidate) {
  return items.find((item) => {
    if (!item || typeof item.text !== 'string') return false;
    if (normalizeFact(item.text) === normalizeFact(candidate.text)) return true;
    if (item.kind !== candidate.kind) return false;
    if ((item.about || '') !== (candidate.about || '')) return false;
    return similarity(item.text, candidate.text) >= 0.8;
  }) || null;
}

// Убирает точные дубли (тот же текст, вид и about), оставляя самую новую запись.
// Ничего не сливает по смыслу: противоречия решает владелец.
function consolidate(store, { max = 2000 } = {}) {
  const items = store.list(max);
  const groups = new Map();
  for (const item of items) {
    const key = `${item.kind || 'note'}|${normalizeFact(item.text)}|${normalizeFact(item.about || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const removed = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // list() отдаёт новые сверху: оставляем первую, остальные — дубли.
    for (const item of group.slice(1)) {
      try {
        if (store.remove(item.id)) removed.push(item.id);
      } catch {
        // файл занят или запись уже удалена: не мешаем ходу
      }
    }
  }
  return { removed, groups: [...groups.values()].filter((g) => g.length > 1).length };
}

// Главная точка: после хода. Никогда не бросает — память не должна ломать ответ.
function learnFromTurn({ store, text, reply = '', auto = true, max = MAX_ADD } = {}) {
  const result = { added: [], skipped: [], conflicts: [], replaced: [], disabled: false };
  if (!store || typeof store.add !== 'function' || typeof store.list !== 'function') return result;
  if (!auto) {
    result.disabled = true;
    return result;
  }
  const source = String(text ?? '').trim();
  if (!source) return result;
  let existing;
  try {
    // Просроченные не считаются дублями: иначе новый факт не запишется и останется невидимым.
    existing = store.list(2000).filter((item) => !isExpired(item));
  } catch {
    return result;
  }
  let candidates;
  try {
    candidates = extractFacts(source);
  } catch {
    return result;
  }
  // reply нарочно не разбираем: модель может ошибиться или придумать факт, а память — про слова владельца.
  void reply;
  for (const candidate of candidates) {
    if (result.added.length >= max) break;
    const textFact = String(candidate.text || '').trim();
    if (!textFact) continue;
    if (looksSecret(textFact)) {
      result.skipped.push({ text: textFact, reason: 'похоже на секрет' });
      continue;
    }
    if (isSensitiveFact(textFact)) {
      result.skipped.push({ text: textFact, reason: 'чувствительное' });
      continue;
    }
    if (findSimilar(existing, candidate)) {
      result.skipped.push({ text: textFact, reason: 'уже есть' });
      continue;
    }
    let conflicts = [];
    try {
      conflicts = store.conflicts({ text: textFact, about: candidate.about });
    } catch {
      conflicts = [];
    }
    if (conflicts.length) {
      // Идея Supermemory: новый факт не выбрасывается, а становится новой версией.
      // Старая запись остаётся в файле как история, но перестаёт быть текущей (см. visible в store.js).
      try {
        const record = store.add({
          text: textFact,
          kind: candidate.kind,
          about: candidate.about,
          supersedes: conflicts.map((item) => item.id),
        });
        for (const old of conflicts) {
          try {
            store.update(old.id, { supersededBy: record.id });
          } catch {
            // Старая версия осталась как есть: новую запись всё равно сохранили.
          }
        }
        result.added.push(record);
        result.replaced.push(...conflicts.map((old) => ({ oldId: old.id, oldText: old.text, by: record.id })));
        result.conflicts.push(...conflicts);
        existing.push(record);
      } catch (err) {
        result.skipped.push({ text: textFact, reason: err && err.message ? err.message : String(err) });
      }
      continue;
    }
    try {
      const record = store.add({ text: textFact, kind: candidate.kind, about: candidate.about });
      result.added.push(record);
      existing.push(record);
    } catch (err) {
      result.skipped.push({ text: textFact, reason: err && err.message ? err.message : String(err) });
    }
  }
  if (result.added.length) {
    try {
      consolidate(store);
    } catch {
      // уборка дублей не обязательна
    }
  }
  return result;
}

module.exports = {
  extractFacts,
  learnFromTurn,
  consolidate,
  isSensitiveFact,
  normalizeFact,
  similarity,
  MAX_ADD,
};
