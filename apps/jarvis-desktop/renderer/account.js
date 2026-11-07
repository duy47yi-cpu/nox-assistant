/* Аккаунт Nox: экран входа, расход в Настройках, пауза на лимите. Без сервера (своя сборка с ключом) файл ничего не показывает. */
(() => {
  'use strict';

  const api = window.jarvis;
  if (!api || !api.accountState) return;

  const clock = (ms) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...kids.filter(Boolean));
    return node;
  };

  // ── Вход ──
  let mode = 'register';
  const email = el('input', { class: 'input', type: 'email', id: 'acEmail', autocomplete: 'email', required: 'required' });
  const password = el('input', { class: 'input', type: 'password', id: 'acPassword', autocomplete: 'new-password', minlength: '8', required: 'required' });
  const error = el('p', { class: 'account-error', role: 'alert', hidden: 'hidden' });
  const title = el('h1', { class: 'account-title' });
  const hint = el('p', { class: 'account-hint' });
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' });
  const swap = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { mode = mode === 'register' ? 'login' : 'register'; paintForm(); } });
  const form = el('form', { class: 'account-card', onsubmit: send },
    title, hint,
    el('label', { class: 'account-field', for: 'acEmail' }, el('span', { text: 'Почта' }), email),
    el('label', { class: 'account-field', for: 'acPassword' }, el('span', { text: 'Пароль, от 8 символов' }), password),
    error, submit, swap);
  const gate = el('div', { class: 'account-gate', hidden: 'hidden' }, form);

  function paintForm() {
    const reg = mode === 'register';
    title.textContent = reg ? 'Первый запуск Nox' : 'С возвращением';
    hint.textContent = reg ? 'Создайте аккаунт: пробный период начнётся сразу, карта не нужна.' : 'Войдите, и Джарвис продолжит работу.';
    submit.textContent = reg ? 'Создать аккаунт' : 'Войти';
    swap.textContent = reg ? 'У меня уже есть аккаунт' : 'Создать новый аккаунт';
    password.autocomplete = reg ? 'new-password' : 'current-password';
    error.hidden = true;
  }

  async function send(e) {
    e.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      const r = await (mode === 'register' ? api.accountRegister : api.accountLogin)(email.value.trim(), password.value);
      if (!r || !r.ok) {
        error.textContent = (r && r.error) || 'Не получилось, попробуйте ещё раз';
        error.hidden = false;
        return;
      }
      password.value = '';
      await refresh();
    } finally {
      submit.disabled = false;
    }
  }

  // ── Настройки: тариф и расход ──
  const meter = (label) => {
    const fill = el('i', { class: 'usage-fill' });
    const note = el('span', { class: 'usage-note' });
    const bar = el('span', { class: 'usage-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
    return {
      node: el('div', { class: 'usage-row' }, el('span', { class: 'usage-name', text: label }), bar, note),
      set({ percent, resetAt }) {
        fill.style.width = `${percent}%`;
        fill.dataset.full = String(percent >= 100);
        bar.setAttribute('aria-valuenow', String(percent));
        note.textContent = `${percent} %${resetAt ? ` · сброс ${clock(resetAt)}` : ''}`;
      },
    };
  };
  const session = meter('За 5 часов');
  const week = meter('За неделю');
  const who = el('span', { class: 'set-name' });
  const plan = el('span', { class: 'set-hint' });
  const logout = el('button', { class: 'btn btn-secondary btn-sm', type: 'button', text: 'Выйти', onclick: async () => { await api.accountLogout(); refresh(); } });
  const panel = el('section', { class: 'set-section', 'aria-label': 'Аккаунт', hidden: 'hidden' },
    el('h2', { class: 'set-title', text: 'Аккаунт и лимиты' }),
    el('div', { class: 'set-row' }, el('span', { class: 'set-text' }, who, plan), logout),
    session.node, week.node);

  function paintAccount(a) {
    who.textContent = a.email;
    const trial = a.plan === 'trial' && a.trialUntil ? `, до ${new Date(a.trialUntil).toLocaleDateString('ru-RU')}` : '';
    plan.textContent = `Тариф: ${a.planTitle}${trial}`;
    session.set(a.limits.session);
    week.set(a.limits.week);
  }

  async function refresh() {
    let st;
    try {
      st = await api.accountState();
    } catch {
      return;
    }
    local.hidden = Boolean(st && st.enabled);
    if (!st || !st.enabled) return;
    gate.hidden = st.signedIn;
    panel.hidden = !st.signedIn || !st.account;
    if (st.account) paintAccount(st.account);
    if (!st.signedIn) { paintForm(); email.focus(); }
  }

  // ── Пауза на лимите ──
  const banner = el('div', { class: 'limit-banner', role: 'status', hidden: 'hidden' });
  api.onEvent((ev) => {
    if (ev.type === 'limit_pause') {
      const what = ev.window === 'week' ? 'Недельный лимит' : 'Лимит на 5 часов';
      banner.textContent = `${what} исчерпан. Работа сохранена и продолжится сама: ${clock(ev.resetAt)}.`;
      banner.hidden = false;
      refresh();
    } else if (ev.type === 'limit_resume') {
      banner.hidden = true;
      refresh();
    } else if (ev.type === 'done') {
      refresh();
    }
  });

  // Раздел «Аккаунт»: свой аккаунт и лимиты или пояснение, что вход не нужен.
  const local = el('section', { class: 'set-section', 'aria-label': 'Аккаунт' },
    el('h2', { class: 'set-title', text: 'Вход не нужен' }),
    el('p', { class: 'set-hint', text: 'Это сборка со своими ключами модели: аккаунт Nox, тариф и лимиты здесь не используются. Всё хранится на этом компьютере.' }));

  function mount() {
    document.body.append(gate, banner);
    const page = document.getElementById('accountPage');
    if (page) page.append(panel, local);
    else {
      const settings = document.querySelector('[data-view="settings"] .set-section');
      if (settings) settings.parentNode.insertBefore(panel, settings);
    }
    paintForm();
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
