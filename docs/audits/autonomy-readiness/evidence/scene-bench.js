'use strict';
// Стенд полноты сцены (этап 1.3). Настоящие программы, настоящий инструмент ui_elements, модели нет.
// Для каждой программы проверяется, что в сцене есть элементы, нужные сценариям владельца:
// поле ввода, кнопки, пункты меню, список файлов, цифры калькулятора, поле имени в окне сохранения,
// адресная строка браузера.
//
// Запуск:  node docs/audits/autonomy-readiness/evidence/scene-bench.js [--probe] [--only=notepad,calc] [--limit=40]
//   --probe  показать, что именно попало в сцену (имя и тип каждого элемента)
//   --only   только перечисленные программы
//   --limit  лимит элементов сцены (по умолчанию 60, как у модели)
// Код выхода 1, если покрытие ниже 95 % (кроме --probe).
//
// Программы: Блокнот, Проводник, Параметры, Калькулятор, окно сохранения, Edge.
// Стенд открывает только свои окна и закрывает их сам; чужие окна не трогает.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..', '..', '..', '..', 'apps', 'jarvis-desktop');
const req = (p) => require(path.join(APP, p));
const { uiTools } = req('src/tools/ui.js');
const { runPowerShell } = req('src/tools/system.js');

const args = process.argv.slice(2);
const PROBE = args.includes('--probe');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 60;
const WAIT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { signal: new AbortController().signal, mode: 'full' };

function cleanupPath(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function taskkill(pid) {
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
}

// Браузер отделяется от пускового процесса: закрываем всех, у кого в командной строке наш временный профиль.
function killProfile(profile) {
  if (!profile) return Promise.resolve();
  const script = "Get-CimInstance Win32_Process -Filter \"Name='librewolf.exe'\" | Where-Object { $_.CommandLine -like \"*$env:NOX_BENCH_PROFILE*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      env: { ...process.env, NOX_BENCH_PROFILE: profile }, windowsHide: true, stdio: 'ignore',
    });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

function browserPath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'LibreWolf', 'librewolf.exe'));
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function makeBench() {
  const tools = Object.fromEntries(uiTools({ selfPid: process.pid }).map((t) => [t.name, t]));
  const opened = []; // { close: async () => void }
  const calls = []; // длительности ui_elements

  async function windows() {
    const res = await tools.ui_windows.run({}, ctx);
    return res && res.ok && res.data ? res.data.windows : [];
  }

  async function snapshot() {
    return new Set((await windows()).map((x) => String(x.handle)));
  }

  // Только окно, которого не было до запуска: чужое окно той же программы (в том числе владельца) не наше.
  async function waitNewWindow(before, match, ms = WAIT_MS) {
    const started = Date.now();
    for (;;) {
      const list = await windows();
      const hit = list.find((x) => !before.has(String(x.handle)) && match(x));
      if (hit) return hit;
      if (Date.now() - started > ms) return null;
      await sleep(400);
    }
  }

  // Закрытие ровно своего окна по дескриптору: WM_CLOSE в то окно, которое открыл стенд.
  async function closeHandle(handle) {
    if (!handle) return;
    const script = [
      "Add-Type -Namespace JarvisUi -Name User32 -MemberDefinition @'",
      '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);',
      "'@",
      `[void][JarvisUi.User32]::PostMessage([IntPtr]${Number(handle)}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`,
    ].join('\n');
    await runPowerShell(script, {}, { timeoutMs: 10000 });
  }

  async function scene(window, limit = LIMIT) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t = Date.now();
      let res;
      try {
        res = await tools.ui_elements.run({ window, limit }, ctx);
      } finally {
        calls.push({ window, ms: Date.now() - t });
      }
      if (!res || !res.ok) return { ok: false, error: (res && res.summary) || 'нет ответа', elements: [] };
      const data = res.data || {};
      const elements = Array.isArray(data.elements) ? data.elements : [];
      // Свежеоткрытое окно иногда ещё не отдаёт дерево: одна повторная попытка через короткую паузу.
      if (elements.length || Number(data.total) > 0 || attempt > 0) {
        return { ok: true, window: data.window, total: data.total, elements };
      }
      await sleep(800);
    }
    return { ok: true, window, total: 0, elements: [] };
  }

  function track(close) { opened.push({ close }); }

  async function cleanup() {
    for (const item of opened.reverse()) {
      try { await item.close(); } catch {}
    }
  }

  return { tools, windows, snapshot, waitNewWindow, scene, closeHandle, track, cleanup, calls };
}

const hasType = (els, types) => els.filter((e) => types.includes(String(e.type || '')));
const nameOk = (e, re) => re.test(String(e.name || ''));
const named = (els) => els.filter((e) => String(e.name || '').trim());

// Программы стенда. open(w) открывает окно и возвращает { title, pid, home? }, close — как закрыть.
// needs — что должно быть в сцене: id, words (для отчёта), ok(elements) → true | причина провала.
const APPS = [
  {
    id: 'notepad',
    label: 'Блокнот',
    async open(w) {
      const before = await w.snapshot();
      const pid = spawn('notepad.exe', [], { windowsHide: false, stdio: 'ignore' }).pid;
      const win = await w.waitNewWindow(before, (x) => /notepad/i.test(x.process) || /Блокнот|Notepad/i.test(x.title));
      if (!win) throw new Error('окно Блокнота не появилось');
      w.track(async () => { await w.closeHandle(win.handle); taskkill(pid); });
      return { title: win.title, pid };
    },
    needs: [
      { id: 'field', words: 'поле текста', ok: (els) => hasType(els, ['Document', 'Edit']).length > 0 || 'нет поля Document/Edit' },
      { id: 'menu', words: 'меню «Файл»', ok: (els) => named(els).some((e) => /^(Файл|File)$/i.test(e.name) && ['MenuItem', 'Button'].includes(e.type)) || 'нет пункта «Файл» среди MenuItem/Button' },
      { id: 'buttons', words: 'кнопки панели', ok: (els) => hasType(els, ['Button']).length > 0 || 'ни одной Button' },
      { id: 'tabs', words: 'вкладки', ok: (els) => hasType(els, ['TabItem']).length > 0 || 'ни одной вкладки' },
    ],
  },
  {
    id: 'explorer',
    label: 'Проводник',
    async open(w) {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-scene-bench-'));
      for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) fs.writeFileSync(path.join(home, name), 'x');
      const before = await w.snapshot();
      const pid = spawn('explorer.exe', [home], { windowsHide: false, stdio: 'ignore' }).pid;
      const base = path.basename(home);
      const win = await w.waitNewWindow(before, (x) => /explorer/i.test(x.process) && x.title.includes(base));
      if (!win) { cleanupPath(home); throw new Error('окно Проводника не появилось'); }
      w.track(async () => { await w.closeHandle(win.handle); taskkill(pid); cleanupPath(home); });
      return { title: win.title, pid, home };
    },
    needs: [
      { id: 'address', words: 'адресная строка', ok: (els) => hasType(els, ['Edit']).some((e) => nameOk(e, /адрес|address|путь|path/i) || /nox-scene-bench/i.test(String(e.value || ''))) || 'нет Edit адресной строки' },
      { id: 'search', words: 'поле поиска', ok: (els) => hasType(els, ['Edit']).some((e) => nameOk(e, /поиск|search/i)) || 'нет Edit поиска' },
      { id: 'items', words: 'три файла списком', ok: (els) => named(els).filter((e) => ['ListItem', 'DataItem'].includes(e.type)).length >= 3 || 'меньше трёх ListItem/DataItem' },
      { id: 'buttons', words: 'три кнопки панели', ok: (els) => hasType(els, ['Button']).length >= 3 || 'меньше трёх Button' },
      { id: 'tabs', words: 'вкладки', ok: (els) => hasType(els, ['TabItem']).length > 0 || 'ни одной вкладки' },
    ],
  },
  {
    id: 'settings',
    label: 'Параметры',
    async open(w) {
      const before = await w.snapshot();
      spawn('cmd.exe', ['/c', 'start', '', 'ms-settings:'], { windowsHide: true, stdio: 'ignore' });
      const win = await w.waitNewWindow(before, (x) => /SystemSettings|ApplicationFrameHost/i.test(x.process) || /Настройки|Параметры|Settings/i.test(x.title));
      if (!win) throw new Error('окно Параметров не появилось (окно могло уже быть открыто)');
      w.track(async () => { await w.closeHandle(win.handle); });
      return { title: win.title, pid: null };
    },
    needs: [
      { id: 'search', words: 'поле поиска', ok: (els) => hasType(els, ['Edit']).some((e) => nameOk(e, /поиск|search/i)) || 'нет Edit поиска' },
      { id: 'sections', words: 'шесть разделов', ok: (els) => named(els).filter((e) => ['ListItem', 'Button', 'TreeItem', 'TabItem', 'Hyperlink'].includes(e.type)).length >= 6 || 'меньше шести пунктов разделов' },
      { id: 'buttons', words: 'кнопки окна', ok: (els) => hasType(els, ['Button']).length >= 3 || 'меньше трёх Button' },
    ],
  },
  {
    id: 'calc',
    label: 'Калькулятор',
    async open(w) {
      const before = await w.snapshot();
      const pid = spawn('calc.exe', [], { windowsHide: false, stdio: 'ignore' }).pid;
      const win = await w.waitNewWindow(before, (x) => /calc/i.test(x.process) || /Калькулятор|Calculator/i.test(x.title));
      if (!win) throw new Error('окно Калькулятора не появилось (на этой машине программа может быть не установлена)');
      w.track(async () => { await w.closeHandle(win.handle); taskkill(pid); });
      return { title: win.title, pid };
    },
    needs: [
      { id: 'display', words: 'дисплей', ok: (els) => els.some((e) => ['Text', 'Edit'].includes(e.type) && (nameOk(e, /дисплей|display/i) || /^\d+([.,]\d+)?$/.test(String(e.name || '').trim()))) || 'нет дисплея' },
      { id: 'digits', words: 'цифры 7, 8, 9', ok: (els) => ['7', '8', '9'].every((d) => named(els).some((e) => e.name.trim() === d || nameOk(e, new RegExp(`^(${['Семь', 'Восемь', 'Девять'][Number(d) - 7]})$`, 'i')))) || 'нет цифр 7, 8, 9' },
      { id: 'ops', words: '«+» и «=»', ok: (els) => named(els).some((e) => e.name.trim() === '+' || nameOk(e, /^Плюс$/i)) && named(els).some((e) => e.name.trim() === '=' || nameOk(e, /^Равно$/i)) || 'нет «+» или «=»' },
    ],
  },
  {
    id: 'save',
    label: 'Окно выбора файла',
    // Системное окно выбора файла (OpenFileDialog) в своём процессе-хозяине: поле имени, список,
    // нижние кнопки. SaveFileDialog на этой машине из .NET не открывается — то же семейство диалога.
    async open(w) {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        "$f.Text = 'NoxBenchSave'; $f.Width = 320; $f.Height = 140",
        '$f.Add_Shown({',
        '  $d = New-Object System.Windows.Forms.OpenFileDialog',
        "  $d.FileName = 'nox-bench.txt'",
        '  [void]$d.ShowDialog($f)',
        '})',
        '[System.Windows.Forms.Application]::Run($f)',
      ].join('\n');
      const before = await w.snapshot();
      const pid = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false, stdio: 'ignore' }).pid;
      const dialog = await w.waitNewWindow(before, (x) => /Сохранить как|Save As|Открытие|Open/i.test(x.title), 20000);
      const host = (await w.windows()).find((x) => !before.has(String(x.handle)) && /NoxBenchSave/i.test(x.title));
      w.track(async () => { await w.closeHandle(dialog ? dialog.handle : null); await w.closeHandle(host ? host.handle : null); taskkill(pid); });
      if (!dialog) throw new Error('системное окно выбора файла не появилось');
      return { title: dialog.title, pid };
    },
    needs: [
      { id: 'filename', words: 'поле имени файла', ok: (els) => hasType(els, ['Edit']).some((e) => nameOk(e, /имя файла|file name/i) || String(e.value || '').length > 0) || 'нет Edit имени файла' },
      { id: 'confirm', words: 'главная кнопка (Открыть/Сохранить)', ok: (els) => named(els).some((e) => ['Button', 'MenuItem', 'Pane'].includes(e.type) && nameOk(e, /^&?(открыт|open|сохран|save)/i)) || 'нет главной кнопки' },
      { id: 'cancel', words: 'кнопка «Отмена»', ok: (els) => named(els).some((e) => ['Button', 'MenuItem', 'Pane'].includes(e.type) && nameOk(e, /^&?(отмен|cancel)/i)) || 'нет кнопки «Отмена»' },
      { id: 'address', words: 'адресная строка', ok: (els) => els.some((e) => ['Pane', 'Edit', 'ComboBox'].includes(e.type) && nameOk(e, /адрес|address/i)) || 'нет адресной строки' },
      { id: 'items', words: 'список файлов', ok: (els) => named(els).filter((e) => ['ListItem', 'DataItem'].includes(e.type)).length >= 1 || 'нет ListItem/DataItem' },
    ],
  },
  {
    id: 'browser',
    label: 'Браузер',
    // Chrome и Edge на этой машине не установлены: стенд честно берёт тот браузер, который есть.
    // Страница — свой файл во временной папке: без сети, с известными ссылкой и кнопкой.
    async open(w) {
      const exe = browserPath();
      if (!exe) throw new Error('браузер не найден');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-scene-page-'));
      const page = path.join(dir, 'bench.html');
      fs.writeFileSync(page, '<html><title>NoxBench</title><body><h1>Bench</h1><a href="#">Ссылка</a><button>Кнопка</button></body></html>');
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-scene-browser-'));
      const url = 'file:///' + page.replace(/\\/g, '/');
      const before = await w.snapshot();
      const pid = spawn(exe, ['-new-instance', '-no-remote', '-profile', profile, url], { windowsHide: false, stdio: 'ignore' }).pid;
      const win = await w.waitNewWindow(before, (x) => /librewolf|firefox|chrome|msedge/i.test(x.process) && /NoxBench|librewolf|firefox|edge|chrome/i.test(x.title), 30000);
      if (!win) { cleanupPath(profile); cleanupPath(dir); throw new Error('окно браузера не появилось'); }
      w.track(async () => {
        await w.closeHandle(win.handle);
        taskkill(pid);
        await killProfile(profile);
        await sleep(500);
        cleanupPath(profile);
        cleanupPath(dir);
      });
      return { title: win.title, pid, exe: path.basename(exe) };
    },
    needs: [
      { id: 'address', words: 'адресная строка', ok: (els) => els.some((e) => ['Edit', 'ComboBox'].includes(e.type) && nameOk(e, /адрес|address|поиск|search|введите|enter/i)) || 'нет поля адреса (Edit/ComboBox)' },
      { id: 'buttons', words: 'две кнопки', ok: (els) => hasType(els, ['Button']).length >= 2 || 'меньше двух Button' },
      { id: 'page', words: 'ссылка или кнопка страницы', ok: (els) => named(els).some((e) => (e.type === 'Hyperlink' && nameOk(e, /Ссылка/i)) || (e.type === 'Button' && nameOk(e, /^Кнопка$/i))) || 'элементы страницы не видны' },
    ],
  },
];

(async () => {
  const w = makeBench();
  const report = { at: new Date().toISOString(), limit: LIMIT, apps: [], passed: 0, total: 0 };
  let failedToOpen = 0;
  try {
    for (const app of APPS) {
      if (ONLY.length && !ONLY.includes(app.id)) continue;
      const row = { id: app.id, label: app.label, opened: false, checks: [], scene: null, error: null, ms: 0 };
      try {
        const t = Date.now();
        const info = await app.open(w);
        await sleep(300);
        const sc = await w.scene(info.title);
        row.ms = Date.now() - t;
        row.opened = sc.ok;
        row.scene = { window: sc.window, shown: sc.elements.length, total: sc.total };
        if (PROBE) {
          console.log(`\n=== ${app.label} · «${info.title}» · показано ${sc.elements.length} из ${sc.total} ===`);
          for (const e of sc.elements) console.log(`  ${String(e.type).padEnd(12)} ${String(e.name || '').slice(0, 60)}`);
        }
        for (const need of app.needs) {
          let verdict;
          try { verdict = sc.ok ? need.ok(sc.elements) : `сцена не прочитана: ${sc.error}`; } catch (err) { verdict = `ошибка проверки: ${err.message}`; }
          const ok = verdict === true;
          row.checks.push({ id: need.id, words: need.words, ok, reason: ok ? null : String(verdict) });
          report.total += 1;
          if (ok) report.passed += 1;
        }
      } catch (err) {
        failedToOpen += 1;
        row.error = err.message;
      }
      report.apps.push(row);
    }
  } finally {
    await w.cleanup();
  }
  const pct = report.total ? (report.passed / report.total) * 100 : 0;
  report.coverage = Math.round(pct * 10) / 10;
  for (const row of report.apps) {
    const got = row.checks.filter((c) => c.ok).length;
    const state = row.error ? `не открылась: ${row.error}` : row.opened ? `${got}/${row.checks.length}` : 'сцена не прочитана';
    console.log(`${row.label.padEnd(18)} ${String(state).padEnd(40)} ${row.scene ? `в сцене ${row.scene.shown} из ${row.scene.total}, ${row.ms} мс` : ''}`);
    for (const c of row.checks.filter((x) => !x.ok)) console.log(`  провал: ${c.words} — ${c.reason}`);
  }
  console.log(`\nпокрытие: ${report.passed} из ${report.total} (${report.coverage}%)${failedToOpen ? `; не открылось программ: ${failedToOpen}` : ''}`);
  console.log(JSON.stringify({ coverage: report.coverage, passed: report.passed, total: report.total, calls: w.calls, apps: report.apps.map((r) => ({ id: r.id, error: r.error, scene: r.scene, ms: r.ms, failed: r.checks.filter((c) => !c.ok).map((c) => c.id) })) }));
  if (!PROBE && report.total && report.coverage < 95) process.exitCode = 1;
})().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
