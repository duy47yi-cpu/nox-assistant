'use strict';

// Расширения: история буфера, быстрые вставки (заготовки), уборка загрузок.
// Здесь только окно: данные и проверки — src/extensions, доступ — main.js.
(function () {
  const U = window.JarvisUI;
  if (!U) return;
  const DEPS = { toast: () => {}, ask: async () => false };
  const $ = (sel, root = document) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...children) => U.el(tag, attrs, ...children);
  const DEFAULT_CLIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const EXT = {
    loaded: false,
    items: [],
    dl: null,
    dlError: null,
    paused: false,
    ttlMs: DEFAULT_CLIP_TTL_MS,
    confirming: false,
  };

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let v = Math.max(0, n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const W = {};

  function formatCustomTtlLabel(ms) {
    const day = 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    const min = 60 * 1000;
    if (ms >= day && ms % day === 0) return `${ms / day} дн.`;
    if (ms >= hour && ms % hour === 0) return `${ms / hour} ч`;
    if (ms >= min && ms % min === 0) return `${ms / min} мин`;
    return `${Math.max(1, Math.round(ms / 1000))} с`;
  }

  function syncClipboardTtl(ttlMs) {
    if (!W.clipTtl) return;
    const options = [...(W.clipTtl.options || W.clipTtl.children || [])];
    for (const opt of options) {
      if (opt && opt.dataset && opt.dataset.customTtl === '1') opt.remove();
    }
    if (ttlMs === null) {
      W.clipTtl.value = '';
      return;
    }
    const num = Number(ttlMs);
    if (!Number.isFinite(num) || num <= 0) return;
    const key = String(num);
    const currentOptions = [...(W.clipTtl.options || W.clipTtl.children || [])];
    const hasMatch = currentOptions.some((opt) => opt && String(opt.value) === key);
    if (!hasMatch) {
      const custom = el('option', { value: key, text: formatCustomTtlLabel(num) });
      custom.dataset.customTtl = '1';
      W.clipTtl.append(custom);
    }
    W.clipTtl.value = key;
  }

  function updateClipboardStatus() {
    const enabled = Boolean(W.clipEnabled && W.clipEnabled.checked);
    if (W.clipStatusHint) {
      if (!enabled) W.clipStatusHint.textContent = 'Выключено — история не ведётся';
      else if (EXT.paused) W.clipStatusHint.textContent = 'Включено, но на паузе — новые копирования не сохраняются';
      else W.clipStatusHint.textContent = 'Включено — история ведётся';
    }
    if (W.clipPause) {
      W.clipPause.disabled = !enabled;
      W.clipPause.textContent = EXT.paused ? 'Продолжить' : 'Пауза';
    }
  }

  async function loadClipboard() {
    const note = W.clipNote;
    if (!note) return;
    if (!U.has || !U.has('clipboardHistoryList')) {
      note.textContent = 'Эта версия Nox не поддерживает историю буфера.';
      note.hidden = false;
      updateClipboardStatus();
      return;
    }
    let state = null;
    try { state = await U.call('clipboardHistoryState'); } catch { state = null; }
    if (state && state.ok) {
      EXT.paused = state.paused === true;
      EXT.ttlMs = state.ttlMs === undefined ? DEFAULT_CLIP_TTL_MS : state.ttlMs;
      syncClipboardTtl(EXT.ttlMs);
    }
    updateClipboardStatus();
    let r;
    try { r = await U.call('clipboardHistoryList', { limit: 20 }); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || r.ok === false) {
      note.textContent = 'История буфера не загрузилась: ' + ((r && r.error) || 'причина неизвестна');
      note.hidden = false;
      return;
    }
    note.hidden = true;
    const items = Array.isArray(r.items) ? r.items : [];
    const totalCount = state && Number.isFinite(Number(state.count)) ? Number(state.count) : items.length;
    if (W.clipCount) W.clipCount.textContent = String(totalCount);
    if (W.clipEmpty) W.clipEmpty.hidden = items.length > 0;
    if (W.clipClear) W.clipClear.disabled = totalCount === 0 && items.length === 0;
    if (W.clipList) {
      W.clipList.replaceChildren(...items.map((item) => el('li', { class: 'memory-item' },
        el('div', { class: 'memory-text' },
          el('span', { class: 'memory-body', text: U.cleanSummary(item.text || '').slice(0, 300) }),
          el('span', { class: 'memory-meta', text: item.createdAt ? U.relTime(item.createdAt) : '' })),
        el('div', { class: 'memory-tools' },
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'В поле', title: 'Вставить текст в поле ввода', onclick: () => putInChat(item.text) }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Удалить', onclick: () => removeClip(item) })))));
    }
  }

  function putInChat(text) {
    const input = $('#chatInput');
    if (!input) return;
    input.value = String(text || '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    DEPS.toast('Текст из истории буфера в поле ввода');
  }

  async function removeClip(item) {
    try {
      const r = await U.call('clipboardHistoryRemove', item.id);
      if (!r || r.ok === false) { DEPS.toast((r && r.error) || 'Не удалось удалить', 'error'); return; }
      await loadClipboard();
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  async function clearClipboard() {
    const ok = await DEPS.ask('Очистить историю буфера?', 'Все сохранённые фрагменты будут удалены.', 'Очистить', 'Отмена');
    if (!ok) return;
    try {
      const r = await U.call('clipboardHistoryClear');
      if (!r || r.ok === false) { DEPS.toast((r && r.error) || 'Не удалось очистить', 'error'); return; }
      await loadClipboard();
      DEPS.toast('История буфера очищена');
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  async function togglePause() {
    try {
      const r = await U.call(EXT.paused ? 'clipboardHistoryResume' : 'clipboardHistoryPause');
      if (!r || r.ok === false) { DEPS.toast((r && r.error) || 'Не получилось', 'error'); return; }
      await loadClipboard();
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  async function setClipboardTtl(value) {
    const prevTtl = EXT.ttlMs;
    try {
      const nextTtl = value === '' ? null : Number(value);
      const r = await U.call('clipboardHistoryTtl', nextTtl);
      if (!r || r.ok === false) {
        syncClipboardTtl(prevTtl);
        DEPS.toast((r && r.error) || 'Не сохранилось', 'error');
        return;
      }
      EXT.ttlMs = r.ttlMs === undefined ? nextTtl : r.ttlMs;
      await loadClipboard();
      DEPS.toast('Срок хранения обновлён');
    } catch (err) {
      syncClipboardTtl(prevTtl);
      DEPS.toast('Не удалось: ' + err.message, 'error');
    }
  }

  async function loadSnippets() {
    const note = W.snipError;
    if (!U.has || !U.has('snippetsList')) {
      if (note) { note.textContent = 'Эта версия Nox не поддерживает быстрые вставки.'; note.hidden = false; }
      return;
    }
    let r;
    try { r = await U.call('snippetsList'); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || r.ok === false) {
      if (note) { note.textContent = 'Заготовки не загрузились: ' + ((r && r.error) || 'причина неизвестна'); note.hidden = false; }
      return;
    }
    if (note) note.hidden = true;
    const items = Array.isArray(r.items) ? r.items : [];
    if (W.snipCount) W.snipCount.textContent = String(items.length);
    if (W.snipEmpty) W.snipEmpty.hidden = items.length > 0;
    if (W.snipList) {
      W.snipList.replaceChildren(...items.map((item) => el('li', { class: 'memory-item' },
        el('div', { class: 'memory-text' },
          el('span', { class: 'memory-body', text: '«' + item.trigger + '» · ' + U.cleanSummary(item.text || '').slice(0, 160) }),
          el('span', { class: 'memory-meta', text: item.updatedAt ? 'изменено ' + U.relTime(item.updatedAt) : '' })),
        el('div', { class: 'memory-tools' },
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'В буфер', title: 'Скопировать текст в буфер после подтверждения', onclick: () => insertSnippet(item) }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Изменить', onclick: () => editSnippet(item) }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Удалить', onclick: () => removeSnippet(item) })))));
    }
  }

  async function insertSnippet(item) {
    const ok = await DEPS.ask('Вставить в буфер обмена?', '«' + item.trigger + '»: ' + U.clip(U.cleanSummary(item.text || ''), 160), 'Вставить', 'Отмена');
    if (!ok) return;
    try {
      const r = await U.call('snippetsInsert', item.id, true);
      if (!r || r.ok === false) { DEPS.toast((r && r.message) || (r && r.error) || 'Не получилось скопировать', 'error'); return; }
      DEPS.toast('Текст скопирован в буфер обмена');
      await loadClipboard();
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  function editSnippet(item) {
    if (W.snipTrigger) W.snipTrigger.value = item.trigger || '';
    if (W.snipText) W.snipText.value = item.text || '';
    if (W.snipSave) W.snipSave.dataset.editId = item.id;
    if (W.snipSave) W.snipSave.textContent = 'Сохранить изменения';
    if (W.snipTrigger) W.snipTrigger.focus();
  }

  async function saveSnippet() {
    if (!W.snipTrigger || !W.snipText) return;
    const trigger = W.snipTrigger.value.trim();
    const text = W.snipText.value.trim();
    if (!trigger || !text) {
      if (W.snipError) { W.snipError.textContent = 'Нужны и короткое название, и текст.'; W.snipError.hidden = false; }
      return;
    }
    const id = W.snipSave ? W.snipSave.dataset.editId : '';
    try {
      const r = await U.call('snippetsSave', { ...(id ? { id } : {}), trigger, text });
      if (!r || r.ok === false) {
        if (W.snipError) { W.snipError.textContent = (r && r.error) || 'Не сохранилось'; W.snipError.hidden = false; }
        return;
      }
      if (W.snipError) W.snipError.hidden = true;
      W.snipTrigger.value = '';
      W.snipText.value = '';
      if (W.snipSave) { delete W.snipSave.dataset.editId; W.snipSave.textContent = 'Сохранить'; }
      DEPS.toast(id ? 'Заготовка изменена' : 'Заготовка сохранена');
      await loadSnippets();
    } catch (err) {
      if (W.snipError) { W.snipError.textContent = err.message; W.snipError.hidden = false; }
    }
  }

  async function removeSnippet(item) {
    const ok = await DEPS.ask('Удалить заготовку?', '«' + item.trigger + '»', 'Удалить', 'Оставить');
    if (!ok) return;
    try {
      const r = await U.call('snippetsRemove', item.id);
      if (!r || r.ok === false) { DEPS.toast((r && r.error) || 'Не удалось', 'error'); return; }
      await loadSnippets();
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  function setDownloadsNote(text, isError = false) {
    if (!W.dlNote) return;
    W.dlNote.textContent = text;
    if (W.dlNote.classList) W.dlNote.classList.toggle('note-err', Boolean(isError));
    W.dlNote.hidden = !text;
  }

  function setDownloadsResult(text, isError = false) {
    if (!W.dlResult) return;
    W.dlResult.textContent = text;
    if (W.dlResult.classList) W.dlResult.classList.toggle('note-err', Boolean(isError));
    W.dlResult.hidden = !text;
  }

  function clearDownloadsResult() {
    setDownloadsResult('', false);
  }

  function getCandidateMap() {
    const map = new Map();
    const list = EXT.dl && Array.isArray(EXT.dl.candidates) ? EXT.dl.candidates : [];
    for (const item of list) {
      if (item && typeof item.path === 'string') map.set(item.path, item);
    }
    return map;
  }

  function getSelectedItems() {
    if (!W.dlList) return [];
    const byPath = getCandidateMap();
    const boxes = [...W.dlList.querySelectorAll('input[type="checkbox"]:checked')];
    return boxes.map((box) => {
      const path = box.dataset && box.dataset.path ? box.dataset.path : '';
      if (!path) return null;
      const item = byPath.get(path);
      return item || { path, size: Number(box.dataset.size) || 0, mtimeMs: Number(box.dataset.mtimeMs) || 0 };
    }).filter(Boolean);
  }

  function updateDownloadSelection() {
    const total = W.dlList ? W.dlList.querySelectorAll('input[type="checkbox"]').length : 0;
    const selected = getSelectedItems();
    const selectedBytes = selected.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    if (W.dlSelection) {
      W.dlSelection.textContent = selected.length > 0
        ? `Выбрано: ${selected.length} из ${total} (${fmtBytes(selectedBytes)})`
        : `Выбрано: 0 из ${total}`;
    }
    if (W.dlRemove) W.dlRemove.disabled = EXT.confirming || selected.length === 0;
    if (W.dlSelectAll) W.dlSelectAll.disabled = EXT.confirming || total === 0 || selected.length === total;
    if (W.dlSelectNone) W.dlSelectNone.disabled = EXT.confirming || selected.length === 0;
  }

  function setDownloadsLocked(locked) {
    EXT.confirming = Boolean(locked);
    if (W.dlAnalyze) W.dlAnalyze.disabled = EXT.confirming;
    if (W.dlList) {
      for (const box of W.dlList.querySelectorAll('input[type="checkbox"]')) {
        box.disabled = EXT.confirming;
      }
    }
    updateDownloadSelection();
  }

  function selectAllDownloads(checked) {
    if (EXT.confirming || !W.dlList) return;
    for (const box of W.dlList.querySelectorAll('input[type="checkbox"]')) {
      box.checked = Boolean(checked);
    }
    updateDownloadSelection();
  }

  async function readFreeSpaceSummary(folder) {
    if (!U.has || !U.has('diskFree')) return '';
    try {
      const fr = await U.call('diskFree');
      const drives = fr && fr.ok && fr.data && Array.isArray(fr.data.drives) ? fr.data.drives : [];
      if (!drives.length) return '';
      const driveLetter = /^[a-zA-Z]:/.exec(String(folder || ''))?.[0]?.toUpperCase();
      const drive = (driveLetter && drives.find((d) => String(d && d.drive || '').toUpperCase().startsWith(driveLetter[0]))) || drives[0];
      if (drive && Number.isFinite(Number(drive.freeGB))) {
        return `Свободно на ${drive.drive}: ~${Math.round(Number(drive.freeGB))} ГБ · `;
      }
    } catch {
      // Свободное место необязательно: основная сводка по папке загрузок остаётся.
    }
    return '';
  }

  async function analyzeDownloads(options = {}) {
    if (!W.dlNote) return;
    if (!options.keepResult) clearDownloadsResult();
    if (!U.has || !U.has('downloadsAnalyze')) {
      EXT.dl = null;
      EXT.dlError = 'Эта версия Nox не поддерживает проверку загрузок.';
      setDownloadsNote(EXT.dlError, true);
      if (W.dlSelectBar) W.dlSelectBar.hidden = true;
      if (W.dlCount) W.dlCount.textContent = '';
      if (W.dlRemove) W.dlRemove.disabled = true;
      return;
    }
    setDownloadsNote('Смотрю папку загрузок…', false);
    let r;
    try { r = await U.call('downloadsAnalyze', {}); } catch (err) { r = { ok: false, message: err.message }; }
    if (!r || r.ok === false) {
      EXT.dl = null;
      EXT.dlError = 'Не удалось проверить загрузки: ' + ((r && r.message) || (r && r.reason) || 'причина неизвестна');
      setDownloadsNote(EXT.dlError, true);
      if (W.dlList) W.dlList.replaceChildren();
      if (W.dlSelectBar) W.dlSelectBar.hidden = true;
      if (W.dlCount) W.dlCount.textContent = '';
      if (W.dlRemove) W.dlRemove.disabled = true;
      return;
    }
    EXT.dlError = null;
    EXT.dl = r;
    const candidates = Array.isArray(r.candidates) ? r.candidates : [];
    const scanned = typeof r.scanned === 'number' ? r.scanned : (r.scanned && Number.isFinite(r.scanned.files) ? r.scanned.files : 0);
    const bytes = Number.isFinite(r.candidateBytes) && r.candidateBytes > 0
      ? r.candidateBytes
      : candidates.reduce((sum, item) => sum + (Number(item && item.size) || 0), 0);

    if (W.dlCount) W.dlCount.textContent = String(candidates.length);
    if (W.dlList) {
      W.dlList.replaceChildren(...candidates.map((item) => {
        const box = el('input', {
          type: 'checkbox',
          class: 'ext-check',
          'aria-label': 'Выбрать ' + (item.path || ''),
        });
        // По умолчанию ни один файл не отмечен: владелец явно выбирает, что удалять.
        box.checked = false;
        box.disabled = EXT.confirming;
        box.dataset.path = item.path || '';
        box.dataset.size = String(Number(item.size) || 0);
        if (item.mtimeMs !== undefined) box.dataset.mtimeMs = String(item.mtimeMs);
        box.addEventListener('change', updateDownloadSelection);
        return el('li', { class: 'memory-item' },
          el('div', { class: 'memory-text' },
            el('span', { class: 'memory-body', text: item.path || '' }),
            el('span', { class: 'memory-meta', text: [fmtBytes(Number(item.size) || 0), item.reason || ''].filter(Boolean).join(' · ') })),
          box);
      }));
    }
    if (W.dlSelectBar) W.dlSelectBar.hidden = candidates.length === 0;
    const baseNote = (candidates.length === 0 || r.status === 'empty')
      ? 'В загрузках нет старых и временных файлов.'
      : `Проверено файлов: ${scanned}; можно убрать: ${candidates.length}${bytes ? ' (' + fmtBytes(bytes) + ')' : ''}. Ничего не удалено — отметьте нужные файлы.${r.candidatesTruncated ? ` Показаны первые ${candidates.length} из ${r.candidatesTotal}.` : ''}`;
    setDownloadsNote(baseNote, false);
    updateDownloadSelection();

    const snapId = r.snapshotId;
    readFreeSpaceSummary(r.folder).then((freePrefix) => {
      if (!freePrefix || !EXT.dl || EXT.dl.snapshotId !== snapId) return;
      setDownloadsNote(freePrefix + baseNote, false);
    });
  }

  async function removeDownloads() {
    if (EXT.confirming || !EXT.dl || !W.dlList) return;
    const selected = getSelectedItems();
    if (!selected.length) {
      DEPS.toast('Ничего не выбрано', 'error');
      updateDownloadSelection();
      return;
    }

    const confirmedSnapshotId = EXT.dl.snapshotId || null;
    const confirmedItems = selected.map((item) => ({
      path: item.path,
      size: Number(item.size) || 0,
      ...(item.mtimeMs !== undefined ? { mtimeMs: Number(item.mtimeMs) } : {}),
    }));
    const confirmedPaths = confirmedItems.map((item) => item.path);
    const totalBytes = confirmedItems.reduce((sum, item) => sum + item.size, 0);
    const summary = `Выбрано файлов: ${confirmedItems.length}${totalBytes ? ' (' + fmtBytes(totalBytes) + ')' : ''}. Это удалит их из папки загрузок без корзины. Проверьте точный список:`;
    const listText = confirmedItems.map((item) => `• ${item.path} (${fmtBytes(item.size)})`).join('\n');
    const dialogItems = confirmedItems.map((item) => ({ label: item.path, meta: fmtBytes(item.size) }));

    setDownloadsLocked(true);
    let ok = false;
    try {
      ok = await DEPS.ask(
        'Удалить выбранные файлы?',
        `${summary}\n${listText}`,
        'Удалить',
        'Отмена',
        { summary, items: dialogItems },
      );
    } catch {
      ok = false;
    }

    if (!ok) {
      setDownloadsLocked(false);
      return;
    }

    // Повторная сверка после закрытия диалога: список не должен измениться между подтверждением и исполнением.
    const currentSnapshotId = EXT.dl ? (EXT.dl.snapshotId || null) : null;
    const currentPaths = getSelectedItems().map((item) => item.path);
    const listDrifted = currentSnapshotId !== confirmedSnapshotId
      || currentPaths.length !== confirmedPaths.length
      || currentPaths.some((p, i) => p !== confirmedPaths[i]);
    if (listDrifted) {
      setDownloadsResult('Список файлов изменился во время подтверждения. Запущена повторная проверка — выберите файлы заново.', true);
      setDownloadsLocked(false);
      await analyzeDownloads({ keepResult: true });
      return;
    }

    try {
      const r = await U.call('downloadsRemove', {
        snapshotId: confirmedSnapshotId,
        items: confirmedItems,
        paths: confirmedPaths,
      }, true);
      if (!r || r.ok === false) {
        const msg = (r && r.needsReanalyze)
          ? ((r && r.message) || 'Состояние файлов изменилось после проверки. Список обновлён — проверьте и подтвердите заново.')
          : ('Не удалось удалить: ' + ((r && r.message) || (r && r.reason) || 'причина неизвестна'));
        setDownloadsResult(msg, true);
        setDownloadsLocked(false);
        await analyzeDownloads({ keepResult: true });
        return;
      }
      const removedCount = Array.isArray(r.removed) ? r.removed.length : 0;
      const freedText = fmtBytes(r.bytesFreed);
      const resultText = `Удалено файлов: ${removedCount}, освобождено ${freedText}${r.refused && r.refused.length ? ', отклонено: ' + r.refused.length : ''}${r.failed && r.failed.length ? ', ошибок: ' + r.failed.length : ''}.`;
      setDownloadsResult(resultText, false);
      DEPS.toast(resultText);
      setDownloadsLocked(false);
      await analyzeDownloads({ keepResult: true });
    } catch (err) {
      setDownloadsResult('Не удалось: ' + err.message, true);
      setDownloadsLocked(false);
    }
  }

  async function loadAll() {
    await Promise.all([loadClipboard(), loadSnippets()]);
  }

  function init(deps) {
    if (deps && typeof deps === 'object') {
      if (typeof deps.toast === 'function') DEPS.toast = deps.toast;
      if (typeof deps.ask === 'function') DEPS.ask = deps.ask;
    }
    W.clipList = $('#clipList');
    if (!W.clipList) return;
    W.clipCount = $('#clipCount');
    W.clipEmpty = $('#clipEmpty');
    W.clipNote = $('#clipNote');
    W.clipEnabled = $('#clipEnabled');
    W.clipStatusHint = $('#clipStatusHint');
    W.clipTtl = $('#clipTtl');
    W.clipPause = $('#clipPause');
    W.clipClear = $('#clipClear');
    W.clipReload = $('#clipReload');
    W.snipList = $('#snipList');
    W.snipCount = $('#snipCount');
    W.snipEmpty = $('#snipEmpty');
    W.snipError = $('#snipError');
    W.snipTrigger = $('#snipTrigger');
    W.snipText = $('#snipText');
    W.snipSave = $('#snipSave');
    W.snipForm = $('#snipForm');
    W.dlCount = $('#dlCount');
    W.dlResult = $('#dlResult');
    W.dlNote = $('#dlNote');
    W.dlSelectBar = $('#dlSelectBar');
    W.dlSelection = $('#dlSelection');
    W.dlSelectAll = $('#dlSelectAll');
    W.dlSelectNone = $('#dlSelectNone');
    W.dlList = $('#dlList');
    W.dlAnalyze = $('#dlAnalyze');
    W.dlRemove = $('#dlRemove');
    if (W.clipEnabled) W.clipEnabled.addEventListener('change', async () => {
      try {
        const r = await U.call('setSetting', 'clipboardHistory', W.clipEnabled.checked);
        if (!r || r.ok === false) { W.clipEnabled.checked = !W.clipEnabled.checked; DEPS.toast('Не сохранилось', 'error'); }
      } catch (err) { W.clipEnabled.checked = !W.clipEnabled.checked; DEPS.toast('Не удалось: ' + err.message, 'error'); }
      updateClipboardStatus();
    });
    if (W.clipTtl) W.clipTtl.addEventListener('change', () => setClipboardTtl(W.clipTtl.value));
    if (W.clipPause) W.clipPause.addEventListener('click', togglePause);
    if (W.clipClear) W.clipClear.addEventListener('click', clearClipboard);
    if (W.clipReload) W.clipReload.addEventListener('click', loadClipboard);
    if (W.snipForm) W.snipForm.addEventListener('submit', (e) => { e.preventDefault(); saveSnippet(); });
    if (W.dlAnalyze) W.dlAnalyze.addEventListener('click', () => analyzeDownloads());
    if (W.dlRemove) W.dlRemove.addEventListener('click', removeDownloads);
    if (W.dlSelectAll) W.dlSelectAll.addEventListener('click', () => selectAllDownloads(true));
    if (W.dlSelectNone) W.dlSelectNone.addEventListener('click', () => selectAllDownloads(false));
    updateClipboardStatus();
  }

  async function loadSettingsState() {
    if (!W.clipEnabled) return;
    try {
      const s = await U.call('getSettings');
      if (s) W.clipEnabled.checked = s.clipboardHistory === true;
    } catch { /* старая сборка: настройка останется выключенной */ }
    updateClipboardStatus();
    await loadAll();
  }

  window.JarvisExtensions = { init, load: loadSettingsState };
})();
