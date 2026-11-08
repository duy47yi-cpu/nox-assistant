'use strict';

// Один рабочий стол на всех: руки чата, команд и задач идут строго по одному.
// Владелец важнее фона: пока он за компьютером, фоновая задача окна не трогает. На заблокированном экране рук нет ни у кого.
// desktop_click/desktop_type — составные руки (нажатие и ввод по id): они вызывают ui_click/ui_type
// напрямую, поэтому замок и Esc нужны на них самих, иначе новая пара обходила бы очередь рук.
const DESKTOP_TOOLS = new Set(['ui_click', 'ui_type', 'ui_keys', 'ui_focus', 'ui_set_toggle', 'ui_close_window', 'app_open', 'app_close', 'url_open', 'windows_focus', 'windows_close_all', 'window_close_active', 'windows_minimize_all', 'windows_restore_all', 'monitor_off', 'mouse_click', 'mouse_scroll', 'desktop_click', 'desktop_type']);
// Открыть ссылку или программу не трогает ни мышь, ни клавиатуру владельца: такие действия не ждут паузы в его вводе.
const OWNER_FREE_TOOLS = new Set(['url_open', 'app_open']);
// shortcut: shell_run и library_run замком не закрыты, что они делают с окнами, из кода не видно; закрыть, если начнут мешать рукам.
const BLOCKED_DESKTOP = 'blocked_desktop';
const OWNER_IDLE_SECONDS = 120;

const blocked = (why) => ({ ok: false, summary: `${BLOCKED_DESKTOP}: ${why}`, data: { state: BLOCKED_DESKTOP } });

// Владелец печатает или двигает мышь (вне окна Nox): руки ждут короткой паузы и действуют, без сообщений и отказов.
// Больше OWNER_WAIT_MS не ждём: владелец сам остановит руки кнопкой «Стоп» или Esc.
const QUIET_MS = 1500;
const OWNER_WAIT_MS = 2500;
const OWNER_POLL_MS = 150;

class DesktopLock {
  // inputAgoMs() — сколько мс назад был последний ввод с клавиатуры или мыши (null — неизвестно или ввод в окне Nox).
  constructor({ idleSeconds = () => Infinity, ownerIdleSeconds = OWNER_IDLE_SECONDS, inputAgoMs = null, quietMs = QUIET_MS, ownerWaitMs = OWNER_WAIT_MS, pollMs = OWNER_POLL_MS, now = Date.now } = {}) {
    this.idleSeconds = idleSeconds;
    this.ownerIdleSeconds = ownerIdleSeconds;
    this.inputAgoMs = inputAgoMs;
    this.quietMs = quietMs;
    this.ownerWaitMs = ownerWaitMs;
    this.pollMs = pollMs;
    this.now = now;
    this.lastOwnEnd = 0; // конец последнего действия рук: ввод раньше этого — наш собственный
    this.locked = false; // экран заблокирован
    this.busy = false;
    this.queue = [];
  }

  // Ввод владельца: был недавно и уже после нашего последнего действия (наши нажатия Windows тоже считает вводом).
  // shortcut: ввод владельца во время нашего же шага не отличить от нашего; станет нужно — сверять LLKHF_INJECTED хуком.
  async _ownerActive() {
    if (typeof this.inputAgoMs !== 'function') return false;
    let ago;
    try { ago = await this.inputAgoMs(); } catch { return false; }
    if (!Number.isFinite(ago)) return false;
    return ago < this.quietMs && this.now() - ago > this.lastOwnEnd + 100;
  }

  // Ждём короткой паузы в вводе владельца, но не дольше ownerWaitMs. false — только если ход остановлен.
  async _waitOwner(signal) {
    const start = this.now();
    while (await this._ownerActive()) {
      if (signal && signal.aborted) return false;
      if (this.now() - start >= this.ownerWaitMs) return true;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    return !(signal && signal.aborted);
  }

  setLocked(value) {
    this.locked = Boolean(value);
  }

  // Причина, по которой действие сейчас нельзя начать, или null.
  _refusal(background) {
    if (this.locked) return 'экран заблокирован';
    if (!background) return null;
    if (this.busy) return 'рабочий стол занят другим действием';
    if (this.idleSeconds() < this.ownerIdleSeconds) return 'владелец работает за компьютером';
    return null;
  }

  // Очередь без срока не держит: стоп снимает ожидание.
  _acquire(signal) {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const entry = { grant: () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(true); } };
      const onAbort = () => {
        this.queue.splice(this.queue.indexOf(entry), 1);
        resolve(false);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  _release() {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.busy = false;
  }

  async run(fn, { background = false, signal, ownerFree = false } = {}) {
    if (signal && signal.aborted) return { ok: false, summary: 'остановлено', data: { stopped: true } };
    const refusal = this._refusal(background);
    if (refusal) return blocked(refusal);
    if (!(await this._acquire(signal))) return { ok: false, summary: 'остановлено', data: { stopped: true } };
    try {
      // Пока стояли в очереди, ход могли остановить — это касается и фоновой задачи.
      if (signal && signal.aborted) return { ok: false, summary: 'остановлено', data: { stopped: true } };
      // Пока стояли в очереди, экран могли заблокировать.
      if (this.locked) return blocked('экран заблокирован');
      if (!background && !ownerFree && typeof this.inputAgoMs === 'function') {
        await this._waitOwner(signal);
        if (signal && signal.aborted) return { ok: false, summary: 'остановлено', data: { stopped: true } };
      }
      return await fn();
    } finally {
      this.lastOwnEnd = this.now();
      this._release();
    }
  }
}

// Замок ставится на сам инструмент, поэтому его не обойти ни чатом, ни командой, ни задачей.
// verify остаётся снаружи: долгий опрос окна не должен держать стол.
// lock.onAction(name, args, ctx) — необязательный хук перед действием (Esc-стоп), возвращает «после» или null.
function guardDesktopTools(list, lock) {
  return list.map((tool) => (DESKTOP_TOOLS.has(tool.name)
    ? {
      ...tool,
      run: async (args, ctx = {}) => {
        const after = typeof lock.onAction === 'function' ? lock.onAction(tool.name, args, ctx) : null;
        try {
          return await lock.run(() => tool.run(args, ctx), { ...ctx, ownerFree: OWNER_FREE_TOOLS.has(tool.name) });
        } finally {
          if (typeof after === 'function') after();
        }
      },
    }
    : tool));
}

// Сколько мс назад был последний ввод (GetLastInputInfo) и PID окна на переднем плане. Постоянный текст, значений извне нет.
// Тип создаётся один раз: живой PowerShell держит его до конца сессии.
const INPUT_AGO_SCRIPT = [
  "if (-not ('JarvisIdle.U' -as [type])) { Add-Type -Namespace JarvisIdle -Name U -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; } [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LII p); [DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);' }",
  '$l = New-Object JarvisIdle.U+LII',
  '$l.cbSize = 8',
  "if (-not [JarvisIdle.U]::GetLastInputInfo([ref]$l)) { 'none'; return }",
  '$now = [int64][Environment]::TickCount -band 0xFFFFFFFF',
  '$ago = $now - [int64]$l.dwTime',
  'if ($ago -lt 0) { $ago += 4294967296 }',
  '$fg = [JarvisIdle.U]::GetForegroundWindow()',
  '$fgpid = [uint32]0',
  '[void][JarvisIdle.U]::GetWindowThreadProcessId($fg, [ref]$fgpid)',
  '"$ago;$fgpid"',
].join('\n');

// ownPid — PID самого Nox: если он на переднем плане, ввод идёт в чат, а не в чужие окна, и руки его не ждут.
function inputAgoVia(runner, ownPid = null) {
  return async () => {
    const res = await runner(INPUT_AGO_SCRIPT, {}, { timeoutMs: 3000 });
    const out = String((res && res.ok && res.data && res.data.stdout) || '').trim();
    if (!res || !res.ok || out === '') return null;
    const [agoText, pidText] = out.split(';');
    const ago = Number(agoText);
    if (!Number.isFinite(ago)) return null;
    if (ownPid && Number(pidText) === ownPid) return null;
    return ago;
  };
}

module.exports = { DesktopLock, guardDesktopTools, inputAgoVia, INPUT_AGO_SCRIPT, DESKTOP_TOOLS, OWNER_FREE_TOOLS, BLOCKED_DESKTOP };
