'use strict';

// Проверка результата по объективным признакам. Модель не решает, выполнено ли: решает проверка.
// Результат каждой проверки: confirmed (подтверждено), failed (не подтверждено), unknown (проверить не удалось).
// Задача считается проверенной только если все проверки шага confirmed. Иначе в отчёте «не проверено».
const fs = require('fs');

// file_exists — файл есть; file_absent — файла нет (шаг «убедиться, что файл ещё не создан»); file_contains — текст есть;
// numbered_steps — в разделе ровно count пронумерованных пунктов: 1..count по порядку, без лишних и повторов;
// sentence_count — в файле ровно count предложений (см. countSentences и её ограничения).
const KINDS = ['file_exists', 'file_contains', 'file_absent', 'numbered_steps', 'sentence_count'];
const HEADING_RE = /^#{1,6}\s/;
const NUMBERED_RE = /^(\d+)[.)]\s+\S/;
const MAX_COUNT = 50;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Заголовок подходит к разделу, если содержит section целыми словами: «Этапы» подходит к «Этапы разработки»,
// но не к «Подэтапы». Точное совпадение заголовка важнее частичного; среди частичных — первый по тексту.
// Исправленный дефект: раньше подходила любая подстрока, и «## Подэтапы» выше по тексту перехватывал проверку
// раздела «Этапы» (ложное «подтверждено» по чужому разделу).
function findSection(lines, section) {
  const want = section.toLowerCase();
  const word = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(want)}(?:[^\\p{L}\\p{N}]|$)`, 'u');
  let partial = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!HEADING_RE.test(lines[i])) continue;
    const title = lines[i].replace(HEADING_RE, '').replace(/\s+#+\s*$/, '').trim().toLowerCase();
    if (title === want) return i;
    if (partial === -1 && word.test(title)) partial = i;
  }
  return partial;
}

// Номера верхнеуровневых пунктов («N. текст» или «N) текст») внутри раздела, заголовок которого содержит section.
// Раздел — до следующего заголовка любого уровня. Нет раздела — null. Вложенные пункты с отступом не считаются.
// Ограничение: блоки кода (```) не распознаются — строка «# …» в них считается заголовком.
function sectionNumbers(text, section) {
  const lines = text.split(/\r?\n/);
  const start = findSection(lines, section);
  if (start === -1) return null;
  const numbers = [];
  for (let i = start + 1; i < lines.length && !HEADING_RE.test(lines[i]); i += 1) {
    const m = NUMBERED_RE.exec(lines[i]);
    if (m) numbers.push(Number(m[1]));
  }
  return numbers;
}

function checkNumberedSteps(check, abs) {
  const section = typeof check.section === 'string' ? check.section.trim() : '';
  const count = check.count;
  if (!section || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return { kind: check.kind, status: 'unknown', evidence: 'у numbered_steps нужны раздел и число пунктов от 1 до 50' };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { kind: check.kind, status: 'failed', evidence: `нет файла: ${check.path}` };
  }
  const numbers = sectionNumbers(fs.readFileSync(abs, 'utf8'), section);
  if (numbers === null) {
    return { kind: check.kind, status: 'failed', evidence: `раздел «${section}» не найден: ${check.path}` };
  }
  const ok = numbers.length === count && numbers.every((n, i) => n === i + 1);
  return {
    kind: check.kind,
    status: ok ? 'confirmed' : 'failed',
    evidence: ok
      ? `в разделе «${section}» ровно ${count} пунктов: 1–${count}`
      : `в разделе «${section}» пункты: ${numbers.length ? numbers.join(', ') : 'нет'}; нужно ровно ${count}: 1–${count} по порядку, без повторов`,
  };
}

// Число предложений в тексте. Конец предложения — один или несколько знаков . ! ? … , за которыми пробел,
// перевод строки или конец текста. Фрагмент без букв и цифр (пустой, «—», «...») предложением не считается;
// последний фрагмент без точки в конце — считается («Чай вкусный. Он полезен» — два предложения).
// Ограничения (правило простое, без разбора языка):
// - сокращения и инициалы с точкой и пробелом дробят предложение: «т. е.», «г. Москва», «А. С. Пушкин»;
// - число с точкой и пробелом после него — тоже конец: «в 2026 г. чай…», «1. пункт списка»;
// - знак перед кавычкой или скобкой не завершает предложение: «Да!» — сказал он. — одно предложение;
// - многоточие посреди фразы («Чай… вкусный») делит её на две;
// - заголовок Markdown без точки сливается со следующим предложением.
// Для проверки «ровно N предложений» в коротком тексте модели этого достаточно; сложный текст считается неточно.
function countSentences(text) {
  return String(text)
    .split(/[.!?…]+(?=\s|$)/u)
    .filter((part) => /[\p{L}\p{N}]/u.test(part))
    .length;
}

function checkSentenceCount(check, abs) {
  const { count } = check;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return { kind: check.kind, status: 'unknown', evidence: 'у sentence_count нужно число предложений от 1 до 50' };
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { kind: check.kind, status: 'failed', evidence: `нет файла: ${check.path}` };
  }
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { kind: check.kind, status: 'unknown', evidence: `не прочитан: ${err.message}` };
  }
  const found = countSentences(text);
  const ok = found === count;
  return {
    kind: check.kind,
    status: ok ? 'confirmed' : 'failed',
    evidence: ok ? `в файле ровно ${count} предл.: ${check.path}` : `в файле ${found} предл., нужно ровно ${count}: ${check.path}`,
  };
}

// Для file_exists: папка по этому пути — не файл. Сообщаем это прямо, а не «нет файла».
function missingFileEvidence(abs, rel) {
  return fs.existsSync(abs) ? `по пути папка, а не файл: ${rel}` : `нет файла: ${rel}`;
}

// resolve(relPath) → абсолютный путь внутри песочницы или бросает ошибку (см. WorkspaceIndex.resolveInside).
function runCheck(check, { resolve }) {
  if (!check || typeof check !== 'object' || !KINDS.includes(check.kind)) {
    return { kind: check && check.kind, status: 'unknown', evidence: 'неизвестный вид проверки' };
  }
  let abs;
  try {
    abs = resolve(String(check.path || ''));
  } catch (err) {
    return { kind: check.kind, status: 'unknown', evidence: `путь не разрешён: ${err.message}` };
  }
  if (check.kind === 'file_exists') {
    const ok = fs.existsSync(abs) && fs.statSync(abs).isFile();
    return { kind: check.kind, status: ok ? 'confirmed' : 'failed', evidence: ok ? `есть: ${check.path}` : missingFileEvidence(abs, check.path) };
  }
  if (check.kind === 'file_absent') {
    const present = fs.existsSync(abs);
    return { kind: check.kind, status: present ? 'failed' : 'confirmed', evidence: present ? `уже есть: ${check.path}` : `нет, как и должно быть: ${check.path}` };
  }
  if (check.kind === 'numbered_steps') return checkNumberedSteps(check, abs);
  if (check.kind === 'sentence_count') return checkSentenceCount(check, abs);
  // file_contains
  if (!fs.existsSync(abs)) return { kind: check.kind, status: 'failed', evidence: `нет файла: ${check.path}` };
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { kind: check.kind, status: 'unknown', evidence: `не прочитан: ${err.message}` };
  }
  const want = String(check.text || '');
  const ok = want !== '' && text.includes(want);
  return { kind: check.kind, status: ok ? 'confirmed' : 'failed', evidence: ok ? `в файле есть нужный текст: ${check.path}` : `нужного текста нет: ${check.path}` };
}

// Проверяет список проверок шага. Возвращает {status, results}: status — общий итог.
function verify(checks, deps) {
  const list = Array.isArray(checks) ? checks : [];
  if (list.length === 0) return { status: 'unverified', results: [], note: 'проверок нет: результат не проверен' };
  const results = list.map((c) => runCheck(c, deps));
  let status = 'confirmed';
  if (results.some((r) => r.status === 'failed')) status = 'failed';
  else if (results.some((r) => r.status === 'unknown')) status = 'unknown';
  return { status, results };
}

// Текст для отчёта: одна строка на проверку, без приукрашивания.
function reportLines(outcome) {
  if (outcome.status === 'unverified') return [outcome.note];
  return outcome.results.map((r) => `${r.status === 'confirmed' ? 'подтверждено' : r.status === 'failed' ? 'не подтверждено' : 'не удалось проверить'}: ${r.evidence}`);
}

module.exports = { verify, runCheck, reportLines, countSentences, KINDS };
