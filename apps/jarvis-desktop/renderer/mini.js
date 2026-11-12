(() => {
  'use strict';
  const U = window.JarvisUI;
  const $ = (id) => document.getElementById(id);
  const pending = new Map();
  let visible = !document.hidden;
  let token = null;
  let current = null;
  let approvalGate = false;
  let sequence = 0;
  let reply = '';
  let failedAction = '';
  let recording = false;
  let target = '';
  let running = false;
  let core = null;
  const tracker = new U.StatusTracker(render);

  function render() {
    if (core) core.setState(tracker.state === 'acting' ? 'thinking' : tracker.state);
    $('miniStop').hidden = !running;
    if (running) $('quickWork').hidden = false;
    const last = tracker.last;
    const action = last && last.status === 'running' ? U.toolTitle(last.tool) : '';
    $('quickStatus').textContent = action ? [action, target].filter(Boolean).join(' · ') : (tracker.note || tracker.phrase);
  }
  function focusInput() { $('quickInput').focus(); }
  async function showApproval() {
    if (pending.size === 0) approvalGate = false;
    const next = pending.values().next().value;
    current = approvalGate ? null : (next || null);
    token = null;
    const seq = ++sequence;
    $('miniApproval').hidden = !next;
    $('approvalAllow').disabled = true;
    $('approvalError').textContent = '';
    if (!next) return;
    $('approvalNext').hidden = !approvalGate;
    $('approvalAction').hidden = approvalGate;
    $('approvalReason').hidden = approvalGate;
    $('approvalArgs').hidden = approvalGate;
    $('approvalReject').parentElement.hidden = approvalGate;
    $('approvalTitle').textContent = approvalGate ? 'Запрос завершён. Есть ещё один запрос.' : 'Нужно ваше разрешение';
    if (approvalGate) { $('approvalTime').textContent = ''; return; }
    $('approvalAction').textContent = U.toolTitle(next.name);
    const reason = String(next.reason || '');
    $('approvalReason').textContent = /^режим\s*[«"]?(?:ask|auto|full)[»"]?;\s*риск\s*T[0-3]$/i.test(reason)
      ? 'Перед действием нужно ваше согласие.' : U.scrub(reason);
    $('approvalArgs').textContent = U.argsPretty(next.args);
    countdown();
    if (!visible || document.hidden) return;
    $('miniApproval').scrollIntoView({ block: 'nearest' });
    try {
      const result = await U.call('markApprovalShown', next.id);
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (seq === sequence && visible && !document.hidden && result && result.ok && result.token) {
        token = result.token;
        $('approvalAllow').disabled = false;
      }
    } catch { $('approvalError').textContent = 'Не удалось показать запрос ядру.'; }
  }
  function countdown() {
    $('approvalTime').textContent = current && current.autoCancelAt ? `Отмена через ${Math.max(0, Math.ceil((current.autoCancelAt - Date.now()) / 1000))} с` : '';
  }
  async function syncApprovals() {
    try {
      const items = await U.call('listApprovals');
      pending.clear();
      if (Array.isArray(items)) for (const item of items) pending.set(item.id, item);
      await showApproval();
    } catch { /* ядро отменит запрос по таймеру */ }
  }
  async function answer(decision) {
    const item = current;
    if (!item || (decision === 'once' && !token)) return;
    $('approvalAllow').disabled = true;
    $('approvalReject').disabled = true;
    try {
      const result = await U.call('respondApproval', item.id, decision, token);
      if (!result || !result.ok) $('approvalError').textContent = (result && result.reason) || 'Не удалось передать решение';
      else { pending.delete(item.id); await showApproval(); }
    } catch { $('approvalError').textContent = 'Не удалось передать решение'; }
    $('approvalReject').disabled = false;
  }
  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'status') {
      if (typeof ev.step === 'number') $('quickStep').textContent = `Шаг ${ev.step}`;
      if (typeof ev.target === 'string') target = U.scrub(ev.target);
      if (ev.state === 'thinking' && !running) { reply = ''; failedAction = ''; target = ''; $('quickReply').textContent = ''; $('quickWork').hidden = false; }
      if (ev.state === 'idle') running = false;
      else if (ev.state) running = true;
    }
    if (ev.type === 'tool_start' || ev.type === 'approval_request') running = true;
    if (ev.type === 'approval_request' && ev.id) { pending.set(ev.id, ev); showApproval(); }
    if (ev.type === 'approval_closed') {
      const closedId = ev.approvalId || ev.id;
      const wasCurrent = current && current.id === closedId;
      pending.delete(closedId);
      if (wasCurrent && pending.size) approvalGate = true;
      showApproval();
    }
    if (ev.type === 'text') { reply += ev.delta || ''; $('quickReply').textContent = U.humanize(reply); }
    if (ev.type === 'tool_result' && (ev.ok === false || ev.verifiedStatus === 'failed' || ev.verifiedStatus === 'unverified')) failedAction = U.cleanSummary(ev.summary) || 'результат действия не подтверждён';
    if (ev.type === 'error') { $('quickReply').textContent = `Не получилось: ${U.scrub(ev.message || '')}`; $('quickWork').hidden = false; }
    if (ev.type === 'done') {
      running = false;
      if (ev.cancelled === true || ev.status === 'cancelled') $('quickReply').textContent = 'Остановлено';
      else if (ev.status === 'failed') $('quickReply').textContent = `Не получилось: ${failedAction || 'ход не завершён'}`;
      else if (ev.status === 'unverified') $('quickReply').textContent = `Результат не подтверждён: ${failedAction || 'проверка не выполнена'}`;
      else if (ev.status === 'succeeded' && ev.verification && ev.verification.confirmed > 0) $('quickReply').textContent = `Проверено действий: ${ev.verification.confirmed}. ${U.humanize(reply)}`.trim();
      if (pending.size) { approvalGate = true; syncApprovals(); }
    }
    tracker.handle(ev);
  }
  async function boot() {
    await U.ensureBridge();
    if (typeof window.NoxOrb === 'function') {
      core = new window.NoxOrb($('quickCore'), { variant: 'nox' });
      try { core.setAnimated(JSON.parse(localStorage.getItem('jarvis.orbAnim') ?? 'true') !== false); } catch { /* недоступно хранилище */ }
    }
    if (U.has('resizeQuick')) {
      let queued = false;
      const resize = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; U.call('resizeQuick', document.querySelector('.quick').scrollHeight + 24); });
      };
      new ResizeObserver(resize).observe(document.querySelector('.quick'));
      new MutationObserver(resize).observe(document.querySelector('.quick'), { attributes: true, childList: true, characterData: true, subtree: true });
      resize();
    }
    window.jarvis.onEvent(onEvent);
    if (U.has('onQuickShown')) window.jarvis.onQuickShown(() => { visible = true; focusInput(); syncApprovals(); });
    document.addEventListener('visibilitychange', () => { visible = !document.hidden; if (!visible) { token = null; sequence++; $('approvalAllow').disabled = true; } else syncApprovals(); });
    window.addEventListener('blur', () => { token = null; sequence++; $('approvalAllow').disabled = true; });
    window.addEventListener('focus', () => { if (visible) syncApprovals(); });
    $('miniHide').addEventListener('click', () => U.call('closeMini'));
    $('miniExpand').addEventListener('click', () => U.call('showMain'));
    $('miniStop').addEventListener('click', () => U.call('stop'));
    $('approvalNext').addEventListener('click', () => { approvalGate = false; showApproval(); });
    for (const [id, decision] of [['approvalReject', 'reject'], ['approvalAllow', 'once']]) {
      const button = $(id);
      let press = null;
      button.addEventListener('pointerdown', (event) => { press = event.isTrusted && current && !button.disabled ? sequence : null; });
      button.addEventListener('keydown', (event) => { if (event.isTrusted && !event.repeat && (event.key === 'Enter' || event.key === ' ')) press = current && !button.disabled ? sequence : null; });
      button.addEventListener('click', (event) => {
        if (!event.isTrusted || !current || (press !== sequence && !(press === null && event.detail === 0))) { press = null; return; }
        press = null;
        answer(decision);
      });
    }
    $('quickForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = $('quickInput').value.trim();
      if (!text || running) return;
      $('quickError').textContent = '';
      const result = await U.call('send', text, []).catch((err) => ({ ok: false, error: err.message }));
      if (result && result.ok === false) { $('quickError').textContent = result.error || 'Не удалось отправить'; return; }
      $('quickInput').value = '';
    });
    $('quickInput').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('quickForm').requestSubmit(); } });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); if (running) U.call('stop'); U.call('closeMini'); } });
    $('quickMic').addEventListener('click', async () => {
      const result = await U.call(recording ? 'dictationStop' : 'dictationStart');
      if (result && result.ok === false) $('quickError').textContent = 'Включите диктовку в настройках';
    });
    if (U.has('onDictationEvent')) window.jarvis.onDictationEvent((ev) => {
      if (ev.type === 'state') { recording = ev.state === 'listening'; $('quickMic').textContent = recording ? 'Остановить запись' : 'Микрофон'; }
      if (ev.type === 'text' && ev.text) { $('quickInput').value += ($('quickInput').value ? ' ' : '') + ev.text; focusInput(); }
      if (ev.type === 'error') $('quickError').textContent = ev.message || 'Диктовка не удалась';
    });
    setInterval(countdown, 1000);
    if (visible) { focusInput(); syncApprovals(); }
  }
  boot().catch((err) => { $('quickError').textContent = err.message; });
})();
