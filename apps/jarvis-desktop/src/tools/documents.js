'use strict';

// Документы: чтение DOCX, XLSX, CSV, PDF и запись DOCX, XLSX, CSV, PDF. DOCX и XLSX на zlib (zip.js), PDF читает pdfjs-dist.
// Пути проверяет WorkspaceIndex.resolveInside, как у workspace_*. Любая ошибка возвращается как {ok: false, summary}.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readZip, writeZip } = require('./zip');
const { writeTarget, reportsOnly } = require('./workspace');
const { pptxBuffer, pptxCheck, normalizeSlides } = require('./pptx');

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TEXT = 50000;
const MAX_PATH = 300;
const MAX_ROWS = 5000;
const FORMATS = ['docx', 'xlsx', 'csv', 'pdf', 'pptx'];
const MAX_SLIDES = 40;
const READABLE = ['.docx', '.xlsx', '.csv', '.pdf'];

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

// Файл чужой: шрифты и код из него не исполняем, берём только текст. Читаем до предела MAX_TEXT, остальные страницы не трогаем.
async function readPdf(buf) {
  const { getDocument, VerbosityLevel } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: VerbosityLevel.ERRORS });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('PDF защищён паролем');
    throw new Error('файл PDF повреждён или не читается', { cause: err });
  }
  try {
    const parts = [];
    let size = 0;
    for (let n = 1; n <= doc.numPages && size <= MAX_TEXT; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
      page.cleanup();
      if (text) parts.push(doc.numPages > 1 ? `[страница ${n}]\n${text}` : text);
      size += text.length;
    }
    if (!parts.length) throw new Error(`в PDF нет текста (страниц: ${doc.numPages}): похоже на скан, текст из картинок я не читаю`);
    return parts.join('\n\n');
  } finally {
    await task.destroy();
  }
}

function documentTools(index, { renderPdf } = {}) {
  if (!index || typeof index.resolveInside !== 'function' || typeof index.invalidate !== 'function') {
    throw new Error('documentTools: нужен экземпляр WorkspaceIndex');
  }
  const relOf = (abs) => path.relative(index.rootDir, abs).split(path.sep).join('/');

  const read = {
    name: 'document_read',
    description: 'Прочитать документ из рабочей папки: .docx (абзацы и таблицы), .xlsx (листы с именами; sheet — один лист), .csv, .pdf (только текст, сканы не читаются). Больше 50000 символов обрезается.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        sheet: { type: 'string', maxLength: 100 },
      },
      required: ['path'],
    },
    async run(args = {}) {
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
        let body;
        if (ext === '.pdf') body = await readPdf(buf);
        else if (ext === '.docx') body = readDocx(buf);
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
    description: 'Записать документ в рабочую папку: docx (title и text или rows), xlsx и csv (rows или text; title — имя листа), pdf (title и text), если подключена печать PDF, pptx (презентация: title — обложка, slides — слайды с заголовком и пунктами). Существующий файл заменяется только с overwrite: true.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH },
        format: { type: 'string', enum: FORMATS },
        title: { type: 'string', maxLength: 200 },
        text: { type: 'string', maxLength: MAX_TEXT },
        slides: {
          type: 'array',
          maxItems: MAX_SLIDES,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 200 },
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
          body = pptxBuffer({ title, slides });
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
          data: { path: relOf(abs), format, created: !exists, ...(format === 'pptx' ? { slides: slides.length + (title ? 1 : 0) } : {}) },
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
          ? { status: 'confirmed', evidence: `презентация ${result.data.path} открывается: ${check.evidence}` }
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

  return [read, write];
}

module.exports = { documentTools, parseCsv };
