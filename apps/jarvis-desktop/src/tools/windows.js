'use strict';

// Инструменты управления окнами Windows: список окон и переключение на окно по заголовку.
// Запуск идёт через runPowerShell из ./system. Пользовательский текст передаётся только через env.
const { runPowerShell, pollUntil } = require('./system');

const MAX_LIST = 50;
const MAX_TITLE = 200;
const restoreSnapshots = new Map();
let lastRestoreSnapshot = null;
const TIMEOUT_MS = 15000;

// Список окон: процессы с непустым заголовком окна, не больше MAX_LIST записей.
// Заголовок обрезается до MAX_TITLE_OUT, чтобы весь список влез в лимит вывода runPowerShell (8000 символов).
// Вывод в UTF-8 без BOM, чтобы кириллица в заголовках не превращалась в кракозябры.
const MAX_TITLE_OUT = 120;
const LIST_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  '$items = @(Get-Process -ErrorAction SilentlyContinue |',
  '  Where-Object { -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } |',
  `  Select-Object -First ${MAX_LIST} |`,
  `  ForEach-Object { $t = [string]$_.MainWindowTitle; [pscustomobject]@{ name = $_.ProcessName; title = $t.Substring(0, [Math]::Min(${MAX_TITLE_OUT}, $t.Length)) } })`,
  'ConvertTo-Json -Compress -InputObject $items',
].join('\n');

// Название окна приходит в $env:JARVIS_TITLE, в тексте скрипта его нет.
const FOCUS_SCRIPT = '(New-Object -ComObject WScript.Shell).AppActivate($env:JARVIS_TITLE)';

// Заголовок окна, которое сейчас на переднем плане.
const FOREGROUND_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  '$sig = \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);\'',
  'Add-Type -MemberDefinition $sig -Name Fg -Namespace Nox',
  '$b = New-Object System.Text.StringBuilder 512',
  '[void][Nox.Fg]::GetWindowText([Nox.Fg]::GetForegroundWindow(), $b, 512)',
  '[Console]::Out.Write($b.ToString())',
].join('\n');

// Разбор stdout списка окон.
// Пустой вывод — пустой список, объект — одна запись, массив — несколько.
// Бросает ошибку, если JSON битый или элемент не является объектом.
function parseWindows(stdout) {
  const text = String(stdout || '').trim();
  if (text === '') return [];
  const parsed = JSON.parse(text);
  if (parsed === null) return [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (item === null || typeof item !== 'object') throw new TypeError('элемент не объект');
    return { name: String(item.name ?? ''), title: String(item.title ?? '') };
  });
}

// Разбор вывода перечисления окон с прямоугольниками.
function parseEnum(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { area: { x: 0, y: 0, w: 0, h: 0 }, windows: [] };
  const parsed = JSON.parse(text);
  const area = parsed && parsed.area && typeof parsed.area === 'object'
    ? { x: Number(parsed.area.x) || 0, y: Number(parsed.area.y) || 0, w: Number(parsed.area.w) || 0, h: Number(parsed.area.h) || 0 }
    : { x: 0, y: 0, w: 0, h: 0 };
  const windows = Array.isArray(parsed.windows) ? parsed.windows.map((w) => ({
    hwnd: Number(w.hwnd),
    process: String(w.process ?? ''),
    title: String(w.title ?? ''),
    left: Number(w.left) || 0,
    top: Number(w.top) || 0,
    right: Number(w.right) || 0,
    bottom: Number(w.bottom) || 0,
    minimized: Boolean(w.minimized),
  })) : [];
  return { area, windows };
}

// Перечисление окон: hwnd, заголовок, прямоугольник, свёрнутое состояние, рабочая область монитора первого окна.
const ENUM_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  'Add-Type -AssemblyName System.Windows.Forms',
  '$sig = \'[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }\'',
  'Add-Type -MemberDefinition $sig -Name Win -Namespace Nox',
  '$procs = @(Get-Process -ErrorAction SilentlyContinue |',
  '  Where-Object { $_.Id -ne $PID -and $_.MainWindowHandle -ne [IntPtr]::Zero -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })',
  '$items = @()',
  'foreach ($p in $procs) {',
  '  $h = $p.MainWindowHandle',
  '  $r = New-Object Nox.Win+RECT',
  '  if ([Nox.Win]::GetWindowRect($h, [ref]$r)) {',
  '    $items += [pscustomobject]@{',
  '      hwnd = [int]$h',
  '      process = [string]$p.ProcessName',
  '      title = [string]$p.MainWindowTitle',
  '      left = $r.Left',
  '      top = $r.Top',
  '      right = $r.Right',
  '      bottom = $r.Bottom',
  '      minimized = [Nox.Win]::IsIconic($h)',
  '    }',
  '  }',
  '}',
  '$area = $null',
  'if ($items.Count -gt 0) {',
  '  $screen = [System.Windows.Forms.Screen]::FromHandle([IntPtr]$items[0].hwnd)',
  '  $wa = $screen.WorkingArea',
  '  $area = [pscustomobject]@{ x = $wa.X; y = $wa.Y; w = $wa.Width; h = $wa.Height }',
  '}',
  'ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ area = $area; windows = $items })',
].join('\n');

// Применение раскладки: MoveWindow по списку из JARVIS_ARRANGE.
const APPLY_SCRIPT = [
  "try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}",
  '$sig = \'[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int h, bool r);\'',
  'Add-Type -MemberDefinition $sig -Name Win -Namespace Nox',
  '$arr = ConvertFrom-Json -InputObject $env:JARVIS_ARRANGE',
  'foreach ($item in $arr) {',
  '  [Nox.Win]::MoveWindow([IntPtr]$item.hwnd, $item.x, $item.y, $item.w, $item.h, $true) | Out-Null',
  '}',
  'ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ moved = $arr.Count })',
].join('\n');

// Чистая геометрия: возвращает массив прямоугольников {x,y,w,h} внутри area.
function computeLayout(layout, count, area) {
  const allowed = new Set(['row','grid','cascade','fill','left_right','top_bottom','main_and_two','grid_4']);
  if (!allowed.has(layout)) throw new TypeError(`неизвестная раскладка: ${layout}`);
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new RangeError('нужно от 2 до 9 окон');
  if (layout !== 'fill' && n < 2) throw new RangeError('нужно от 2 до 9 окон');

  const a = {
    x: Math.round(Number(area.x) || 0),
    y: Math.round(Number(area.y) || 0),
    w: Math.round(Number(area.w) || 0),
    h: Math.round(Number(area.h) || 0),
  };
  const gap = 8;

  if (layout === 'fill') {
    // «Заполнить» — все окна занимают всю рабочую область; нужно ровно count прямоугольников,
    // иначе раскладка на несколько окон получит undefined.
    return Array.from({ length: n }, () => ({ x: a.x, y: a.y, w: a.w, h: a.h }));
  }

  if (n === 1) {
    return [{ x: a.x, y: a.y, w: a.w, h: a.h }];
  }

  if (layout === 'left_right') {
    const m = Math.min(n, 2);
    const w = Math.floor((a.w - gap * (m - 1)) / m);
    const out = [];
    for (let i = 0; i < m; i++) out.push({ x: a.x + i * (w + gap), y: a.y, w, h: a.h });
    return out;
  }

  if (layout === 'top_bottom') {
    const m = Math.min(n, 2);
    const h = Math.floor((a.h - gap * (m - 1)) / m);
    const out = [];
    for (let i = 0; i < m; i++) out.push({ x: a.x, y: a.y + i * (h + gap), w: a.w, h });
    return out;
  }

  if (layout === 'main_and_two') {
    if (n < 3) {
      const m = Math.min(n, 2);
      const w = Math.floor((a.w - gap * (m - 1)) / m);
      const out = [];
      for (let i = 0; i < m; i++) out.push({ x: a.x + i * (w + gap), y: a.y, w, h: a.h });
      return out;
    }
    const mainW = Math.floor(a.w * 0.6);
    const sideW = a.w - mainW - gap;
    const sideH = Math.floor((a.h - gap) / 2);
    return [
      { x: a.x, y: a.y, w: mainW, h: a.h },
      { x: a.x + mainW + gap, y: a.y, w: sideW, h: sideH },
      { x: a.x + mainW + gap, y: a.y + sideH + gap, w: sideW, h: a.h - sideH - gap },
    ];
  }

  if (layout === 'row') {
    const w = Math.floor((a.w - gap * (n - 1)) / n);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ x: a.x + i * (w + gap), y: a.y, w, h: a.h });
    return out;
  }

  if (layout === 'cascade') {
    const w = Math.floor(a.w * 0.7);
    const h = Math.floor(a.h * 0.7);
    const out = [];
    for (let i = 0; i < n; i++) {
      const x = Math.min(a.x + i * 40, Math.max(a.x, a.x + a.w - w));
      const y = Math.min(a.y + i * 40, Math.max(a.y, a.y + a.h - h));
      out.push({ x, y, w, h });
    }
    return out;
  }

  const cols = layout === 'grid_4' ? 2 : Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor((a.w - gap * (cols - 1)) / cols);
  const cellH = Math.floor((a.h - gap * (rows - 1)) / rows);
  const out = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = (i / cols) | 0;
    out.push({ x: a.x + col * (cellW + gap), y: a.y + row * (cellH + gap), w: cellW, h: cellH });
  }
  return out;

}

// runner по умолчанию — runPowerShell; в тестах подменяется функцией с той же сигнатурой.
function windowsTools(runner = runPowerShell) {
  const windowsList = {
    name: 'windows_list',
    description: 'Список открытых окон с заголовком: имя процесса и текст заголовка окна.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run(args, ctx) {
      const signal = ctx && ctx.signal;
      const res = await runner(LIST_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      let windows;
      try {
        windows = parseWindows(res.data && res.data.stdout);
      } catch {
        return { ok: false, summary: 'не удалось разобрать список окон', data: {} };
      }
      return { ok: true, summary: `окон: ${windows.length}`, data: { windows } };
    },
  };

  const windowsFocus = {
    name: 'windows_focus',
    description: 'Переключиться на открытое окно по его заголовку.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: MAX_TITLE },
      },
      required: ['title'],
    },
    async run(args, ctx) {
      const title = String((args && args.title) || '').trim();
      if (!title) return { ok: false, summary: 'пустое название окна', data: {} };
      if (title.length > MAX_TITLE) {
        return { ok: false, summary: `название длиннее ${MAX_TITLE} символов`, data: {} };
      }
      const signal = ctx && ctx.signal;
      const res = await runner(FOCUS_SCRIPT, { JARVIS_TITLE: title }, { timeoutMs: TIMEOUT_MS, signal });
      // Ошибка самого запуска PowerShell (таймаут, сбой) не то же самое, что «окно не найдено».
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      const activated = String((res.data && res.data.stdout) || '').trim() === 'True';
      if (activated) return { ok: true, summary: 'окно активировано', data: {} };
      return { ok: false, summary: 'окно с таким названием не найдено', data: {} };
    },
    // AppActivate отвечает True и тогда, когда Windows запретила перехват фокуса: смотрим, что реально впереди.
    async verify(args, result, ctx = {}) {
      const want = String(args.title).trim().toLowerCase();
      let front = null;
      const seen = await pollUntil(async () => {
        const res = await runner(FOREGROUND_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal: ctx.signal });
        front = res.ok ? String((res.data && res.data.stdout) || '') : null;
        return front !== null && front.toLowerCase().includes(want);
      }, { timeoutMs: ctx.pollTimeoutMs || 1500, signal: ctx.signal });
      if (seen) return { status: 'confirmed', evidence: `впереди окно «${front.slice(0, 120)}»` };
      if (front === null) return { status: 'unknown', evidence: 'не удалось узнать активное окно' };
      return { status: 'failed', evidence: `впереди другое окно: «${front.slice(0, 120)}»` };
    },
  };

  const windowsArrange = {
    name: 'windows_arrange',
    description: 'Раскладка открытых окон на экране: рядом, сеткой или каскадом.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: ['row', 'grid', 'cascade'], minLength: 1 },
        titles: { type: 'array', items: { type: 'string' }, maxItems: 9 },
      },
      required: ['layout'],
    },
    async run(args, ctx) {
      const layout = String((args && args.layout) || '').trim().toLowerCase();
      if (!layout) return { ok: false, summary: 'не указана раскладка', data: {} };

      const signal = ctx && ctx.signal;
      const enumRes = await runner(ENUM_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal });
      if (!enumRes.ok) return { ok: false, summary: enumRes.summary, data: {} };

      let parsed;
      try {
        parsed = parseEnum(String((enumRes.data && enumRes.data.stdout) || '').trim());
      } catch {
        return { ok: false, summary: 'не удалось разобрать список окон', data: {} };
      }

      let windows = parsed.windows.filter((w) => !w.minimized);
      const titles = Array.isArray((args && args.titles)) ? args.titles.filter(Boolean).slice(0, 9) : null;
      if (titles && titles.length > 0) {
        const lower = titles.map((t) => String(t).toLowerCase());
        windows = windows.filter((w) => lower.some((t) => String(w.title || '').toLowerCase().includes(t)));
      }

      if (windows.length < 2) {
        return { ok: false, summary: `подходящих окон: ${windows.length}, нужно минимум 2`, data: {} };
      }
      if (windows.length > 9) windows = windows.slice(0, 9);

      let rects;
      try {
        rects = computeLayout(layout, windows.length, parsed.area);
      } catch (err) {
        return { ok: false, summary: err.message || `неизвестная раскладка: ${layout}`, data: {} };
      }

      const placed = windows.slice(0, rects.length).map((w, i) => ({
        hwnd: w.hwnd,
        title: w.title,
        x: rects[i].x,
        y: rects[i].y,
        w: rects[i].w,
        h: rects[i].h,
      }));

      const applyRes = await runner(APPLY_SCRIPT, { JARVIS_ARRANGE: JSON.stringify(placed) }, { timeoutMs: TIMEOUT_MS, signal });
      if (!applyRes.ok) return { ok: false, summary: applyRes.summary, data: {} };

      const layoutWord = layout === 'row' ? 'рядом' : layout === 'grid' ? 'сетка' : 'каскадом';
      const cols = layout === 'grid' ? Math.ceil(Math.sqrt(placed.length)) : null;
      const rows = layout === 'grid' ? Math.ceil(placed.length / cols) : null;
      const detail = layout === 'grid' ? `сетка ${cols}×${rows}` : layoutWord;
      return { ok: true, summary: `разложил ${placed.length} окон: ${detail}`, data: { placed, layout } };
    },
    async verify(args, result, ctx = {}) {
      if (!result || !result.ok || !Array.isArray(result.data && result.data.placed)) {
        return { status: 'unknown', evidence: 'нет данных о размещённых окнах' };
      }

      const placed = result.data.placed;
      const signal = ctx && ctx.signal;
      const enumRes = await runner(ENUM_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal });
      if (!enumRes.ok) return { status: 'unknown', evidence: enumRes.summary };

      let current;
      try {
        current = parseEnum(String((enumRes.data && enumRes.data.stdout) || '').trim());
      } catch {
        return { status: 'unknown', evidence: 'не удалось разобрать список окон' };
      }

      const byHwnd = new Map((current.windows || []).map((w) => [String(w.hwnd), w]));
      const tolerance = 8;
      let allOk = true;
      const evidence = [];

      for (const p of placed) {
        const cur = byHwnd.get(String(p.hwnd));
        if (!cur) {
          allOk = false;
          evidence.push(`окно «${p.title}» исчезло`);
          continue;
        }
        if (cur.minimized) {
          allOk = false;
          evidence.push(`окно «${p.title}» свернуто`);
          continue;
        }
        const dx = Math.abs((cur.left || 0) - p.x);
        const dy = Math.abs((cur.top || 0) - p.y);
        const dw = Math.abs((cur.right - cur.left) - p.w);
        const dh = Math.abs((cur.bottom - cur.top) - p.h);
        if (dx > tolerance || dy > tolerance || dw > tolerance || dh > tolerance) {
          allOk = false;
          evidence.push(`окно «${p.title}» сдвинулось: dx=${dx}, dy=${dy}, dw=${dw}, dh=${dh}`);
        }
      }

      return allOk
        ? { status: 'confirmed', evidence: `все ${placed.length} окон на месте` }
        : { status: 'failed', evidence: evidence.join('; ') };
    },
  };

  const APP_PROC = {
    terminal: ['powershell', 'windowsterminal', 'pwsh'],
    vscode: ['code'],
    notepad: ['notepad'],
    browser: ['chrome', 'msedge', 'firefox', 'librewolf', 'opera'],
  };

  function matchAppWindow(app, w) {
    const proc = String(w.process || '').toLowerCase();
    const names = APP_PROC[app.app_id] || [];
    const procMatch = names.some((n) => proc.includes(n));
    if (app.app_id === 'browser') {
      const host = app.url ? String(app.url).replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '') : 'youtube';
      const t = String(w.title || '').toLowerCase();
      const titleMatch = t.includes(host.toLowerCase()) || t.includes('youtube');
      return procMatch || titleMatch;
    }
    return procMatch;
  }

  const organizeWorkspace = {
    name: 'organize_workspace',
    description: 'Запустить приложения (terminal, vscode, notepad, browser) и разложить их окна по сетке. Операции: launch_only, launch_and_arrange, arrange_only.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['launch_only', 'launch_and_arrange', 'arrange_only'] },
        apps: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              app_id: { type: 'string', enum: ['terminal', 'vscode', 'notepad', 'browser'] },
              url: { type: 'string' },
              window_policy: { type: 'string', enum: ['reuse_or_launch', 'new_window', 'existing_only'] },
            },
            required: ['app_id'],
          },
        },
        layout: { type: 'string', enum: ['grid_4', 'left_right', 'top_bottom', 'main_and_two', 'fill'] },
        monitor: { type: 'string', enum: ['current', 'primary'] },
      },
      required: ['operation'],
    },
    async run(args, ctx) {
      const operation = String((args && args.operation) || 'launch_and_arrange');
      const apps = Array.isArray(args && args.apps) ? args.apps.slice(0, 4) : [];
      const layoutArg = String((args && args.layout) || 'grid_4');
      const signal = ctx && ctx.signal;

      if (apps.length === 0 && operation !== 'arrange_only') {
        return { ok: false, summary: 'не указаны приложения', data: {} };
      }
      if (apps.length > 4) return { ok: false, summary: 'не больше 4 приложений', data: {} };

      const beforeRes = await runner(ENUM_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal });
      if (!beforeRes.ok) return { ok: false, summary: beforeRes.summary, data: {} };
      let before;
      try { before = parseEnum(String((beforeRes.data && beforeRes.data.stdout) || '')); }
      catch { return { ok: false, summary: 'не удалось разобрать окна', data: {} }; }
      const beforeHwnds = new Set((before.windows || []).map((w) => w.hwnd));

      const launchResults = [];
      if (operation === 'launch_and_arrange' || operation === 'launch_only') {
        for (const app of apps) {
          let res;
          if (app.app_id === 'terminal') {
            res = await runner('Start-Process -FilePath powershell.exe', {}, { timeoutMs: 15000, signal });
          } else if (app.app_id === 'vscode') {
            res = await runner('Start-Process -FilePath code', {}, { timeoutMs: 15000, signal });
          } else if (app.app_id === 'notepad') {
            res = await runner('Start-Process -FilePath notepad.exe', {}, { timeoutMs: 15000, signal });
          } else if (app.app_id === 'browser') {
            const url = app.url || 'https://www.youtube.com';
            res = await runner("Start-Process -FilePath explorer.exe -ArgumentList '" + url + "'", {}, { timeoutMs: 15000, signal });
          } else {
            res = { ok: false, summary: 'неизвестное приложение', data: {} };
          }
          launchResults.push({ app_id: app.app_id, ok: res.ok, summary: res.summary });
        }
      }

      let after = before;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (signal && signal.aborted) break;
        const r = await runner(ENUM_SCRIPT, {}, { timeoutMs: TIMEOUT_MS, signal });
        if (r.ok) {
          try {
            const parsed = parseEnum(String((r.data && r.data.stdout) || ''));
            after = parsed;
            const newCount = (parsed.windows || []).filter((w) => !beforeHwnds.has(w.hwnd)).length;
            if (operation === 'arrange_only' || newCount >= Math.max(1, apps.length)) break;
          } catch {}
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const placedWindows = [];
      const used = new Set();
      for (const app of apps) {
        const candidates = (after.windows || []).filter((w) => !used.has(w.hwnd) && matchAppWindow(app, w));
        if (candidates.length === 0) {
          placedWindows.push({ app_id: app.app_id, hwnd: null, title: null, missing: true });
          continue;
        }
        if (candidates.length > 1) {
          placedWindows.push({ app_id: app.app_id, hwnd: null, ambiguous: true, candidates: candidates.map((c) => ({ hwnd: c.hwnd, title: c.title })) });
          continue;
        }
        const w = candidates[0];
        used.add(w.hwnd);
        placedWindows.push({ app_id: app.app_id, hwnd: w.hwnd, title: w.title, window: w });
      }

      if (operation === 'launch_only') {
        return { ok: true, summary: 'запущено: ' + apps.length, data: { apps: launchResults, windows: placedWindows } };
      }

      const toPlace = placedWindows.filter((p) => p.hwnd && !p.missing && !p.ambiguous);
      if (toPlace.length === 0) {
        return { ok: false, summary: 'нет окон для раскладки', data: { windows: placedWindows } };
      }

      const area = (after.area && after.area.w > 0) ? after.area : (before.area || { x: 0, y: 0, w: 1920, h: 1080 });

      let layoutKey = 'grid';
      if (layoutArg === 'left_right') layoutKey = 'left_right';
      else if (layoutArg === 'top_bottom') layoutKey = 'top_bottom';
      else if (layoutArg === 'main_and_two') layoutKey = 'main_and_two';
      else if (layoutArg === 'fill') layoutKey = 'fill';

      let rects;
      try { rects = computeLayout(layoutKey, toPlace.length, area); }
      catch (err) { return { ok: false, summary: err.message, data: {} }; }

      const previous = toPlace.map((p) => ({ hwnd: p.hwnd, title: p.title, x: p.window.left, y: p.window.top, w: p.window.right - p.window.left, h: p.window.bottom - p.window.top }));
      const placed = toPlace.map((p, i) => ({ hwnd: p.hwnd, title: p.title, x: rects[i].x, y: rects[i].y, w: rects[i].w, h: rects[i].h }));

      const applyRes = await runner(APPLY_SCRIPT, { JARVIS_ARRANGE: JSON.stringify(placed) }, { timeoutMs: TIMEOUT_MS, signal });
      if (!applyRes.ok) return { ok: false, summary: applyRes.summary, data: {} };

      const opId = 'op_' + Date.now();
      const snap = { previous: previous, placed: placed };
      restoreSnapshots.set(opId, snap);
      lastRestoreSnapshot = snap;

      const missing = placedWindows.filter((p) => p.missing || p.ambiguous);
      return { ok: true, summary: 'разложено ' + placed.length + ' окон', data: { operation_id: opId, placed: placed, windows: placedWindows, missing: missing } };
    },
  };

  const restoreWorkspace = {
    name: 'restore_workspace',
    description: 'Вернуть окна последней раскладки на прежние места (по operation_id).',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        operation_id: { type: 'string' },
      },
    },
    async run(args, ctx) {
      const signal = ctx && ctx.signal;
      const opId = args && args.operation_id;
      const snap = (opId && restoreSnapshots.get(opId)) || lastRestoreSnapshot;
      if (!snap) return { ok: false, summary: 'нет сохранённой раскладки', data: {} };
      const arr = snap.previous.map((p) => ({ hwnd: p.hwnd, title: p.title, x: p.x, y: p.y, w: p.w, h: p.h }));
      const res = await runner(APPLY_SCRIPT, { JARVIS_ARRANGE: JSON.stringify(arr) }, { timeoutMs: TIMEOUT_MS, signal });
      if (!res.ok) return { ok: false, summary: res.summary, data: {} };
      return { ok: true, summary: 'восстановлено ' + arr.length + ' окон', data: { restored: arr.length } };
    },
  };


  return [windowsList, windowsFocus, windowsArrange, organizeWorkspace, restoreWorkspace];
}

module.exports = { windowsTools, computeLayout };
