'use strict';

// Единый детектор секретов: память, журнал, история буфера, аргументы команд, исходящие действия.
// Проверки — страховка, а не защита: лучше лишний раз спросить и замазать, чем молча отправить пароль.
// Поэтому детектор смотрит два независимых признака:
//   1) слово-метка («пароль», «token», «pin», «код») и рядом правдоподобное значение — двоеточие не обязательно,
//      между словом и значением допускаются короткие слова («Пароль от Wi-Fi: hunter2»);
//   2) длинный токен без метки — по алфавиту и запутанности, а не по одному «похоже на ключ».
//
// Устроено диапазонами: findSecrets возвращает только сами значения, метка и разделитель остаются на месте,
// поэтому маска читается («пароль: [скрыто]»). Одна общая точка правды вместо копий в разных файлах.

const MAX_FILLER = 4;
const MAX_FILLER_WORD = 24;
const MIN_MASK_CHARS = 3;
const MIN_TOKEN = 12;

// Метка секрета. После неё идём вперёд и ищем значение.
const STRONG_LABEL = /(?:парол\p{L}*|password|passwd|pwd|passphrase|секрет\p{L}*|secret|api[\s_-]?key|apikey|access[\s_-]?token|refresh[\s_-]?token|токен\p{L}*|token|пин[-\s]?код|pin[-\s]?code|pin|cvv2?|cvc|otp|totp|логин|login|вход\p{L}*|credential)/giu;
// «Код» — слабая метка: так называют и код ошибки, и код города, поэтому её правило строже (см. acceptValue).
const CODE_LABEL = /(?<![\p{L}\p{N}])код(?![\p{L}\p{N}])/giu;

// Слова после метки, которые сами секретом не являются: маска на них только мешает читать.
const STOP_WORDS = new Set([
  'обязателен', 'обязательно', 'обязательный', 'неверный', 'неверен', 'пустой', 'пустое',
  'изменён', 'изменен', 'забыл', 'забыли', 'восстановить', 'состоит', 'должен', 'нужен',
  'введён', 'введен', 'сброшен', 'сменён', 'сменен', 'истёк', 'истек', 'неизвестен', 'сохранён',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASCAL_ID_RE = /^[A-Za-z]+\d{0,4}_(?:[A-Z][a-z]{2,})+$/;
const KEBAB_WORDS_RE = /^(?:[a-z]{2,}-|\d{2,4}-){2,}[a-z0-9]{2,}$/i;
const HEX_LOWER_RE = /^[0-9a-f]+$/;
const HEX_UPPER_RE = /^[0-9A-F]+$/;
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
// Идентификаторы элементов рабочего стола (desktop_observe) — техническая связка шагов, её не прячем.
const ELEMENT_ID_RE = /^e[0-9a-f]{12}$/;
const PATH_LIKE_RE = /^(?:[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])/;

// Метка + до четырёх коротких слов + разделитель (двоеточие, равно, тире, «это/is») или просто пробел + значение.
const TAIL_RE = /^((?:\s+[^\s\d,;:="'«“»”()]{1,24}){0,4})(\s*(?:[:=—–-]|это|is)\s*|\s+)(["'«“]?)([^\s,;"'»”]{2,})/u;
const TOKEN_RE = /(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{12,}={0,3}(?![A-Za-z0-9_+/-])/g;
const KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function shannonEntropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);
  let ent = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    ent -= p * Math.log2(p);
  }
  return ent;
}

function countOf(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

// Значение правдоподобно, если в нём есть цифра, или смешаны регистры, или оно длинное.
// Для «кода» отдельно: только 4–8 цифр подряд либо разделитель при наличии цифры.
function acceptValue(raw, { code = false, separated = false } = {}) {
  const value = String(raw).replace(/[.,;:!?»”'"\]]+$/u, '');
  if (Array.from(value).length < MIN_MASK_CHARS) return '';
  if (STOP_WORDS.has(value.toLowerCase().replace(/ё/g, 'е'))) return '';
  const digits = countOf(value, /\d/g);
  if (code) {
    if (/^\d{3,8}$/.test(value)) return value;
    if (separated && digits >= 1) return value;
    return '';
  }
  if (digits >= 1) return value;
  if (/\p{Ll}/u.test(value) && /\p{Lu}/u.test(value)) return value;
  if (Array.from(value).length >= 10) return value;
  return '';
}

// Токен без метки: цифра обязательна, мусор (UUID, идентификаторы, даты, пути) отсекается,
// а запутанность нужна, чтобы обычные слова и числа не маскировались.
function isBareToken(tok) {
  if (tok.length < MIN_TOKEN) return false;
  if (UUID_RE.test(tok) || PASCAL_ID_RE.test(tok) || KEBAB_WORDS_RE.test(tok)) return false;
  if (ELEMENT_ID_RE.test(tok) || ISO_LIKE_RE.test(tok) || PATH_LIKE_RE.test(tok)) return false;
  // Адреса и пути: тайну в адресе ловит SECRET_URL_PARAM, а сам путь секретом не считаем.
  // Верхний регистр в пути оставляем признаком токена: случайные ключи его содержат, адреса — нет.
  if (tok.includes('//') || (tok.includes('/') && !/[A-Z]/.test(tok))) return false;
  // «Слово-2026» и «Слово-2026-11-19»: обычные имена с датой, а не токен.
  const parts = tok.split('-');
  if (parts.length > 1 && parts.every((part) => /^[A-Za-z]{2,}$/.test(part) || /^(?:19|20)\d{2}$/.test(part) || /^\d{1,2}$/.test(part))) return false;
  if (!/\d/.test(tok)) return false;
  const uniform = HEX_LOWER_RE.test(tok) || HEX_UPPER_RE.test(tok) || /^\d+$/.test(tok) || /^[0-9A-Z]+$/.test(tok);
  const mixedCase = /[a-z]/.test(tok) && /[A-Z]/.test(tok);
  const entropy = shannonEntropy(tok);
  if (uniform) return entropy >= 3;
  // Ключи вида sk-… и токены в нижнем регистре: высокий разброс важнее регистра.
  if (!mixedCase) return entropy >= 3.6;
  // Короткий токен без метки (12–15) засчитываем только при явно случайном виде.
  return entropy >= (tok.length < 16 ? 3.4 : 3.2);
}

function pushRange(ranges, start, end, kind = 'label') {
  if (end - start < MIN_MASK_CHARS) return;
  ranges.push({ start, end, kind });
}

// Все найденные секреты — диапазонами по исходному тексту, по возрастанию начала.
// codes: false — не считать секретом одну метку «код» (код домофона ещё и обычный факт памяти).
function findSecrets(text, { codes = true } = {}) {
  const raw = String(text ?? '');
  if (!raw) return [];
  const ranges = [];

  const scanLabel = (re, code) => {
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(raw)) !== null) {
      const tail = raw.slice(hit.index + hit[0].length);
      const m = TAIL_RE.exec(tail);
      if (!m) continue;
      const separated = m[2].trim() !== '';
      const value = acceptValue(m[4], { code, separated });
      if (!value) continue;
      const start = hit.index + hit[0].length + m[1].length + m[2].length + m[3].length;
      pushRange(ranges, start, start + value.length, 'label');
    }
  };
  scanLabel(STRONG_LABEL, false);
  if (codes) scanLabel(CODE_LABEL, true);

  // Приватный ключ целиком: заголовок и тело одним куском, иначе заголовок остаётся в журнале.
  KEY_BLOCK_RE.lastIndex = 0;
  let block;
  while ((block = KEY_BLOCK_RE.exec(raw)) !== null) pushRange(ranges, block.index, block.index + block[0].length, 'block');

  TOKEN_RE.lastIndex = 0;
  let token;
  while ((token = TOKEN_RE.exec(raw)) !== null) {
    if (isBareToken(token[0])) pushRange(ranges, token.index, token.index + token[0].length, 'token');
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  return ranges;
}

// Секрет без всяких меток: известные форматы ключей, пропусков и приватных ключей.
const SECRET_BEARER = /\bBearer\s+[A-Za-z0-9._+/=-]{12,}/i;
const SECRET_JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?/;
const SECRET_KEY_PREFIX = /\b(?:sk|pk|ghp|gho|ghu|ghs|glpat|xox[abp])[-_][A-Za-z0-9_-]{12,}\b|\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/i;
const SECRET_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function hasKnownSecretFormat(raw) {
  return SECRET_BEARER.test(raw) || SECRET_JWT.test(raw) || SECRET_KEY_PREFIX.test(raw) || SECRET_KEY_BLOCK.test(raw);
}

// Есть ли в тексте секрет. Коды сюда не входят: «код домофона 4821» — ещё и обычный факт памяти,
// поэтому память его принимает, а маска и вопрос про исходящее (looksSecretEgress) его ловят.
function looksSecret(text) {
  const raw = String(text ?? '');
  return hasKnownSecretFormat(raw) || findSecrets(raw, { codes: false }).length > 0;
}

// Секрет в исходящем: сверх обычного — тайна прямо в адресе.
const SECRET_URL_USERINFO = /\bhttps?:\/\/[^/\s:@"'`]+:[^/\s@"'`]+@/i;
const SECRET_URL_PARAM = /[?&](?:api[_-]?key|apikey|key|k|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|sig|signature|session|sessionid|code|ticket|jwt)=[^&#\s"'`]{4,}/i;

function looksSecretEgress(text) {
  const raw = String(text ?? '');
  if (hasKnownSecretFormat(raw) || SECRET_URL_USERINFO.test(raw) || SECRET_URL_PARAM.test(raw)) return true;
  // Кавычки вокруг имени поля («password":"…») мешают метке: для проверки заменяем их пробелом.
  return findSecrets(raw.replace(/["']/g, ' ')).length > 0;
}

// Строка без секретов. Метка и разделитель остаются, значение заменяется: у токена сохраняется длина
// («[скрыто, 32 симв.]»), чтобы по журналу было видно, сколько убрано.
function maskSecretText(text) {
  const raw = String(text ?? '');
  if (!raw) return raw;
  const ranges = findSecrets(raw);
  if (!ranges.length) return raw;
  let out = '';
  let at = 0;
  for (const range of ranges) {
    if (range.start < at) continue;
    const hidden = range.kind === 'block'
      ? '[скрыто: приватный ключ]'
      : range.kind === 'token' ? `[скрыто, ${Array.from(raw.slice(range.start, range.end)).length} симв.]` : '[скрыто]';
    out += raw.slice(at, range.start) + hidden;
    at = range.end;
  }
  return out + raw.slice(at);
}

// Имена полей, значение которых целиком секрет (журнал, маскировка объектов по ключу).
const SECRET_FIELD_RE = /^(?:парол\p{L}*|password|passwd|pwd|passphrase|api[\s_-]?key|apikey|access[\s_-]?token|refresh[\s_-]?token|id[_-]?token|токен\p{L}*|token|secret|client[_-]?secret|секрет\p{L}*|pin|pin[_-]?code|пин[-\s]?код|cvv|cvc|otp|totp|credential|credentials|sig|signature)$/iu;

module.exports = {
  findSecrets,
  looksSecret,
  looksSecretEgress,
  maskSecretText,
  SECRET_FIELD_RE,
  isBareToken,
  acceptValue,
};
