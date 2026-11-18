'use strict';

// Документы: чтение DOCX, XLSX, CSV, PDF и запись DOCX, XLSX, CSV, PDF. DOCX и XLSX на zlib (zip.js), PDF читает pdfjs-dist.
// Пути проверяет WorkspaceIndex.resolveInside, как у workspace_*. Любая ошибка возвращается как {ok: false, summary}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readZip, writeZip } = require('./zip');
const { writeTarget, reportsOnly } = require('./workspace');
const { pptxBuffer, pptxCheck, normalizeSlides } = require('./pptx');
const { fillDocx, placeholdersIn } = require('./docx-fill');
const { stem, looksSecret } = require('../memory/store');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TEXT = 50000;
const MAX_PATH = 300;
const MAX_ROWS = 5000;
const FORMATS = ['docx', 'xlsx', 'csv', 'pdf', 'pptx'];
const MAX_SLIDES = 40;
const READABLE = ['.docx', '.xlsx', '.csv', '.pdf'];
const BATCH_EXT = new Set(['.docx', '.xlsx', '.csv', '.pdf', '.txt', '.md']);
const BATCH_SKIP_DIRS = new Set(['data', 'node_modules', 'dist']);

const ENT = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function fail(err) {
  return { ok: false, summary: err && err.message ? err.message : String(err), data: {} };
}

function notOk(summary) {
  return { ok: false, summary, data: {} };
}

function cleanPath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Удаление символов, которые в XML недопустимы.
const clean = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
// Экранирование для XML.
const esc = (s) => clean(s).replace(/[&<>"']/g, (c) => ESC[c]);

// Текст из XML: снимаем экранирование (&amp; и числовые ссылки) за один проход.
function xmlText(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return ENT.get(e) ?? m;
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

// Атрибут тега: name="значение".
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? xmlText(m[1]) : null;
}

// Текст всех <t> внутри фрагмента (общие строки и встроенные строки).
function runs(s) {
  return [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('');
}

// ---------- DOCX ----------

// Абзац Word: текст, табуляция и перенос строки.
function paragraph(inner) {
  return [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)]
    .map((m) => (m[0] === '<w:tab/>' ? '\t' : m[0] === '<w:br/>' ? '\n' : xmlText(m[1])))
    .join('');
}

const PARA_RE = /<w:p(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/w:p>/g;

// Абзацы подряд; строка таблицы — клетки через « | », клетка — её абзацы через пробел.
function docxLines(xml) {
  const lines = [];
  for (const b of xml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>|<w:p(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/w:p>/g)) {
    if (b[1] === undefined) {
      lines.push(paragraph(b[2]));
      continue;
    }
    const cells = [...b[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)]
      .map((c) => [...c[1].matchAll(PARA_RE)].map((p) => paragraph(p[1])).join(' '));
    lines.push(cells.join(' | '));
  }
  return lines;
}

function readDocx(buf) {
  const doc = readZip(buf).get('word/document.xml');
  if (!doc) throw new Error('в файле нет текста Word: word/document.xml не найден');
  return docxLines(doc.toString('utf8')).join('\n');
}

// ---------- XLSX ----------

// Номер столбца из буквенной части ссылки (A → 0).
function colIndex(letters) {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

// Листы книги: имя и путь к файлу листа через связи книги.
function sheetList(files) {
  const wb = files.get('xl/workbook.xml');
  if (!wb) throw new Error('в файле нет листов: xl/workbook.xml не найден');
  const targets = new Map();
  const rels = files.get('xl/_rels/workbook.xml.rels');
  for (const m of rels ? rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/g) : []) {
    const target = attr(m[0], 'Target');
    if (target) targets.set(attr(m[0], 'Id'), target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  return [...wb.toString('utf8').matchAll(/<sheet\b[^>]*>/g)]
    .map((m) => ({ name: attr(m[0], 'name') || '', file: targets.get(attr(m[0], 'r:id')) }))
    .filter((s) => s.file && files.has(s.file));
}

// Значения листа строками: общие строки, встроенные строки, числа, логические значения.
function sheetGrid(xml, shared) {
  const grid = [];
  for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = attr(c[1], 'r');
    const pos = ref && ref.match(/^([A-Za-z]+)(\d+)$/);
    if (!pos) continue;
    const type = attr(c[1], 't');
    const body = c[2] || '';
    let value;
    if (type === 'inlineStr') value = runs(body);
    else {
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      const raw = v ? xmlText(v[1]) : '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else value = raw;
    }
    (grid[Number(pos[2]) - 1] ||= [])[colIndex(pos[1])] = value;
  }
  return Array.from(grid, (row) => Array.from(row || [], (v) => v ?? '')).filter((row) => row.some((v) => v !== ''));
}

function readXlsx(buf, sheetArg) {
  const files = readZip(buf);
  const ss = files.get('xl/sharedStrings.xml');
  const shared = ss ? [...ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => runs(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''))) : [];
  let sheets = sheetList(files);
  if (sheetArg !== undefined && sheetArg !== null && sheetArg !== '') {
    const want = String(sheetArg);
    const byIndex = Number.isInteger(Number(want)) ? sheets[Number(want) - 1] : undefined;
    const found = sheets.find((s) => s.name === want) || byIndex;
    if (!found) throw new Error(`лист «${want}» не найден; листы: ${sheets.map((s) => s.name).join(', ')}`);
    sheets = [found];
  }
  return sheets.map((s) => {
    const rows = sheetGrid(files.get(s.file).toString('utf8'), shared).map(lineOf);
    return `## Лист «${s.name}»\n${rows.join('\n')}`;
  }).join('\n\n');
}

// ---------- CSV ----------

// CSV: кавычки, удвоенные кавычки и переносы внутри кавычек. Разделитель — по первой строке: «;» или «,».
function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/)[0] || '';
  const sep = first.split(';').length > first.split(',').length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (t[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v !== ''));
}

// ---------- Запись ----------

function rowsOf(args) {
  if (Array.isArray(args.rows)) return args.rows.map((r) => (Array.isArray(r) ? r : [r]));
  if (typeof args.text === 'string' && args.text !== '') return args.text.split(/\r?\n/).map((l) => [l]);
  return [];
}

// Строка таблицы или абзац: клетки через « | », как при чтении.
const lineOf = (row) => row.map((v) => String(v)).join(' | ');

function docxBuffer(title, rows) {
  const p = (t, bold) => `<w:p><w:r>${bold ? '<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const body = (title ? p(title, true) : '') + rows.map((r) => p(lineOf(r), false)).join('');
  return writeZip([
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFFICE}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ]);
}

function xlsxBuffer(sheetTitle, rows) {
  const colName = (i) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const cell = (ref, v) => (typeof v === 'number' && Number.isFinite(v)
    ? `<c r="${ref}"><v>${v}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`);
  const data = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(`${colName(ci)}${ri + 1}`, v)).join('')}</row>`).join('');
  // Имя листа: без символов, запрещённых Excel, не длиннее 31 символа.
  const name = String(sheetTitle || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Лист1';
  return writeZip([
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFFICE}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_OFFICE}"><sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="${NS_REL}"><Relationship Id="rId1" Type="${NS_OFFICE}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_OFFICE}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>` },
  ]);
}

// CSV с точкой с запятой и BOM: русский Excel открывает такой файл сразу по колонкам, в UTF-8.
function csvBuffer(rows) {
  const q = (v) => {
    const s = clean(v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(`﻿${rows.map((r) => r.map((v) => q(String(v))).join(';')).join('\r\n')}`, 'utf8');
}

function pdfHtml(title, rows) {
  const body = rows.map((r) => `<p>${esc(lineOf(r))}</p>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.4}h1{font-size:18pt}</style></head><body>${title ? `<h1>${esc(title)}</h1>` : ''}${body}</body></html>`;
}

// Нормализация текста и запрос по основам слов / подстроке для пакетного чтения.
function normalizeSearch(text) {
  return String(text ?? '').toLowerCase().replace(/ё/g, 'е');
}

function batchQueryTerms(query) {
  const norm = normalizeSearch(query).trim();
  if (!norm) return null;
  const words = [...new Set(norm.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2))];
  return {
    phrase: norm,
    terms: words.map((w) => ({ word: w, stem: stem(w) })),
  };
}

function matchBatchText(body, parsedQuery, maxChars) {
  if (!parsedQuery) {
    const text = String(body || '');
    const truncated = text.length > maxChars;
    return {
      matched: true,
      matches: undefined,
      truncated,
      excerpt: (truncated ? text.slice(0, maxChars) : text).trim(),
    };
  }
  const bodyNorm = normalizeSearch(body);
  const tokens = Array.from(bodyNorm.matchAll(/[\p{L}\p{N}]+/gu), (m) => m[0]);
  const bodyStems = new Set(tokens.map((t) => stem(t)));
  const hits = [];
  for (const t of parsedQuery.terms) {
    if (bodyStems.has(t.stem) || bodyNorm.includes(t.word)) hits.push(t.word);
  }
  const phraseHit = bodyNorm.includes(parsedQuery.phrase);
  if (hits.length === 0 && !phraseHit) return { matched: false };

  let excerptStart = 0;
  let idx = phraseHit ? bodyNorm.indexOf(parsedQuery.phrase) : -1;
  if (idx < 0 && hits.length > 0) idx = bodyNorm.indexOf(hits[0]);
  if (idx < 0 && parsedQuery.terms.length > 0) {
    const s = parsedQuery.terms[0].stem;
    const tok = tokens.find((w) => stem(w) === s);
    if (tok) idx = bodyNorm.indexOf(tok);
  }
  if (idx > 0 && body.length > maxChars) {
    excerptStart = Math.max(0, idx - Math.floor(maxChars / 4));
  }
  const slice = String(body).slice(excerptStart, excerptStart + maxChars).trim();
  return {
    matched: true,
    matches: hits.length ? hits : [parsedQuery.phrase],
    truncated: excerptStart > 0 || excerptStart + maxChars < body.length,
    excerpt: (excerptStart > 0 ? `…${slice}` : slice),
  };
}

// Файл чужой: шрифты и код из него не исполняем, берём только текст.
// Если текстового слоя нет или текста меньше чем на 15% страниц — при наличии ocrPdf пробуем OCR скана.
async function readPdf(buf, { absPath = '', ocrPdf = null, maxOcrPages = 15, signal, maxPages = Infinity, maxText = MAX_TEXT } = {}) {
  signal?.throwIfAborted();
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: VerbosityLevel.ERRORS });
  try {
    const doc = await task.promise.catch((err) => {
      if (err && err.name === 'PasswordException') throw new Error('PDF защищён паролем');
      throw new Error('файл PDF повреждён или не читается', { cause: err });
    });
    const pagesTotal = doc.numPages;
    const pageTexts = new Map();
    const emptyPages = [];
    let textPages = 0;
    let size = 0;
    let scannedPages = 0;
    for (let n = 1; n <= Math.min(pagesTotal, maxPages) && size <= maxText; n += 1) {
      signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
      page.cleanup();
      scannedPages = n;
      if (text) {
        textPages += 1;
        pageTexts.set(n, text);
        size += text.length;
      } else {
        emptyPages.push(n);
      }
    }

    const textRatio = pagesTotal > 0 ? textPages / pagesTotal : 0;
    const needsOcr = pagesTotal > 0 && (textPages === 0 || (emptyPages.length > 0 && textRatio < 0.15));
    const ocrTexts = new Map();
    let ocrPages = 0;
    let ocrStatus = 'not_needed';

    if (needsOcr) {
      if (typeof ocrPdf === 'function' && absPath) {
        let ocrRes = null;
        try {
          ocrRes = await ocrPdf(absPath, { maxPages: maxOcrPages, signal });
        } catch {
          ocrRes = { status: 'error', pages: [] };
        }
        if (ocrRes && ocrRes.status === 'password') {
          throw new Error('PDF защищён паролем');
        }
        const emptySet = new Set(emptyPages);
        const rawPages = Array.isArray(ocrRes && ocrRes.pages) ? ocrRes.pages : [];
        for (const p of rawPages) {
          const num = Number(p && p.page);
          const txt = String((p && p.text) || '').trim();
          if (Number.isInteger(num) && num >= 1 && num <= pagesTotal && emptySet.has(num) && txt) {
            ocrTexts.set(num, txt);
            ocrPages += 1;
          }
        }
        if (ocrPages > 0) {
          ocrStatus = ocrPages >= emptyPages.length ? 'recognized' : 'partial';
        } else if (!ocrRes || ocrRes.status === 'no_engine' || ocrRes.status === 'error') {
          ocrStatus = 'unavailable';
        } else {
          ocrStatus = 'no_text_found';
        }
      } else {
        ocrStatus = 'unavailable';
      }
    }

    const sections = [...pageTexts, ...ocrTexts]
      .sort(([a], [b]) => a - b)
      .map(([page, text]) => ({ page, text }));
    const parts = sections.map(({ page, text }) => {
      if (ocrTexts.has(page)) return `[страница ${page} · OCR]\n${text}`;
      return pagesTotal > 1 ? `[страница ${page}]\n${text}` : text;
    });

    let pdfKind = 'text';
    if (textPages === 0 && ocrPages > 0) pdfKind = 'scan_ocr';
    else if (textPages === 0 && ocrPages === 0) pdfKind = 'scan_unrecognized';
    else if (ocrPages > 0 || (needsOcr && emptyPages.length > 0)) pdfKind = 'mixed';

    return {
      text: parts.join('\n\n'),
      pdfKind,
      ocrStatus,
      pagesTotal,
      textPages,
      ocrPages,
      sections,
      incomplete: scannedPages < pagesTotal || emptyPages.length > ocrTexts.size,
    };
  } finally {
    await task.destroy();
  }
}

function documentSearchReader(ocrPdf) {
  return async (file, signal) => {
    const buf = await fs.promises.readFile(file, { signal });
    if (path.extname(file).toLowerCase() === '.docx') {
      const text = readDocx(buf);
      return { sections: text.trim() ? [{ text }] : [], incomplete: !text.trim() };
    }
    return readPdf(buf, { absPath: file, ocrPdf, signal, maxPages: 250, maxText: 250000 });
  };
}

function documentTools(index, { renderPdf, ocrPdf = null } = {}) {
  if (!index || typeof index.resolveInside !== 'function' || typeof index.invalidate !== 'function') {
    throw new Error('documentTools: нужен экземпляр WorkspaceIndex');
  }
  const relOf = (abs) => path.relative(index.rootDir, abs).split(path.sep).join('/');

  const read = {
    name: 'document_read',
    description: 'Прочитать документ из рабочей папки: .docx (абзацы и таблицы), .xlsx (листы с именами; sheet — один лист), .csv, .pdf (текстовый слой и, при наличии Windows OCR, сканы). Больше 50000 символов обрезается.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        sheet: { type: 'string', maxLength: 100 },
      },
      required: ['path'],
    },
    async run(args = {}, ctx = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel) return notOk('пустой путь');
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const abs = index.resolveInside(rel);
        const ext = path.extname(abs).toLowerCase();
        if (!READABLE.includes(ext)) return notOk('читаю только .docx, .xlsx, .csv и .pdf');
        if (!fs.existsSync(abs)) return notOk('файл не найден');
        const st = fs.statSync(abs);
        if (!st.isFile()) return notOk('это не файл');
        if (st.size > MAX_FILE) return notOk(`файл больше ${MAX_FILE / 1024 / 1024} МБ`);
        const buf = fs.readFileSync(abs);
        if (ext === '.pdf') {
          const pdf = await readPdf(buf, { absPath: abs, ocrPdf, signal: ctx && ctx.signal });
          if (!pdf.text) {
            const msg = pdf.ocrStatus === 'no_text_found'
              ? `в PDF нет текста (страниц: ${pdf.pagesTotal}): похоже на скан, распознавание текста не нашло`
              : `в PDF нет текста (страниц: ${pdf.pagesTotal}): похоже на скан, OCR недоступен или не распознан`;
            return {
              ok: false,
              summary: msg,
              data: {
                path: relOf(abs),
                text: '',
                truncated: false,
                size: st.size,
                pdfKind: pdf.pdfKind,
                ocrStatus: pdf.ocrStatus,
                pagesTotal: pdf.pagesTotal,
                textPages: pdf.textPages,
                ocrPages: pdf.ocrPages,
              },
            };
          }
          const body = pdf.text;
          const truncated = body.length > MAX_TEXT;
          const text = truncated ? body.slice(0, MAX_TEXT) : body;
          let summary;
          if (pdf.pdfKind === 'scan_ocr') {
            summary = truncated
              ? `распознано по скану (OCR), обрезано: первые ${MAX_TEXT} из ${body.length} символов (стр. ${pdf.ocrPages}/${pdf.pagesTotal})`
              : `распознано по скану (OCR): ${body.length} символов (стр. ${pdf.ocrPages}/${pdf.pagesTotal})`;
          } else if (pdf.pdfKind === 'mixed') {
            summary = truncated
              ? `прочитано с OCR, обрезано: первые ${MAX_TEXT} из ${body.length} символов (текст: ${pdf.textPages}, OCR: ${pdf.ocrPages} из ${pdf.pagesTotal})`
              : `прочитано с OCR: ${body.length} символов (текст: ${pdf.textPages}, OCR: ${pdf.ocrPages} из ${pdf.pagesTotal})`;
          } else {
            summary = truncated
              ? `документ обрезан: первые ${MAX_TEXT} из ${body.length} символов`
              : `прочитано: ${body.length} символов`;
          }
          return {
            ok: true,
            summary,
            data: {
              path: relOf(abs),
              text,
              truncated,
              size: st.size,
              pdfKind: pdf.pdfKind,
              ocrStatus: pdf.ocrStatus,
              pagesTotal: pdf.pagesTotal,
              textPages: pdf.textPages,
              ocrPages: pdf.ocrPages,
            },
          };
        }
        let body;
        if (ext === '.docx') body = readDocx(buf);
        else if (ext === '.xlsx') body = readXlsx(buf, args.sheet);
        else body = parseCsv(buf.toString('utf8')).map(lineOf).join('\n');
        const truncated = body.length > MAX_TEXT;
        const text = truncated ? body.slice(0, MAX_TEXT) : body;
        const summary = truncated
          ? `документ обрезан: первые ${MAX_TEXT} из ${body.length} символов`
          : `прочитано: ${body.length} символов`;
        return { ok: true, summary, data: { path: relOf(abs), text, truncated, size: st.size } };
      } catch (err) {
        return fail(err);
      }
    },
  };

  const write = {
    name: 'document_write',
    description: 'Записать документ в рабочую папку: docx (title и text или rows), xlsx и csv (rows или text; title — имя листа), pdf (title и text), если подключена печать PDF, pptx (title и subtitle — обложка; slides — заголовок, пункты и необязательная раскладка: agenda — нумерованное содержание, cards — 2–3 карточки «Заголовок: текст», list — обычный список). Существующий файл заменяется только с overwrite: true.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        format: { type: 'string', enum: FORMATS },
        title: { type: 'string', maxLength: 200 },
        subtitle: { type: 'string', maxLength: 250 },
        text: { type: 'string', maxLength: MAX_TEXT },
        slides: {
          type: 'array',
          maxItems: MAX_SLIDES,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 200 },
              layout: { type: 'string', enum: ['list', 'agenda', 'cards'] },
              bullets: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 300 } },
            },
          },
        },
        rows: {
          type: 'array',
          maxItems: MAX_ROWS,
          items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
        },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'format'],
    },
    async run(args = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel) return notOk('пустой путь');
        if (rel.length > MAX_PATH) return notOk(`путь длиннее ${MAX_PATH} символов`);
        const format = String(args.format || '');
        if (!FORMATS.includes(format)) return notOk('формат: docx, xlsx, csv, pdf или pptx');
        if (path.extname(rel).toLowerCase() !== `.${format}`) return notOk(`расширение файла должно быть .${format}`);
        if (/[<>:"|?*\x00-\x1f]/.test(path.basename(rel))) return notOk('в имени файла есть символы, которых нет в Windows: < > : " | ? *');
        const rows = rowsOf(args);
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        // Презентация: слайды из slides, а без них — текст строками на одном слайде.
        let slides = format === 'pptx' ? normalizeSlides(args.slides) : [];
        if (format === 'pptx' && !slides.length && rows.length) slides = [{ title: title || 'Слайд', bullets: rows.map(lineOf) }];
        if (!title && rows.length === 0 && slides.length === 0) return notOk('нет содержимого: передайте text, rows или slides');
        if (rows.length > MAX_ROWS) return notOk(`строк больше ${MAX_ROWS}`);
        const abs = writeTarget(index, rel, null);
        const exists = fs.existsSync(abs);
        if (exists) {
          if (fs.statSync(abs).isDirectory()) return notOk('это папка');
          if (!args.overwrite) return notOk('файл уже есть: укажите overwrite: true, чтобы заменить');
          const denied = reportsOnly(index, abs);
          if (denied) return notOk(denied);
        }
        let body;
        if (format === 'pptx') {
          if (slides.length > MAX_SLIDES) return notOk(`слайдов больше ${MAX_SLIDES}`);
          body = pptxBuffer({ title, subtitle: typeof args.subtitle === 'string' ? args.subtitle.slice(0, 250) : '', slides });
        } else if (format === 'docx') body = docxBuffer(title, rows);
        else if (format === 'xlsx') body = xlsxBuffer(title, rows.length ? rows : [['']]);
        else if (format === 'csv') body = csvBuffer(rows);
        else {
          if (!renderPdf) return notOk('запись PDF пока недоступна: нет движка печати');
          body = await renderPdf(pdfHtml(clean(title), rows));
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Атомарная запись: временный файл рядом, затем переименование.
        const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, abs);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        index.invalidate();
        return {
          ok: true,
          summary: exists ? 'перезаписал' : 'записал',
          data: {
            path: relOf(abs), format, created: !exists,
            ...(format === 'pptx' ? { slides: slides.length + (title ? 1 : 0) } : {}),
            ...(format === 'xlsx' ? { rows: rows.length || 1 } : {}),
            ...(format === 'csv' ? { rows: parseCsv(body.toString('utf8')).length } : {}),
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
    // Проверка эффекта: файл есть; docx, xlsx и csv читаются обратно через document_read; pdf начинается с %PDF.
    async verify(args = {}, result = {}) {
      if (!result.data || !result.data.path) return { status: 'unknown', evidence: 'нет пути результата' };
      const abs = index.resolveInside(result.data.path);
      if (!fs.existsSync(abs)) return { status: 'failed', evidence: `файла ${result.data.path} нет на диске` };
      if (result.data.format === 'pptx') {
        // Презентация не читается как текст: проверяем архив и число слайдов.
        const check = pptxCheck(fs.readFileSync(abs), result.data.slides);
        return check.ok
          ? { status: 'confirmed', evidence: `структура презентации ${result.data.path} проверена: ${check.evidence}` }
          : { status: 'failed', evidence: `презентация ${result.data.path} повреждена или неполна: ${check.evidence}` };
      }
      if (result.data.format === 'pdf') {
        const head = fs.readFileSync(abs).subarray(0, 5).toString('latin1');
        return head === '%PDF-'
          ? { status: 'confirmed', evidence: `файл ${result.data.path} — PDF` }
          : { status: 'failed', evidence: `файл ${result.data.path} не похож на PDF` };
      }
      const back = await read.run({ path: result.data.path });
      return back.ok
        ? { status: 'confirmed', evidence: `файл ${result.data.path} читается обратно` }
        : { status: 'failed', evidence: `файл ${result.data.path} не читается: ${back.summary}` };
    },
  };

  // Шаблон Word с ключами {{ключ}} (например, диплом по образцу): значения подставляются, результат — новый файл.
  const fill = {
    name: 'document_fill',
    description: 'Заполнить шаблон Word (.docx): в образце ключи в двойных фигурных скобках, например {{ФИО}}. values — значения по ключам. Результат пишется новым файлом (path); существующий заменяется только с overwrite: true. Ключи без значения вернутся в missing.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        values: { type: 'object' },
        overwrite: { type: 'boolean' },
      },
      required: ['template', 'path', 'values'],
    },
    async run(args = {}) {
      try {
        const tplRel = cleanPath(args.template);
        const rel = cleanPath(args.path);
        if (!tplRel || !rel) return notOk('нужны template и path');
        if (path.extname(tplRel).toLowerCase() !== '.docx') return notOk('шаблон должен быть .docx');
        if (path.extname(rel).toLowerCase() !== '.docx') return notOk('результат должен быть .docx');
        if (/[<>:"|?*\x00-\x1f]/.test(path.basename(rel))) return notOk('в имени файла есть символы, которых нет в Windows: < > : " | ? *');
        const tplAbs = index.resolveInside(tplRel);
        if (!fs.existsSync(tplAbs) || !fs.statSync(tplAbs).isFile()) return notOk('шаблон не найден');
        if (fs.statSync(tplAbs).size > MAX_FILE) return notOk(`шаблон больше ${MAX_FILE / 1024 / 1024} МБ`);
        const values = args.values && typeof args.values === 'object' ? args.values : {};
        const out = fillDocx(fs.readFileSync(tplAbs), values);
        const abs = writeTarget(index, rel, null);
        const exists = fs.existsSync(abs);
        if (exists) {
          if (fs.statSync(abs).isDirectory()) return notOk('это папка');
          if (!args.overwrite) return notOk('файл уже есть: укажите overwrite: true, чтобы заменить');
          const denied = reportsOnly(index, abs);
          if (denied) return notOk(denied);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomUUID()}.tmp`);
        try {
          fs.writeFileSync(tmp, out.buffer);
          fs.renameSync(tmp, abs);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        index.invalidate();
        const summary = out.missing.length ? `записал; без значения осталось: ${out.missing.join(', ')}` : 'записал';
        return { ok: true, summary, data: { path: relOf(abs), format: 'docx', created: !exists, filled: out.filled, missing: out.missing } };
      } catch (err) {
        return fail(err);
      }
    },
    // Проверка эффекта: в результате не осталось ни одного заполненного ключа, а сам файл читается как Word.
    async verify(args = {}, result = {}) {
      if (!result.data || !result.data.path) return { status: 'unknown', evidence: 'нет пути результата' };
      const abs = index.resolveInside(result.data.path);
      if (!fs.existsSync(abs)) return { status: 'failed', evidence: `файла ${result.data.path} нет на диске` };
      try {
        const left = placeholdersIn(fs.readFileSync(abs));
        const stuck = (result.data.filled || []).filter((k) => left.includes(k));
        if (stuck.length) return { status: 'failed', evidence: `в документе остались не заполненные ключи: ${stuck.join(', ')}` };
        return { status: 'confirmed', evidence: `документ ${result.data.path} заполнен; без значения: ${(result.data.missing || []).length}` };
      } catch (err) {
        return { status: 'failed', evidence: `документ ${result.data.path} не читается как Word: ${err.message}` };
      }
    },
  };

  const displayOf = (abs) => (typeof index._display === 'function' ? index._display(abs) : relOf(abs));

  const collectFolderFiles = (dirAbs, out, depth = 0) => {
    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return out;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && BATCH_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (depth < 6) collectFolderFiles(abs, out, depth + 1);
      } else if (entry.isFile() && BATCH_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(abs);
      }
    }
    return out;
  };

  const batch = {
    name: 'document_batch',
    description: 'Пакетно прочитать несколько документов из рабочей или подключённой папки (.docx, .xlsx, .csv, .pdf, .txt, .md), при желании отфильтровать по смыслу/словам query и вернуть структурированный отчёт по прочитанным и пропущенным файлам.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string', minLength: 1, maxLength: MAX_PATH }, maxItems: 100 },
        folder: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        query: { type: 'string', minLength: 1, maxLength: 300 },
        maxFiles: { type: 'integer', minimum: 1, maximum: 30, default: 15 },
        maxCharsPerFile: { type: 'integer', minimum: 500, maximum: 15000, default: 4000 },
      },
    },
    async run(args = {}, ctx = {}) {
      try {
        const maxFiles = Number.isInteger(args.maxFiles)
          ? Math.max(1, Math.min(30, args.maxFiles))
          : 15;
        const maxCharsPerFile = Number.isInteger(args.maxCharsPerFile)
          ? Math.max(500, Math.min(15000, args.maxCharsPerFile))
          : 4000;
        const parsedQuery = batchQueryTerms(args.query);

        const queue = [];
        const seenAbs = new Set();
        const skipped = [];

        const explicitPaths = Array.isArray(args.paths) ? args.paths : [];
        for (const raw of explicitPaths) {
          const rel = cleanPath(raw);
          if (!rel) {
            skipped.push({ path: String(raw || ''), reason: 'пустой путь' });
            continue;
          }
          if (rel.length > MAX_PATH) {
            skipped.push({ path: rel.slice(0, 80), reason: `путь длиннее ${MAX_PATH} символов` });
            continue;
          }
          let abs;
          try {
            abs = index.resolveInside(rel);
          } catch (err) {
            skipped.push({ path: rel, reason: err && err.message ? err.message : 'путь вне рабочей папки' });
            continue;
          }
          const key = abs.toLowerCase();
          if (seenAbs.has(key)) continue;
          seenAbs.add(key);
          queue.push({ abs, label: displayOf(abs), explicit: true });
        }

        const shouldScanFolder = args.folder !== undefined || explicitPaths.length === 0;
        if (shouldScanFolder) {
          const folderRel = args.folder !== undefined ? cleanPath(args.folder) : '.';
          if (args.folder !== undefined && !folderRel) {
            return notOk('пустой путь к папке');
          }
          let dirAbs;
          try {
            const candidate = path.resolve(index.rootDir, folderRel || '.');
            dirAbs = candidate === path.resolve(index.rootDir)
              ? index.rootDir
              : index.resolveInside(folderRel);
          } catch (err) {
            return notOk(err && err.message ? err.message : 'папка вне рабочей папки');
          }
          let dirSt;
          try {
            dirSt = fs.lstatSync(dirAbs);
          } catch {
            return notOk(`папка не найдена: ${folderRel}`);
          }
          if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
            return notOk(`это не обычная папка: ${folderRel}`);
          }
          const found = collectFolderFiles(dirAbs, []);
          for (const abs of found) {
            const key = abs.toLowerCase();
            if (seenAbs.has(key)) continue;
            seenAbs.add(key);
            queue.push({ abs, label: displayOf(abs), explicit: false });
          }
        }

        const totalFound = queue.length + skipped.length;
        const processed = [];
        let handled = 0;

        for (const item of queue) {
          if (ctx.signal && ctx.signal.aborted) break;
          if (handled >= maxFiles) {
            skipped.push({ path: item.label, reason: `превышен лимит файлов (maxFiles: ${maxFiles})` });
            continue;
          }

          const base = path.basename(item.abs).toLowerCase();
          if (base === '.env' || base.startsWith('.env.')) {
            skipped.push({ path: item.label, reason: 'закрытый файл (.env не читается)' });
            continue;
          }

          const ext = path.extname(item.abs).toLowerCase();
          if (!BATCH_EXT.has(ext)) {
            skipped.push({ path: item.label, reason: `неподдерживаемый формат (${ext || 'без расширения'})` });
            continue;
          }

          let st;
          try {
            st = fs.lstatSync(item.abs);
          } catch {
            skipped.push({ path: item.label, reason: 'файл не найден' });
            continue;
          }
          if (st.isSymbolicLink()) {
            skipped.push({ path: item.label, reason: 'символическая ссылка не читается' });
            continue;
          }
          if (!st.isFile()) {
            skipped.push({ path: item.label, reason: 'это не файл' });
            continue;
          }
          if (st.size > MAX_FILE) {
            skipped.push({ path: item.label, reason: `файл больше ${MAX_FILE / 1024 / 1024} МБ` });
            continue;
          }

          handled += 1;
          try {
            const buf = fs.readFileSync(item.abs);
            let body = '';
            const extra = {};
            if (ext === '.pdf') {
              const pdf = await readPdf(buf, { absPath: item.abs, ocrPdf, signal: ctx && ctx.signal });
              if (!pdf.text) {
                skipped.push({ path: item.label, reason: `скан PDF не распознан (${pdf.ocrStatus})` });
                continue;
              }
              body = pdf.text;
              extra.pdfKind = pdf.pdfKind;
              extra.ocrStatus = pdf.ocrStatus;
            } else if (ext === '.docx') {
              body = readDocx(buf);
            } else if (ext === '.xlsx') {
              body = readXlsx(buf);
            } else if (ext === '.csv') {
              body = parseCsv(buf.toString('utf8')).map(lineOf).join('\n');
            } else {
              if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) {
                skipped.push({ path: item.label, reason: 'похоже на бинарный файл' });
                continue;
              }
              body = buf.toString('utf8');
              if (looksSecret(body)) {
                skipped.push({ path: item.label, reason: 'текст похож на секрет или ключ' });
                continue;
              }
            }

            const matched = matchBatchText(body, parsedQuery, maxCharsPerFile);
            if (!matched.matched) {
              skipped.push({ path: item.label, reason: 'нет совпадений по запросу' });
              continue;
            }

            const entry = {
              path: item.label,
              kind: ext.slice(1),
              chars: body.length,
              truncated: matched.truncated,
              ...extra,
              ...(matched.matches ? { matches: matched.matches } : {}),
              excerpt: matched.excerpt,
            };
            processed.push(entry);
          } catch (err) {
            skipped.push({ path: item.label, reason: err && err.message ? err.message : String(err) });
          }
        }

        const sources = processed.map((p) => ({
          path: p.path,
          kind: p.kind,
          title: path.basename(p.path),
        }));

        const summaryParts = [
          `Найдено файлов: ${totalFound}`,
          `обработано: ${processed.length}`,
          `пропущено: ${skipped.length}`,
        ];
        if (parsedQuery) summaryParts.push(`запрос: «${String(args.query).trim()}»`);
        let summary = summaryParts.join(', ');
        if (skipped.length > 0) {
          const preview = skipped.slice(0, 5).map((s) => `${s.path} (${s.reason})`).join('; ');
          summary += `. Пропущены: ${preview}${skipped.length > 5 ? ` и ещё ${skipped.length - 5}` : ''}`;
        }

        return {
          ok: true,
          summary,
          data: {
            totalFound,
            processedCount: processed.length,
            skippedCount: skipped.length,
            processed,
            skipped,
            sources,
          },
        };
      } catch (err) {
        return fail(err);
      }
    },
  };

  return [read, write, fill, batch];
}

// Отдельный шаг: проверка файла не доказывает, что PowerPoint открыл его.
function presentationOpenTool(index, { openPath, probeOpen }) {
  function insideRoot(root, file) {
    const rel = path.relative(root, file);
    return Boolean(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }
  return {
    name: 'presentation_open',
    risk: 'T1',
    description: 'Открыть существующую презентацию .pptx из рабочей папки в приложении Windows. Отдельно проверяет точный путь документа в PowerPoint. Используй после document_write, если владелец попросил открыть результат.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: MAX_PATH } },
      required: ['path'],
    },
    async run(args = {}, ctx = {}) {
      try {
        const rel = cleanPath(args.path);
        if (!rel || rel.length > MAX_PATH || path.extname(rel).toLowerCase() !== '.pptx') return notOk('нужен путь к файлу .pptx');
        const abs = index.resolveInside(rel);
        if (!insideRoot(index.rootDir, abs)) return notOk('нужен файл .pptx в рабочей папке');
        const file = fs.realpathSync(abs);
        const root = fs.realpathSync(index.rootDir);
        if (!insideRoot(root, file) || path.extname(file).toLowerCase() !== '.pptx'
            || !fs.statSync(file).isFile()) return notOk('нужен файл .pptx в рабочей папке');
        if (ctx.signal?.aborted) return notOk('отменено');
        const error = await openPath(file);
        return error ? notOk(`Windows не открыла презентацию: ${error}`)
          : { ok: true, summary: `Windows приняла запрос на открытие «${path.basename(file)}»`, data: { path: file } };
      } catch (err) {
        return fail(err);
      }
    },
    async verify(_args, result, ctx = {}) {
      const file = result.data.path;
      const opened = await probeOpen(file, ctx);
      return opened
        ? { status: 'confirmed', evidence: `PowerPoint показывает «${path.basename(file)}»` }
        : { status: 'unknown', evidence: 'Не удалось подтвердить, что этот файл открыт в PowerPoint' };
    },
  };
}

module.exports = { documentTools, documentSearchReader, presentationOpenTool, parseCsv, readPdf };
