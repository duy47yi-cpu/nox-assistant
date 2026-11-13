/* Экран чата Nox Aether:
 * - единая композиция диалога и сферы (#noxChat + OrbStage через родительский контейнер);
 * - при действительно пустом чате строка ввода по центру;
 * - при первой отправке — плавная FLIP-анимация в нижний док (или мгновенно при reduced-motion);
 * - при открытии непустого чата из истории — сразу внизу без лишней анимации;
 * - минимальный шум: не более 1 спокойной строки состояния во время работы, все шаги/доказательства/источники — в «Подробности»;
 * - все 8 состояний: пустой, диалог, длинный ответ, работа инструментов, подтверждение, ошибка+повтор, голос, узкое/широкое окно. */
(() => {
  'use strict';

  const FALLBACK_STARTERS = [
    'С чего лучше начать день?',
    'Проверь, что сейчас открыто на компьютере',
    'Помоги составить короткий план на неделю',
  ];

  function createChatView({ store, bridge, orbStage }) {
    const ui = window.JarvisUI || {};
    const md = window.NoxAetherMarkdown;
    const { icon } = window.NoxAetherIcons;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');
    const toolTitle = typeof ui.toolTitle === 'function' ? ui.toolTitle : (t) => String(t || 'Шаг');
    const statusOfResult = typeof ui.statusOfResult === 'function' ? ui.statusOfResult : () => ({ ok: true, label: 'Готово' });
    const argsPretty = typeof ui.argsPretty === 'function' ? ui.argsPretty : () => '';

    const root = document.createElement('section');
    root.className = 'ae-chat-view is-empty';
    root.id = 'noxChat';
    root.setAttribute('aria-label', 'Чат с Nox');

    // Верхний баннер статуса (лимит / пауза / важное предупреждение — по умолчанию скрыт)
    const bannerWrap = document.createElement('div');
    bannerWrap.className = 'ae-banner-wrap';
    bannerWrap.id = 'bannerWrap';
    bannerWrap.hidden = true;

    const column = document.createElement('div');
    column.className = 'ae-chat-column';

    // Область пустого чата (центрируется над полем ввода)
    const emptyHero = document.createElement('div');
    emptyHero.className = 'ae-empty-hero';

    const emptyTitle = document.createElement('h1');
    emptyTitle.className = 'ae-empty-title';
    emptyTitle.textContent = 'С чего начнём?';

    const emptySub = document.createElement('p');
    emptySub.className = 'ae-empty-sub';
    emptySub.textContent = 'Задайте вопрос, попросите выполнить действие или приложите файл.';

    const starterRow = document.createElement('div');
    starterRow.className = 'ae-starters';

    emptyHero.append(emptyTitle, emptySub, starterRow);

    // Лента сообщений
    const feedWrap = document.createElement('div');
    feedWrap.className = 'ae-feed-wrap';
    feedWrap.hidden = true;

    const feed = document.createElement('div');
    feed.className = 'ae-feed';
    feed.id = 'feed';
    feed.setAttribute('role', 'log');
    feed.setAttribute('aria-live', 'polite');

    const toBottomBtn = document.createElement('button');
    toBottomBtn.type = 'button';
    toBottomBtn.id = 'toBottom';
    toBottomBtn.className = 'ae-to-bottom';
    toBottomBtn.hidden = true;
    toBottomBtn.setAttribute('aria-label', 'К последним сообщениям');
    toBottomBtn.append(icon('arrowDown'), (() => { const s = document.createElement('span'); s.textContent = 'Вниз'; return s; })());

    feedWrap.append(feed, toBottomBtn);

    // Слот подтверждения (показывается над полем ввода, фокусируя внимание без шума)
    const approvalCard = window.NoxAetherApprovalCard.createApprovalCard({ store });

    // Поле ввода (единый экземпляр без пересоздания при переходе empty -> docked)
    let stickBottom = true;
    let captureBeforeSendRect = null;

    const composer = window.NoxAetherComposer.createComposer({
      store,
      bridge,
      onSendTrigger: () => {
        if (store.isEmptyChat()) {
          captureBeforeSendRect = dockWrap.getBoundingClientRect();
        }
        stickBottom = true;
      },
      onTyping: (text, caret) => {
        if (orbStage) {
          orbStage.setComposer(text);
          if (text.length) orbStage.gesture('type', caret);
        }
      },
    });

    const dockWrap = document.createElement('div');
    dockWrap.className = 'ae-composer-dock';
    dockWrap.append(approvalCard.el, composer.el);

    column.append(feedWrap, emptyHero, dockWrap);
    root.append(bannerWrap, column);

    // Загрузка подсказок из библиотеки (до 3-4 аккуратных вариантов для пустого экрана)
    let loadedStarters = FALLBACK_STARTERS.slice();
    async function loadStarterChips() {
      if (bridge.has('libraryList')) {
        try {
          const list = await bridge.call('libraryList');
          if (Array.isArray(list) && list.length) {
            const picked = [];
            const seenCats = new Set();
            for (const c of list) {
              if (!c || !c.phrase) continue;
              const cat = c.category || 'all';
              if (!seenCats.has(cat)) {
                seenCats.add(cat);
                picked.push(c.phrase);
              }
              if (picked.length >= 3) break;
            }
            if (picked.length) loadedStarters = picked;
          }
        } catch { /* fallback */ }
      }
      renderStarters();
    }

    function renderStarters() {
      starterRow.replaceChildren();
      for (const phrase of loadedStarters.slice(0, 3)) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ae-starter-chip';
        chip.textContent = phrase;
        chip.addEventListener('click', () => composer.setValueAndSend(phrase));
        starterRow.append(chip);
      }
    }
    renderStarters();

    // Управление прокруткой ленты
    function isNearBottom() {
      return (feed.scrollHeight - feed.scrollTop - feed.clientHeight) <= 52;
    }

    function scrollBottom(force = false) {
      if (!force && !stickBottom) return;
      feed.scrollTop = feed.scrollHeight;
      toBottomBtn.hidden = true;
    }

    feed.addEventListener('scroll', () => {
      const near = isNearBottom();
      stickBottom = near;
      toBottomBtn.hidden = near || feedWrap.hidden;
    }, { passive: true });

    toBottomBtn.addEventListener('click', () => {
      stickBottom = true;
      scrollBottom(true);
      composer.focus();
    });

    function openSourceUrl(url) {
      if (!url) return;
      if (bridge.has('openSource')) bridge.call('openSource', url).catch(() => {});
      else if (bridge.has('openUrl')) bridge.call('openUrl', url).catch(() => {});
    }

    let pendingFocusTurnId = null;

    function buildDetailsPanel(turn) {
      const acts = Array.isArray(turn.actions) ? turn.actions : [];
      const srcs = Array.isArray(turn.sources) ? turn.sources : [];
      if (!acts.length && !srcs.length) return null;

      const wrap = document.createElement('div');
      wrap.className = 'ae-details-wrap';

      const parts = [];
      if (acts.length) parts.push(`действий: ${acts.length}`);
      if (srcs.length) parts.push(`источников: ${srcs.length}`);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ae-details-toggle';
      toggle.setAttribute('aria-expanded', String(Boolean(turn.detailsOpen)));
      toggle.append(
        icon(turn.detailsOpen ? 'chevronDown' : 'chevronRight', 'ae-details-chev'),
        (() => {
          const sp = document.createElement('span');
          sp.textContent = turn.detailsOpen ? 'Скрыть подробности' : `Подробности (${parts.join(', ')})`;
          return sp;
        })()
      );
      toggle.addEventListener('click', () => {
        pendingFocusTurnId = turn.id;
        store.toggleTurnDetails(turn.id);
      });
      wrap.append(toggle);

      if (turn.detailsOpen) {
        const panel = document.createElement('div');
        panel.className = 'ae-details-panel';

        if (acts.length) {
          const actList = document.createElement('div');
          actList.className = 'ae-details-actions';
          for (const a of acts) {
            const row = document.createElement('div');
            row.className = 'ae-act-row';

            const top = document.createElement('div');
            top.className = 'ae-act-top';
            const title = document.createElement('span');
            title.className = 'ae-act-name';
            title.textContent = toolTitle(a.tool);

            const stInfo = a.status === 'done'
              ? statusOfResult({ ok: a.ok !== false, text: a.summary || '', verified: a.verified })
              : { ok: a.status !== 'failed', label: a.status === 'running' ? 'Выполняется' : (a.status === 'waiting' ? 'Ждёт решения' : 'Выполнено') };

            const badge = document.createElement('span');
            badge.className = stInfo.ok === false ? 'ae-act-state is-err' : (a.verified === true ? 'ae-act-state is-ok' : 'ae-act-state');
            badge.textContent = a.verified === true ? 'Проверено' : (stInfo.label || 'Готово');

            top.append(title, badge);
            row.append(top);

            if (a.summary) {
              const sum = document.createElement('div');
              sum.className = 'ae-act-summary';
              sum.textContent = scrub(a.summary);
              row.append(sum);
            }
            const argStr = a.args ? argsPretty(a.args) : '';
            if (argStr) {
              const argsEl = document.createElement('pre');
              argsEl.className = 'ae-act-args';
              argsEl.textContent = scrub(argStr).slice(0, 320);
              row.append(argsEl);
            }
            actList.append(row);
          }
          panel.append(actList);
        }

        if (srcs.length) {
          const srcWrap = document.createElement('div');
          srcWrap.className = 'ae-details-sources';
          const h = document.createElement('div');
          h.className = 'ae-sources-title';
          h.textContent = 'Источники';
          srcWrap.append(h);
          for (const s of srcs) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ae-source-card';
            const st = document.createElement('span');
            st.className = 'ae-source-name';
            st.textContent = scrub(s.title || s.domain || s.url || 'Источник');
            const urlSp = document.createElement('span');
            urlSp.className = 'ae-source-url';
            urlSp.textContent = scrub(s.domain || s.url || '');
            btn.append(st, urlSp, icon('external', 'ae-source-ext'));
            btn.addEventListener('click', () => openSourceUrl(s.url));
            srcWrap.append(btn);
          }
          panel.append(srcWrap);
        }

        wrap.append(panel);
      }

      return wrap;
    }

    function renderTurnItem(item, { isActive = false, isLastError = false } = {}) {
      if (item.kind === 'user') {
        const msg = document.createElement('article');
        msg.className = 'ae-msg is-user';
        msg.dataset.id = item.id;

        const bubble = document.createElement('div');
        bubble.className = 'ae-user-bubble';
        const txt = document.createElement('div');
        txt.className = 'ae-user-text';
        txt.textContent = item.text || '';
        bubble.append(txt);

        if (Array.isArray(item.files) && item.files.length) {
          const fl = document.createElement('div');
          fl.className = 'ae-user-files';
          for (const f of item.files) {
            const tag = document.createElement('span');
            tag.className = 'ae-user-file-tag';
            tag.textContent = f.name || 'Файл';
            fl.append(tag);
          }
          bubble.append(fl);
        }
        msg.append(bubble);
        return msg;
      }

      if (item.kind === 'error') {
        const card = document.createElement('article');
        card.className = 'ae-msg is-error';
        card.dataset.id = item.id;

        const row = document.createElement('div');
        row.className = 'ae-error-card';

        const head = document.createElement('div');
        head.className = 'ae-error-head';
        head.append(icon('alert', 'ae-error-ico'));
        const msgEl = document.createElement('span');
        msgEl.className = 'ae-error-text';
        msgEl.textContent = scrub(item.text || 'Не удалось выполнить запрос');
        head.append(msgEl);
        row.append(head);

        const bar = document.createElement('div');
        bar.className = 'ae-error-actions';

        if (isLastError && store.state.lastSentPayload && !store.state.trackerBusy) {
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          retryBtn.append(icon('refresh'), (() => { const s = document.createElement('span'); s.textContent = 'Повторить'; return s; })());
          retryBtn.addEventListener('click', () => {
            const p = store.state.lastSentPayload;
            if (p) store.sendChatMessage(p.text, p.files);
          });
          bar.append(retryBtn);
        }

        const techText = String(item.technical || item.rawText || '').trim();
        if (techText && techText !== item.text) {
          const detailsEl = document.createElement('details');
          detailsEl.className = 'ae-tech-details';
          const sum = document.createElement('summary');
          sum.textContent = 'Технические детали';
          const pre = document.createElement('pre');
          pre.textContent = scrub(techText);
          detailsEl.append(sum, pre);
          bar.append(detailsEl);
        }

        if (bar.childElementCount) row.append(bar);
        card.append(row);
        return card;
      }

      if (item.kind === 'notice') {
        const n = document.createElement('div');
        n.className = 'ae-msg is-notice';
        n.textContent = scrub(item.text || '');
        return n;
      }

      if (item.kind === 'task') {
        const t = document.createElement('div');
        t.className = 'ae-msg is-task';
        const line = document.createElement('div');
        line.className = 'ae-task-pill';
        line.textContent = scrub(item.summary || item.title || 'Задача обновлена');
        t.append(line);
        return t;
      }

      // Сообщение ассистента (включая активный поток)
      const msg = document.createElement('article');
      msg.className = isActive ? 'ae-msg is-assistant is-live' : 'ae-msg is-assistant';
      msg.dataset.id = item.id;

      // Во время активной работы — не более ОДНОЙ спокойной строки прогресса (без многострочного спама)
      if (isActive) {
        const liveText = store.getLiveWorkText() || 'Готовлю ответ…';
        const statusLine = document.createElement('div');
        statusLine.className = 'ae-live-line';
        const dot = document.createElement('span');
        dot.className = 'ae-live-dot';
        dot.setAttribute('aria-hidden', 'true');
        const stLabel = document.createElement('span');
        stLabel.className = 'ae-live-text';
        const sec = Number.isFinite(item.startedAt) ? Math.max(0, (Date.now() - item.startedAt) / 1000) : 0;
        stLabel.textContent = liveText === 'Ход работы · Выполняется'
          ? `${liveText} ${sec.toFixed(1)} с`
          : `${liveText} · ${sec.toFixed(1)} с`;
        liveTextNode = stLabel;
        statusLine.append(dot, stLabel);
        msg.append(statusLine);
      }

      if (item.text) {
        const body = document.createElement('div');
        body.className = 'ae-assistant-body';
        body.append(md.renderMarkdown(item.text, { onOpenUrl: openSourceUrl }));

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ae-msg-copy';
        copyBtn.title = 'Скопировать ответ';
        copyBtn.setAttribute('aria-label', 'Скопировать ответ');
        copyBtn.append(icon('copy'));
        copyBtn.addEventListener('click', async () => {
          const ok = await md.copyPlain(item.text);
          if (ok) {
            copyBtn.replaceChildren(icon('check'));
            setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1500);
          }
        });
        body.append(copyBtn);
        msg.append(body);
      }

      const details = buildDetailsPanel(item);
      if (details) msg.append(details);

      return msg;
    }

    function renderBanner(st) {
      if (st.link === 'none') {
        bannerWrap.hidden = false;
        const b = document.createElement('div');
        b.className = 'ae-banner is-warn';
        b.textContent = 'Открыто в автономном режиме предпросмотра: связь с ядром отключена.';
        bannerWrap.replaceChildren(b);
        return;
      }
      if (!st.hasKey && !st.account.signedIn && st.link === 'electron') {
        bannerWrap.hidden = false;
        const b = document.createElement('div');
        b.className = 'ae-banner is-info';
        const sp = document.createElement('span');
        sp.textContent = 'Чтобы отправлять запросы, подключите аккаунт или ключ в Настройках.';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ae-link-btn';
        btn.textContent = 'Открыть Настройки';
        btn.addEventListener('click', () => store.setRoute('settings'));
        b.append(sp, btn);
        bannerWrap.replaceChildren(b);
        return;
      }
      bannerWrap.hidden = true;
      bannerWrap.replaceChildren();
    }

    let wasEmptyPrev = true;
    let lastFeedSig = '';
    let liveTextNode = null;
    let liveElapsedTimer = null;

    function syncLiveTimer(active) {
      if (active && !liveElapsedTimer) {
        liveElapsedTimer = setInterval(() => {
          const t = store.state.activeTurn;
          if (!t || !liveTextNode || !liveTextNode.isConnected) return;
          const base = store.getLiveWorkText() || 'Готовлю ответ…';
          const sec = Number.isFinite(t.startedAt) ? Math.max(0, (Date.now() - t.startedAt) / 1000) : 0;
          liveTextNode.textContent = base === 'Ход работы · Выполняется'
            ? `${base} ${sec.toFixed(1)} с`
            : `${base} · ${sec.toFixed(1)} с`;
        }, 200);
      } else if (!active && liveElapsedTimer) {
        clearInterval(liveElapsedTimer);
        liveElapsedTimer = null;
        liveTextNode = null;
      }
    }

    function render(st) {
      renderBanner(st);
      approvalCard.render(st);
      composer.render(st);

      const isEmpty = store.isEmptyChat();
      const shouldAnim = store.consumeComposeAnim() || (wasEmptyPrev && !isEmpty && Boolean(captureBeforeSendRect));

      if (isEmpty) {
        root.classList.add('is-empty');
        root.classList.remove('is-docked');
        emptyHero.hidden = false;
        feedWrap.hidden = true;
        toBottomBtn.hidden = true;
        wasEmptyPrev = true;
        captureBeforeSendRect = null;
        return;
      }

      const beforeRect = captureBeforeSendRect || (wasEmptyPrev ? dockWrap.getBoundingClientRect() : null);
      captureBeforeSendRect = null;

      root.classList.remove('is-empty');
      root.classList.add('is-docked');
      emptyHero.hidden = true;
      feedWrap.hidden = false;

      if (wasEmptyPrev && shouldAnim && beforeRect && document.documentElement.dataset.animations !== 'off') {
        const afterRect = dockWrap.getBoundingClientRect();
        const dy = beforeRect.top - afterRect.top;
        if (Math.abs(dy) > 6 && typeof dockWrap.animate === 'function') {
          dockWrap.animate(
            [
              { transform: `translateY(${dy}px)`, opacity: 0.96 },
              { transform: 'translateY(0)', opacity: 1 },
            ],
            { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
          );
        }
      }
      wasEmptyPrev = false;

      // Сравнение сигнатуры ленты снижает лишнюю перестройку DOM во время частых тиков
      const active = st.activeTurn;
      const liveText = active ? store.getLiveWorkText() : '';
      const lastItem = st.feedItems[st.feedItems.length - 1];
      const sig = [
        st.activeChatId,
        st.feedItems.length,
        st.feedItems.map((x) => `${x.id}:${x.detailsOpen ? 1 : 0}:${(x.text || '').length}`).join(','),
        active ? `${active.id}:${active.text.length}:${active.actions.length}:${active.sources.length}:${active.detailsOpen ? 1 : 0}:${liveText}` : '',
        st.trackerBusy ? '1' : '0',
      ].join('|');

      if (sig !== lastFeedSig) {
        lastFeedSig = sig;
        const frag = document.createDocumentFragment();
        const len = st.feedItems.length;
        for (let i = 0; i < len; i += 1) {
          const item = st.feedItems[i];
          const isLastErr = item.kind === 'error' && item === lastItem;
          frag.append(renderTurnItem(item, { isActive: false, isLastError: isLastErr }));
        }
        if (active) {
          frag.append(renderTurnItem({ ...active, kind: 'assistant' }, { isActive: true }));
        }
        feed.replaceChildren(frag);
        if (pendingFocusTurnId) {
          const focusId = pendingFocusTurnId;
          pendingFocusTurnId = null;
          const msgs = feed.querySelectorAll('.ae-msg');
          for (const m of msgs) {
            if (m.dataset.id === focusId) {
              const btn = m.querySelector('.ae-details-toggle');
              if (btn) btn.focus({ preventScroll: true });
              break;
            }
          }
        }
        scrollBottom(false);
      }
      syncLiveTimer(Boolean(active));
    }

    loadStarterChips();

    return {
      el: root,
      focusComposer: () => composer.focus(),
      render,
      destroy: () => {
        if (liveElapsedTimer) clearInterval(liveElapsedTimer);
      },
    };
  }

  window.NoxAetherChatView = { createChatView };
})();
