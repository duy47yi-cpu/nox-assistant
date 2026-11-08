'use strict';

// Заполнение шаблона Word: {{ключ}} в тексте документа заменяется значениями. Например, диплом по образцу:
// в образце стоят {{ФИО}}, {{Дата}}, а значения передаёт владелец. Чистые функции над байтами .docx.
const { readZip, writeZip } = require('./zip');

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*[^{}]+?\s*\}\}/;
const PARA = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const TEXT = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const MAX_VALUE = 500;

const esc = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Текст из XML: сущности раскрываем, чтобы сравнивать с ключами, и снова экранируем при записи.
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// Ключи, которые встречаются в документе (без повторов, в порядке появления).
function placeholdersIn(buf) {
  const files = readZip(buf);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('это не документ Word');
  const keys = [];
  for (const para of doc.toString('utf8').match(PARA) || []) {
    const text = [...para.matchAll(TEXT)].map((m) => unesc(m[1])).join('');
    for (const m of text.matchAll(PLACEHOLDER)) if (!keys.includes(m[1].trim())) keys.push(m[1].trim());
  }
  return keys;
}

// Заполняет шаблон. values — объект «ключ → строка». Абзацы с ключами собираются заново в один прогон текста:
// оформление отдельных слов внутри такого абзаца теряется, остальные абзацы не меняются.
// Возвращает { buffer, filled, missing } — заменённые и не найденные в values ключи.
function fillDocx(buf, values) {
  const files = readZip(buf);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('это не документ Word');
  const filled = new Set();
  const missing = new Set();
  const map = values && typeof values === 'object' ? values : {};
  const xml = doc.toString('utf8').replace(PARA, (para) => {
    const runs = [...para.matchAll(TEXT)];
    if (!runs.length) return para;
    const text = runs.map((m) => unesc(m[1])).join('');
    if (!HAS_PLACEHOLDER.test(text)) return para;
    const next = text.replace(PLACEHOLDER, (whole, rawKey) => {
      const key = rawKey.trim();
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        filled.add(key);
        return String(map[key]).slice(0, MAX_VALUE);
      }
      missing.add(key);
      return whole;
    });
    let first = true;
    return para.replace(TEXT, () => {
      if (first) { first = false; return `<w:t xml:space="preserve">${esc(next)}</w:t>`; }
      return '<w:t xml:space="preserve"></w:t>';
    });
  });
  const entries = [...files.entries()].map(([name, data]) => ({ name, data: name === 'word/document.xml' ? Buffer.from(xml, 'utf8') : data }));
  return { buffer: writeZip(entries), filled: [...filled], missing: [...missing] };
}

module.exports = { placeholdersIn, fillDocx };
