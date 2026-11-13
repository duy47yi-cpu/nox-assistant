/* Nox — первый экран: история чатов, сфера, оболочка окна.
 * Тонкий слой поверх прежнего приложения: беседа и поле ввода переезжают сюда
 * из классического экрана (их логика остаётся в app.js), данные — из того же моста.
 * Вариант сферы переключается только для разработки: window.NoxScreen.setVariant,
 * localStorage 'noxOrb' или #orb=wire; в обычном интерфейсе переключателя нет. */
(() => {
  'use strict';

  const WORK_LABELS = {
    planning: 'Планирование',
    thinking: 'Обдумывает следующий шаг',
    running: 'Выполняется',
    awaiting_approval: 'Ждёт подтверждения',
    verifying: 'Проверка результата',
    answering: 'Готовит ответ',
    succeeded: 'Ход завершён',
    unverified: 'Результат не подтверждён',
    incomplete: 'План не завершён',
    failed: 'Не получилось',
    cancelled: 'Остановлено',
    needs_human: 'Нужно ваше участие',
  };
  const PLAN_CALLS = new Set(['plan_set', 'plan_done', 'turn_stop']);
  const workText = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

  function createWork(runId) {
    return { runId, phase: 'planning', closed: false, steps: [], summary: null, calls: new Map(), evidence: null, issue: '', unverified: false };
  }

  function workPhase(ev) {
    if (ev.status === 'awaiting_approval' || ev.state === 'waiting_approval') return 'awaiting_approval';
    if (ev.status === 'verifying' || ev.state === 'verifying') return 'verifying';
    if (ev.status === 'planning' || ev.state === 'planning') return 'planning';
    if (ev.state === 'thinking') return 'thinking';
    if (ev.status === 'running' || ev.state === 'acting' || ev.state === 'searching') return 'running';
    return null;
  }

  function currentWorkCall(work) {
    const calls = [...work.calls.values()].filter((call) => !PLAN_CALLS.has(call.name));
    return calls.findLast((call) => call.phase === 'awaiting_approval') || calls.at(-1);
  }

  // План — заявленный порядок, а не доказательство. Результат связываем с
  // начатым вызовом, а plan_done отмечает шаг, но не подтверждает эффект.
  function updateWork(work, ev) {
    if (work.closed || ev.afterStop || ev.taskId || (work.runId && ev.runId && work.runId !== ev.runId)) return false;
    if (!work.runId && ev.runId) work.runId = ev.runId;
    switch (ev.type) {
      case 'status': {
        const phase = workPhase(ev);
        if (!phase) return false;
        const call = [...work.calls.values()].find((entry) => entry.step != null && entry.step === ev.step);
        if (call && !PLAN_CALLS.has(call.name) && phase !== 'thinking') call.phase = phase;
        work.phase = phase;
        return true;
      }
      case 'tool_start': {
        const plan = PLAN_CALLS.has(ev.name);
        work.calls.set(ev.id ?? ev.step, {
          name: ev.name, step: ev.step, phase: 'running',
          target: ev.target,
          ...(plan ? { steps: ev.args?.steps, index: ev.args?.step } : {}),
        });
        if (!plan) work.phase = 'running';
        return !plan;
      }
      case 'approval_request': {
        const call = work.calls.get(ev.id ?? ev.step);
        if (call) call.phase = 'awaiting_approval';
        work.phase = 'awaiting_approval';
        return true;
      }
      case 'tool_result': {
        const key = ev.id ?? ev.step;
        const call = work.calls.get(key);
        if (!call) return false;
        work.calls.delete(key);
        if (ev.ok === true && (!ev.status || ev.status === 'succeeded')) {
          if (call.name === 'plan_set' && Array.isArray(call.steps)) {
            work.steps = call.steps.slice(0, 20).map((text) => ({ text: workText(text), done: false })).filter((step) => step.text);
          }
          if (call.name === 'plan_done' && Number.isInteger(call.index) && work.steps[call.index - 1]) {
            work.steps[call.index - 1].done = true;
          }
          const proof = workText(ev.evidence);
          if (!PLAN_CALLS.has(call.name) && ev.verified === 'confirmed' && proof) {
            work.evidence = { name: call.name, text: proof };
          }
        }
        const unverified = ev.status === 'unverified' || ev.verified === 'unknown';
        if (unverified) work.unverified = true;
        if (ev.ok === false || ev.status === 'failed' || unverified) work.issue = workText(ev.summary);
        if (!currentWorkCall(work)) work.phase = 'thinking';
        return true;
      }
      case 'text':
        if (work.phase === 'answering' || !ev.delta) return false;
        work.phase = 'answering';
        return true;
      case 'error':
        work.issue = workText(ev.message) || work.issue;
        work.phase = 'failed';
        break;
      case 'done':
        if (Number.isInteger(ev.plan?.total) && ev.plan.total > 0
            && Number.isInteger(ev.plan.done) && ev.plan.done >= 0 && ev.plan.done <= ev.plan.total) {
          work.summary = { done: ev.plan.done, total: ev.plan.total };
        }
        if (ev.cancelled || ev.status === 'cancelled') work.phase = 'cancelled';
        else if (ev.outcome === 'needs_human') work.phase = 'needs_human';
        else if (ev.status === 'failed') work.phase = 'failed';
        else if (ev.status !== 'succeeded' || work.unverified) work.phase = 'unverified';
        else if (work.summary ? work.summary.done < work.summary.total : work.steps.some((step) => !step.done)) work.phase = 'incomplete';
        else work.phase = 'succeeded';
        break;
      default:
        return false;
    }
    work.closed = true;
    work.calls.clear();
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createWork, updateWork, currentWorkCall };
    return;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const api = () => window.jarvis || null;
  const app = () => window.JarvisNox || null;

  const S = {
    variant: 'nox',
    orb: null,
    orbState: 'idle',
    composerFocus: false,
    work: null,
    workOwner: null,
    chatCount: 1,
    historySeq: 0,
  };

  let refs = null;

  // ── Разметка панелей ───────────────────────────────────────────
  function cacheRefs() {
    refs = {
      body: document.body,
      grid: $('.nox-grid'),
      history: $('#noxHistory'),
      histSections: $('#noxHistSections'),
      histEmpty: $('#noxHistEmpty'),
      wsSlot: $('#noxWsSlot'),
      chat: $('#noxChat'),
      chatMount: $('#noxChatMount'),
      composerSlot: $('#noxComposerSlot'),
      sphere: $('#noxSphere'),
      orbStage: $('#noxOrbStage'),
      orbCanvas: $('#noxOrb'),
      convo: $('.view-dialog .convo'),
      dock: $('.view-dialog .stage-dock'),
      dialog: $('.view-dialog'),
      stage: $('#stage'),
      feed: $('#feed'),
      feedList: $('#feedList'),
      chatInput: $('#chatInput'),
      composer: $('#composer'),
      chatTabsList: $('#chatTabsList'),
      workspaceSwitch: $('#workspaceSwitch'),
    };
  }

  // ── Шапка истории и список чатов ───────────────────────────────
  function chatRows(data) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    const groups = { today: [], earlier: [] };
    for (const chat of data.chats) {
      const at = Number(chat.updatedAt) || 0;
      (at >= todayStart ? groups.today : groups.earlier).push(chat);
    }
    const frag = document.createDocumentFragment();
    const addGroup = (title, chats) => {
      if (!chats.length) return;
      frag.append(el('div', 'nox-hist-label', title));
      for (const chat of chats) frag.append(chatRow(chat, chat.id === data.activeId));
    };
    addGroup('Сегодня', groups.today);
    addGroup('Ранее', groups.earlier);
    return frag;
  }

  function chatRow(chat, active) {
    const row = el('div', 'nox-hist-item');
    row.dataset.chatId = chat.id;
    if (active) row.dataset.active = 'true';
    const open = el('button', 'nox-hist-open');
    open.type = 'button';
    open.textContent = chat.title || 'Новый чат';
    open.title = chat.title || 'Новый чат';
    if (active) open.setAttribute('aria-current', 'true');
    open.addEventListener('click', () => selectChat(chat.id, row));
    const more = el('button', 'nox-hist-more', '…');
    more.type = 'button';
    more.title = 'Закрыть чат';
    more.setAttribute('aria-label', `Закрыть чат «${chat.title || 'Новый чат'}»`);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      closeChat(chat);
    });
    row.append(open, more);
    return row;
  }

  async function refreshHistory() {
    const bridge = api();
    if (!bridge || typeof bridge.chatList !== 'function') return;
    const seq = ++S.historySeq;
    let data = null;
    try { data = await bridge.chatList(); } catch { return; }
    if (seq !== S.historySeq || !data || !Array.isArray(data.chats)) return;
    S.chatCount = data.chats.length;
    refs.histSections.replaceChildren(chatRows(data));
    refs.histEmpty.hidden = data.chats.length > 0;
    syncEmpty();
  }

  function selectChat(id, row) {
    if (row && row.dataset.active === 'true') return;
    const nav = app();
    if (nav && typeof nav.changeChat === 'function') {
      nav.changeChat('chatSelect', id);
      return;
    }
    // Запасной путь для старой сборки: нажать ту же вкладку чата.
    const index = [...(refs.histSections?.querySelectorAll('.nox-hist-item') || [])].indexOf(row);
    const tabs = $$('#chatTabsList .chat-tab-name');
    if (tabs[index]) tabs[index].click();
  }

  function closeChat(chat) {
    const nav = app();
    if (nav && typeof nav.closeChat === 'function') { nav.closeChat(chat); return; }
    const tabs = $$('#chatTabsList .chat-tab');
    const row = refs.histSections?.querySelector(`.nox-hist-item[data-chat-id="${chat.id}"]`);
    const index = row ? [...refs.histSections.querySelectorAll('.nox-hist-item')].indexOf(row) : -1;
    const x = index >= 0 ? tabs[index]?.querySelector('.chat-tab-x') : null;
    if (x) x.click();
  }

  function newChat() {
    const nav = app();
    if (nav && typeof nav.changeChat === 'function') { nav.changeChat('chatNew'); return; }
    $('#chatNew')?.click();
  }

  // ── Пустое состояние: история скрыта, в шапке чата знак NOX ─────
  function syncEmpty() {
    if (!refs || !refs.grid) return;
    const empty = refs.feedList.childElementCount === 0 && S.chatCount <= 1;
    refs.grid.classList.toggle('is-empty', empty);
  }

  // Открытие экрана показывает конец разговора, как обычный мессенджер.
  function scrollToBottom() {
    const run = () => {
      const feed = refs && refs.feed;
      if (!feed) return;
      feed.scrollTop = feed.scrollHeight;
    };
    requestAnimationFrame(run);
    setTimeout(run, 60);
  }

  // ── Кнопка «Скопировать ответ» под ответом ассистента ─────────
  // Настоящее копирование текста конкретного ответа в буфер обмена (без фейковой иконки).
  const COPY_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.4"/><path d="M5.5 15V6.5a2 2 0 0 1 2-2H15"/></svg>';
  const CHECK_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function legacyCopy(value) {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  // Возвращает promise<boolean>: скопировалось или нет (это проверяется в тесте).
  function copyText(text) {
    const value = String(text || '');
    if (!value) return Promise.resolve(false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => legacyCopy(value));
    }
    return Promise.resolve(legacyCopy(value));
  }

  function answerText(turn) {
    const md = turn.querySelector('.md');
    if (!md) return '';
    const raw = (md.innerText || md.textContent || '').replace(/\u00a0/g, ' ');
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  function flashCopy(btn, ok) {
    btn.dataset.copied = ok ? 'true' : 'false';
    const label = ok ? 'Скопировано' : 'Не удалось скопировать';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = ok ? CHECK_GLYPH : COPY_GLYPH;
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      delete btn.dataset.copied;
      btn.setAttribute('aria-label', 'Скопировать ответ');
      btn.title = 'Скопировать ответ';
      btn.innerHTML = COPY_GLYPH;
    }, 1400);
  }

  function ensureCopyButtons() {
    if (!refs || !refs.feedList) return;
    // Кнопка добавляет ~28 px под ответ. Если лента была прижата к низу (или это первая
    // отрисовка истории), после добавления ленту надо снова прижать, иначе ответ уезжает
    // вверх и автопрокрутка «Готово» врёт. Если пользователь читает выше — не трогаем.
    const feed = refs.feed;
    const pinned = feed ? feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48 : false;
    let added = 0;
    for (const turn of refs.feedList.querySelectorAll('.turn')) {
      const md = turn.querySelector('.md');
      if (!md) continue;
      let btn = turn.querySelector(':scope > .nox-copy');
      if (!btn) {
        btn = el('button', 'nox-copy');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Скопировать ответ');
        btn.title = 'Скопировать ответ';
        btn.innerHTML = COPY_GLYPH;
        md.after(btn);
        btn.addEventListener('click', () => {
          copyText(answerText(turn)).then((ok) => flashCopy(btn, ok));
        });
        added += 1;
      }
    }
    if (added && pinned && feed) feed.scrollTop = feed.scrollHeight;
  }

  // ── Ход работы закреплён над лентой и не меняет её прокрутку ──────
  function initWork() {
    const row = el('section', 'nox-working');
    row.setAttribute('aria-labelledby', 'noxWorkTitle');
    const head = el('div', 'nox-work-head');
    const title = el('h2', '', 'Ход работы');
    title.id = 'noxWorkTitle';
    const count = el('span', 'nox-work-count');
    const more = el('button', 'nox-work-button', 'Подробнее');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'dialog');
    head.append(title, count, more);
    const status = el('div', 'nox-work-status');
    status.setAttribute('role', 'status');
    const plan = el('ol', 'nox-work-plan');
    plan.setAttribute('aria-label', 'План задачи');
    const note = el('p', 'nox-work-note');
    const proof = el('p', 'nox-work-proof');
    const dialog = el('dialog', 'nox-work-dialog');
    const dialogTitle = el('h2', '', 'Ход работы');
    dialogTitle.id = 'noxWorkDialogTitle';
    dialog.setAttribute('aria-labelledby', dialogTitle.id);
    const details = el('div', 'nox-work-details');
    const close = el('button', 'nox-work-button', 'Закрыть');
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    more.addEventListener('click', () => { renderWorkDetails(); dialog.showModal(); });
    dialog.append(dialogTitle, details, close);
    row.append(head, status, plan, note, proof, dialog);
    row.hidden = true;
    refs.chatMount.prepend(row);
    refs.work = { row, status, count, more, plan, note, proof, dialog, details };
  }

  const cleanWork = (text) => window.JarvisUI?.cleanSummary(text) ?? workText(text);
  const workTool = (name) => window.JarvisUI?.toolTitle(name) || 'Действие';

  function workStatus(work) {
    const call = currentWorkCall(work);
    const phase = call?.phase || work.phase;
    const target = cleanWork(call?.target?.path || call?.target?.file || call?.target?.app);
    return {
      phase,
      text: WORK_LABELS[phase],
      action: call ? [workTool(call.name), target].filter(Boolean).join(' · ') : '',
    };
  }

  function workPlan(list, start, end) {
    const steps = S.work.steps;
    const next = S.work.closed ? -1 : steps.findIndex((step) => !step.done);
    list.start = start + 1;
    list.replaceChildren(...steps.slice(start, end).map((step, offset) => {
      const index = start + offset;
      const item = el('li', 'nox-work-step');
      const mark = el('span', 'nox-work-number', String(index + 1).padStart(2, '0'));
      mark.setAttribute('aria-hidden', 'true');
      const state = step.done ? 'Отмечен' : index === next ? 'Следующий' : '';
      const text = cleanWork(step.text);
      item.dataset.stepState = step.done ? 'done' : index === next ? 'next' : 'pending';
      item.title = text;
      item.append(mark, el('span', 'nox-work-step-text', text), el('span', 'nox-work-step-state', state));
      return item;
    }));
  }

  function noPlanText(work) {
    if (work.summary) return 'Названия шагов недоступны';
    return work.closed ? 'План не задан' : 'План пока не задан';
  }

  function renderWorkDetails() {
    const work = S.work;
    const { details } = refs.work;
    const { text, action } = workStatus(work);
    const list = el('ol', 'nox-work-plan');
    list.setAttribute('aria-label', 'Полный план');
    workPlan(list, 0, work.steps.length);
    details.replaceChildren(el('p', '', [text, action].filter(Boolean).join(' · ')),
      work.steps.length ? list : el('p', '', noPlanText(work)));
    if (work.evidence) details.append(el('p', '', `Проверено · ${workTool(work.evidence.name)}: ${cleanWork(work.evidence.text)}`));
    if (work.closed && work.issue && ['failed', 'unverified', 'needs_human', 'incomplete'].includes(work.phase)) {
      details.append(el('p', '', cleanWork(work.issue)));
    }
  }

  function renderWork() {
    const { row, status, count, plan, note, proof, more, dialog } = refs.work;
    const work = S.work;
    row.hidden = !work;
    if (!work) {
      if (dialog.open) dialog.close();
      return;
    }
    const { phase, text, action } = workStatus(work);
    const statusText = [text, action].filter(Boolean).join(' · ');
    row.dataset.phase = phase;
    if (status.textContent !== statusText) status.textContent = statusText;
    status.title = statusText;
    const { done, total } = work.summary || { done: work.steps.filter((step) => step.done).length, total: work.steps.length };
    count.textContent = total ? `План · ${done} из ${total}` : '';
    const next = work.steps.findIndex((step) => !step.done);
    const start = Math.max(0, Math.min(next < 0 ? work.steps.length - 3 : next - 1, work.steps.length - 3));
    plan.hidden = !work.steps.length;
    workPlan(plan, start, start + 3);
    note.textContent = work.steps.length ? '' : noPlanText(work);
    if (work.closed && work.issue && ['failed', 'unverified', 'needs_human', 'incomplete'].includes(phase)) {
      note.textContent = cleanWork(work.issue);
    }
    note.hidden = !note.textContent;
    proof.hidden = !work.evidence;
    proof.replaceChildren();
    if (work.evidence) {
      const evidence = cleanWork(work.evidence.text);
      proof.title = evidence;
      proof.append(el('b', '', work.closed ? 'Проверено' : 'Уже проверено'), ' · ' + evidence);
    }
    more.hidden = !work.steps.length && !work.evidence && !work.issue && !action;
    if (dialog.open) renderWorkDetails();
  }

  function lastUser() {
    let node = refs.feedList.lastElementChild;
    while (node && !node.classList.contains('msg-user')) node = node.previousElementSibling;
    return node;
  }

  function clearWork() {
    S.work = S.workOwner = null;
    renderWork();
  }

  // ── Сфера: вариант, состояние, внимание поля ввода ─────────────
  const STAGE_TO_ORB = {
    idle: 'idle', listening: 'listening',
    thinking: 'thinking', planning: 'thinking', acting: 'thinking', searching: 'thinking', verifying: 'thinking',
    speaking: 'speaking', waiting_approval: 'waiting_approval',
    error: 'error', stopped: 'error', success: 'success', cancelled: 'idle',
  };

  function motionOn() {
    return document.documentElement.dataset.motion !== 'off';
  }

  function initOrb() {
    const canvas = refs.orbCanvas;
    if (!canvas) return;
    if (typeof window.NoxOrb !== 'function') {
      console.warn('[nox] orb-nox.js не загружен: сфера останется пустой');
      return;
    }
    try {
      window.NoxOrb.ignoreSystemMotion = true; // у шара свой переключатель, как у прежнего
      // 0.86 от «полного» радиуса модуля: диаметр сферы ≈ 23 % ширины окна, как в референсе.
      S.orb = new window.NoxOrb(canvas, { variant: S.variant, state: 'idle', animated: motionOn(), scale: 0.86 });
    } catch (err) {
      console.error('[nox] сфера не запустилась:', err);
      return;
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { try { S.orb.resize(); } catch { /* размер ещё не нужен */ } });
      ro.observe(refs.orbStage);
    }
    applyStageState();
    bindReadout();
    window.addEventListener('jarvis:orbtune', () => { if (S.orb) S.orb.setAnimated(motionOn()); });
  }

  function applyStageState() {
    if (!S.orb || !refs.stage) return;
    const raw = refs.stage.dataset.state || 'idle';
    const mapped = S.composerFocus && raw === 'idle' ? 'attentive' : (STAGE_TO_ORB[raw] || 'idle');
    S.orbState = mapped;
    try { S.orb.setState(mapped); } catch { /* старый модуль без состояния */ }
    const word = document.getElementById('noxReadState');
    if (word) word.textContent = READ_WORD[mapped] || 'готов';
  }

  // Подпись состояния рядом с затвором: только слова, ничего не считаем и не выдумываем.
  const READ_WORD = {
    idle: 'готов', attentive: 'готов', listening: 'слушаю', thinking: 'работает', speaking: 'отвечаю',
    waiting_approval: 'ждёт вас', error: 'ошибка', success: 'готово',
  };
  function bindReadout() {
    const src = document.getElementById('modePillText');
    const out = document.getElementById('noxReadMode');
    if (!src || !out) return;
    const copy = () => { out.textContent = (src.textContent || '').trim().toLowerCase() || '…'; };
    copy();
    new MutationObserver(copy).observe(src, { childList: true, characterData: true, subtree: true });
  }

  function setVariant(variant, save = true) {
    const value = variant === 'wire' || variant === 'nox' ? variant : 'shutter';
    S.variant = value;
    if (save) { try { localStorage.setItem('noxOrb', value); } catch { /* приватный режим */ } }
    if (S.orb) { try { S.orb.setVariant(value); } catch (err) { console.warn('[nox] вариант сферы:', err); } }
    document.dispatchEvent(new CustomEvent('nox:variant', { detail: value }));
    return value;
  }

  function readVariant() {
    const fromHash = /(?:^|[#&])orb=(wire|nox)\b/.exec(location.hash || '');
    if (fromHash) return fromHash[1];
    try {
      const saved = localStorage.getItem('noxOrb');
      if (saved === 'wire' || saved === 'nox' || saved === 'shutter') return saved;
    } catch { /* хранилище недоступно */ }
    return 'shutter'; // фирменный вид — затвор; сфера и проволока остаются в разработке
  }

  // ── Кнопки окна классического экрана (у разделов Nox — общая шапка, nox-shell.js) ──
  function windowControl(action) {
    const bridge = api();
    if (!bridge || typeof bridge.windowControl !== 'function') return;
    bridge.windowControl(action).catch(() => {});
  }

  // ── Перенос беседы и поля ввода между экранами ─────────────────
  function onView(view) {
    if (!refs) return;
    if (view === 'nox') {
      if (refs.convo.parentElement !== refs.chatMount) refs.chatMount.append(refs.convo);
      if (refs.dock.parentElement !== refs.composerSlot) refs.composerSlot.append(refs.dock);
      const picks = $('#composer .composer-picks');
      const row = $('#composer .composer-row');
      if (picks && row && picks.parentElement !== row) row.append(picks);
      if (refs.workspaceSwitch && refs.wsSlot && refs.workspaceSwitch.parentElement !== refs.wsSlot) {
        refs.wsSlot.append(refs.workspaceSwitch);
      }
      if (S.orb) S.orb.setAnimated(motionOn());
      syncEmpty();
      placePicks();
      ensureMic();
      ensureCopyButtons();
      refreshHistory();
      scrollToBottom();
      requestAnimationFrame(() => { try { S.orb?.resize(); } catch { /* нет сферы */ } });
    } else if (view === 'dialog') {
      if (refs.convo.parentElement !== refs.dialog) {
        const desk = $('#deskPage', refs.dialog);
        if (desk) desk.before(refs.convo); else refs.dialog.append(refs.convo);
      }
      // app.js при запуске переносит поле ввода в беседу; возвращаем туда же, не в сцену.
      if (refs.dock.parentElement !== refs.convo) refs.convo.append(refs.dock);
      const picks = $('#composer .composer-picks');
      const composer = $('#composer');
      if (picks && composer && picks.parentElement !== composer) composer.append(picks);
      if (refs.workspaceSwitch && refs.convo) {
        const tabs = $('#chatTabs', refs.convo);
        if (refs.workspaceSwitch.parentElement !== refs.convo) {
          if (tabs) refs.convo.insertBefore(refs.workspaceSwitch, tabs); else refs.convo.prepend(refs.workspaceSwitch);
        }
      }
      if (S.orb) S.orb.setAnimated(false);
    }
  }

  function ensurePlacement() {
    const view = refs.body.dataset.view || 'nox';
    if (view === 'nox') onView('nox');
  }

  // Выбор модели монтируется отдельным модулем позже — переносим его в строку инструментов.
  function placePicks() {
    if ((refs.body.dataset.view || 'nox') !== 'nox') return;
    const picks = $('#composer .composer-picks');
    const row = $('#composer .composer-row');
    if (picks && row && picks.parentElement !== row) row.append(picks);
  }

  // Микрофон в референсе всегда в строке инструментов. Он честно работает:
  // без включённой диктовки нажатие объясняет, что включить в настройках.
  function ensureMic() {
    if ((refs.body.dataset.view || 'nox') !== 'nox') return;
    const mic = $('#dictationBtn');
    if (mic && mic.hidden) mic.hidden = false;
  }

  // ── Осциллограмма: настоящая диктовка, не украшение ────────────
  function initWave() {
    const form = refs.composer;
    if (!form || form.querySelector('.nox-wave')) return;
    const wave = el('div', 'nox-wave');
    wave.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 28; i += 1) wave.append(el('i'));
    form.insertBefore(wave, form.firstChild);
    const mic = $('#dictationBtn');
    const sync = () => { wave.dataset.recording = mic && mic.dataset.recording === 'true' ? 'true' : 'false'; };
    sync();
    if (mic) new MutationObserver(sync).observe(mic, { attributes: true, attributeFilter: ['data-recording', 'hidden'] });
  }

  // ── Связывание кнопок и наблюдений ─────────────────────────────
  function initControls() {
    $('#noxNewChat')?.addEventListener('click', newChat);
    for (const btn of $$('.win-controls [data-act]')) {
      btn.addEventListener('click', () => windowControl(btn.dataset.act));
    }
    $('#openClassic')?.addEventListener('click', () => {
      const nav = app();
      if (nav && typeof nav.show === 'function') nav.show('dialog');
    });
    // Запасной жест разработчика: Ctrl+Alt+O меняет вариант сферы (в интерфейсе кнопки нет).
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'o' || e.key === 'O' || e.key === 'щ' || e.key === 'Щ')) {
        e.preventDefault();
        setVariant(S.variant === 'shutter' ? 'nox' : S.variant === 'nox' ? 'wire' : 'shutter');
      }
    });
  }

  function initObservers() {
    // Состояние ядра: шар.
    if (refs.stage) {
      new MutationObserver(applyStageState).observe(refs.stage, { attributes: true, attributeFilter: ['data-state'] });
    }
    if (refs.feedList) {
      let copyScheduled = false;
      new MutationObserver((records) => {
        syncEmpty();
        if (S.work && records.some((record) => record.target === refs.feedList)
            && S.workOwner !== lastUser()) clearWork();
        const needsCopy = records.some((record) => [...record.addedNodes].some((node) => {
          if (node.nodeType !== 1) return false;
          return node.matches('.turn') || Boolean(node.querySelector('.turn, .md'));
        }));
        // Кнопка копирования нужна новому ответу, а не каждому изменению его текста.
        if (needsCopy && !copyScheduled) {
          copyScheduled = true;
          requestAnimationFrame(() => { copyScheduled = false; ensureCopyButtons(); });
        }
      }).observe(refs.feedList, { childList: true, subtree: true });
    }
    if (refs.chatTabsList) {
      let timer = 0;
      new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => refreshHistory(), 40);
      }).observe(refs.chatTabsList, { childList: true });
    }
    // Модуль выбора модели и видимость микрофона приходят позже — подхватываем.
    if (refs.composer) new MutationObserver(placePicks).observe(refs.composer, { childList: true });
    const mic = $('#dictationBtn');
    if (mic) new MutationObserver(ensureMic).observe(mic, { attributes: true, attributeFilter: ['hidden'] });
    // Внимание сферы к полю ввода.
    if (refs.chatInput) {
      refs.chatInput.addEventListener('focus', () => { S.composerFocus = true; applyStageState(); });
      refs.chatInput.addEventListener('blur', () => { S.composerFocus = false; applyStageState(); });
      refs.chatInput.addEventListener('input', () => { try { S.orb?.pulse(0.08); } catch { /* модуль без pulse */ } });
    }
    document.addEventListener('jarvis:view', (e) => onView(e.detail));
    document.addEventListener('visibilitychange', () => {
      if (!S.orb) return;
      if (document.hidden) S.orb.setAnimated(false);
      else if ((refs.body.dataset.view || 'nox') === 'nox') S.orb.setAnimated(motionOn());
    });
  }

  function initEvents() {
    const bridge = api();
    if (!bridge || typeof bridge.onEvent !== 'function') return;
    bridge.onEvent((ev) => {
      if (!ev || typeof ev !== 'object' || ev.afterStop || ev.taskId) return;
      const starts = ev.type === 'tool_start' || (ev.type === 'status' && workPhase(ev));
      if (starts) {
        const owner = lastUser();
        if (!owner) return;
        if (!S.work || owner !== S.workOwner) {
          S.workOwner = owner;
          S.work = createWork(ev.runId);
          renderWork();
        }
      }
      if (S.work && S.workOwner.isConnected && updateWork(S.work, ev)) renderWork();
    });
  }

  // ── Геометрия для сверки со скриншотом (только разработка) ─────
  function geometry() {
    const box = (sel) => {
      const node = $(sel);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      window: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      rail: box('.rail'), history: box('#noxHistory'), chat: box('#noxChat'),
      sphere: box('#noxSphere'), orb: box('#noxOrb'),
      variant: S.variant,
    };
  }

  function init() {
    cacheRefs();
    if (!refs.grid) return; // экрана нет в этой сборке
    initWork();
    S.variant = readVariant();
    ensurePlacement();
    initOrb();
    initWave();
    initControls();
    initObservers();
    initEvents();
    placePicks();
    ensureMic();
    ensureCopyButtons();
    refreshHistory();
  }

  // Публичный мост для сверки: переключение варианта, раздел, геометрия.
  window.NoxScreen = {
    onView,
    setVariant,
    getVariant: () => S.variant,
    refreshHistory,
    geometry,
    setState: (state) => { try { S.orb?.setState(state); } catch { /* нет сферы */ } },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

