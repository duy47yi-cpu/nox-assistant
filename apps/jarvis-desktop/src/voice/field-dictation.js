'use strict';

// Диктовка в поле другой программы. Владелец ставит курсор в поле, вызывает диктовку, говорит,
// видит текст и место вставки, подтверждает — текст печатается в это поле.
// Распознавание — тот же раннер, что у диктовки в чат (src/voice/dictation.js); ввод — те же части
// скриптов и SendKeys, что у ui_type (src/tools/ui.js). Буфер обмена не используется вовсе.
// Здесь только логика сеанса и два скрипта; окно и клавиши — в main.js.
const { PS, PASSWORD_LABEL_RE, escapeSendKeys, parseJsonOutput } = require('../tools/ui');
const { MAX_TEXT } = require('./dictation');

// Поле в фокусе переднего окна: чьё оно и можно ли в него печатать. Только чтение.
const PS_FIELD = [
  'function Get-JField {',
  '  $fg = [JarvisUi.User32]::GetForegroundWindow()',
  "  if ($fg -eq [IntPtr]::Zero) { return @{ status = 'no_window' } }",
  '  $wpid = [uint32]0',
  '  [void][JarvisUi.User32]::GetWindowThreadProcessId($fg, [ref]$wpid)',
  "  if ($selfPid -ne 0 -and [int]$wpid -eq $selfPid) { return @{ status = 'self' } }",
  '  $e = $AE::FocusedElement',
  "  if ($null -eq $e) { return @{ status = 'no_field' } }",
  '  $type = TypeOf $e.Current.ControlType',
  '  $p = $null',
  "  $can = @('Edit', 'Document', 'ComboBox') -contains $type",
  '  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) { $can = -not $p.Current.IsReadOnly }',
  "  if (-not $can) { return @{ status = 'no_field' } }",
  "  $title = ''",
  '  try { $title = Cut ($AE::FromHandle($fg).Current.Name) 120} catch {}',
  "  $app = ''",
  '  try { $app = Cut (Get-Process -Id ([int]$wpid)).MainModule.FileVersionInfo.FileDescription 60 } catch {}',
  "  return @{ status = 'ok'; hwnd = $fg.ToInt64(); rid = ($e.GetRuntimeId() -join '.'); password = [bool]$e.Current.IsPassword; field = (Cut $e.Current.Name 80); title = $title; app = $app }",
  '}',
].join('\n');

const CAPTURE_MAIN = 'function Main { $script:R = Get-JField }';

// Вставка: только если запомненное окно живо и впереди, а в фокусе то же самое поле. Иначе — отказ без ввода.
const INSERT_MAIN = [
  'function Main {',
  '  $h = [IntPtr][int64]$env:NOX_DICT_HWND',
  "  if (-not [JarvisUi.User32]::IsWindow($h)) { $script:R = @{ status = 'window_gone' }; return }",
  '  $fg = [JarvisUi.User32]::GetForegroundWindow()',
  '  if ($fg -ne $h) {',
  '    $fpid = [uint32]0',
  '    [void][JarvisUi.User32]::GetWindowThreadProcessId($fg, [ref]$fpid)',
  // Впереди окно самого Nox (подсказка диктовки забрала фокус): возвращаем его цели. Чужое окно — владелец ушёл сам, не дёргаем.
  "    if ($selfPid -eq 0 -or [int]$fpid -ne $selfPid -or -not (Set-JForeground ($AE::FromHandle($h)))) { $script:R = @{ status = 'focus_moved' }; return }",
  '  }',
  '  $f = Get-JField',
  "  if ($f.status -ne 'ok' -or $f.hwnd -ne $h.ToInt64() -or $f.rid -cne [string]$env:NOX_DICT_RID) { $script:R = @{ status = 'field_changed' }; return }",
  "  if ($f.password) { $script:R = @{ status = 'password' }; return }",
  '  $before = Read-JValue ($AE::FocusedElement)',
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  [System.Windows.Forms.SendKeys]::SendWait([string]$env:NOX_DICT_SENDKEYS)',
  // Проверка результата: значение поля читается заново. Наружу — только «видно / не видно».
  '  $want = Norm ([string]$env:NOX_DICT_TEXT)',
  '  $known = $false; $seen = $false',
  '  for ($i = 0; $i -lt 4 -and -not $seen; $i++) {',
  '    Start-Sleep -Milliseconds 150',
  '    $after = Read-JValue ($AE::FocusedElement)',
  '    $known = [bool]$after.known',
  '    if ($known) { $seen = (Norm $after.value).Contains($want) -and ((-not $before.known) -or ($after.value -cne $before.value)) }',
  '  }',
  "  $script:R = @{ status = 'ok'; known = $known; seen = $seen }",
  '}',
].join('\n');

const CAPTURE_SCRIPT = [PS.HEAD, PS.USER32, PS.UIA, PS_FIELD, CAPTURE_MAIN, PS.TAIL].join('\n');
const INSERT_SCRIPT = [PS.HEAD, PS.USER32, PS.UIA, PS.FOREGROUND, PS.CHECK, PS_FIELD, INSERT_MAIN, PS.TAIL].join('\n');

// Почему диктовка не началась.
const REFUSED = {
  no_window: 'Не вижу активного окна. Поставьте курсор в поле и вызовите диктовку ещё раз.',
  self: 'Это окно Nox. Здесь диктуйте кнопкой микрофона у поля ввода.',
  no_field: 'Курсор не стоит в поле для текста. Щёлкните в поле и вызовите диктовку ещё раз.',
  password: 'Это поле для пароля. В такие поля я не диктую — введите пароль сами.',
  error: 'Не получилось определить поле. Попробуйте ещё раз.',
};

// Почему текст не вставлен. Он остаётся в окне диктовки для копирования.
const KEPT = {
  window_gone: 'Окно, куда шёл текст, закрыто. Текст не вставлен — его можно скопировать.',
  focus_moved: 'Вы перешли в другое окно. Текст не вставлен — его можно скопировать.',
  field_changed: 'Курсор уже не в том поле. Текст не вставлен — его можно скопировать.',
  password: 'Курсор теперь в поле для пароля. Текст не вставлен — его можно скопировать.',
  not_seen: 'Текст отправлен, но в поле он не появился. Он остался здесь — можно скопировать.',
  error: 'Вставить не получилось. Текст остался здесь — можно скопировать.',
};

// Что видит владелец: программа и окно словами.
function targetLabel(raw) {
  const app = String(raw.app || '').trim().replace(/^.*\.exe$/i, ''); // «Notepad.exe» вместо описания — не название для человека
  const title = String(raw.title || '').trim();
  if (app && title) return title.toLowerCase().includes(app.toLowerCase()) ? title : `${app} — ${title}`;
  return title || app || 'окно без названия';
}

// Показывать ли окно-подсказку прямо сейчас. Окно обязано быть видно весь сеанс, но показ нельзя
// вешать на одно событие готовности: у скрытого прозрачного окна оно приходит не всегда, и тогда
// владелец говорит в никуда. Здесь только решение; сам показ — revealDictate в main.js.
function hintNeedsShow(state, visible) {
  const phase = state && state.phase;
  return Boolean(phase && phase !== 'idle' && visible !== true);
}

// run(script, env, opts) — тот же вызов, что у ui_* (живой PowerShell). onChange(снимок) — на каждое изменение.
function createFieldDictation({ run, selfPid = process.pid, onChange = () => {} } = {}) {
  let s = { phase: 'idle', target: '', text: '', message: '', mic: 'off' };
  let target = null; // { hwnd, rid } — наружу не отдаётся
  let seq = 0; // отмена во время чтения окна или вставки: поздний ответ скрипта ничего не меняет

  const state = () => ({ ...s });
  const set = (patch) => { s = { ...s, ...patch }; try { onChange(state()); } catch {} return state(); };

  async function exec(script, env) {
    try {
      const res = await run(script, { JARVIS_UI_SELF_PID: String(selfPid), ...env }, { timeoutMs: 30000 });
      return parseJsonOutput(res && res.data && res.data.stdout) || { status: 'error' };
    } catch {
      return { status: 'error' };
    }
  }

  // Запомнить окно и поле с фокусом. Поле пароля и «не поле» — отказ словами.
  async function start() {
    if (s.phase === 'capturing' || s.phase === 'inserting') return state();
    const my = ++seq;
    target = null;
    set({ phase: 'capturing', target: '', text: '', message: '', mic: 'off' });
    const raw = await exec(CAPTURE_SCRIPT, {});
    if (my !== seq) return state();
    let status = raw.status === 'ok' && raw.hwnd && raw.rid ? 'ok' : (REFUSED[raw.status] ? raw.status : 'error');
    if (status === 'ok' && (raw.password === true || PASSWORD_LABEL_RE.test(String(raw.field || '')))) status = 'password';
    if (status !== 'ok') return set({ phase: 'refused', message: REFUSED[status] });
    target = { hwnd: String(raw.hwnd), rid: String(raw.rid) };
    return set({ phase: 'recording', target: targetLabel(raw) });
  }

  function addText(text) {
    if (s.phase !== 'recording' || typeof text !== 'string' || !text.trim()) return;
    // Переводы строк становятся пробелами: Enter в чужом окне мог бы отправить форму.
    set({ text: `${s.text} ${text}`.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) });
  }

  function setMic(mic, message = '') {
    if (s.phase === 'recording') set({ mic, message });
  }

  // Вставить показанный текст. Цель проверяется заново в том же скрипте, что печатает.
  async function insert() {
    if (s.phase !== 'recording' || !s.text || !target) return state();
    const my = ++seq;
    const text = s.text;
    set({ phase: 'inserting', message: '' });
    const r = await exec(INSERT_SCRIPT, { NOX_DICT_HWND: target.hwnd, NOX_DICT_RID: target.rid, NOX_DICT_TEXT: text, NOX_DICT_SENDKEYS: escapeSendKeys(text) });
    if (my !== seq) return state();
    if (r.status === 'ok' && r.seen === true) return set({ phase: 'done', message: 'Вставлено.' });
    if (r.status === 'ok' && r.known !== true) return set({ phase: 'done', message: 'Текст отправлен в поле. Проверить, что он появился, не удалось.' });
    return set({ phase: 'kept', message: KEPT[r.status === 'ok' ? 'not_seen' : r.status] || KEPT.error });
  }

  function cancel() {
    seq += 1;
    target = null;
    if (s.phase !== 'idle') set({ phase: 'idle', target: '', text: '', message: '', mic: 'off' });
    return state();
  }

  return { state, start, addText, setMic, insert, cancel };
}

module.exports = { createFieldDictation, targetLabel, hintNeedsShow, CAPTURE_SCRIPT, INSERT_SCRIPT, REFUSED, KEPT };