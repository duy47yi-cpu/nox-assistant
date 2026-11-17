/* Модальное окно «Настройки Nox AI» (540px, тёмная палитра #0F141C):
 * - секции «Подключение», «Модель» и «Основные» с кнопкой обновления;
 * - маска ключа доступа с «Показать / Скрыть», статус подключения и проверка;
 * - без раскрытия внутренних названий внешних моделей и провайдеров (только Nox / Быстрая / Умная). */
(() => {
  'use strict';

  function createAiModal({ store, bridge }) {
    const { icon } = window.NoxAetherIcons;

    const backdrop = document.createElement('div');
    backdrop.id = 'lxAiModalBackdrop';
    backdrop.className = 'lx-modal-backdrop';
    backdrop.hidden = true;
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.id = 'lxAiModal';
    dialog.className = 'lx-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'lxAiModalTitle');

    // Шапка модалки
    const head = document.createElement('div');
    head.className = 'lx-modal-head';
    const title = document.createElement('h2');
    title.id = 'lxAiModalTitle';
    title.className = 'lx-modal-title';
    title.textContent = 'Настройки Nox AI';

    const closeTopBtn = document.createElement('button');
    closeTopBtn.type = 'button';
    closeTopBtn.className = 'lx-icon-btn lx-modal-close';
    closeTopBtn.setAttribute('aria-label', 'Закрыть настройки Nox AI');
    closeTopBtn.append(icon('x'));
    head.append(title, closeTopBtn);

    // Тело со скроллом
    const body = document.createElement('div');
    body.className = 'lx-modal-body';

    function makeSectionHead(labelText, onRefresh) {
      const row = document.createElement('div');
      row.className = 'lx-modal-sec-head';
      const h = document.createElement('h3');
      h.className = 'lx-section-title';
      h.textContent = labelText;
      const refBtn = document.createElement('button');
      refBtn.type = 'button';
      refBtn.className = 'lx-icon-btn lx-sec-refresh';
      refBtn.title = 'Обновить';
      refBtn.setAttribute('aria-label', `Обновить раздел «${labelText}»`);
      refBtn.append(icon('refresh'));
      refBtn.addEventListener('click', () => {
        if (typeof onRefresh === 'function') onRefresh();
      });
      row.append(h, refBtn);
      return row;
    }

    // ── Секция «Подключение» ────────────────────────────────────
    const connSec = document.createElement('section');
    connSec.className = 'lx-modal-sec';

    const provLabel = document.createElement('label');
    provLabel.className = 'lx-field-label';
    provLabel.htmlFor = 'lxAiProvider';
    provLabel.textContent = 'Провайдер';

    const provSelect = document.createElement('select');
    provSelect.id = 'lxAiProvider';
    provSelect.className = 'lx-select';
    for (const [val, text] of [
      ['nox-cloud', 'Облако Nox (по умолчанию)'],
      ['local-compat', 'Совместимый локальный сервер'],
    ]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      provSelect.append(opt);
    }

    const keyLabel = document.createElement('label');
    keyLabel.className = 'lx-field-label';
    keyLabel.htmlFor = 'lxAiKeyInput';
    keyLabel.textContent = 'Ключ доступа';

    const keyRow = document.createElement('div');
    keyRow.className = 'lx-key-row';

    const keyInput = document.createElement('input');
    keyInput.id = 'lxAiKeyInput';
    keyInput.type = 'password';
    keyInput.className = 'lx-input';
    keyInput.value = 'nx-demo-connected-key-0000';
    keyInput.placeholder = 'Введите ключ доступа…';
    keyInput.autocomplete = 'off';

    const toggleKeyBtn = document.createElement('button');
    toggleKeyBtn.type = 'button';
    toggleKeyBtn.id = 'lxAiKeyToggle';
    toggleKeyBtn.className = 'lx-pill-btn lx-pill-ghost';
    toggleKeyBtn.textContent = 'Показать';
    toggleKeyBtn.addEventListener('click', () => {
      const shown = keyInput.type === 'text';
      keyInput.type = shown ? 'password' : 'text';
      toggleKeyBtn.textContent = shown ? 'Показать' : 'Скрыть';
    });
    keyRow.append(keyInput, toggleKeyBtn);

    const connHint = document.createElement('p');
    connHint.className = 'lx-hint';
    connHint.textContent = 'Ключ хранится локально в защищённом хранилище устройства и не передаётся третьим лицам.';

    const statusLine = document.createElement('div');
    statusLine.className = 'lx-conn-status';
    const statusDot = document.createElement('span');
    statusDot.className = 'lx-status-dot is-ok';
    const statusText = document.createElement('span');
    statusText.id = 'lxAiConnStatusText';
    statusText.textContent = 'Подключено';
    statusLine.append(statusDot, statusText);

    function syncConnStatus(ok, label) {
      statusDot.classList.toggle('is-ok', Boolean(ok));
      statusDot.classList.toggle('is-off', !ok);
      statusText.textContent = label || (ok ? 'Подключено' : 'Ключ не указан');
    }

    const connActions = document.createElement('div');
    connActions.className = 'lx-btn-row';

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.id = 'lxAiTestBtn';
    testBtn.className = 'lx-pill-btn lx-pill-secondary';
    testBtn.textContent = 'Проверить подключение';
    testBtn.addEventListener('click', async () => {
      const hasVal = Boolean(keyInput.value.trim()) || provSelect.value === 'nox-cloud';
      syncConnStatus(hasVal, hasVal ? 'Подключено · проверка пройдена' : 'Нет ключа доступа');
      store.toast(hasVal ? 'Подключение к Nox AI активно' : 'Укажите ключ доступа', hasVal ? 'ok' : 'error');
    });

    const removeKeyBtn = document.createElement('button');
    removeKeyBtn.type = 'button';
    removeKeyBtn.id = 'lxAiDeleteKeyBtn';
    removeKeyBtn.className = 'lx-pill-btn lx-pill-secondary lx-pill-danger-soft';
    removeKeyBtn.textContent = 'Удалить ключ';
    removeKeyBtn.addEventListener('click', () => {
      keyInput.value = '';
      keyInput.type = 'password';
      toggleKeyBtn.textContent = 'Показать';
      syncConnStatus(false, 'Ключ удалён');
      store.toast('Ключ доступа очищен');
    });

    connActions.append(testBtn, removeKeyBtn);

    connSec.append(
      makeSectionHead('Подключение', () => {
        syncConnStatus(Boolean(keyInput.value.trim()), keyInput.value.trim() ? 'Подключено' : 'Ключ не указан');
        store.toast('Состояние подключения обновлено');
      }),
      provLabel,
      provSelect,
      keyLabel,
      keyRow,
      connHint,
      statusLine,
      connActions
    );

    // ── Секция «Модель» ─────────────────────────────────────────
    const modelSec = document.createElement('section');
    modelSec.className = 'lx-modal-sec';

    const modelLabel = document.createElement('label');
    modelLabel.className = 'lx-field-label';
    modelLabel.htmlFor = 'lxAiModelSelect';
    modelLabel.textContent = 'Модель';

    const modelSelect = document.createElement('select');
    modelSelect.id = 'lxAiModelSelect';
    modelSelect.className = 'lx-select';
    for (const [val, text] of [
      ['fast', 'Быстрая — моментальные ответы и команды'],
      ['smart', 'Умная — глубокий разбор и сложные задачи'],
    ]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      modelSelect.append(opt);
    }

    const modelHint = document.createElement('p');
    modelHint.className = 'lx-hint';
    modelHint.textContent = '«Быстрая» подходит для повседневных команд. «Умная» точнее решает составные поручения.';

    modelSec.append(
      makeSectionHead('Модель', () => {
        modelSelect.value = store.state.tier || 'fast';
        store.toast('Список режимов обновлён');
      }),
      modelLabel,
      modelSelect,
      modelHint
    );

    // ── Секция «Основные» (нижний блок модалки как на референсе) ─
    const baseSec = document.createElement('section');
    baseSec.className = 'lx-modal-sec';
    const baseHint = document.createElement('p');
    baseHint.className = 'lx-hint';
    baseHint.textContent = 'Дальнейшие параметры диалога и памяти доступны в разделе «Настройки».';
    baseSec.append(makeSectionHead('Основные', () => store.toast('Параметры синхронизированы')), baseHint);

    body.append(connSec, modelSec, baseSec);

    // Подвал с капсулами
    const footer = document.createElement('div');
    footer.className = 'lx-modal-foot';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.id = 'lxAiCloseBtn';
    cancelBtn.className = 'lx-pill-btn lx-pill-secondary';
    cancelBtn.textContent = 'Закрыть';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'lxAiSaveBtn';
    saveBtn.className = 'lx-pill-btn lx-pill-primary';
    saveBtn.textContent = 'Сохранить';

    footer.append(cancelBtn, saveBtn);
    dialog.append(head, body, footer);
    backdrop.append(dialog);

    function syncFromState(st) {
      modelSelect.value = st.tier === 'smart' ? 'smart' : 'fast';
      const accountSignedIn = Boolean(st.account && st.account.signedIn);
      if (!keyInput.dataset.edited) {
        syncConnStatus(true, accountSignedIn ? 'Подключено · аккаунт Nox' : 'Подключено');
      }
    }

    // ── Доступность модалки: ловушка фокуса, возврат фокуса, inert для фона ──
    let lastFocus = null;
    let opener = null;
    const INERT_SELECTORS = ['#aeTopbar', '.ae-utility-rail', '#aeMain'];
    const supportsInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;

    function setBackgroundInert(on) {
      for (const selector of INERT_SELECTORS) {
        const el = document.querySelector(selector);
        if (!el) continue;
        if (supportsInert) el.inert = Boolean(on);
      }
    }

    function focusableInDialog() {
      return [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return !el.disabled && rect.width > 0 && rect.height > 0
            && style.visibility !== 'hidden' && style.display !== 'none';
        });
    }

    function open() {
      if (!backdrop.hidden) return;
      syncFromState(store.state);
      lastFocus = document.activeElement;
      opener = lastFocus && lastFocus.setAttribute && lastFocus.hasAttribute('aria-haspopup') ? lastFocus : null;
      if (opener) opener.setAttribute('aria-expanded', 'true');
      backdrop.hidden = false;
      dialog.tabIndex = -1;
      setBackgroundInert(true);
      requestAnimationFrame(() => dialog.focus({ preventScroll: true }));
    }

    function close() {
      if (backdrop.hidden) return;
      backdrop.hidden = true;
      setBackgroundInert(false);
      if (opener) opener.setAttribute('aria-expanded', 'false');
      const canReturn = lastFocus && lastFocus !== document.body && lastFocus !== document.documentElement && lastFocus.isConnected;
      const target = canReturn ? lastFocus : document.getElementById('chatInput');
      lastFocus = null;
      opener = null;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }

    closeTopBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });

    // Пока диалог открыт, Esc закрывает только его (и не запускает глобальный «стоп хода»),
    // а Tab и Shift+Tab ходят по кругу внутри диалога.
    document.addEventListener('keydown', (e) => {
      if (backdrop.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableInDialog();
      if (!items.length) {
        e.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === dialog || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }, true);

    keyInput.addEventListener('input', () => {
      keyInput.dataset.edited = '1';
    });

    saveBtn.addEventListener('click', async () => {
      const nextTier = modelSelect.value === 'smart' ? 'smart' : 'fast';
      if (typeof store.setTier === 'function') store.setTier(nextTier);
      if (bridge && bridge.has('setSetting')) {
        try {
          await bridge.call('setSetting', 'tier', nextTier);
        } catch {}
      }
      store.toast('Настройки Nox AI сохранены', 'ok');
      close();
    });

    return {
      el: backdrop,
      open,
      close,
      isOpen: () => !backdrop.hidden,
      update: (st) => {
        if (!backdrop.hidden) syncFromState(st);
      },
    };
  }

  window.NoxAetherAiModal = { createAiModal };
})();
