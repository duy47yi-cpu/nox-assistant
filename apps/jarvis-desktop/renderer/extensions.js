'use strict';

// Расширения из видео: история буфера, быстрые вставки, уборка загрузок.
// Здесь только окно: данные и проверки — src/extensions, доступ — main.js.
(function () {
  const U = window.JarvisUI;
  if (!U) return;
  const DEPS = { toast: () => {}, ask: async () => false };
  const $ = (sel, root = document) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...children) => U.el(tag, attrs, ...children);
  const EXT = { loaded: false, items: [], dl: null, paused: false };

  const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let v = Math.max(0, n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  const W = {};

  async function loadClipboard() {
    const note = W.clipNote;
    if (!note) return;
    if (!U.has || !U.has('clipboardHistoryList')) {
      note.textContent = 'Эта версия ядра не знает историю буфера.';
      note.hidden = false;
      return;
    }
    let state = null;
    try { state = await U.call('clipboardHistoryState'); } catch { state = null; }
    if (state && state.ok) {
      EXT.paused = state.paused === true;
      if (W.clipPause) W.clipPause.textContent = EXT.paused ? 'Продолжить' : 'Пауза';
    }
    let r;
    try { r = await U.call('clipboardHistoryList', { limit: 20 }); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || r.ok === false) {
      note.textContent = 'История буфера не загрузилась: ' + ((r && r.error) || 'причина неизвестна');
      note.hidden = false;
      return;
    }
    note.hidden = true;
    const items = Array.isArray(r.items) ? r.items : [];
    if (W.clipCount) W.clipCount.textContent = String(items.length);
    if (W.clipEmpty) W.clipEmpty.hidden = items.length > 0;
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
    try {
      const r = await U.call('clipboardHistoryTtl', value === '' ? null : Number(value));
      if (!r || r.ok === false) DEPS.toast((r && r.error) || 'Не сохранилось', 'error');
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  async function loadSnippets() {
    const note = W.snipError;
    if (!U.has || !U.has('snippetsList')) {
      if (note) { note.textContent = 'Эта версия ядра не знает быстрые вставки.'; note.hidden = false; }
      return;
    }
    let r;
    try { r = await U.call('snippetsList'); } catch (err) { r = { ok: false, error: err.message }; }
    if (!r || r.ok === false) {
      if (note) { note.textContent = 'Вставки не загрузились: ' + ((r && r.error) || 'причина неизвестна'); note.hidden = false; }
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
          el('button', { type: 'button', class: 'btn btn-secondary btn-sm', text: 'В буфер', title: 'Скопировать текст после подтверждения', onclick: () => insertSnippet(item) }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Изменить', onclick: () => editSnippet(item) }),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Удалить', onclick: () => removeSnippet(item) })))));
    }
  }

  async function insertSnippet(item) {
    const ok = await DEPS.ask('Вставить в буфер обмена?', '«' + item.trigger + '»: ' + U.clip(U.cleanSummary(item.text || ''), 160), 'Вставить', 'Отмена');
    if (!ok) return;
    try {
      const r = await U.call('snippetsInsert', item.id, true);
      if (!r || r.ok === false) { DEPS.toast((r && r.message) || (r && r.error) || 'Не получилось вставить', 'error'); return; }
      DEPS.toast('Текст вставки в буфере обмена');
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
      if (W.snipError) { W.snipError.textContent = 'Нужны и фраза-триггер, и текст.'; W.snipError.hidden = false; }
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
      DEPS.toast(id ? 'Вставка изменена' : 'Вставка сохранена');
      await loadSnippets();
    } catch (err) {
      if (W.snipError) { W.snipError.textContent = err.message; W.snipError.hidden = false; }
    }
  }

  async function removeSnippet(item) {
    const ok = await DEPS.ask('Удалить вставку?', '«' + item.trigger + '»', 'Удалить', 'Оставить');
    if (!ok) return;
    try {
      const r = await U.call('snippetsRemove', item.id);
      if (!r || r.ok === false) { DEPS.toast((r && r.error) || 'Не удалось', 'error'); return; }
      await loadSnippets();
    } catch (err) { DEPS.toast('Не удалось: ' + err.message, 'error'); }
  }

  async function analyzeDownloads() {
    if (!W.dlNote) return;
    if (!U.has || !U.has('downloadsAnalyze')) {
      W.dlNote.textContent = 'Эта версия ядра не умеет разбирать загрузки.';
      W.dlNote.hidden = false;
      return;
    }
    W.dlNote.textContent = 'Смотрю папку загрузок…';
    W.dlNote.hidden = false;
    let r;
    try { r = await U.call('downloadsAnalyze', {}); } catch (err) { r = { ok: false, message: err.message }; }
    if (!r || r.ok === false) {
      W.dlNote.textContent = 'Не получилось: ' + ((r && r.message) || (r && r.reason) || 'причина неизвестна');
      return;
    }
    EXT.dl = r;
    const candidates = Array.isArray(r.candidates) ? r.candidates : [];
    const scanned = typeof r.scanned === 'number' ? r.scanned : (r.scanned && Number.isFinite(r.scanned.files) ? r.scanned.files : 0);
    W.dlNote.textContent = r.status === 'empty'
      ? 'В загрузках нет файлов, которые можно убрать.'
      : `Проверено ${scanned} файлов; кандидатов: ${candidates.length}${r.candidateBytes ? ' на ' + fmtBytes(r.candidateBytes) : ''}. Ничего не удалено.`;
    if (W.dlList) {
      W.dlList.replaceChildren(...candidates.slice(0, 30).map((item) => {
        const box = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Выбрать ' + (item.path || '') });
        box.checked = true;
        box.dataset.path = item.path;
        return el('li', { class: 'memory-item' },
          el('div', { class: 'memory-text' },
            el('span', { class: 'memory-body', text: item.path || '' }),
            el('span', { class: 'memory-meta', text: [fmtBytes(item.size), item.reason || ''].filter(Boolean).join(' · ') })),
          box);
      }));
    }
    if (W.dlRemove) W.dlRemove.disabled = candidates.length === 0;
  }

  async function removeDownloads() {
    if (!EXT.dl || !W.dlList) return;
    const boxes = [...W.dlList.querySelectorAll('input[type="checkbox"]:checked')];
    if (!boxes.length) { DEPS.toast('Ничего не выбрано', 'error'); return; }
    const paths = boxes.map((box) => box.dataset.path).filter(Boolean);
    const ok = await DEPS.ask('Удалить выбранные файлы?', `Файлов: ${paths.length}. Это удалит их из папки загрузок без корзины.`, 'Удалить', 'Отмена');
    if (!ok) return;
    try {
      const r = await U.call('downloadsRemove', { paths }, true);
      if (!r || r.ok === false) {
        W.dlNote.textContent = 'Не удалось: ' + ((r && r.message) || (r && r.reason) || 'причина неизвестна');
        W.dlNote.hidden = false;
        return;
      }
      W.dlNote.textContent = `Удалено ${Array.isArray(r.removed) ? r.removed.length : 0}, освобождено ${fmtBytes(r.bytesFreed)}${r.refused && r.refused.length ? ', отклонено: ' + r.refused.length : ''}${r.failed && r.failed.length ? ', ошибок: ' + r.failed.length : ''}.`;
      W.dlNote.hidden = false;
      await analyzeDownloads();
    } catch (err) {
      W.dlNote.textContent = 'Не удалось: ' + err.message;
      W.dlNote.hidden = false;
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
    W.dlNote = $('#dlNote');
    W.dlList = $('#dlList');
    W.dlAnalyze = $('#dlAnalyze');
    W.dlRemove = $('#dlRemove');
    if (W.clipEnabled) W.clipEnabled.addEventListener('change', async () => {
      try {
        const r = await U.call('setSetting', 'clipboardHistory', W.clipEnabled.checked);
        if (!r || r.ok === false) { W.clipEnabled.checked = !W.clipEnabled.checked; DEPS.toast('Не сохранилось', 'error'); }
      } catch (err) { W.clipEnabled.checked = !W.clipEnabled.checked; DEPS.toast('Не удалось: ' + err.message, 'error'); }
    });
    if (W.clipTtl) W.clipTtl.addEventListener('change', () => setClipboardTtl(W.clipTtl.value));
    if (W.clipPause) W.clipPause.addEventListener('click', togglePause);
    if (W.clipClear) W.clipClear.addEventListener('click', clearClipboard);
    if (W.clipReload) W.clipReload.addEventListener('click', loadClipboard);
    if (W.snipForm) W.snipForm.addEventListener('submit', (e) => { e.preventDefault(); saveSnippet(); });
    if (W.dlAnalyze) W.dlAnalyze.addEventListener('click', analyzeDownloads);
    if (W.dlRemove) W.dlRemove.addEventListener('click', removeDownloads);
  }

  async function loadSettingsState() {
    if (!W.clipEnabled) return;
    try {
      const s = await U.call('getSettings');
      if (s) W.clipEnabled.checked = s.clipboardHistory === true;
    } catch { /* старая сборка: настройка останется выключенной */ }
    await loadAll();
  }

  window.JarvisExtensions = { init, load: loadSettingsState };
})();
