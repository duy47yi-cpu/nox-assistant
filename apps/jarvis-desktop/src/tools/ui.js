'use strict';

// «Руки» Джарвиса: окна и элементы интерфейса программ через UI Automation.
// Модель работает только с текстом, поэтому элементы отдаются именами и типами, без картинок.
//
// Правила безопасности:
// - тексты скриптов постоянные; всё, что приходит от модели или пользователя (заголовки, имена,
//   тексты, числа), передаётся только через переменные окружения JARVIS_UI_*;
// - окна самого Джарвиса (его pid) исключаются из поиска, чтобы он не нажимал и не печатал в себя;
// - клавиши — только из белого списка; закрытие окна — отдельный инструмент с риском T2;
// - сетевых запросов нет, таймаут 15 с на вызов.
const { runPowerShell } = require('./system');
const { sleep } = require('./wait');

const TIMEOUT_MS = 15000;
const WAIT_DEFAULT_MS = 15000;
const WAIT_MAX_MS = 120000;
const WAIT_STEP_MS = 250;
const WAIT_PROBE_MS = 5000;
const MAX_WINDOW = 120;
const MAX_NAME = 200;
const MAX_FILTER = 120;
const MAX_TEXT = 2000;
const MAX_KEYS = 100;
const MAX_KEY_TOKENS = 20;
const MAX_OCCURRENCE = 1000;
const LIMIT_DEFAULT = 40;
const LIMIT_MAX = 60;

// ---------------------------------------------------------------------------
// Части PowerShell-скриптов. Только постоянный текст, значений пользователя здесь нет.

const PS_HEAD = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch {}',
  '$script:R = $null',
].join('\n');

// user32: активация окна, проверка переднего окна, клик мышью, WM_CLOSE.
// SetProcessDPIAware — чтобы координаты UIA и SetCursorPos совпадали при масштабе экрана не 100%.
const PS_USER32 = [
  "Add-Type -Namespace JarvisUi -Name User32 -MemberDefinition @'",
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);',
  '[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
  '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);',
  '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);',
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
  '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);',
  '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  "'@",
  '[void][JarvisUi.User32]::SetProcessDPIAware()',
].join('\n');

const PS_UIA = [
  'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase',
  '$AE = [System.Windows.Automation.AutomationElement]',
  '$TS = [System.Windows.Automation.TreeScope]',
  '$selfPid = 0',
  '[void][int]::TryParse([string]$env:JARVIS_UI_SELF_PID, [ref]$selfPid)',
  // Сжать пробелы и обрезать строку до n символов.
  'function Cut([object]$s, [int]$n) {',
  "  if ($null -eq $s) { return '' }",
  "  $t = ([string]$s -replace '\\s+', ' ').Trim()",
  '  if ($t.Length -gt $n) { return $t.Substring(0, $n) }',
  '  return $t',
  '}',
  // Поиск подстроки без учёта регистра и без подстановочных символов (-like здесь не годится).
  'function Has([string]$hay, [string]$needle) {',
  '  if ($null -eq $hay) { return $false }',
  '  return $hay.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0',
  '}',
  'function TypeOf($ct) {',
  "  if ($null -eq $ct) { return '' }",
  "  return ([string]$ct.ProgrammaticName) -replace '^ControlType\\.', ''",
  '}',
  // Окна верхнего уровня с непустым заголовком, кроме окон самого Джарвиса.
  'function Get-JTopWindows {',
  '  $list = New-Object System.Collections.ArrayList',
  '  $all = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)',
  '  foreach ($w in $all) {',
  '    try { $n = [string]$w.Current.Name; $p = [int]$w.Current.ProcessId } catch { continue }',
  '    if ([string]::IsNullOrWhiteSpace($n)) { continue }',
  '    if ($selfPid -ne 0 -and $p -eq $selfPid) { continue }',
  // Диалог программы («Сохранить как», «Открыть») в дереве UIA — ребёнок её окна: показываем его первым, как отдельное окно.
  "    $dc = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $AE::ClassNameProperty, '#32770'",
  '    try { foreach ($d in $w.FindAll($TS::Children, $dc)) { if (-not [string]::IsNullOrWhiteSpace([string]$d.Current.Name)) { [void]$list.Add($d) } } } catch {}',
  '    [void]$list.Add($w)',
  '  }',
  '  return ,$list',
  '}',
  // Окно по части заголовка: точное совпадение важнее, иначе первое по Z-порядку.
  'function Find-JWindow([string]$needle) {',
  '  $needle = Cut $needle 1000',
  '  if ($needle -eq \'\') { return $null }',
  '  $part = $null',
  '  foreach ($w in (Get-JTopWindows)) {',
  '    $n = Cut $w.Current.Name 1000',
  '    if ($n -ieq $needle) { return $w }',
  '    if ($null -eq $part -and (Has $n $needle)) { $part = $w }',
  '  }',
  '  return $part',
  '}',
  // Все элементы окна одним запросом, с кешем нужных свойств (так быстрее, чем по одному).
  'function Get-JElements($w) {',
  '  $cr = New-Object System.Windows.Automation.CacheRequest',
  '  $cr.Add($AE::NameProperty)',
  '  $cr.Add($AE::ControlTypeProperty)',
  '  $cr.Add($AE::IsEnabledProperty)',
  '  $cr.Add($AE::AutomationIdProperty)',
  '  $cr.Add($AE::BoundingRectangleProperty)',
  '  $cr.Add([System.Windows.Automation.ValuePattern]::ValueProperty)',
  '  $h = $cr.Activate()',
  '  try { $all = $w.FindAll($TS::Descendants, [System.Windows.Automation.Automation]::ControlViewCondition) } finally { $h.Dispose() }',
  '  return ,$all',
  '}',
  'function Short($e) {',
  '  return [ordered]@{ name = (Cut $e.Cached.Name 80); type = (TypeOf $e.Cached.ControlType); enabled = [bool]$e.Cached.IsEnabled }',
  '}',
].join('\n');

// Поиск целевого элемента по имени. Точные совпадения (без регистра) важнее частичных.
// Несколько совпадений без occurrence — отказ со списком первых пяти.
// Частичное совпадение не берёт надписи и панели: «Папка» не должна попасть в текст «Эта папка пуста.».
const PS_TARGET = [
  "$script:JPassive = @('Text', 'Pane', 'Group', 'StatusBar', 'Image', 'Header', 'Window', 'TitleBar', 'ToolBar', 'Separator')",
  '$script:JKinds = $null', // живой PowerShell помнит переменные: ограничение ui_type не должно перейти в другой инструмент
  'function Find-JTarget($w, [string]$needle, [int]$occ) {',
  '  $needle = Cut $needle 1000',
  '  $exact = New-Object System.Collections.ArrayList',
  '  $part = New-Object System.Collections.ArrayList',
  '  foreach ($e in (Get-JElements $w)) {',
  '    $n = Cut $e.Cached.Name 1000',
  // Точное совпадение и по AutomationId: у поля «Имя файла» в окнах сохранения Windows он всегда 1001, а имя — текущий текст поля.
  "    $aid = ''",
  '    try { $aid = [string]$e.Cached.AutomationId } catch {}',
  "    if ($aid -ne '' -and $aid -ceq $needle) { [void]$exact.Add($e); continue }",
  "    if ($n -eq '') { continue }",
  // Ввод текста ищет только поля: иначе «Имя» попало бы в заголовок столбца «Имя», а не в поле имени папки.
  '    if ($null -ne $script:JKinds -and $script:JKinds -notcontains (TypeOf $e.Cached.ControlType)) { continue }',
  '    if ($n -ieq $needle) { [void]$exact.Add($e) } elseif ((Has $n $needle) -and ($script:JPassive -notcontains (TypeOf $e.Cached.ControlType))) { [void]$part.Add($e) }',
  '  }',
  '  $m = $exact',
  '  if ($m.Count -eq 0) { $m = $part }',
  // Пункт меню «Папку» и его же надпись «Папку»: если управляемый элемент среди совпадений один, берём его.
  '  if ($occ -le 0 -and $m.Count -gt 1) {',
  '    $act = @($m | Where-Object { $script:JPassive -notcontains (TypeOf $_.Cached.ControlType) })',
  '    if ($act.Count -eq 1) { $m = New-Object System.Collections.ArrayList; [void]$m.Add($act[0]) }',
  '  }',
  '  $top = @($m | Select-Object -First 5 | ForEach-Object { Short $_ })',
  "  if ($m.Count -eq 0) { return @{ status = 'not_found' } }",
  "  if ($occ -le 0 -and $m.Count -gt 1) { return @{ status = 'ambiguous'; count = $m.Count; matches = $top } }",
  '  if ($occ -le 0) { $occ = 1 }',
  "  if ($occ -gt $m.Count) { return @{ status = 'out_of_range'; count = $m.Count; matches = $top } }",
  "  return @{ status = 'ok'; element = $m[$occ - 1]; count = $m.Count }",
  '}',
  'function Get-Occurrence {',
  '  $o = 0',
  '  [void][int]::TryParse([string]$env:JARVIS_UI_OCCURRENCE, [ref]$o)',
  '  return $o',
  '}',
].join('\n');

// Активация окна: SetForegroundWindow по handle, при неудаче — WScript.Shell AppActivate по заголовку.
// Успех проверяется по GetForegroundWindow (своё окно или его модальный диалог).
const PS_FOREGROUND = [
  'function Test-JForeground([IntPtr]$h) {',
  '  $fg = [JarvisUi.User32]::GetForegroundWindow()',
  '  if ($fg -eq $h) { return $true }',
  '  if ($fg -ne [IntPtr]::Zero -and [JarvisUi.User32]::GetAncestor($fg, 3) -eq $h) { return $true }',
  '  return $false',
  '}',
  // Открытый модальный диалог программы (класс #32770: «Сохранить как», «Открыть», вопросы): ввод идёт в него, а не в главное окно.
  'function Get-JDialog($w) {',
  "  $c = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $AE::ClassNameProperty, '#32770'",
  '  try { $d = $w.FindFirst($TS::Children, $c) } catch { return [IntPtr]::Zero }',
  '  if ($null -eq $d) { return [IntPtr]::Zero }',
  '  return [IntPtr][int64]$d.Current.NativeWindowHandle',
  '}',
  'function Set-JForeground($w) {',
  '  $h = [IntPtr][int64]$w.Current.NativeWindowHandle',
  '  if ($h -eq [IntPtr]::Zero) { return $false }',
  '  if ([JarvisUi.User32]::IsIconic($h)) { [void][JarvisUi.User32]::ShowWindow($h, 9) }',
  '  $dlg = Get-JDialog $w',
  '  if ($dlg -ne [IntPtr]::Zero) { $h = $dlg }',
  '  [void][JarvisUi.User32]::SetForegroundWindow($h)',
  '  Start-Sleep -Milliseconds 150',
  '  if (Test-JForeground $h) { return $true }',
  // Windows не даёт фоновому процессу забрать передний план. Без нажатий клавиш: на миг подключаемся к потоку
  // переднего окна (AttachThreadInput), тогда SetForegroundWindow разрешён.
  '  $fgw = [JarvisUi.User32]::GetForegroundWindow()',
  '  $fpid = [uint32]0',
  '  $ft = [JarvisUi.User32]::GetWindowThreadProcessId($fgw, [ref]$fpid)',
  '  $me = [JarvisUi.User32]::GetCurrentThreadId()',
  '  if ($ft -ne 0 -and $ft -ne $me) {',
  '    $att = [JarvisUi.User32]::AttachThreadInput($me, $ft, $true)',
  '    try { [void][JarvisUi.User32]::BringWindowToTop($h); [void][JarvisUi.User32]::SetForegroundWindow($h) } finally { if ($att) { [void][JarvisUi.User32]::AttachThreadInput($me, $ft, $false) } }',
  '    Start-Sleep -Milliseconds 150',
  '    if (Test-JForeground $h) { return $true }',
  '  }',
  '  try {',
  '    $sh = New-Object -ComObject WScript.Shell',
  '    [void]$sh.AppActivate([string]$w.Current.Name)',
  '    Start-Sleep -Milliseconds 300',
  '  } catch {}',
  '  return (Test-JForeground $h)',
  '}',
  // Лежит ли элемент внутри окна: подъём по дереву UIA.
  'function Test-JInside($e, $w) {',
  '  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker',
  '  $cur = $e',
  '  for ($i = 0; $i -lt 80 -and $null -ne $cur; $i++) {',
  '    if ([System.Windows.Automation.Automation]::Compare($cur, $w)) { return $true }',
  '    $cur = $walker.GetParent($cur)',
  '  }',
  '  return $false',
  '}',
].join('\n');

// Чтение состояния для проверки действия. Только чтение. Элемент каждый раз ищется заново;
// недоступное значение не считается пустым, сбой провайдера UIA не считается исчезновением окна (окно проверяет IsWindow).
const PS_CHECK = [
  'function Get-JWinState($w, [IntPtr]$h, [int]$wpid) {',
  '  $s = [ordered]@{ alive = $null; fg = [JarvisUi.User32]::GetForegroundWindow().ToInt64(); readable = $false; title = $null; count = $null; tops = $null }',
  '  if ($h -ne [IntPtr]::Zero) { $s.alive = [bool][JarvisUi.User32]::IsWindow($h) }',
  '  try {',
  '    $s.title = Cut $w.Current.Name 120',
  '    $s.count = (Get-JElements $w).Count',
  '    $c = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $AE::ProcessIdProperty, $wpid',
  '    $s.tops = $AE::RootElement.FindAll($TS::Children, $c).Count',
  '    $s.readable = $true',
  '  } catch {}',
  '  return $s',
  '}',
  'function Get-JTargetState($w, [string]$needle, [int]$occ) {',
  "  try { $f = Find-JTarget $w $needle $occ } catch { return @{ found = 'error' } }",
  "  if ($f.status -ne 'ok') { return @{ found = [string]$f.status } }",
  '  $e = $f.element',
  "  $s = [ordered]@{ found = 'ok'; name = $null; enabled = $null; toggle = $null; selected = $null; expand = $null }",
  '  try {',
  '    $s.name = Cut $e.Current.Name 80',
  '    $s.enabled = [bool]$e.Current.IsEnabled',
  '    $p = $null',
  '    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $s.toggle = [string]$p.Current.ToggleState }',
  '    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $s.selected = [bool]$p.Current.IsSelected }',
  '    if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $s.expand = [string]$p.Current.ExpandCollapseState }',
  "  } catch { $s.found = 'error' }",
  '  return $s',
  '}',
  // Значение поля: Value, иначе Text. Пароль и поле без этих паттернов — known = false.
  'function Read-JValue($e) {',
  '  try {',
  '    if ($null -eq $e -or $e.Current.IsPassword) { return @{ known = $false } }',
  '    $p = $null',
  '    if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { return @{ known = $true; value = [string]$p.Current.Value } }',
  '    if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$p)) { return @{ known = $true; value = [string]$p.DocumentRange.GetText(20000) } }',
  '  } catch {}',
  '  return @{ known = $false }',
  '}',
  "function Norm([string]$v) { return (($v -replace '\\r\\n?', ([string][char]10)).TrimEnd([char]10)) }",
].join('\n');

const PS_TAIL = [
  'try { $null = Main } catch {',
  "  $script:R = @{ status = 'error'; message = (Cut $_.Exception.Message 300) }",
  '}',
  'ConvertTo-Json -Compress -Depth 6 -InputObject $script:R',
].join('\n');

function buildScript(parts) {
  return parts.join('\n');
}

// --- ui_windows -----------------------------------------------------------
const WINDOWS_MAIN = [
  'function Main {',
  '  $out = New-Object System.Collections.ArrayList',
  '  $budget = 0',
  '  foreach ($w in (Get-JTopWindows)) {',
  '    if ($out.Count -ge 40 -or $budget -gt 7000) { break }',
  '    $c = $w.Current',
  "    $pn = ''",
  '    try { $pn = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}',
  '    $t = Cut $c.Name 120',
  '    $budget += $t.Length + $pn.Length + 50',
  '    [void]$out.Add([ordered]@{ title = $t; process = $pn; handle = [int64]$c.NativeWindowHandle })',
  '  }',
  '  $script:R = $out',
  '}',
].join('\n');
const WINDOWS_TAIL = [
  'try { $null = Main; ConvertTo-Json -Compress -Depth 4 -InputObject @($script:R) } catch {',
  "  ConvertTo-Json -Compress -InputObject @{ status = 'error'; message = (Cut $_.Exception.Message 300) }",
  '}',
].join('\n');
const WINDOWS_SCRIPT = buildScript([PS_HEAD, PS_UIA, WINDOWS_MAIN, WINDOWS_TAIL]);

// --- ui_elements ----------------------------------------------------------
const ELEMENTS_MAIN = [
  'function Main {',
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $filter = Cut ([string]$env:JARVIS_UI_FILTER) 200',
  '  $limit = 40',
  '  [void][int]::TryParse([string]$env:JARVIS_UI_LIMIT, [ref]$limit)',
  '  if ($limit -lt 1 -or $limit -gt 60) { $limit = 40 }',
  '  $items = New-Object System.Collections.ArrayList',
  '  $total = 0',
  '  $budget = 0',
  '  $cut = $false',
  "  $interactive = @('Button','Edit','MenuItem','ListItem','Hyperlink','CheckBox','RadioButton','ComboBox','TabItem','TreeItem','DataItem','Slider','Spinner','SplitButton')",
  '  foreach ($e in (Get-JElements $w)) {',
  '    $n = Cut $e.Cached.Name 100',
  "    $v = ''",
  '    try { $v = Cut ([string]$e.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty)) 80 } catch {}',
  '    $t = TypeOf $e.Cached.ControlType',
  '    $r = $e.Cached.BoundingRectangle',
  '    $b = $null',
  '    if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0) { $b = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } }',
  "    if ($n -eq '' -and $v -eq '' -and -not ($null -ne $b -and $interactive -contains $t)) { continue }",
  "    if ($filter -ne '' -and -not ((Has $n $filter) -or (Has $t $filter))) { continue }",
  '    $total++',
  '    if ($items.Count -ge $limit -or $budget -gt 6500) { $cut = $true; continue }',
  '    $budget += $n.Length + $v.Length + $t.Length + 70',
  '    [void]$items.Add([ordered]@{ name = $n; type = $t; enabled = [bool]$e.Cached.IsEnabled; value = $v; bounds = $b })',
  '  }',
  "  $script:R = @{ status = 'ok'; window = (Cut $w.Current.Name 120); total = $total; truncated = $cut; items = $items }",
  '}',
].join('\n');
const ELEMENTS_SCRIPT = buildScript([PS_HEAD, PS_UIA, ELEMENTS_MAIN, PS_TAIL]);

// Похожие имена элементов, если точного нет: модель сразу повторяет клик с нужным именем, без ui_elements.
const PS_SUGGEST = [
  'function Get-JSuggestions($w, [string]$needle) {',
  '  $first = ($needle.ToLower() -split "\\s+")[0]',
  '  $out = New-Object System.Collections.ArrayList',
  '  foreach ($e in (Get-JElements $w)) {',
  '    $n = Cut $e.Cached.Name 120',
  "    if ($n -eq '') { continue }",
  '    if ($first -ne "" -and -not $n.ToLower().Contains($first)) { continue }',
  '    if (-not $out.Contains($n)) { [void]$out.Add($n) }',
  '    if ($out.Count -ge 8) { break }',
  '  }',
  '  return ,@($out)',
  '}',
].join('\n');

// Проверка элемента перед нажатием: признаки оплаты в подписи, AutomationId и подсказке самого элемента
// и его родителей — до 4 уровней вверх по дереву управления, до окна.
// Список признаков надо держать согласованным с PAY_ELEMENT в src/policy/modes.js и с Test-JPaymentAtPoint
// в src/tools/mouse.js: новый признак оплаты добавляется во все три места.
const PS_PAYMENT = [
  'function Test-JPaymentElement($e) {',
  '  try {',
  '    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  '    $cur = $e',
  '    for ($depth = 0; $depth -lt 4 -and $null -ne $cur; $depth++) {',
  '      $c = $cur.Current',
  '      if ($c.ControlType -eq [System.Windows.Automation.ControlType]::Window) { break }',
  "      $label = @([string]$c.Name, [string]$c.AutomationId, [string]$c.HelpText) -join ' '",
  "      if ($label -match 'оплат|купить|покупк|подписк|оформить заказ|подтвердить заказ|перевести деньги|checkout|\\bpay(?:ment)?\\b|\\bbuy\\b|\\bsubscribe\\b|\\btransfer\\b|place (?:the )?order|complete (?:the )?(?:order|purchase)|purchase now') { return $true }",
  '      $cur = $walker.GetParent($cur)',
  '    }',
  '  } catch {}',
  '  return $false',
  '}',
].join('\n');

// --- ui_click -------------------------------------------------------------
const CLICK_MAIN = [
  'function Main {',
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $title = Cut $w.Current.Name 120',
  '  $f = Find-JTarget $w ([string]$env:JARVIS_UI_NAME) (Get-Occurrence)',
  "  if ($f.status -eq 'not_found') { $f.window = $title; $f.suggestions = (Get-JSuggestions $w ([string]$env:JARVIS_UI_NAME)); $script:R = $f; return }",
  "  if ($f.status -ne 'ok') { $f.window = $title; $script:R = $f; return }",
  '  $t = $f.element',
  '  $info = Short $t',
  "  if (-not $t.Cached.IsEnabled) { $script:R = @{ status = 'disabled'; window = $title; element = $info }; return }",
  // Оплату не нажимаем даже по безобидному имени: смотрим сам элемент и родителей до окна.
  "  if (Test-JPaymentElement $t) { $script:R = @{ status = 'payment'; window = $title; element = $info }; return }",
  '  $occ = Get-Occurrence',
  '  $needle = [string]$env:JARVIS_UI_NAME',
  '  $h = [IntPtr][int64]$w.Current.NativeWindowHandle',
  '  $wpid = [int]$w.Current.ProcessId',
  // Два замера до действия: если число элементов меняется само, по нему судить нельзя.
  '  $b0 = Get-JWinState $w $h $wpid',
  '  Start-Sleep -Milliseconds 200',
  '  $b1 = Get-JWinState $w $h $wpid',
  '  $tb = Get-JTargetState $w $needle $occ',
  '  $p = $null',
  "  $method = ''",
  "  if ($t.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $method = 'invoke' }",
  "  elseif ($t.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); $method = 'toggle' }",
  "  elseif ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); $method = 'select' }",
  '  else {',
  "    if (-not (Set-JForeground $w)) { $script:R = @{ status = 'no_focus'; window = $title }; return }",
  '    $pt = New-Object System.Windows.Point',
  '    if (-not $t.TryGetClickablePoint([ref]$pt)) {',
  '      $r = $t.Current.BoundingRectangle',
  "      if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { $script:R = @{ status = 'no_point'; window = $title; element = $info }; return }",
  '      $pt = New-Object System.Windows.Point -ArgumentList ($r.X + $r.Width / 2), ($r.Y + $r.Height / 2)',
  '    }',
  // Не кликаем вслепую: в точке должен быть элемент нашего окна, а не чужое окно поверх.
  '    $hit = $null',
  '    try { $hit = $AE::FromPoint($pt) } catch {}',
  "    if ($null -eq $hit -or -not (Test-JInside $hit $w)) { $script:R = @{ status = 'occluded'; window = $title; element = $info }; return }",
  '    [void][JarvisUi.User32]::SetCursorPos([int]$pt.X, [int]$pt.Y)',
  '    Start-Sleep -Milliseconds 50',
  '    [JarvisUi.User32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
  '    [JarvisUi.User32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
  "    $method = 'click'",
  '  }',
  '  $sb = ConvertTo-Json -Compress -Depth 4 -InputObject @($b1, $tb)',
  '  for ($i = 0; $i -lt 3; $i++) {',
  '    Start-Sleep -Milliseconds 250',
  '    $a = Get-JWinState $w $h $wpid',
  '    $ta = Get-JTargetState $w $needle $occ',
  '    if ((ConvertTo-Json -Compress -Depth 4 -InputObject @($a, $ta)) -ne $sb) { break }',
  '  }',
  "  $check = @{ before = $b1; after = $a; target = $tb; targetAfter = $ta; noisy = ($b0.count -ne $b1.count) }",
  "  $script:R = @{ status = 'ok'; window = $title; element = $info; method = $method; count = $f.count; check = $check }",
  '}',
].join('\n');
const CLICK_SCRIPT = buildScript([PS_HEAD, PS_USER32, PS_UIA, PS_TARGET, PS_FOREGROUND, PS_SUGGEST, PS_CHECK, PS_PAYMENT, CLICK_MAIN, PS_TAIL]);

// --- ui_type --------------------------------------------------------------
// Значение читается заново после действия. Текст наружу не отдаём: только длину и совпадение.
const TYPE_READBACK = [
  'function Get-JReadback($w, [string]$method) {',
  '  $want = Norm ([string]$env:JARVIS_UI_TEXT)',
  "  $out = @{ found = 'ok'; known = $false; matches = $false; length = 0 }",
  '  for ($i = 0; $i -lt 4; $i++) {',
  '    Start-Sleep -Milliseconds 150',
  '    $e = $null',
  "    if (([string]$env:JARVIS_UI_NAME).Trim() -ne '') {",
  '      $f = Find-JTarget $w ([string]$env:JARVIS_UI_NAME) (Get-Occurrence)',
  '      $out.found = [string]$f.status',
  "      if ($f.status -eq 'ok') { $e = $f.element }",
  '    } else {',
  '      $e = $AE::FocusedElement',
  "      if ($null -eq $e -or -not (Test-JInside $e $w)) { $e = $null; $out.found = 'focus_elsewhere' } else { $out.found = 'ok' }",
  '    }',
  '    $r = Read-JValue $e',
  '    $out.known = [bool]$r.known',
  '    if ($r.known) {',
  '      $v = Norm $r.value',
  '      $out.length = $v.Length',
  "      if ($method -eq 'value') { $out.matches = ($v -ceq $want) } else { $out.matches = $v.Contains($want) }",
  '      if ($out.matches) { break }',
  '    }',
  '  }',
  '  return $out',
  '}',
].join('\n');

const TYPE_MAIN = [
  'function Main {',
  "  $script:JKinds = @('Edit', 'Document', 'ComboBox')",
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $title = Cut $w.Current.Name 120',
  '  $name = [string]$env:JARVIS_UI_NAME',
  '  $focused = $false',
  "  if ($name.Trim() -ne '') {",
  '    $f = Find-JTarget $w $name (Get-Occurrence)',
  "    if ($f.status -ne 'ok') { $f.window = $title; $script:R = $f; return }",
  '    $t = $f.element',
  '    $info = Short $t',
  "    if (-not $t.Cached.IsEnabled) { $script:R = @{ status = 'disabled'; window = $title; element = $info }; return }",
  '  } else {',
  "    if (-not (Set-JForeground $w)) { $script:R = @{ status = 'no_focus'; window = $title }; return }",
  '    $focused = $true',
  '    $t = $AE::FocusedElement',
  "    if ($null -eq $t -or -not (Test-JInside $t $w)) { $script:R = @{ status = 'focus_elsewhere'; window = $title }; return }",
  '    $info = [ordered]@{ name = (Cut $t.Current.Name 80); type = (TypeOf $t.Current.ControlType); enabled = [bool]$t.Current.IsEnabled }',
  '  }',
  '  $p = $null',
  '  if ($t.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p) -and -not $p.Current.IsReadOnly) {',
  '    $p.SetValue([string]$env:JARVIS_UI_TEXT)',
  "    $script:R = @{ status = 'ok'; window = $title; element = $info; method = 'value'; check = (Get-JReadback $w 'value') }",
  '    return',
  '  }',
  // Многострочный текст с клавиатуры отправил бы Enter — не делаем этого.
  "  if ([string]$env:JARVIS_UI_MULTILINE -eq '1') { $script:R = @{ status = 'multiline'; window = $title; element = $info }; return }",
  "  if (-not $focused -and -not (Set-JForeground $w)) { $script:R = @{ status = 'no_focus'; window = $title }; return }",
  '  try { $t.SetFocus() } catch {}',
  '  Start-Sleep -Milliseconds 100',
  '  $h = [IntPtr][int64]$w.Current.NativeWindowHandle',
  "  if (-not (Test-JForeground $h)) { $script:R = @{ status = 'no_focus'; window = $title }; return }",
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  [System.Windows.Forms.SendKeys]::SendWait([string]$env:JARVIS_UI_SENDKEYS)',
  "  $script:R = @{ status = 'ok'; window = $title; element = $info; method = 'sendkeys'; check = (Get-JReadback $w 'sendkeys') }",
  '}',
].join('\n');
const TYPE_SCRIPT = buildScript([PS_HEAD, PS_USER32, PS_UIA, PS_TARGET, PS_FOREGROUND, PS_CHECK, TYPE_READBACK, TYPE_MAIN, PS_TAIL]);

// --- ui_keys --------------------------------------------------------------
// Что видно снаружи до и после клавиш: активное окно и элемент в фокусе. Значение — только хеш и длина.
const KEYS_STATE = [
  'function Get-JKeyState {',
  '  $fg = [JarvisUi.User32]::GetForegroundWindow()',
  '  $s = [ordered]@{ fg = $fg.ToInt64(); title = $null; focus = $null; known = $false; hash = $null; length = 0 }',
  '  try {',
  '    $s.title = Cut $AE::FromHandle($fg).Current.Name 120',
  '    $e = $AE::FocusedElement',
  "    $s.focus = (TypeOf $e.Current.ControlType) + ':' + (Cut $e.Current.Name 80)",
  '    $r = Read-JValue $e',
  '    if ($r.known) { $s.known = $true; $s.hash = $r.value.GetHashCode(); $s.length = $r.value.Length }',
  '  } catch {}',
  '  return $s',
  '}',
  'function Test-JPaymentFocus {',
  '  try {',
  '    $e = $AE::FocusedElement',
  '    $type = [string]$e.Current.ControlType.ProgrammaticName',
  "    if ($type -notmatch '(?i)Button|Hyperlink|MenuItem') { return $false }",
  "    return ([string]$e.Current.Name -match '(?i)оплат|купить|покупк|подписк|оформить заказ|подтвердить заказ|перевести деньги|checkout|\\bpay(?:ment)?\\b|\\bbuy\\b|\\bsubscribe\\b|purchase')",
  '  } catch { return $false }',
  '}',
].join('\n');

const KEYS_MAIN = [
  'function Main {',
  '  $wname = [string]$env:JARVIS_UI_WINDOW',
  "  if ($wname.Trim() -ne '') {",
  '    $w = Find-JWindow $wname',
  "    if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '    $title = Cut $w.Current.Name 120',
  // Ctrl+S в окне уже сохранённого файла перезаписывает его: пусть вызов назовёт файл в window, тогда спросит Risk Gate.
  "    if ([string]$env:JARVIS_UI_SAVE_GUARD -eq '1' -and $title -match '\\.[A-Za-z0-9]{1,5}(\\s|$)') { $script:R = @{ status = 'save_existing'; window = $title }; return }",
  "    if (-not (Set-JForeground $w)) { $script:R = @{ status = 'no_focus'; window = $title }; return }",
  '  } else {',
  '    $fg = [JarvisUi.User32]::GetForegroundWindow()',
  "    if ($fg -eq [IntPtr]::Zero) { $script:R = @{ status = 'no_focus' }; return }",
  '    $fpid = [uint32]0',
  '    [void][JarvisUi.User32]::GetWindowThreadProcessId($fg, [ref]$fpid)',
  "    if ($selfPid -ne 0 -and [int]$fpid -eq $selfPid) { $script:R = @{ status = 'self_foreground' }; return }",
  "    $title = ''",
  '    try { $title = Cut $AE::FromHandle($fg).Current.Name 120 } catch {}',
  "    if ([string]$env:JARVIS_UI_SAVE_GUARD -eq '1' -and $title -match '\\.[A-Za-z0-9]{1,5}(\\s|$)') { $script:R = @{ status = 'save_existing'; window = $title }; return }",
  '  }',
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  $b = Get-JKeyState',
  '  $sb = ConvertTo-Json -Compress -InputObject $b',
  // Виртуальные клавиши через keybd_event: сочетания с Ctrl из SendKeys новые программы Windows (Блокнот, Проводник) не принимают.
  '  $plan = [string]$env:JARVIS_UI_VK',
  "  if ($plan -ne '') {",
  '    $ext = @(33, 34, 35, 36, 37, 38, 39, 40)',
  "    foreach ($combo in $plan.Split(';')) {",
  "      $codes = @($combo.Split(',') | ForEach-Object { [int]$_ })",
  "      if (($codes -contains 13 -or $codes -contains 32) -and (Test-JPaymentFocus)) { $script:R = @{ status = 'payment'; window = $title }; return }",
  '      foreach ($c in $codes) { $f = 0; if ($ext -contains $c) { $f = 1 }; [JarvisUi.User32]::keybd_event([byte]$c, 0, $f, [UIntPtr]::Zero) }',
  '      for ($j = $codes.Count - 1; $j -ge 0; $j--) { $f = 2; if ($ext -contains $codes[$j]) { $f = 3 }; [JarvisUi.User32]::keybd_event([byte]$codes[$j], 0, $f, [UIntPtr]::Zero) }',
  '      Start-Sleep -Milliseconds 40',
  '    }',
  '  } else { [System.Windows.Forms.SendKeys]::SendWait([string]$env:JARVIS_UI_KEYS) }',
  '  for ($i = 0; $i -lt 3; $i++) {',
  '    Start-Sleep -Milliseconds 200',
  '    $a = Get-JKeyState',
  '    if ((ConvertTo-Json -Compress -InputObject $a) -ne $sb) { break }',
  '  }',
  "  $script:R = @{ status = 'ok'; window = $title; check = @{ before = $b; after = $a } }",
  '}',
].join('\n');
const KEYS_SCRIPT = buildScript([PS_HEAD, PS_USER32, PS_UIA, PS_FOREGROUND, PS_CHECK, KEYS_STATE, KEYS_MAIN, PS_TAIL]);

// --- ui_focus -------------------------------------------------------------
const FOCUS_MAIN = [
  'function Main {',
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $title = Cut $w.Current.Name 120',
  "  if (-not (Set-JForeground $w)) { $script:R = @{ status = 'no_focus'; window = $title }; return }",
  // Повторное чтение чуть позже: окно могло сразу потерять передний план.
  '  Start-Sleep -Milliseconds 150',
  '  $h = [IntPtr][int64]$w.Current.NativeWindowHandle',
  "  $script:R = @{ status = 'ok'; window = $title; check = @{ foreground = [bool](Test-JForeground $h) } }",
  '}',
].join('\n');
const FOCUS_SCRIPT = buildScript([PS_HEAD, PS_USER32, PS_UIA, PS_FOREGROUND, FOCUS_MAIN, PS_TAIL]);

// --- ui_close_window ------------------------------------------------------
// WM_CLOSE через PostMessage: асинхронно, программа может спросить «сохранить?».
// Окна оболочки (рабочий стол, панель задач) не закрываем: WM_CLOSE им открывает диалог выключения.
const CLOSE_MAIN = [
  'function Main {',
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $title = Cut $w.Current.Name 120',
  '  $cls = [string]$w.Current.ClassName',
  "  if (@('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -contains $cls) { $script:R = @{ status = 'protected'; window = $title }; return }",
  '  $h = [IntPtr][int64]$w.Current.NativeWindowHandle',
  "  if ($h -eq [IntPtr]::Zero) { $script:R = @{ status = 'no_handle'; window = $title }; return }",
  '  [void][JarvisUi.User32]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)',
  '  Start-Sleep -Milliseconds 1000',
  "  $script:R = @{ status = 'ok'; window = $title; closed = (-not [JarvisUi.User32]::IsWindow($h)) }",
  '}',
].join('\n');
const CLOSE_SCRIPT = buildScript([PS_HEAD, PS_USER32, PS_UIA, CLOSE_MAIN, PS_TAIL]);

// --- ui_set_toggle --------------------------------------------------------
// Уже нужное состояние — ничего не нажимаем. Иначе Toggle до двух раз: трёхпозиционный флажок идёт Off → On → Indeterminate → Off.
const TOGGLE_MAIN = [
  'function Main {',
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $title = Cut $w.Current.Name 120',
  '  $name = [string]$env:JARVIS_UI_NAME',
  '  $f = Find-JTarget $w $name (Get-Occurrence)',
  "  if ($f.status -eq 'not_found') { $f.window = $title; $f.suggestions = (Get-JSuggestions $w $name); $script:R = $f; return }",
  "  if ($f.status -ne 'ok') { $f.window = $title; $script:R = $f; return }",
  '  $t = $f.element',
  '  $info = Short $t',
  "  if (-not $t.Cached.IsEnabled) { $script:R = @{ status = 'disabled'; window = $title; element = $info }; return }",
  // Флажок с признаком оплаты (подписка, согласие со списанием) не переключаем: проверка та же, что у нажатия.
  "  if (Test-JPaymentElement $t) { $script:R = @{ status = 'payment'; window = $title; element = $info }; return }",
  '  $p = $null',
  "  if (-not $t.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $script:R = @{ status = 'no_toggle'; window = $title; element = $info }; return }",
  "  $want = if ([string]$env:JARVIS_UI_STATE -eq 'on') { 'On' } else { 'Off' }",
  '  $was = [string]$p.Current.ToggleState',
  '  $now = $was',
  '  for ($i = 0; $i -lt 2 -and $now -ne $want; $i++) {',
  '    $before = $now',
  '    $p.Toggle()',
  // Окно могло не успеть: второй Toggle вслепую отменил бы первый.
  '    for ($j = 0; $j -lt 10 -and $now -eq $before; $j++) { Start-Sleep -Milliseconds 150; $now = [string]$p.Current.ToggleState }',
  '    if ($now -eq $before) { break }',
  '  }',
  "  $script:R = @{ status = 'ok'; window = $title; element = $info; was = $was; now = $now; changed = ($now -ne $was) }",
  '}',
].join('\n');
const TOGGLE_SCRIPT = buildScript([PS_HEAD, PS_UIA, PS_TARGET, PS_SUGGEST, PS_PAYMENT, TOGGLE_MAIN, PS_TAIL]);

// --- ui_wait --------------------------------------------------------------
// Только чтение: элемент с точным или частичным именем в окне. Окна нет — элемента нет.
const WAIT_MAIN = [
  'function Main {',
  '  $w = Find-JWindow ([string]$env:JARVIS_UI_WINDOW)',
  "  if ($null -eq $w) { $script:R = @{ status = 'no_window' }; return }",
  '  $needle = Cut ([string]$env:JARVIS_UI_NAME) 1000',
  '  $found = $false',
  '  foreach ($e in (Get-JElements $w)) {',
  '    $n = Cut $e.Cached.Name 1000',
  "    if ($n -ne '' -and (Has $n $needle)) { $found = $true; break }",
  '  }',
  "  $script:R = @{ status = 'ok'; found = $found }",
  '}',
].join('\n');
const WAIT_SCRIPT = buildScript([PS_HEAD, PS_UIA, WAIT_MAIN, PS_TAIL]);

const SCRIPTS = {
  ui_windows: WINDOWS_SCRIPT,
  ui_elements: ELEMENTS_SCRIPT,
  ui_click: CLICK_SCRIPT,
  ui_type: TYPE_SCRIPT,
  ui_keys: KEYS_SCRIPT,
  ui_focus: FOCUS_SCRIPT,
  ui_close_window: CLOSE_SCRIPT,
  ui_set_toggle: TOGGLE_SCRIPT,
  ui_wait: WAIT_SCRIPT,
};

// ---------------------------------------------------------------------------
// Чистые помощники (экспортируются для тестов).

// Экранирование текста для SendKeys: спецсимволы берутся в фигурные скобки.
const SENDKEYS_SPECIAL = new Set(['{', '}', '+', '^', '%', '~', '(', ')', '[', ']']);
function escapeSendKeys(text) {
  let out = '';
  for (const ch of String(text)) out += SENDKEYS_SPECIAL.has(ch) ? `{${ch}}` : ch;
  return out;
}

// Белый список клавиш → коды SendKeys. alt+f4 сюда сознательно не входит (см. ui_close_window).
const KEY_MAP = Object.freeze({
  tab: '{TAB}',
  enter: '{ENTER}',
  escape: '{ESC}',
  space: ' ',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  home: '{HOME}',
  end: '{END}',
  'ctrl+a': '^a',
  'ctrl+c': '^c',
  'ctrl+v': '^v',
  'ctrl+z': '^z',
  'ctrl+s': '^s',
  // Новый документ, новая папка в Проводнике, адресная строка. Клавиши Delete здесь нет: удаление только инструментами с вопросом.
  'ctrl+n': '^n',
  'ctrl+shift+n': '^+n',
  'ctrl+shift+s': '^+s',
  'ctrl+t': '^t', // новая вкладка браузера: открытую вкладку владельца не трогаем
  'ctrl+l': '^l',
});

// Заголовок окна с именем файла («привет.txt — Блокнот»): то же правило, что в policy/modes.js для перезаписи.
const SAVED_FILE_TITLE = /\.[a-z0-9]{1,5}(\s|$)/i;

// Те же клавиши как коды виртуальных клавиш: "17,83" — Ctrl+S, сочетания через «;».
const VK_CODES = Object.freeze({ ctrl: 17, shift: 16, tab: 9, enter: 13, escape: 27, space: 32, up: 38, down: 40, left: 37, right: 39, pageup: 33, pagedown: 34, home: 36, end: 35, a: 65, c: 67, v: 86, z: 90, s: 83, n: 78, l: 76, t: 84 });
function keysToVk(tokens) {
  return tokens.map((t) => t.split('+').map((k) => VK_CODES[k]).join(',')).join(';');
}

// Разбор строки клавиш: последовательность через пробел или запятую, например "tab tab enter".
function parseKeys(input) {
  const raw = String(input ?? '');
  if (raw.trim() === '') return { ok: false, error: 'не заданы клавиши' };
  if (raw.length > MAX_KEYS) return { ok: false, error: `строка клавиш длиннее ${MAX_KEYS} символов` };
  const tokens = raw.toLowerCase().replace(/\s*\+\s*/g, '+').split(/[\s,;]+/).filter(Boolean);
  if (tokens.length > MAX_KEY_TOKENS) return { ok: false, error: `не больше ${MAX_KEY_TOKENS} клавиш за раз` };
  let sendkeys = '';
  for (const tok of tokens) {
    if (tok === 'alt+f4') {
      return { ok: false, error: 'alt+f4 не поддерживается: чтобы закрыть окно, используй ui_close_window' };
    }
    if (!Object.prototype.hasOwnProperty.call(KEY_MAP, tok)) {
      return { ok: false, error: `клавиша «${tok.slice(0, 30)}» не из белого списка: ${Object.keys(KEY_MAP).join(', ')}` };
    }
    sendkeys += KEY_MAP[tok];
  }
  return { ok: true, tokens, sendkeys };
}

// JSON из stdout: пустой вывод → null; если перед JSON был мусор — берём последнюю строку.
function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').replace(/^﻿/, '').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last !== text) return JSON.parse(last);
    throw err;
  }
}

// Список окон: пустой вывод → [], объект → одна запись, массив → все.
function parseWindows(stdout) {
  const parsed = parseJsonOutput(stdout);
  if (parsed === null) return [];
  if (!Array.isArray(parsed) && parsed && typeof parsed === 'object' && parsed.status === 'error') {
    const err = new Error(String(parsed.message || 'ошибка UI Automation'));
    err.uiaError = true;
    throw err;
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => {
    if (item === null || typeof item !== 'object') throw new TypeError('элемент не объект');
    return {
      title: String(item.title ?? '').slice(0, MAX_WINDOW),
      process: String(item.process ?? ''),
      handle: Number(item.handle) || 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Проверка аргументов.

function strArg(value, { label, min = 1, max }) {
  const s = value === undefined || value === null ? '' : String(value).trim();
  if (s.length < min) return { error: min > 0 ? `пустое значение: ${label}` : null, value: s };
  if (s.length > max) return { error: `${label} длиннее ${max} символов`, value: s };
  return { error: null, value: s };
}

function windowArg(args) {
  return strArg(args && args.window, { label: 'window (часть заголовка окна)', max: MAX_WINDOW });
}

function intArg(value, { label, min, max, def }) {
  if (value === undefined || value === null || value === '') return { error: null, value: def };
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `${label}: целое число от ${min} до ${max}`, value: def };
  }
  return { error: null, value: n };
}

const fail = (summary, data = {}) => ({ ok: false, summary, data });

function listMatches(matches) {
  return (Array.isArray(matches) ? matches : [])
    .slice(0, 5)
    .map((m, i) => `${i + 1}) «${String((m && m.name) || '')}» (${String((m && m.type) || '?')}${m && m.enabled === false ? ', выключен' : ''})`)
    .join('; ');
}

// Перевод статуса из PowerShell в понятный ответ.
function statusFailure(r, { window, name, occurrence }) {
  const title = r.window ? `«${r.window}»` : `«${window}»`;
  const matches = Array.isArray(r.matches) ? r.matches.slice(0, 5) : [];
  switch (r.status) {
    case 'no_window':
      return fail(`окно с заголовком, содержащим «${window}», не найдено; список окон даёт ui_windows`);
    case 'not_found':
      {
        const hints = Array.isArray(r.suggestions) ? r.suggestions.slice(0, 8) : [];
        const tail = hints.length
          ? ` Похожие: ${hints.map((h) => `«${h}»`).join(', ')}. Повтори ui_click с точным именем из списка.`
          : ' Посмотри элементы через ui_elements.';
        return fail(`элемент «${name}» не найден в окне ${title}.${tail}`, { window: r.window, suggestions: hints });
      }
    case 'ambiguous':
      return fail(
        `в окне ${title} несколько элементов «${name}» (${r.count}); укажи occurrence от 1 до ${r.count}. Первые: ${listMatches(matches)}`,
        { window: r.window, count: r.count, matches }
      );
    case 'out_of_range':
      return fail(
        `occurrence ${occurrence} больше числа совпадений (${r.count}) для «${name}». Первые: ${listMatches(matches)}`,
        { window: r.window, count: r.count, matches }
      );
    case 'disabled':
      return fail(`элемент «${(r.element && r.element.name) || name}» в окне ${title} выключен (недоступен)`, { window: r.window, element: r.element });
    // Подпись самого элемента или его родителей говорит об оплате: нажимать не даём, владелец делает это сам.
    case 'payment':
      return fail('оплату выполняет владелец самостоятельно');
    case 'no_focus':
      return fail(`не удалось сделать окно ${title} активным`, { window: r.window });
    case 'focus_elsewhere':
      return fail(`фокус ввода не внутри окна ${title}; укажи name поля для ввода`, { window: r.window });
    case 'multiline':
      return fail('поле не принимает значение напрямую, а ввод многострочного текста с клавиатуры отправил бы Enter; введи текст без переводов строк', { window: r.window, element: r.element });
    case 'no_toggle':
      return fail(`у элемента «${(r.element && r.element.name) || name}» в окне ${title} нет переключателя; для кнопки используй ui_click`, { window: r.window, element: r.element });
    case 'no_point':
      return fail(`у элемента «${(r.element && r.element.name) || name}» нет точки для клика (скрыт или вне экрана)`, { window: r.window, element: r.element });
    case 'occluded':
      return fail(`элемент «${(r.element && r.element.name) || name}» закрыт другим окном или элементом, клик не выполнен`, { window: r.window, element: r.element });
    case 'self_foreground':
      return fail('активно окно самого Джарвиса; укажи window, куда отправить клавиши');
    case 'protected':
      return fail(`окно ${title} принадлежит оболочке Windows, закрывать его нельзя`, { window: r.window });
    case 'no_handle':
      return fail(`у окна ${title} нет дескриптора, закрыть не получится`, { window: r.window });
    case 'error':
      return fail(`ошибка UI Automation: ${String(r.message || 'неизвестная')}`);
    default:
      return fail('неожиданный ответ PowerShell');
  }
}

// ---------------------------------------------------------------------------
// Проверка результата по данным скрипта. Нет изменений после клика или клавиш — unknown, а не провал: действие могло быть верным.

// Состояние окна не доказывает сохранение или отправку: такие действия подтверждаются отдельно (файлом, ответом сервиса).
const FINAL_ACTION = /отправ|сохран|оплат|купить|опубликов|send|save|submit|publish|\bpay\b|\bbuy\b/i;
const FINAL_KEYS = new Set(['enter', 'ctrl+s']);
const notProven = (seen) => ({ status: 'unknown', evidence: `${seen}, но результат сохранения или отправки так не доказать` });

function takeCheck(result) {
  const data = result && result.data;
  if (!data || !data.check) return null;
  const { check } = data;
  delete data.check; // служебное: в историю модели не идёт
  return check;
}

function windowChange(b, a) {
  if (a.alive === false) return 'окно закрылось';
  if (!a.readable || !b.readable) return null;
  if (a.title !== b.title) return 'изменился заголовок окна';
  if (a.fg !== b.fg) return 'сменилось активное окно';
  if (a.tops !== b.tops) return 'у программы изменилось число окон';
  return null;
}

function clickVerdict(check, { method, name } = {}) {
  if (!check || !check.before || !check.after) return { status: 'unknown', evidence: 'состояние окна не прочитано' };
  const { before: b, after: a, target: tb = {}, targetAfter: ta = {}, noisy } = check;
  const same = tb.found === 'ok' && ta.found === 'ok';
  let seen = null;
  if (same && method === 'select' && ta.selected === false) return { status: 'failed', evidence: 'элемент не стал выбранным' };
  if (same && method === 'toggle' && tb.toggle != null && ta.toggle === tb.toggle) return { status: 'failed', evidence: `состояние переключателя не изменилось: ${ta.toggle}` };
  if (same && tb.toggle !== ta.toggle) seen = `переключатель: ${ta.toggle}`;
  else if (same && method === 'select' && ta.selected === true) seen = 'элемент выбран';
  else if (same && tb.selected !== ta.selected) seen = 'изменился выбор элемента';
  else if (same && tb.expand !== ta.expand) seen = `элемент: ${ta.expand}`;
  else if (same && (tb.name !== ta.name || tb.enabled !== ta.enabled)) seen = 'изменился сам элемент';
  else if (tb.found === 'ok' && ta.found === 'not_found') seen = 'элемент исчез из окна';
  else seen = windowChange(b, a);
  if (!seen && !noisy && a.readable && b.readable && a.count !== b.count) seen = `элементов в окне: было ${b.count}, стало ${a.count}`;
  if (!seen) return { status: 'unknown', evidence: a.readable ? 'нажатие прошло, видимых изменений нет' : 'состояние окна не прочитано' };
  if (FINAL_ACTION.test(String(name || ''))) return notProven(seen);
  return { status: 'confirmed', evidence: seen };
}

function typeVerdict(check, length) {
  if (!check) return { status: 'unknown', evidence: 'значение поля не прочитано' };
  if (check.found && check.found !== 'ok') return { status: 'unknown', evidence: `поле при проверке не определено: ${check.found}` };
  if (!check.known) return { status: 'unknown', evidence: 'значение поля недоступно для чтения' };
  if (check.matches) return { status: 'confirmed', evidence: 'значение поля прочитано, текст на месте' };
  return { status: 'failed', evidence: `в поле другой текст: длина ${check.length}, ожидалось ${length}` };
}

function keysVerdict(check, tokens = []) {
  if (!check || !check.before || !check.after) return { status: 'unknown', evidence: 'состояние окна не прочитано' };
  const { before: b, after: a } = check;
  let seen = null;
  if (a.fg !== b.fg) seen = 'сменилось активное окно';
  else if (a.title !== b.title) seen = 'изменился заголовок окна';
  else if (a.focus !== b.focus) seen = 'сместился фокус';
  else if (a.known && b.known && (a.hash !== b.hash || a.length !== b.length)) seen = 'изменилось значение в фокусе';
  if (!seen) return { status: 'unknown', evidence: 'клавиши отправлены, видимых изменений нет' };
  if (tokens.some((t) => FINAL_KEYS.has(t))) return notProven(seen);
  return { status: 'confirmed', evidence: seen };
}

function focusVerdict(check) {
  if (!check) return { status: 'unknown', evidence: 'активное окно не прочитано' };
  return check.foreground
    ? { status: 'confirmed', evidence: 'окно на переднем плане' }
    : { status: 'failed', evidence: 'окно не удержало передний план' };
}

// ---------------------------------------------------------------------------
// Инструменты.

function uiTools({ runner = runPowerShell, selfPid = process.pid } = {}) {
  const pidEnv = String(selfPid || '');

  // Один вызов PowerShell: постоянный скрипт + значения в env. Возвращает {res} или {result}.
  async function call(tool, env, ctx, extra = {}) {
    const signal = ctx && ctx.signal;
    const fullEnv = {
      JARVIS_UI_WINDOW: '',
      JARVIS_UI_NAME: '',
      JARVIS_UI_OCCURRENCE: '',
      JARVIS_UI_FILTER: '',
      JARVIS_UI_LIMIT: '',
      JARVIS_UI_TEXT: '',
      JARVIS_UI_SENDKEYS: '',
      JARVIS_UI_MULTILINE: '',
      JARVIS_UI_KEYS: '',
      JARVIS_UI_VK: '',
      JARVIS_UI_SAVE_GUARD: '',
      JARVIS_UI_STATE: '',
      ...env,
      JARVIS_UI_SELF_PID: pidEnv,
    };
    const res = await runner(SCRIPTS[tool], fullEnv, { timeoutMs: TIMEOUT_MS, signal });
    if (!res || !res.ok) {
      let summary = (res && res.summary) || 'PowerShell не ответил';
      if (extra.actionTimeoutNote && /таймаут/i.test(summary)) {
        summary += '; действие, возможно, уже выполнено (например, открылось модальное окно) — проверь через ui_elements';
      }
      const stderr = String((res && res.data && res.data.stderr) || '').trim().slice(0, 300);
      const out = fail(summary, stderr ? { stderr } : {});
      // Таймаут не доказывает, что действия не было: исход неизвестен, повторять вслепую нельзя.
      if (extra.actionTimeoutNote && /таймаут/i.test(summary)) return { result: { ...out, verified: 'unknown', evidence: 'истёк срок, исход действия неизвестен' } };
      return { result: out };
    }
    let parsed;
    try {
      parsed = parseJsonOutput(res.data && res.data.stdout);
    } catch {
      return { result: fail('не удалось разобрать ответ PowerShell (возможно, вывод слишком большой)') };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { result: fail('пустой или неожиданный ответ PowerShell') };
    }
    return { parsed };
  }

  const uiWindows = {
    name: 'ui_windows',
    description: 'Список окон верхнего уровня с заголовком: title, process, handle. До 40 окон, заголовок до 120 символов. Начинай с него, чтобы узнать точный заголовок окна.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run(args, ctx) {
      const signal = ctx && ctx.signal;
      const res = await runner(WINDOWS_SCRIPT, { JARVIS_UI_SELF_PID: pidEnv }, { timeoutMs: TIMEOUT_MS, signal });
      if (!res || !res.ok) return fail((res && res.summary) || 'PowerShell не ответил');
      let windows;
      try {
        windows = parseWindows(res.data && res.data.stdout);
      } catch (err) {
        if (err && err.uiaError) return fail(`ошибка UI Automation: ${err.message}`);
        return fail('не удалось разобрать список окон');
      }
      return { ok: true, summary: `окон: ${windows.length}`, data: { windows } };
    },
  };

  const uiElements = {
    name: 'ui_elements',
    description: 'Элементы интерфейса окна (кнопки, поля, пункты меню, ссылки): name, type, enabled, value (до 80 символов), bounds (x, y, w, h в настоящих пикселях). Безымянная кнопка остаётся, если у неё есть координаты. window — часть заголовка окна; filter — часть имени или типа (например Button, Edit); limit 1–60.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
        filter: { type: 'string', maxLength: MAX_FILTER },
        limit: { type: 'integer', minimum: 1, maximum: LIMIT_MAX, default: LIMIT_DEFAULT },
      },
      required: ['window'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const f = strArg(args && args.filter, { label: 'filter', min: 0, max: MAX_FILTER });
      if (f.error) return fail(f.error);
      const l = intArg(args && args.limit, { label: 'limit', min: 1, max: LIMIT_MAX, def: LIMIT_DEFAULT });
      if (l.error) return fail(l.error);
      const { result, parsed } = await call(
        'ui_elements',
        { JARVIS_UI_WINDOW: w.value, JARVIS_UI_FILTER: f.value, JARVIS_UI_LIMIT: String(l.value) },
        ctx
      );
      if (result) return result;
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value });
      const items = (Array.isArray(parsed.items) ? parsed.items : parsed.items ? [parsed.items] : []).map((it) => {
        const item = {
          name: String((it && it.name) ?? ''),
          type: String((it && it.type) ?? ''),
          enabled: Boolean(it && it.enabled),
          value: String((it && it.value) ?? '').slice(0, 80),
        };
        // Координаты нужны сцене для запасного нажатия мышью. Нет валидных — поля нет, чтобы старый вид ответа не ломался.
        const b = it && it.bounds;
        if (b && typeof b === 'object') {
          const bounds = { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) };
          if (Object.values(bounds).every(Number.isFinite) && bounds.w > 0 && bounds.h > 0) item.bounds = bounds;
        }
        return item;
      });
      const total = Number(parsed.total) || items.length;
      const more = total > items.length ? ` (из ${total}; сузь filter)` : '';
      return {
        ok: true,
        summary: `окно «${parsed.window}»: элементов ${items.length}${more}`,
        data: { window: String(parsed.window || ''), total, truncated: Boolean(parsed.truncated), elements: items },
      };
    },
  };

  const uiClick = {
    name: 'ui_click',
    description: 'Нажать элемент окна по имени (точному или части): кнопку, флажок, пункт списка или меню. Сначала через UI Automation (Invoke/Toggle/Select), иначе кликом мыши по центру. Если совпадений несколько — укажи occurrence (номер, с 1).',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
        occurrence: { type: 'integer', minimum: 1, maximum: MAX_OCCURRENCE },
      },
      required: ['window', 'name'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const n = strArg(args && args.name, { label: 'name (имя элемента)', max: MAX_NAME });
      if (n.error) return fail(n.error);
      const o = intArg(args && args.occurrence, { label: 'occurrence', min: 1, max: MAX_OCCURRENCE, def: 0 });
      if (o.error) return fail(o.error);
      const { result, parsed } = await call(
        'ui_click',
        { JARVIS_UI_WINDOW: w.value, JARVIS_UI_NAME: n.value, JARVIS_UI_OCCURRENCE: String(o.value) },
        ctx,
        { actionTimeoutNote: true }
      );
      if (result) return result;
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value, name: n.value, occurrence: o.value });
      const el = parsed.element || {};
      return {
        ok: true,
        summary: `нажато «${el.name || n.value}» (${el.type || '?'}) в окне «${parsed.window}», способ: ${parsed.method}`,
        data: { window: parsed.window, element: el, method: parsed.method, check: parsed.check },
      };
    },
    async verify(args, result) {
      return clickVerdict(takeCheck(result), { method: result.data && result.data.method, name: args && args.name });
    },
  };

  const uiType = {
    name: 'ui_type',
    description: 'Ввести текст в поле окна. name — имя поля (если не задано — текущий фокус в окне). Если поле поддерживает ValuePattern, его содержимое заменяется текстом целиком; иначе текст печатается с клавиатуры в позицию курсора. Enter не нажимается — для этого ui_keys.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
        name: { type: 'string', maxLength: MAX_NAME },
        occurrence: { type: 'integer', minimum: 1, maximum: MAX_OCCURRENCE },
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
      },
      required: ['window', 'text'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const n = strArg(args && args.name, { label: 'name', min: 0, max: MAX_NAME });
      if (n.error) return fail(n.error);
      const o = intArg(args && args.occurrence, { label: 'occurrence', min: 1, max: MAX_OCCURRENCE, def: 0 });
      if (o.error) return fail(o.error);
      const text = args && typeof args.text === 'string' ? args.text : args && args.text != null ? String(args.text) : '';
      if (text.length === 0) return fail('пустой текст');
      // В сохранённой истории набранный текст заменён пометкой журнала: модель не должна печатать саму пометку.
      if (/^\[скрыто, \d+ симв\.\]$/.test(text.trim())) return fail('это пометка журнала «[скрыто, N симв.]», а не текст: возьми текст из просьбы владельца');
      if (text.length > MAX_TEXT) return fail(`текст длиннее ${MAX_TEXT} символов`);
      // Управляющие символы (кроме табуляции и переводов строк) не пропускаем.
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return fail('в тексте есть управляющие символы');
      const multiline = /[\r\n]/.test(text);
      const { result, parsed } = await call(
        'ui_type',
        {
          JARVIS_UI_WINDOW: w.value,
          JARVIS_UI_NAME: n.value,
          JARVIS_UI_OCCURRENCE: String(o.value),
          JARVIS_UI_TEXT: text,
          JARVIS_UI_SENDKEYS: multiline ? '' : escapeSendKeys(text),
          JARVIS_UI_MULTILINE: multiline ? '1' : '0',
        },
        ctx,
        { actionTimeoutNote: true }
      );
      if (result) return result;
      if (parsed.status === 'not_found') {
        return fail(`поля ввода «${n.value}» в окне «${parsed.window || w.value}» нет (кнопки и надписи для ввода не берутся). Если курсор уже стоит в нужном поле (новая папка, окно сохранения), вызови ui_type без name.`);
      }
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value, name: n.value, occurrence: o.value });
      const el = parsed.element || {};
      const how = parsed.method === 'value' ? 'значение поля заменено' : 'напечатано с клавиатуры';
      return {
        ok: true,
        summary: `введено ${text.length} симв. в «${el.name || el.type || 'поле'}» окна «${parsed.window}» (${how})`,
        data: { window: parsed.window, element: el, method: parsed.method, length: text.length, check: parsed.check },
      };
    },
    async verify(args, result) {
      return typeVerdict(takeCheck(result), result.data && result.data.length);
    },
  };

  const uiKeys = {
    name: 'ui_keys',
    description: `Нажать клавиши из белого списка: ${Object.keys(KEY_MAP).join(', ')}. Можно несколько через пробел, например "tab tab enter". window — часть заголовка окна, которое сначала сделать активным (рекомендуется; без него клавиши уйдут в текущее активное окно).`,
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', minLength: 1, maxLength: MAX_KEYS },
        window: { type: 'string', maxLength: MAX_WINDOW },
      },
      required: ['keys'],
    },
    async run(args, ctx) {
      const k = parseKeys(args && args.keys);
      if (!k.ok) return fail(k.error);
      const w = strArg(args && args.window, { label: 'window', min: 0, max: MAX_WINDOW });
      if (w.error) return fail(w.error);
      const { result, parsed } = await call(
        'ui_keys',
        {
          JARVIS_UI_WINDOW: w.value,
          JARVIS_UI_KEYS: k.sendkeys,
          JARVIS_UI_VK: keysToVk(k.tokens),
          // Если имя файла не указано, уточняем окно до сохранения существующего документа.
          JARVIS_UI_SAVE_GUARD: k.tokens.includes('ctrl+s') && !SAVED_FILE_TITLE.test(w.value) ? '1' : '',
        },
        ctx,
        { actionTimeoutNote: true }
      );
      if (result) return result;
      if (parsed.status === 'payment') return fail('оплату выполняет владелец самостоятельно', { window: parsed.window });
      if (parsed.status === 'save_existing') {
        return fail(`в окне «${parsed.window}» открыт уже сохранённый файл: Ctrl+S его перезапишет. Для нового файла — ctrl+n и новая вкладка; для сохранения этого укажи в window имя файла из заголовка.`, { window: parsed.window });
      }
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value });
      const where = parsed.window ? ` в окно «${parsed.window}»` : '';
      return {
        ok: true,
        summary: `нажато: ${k.tokens.join(' ')}${where}`,
        data: { window: parsed.window || '', keys: k.tokens, check: parsed.check },
      };
    },
    async verify(args, result) {
      return keysVerdict(takeCheck(result), result.data && result.data.keys);
    },
  };

  const uiFocus = {
    name: 'ui_focus',
    description: 'Сделать окно активным (на передний план) по части заголовка.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
      },
      required: ['window'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const { result, parsed } = await call('ui_focus', { JARVIS_UI_WINDOW: w.value }, ctx);
      if (result) return result;
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value });
      return { ok: true, summary: `окно «${parsed.window}» активировано`, data: { window: parsed.window, ...(parsed.check ? { check: parsed.check } : {}) } };
    },
    async verify(args, result) {
      return focusVerdict(takeCheck(result));
    },
  };

  const uiCloseWindow = {
    name: 'ui_close_window',
    description: 'Закрыть окно по части заголовка (как крестик: программа может спросить о сохранении). Вместо alt+f4, который бьёт по любому активному окну.',
    risk: 'T2',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
      },
      required: ['window'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const { result, parsed } = await call('ui_close_window', { JARVIS_UI_WINDOW: w.value }, ctx);
      if (result) return result;
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value });
      const closed = Boolean(parsed.closed);
      return {
        ok: true,
        summary: closed
          ? `окно «${parsed.window}» закрыто`
          : `окну «${parsed.window}» отправлена команда закрытия; оно ещё открыто (возможно, спрашивает о сохранении)`,
        data: { window: parsed.window, closed },
      };
    },
    // Скрипт спрашивает у Windows, жив ли дескриптор окна, через секунду после команды закрытия.
    async verify(args, result) {
      return result.data && result.data.closed
        ? { status: 'confirmed', evidence: 'окна больше нет' }
        : { status: 'failed', evidence: 'окно ещё открыто, программа могла спросить о сохранении' };
    },
  };

  const uiSetToggle = {
    name: 'ui_set_toggle',
    description: 'Поставить флажок или переключатель окна в состояние state: "on" или "off". Если он уже в нужном состоянии, ничего не нажимается. Кнопки и пункты меню — через ui_click.',
    risk: 'T1',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
        occurrence: { type: 'integer', minimum: 1, maximum: MAX_OCCURRENCE },
        state: { type: 'string', enum: ['on', 'off'] },
      },
      required: ['window', 'name', 'state'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const n = strArg(args && args.name, { label: 'name (имя элемента)', max: MAX_NAME });
      if (n.error) return fail(n.error);
      const o = intArg(args && args.occurrence, { label: 'occurrence', min: 1, max: MAX_OCCURRENCE, def: 0 });
      if (o.error) return fail(o.error);
      const state = args && args.state;
      if (state !== 'on' && state !== 'off') return fail('state: on или off');
      const { result, parsed } = await call(
        'ui_set_toggle',
        { JARVIS_UI_WINDOW: w.value, JARVIS_UI_NAME: n.value, JARVIS_UI_OCCURRENCE: String(o.value), JARVIS_UI_STATE: state },
        ctx,
        { actionTimeoutNote: true }
      );
      if (result) return result;
      if (parsed.status !== 'ok') return statusFailure(parsed, { window: w.value, name: n.value, occurrence: o.value });
      const el = parsed.element || {};
      const was = String(parsed.was || '').toLowerCase();
      const now = String(parsed.now || '').toLowerCase();
      const label = el.name || n.value;
      return {
        ok: true,
        summary: parsed.changed ? `«${label}» переключён: ${was} → ${now}` : `«${label}» уже ${now}, ничего не нажато`,
        data: { window: parsed.window, element: el, was, now, changed: Boolean(parsed.changed) },
      };
    },
    async verify(args, result) {
      const now = result.data && result.data.now;
      return now === (args && args.state)
        ? { status: 'confirmed', evidence: `переключатель: ${now}` }
        : { status: 'failed', evidence: `переключатель не в состоянии ${args && args.state}: сейчас ${now || 'неизвестно'}` };
    },
  };

  // Ожидание элемента в окне: опрос каждые 250 мс, общий срок timeout_ms. Окна нет — для appear «нет», для gone «элемента нет».
  const uiWait = {
    name: 'ui_wait',
    description: `Ждать, пока в окне появится элемент с именем (until=appear, по умолчанию) или исчезнет (until=gone). window — часть заголовка окна; name — точное или частичное имя элемента. timeout_ms до ${WAIT_MAX_MS}, по умолчанию ${WAIT_DEFAULT_MS}. Только чтение.`,
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', minLength: 1, maxLength: MAX_WINDOW },
        name: { type: 'string', minLength: 1, maxLength: MAX_NAME },
        until: { type: 'string', enum: ['appear', 'gone'], default: 'appear' },
        timeout_ms: { type: 'integer', minimum: 1, maximum: WAIT_MAX_MS },
      },
      required: ['window', 'name'],
    },
    async run(args, ctx) {
      const w = windowArg(args);
      if (w.error) return fail(w.error);
      const n = strArg(args && args.name, { label: 'name (имя элемента)', max: MAX_NAME });
      if (n.error) return fail(n.error);
      const until = args && args.until === undefined ? 'appear' : args && args.until;
      if (until !== 'appear' && until !== 'gone') return fail('until: appear или gone');
      const timeoutMs = args && args.timeout_ms === undefined ? WAIT_DEFAULT_MS : Number(args && args.timeout_ms);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WAIT_MAX_MS) return fail(`timeout_ms от 1 до ${WAIT_MAX_MS}`);
      const signal = ctx && ctx.signal;
      const want = until === 'appear';
      const env = { JARVIS_UI_WINDOW: w.value, JARVIS_UI_NAME: n.value, JARVIS_UI_SELF_PID: pidEnv };

      // Один опрос: true/false — видно ли элемент; null — опрос не удался (это не «нет элемента»).
      async function probe() {
        let res;
        try {
          res = await runner(WAIT_SCRIPT, env, { timeoutMs: WAIT_PROBE_MS, signal });
        } catch {
          return null;
        }
        if (!res || !res.ok) return null;
        let parsed;
        try {
          parsed = parseJsonOutput(res.data && res.data.stdout);
        } catch {
          return null;
        }
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.status === 'no_window') return false;
        if (parsed.status === 'ok' && typeof parsed.found === 'boolean') return parsed.found;
        return null;
      }

      const stopped = { ok: false, summary: 'остановлено', data: { window: w.value, name: n.value, stopped: true } };
      const started = Date.now();
      for (;;) {
        if (signal && signal.aborted) return stopped;
        const seen = await probe();
        if (signal && signal.aborted) return stopped;
        const ms = Date.now() - started;
        if (seen === want) {
          return {
            ok: true,
            summary: want ? `элемент появился за ${ms} мс` : `элемент исчез за ${ms} мс`,
            data: { window: w.value, name: n.value, until, seen, ms },
          };
        }
        const left = timeoutMs - ms;
        if (left <= 0) {
          const summary = seen === null
            ? `опросить не удалось за ${timeoutMs} мс: ${want ? 'появился ли' : 'исчез ли'} элемент, неизвестно`
            : `${want ? 'элемент не появился' : 'элемент не исчез'} за ${timeoutMs} мс`;
          return { ok: false, summary, data: { window: w.value, name: n.value, until, seen, ms } };
        }
        await sleep(Math.min(WAIT_STEP_MS, left), signal);
      }
    },
    // Итог уже получен чтением настоящего состояния.
    async verify() {
      return { status: 'confirmed', evidence: 'условие прочитано' };
    },
  };

  return [uiWindows, uiElements, uiClick, uiType, uiKeys, uiFocus, uiCloseWindow, uiSetToggle, uiWait];
}

module.exports = { uiTools, clickVerdict, typeVerdict, keysVerdict, focusVerdict, escapeSendKeys, parseKeys, keysToVk, parseWindows, parseJsonOutput, KEY_MAP, SCRIPTS };
