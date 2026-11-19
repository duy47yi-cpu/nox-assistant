'use strict';

// Снимок основного экрана для модели. Файл создаётся во временной папке и удаляется сразу после чтения.
// allowed() решает, можно ли снимать сейчас: в режиме «по просьбе» только когда владелец попросил.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runPowerShell } = require('./system');
// Список менеджеров паролей один на проект: правила доступа и предупреждение о снимке сверяются по нему.
const { CREDENTIAL_WINDOW_RE } = require('../policy/modes');
const modes = require('../policy/modes');

const MAX_WIDTH = 1280;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_WINDOW_CHARS = 200;
// Окно меньше этого не считаем окном: пустая рамка или свёрнутая полоска ничего не объяснят.
const MIN_SIDE = 8;

// Заголовок переднего окна помнит последний снимок. Его читают правила доступа: при менеджере паролей в кадре
// снимок всего экрана спрашивается, а не уходит молча (src/policy/modes.js, setScreenWindowSource).
let lastFrontWindow = '';
function frontWindowTitle() {
  return lastFrontWindow;
}
// Источник подключается здесь же: кто взял снимок, тот и вооружил правило — main.js об этом забыть не может.
modes.setScreenWindowSource(frontWindowTitle);

// Постоянный текст скрипта: путь к файлу и часть заголовка окна идут переменными окружения (JARVIS_SHOT, JARVIS_WINDOW).
// Полный экран — когда окно не названо; иначе прямоугольник найденного окна, обрезанный по экрану.
// В конце всегда печатается JSON: заголовок переднего окна нужен и предупреждению, и правилам доступа.
const CAPTURE_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  // Те же настоящие пиксели, что считает мышь: при масштабе Windows не 100 % точки снимка иначе не совпадут.
  'Add-Type -Namespace JarvisShot -Name Dpi -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\'',
  '[void][JarvisShot.Dpi]::SetProcessDPIAware()',
  '$sig = \'[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }\'',
  'Add-Type -Namespace JarvisShot -Name W -MemberDefinition $sig',
  'function FgTitle {',
  '  try { $b = New-Object System.Text.StringBuilder 512; [void][JarvisShot.W]::GetWindowText([JarvisShot.W]::GetForegroundWindow(), $b, 512); return $b.ToString() } catch { return \'\' }',
  '}',
  '$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$front = FgTitle',
  '$wanted = [string]$env:JARVIS_WINDOW',
  '$found = $null',
  '$restored = $false',
  // Совпадение по подстроке без толкования звёздочек: «[*]» в заголовке — обычные символы.
  'if ($wanted -ne \'\') {',
  '  $found = Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -and $_.MainWindowTitle.IndexOf($wanted, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1',
  '}',
  '$o = [ordered]@{ status = \'ok\'; front = $front; target = \'\'; x = $screen.X; y = $screen.Y; w = $screen.Width; h = $screen.Height; restored = $false }',
  'if ($wanted -eq \'\') { $o.target = $front }',
  'elseif ($null -eq $found) { $o.status = \'no_window\' }',
  'else {',
  '  $h = [IntPtr]$found.MainWindowHandle',
  '  if ([JarvisShot.W]::IsIconic($h)) { [void][JarvisShot.W]::ShowWindow($h, 9); Start-Sleep -Milliseconds 180; $restored = $true }',
  '  $r = New-Object JarvisShot.W+RECT',
  '  if (-not [JarvisShot.W]::GetWindowRect($h, [ref]$r)) { $o.status = \'no_window\' }',
  '  else {',
  '    $x = [Math]::Max($screen.X, $r.Left); $y = [Math]::Max($screen.Y, $r.Top)',
  '    $right = [Math]::Min($screen.Right, $r.Right); $bottom = [Math]::Min($screen.Bottom, $r.Bottom)',
  '    $o.target = $found.MainWindowTitle; $o.x = $x; $o.y = $y; $o.w = $right - $x; $o.h = $bottom - $y; $o.restored = $restored',
  '    if ($o.w -lt 8 -or $o.h -lt 8) { $o.status = \'too_small\' }',
  '  }',
  '}',
  'if ($o.status -eq \'ok\') {',
  '  $shot = New-Object System.Drawing.Bitmap $o.w, $o.h',
  '  $g = [System.Drawing.Graphics]::FromImage($shot)',
  '  $g.CopyFromScreen((New-Object System.Drawing.Point $o.x, $o.y), [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $o.w, $o.h))',
  `  $sw = [Math]::Min(${MAX_WIDTH}, $o.w)`,
  '  $sh = [int]($o.h * $sw / $o.w)',
  '  $small = New-Object System.Drawing.Bitmap $sw, $sh',
  '  $g2 = [System.Drawing.Graphics]::FromImage($small)',
  '  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '  $g2.DrawImage($shot, 0, 0, $sw, $sh)',
  '  $small.Save($env:JARVIS_SHOT, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
  '  $g.Dispose(); $g2.Dispose(); $shot.Dispose(); $small.Dispose()',
  '}',
  'try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}',
  '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $o))',
].join('\n');

// Разбор ответа скрипта: JSON или честный текст ошибки.
function parseShot(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function screenTools({ allowed = () => false, capture = runPowerShell, secrets = CREDENTIAL_WINDOW_RE } = {}) {
  return [
    {
      name: 'screen_look',
      description: 'Снимок экрана: модель видит картинку. Вызывай, когда владелец просит посмотреть экран или без картинки не понять задачу. Назови window — часть заголовка нужного окна: тогда снимется только оно, а не весь экран (меньше лишнего, включая менеджер паролей сзади).',
      risk: 'T1',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW_CHARS, description: 'часть заголовка окна; без него снимается весь экран' },
        },
      },
      async run(args, ctx) {
        if (!allowed()) return { ok: false, summary: 'снимок экрана не запрошен: режим «по просьбе»', data: {} };
        const raw = args && typeof args.window === 'string' ? args.window.trim() : '';
        if (raw.length > MAX_WINDOW_CHARS) return { ok: false, summary: `окно: не длиннее ${MAX_WINDOW_CHARS} символов`, data: {} };
        const file = path.join(os.tmpdir(), `jarvis-shot-${crypto.randomUUID()}.jpg`);
        try {
          const res = await capture(CAPTURE_SCRIPT, { JARVIS_SHOT: file, JARVIS_WINDOW: raw }, { signal: ctx && ctx.signal, timeoutMs: 15000 });
          const shot = parseShot(res.ok ? res.data && res.data.stdout : '');
          if (shot && typeof shot.front === 'string') lastFrontWindow = shot.front;
          if (shot && shot.status === 'no_window') {
            return { ok: false, summary: raw ? `окно «${raw}» не найдено` : 'не удалось снять экран: окно не найдено', data: {} };
          }
          if (shot && shot.status === 'too_small') return { ok: false, summary: 'окно свёрнуто или слишком мало для снимка', data: { frontWindow: String(shot.front || '') } };
          if (!res.ok || !fs.existsSync(file)) {
            return { ok: false, summary: `не удалось снять экран: ${res.summary}`, data: {} };
          }
          const bytes = fs.readFileSync(file);
          if (bytes.length > MAX_BYTES) return { ok: false, summary: 'снимок слишком большой', data: {} };
          const data = {
            bytes: bytes.length,
            width: Number(shot && shot.w) || 0,
            height: Number(shot && shot.h) || 0,
            frontWindow: String((shot && shot.front) || ''),
            ...(raw ? { window: String((shot && shot.target) || raw) } : {}),
            ...(shot && shot.restored === true ? { restored: true } : {}),
          };
          // Менеджеры паролей видны целиком: их надо назвать, иначе модель не поймёт, что в кадре лишнее.
          const inFrame = [data.frontWindow, raw ? data.window : ''].filter(Boolean).filter((title) => secrets.test(title));
          if (!raw && inFrame.length) data.secretWindows = inFrame;
          const notes = [];
          if (!raw && inFrame.length) notes.push(`в кадре ${inFrame[0]} (менеджер паролей): повтори с window=<другое окно>, если нужен только оно`);
          if (raw && data.frontWindow && data.window && !data.frontWindow.startsWith(raw) && !data.window.toLowerCase().includes(raw.toLowerCase())) {
            notes.push('названное окно не на переднем плане: поверх могут быть другие');
          }
          if (data.restored) notes.push('окно было свёрнуто и развёрнуто для снимка');
          const head = raw ? `снимок окна «${data.window || raw}»` : 'снимок экрана';
          return {
            ok: true,
            summary: `${head}, ${data.width}×${data.height}${notes.length ? `; ${notes.join('; ')}` : ''}`,
            data,
            image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
          };
        } finally {
          fs.rmSync(file, { force: true });
        }
      },
    },
  ];
}

// Срок жизни обведённой области: дольше снимок в памяти не держим.
const REGION_TTL_MS = 10 * 60 * 1000;

// Область, которую владелец сам обвёл рамкой. take() отдаёт {shot, pixels, label, at}:
// shot — nativeImage всего экрана, снятый desktopCapturer в момент выбора (потом окно Джарвиса закрыло бы область),
// pixels — прямоугольник в пикселях снимка. Снимок только в памяти, на диск не пишется; после показа сбрасывается.
// Только для чата в окне: в фон, команды и Telegram не регистрируется (screen_ закрыт в telegram/policy.js).
function regionTools({ take = () => null, clear = () => {}, now = Date.now } = {}) {
  return [
    {
      name: 'screen_region_look',
      description: 'Картинка области экрана, которую владелец сам обвёл рамкой («объясни, что я обвёл»). Только смотреть и объяснять: ничего не нажимать и не оплачивать.',
      risk: 'T1',
      parameters: { type: 'object', properties: {} },
      async run() {
        const region = take();
        if (!region || !region.shot || !region.pixels) return { ok: false, summary: 'область не выбрана: владелец обводит её кнопкой у поля ввода', data: {} };
        if (now() - region.at > REGION_TTL_MS) { clear(); return { ok: false, summary: 'обведённая область устарела, обведите заново', data: {} }; }
        const want = region.pixels;
        let part;
        try { part = region.shot.crop(want); } catch (err) { return { ok: false, summary: `не удалось вырезать область: ${err.message}`, data: {} }; }
        const got = part && typeof part.getSize === 'function' ? part.getSize() : { width: 0, height: 0 };
        // Как у screen_look: ширину ужимаем до MAX_WIDTH, пропорции сохраняются.
        const small = got.width > MAX_WIDTH ? part.resize({ width: MAX_WIDTH, quality: 'best' }) : part;
        const bytes = small && typeof small.toJPEG === 'function' ? small.toJPEG(85) : Buffer.alloc(0);
        clear();
        if (!bytes.length) return { ok: false, summary: 'снимок области пустой', data: { width: got.width, height: got.height } };
        if (bytes.length > MAX_BYTES) return { ok: false, summary: 'снимок области слишком большой', data: {} };
        return {
          ok: true,
          summary: `снимок: ${region.label || `область ${got.width}×${got.height}`}`,
          data: { width: got.width, height: got.height, wantWidth: want.width, wantHeight: want.height, bytes: bytes.length },
          image: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        };
      },
      // Снимок есть и вырезан ровно того размера, что обвели; иначе честный провал.
      verify(args, result) {
        const d = (result && result.data) || {};
        const image = typeof result.image === 'string' && result.image.startsWith('data:image/jpeg;base64,') && result.image.length > 23;
        if (!image) return { status: 'failed', evidence: 'картинки области нет' };
        if (d.width !== d.wantWidth || d.height !== d.wantHeight) {
          return { status: 'failed', evidence: `размер не совпал: ${d.width}×${d.height} вместо ${d.wantWidth}×${d.wantHeight}` };
        }
        return { status: 'confirmed', evidence: `область ${d.width}×${d.height}` };
      },
    },
  ];
}

module.exports = { screenTools, regionTools, CAPTURE_SCRIPT, MAX_WIDTH, REGION_TTL_MS, frontWindowTitle, parseShot };
