/* Аккаунт и лимиты на левой панели. */
(() => {
  'use strict';

  const WINDOWS = [
    ['day', 'Дневной лимит'],
    ['week', 'Недельный лимит'],
    ['session', 'Лимит на 5 часов'],
  ];
  const resetTime = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const percentUsed = (limit) => Number.isFinite(limit?.percent)
    ? Math.max(0, Math.min(100, limit.percent))
    : null;

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function createAccountPanel({ store, bridge }) {
    const { icon } = window.NoxAetherIcons;
    const controls = node('div', 'ae-account-controls');
    let active = null;
    let formMode = '';

    function createPopover(id, label, buttonClass) {
      const trigger = node('button', buttonClass);
      trigger.type = 'button';
      trigger.id = `${id}Trigger`;
      trigger.title = label;
      trigger.setAttribute('aria-label', label);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', 'false');

      const panel = node('section', 'ae-account-panel');
      panel.id = `${id}Panel`;
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      trigger.setAttribute('aria-controls', panel.id);
      const head = node('div', 'ae-account-head');
      const title = node('h2', '', label);
      title.id = `${id}Title`;
      panel.setAttribute('aria-labelledby', title.id);
      const closeBtn = node('button', 'ae-icon-btn');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', `Закрыть «${label}»`);
      closeBtn.append(icon('x'));
      head.append(title, closeBtn);
      const body = node('div', 'ae-account-body');
      panel.append(head, body);
      const popover = { trigger, panel, body, closeBtn, rendered: undefined };
      trigger.addEventListener('click', () => active === popover ? close() : open(popover));
      closeBtn.addEventListener('click', () => close());
      controls.append(trigger, panel);
      return popover;
    }

    const usage = createPopover('aeLimits', 'Лимиты', 'ae-icon-btn ae-limits-trigger');
    const ring = node('span', 'ae-limits-ring');
    ring.setAttribute('aria-hidden', 'true');
    usage.trigger.append(ring);
    const profile = createPopover('aeAccount', 'Аккаунт', 'ae-account-trigger');
    profile.trigger.append(icon('user'));

    function close(restoreFocus = true) {
      if (!active) return;
      const { panel, trigger } = active;
      active = null;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus();
    }

    function open(popover) {
      close(false);
      active = popover;
      popover.panel.hidden = false;
      popover.trigger.setAttribute('aria-expanded', 'true');
      render(store.state);
      popover.closeBtn.focus();
      store.refreshAccount();
    }

    controls.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && active) {
        event.stopPropagation();
        close();
      }
    });
    document.addEventListener('click', (event) => {
      if (active && !controls.contains(event.target)) close(false);
    });

    function renderLimits(limits) {
      const group = node('div', 'ae-account-limits');
      for (const [key, label] of WINDOWS) {
        const limit = limits?.[key];
        if (key === 'session' && !limit) continue;
        const row = node('div', 'ae-account-limit');
        const heading = node('div', 'ae-account-limit-heading');
        heading.append(node('strong', '', label));
        const percent = percentUsed(limit);
        if (percent !== null) {
          const progress = node('progress', 'ae-account-meter');
          progress.max = 100;
          progress.value = percent;
          progress.setAttribute('aria-label', label);
          heading.append(node('span', '', `${percent}% использовано`));
          row.append(heading, progress);
          if (Number.isFinite(limit.resetAt) && limit.resetAt > 0) {
            row.append(node('span', 'ae-item-meta', `Обновится ${resetTime.format(limit.resetAt)}`));
          }
        } else {
          row.append(heading, node('span', 'ae-item-meta', 'Данные недоступны'));
        }
        group.append(row);
      }
      return group;
    }

    function renderRing(limits) {
      let highest = null;
      let period = '';
      for (const [key, label] of WINDOWS) {
        const percent = percentUsed(limits?.[key]);
        if (percent !== null && (highest === null || percent > highest)) {
          highest = percent;
          period = label;
        }
      }
      ring.classList.toggle('has-data', highest !== null);
      ring.style.setProperty('--used', `${highest ?? 0}%`);
      const label = highest === null ? 'Лимиты' : `Лимиты. ${period}: использовано ${highest}%`;
      usage.trigger.title = label;
      usage.trigger.setAttribute('aria-label', label);
    }

    function renderForm() {
      const form = node('form', 'ae-account-form');
      const email = node('input', 'ae-input');
      email.type = 'email';
      email.required = true;
      email.placeholder = 'Почта';
      email.autocomplete = 'email';
      email.setAttribute('aria-label', 'Почта');
      const password = node('input', 'ae-input');
      password.type = 'password';
      password.required = true;
      password.placeholder = 'Пароль';
      password.autocomplete = 'current-password';
      password.setAttribute('aria-label', 'Пароль');
      const error = node('p', 'ae-account-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      const buttons = node('div', 'ae-account-actions');
      const enter = node('button', 'ae-btn ae-btn-primary ae-btn-sm', 'Войти');
      enter.type = 'submit';
      const signup = node('button', 'ae-btn ae-btn-secondary ae-btn-sm', 'Создать аккаунт');
      signup.type = 'button';
      async function authenticate(method) {
        if (!form.reportValidity()) return;
        enter.disabled = signup.disabled = true;
        error.hidden = true;
        try {
          const result = await bridge.call(method, email.value.trim(), password.value);
          if (!result?.ok) throw new Error(result?.error || 'Не удалось выполнить запрос');
          password.value = '';
          await store.refreshAccount();
        } catch (err) {
          error.textContent = bridge.errText(err);
          error.hidden = false;
        } finally {
          enter.disabled = signup.disabled = false;
        }
      }
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        authenticate('accountLogin');
      });
      signup.addEventListener('click', () => authenticate('accountRegister'));
      buttons.append(enter, signup);
      form.append(email, password, error, buttons);
      return form;
    }

    function render(st) {
      const account = st.account;
      const details = account?.account;
      profile.trigger.dataset.signedIn = String(Boolean(details));
      renderRing(details?.limits);
      if (!active || account === active.rendered) return;
      const { body, closeBtn } = active;
      active.rendered = account;
      const signedOut = account?.enabled && !account.offline && !account.signedIn;
      if (active === profile) {
        if (signedOut && formMode === 'signed-out') return;
        formMode = signedOut ? 'signed-out' : '';
      }
      const restoreFocus = body.contains(document.activeElement);
      body.replaceChildren();
      if (!account) {
        body.append(node('p', 'ae-muted', active === usage ? 'Загружаю лимиты…' : 'Загружаю аккаунт…'));
      } else if (!account.enabled) {
        body.append(node('p', 'ae-muted', active === usage
          ? 'Лимиты аккаунта доступны при подключении к серверу Nox.'
          : 'Локальный режим.'));
      } else if (account.offline) {
        body.append(node('p', 'ae-muted', 'Сервер аккаунтов недоступен. Откройте панель снова, чтобы обновить данные.'));
      } else if (signedOut) {
        if (active === usage) {
          const enter = node('button', 'ae-btn ae-btn-secondary ae-btn-sm', 'Войти в аккаунт');
          enter.type = 'button';
          enter.addEventListener('click', () => open(profile));
          body.append(node('p', 'ae-muted', 'Войдите, чтобы увидеть лимиты.'), enter);
        } else {
          body.append(renderForm());
        }
      } else if (active === usage) {
        body.append(renderLimits(details?.limits));
      } else if (details) {
        const identity = node('div', 'ae-account-identity');
        identity.append(node('strong', '', details.email), node('span', 'ae-item-meta', details.planTitle || details.plan));
        const logout = node('button', 'ae-btn ae-btn-secondary ae-btn-sm', 'Выйти');
        logout.type = 'button';
        logout.addEventListener('click', async () => {
          logout.disabled = true;
          try {
            const result = await bridge.call('accountLogout');
            if (!result?.ok) throw new Error(result?.error || 'Не удалось выйти');
            await store.refreshAccount();
          } catch (err) {
            store.toast(bridge.errText(err), 'error');
          } finally {
            logout.disabled = false;
          }
        });
        body.append(identity, logout);
      }
      if (restoreFocus) closeBtn.focus();
    }

    return { el: controls, render, isOpen: () => Boolean(active) };
  }

  window.NoxAetherAccountPanel = { createAccountPanel };
})();
