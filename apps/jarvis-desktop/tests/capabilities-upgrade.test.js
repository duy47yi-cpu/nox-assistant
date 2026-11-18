'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  AppInventory,
  category,
  CATEGORY_LABELS,
  formatAppSummary,
} = require('../src/inventory/apps');
const {
  imageTools,
  ocrPdfFile,
  PDF_OCR_SCRIPT,
} = require('../src/tools/ocr');
const {
  documentTools,
  documentSearchReader,
  readPdf,
} = require('../src/tools/documents');
const { workspaceTools } = require('../src/tools/workspace');
const { calendarTools } = require('../src/tools/calendar');
const { mailTools, MailDraftStore, MAIL_TEMPLATES } = require('../src/tools/mail');
const { renderTemplate, suggestRecipients } = require('../src/mail/drafts');
const {
  BrowserPage,
  BrowserBookmarkStore,
  browserTools,
  detectAuthNeeded,
  MULTI_TAB_NOTE,
  SNAPSHOT_SCRIPT,
} = require('../src/tools/browser');
const { WorkspaceIndex } = require('../src/rag/index');

function tempDir(t, prefix = 'nox-cap-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Простейший многостраничный PDF-конструктор для тестов pdfjs-dist: каждая строка массива — содержимое страницы.
function makeMultiPagePdf(pageBodies) {
  const objs = [];
  const pageCount = pageBodies.length;
  // 1: Catalog, 2: Pages, 3: Font F1, затем на каждую страницу пара (Page, Contents)
  const pageIds = [];
  const contentIds = [];
  for (let i = 0; i < pageCount; i += 1) {
    pageIds.push(4 + i * 2);
    contentIds.push(5 + i * 2);
  }
  objs.push(`1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`);
  objs.push(`2 0 obj<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${pageCount}>>endobj`);
  objs.push(`3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);
  for (let i = 0; i < pageCount; i += 1) {
    const body = pageBodies[i];
    objs.push(`${pageIds[i]} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents ${contentIds[i]} 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj`);
    objs.push(`${contentIds[i]} 0 obj<</Length ${body.length}>>stream\n${body}\nendstream endobj`);
  }
  return Buffer.from(`%PDF-1.4\n${objs.join('\n')}\ntrailer<</Root 1 0 R>>\n%%EOF`);
}

test('workspace_search: страницы PDF и выдержки DOCX из подключённой папки', async (t) => {
  const root = tempDir(t);
  const course = tempDir(t);
  const connected = new WorkspaceIndex(course);
  const writer = documentTools(connected).find((tool) => tool.name === 'document_write');
  assert.equal((await writer.run({ path: 'lecture.docx', format: 'docx', text: 'Solenoid induction depends on the coil.' })).ok, true);
  fs.writeFileSync(path.join(course, 'course.pdf'), makeMultiPagePdf([
    'BT /F1 14 Tf 10 100 Td (Introduction) Tj ET',
    'BT /F1 14 Tf 10 100 Td (Solenoid induction depends on the current.) Tj ET',
  ]));
  fs.writeFileSync(path.join(course, 'broken.pdf'), 'broken');
  const index = new WorkspaceIndex(root);
  index.setFolders([course]);
  const search = workspaceTools(index, { readSearchDocument: documentSearchReader() })
    .find((tool) => tool.name === 'workspace_search');
  const result = await search.run({ query: 'solenoid induction' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.map((hit) => [path.basename(hit.path), hit.page, hit.snippet]), [
    ['course.pdf', 2, 'Solenoid induction depends on the current.'],
    ['lecture.docx', undefined, 'Solenoid induction depends on the coil.'],
  ]);
  assert.match(result.summary, /пропущено: 1/);

  index.setFolders([]);
  assert.deepEqual((await search.run({ query: 'solenoid' })).data, []);
});

// 1. Инвентаризация программ: творческие инструменты и локальный ИИ.
test('apps inventory: расширенные creative и новая категория ai (Локальный ИИ)', (t) => {
  const dir = tempDir(t, 'nox-apps-');
  const inv = new AppInventory(path.join(dir, 'apps.json'));

  const creativeSamples = [
    'CapCut', 'VEGAS Pro', 'Adobe After Effects 2025', 'Wondershare Filmora',
    'Kdenlive', 'Shotcut', 'Microsoft Clipchamp', 'Camtasia', 'Movavi Video Editor',
    'OpenShot', 'Topaz Video AI', 'Adobe Media Encoder', 'Adobe Illustrator',
    'Figma', 'GIMP', 'Krita', 'paint.net', 'Inkscape', 'CorelDRAW', 'Canva',
    'Affinity Photo', 'Adobe Lightroom Classic', 'Aseprite',
    'DaVinci Resolve', 'Adobe Premiere Pro', 'OBS Studio', 'HandBrake',
    'Blender', 'Adobe Photoshop', 'Audacity',
  ];
  for (const name of creativeSamples) {
    assert.equal(category(name), 'creative', `ожидался creative для ${name}`);
  }

  const aiSamples = [
    'Ollama', 'LM Studio', 'LMStudio', 'ComfyUI', 'Stable Diffusion',
    'Automatic1111', 'WebUI Forge', 'koboldcpp', 'GPT4All', 'Jan.ai',
    'Jan', 'AnythingLLM', 'Open WebUI', 'Pinokio', 'Whisper Desktop',
  ];
  for (const name of aiSamples) {
    assert.equal(category(name), 'ai', `ожидался ai для ${name}`);
  }
  assert.notEqual(category('January Planner'), 'ai', 'граница слова \\bjan\\b не должна ловить January');

  inv.entries = [
    { name: 'Google Chrome', exe: 'chrome.exe' },
    { name: 'CapCut', exe: 'capcut.exe' },
    { name: 'Figma', exe: 'figma.exe' },
    { name: 'Ollama', exe: 'ollama.exe' },
    { name: 'LM Studio', exe: 'lmstudio.exe' },
  ];
  inv.scannedAt = new Date().toISOString();

  const s = inv.summary();
  assert.deepEqual(s.creative, ['CapCut', 'Figma']);
  assert.deepEqual(s.ai, ['Ollama', 'LM Studio']);
  assert.equal(s.total, 5);

  assert.equal(CATEGORY_LABELS.ai, 'Локальный ИИ');
  const text = inv.summaryText();
  assert.match(text, /Локальный ИИ: Ollama, LM Studio/);
  assert.match(text, /Графика и монтаж: CapCut, Figma/);
  assert.equal(text, formatAppSummary(s));
});

// 2. OCR картинок и PDF-сканов.
test('ocr: image_read_text добавляет ocrStatus/lineCount и ocrPdfFile обрабатывает все статусы', async (t) => {
  const dir = tempDir(t, 'nox-ocr-');
  const imgPath = path.join(dir, 'sample.png');
  fs.writeFileSync(imgPath, Buffer.from([137, 80, 78, 71]));

  const recognizedRunner = async () => ({
    ok: true,
    summary: 'ок',
    data: {
      stdout: JSON.stringify([
        { text: 'Первая строка', x: 1, y: 2, width: 100, height: 20 },
        { text: 'Вторая строка', x: 1, y: 30, width: 110, height: 20 },
      ]),
    },
  });
  const [readRecognized] = imageTools({ workspace: dir, runner: recognizedRunner });
  const r1 = await readRecognized.run({ path: 'sample.png' });
  assert.equal(r1.ok, true);
  assert.equal(r1.data.ocrStatus, 'recognized');
  assert.equal(r1.data.lineCount, 2);

  const emptyRunner = async () => ({ ok: true, summary: 'ок', data: { stdout: '[]' } });
  const [readEmpty] = imageTools({ workspace: dir, runner: emptyRunner });
  const r2 = await readEmpty.run({ path: 'sample.png' });
  assert.equal(r2.ok, true);
  assert.equal(r2.data.ocrStatus, 'empty');
  assert.equal(r2.data.lineCount, 0);

  // Скрипт PDF OCR передаёт путь только через env и не содержит прямой интерполяции пути.
  assert.match(PDF_OCR_SCRIPT, /\$env:JARVIS_PDF/);
  assert.match(PDF_OCR_SCRIPT, /\$env:JARVIS_PDF_MAX_PAGES/);
  assert.match(PDF_OCR_SCRIPT, /Windows\.Data\.Pdf\.PdfDocument/);
  assert.match(PDF_OCR_SCRIPT, /Windows\.Media\.Ocr\.OcrEngine/);

  let seenEnv = null;
  const okPdf = await ocrPdfFile('C:\\docs\\scan.pdf', {
    maxPages: 7,
    runner: async (_script, env) => {
      seenEnv = env;
      return {
        ok: true,
        summary: 'ок',
        data: { stdout: JSON.stringify({ status: 'ok', pageCount: 2, pages: [{ page: 1, text: 'Договор № 10' }] }) },
      };
    },
  });
  assert.deepEqual(seenEnv, { JARVIS_PDF: 'C:\\docs\\scan.pdf', JARVIS_PDF_MAX_PAGES: '7' });
  assert.equal(okPdf.status, 'ok');
  assert.equal(okPdf.pageCount, 2);
  assert.deepEqual(okPdf.pages, [{ page: 1, text: 'Договор № 10' }]);

  const noEngine = await ocrPdfFile('scan.pdf', {
    runner: async () => ({ ok: true, data: { stdout: JSON.stringify({ status: 'no_engine', pageCount: 0, pages: [] }) } }),
  });
  assert.equal(noEngine.status, 'no_engine');

  const pwd = await ocrPdfFile('scan.pdf', {
    runner: async () => ({ ok: true, data: { stdout: JSON.stringify({ status: 'password', pageCount: 0, pages: [] }) } }),
  });
  assert.equal(pwd.status, 'password');

  const empty = await ocrPdfFile('scan.pdf', {
    runner: async () => ({ ok: true, data: { stdout: JSON.stringify({ status: 'empty', pageCount: 3, pages: [] }) } }),
  });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.pageCount, 3);

  const crashed = await ocrPdfFile('scan.pdf', {
    runner: async () => { throw new Error('boom'); },
  });
  assert.equal(crashed.status, 'error');
  assert.match(crashed.error, /boom/);
});

// 3. document_read с OCR сканов/смешанных PDF и пакетное чтение document_batch.
test('documents: OCR сканов PDF (scan_ocr, mixed, partial, fallback) и document_batch', async (t) => {
  const dir = tempDir(t, 'nox-docs-');

  // Чисто текстовый PDF
  const textPdfPath = path.join(dir, 'text.pdf');
  fs.writeFileSync(textPdfPath, makeMultiPagePdf(['BT /F1 14 Tf 10 100 Td (Quarterly Budget Report) Tj ET']));

  // 2-страничный скан без текстового слоя
  const scanPdfPath = path.join(dir, 'scan2.pdf');
  fs.writeFileSync(scanPdfPath, makeMultiPagePdf(['0 0 m 10 10 l S', '0 0 m 20 20 l S']));

  // 8-страничный смешанный PDF: текст только на стр. 1 (1/8 = 12.5% < 15%), стр. 2..8 пустые
  const mixedBodies = ['BT /F1 14 Tf 10 100 Td (Cover Sheet) Tj ET', '0 0 m S', '0 0 m S', '0 0 m S', '0 0 m S', '0 0 m S', '0 0 m S', '0 0 m S'];
  const mixedPdfPath = path.join(dir, 'mixed.pdf');
  fs.writeFileSync(mixedPdfPath, makeMultiPagePdf(mixedBodies));

  // Проверка readPdf напрямую: частичный OCR на скане
  const partialMeta = await readPdf(fs.readFileSync(scanPdfPath), {
    absPath: scanPdfPath,
    ocrPdf: async () => ({ status: 'ok', pageCount: 2, pages: [{ page: 1, text: 'Акт приёмки' }] }),
  });
  assert.equal(partialMeta.pdfKind, 'scan_ocr');
  assert.equal(partialMeta.ocrStatus, 'partial');
  assert.equal(partialMeta.pagesTotal, 2);
  assert.equal(partialMeta.textPages, 0);
  assert.equal(partialMeta.ocrPages, 1);
  assert.match(partialMeta.text, /\[страница 1 · OCR\]\nАкт приёмки/);

  // Смешанный PDF с полным OCR пустых страниц
  const mixedMeta = await readPdf(fs.readFileSync(mixedPdfPath), {
    absPath: mixedPdfPath,
    ocrPdf: async () => ({
      status: 'ok',
      pageCount: 8,
      pages: [2, 3, 4, 5, 6, 7, 8].map((n) => ({ page: n, text: `Скан стр ${n}` })),
    }),
  });
  assert.equal(mixedMeta.pdfKind, 'mixed');
  assert.equal(mixedMeta.ocrStatus, 'recognized');
  assert.equal(mixedMeta.textPages, 1);
  assert.equal(mixedMeta.ocrPages, 7);
  assert.match(mixedMeta.text, /\[страница 1\]\nCover Sheet/);
  assert.match(mixedMeta.text, /\[страница 2 · OCR\]\nСкан стр 2/);

  // Инструменты document_read и document_batch
  const index = new WorkspaceIndex(dir);
  const tools = documentTools(index, {
    ocrPdf: async (absPath) => {
      if (absPath.endsWith('scan2.pdf')) {
        return {
          status: 'ok',
          pageCount: 2,
          pages: [
            { page: 1, text: 'Счёт фактура от поставщика' },
            { page: 2, text: 'Итого к оплате 12000' },
          ],
        };
      }
      return { status: 'empty', pageCount: 1, pages: [] };
    },
  });
  const readTool = tools.find((x) => x.name === 'document_read');
  const writeTool = tools.find((x) => x.name === 'document_write');
  const batchTool = tools.find((x) => x.name === 'document_batch');
  assert.ok(batchTool);
  assert.equal(batchTool.risk, 'T0');

  const rText = await readTool.run({ path: 'text.pdf' });
  assert.equal(rText.ok, true);
  assert.equal(rText.data.pdfKind, 'text');
  assert.equal(rText.data.ocrStatus, 'not_needed');

  const rScan = await readTool.run({ path: 'scan2.pdf' });
  assert.equal(rScan.ok, true);
  assert.equal(rScan.data.pdfKind, 'scan_ocr');
  assert.equal(rScan.data.ocrStatus, 'recognized');
  assert.equal(rScan.data.ocrPages, 2);
  assert.match(rScan.data.text, /\[страница 2 · OCR\]/);

  // Без ocrPdf скан возвращает понятный отказ со статусом
  const noOcrRead = documentTools(index).find((x) => x.name === 'document_read');
  const rNoOcr = await noOcrRead.run({ path: 'scan2.pdf' });
  assert.equal(rNoOcr.ok, false);
  assert.equal(rNoOcr.data.pdfKind, 'scan_unrecognized');
  assert.equal(rNoOcr.data.ocrStatus, 'unavailable');
  assert.match(rNoOcr.summary, /скан/);

  // Подготовим документы разных форматов для пакетного чтения
  await writeTool.run({ path: 'contract.docx', format: 'docx', title: 'Договор поставки', text: 'Поставка оборудования и оплата в ноябре.' });
  await writeTool.run({ path: 'budget.xlsx', format: 'xlsx', title: 'Бюджет', rows: [['Статья', 'Сумма'], ['Серверы', '50000']] });
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Встреча\nОбсудили поставку и бюджет на квартал.', 'utf8');
  fs.writeFileSync(path.join(dir, 'table.csv'), 'name;amount\nСервер;100', 'utf8');
  fs.writeFileSync(path.join(dir, 'photo.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=123456', 'utf8');
  fs.writeFileSync(path.join(dir, 'empty-scan.pdf'), makeMultiPagePdf(['0 0 m S']));

  // Пакетное чтение по явным путям: проверяем пропуск неподдерживаемых, .env, missing и sandbox escape
  const batchPaths = await batchTool.run({
    paths: ['contract.docx', 'budget.xlsx', 'scan2.pdf', 'notes.md', 'table.csv', 'photo.png', '.env', 'missing.txt', '../outside.txt'],
    maxCharsPerFile: 500,
  });
  assert.equal(batchPaths.ok, true);
  assert.equal(batchPaths.data.processedCount, 5);
  assert.equal(batchPaths.data.skippedCount, 4);
  assert.equal(batchPaths.data.totalFound, 9);
  assert.equal(batchPaths.data.sources.length, 5);
  assert.ok(batchPaths.data.skipped.some((s) => s.path === 'photo.png' && /формат/.test(s.reason)));
  assert.ok(batchPaths.data.skipped.some((s) => s.path === '.env' && /\.env/.test(s.reason)));
  assert.ok(batchPaths.data.skipped.some((s) => s.path === '../outside.txt'));
  assert.ok(batchPaths.data.skipped.some((s) => s.path === 'missing.txt' && /не найден/.test(s.reason)));

  // Поиск по основе слова в папке + учёт maxFiles
  const batchQuery = await batchTool.run({ folder: '.', query: 'поставки', maxFiles: 10 });
  assert.equal(batchQuery.ok, true);
  const matchedPaths = batchQuery.data.processed.map((p) => p.path);
  assert.ok(matchedPaths.includes('contract.docx'));
  assert.ok(matchedPaths.includes('notes.md'));
  assert.ok(!matchedPaths.includes('table.csv'));
  assert.ok(batchQuery.data.skipped.some((s) => s.path === 'table.csv' && /совпадений/.test(s.reason)));

  const capped = await batchTool.run({ folder: '.', maxFiles: 2 });
  assert.equal(capped.ok, true);
  assert.ok(capped.data.processedCount <= 2);
  assert.ok(capped.data.skipped.some((s) => /maxFiles/.test(s.reason)));
});

// 4. Календарь: недельная группировка и calendar_prep.
test('calendar: byDay при days >= 5 и calendar_prep с реальными заметками и конфликтами', async (t) => {
  const dir = tempDir(t, 'nox-cal-');
  const icsPath = path.join(dir, 'week.ics');
  const now = Date.parse('2026-11-16T06:00:00Z'); // Понедельник
  fs.writeFileSync(icsPath, [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:w-1',
    'SUMMARY:Синхронизация по бюджету',
    'DTSTART:20261116T080000Z',
    'DTEND:20261116T090000Z',
    'LOCATION:https://meet.example/budget',
    'DESCRIPTION:Согласовать лимиты Q4',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:w-2',
    'SUMMARY:Пересекающийся созвон',
    'DTSTART:20261116T083000Z',
    'DTEND:20261116T091500Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:w-3',
    'SUMMARY:Архитектурный разбор',
    'DTSTART:20261118T110000Z',
    'DTEND:20261118T120000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n'), 'utf8');

  let source = null;
  let queriedTopic = '';
  const [upcoming, _briefing, prep] = calendarTools({
    getSource: () => source,
    getTimeZone: () => 'Europe/Moscow',
    now: () => now,
    searchNotes: async (topic) => {
      queriedTopic = topic;
      return [{ path: 'notes/q4.md', text: 'Черновик бюджета Q4 согласован с финансами.' }];
    },
  });
  assert.equal(prep.name, 'calendar_prep');
  assert.equal(prep.risk, 'T0');

  // Без подключения — ничего не выдумывается
  const noConn = await prep.run({});
  assert.equal(noConn.ok, true);
  assert.equal(noConn.data.state, 'not_connected');
  assert.equal(noConn.data.meeting, null);

  // Подключаем реальный ICS
  source = { filePath: icsPath, label: 'Рабочий ICS', timeZone: 'Europe/Moscow' };
  const week = await upcoming.run({ days: 7 });
  assert.equal(week.ok, true);
  assert.equal(week.data.byDay.length, 2);
  assert.match(week.data.byDay[0].weekday, /понедельник/i);
  assert.match(week.data.byDay[1].weekday, /среда/i);
  assert.match(week.summary, /понедельник/i);
  assert.match(week.summary, /среда/i);

  // calendar_prep для ближайшей/найденной встречи
  const pOk = await prep.run({ query: 'бюджет', hoursAhead: 72 });
  assert.equal(pOk.ok, true);
  assert.equal(pOk.data.meeting.title, 'Синхронизация по бюджету');
  assert.equal(pOk.data.meeting.location, 'https://meet.example/budget');
  assert.equal(pOk.data.meeting.description, 'Согласовать лимиты Q4');
  assert.equal(pOk.data.meeting.conflict, true);
  assert.ok(pOk.data.conflictWarning);
  assert.equal(pOk.data.notes.length, 1);
  assert.match(queriedTopic, /бюджет/i);
  assert.ok(pOk.data.checklist.length >= 4);
  assert.equal((await prep.verify({}, pOk)).status, 'confirmed');

  // Запрос к несуществующей встрече не выдумывает её
  const pMiss = await prep.run({ query: 'маркетинг несуществующий', hoursAhead: 48 });
  assert.equal(pMiss.ok, true);
  assert.equal(pMiss.data.meeting, null);
  assert.match(pMiss.summary, /не найдено/);
});

// 5. Черновики писем, шаблоны и подсказки адресатов.
test('mail: MailDraftStore, шаблоны, дедупликация получателей, отказ от секретов и mail_draft', async (t) => {
  const dir = tempDir(t, 'nox-mail-');
  const draftFile = path.join(dir, 'drafts.json');
  const store = new MailDraftStore(draftFile);

  assert.equal(MAIL_TEMPLATES.length, 5);
  const rendered = renderTemplate('встреча', { name: 'Иван', topic: 'Релиз', when: 'завтра в 15:00' });
  assert.equal(rendered.subject, 'Встреча: Релиз');
  assert.match(rendered.body, /Здравствуйте, Иван!/);
  assert.match(rendered.body, /завтра в 15:00/);

  const recipients = suggestRecipients({
    knownRecipients: ['Alice@Example.com', 'bob@example.com'],
    hints: ['Алиса <alice@example.com>', 'Carol <carol@example.org>', 'invalid-email'],
  });
  assert.equal(recipients.length, 3);
  const alice = recipients.find((r) => r.email === 'alice@example.com');
  assert.equal(alice.name, 'Алиса');
  assert.equal(alice.source, 'known');

  let sendCalls = 0;
  const fakeGmail = {
    send: async () => { sendCalls += 1; return { ok: true, id: '1' }; },
    listUnread: async () => ({ ok: true, items: [] }),
  };

  // По умолчанию — только 2 инструмента (обратная совместимость)
  assert.equal(mailTools(fakeGmail).length, 2);

  const tools = mailTools(fakeGmail, {
    knownRecipients: () => ['alice@example.com', 'bob@example.com'],
    draftStore: store,
    enableDrafts: true,
  });
  assert.equal(tools.length, 3);
  const draftTool = tools[2];
  assert.equal(draftTool.name, 'mail_draft');
  assert.equal(draftTool.risk, 'T0');

  // Подсказки получателей
  const sug = await draftTool.run({ action: 'suggest_recipients', contactHints: ['Алиса <ALICE@example.com>', 'dmitry@work.ru'], query: 'ali' });
  assert.equal(sug.ok, true);
  assert.equal(sug.data.total, 1);
  assert.equal(sug.data.recipients[0].email, 'alice@example.com');

  // Отказ сохранять секреты в черновике
  const secretAttempt = await draftTool.run({
    action: 'save',
    to: 'alice@example.com',
    subject: 'Доступ',
    body: 'Вот пароль: password=MySecretValue12345',
  });
  assert.equal(secretAttempt.ok, false);
  assert.match(secretAttempt.summary, /пароль|секрет|ключ/i);

  // Сохранение черновика по шаблону со списком вложений (только метаданные, без отправки)
  const saved = await draftTool.run({
    action: 'save',
    to: 'alice@example.com',
    templateId: 'документ',
    templateVars: { name: 'Алиса', topic: 'Договор', summary: 'Прилагаю финальную версию.' },
    attachments: [{ name: 'contract.pdf', note: 'подписанный экземпляр' }],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.sent, false);
  assert.match(saved.data.attachmentsNote, /файлы с диска не читались/);
  assert.equal(sendCalls, 0);

  // Перезагрузка с диска (атомарное хранение)
  const reloaded = new MailDraftStore(draftFile);
  assert.equal(reloaded.list().length, 1);
  assert.equal(reloaded.get(saved.data.draft.id).attachments[0].name, 'contract.pdf');

  const del = await draftTool.run({ action: 'delete', id: saved.data.draft.id });
  assert.equal(del.ok, true);
  assert.equal(reloaded.list().length, 0);
});

// 6. Браузер: распознавание окна входа без чтения паролей/куки, закладки и заметка о вкладках.
test('browser: authRequired с reveal без утечки пароля/куки и закладки', async (t) => {
  const dir = tempDir(t, 'nox-browser-');

  // Проверяем hasPassword в SNAPSHOT_SCRIPT без чтения el.value пароля
  const pwdInput = {
    tagName: 'INPUT',
    type: 'password',
    value: 'SuperSecretPass!',
    options: [],
    selectedIndex: -1,
    innerText: '',
    isContentEditable: false,
    title: '',
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 120, height: 28 }),
  };
  const snap = vm.runInNewContext(SNAPSHOT_SCRIPT, {
    window: { innerHeight: 800 },
    document: {
      title: 'Войти в аккаунт',
      body: { innerText: 'Войти\nВведите логин и пароль', scrollHeight: 500 },
      querySelectorAll: (sel) => (sel.includes('captcha') ? [] : [pwdInput]),
    },
    location: { href: 'https://portal.example.com/login' },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  });
  assert.equal(snap.hasPassword, true);
  assert.equal('value' in snap.elements[0], false);
  assert.equal(detectAuthNeeded(snap), true);
  assert.equal(detectAuthNeeded({ ...snap, title: 'Капча', text: 'I am not a robot', status: 403 }), false);

  let revealed = false;
  let current = 'https://portal.example.com/login';
  const fakePage = {
    open: async () => snap,
    read: async () => snap,
    scroll: async () => snap,
    click: async () => snap,
    type: async () => snap,
    currentUrl: () => current,
    describe: () => 'страница portal.example.com',
    reveal: () => { revealed = true; },
    seen: snap,
    bookmarks: new BrowserBookmarkStore(path.join(dir, 'bookmarks.json')),
  };

  // По умолчанию длина ровно 5
  assert.equal(browserTools(fakePage).length, 5);

  const tools = browserTools(fakePage, fakePage, { enableBookmarks: true });
  assert.equal(tools.length, 6);
  const openTool = tools[0];
  const bmTool = tools[5];
  assert.equal(bmTool.name, 'browser_bookmarks');

  const openRes = await openTool.run({ url: current });
  assert.equal(openRes.ok, true);
  assert.equal(openRes.data.authRequired, true);
  assert.equal(revealed, true);
  assert.match(openRes.summary, /войдите вручную/i);
  assert.ok(!JSON.stringify(openRes).includes('SuperSecretPass'));

  // Закладки и заметка о вкладках
  assert.match(MULTI_TAB_NOTE, /Одна активная вкладка/);
  const bmAdd = await bmTool.run({ action: 'add', title: 'Портал', note: 'личный кабинет' });
  assert.equal(bmAdd.ok, true);
  assert.match(bmAdd.data.tabsNote, /Одна активная вкладка/);

  const bmSecret = await bmTool.run({ action: 'add', url: 'https://example.com/?token=ghp_1234567890abcdef1234', title: 'leak' });
  assert.equal(bmSecret.ok, false);

  const bmList = await bmTool.run({ action: 'list', query: 'Портал' });
  assert.equal(bmList.data.total, 1);

  const bmDel = await bmTool.run({ action: 'remove', id: bmAdd.data.bookmark.id });
  assert.equal(bmDel.ok, true);

  // Настоящий BrowserPage предоставляет методы закладок и tabsNote
  const bp = new BrowserPage({
    createWindow: () => { throw new Error('не вызывается'); },
    bookmarkStore: new BrowserBookmarkStore(),
  });
  assert.match(bp.tabsNote(), /Одна активная вкладка/);
  bp.addBookmark({ url: 'https://example.org/docs', title: 'Документация' });
  assert.equal(bp.listBookmarks('документ').length, 1);
});
