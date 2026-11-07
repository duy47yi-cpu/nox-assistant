'use strict';

// Запуск DeepSeek Harness в режиме headless: один ход, поток событий JSON.
// Сессия harness сохраняется на диск (в ~/.dsh/sessions), поэтому --session-id продолжает разговор.
// Прерывание — снятие дерева процессов: harness запускает инструменты как дочерние процессы.

const { spawn } = require('child_process');

const DEFAULT_EXE = 'C:\\Users\\abdut\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe';
const DEFAULT_CLI = 'C:\\Users\\abdut\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    const child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
  });
}

// Один ход. Возвращает { sessionId, text, error, aborted, exitCode }.
// onEvent(event) получает разобранные строки потока событий; onProgress(text) — короткие вехи.
function runTurn({
  prompt,
  sessionId = null,
  cwd,
  exe = DEFAULT_EXE,
  cli = DEFAULT_CLI,
  permissionMode = 'danger-full-access',
  approvalPolicy = 'never',
  timeoutMs = 30 * 60 * 1000,
  onEvent = () => {},
  onProgress = () => {},
  log = () => {},
} = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('пустая задача');

  const args = ['--expose-internals', cli, 'headless', '--json', '-'];
  if (sessionId) args.splice(3, 0, '--session-id', sessionId);
  args.splice(3, 0, '--approval-policy', approvalPolicy, '--permission-mode', permissionMode);

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.DSH_PROFILE; // профиль выбирается подкомандой headless

  const child = spawn(exe, args, {
    cwd: cwd || process.cwd(),
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  let text = '';
  let foundSession = null;
  let finalText = null;
  let finalReason = null;
  let aborted = false;
  let timer = null;

  const finishText = () => (finalText != null ? finalText : text).trim();

  const handleLine = (line) => {
    const raw = line.trim();
    if (!raw) return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      stderrBuf += raw + '\n';
      return;
    }
    if (event.type === 'session' && event.sessionId) foundSession = event.sessionId;
    if (event.type === 'text' && typeof event.text === 'string') text += event.text;
    if (event.type === 'final') {
      if (event.sessionId) foundSession = event.sessionId;
      if (typeof event.text === 'string') finalText = event.text;
      if (event.reason) finalReason = event.reason;
    }
    if (event.type === 'status') {
      if (event.phase === 'step_start') onProgress(`шаг ${event.step || ''}`.trim());
      if (event.phase === 'turn_end' && event.reason && event.reason.kind && event.reason.kind !== 'completed') {
        finalReason = event.reason;
      }
    }
    try {
      onEvent(event);
    } catch (err) {
      log(`onEvent: ${err.message}`);
    }
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
  });

  child.stdin.end(String(prompt), 'utf8');

  const done = new Promise((resolve) => {
    timer = setTimeout(() => {
      aborted = true;
      log('ход превысил потолок времени — снимаю дерево процессов');
      killTree(child.pid).finally(() => resolve());
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve();
      stderrBuf += `\n${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return {
    pid: child.pid,
    // Прервать ход: снять дерево процессов. onClose получит уже разобранный результат.
    abort() {
      aborted = true;
      return killTree(child.pid);
    },
    async result() {
      const code = await done;
      const errReason = finalReason && finalReason.kind && finalReason.kind !== 'completed' ? finalReason.error : null;
      const error = !aborted && (errReason ? errReason.message || String(errReason) : null)
        || (!aborted && code !== 0 && !foundSession && !finalText ? stderrBuf.trim().slice(-2000) : null)
        || (!aborted && finalReason && finalReason.kind === 'error' ? (finalReason.error && finalReason.error.message) || 'ошибка harness' : null);
      return {
        sessionId: foundSession,
        text: aborted ? '' : finishText(),
        error: error || null,
        aborted,
        exitCode: code,
        stderr: stderrBuf.trim(),
      };
    },
  };
}

module.exports = { runTurn, killTree, DEFAULT_EXE, DEFAULT_CLI };
