'use strict';

// Мышь для окон без дерева элементов (игры, нестандартные программы). Сначала пробуем ui_click: он надёжнее.
// Координаты — точки снимка screen_look (он сжат до ширины SHOT_WIDTH, скрипт пересчитывает в настоящие).
// Окно указывается обязательно: точка должна лежать в нём, а чужое окно поверх не получит нажатие.
// Значения только через переменные окружения, окна самого Джарвиса исключены.
// Скрипт идёт в общем живом PowerShell (ps-host), как ui_*: без нового powershell.exe и без повторной
// сборки C# через Add-Type на каждое нажатие. Поэтому ранний выход — return: exit закрыл бы общий процесс.
const { runPowerShell } = require('./system');
const { MAX_WIDTH: SHOT_WIDTH } = require('./screen');

const TIMEOUT_MS = 15000;
const MAX_WINDOW = 120;
const MAX_COORD = 20000;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}',
  'Add-Type -AssemblyName System.Windows.Forms',
  "Add-Type -Namespace JarvisMouse -Name User32 -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);',
  '[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);',
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, int d, UIntPtr e);',
  'public struct POINT { public int X; public int Y; }',
  'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  "'@",
  '[void][JarvisMouse.User32]::SetProcessDPIAware()',
  'function Out($o) { ConvertTo-Json -Compress -InputObject $o }',
  // UIA доступна не во всех приложениях. Пустой или недоступный элемент не считается оплатой.
  'function Test-JPaymentAtPoint([int]$x, [int]$y) {',
  '  try {',
  '    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase',
  '    $element = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new([double]$x, [double]$y))',
  '    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  '    for ($depth = 0; $depth -lt 4 -and $null -ne $element; $depth++) {',
  '      $current = $element.Current',
  '      if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { break }',
  "      $label = @($current.Name, $current.AutomationId, $current.HelpText) -join ' '",
  "      if ($label -match 'оплат|купить|покупк|оформить заказ|подтвердить заказ|перевести деньги|checkout|\\bpay(?:ment)?\\b|\\bbuy\\b|place (?:the )?order|complete (?:the )?(?:order|purchase)|purchase now') { return $true }",
  '      $element = $walker.GetParent($element)',
  '    }',
  '  } catch {}',
  '  return $false',
  '}',
  // Опасная подпись под точкой: удаление, установка, выключение/перезагрузка. Смотрим сам элемент
  // и до четырёх родителей — так же, как у оплаты. Признак возвращаем словом: отказ должен быть понятным.
  'function Test-JDangerAtPoint([int]$x, [int]$y) {',
  '  try {',
  '    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase',
  '    $element = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new([double]$x, [double]$y))',
  '    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  '    for ($depth = 0; $depth -lt 4 -and $null -ne $element; $depth++) {',
  '      $current = $element.Current',
  '      if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { break }',
  "      $label = @($current.Name, $current.AutomationId, $current.HelpText) -join ' '",
  "      if ($label -match 'удал|корзин|перезапис|\\bdelete\\b|\\bremove\\b|\\buninstall\\b|\\btrash\\b') { return 'delete' }",
  "      if ($label -match 'перезагруз|завершение работы|выключение|выключить компьютер|выход из системы|выйти из системы|\\brestart\\b|shut ?down|sign out') { return 'power' }",
  "      if ($label -match 'установ|обновить драйвер|скачать и|\\binstall\\b|update driver|download and') { return 'install' }",
  '      $element = $walker.GetParent($element)',
  '    }',
  '  } catch {}',
  '  return $null',
  '}',
  'try {',
  '  $self = 0; [void][int]::TryParse([string]$env:JARVIS_UI_SELF_PID, [ref]$self)',
  '  $need = [string]$env:JARVIS_MOUSE_WINDOW',
  '  $p = Get-Process | Where-Object { $_.Id -ne $self -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle.IndexOf($need, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1',
  "  if ($null -eq $p) { Out @{ status = 'no_window' }; return }",
  '  $h = $p.MainWindowHandle',
  '  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  `  $shot = [Math]::Min(${SHOT_WIDTH}, $b.Width)`,
  '  $x = [int]([int]$env:JARVIS_MOUSE_X * $b.Width / $shot); $y = [int]([int]$env:JARVIS_MOUSE_Y * $b.Width / $shot)',
  "  if ($env:JARVIS_MOUSE_UNITS -eq 'physical') { $x = [int]$env:JARVIS_MOUSE_X; $y = [int]$env:JARVIS_MOUSE_Y }",
  '  $r = New-Object JarvisMouse.User32+RECT',
  '  [void][JarvisMouse.User32]::GetWindowRect($h, [ref]$r)',
  "  if ($x -lt $r.Left -or $x -ge $r.Right -or $y -lt $r.Top -or $y -ge $r.Bottom) { Out @{ status = 'outside'; title = $p.MainWindowTitle }; return }",
  // Окно уже впереди (второй клик в том же окне) — не активируем заново и не ждём 150 мс.
  '  if ([JarvisMouse.User32]::GetForegroundWindow() -ne $h) {',
  '    [void][JarvisMouse.User32]::SetForegroundWindow($h)',
  '    Start-Sleep -Milliseconds 150',
  '  }',
  "  if ([JarvisMouse.User32]::GetForegroundWindow() -ne $h) { Out @{ status = 'no_focus'; title = $p.MainWindowTitle }; return }",
  '  $pt = New-Object JarvisMouse.User32+POINT; $pt.X = $x; $pt.Y = $y',
  "  if ([JarvisMouse.User32]::GetAncestor([JarvisMouse.User32]::WindowFromPoint($pt), 2) -ne $h) { Out @{ status = 'occluded'; title = $p.MainWindowTitle }; return }",
  '  [void][JarvisMouse.User32]::SetCursorPos($x, $y)',
  '  Start-Sleep -Milliseconds 40',
  "  if ($env:JARVIS_MOUSE_ACTION -eq 'scroll') { [JarvisMouse.User32]::mouse_event(0x0800, 0, 0, [int]$env:JARVIS_MOUSE_DELTA, [UIntPtr]::Zero) }",
  '  else {',
  "    $down = 0x0002; $up = 0x0004; if ($env:JARVIS_MOUSE_ACTION -eq 'right') { $down = 0x0008; $up = 0x0010 }",
  "    $times = 1; if ($env:JARVIS_MOUSE_ACTION -eq 'double') { $times = 2 }",
  "    for ($i = 0; $i -lt $times; $i++) {",
  "      if (Test-JPaymentAtPoint $x $y) { Out @{ status = 'payment'; title = $p.MainWindowTitle }; return }",
  '      $danger = Test-JDangerAtPoint $x $y',
  "      if ($danger) { Out @{ status = 'danger'; kind = $danger; title = $p.MainWindowTitle }; return }",
  '      [JarvisMouse.User32]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero); [JarvisMouse.User32]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60',
  '    }',
  '  }',
  "  Out @{ status = 'ok'; title = $p.MainWindowTitle }",
  "} catch { Out @{ status = 'error'; message = [string]$_.Exception.Message } }",
].join('\n');

const DANGER_LABELS = { delete: 'удаление', install: 'установка', power: 'выключение или перезагрузка' };

const REFUSALS = {
  no_window: (w) => `окно «${w}» не найдено`,
  outside: (w) => `точка вне окна «${w}», нажатие не выполнено; посмотри снимок заново`,
  no_focus: (w) => `окно «${w}» не стало активным, нажатие не выполнено`,
  occluded: (w) => `точку закрывает другое окно, нажатие в «${w}» не выполнено`,
  payment: () => 'оплату выполняет владелец самостоятельно',
  danger: (kind) => `похоже на опасное действие${DANGER_LABELS[kind] ? ` (${DANGER_LABELS[kind]})` : ''}, мышью не нажимаю: нужно решение режима или подтверждение`,
};

function mouseTools({ runner = runPowerShell, selfPid = process.pid } = {}) {
  const act = async (window, x, y, action, delta, ctx = {}, units = 'shot') => {
    const w = String(window ?? '').trim();
    if (!w || w.length > MAX_WINDOW) return { ok: false, summary: 'window: часть заголовка окна', data: {} };
    if (units !== 'shot' && units !== 'physical') return { ok: false, summary: 'units: shot или physical', data: {} };
    for (const v of [x, y]) if (!Number.isInteger(v) || v < 0 || v > MAX_COORD) return { ok: false, summary: `x и y: целые от 0 до ${MAX_COORD}`, data: {} };
    const res = await runner(SCRIPT, {
      JARVIS_MOUSE_WINDOW: w, JARVIS_MOUSE_X: String(x), JARVIS_MOUSE_Y: String(y), JARVIS_MOUSE_ACTION: action, JARVIS_MOUSE_DELTA: String(delta || 0), JARVIS_UI_SELF_PID: String(selfPid || ''), JARVIS_MOUSE_UNITS: units,
    }, { timeoutMs: TIMEOUT_MS, signal: ctx.signal });
    if (!res || !res.ok) return { ok: false, summary: (res && res.summary) || 'PowerShell не ответил', data: {}, verified: 'unknown', evidence: 'исход нажатия неизвестен' };
    let r;
    try {
      r = JSON.parse(String(res.data.stdout).trim().split(/\r?\n/).pop());
    } catch {
      return { ok: false, summary: 'не удалось разобрать ответ', data: {}, verified: 'unknown', evidence: 'исход нажатия неизвестен' };
    }
    if (r.status === 'ok') return { ok: true, summary: `${action === 'scroll' ? 'прокрутка' : 'нажатие'} в окне «${r.title}»: ${x}, ${y}`, data: { x, y } };
    if (r.status === 'danger') {
      const kind = String(r.kind || '');
      return { ok: false, summary: REFUSALS.danger(kind), data: { status: 'danger', kind } };
    }
    if (REFUSALS[r.status]) return { ok: false, summary: REFUSALS[r.status](w), data: {} };
    return { ok: false, summary: `ошибка мыши: ${String(r.message || r.status).slice(0, 200)}`, data: {} };
  };
  // Нажатие по пикселям из кода не проверить: результат видно только на следующем снимке.
  const verify = async () => ({ status: 'unknown', evidence: 'посмотри снимок экрана, чтобы убедиться' });
  const base = { window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW, description: 'часть заголовка окна' }, x: { type: 'integer', minimum: 0, maximum: MAX_COORD }, y: { type: 'integer', minimum: 0, maximum: MAX_COORD } };
  return [
    {
      name: 'mouse_click',
      description: 'Нажать мышью по точке внутри окна. Только если нужного элемента нет в ui_elements. x и y — точки снимка экрана screen_look; units=physical — настоящие пиксели окна (так нажимает desktop_click). button: left, right или double.',
      risk: 'T1',
      parameters: { type: 'object', properties: { ...base, units: { type: 'string', enum: ['shot', 'physical'], default: 'shot', description: 'в чём заданы x и y' }, button: { type: 'string', enum: ['left', 'right', 'double'], default: 'left' } }, required: ['window', 'x', 'y'] },
      run: async (a = {}, ctx) => (['left', 'right', 'double', undefined].includes(a.button) ? act(a.window, a.x, a.y, a.button || 'left', 0, ctx, a.units || 'shot') : { ok: false, summary: 'button: left, right или double', data: {} }),
      verify,
    },
    {
      name: 'mouse_scroll',
      description: 'Прокрутить колесом в точке окна. lines больше 0 — вверх, меньше 0 — вниз. x и y — точки снимка screen_look.',
      risk: 'T1',
      parameters: { type: 'object', properties: { ...base, lines: { type: 'integer', minimum: -50, maximum: 50 } }, required: ['window', 'x', 'y', 'lines'] },
      run: async (a = {}, ctx) => (Number.isInteger(a.lines) && Math.abs(a.lines) <= 50 && a.lines !== 0 ? act(a.window, a.x, a.y, 'scroll', a.lines * 120, ctx) : { ok: false, summary: 'lines: целое от -50 до 50, не 0', data: {} }),
      verify,
    },
  ];
}

module.exports = { mouseTools, SCRIPT };
