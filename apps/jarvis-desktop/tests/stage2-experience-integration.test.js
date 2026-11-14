'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');

const { resolveLocalTurnAsync } = require('../src/shortcuts/scenarios');
const { runCommand } = require('../src/commands/runner');
const { ToolRegistry } = require('../src/tools/registry');
const { youtubeTools } = require('../src/tools/youtube');
const { documentTools } = require('../src/tools/documents');
const { WorkspaceIndex } = require('../src/rag/index');
const { draftCommandFromTurn } = require('../src/commands/builder');
const { TAINT_SOURCES } = require('../src/policy/taint');
const modes = require('../src/policy/modes');

test('намёки, полуслова и сарказм: выполняются локально через runCommand с реальной проверкой и не трогают идиомы', async () => {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'ui_keys',
    risk: 'T1',
    async run(args) {
      calls.push({ tool: 'ui_keys', args });
      return { ok: true, summary: `pressed ${args.keys}` };
    },
    async verify() {
      return { status: 'confirmed', evidence: 'клавиши нажаты' };
    },
  });
  registry.register({
    name: 'media_control',
    risk: 'T1',
    async run(args) {
      calls.push({ tool: 'media_control', args });
      return { ok: true, summary: 'paused' };
    },
  });
  registry.register({
    name: 'volume_set',
    risk: 'T1',
    async run(args) {
      calls.push({ tool: 'volume_set', args });
      return { ok: true, summary: `volume ${args.percent}` };
    },
  });

  const hintPlan = await resolveLocalTurnAsync('блин, слишком тихо', {});
  assert.ok(hintPlan, 'должен распознаться намёк «блин, слишком тихо»');
  assert.equal(hintPlan.source, 'hint');
  assert.equal(hintPlan.steps[0].tool, 'ui_keys');
  assert.match(hintPlan.steps[0].args.keys, /volume_up/);

  // В режиме auto без approvals действие T1 вне workspace спрашивается (не выполняется втихую).
  const autoRes = await runCommand(
    { id: 'hint-vol', name: hintPlan.title, steps: hintPlan.steps },
    { tools: registry, policy: modes, mode: 'auto', approvals: null, reportVerification: true }
  );
  assert.equal(autoRes.ok, false);
  assert.equal(calls.length, 0);

  // В режиме full или после подтверждения выполняется с подтверждённым verify.
  const res = await runCommand(
    { id: 'hint-vol', name: hintPlan.title, steps: hintPlan.steps },
    { tools: registry, policy: modes, mode: 'full', approvals: null, reportVerification: true }
  );
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'ui_keys');

  const sarcasmPlan = await resolveLocalTurnAsync('ну да, сделай ещё тише, вообще кайф', {});
  assert.ok(sarcasmPlan, 'должен перевернуться сарказм');
  assert.match(sarcasmPlan.steps[0].args.keys, /volume_up/);

  const silencePlan = await resolveLocalTurnAsync('нужна тишина', {});
  assert.ok(silencePlan);
  assert.deepEqual(silencePlan.steps.map((s) => s.tool), ['media_control', 'volume_set']);

  // Guardrails: вопросы, идиомы, внешние места и опасные слова не перехватываются.
  assert.equal(await resolveLocalTurnAsync('почему тут так тихо?', {}), null);
  assert.equal(await resolveLocalTurnAsync('Расскажи про Тихий океан', {}), null);
  assert.equal(await resolveLocalTurnAsync('на улице слишком темно сегодня', {}), null);
  assert.equal(await resolveLocalTurnAsync('удали файлы, тут бардак', {}), null);
});

test('ситуативная музыка учитывает историю диалога, активные окна, не повторяет треки и открывает mood:true без переспроса', async () => {
  const openedUrls = [];
  const noted = [];
  const fakeUrlOpen = {
    name: 'url_open',
    risk: 'T1',
    async run(args) {
      openedUrls.push(args.url);
      return { ok: true, summary: `opened ${args.url}`, data: { url: args.url } };
    },
    async verify() {
      return { status: 'confirmed', evidence: 'ссылка открыта' };
    },
  };
  const [ytTool] = youtubeTools(fakeUrlOpen, {
    find: async () => [
      { id: 'short1', title: 'Random #shorts clip', url: 'https://www.youtube.com/watch?v=short1' },
      { id: 'lofi99', title: 'Deep Chill Ambient Waves 2 Hours', url: 'https://www.youtube.com/watch?v=lofi99' },
    ],
    notePlay: (q) => noted.push(q),
  });

  const registry = new ToolRegistry();
  registry.register(fakeUrlOpen);
  registry.register(ytTool);
  registry.register({
    name: 'volume_set',
    risk: 'T1',
    async run(args) {
      return { ok: true, summary: `volume=${args.percent}` };
    },
    async verify() {
      return { status: 'confirmed', evidence: 'громкость обновлена' };
    },
  });

  const studyPlan = await resolveLocalTurnAsync('нужна музыка потише', {
    history: [{ role: 'user', content: 'занимаюсь учебой, готовлюсь к экзамену' }],
    activeApps: [],
    musicService: 'youtube',
    musicHistory: [],
    now: new Date('2026-11-14T15:00:00Z'),
  });
  assert.ok(studyPlan);
  assert.equal(studyPlan.source, 'music-context');
  assert.equal(studyPlan.mood, 'study_pomodoro');
  assert.equal(studyPlan.softenVolume, true);
  assert.equal(studyPlan.steps[0].tool, 'volume_set');
  assert.equal(studyPlan.steps[1].tool, 'youtube_play');
  assert.equal(studyPlan.steps[1].args.mood, true);

  const execRes = await runCommand(
    { id: 'music-study', name: studyPlan.title, steps: studyPlan.steps },
    { tools: registry, policy: modes, mode: 'full', ownerCommand: true, reportVerification: true }
  );
  assert.equal(execRes.ok, true);
  assert.equal(openedUrls.length, 1);
  assert.match(openedUrls[0], /lofi99/);
  assert.equal(noted.length, 1);

  // Антиповтор при повторной просьбе в той же ситуации + распознавание по активным окнам (VS Code).
  const codePlan1 = await resolveLocalTurnAsync('нужна музыка', {
    history: [],
    activeApps: [{ name: 'Code', title: 'main.js - Visual Studio Code' }],
    musicService: 'youtube',
    musicHistory: [],
    now: new Date('2026-11-14T15:00:00Z'),
  });
  const codePlan2 = await resolveLocalTurnAsync('нужна музыка', {
    history: [],
    activeApps: [{ name: 'Code', title: 'main.js - Visual Studio Code' }],
    musicService: 'youtube',
    musicHistory: [{ query: codePlan1.musicQuery, service: 'youtube' }],
    now: new Date('2026-11-14T15:00:00Z'),
  });
  assert.equal(codePlan1.mood, 'coding_focus');
  assert.equal(codePlan2.mood, 'coding_focus');
  assert.notEqual(codePlan2.musicQuery, codePlan1.musicQuery);
});

test('documentTools прокидывает ocrPdf на скан PDF и TAINT_SOURCES защищает document_batch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-stage2-doc-'));
  try {
    const fakePdfPath = path.join(tmpDir, 'scan.pdf');
    // Валидный пустой PDF (1 страница без текстового слоя) -> срабатывает OCR скана.
    const pdfBuf = Buffer.from([
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[4 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      '4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 5 0 R/Resources<</Font<</F1 3 0 R>>>>>>endobj',
      '5 0 obj<</Length 0>>stream\n\nendstream endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
    ].join('\n'), 'utf8');
    fs.writeFileSync(fakePdfPath, pdfBuf);
    const idx = new WorkspaceIndex(tmpDir);
    let ocrCalled = false;
    const docs = documentTools(idx, {
      ocrPdf: async (abs) => {
        ocrCalled = abs === fakePdfPath;
        return {
          status: 'ok',
          pageCount: 1,
          pages: [{ page: 1, text: 'Распознанный текст скана договора' }],
        };
      },
    });
    const docRead = docs.find((t) => t.name === 'document_read');
    const out = await docRead.run({ path: 'scan.pdf' });
    assert.equal(ocrCalled, true);
    assert.equal(out.ok, true);
    assert.equal(out.data.ocrStatus, 'recognized');
    assert.match(out.data.text, /Распознанный текст скана договора/);
    assert.equal(TAINT_SOURCES.has('document_batch'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('интеграционные швы main.js, preload.js и composer/store совместимы (agentMode + draftCommandFromTurn + wired stores)', () => {
  const root = path.resolve(__dirname, '..');
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

  assert.match(preloadSrc, /send:\s*\(text,\s*files,\s*opts\)\s*=>\s*ipcRenderer\.invoke\('chat:send'/);
  assert.match(preloadSrc, /draftCommandFromTurn:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('commands:draft-from-turn'/);

  assert.match(mainSrc, /ipcMain\.handle\('commands:draft-from-turn'/);
  assert.match(mainSrc, /ocrPdf:\s*ocrPdfFile/);
  assert.match(mainSrc, /draftStore:\s*mailDrafts/);
  assert.match(mainSrc, /enableBookmarks:\s*true/);
  assert.match(mainSrc, /searchNotes:\s*\(query\)\s*=>/);
  assert.match(mainSrc, /youtubeTools\(baseTools\.find/);
  assert.match(mainSrc, /forceAgentMode/);
  assert.match(mainSrc, /const screenJob = screenTask\(phrase\);/);
  assert.match(mainSrc, /turnContext:\s*forceAgentMode\s*\?\s*AGENT_MODE_NOTE\s*:\s*''/);
  assert.match(mainSrc, /leanTools\s*===\s*true\s*&&\s*!agentModeTurn/);

  const built = draftCommandFromTurn({
    phrase: 'Сделай тише',
    actions: [{ tool: 'volume_set', args: { percent: 25 }, ok: true, status: 'confirmed' }],
    existingCommands: [],
  });
  assert.equal(built.ok, true);
  assert.equal(built.draft.steps[0].tool, 'volume_set');
});
