'use strict';

// Доступность Nox Aether: статические контракты компонентов и объявления store.
// Поведение в настоящем окне (Tab/Esc, фокус, ловушка модалки, aria-live) проверяет
// scripts/aether-a11y-qa.js на 1200x720 и 864x520 — отдельный живой стенд.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AETHER = path.join(__dirname, '..', 'renderer', 'aether');
const read = (file) => fs.readFileSync(path.join(AETHER, file), 'utf8');
const TOPBAR = read(path.join('components', 'topbar.js'));
const COMPOSER = read(path.join('components', 'composer.js'));
const CHAT = read(path.join('components', 'chat-view.js'));
const APPROVAL = read(path.join('components', 'approval-card.js'));
const MODAL = read(path.join('components', 'ai-modal.js'));
const STORE = read('store.js');

const has = (source, needle, message) => assert.ok(source.includes(needle), message || ('не найдено: ' + needle));

test('Шапка: вкладки — один шаг Tab (roving tabindex) и связаны с разделом', () => {
  has(TOPBAR, "aria-controls', item.panel");
  has(TOPBAR, 'btn.tabIndex = -1');
  has(TOPBAR, 'btn.tabIndex = active ? 0 : -1');
  has(TOPBAR, 'function go(next)');
  has(TOPBAR, 'next.focus();');
  has(TOPBAR, 'next.click();');
});

test('Шапка: меню режима и быстрые настройки закрываются Esc и возвращают фокус', () => {
  has(TOPBAR, "modeMenu.id = 'aeModeMenu'");
  has(TOPBAR, "aria-labelledby', 'aeModePill'");
  has(TOPBAR, "e.key === 'ArrowDown'");
  has(TOPBAR, "e.key === 'ArrowUp'");
  has(TOPBAR, "quickBtn.id = 'aeQuickBtn'");
  has(TOPBAR, 'if (quick.hidden && modeMenu.hidden) return;');
  has(TOPBAR, 'const quickWasOpen = !quick.hidden;');
  has(TOPBAR, '(quickWasOpen ? quickBtn : modeBtn).focus();');
  has(TOPBAR, "}, true);");
  has(TOPBAR, 'Свернуть окно');
});

test('Композер: Esc закрывает меню модели, фокус виден на скрытом radio', () => {
  has(COMPOSER, "input.addEventListener('focus'");
  has(COMPOSER, "sp.style.outline = '2px solid var(--accent, #58D9E8)'");
  has(COMPOSER, "if (e.key !== 'Escape' || pickPanel.hidden) return;");
  has(COMPOSER, 'pickTrigger.focus();');
});

test('Композер: фокус не теряется после отправки и стопа', () => {
  has(COMPOSER, 'if (document.activeElement === sendBtn) ta.focus({ preventScroll: true });');
  has(COMPOSER, 'const hadFocus = document.activeElement === sendBtn;');
  has(COMPOSER, 'if (hadFocus && sendBtn.disabled) ta.focus({ preventScroll: true });');
  has(COMPOSER, 'ta.focus({ preventScroll: true });');
});

test('Модалка: aria-modal, inert фона, ловушка Tab и возврат фокуса, Esc в capture', () => {
  has(MODAL, "aria-modal', 'true'");
  has(MODAL, "const INERT_SELECTORS = ['#aeTopbar', '.ae-utility-rail', '#aeMain']");
  has(MODAL, 'focusableInDialog');
  has(MODAL, "if (e.key !== 'Tab') return;");
  has(MODAL, 'e.shiftKey');
  has(MODAL, 'const canReturn = lastFocus && lastFocus !== document.body');
  has(MODAL, '}, true);');
  has(MODAL, "closeTopBtn.setAttribute('aria-label', 'Закрыть настройки Nox AI');");
});

test('Подтверждение: ARIA-связи, скрытое объявление и клавиатура', () => {
  assert.doesNotMatch(APPROVAL, /root\.setAttribute\('aria-live', 'assertive'\)/);
  has(APPROVAL, "'aria-labelledby'");
  has(APPROVAL, 'aeApprovalTitle-');
  has(APPROVAL, "'aria-describedby'");
  has(APPROVAL, 'aeApprovalSummary-');
  has(APPROVAL, "el.setAttribute('role', 'alert')");
  has(APPROVAL, 'ae-day-sr-only');
  has(APPROVAL, "aria-keyshortcuts', 'Escape'");
  has(APPROVAL, "if (e.key !== 'Escape') return;");
  has(APPROVAL, 'returnFocusToComposer = true');
  has(APPROVAL, 'restoreFocus(focusBefore, card)');
  has(APPROVAL, 'returnFocusToComposer ||');
});

test('Лента чата: aria-live ответа и ошибок, фокус возвращается после пересборки', () => {
  has(CHAT, "feed.setAttribute('aria-label', 'Лента сообщений')");
  has(CHAT, "card.setAttribute('role', 'alert')");
  has(CHAT, "card.setAttribute('aria-live', 'assertive')");
  has(CHAT, "answerAnnouncer.id = 'aeAnswerAnnouncer'");
  has(CHAT, "answerAnnouncer.setAttribute('aria-live', 'polite')");
  has(CHAT, 'function restoreFeedFocus');
  has(CHAT, 'restoreFeedFocus(feedFocus)');
  has(CHAT, 'announceFinished(st)');
});

test('Скрытые объявления не используют inline-стили (CSP окна запрещает style-src unsafe-inline)', () => {
  for (const [name, source] of [['approval-card.js', APPROVAL], ['chat-view.js', CHAT]]) {
    assert.doesNotMatch(source, /setAttribute\('style'/, name + ': inline style под CSP запрещён');
  }
});

// ── store.announce: объявление для экранного диктора без DOM ────────────────
const { createStore } = require('../renderer/aether/store');

function memStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}
function fakeBridge() {
  return {
    ensureBridge: async () => 'electron',
    has: () => false,
    call: async () => ({ ok: true }),
    errText: (err) => (err && err.message) || String(err),
  };
}

test('store.announce: спокойное объявление с новым id и без пустого текста', () => {
  const store = createStore({ bridge: fakeBridge(), storage: memStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  assert.equal(typeof store.announce, 'function');
  assert.equal(store.state.announcement, null);

  let notified = 0;
  store.subscribe(() => { notified += 1; });

  store.announce('   ');
  assert.equal(store.state.announcement, null, 'пустое объявление не создаётся');
  assert.equal(notified, 0);

  store.announce('Ответ скопирован.');
  const first = store.state.announcement;
  assert.ok(first && first.id, 'у объявления есть id');
  assert.match(first.text, /Ответ скопирован/);
  assert.equal(notified, 1);

  store.announce('Выполнение остановлено.');
  const second = store.state.announcement;
  assert.notEqual(second.id, first.id, 'каждое объявление отличается по id');
  assert.match(second.text, /остановлено/);
  assert.equal(notified, 2);
});

test('store.announce: длинный текст не раздувает состояние', () => {
  const store = createStore({ bridge: fakeBridge(), storage: memStorage(), ui: { scrub: (s) => s, toolTitle: (t) => t } });
  store.announce('я'.repeat(2000));
  assert.equal(store.state.announcement.text.length, 400);
});
