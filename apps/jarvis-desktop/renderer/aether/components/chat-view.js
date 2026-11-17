/* Экран чата Nox Aether:
 * - единая композиция диалога и сферы (#noxChat + OrbStage через родительский контейнер);
 * - при действительно пустом чате строка ввода по центру;
 * - при первой отправке — плавная FLIP-анимация в нижний док (или мгновенно при reduced-motion);
 * - при открытии непустого чата из истории — сразу внизу без лишней анимации;
 * - подпись Nox и многоточие в ожидании, панель действий над вводом и короткий итог проверки;
 * - все 8 состояний: пустой, диалог, длинный ответ, работа инструментов, подтверждение, ошибка+повтор, голос, узкое/широкое окно. */
(() => {
  'use strict';

  const PARTIAL_LABELS = {
    done: 'Выполнено', failed: 'Не удалось выполнить', unverified: 'Не подтверждено',
  };
  const WORK_LABELS = {
    failed: 'Не выполнено', unverified: 'Не подтверждено', succeeded: 'Готово',
    partial: 'Выполнено частично', cancelled: 'Остановлено',
  };
  const ARTIFACT_ICONS = {
    pptx: 'layers', ppt: 'layers', odp: 'layers',
    xlsx: 'listChecks', xls: 'listChecks', ods: 'listChecks', csv: 'listChecks', tsv: 'listChecks',
  };
  const countPlural = new Intl.PluralRules('ru');

  function countLabel(value, words) {
    return `${value} ${words[countPlural.select(value)] || words.many}`;
  }
  const ACTION_LABELS = {
    confirmed: 'Результат проверен', unverified: 'Результат не подтверждён',
    failed: 'Проверка не прошла', error: 'Не удалось выполнить', refused: 'Действие отклонено',
    done: 'Выполнено', running: 'Выполняется', pending: 'Ждёт решения',
  };
  const SAVE_DENY_TOOLS = new Set([
    'mail_send', 'pc_shutdown', 'shell_run', 'app_close', 'ui_close_window',
    'app_install', 'windows_close_all', 'window_close_active',
    'forget', 'deal_clear', 'cancel_reminder',
  ]);
  const SAVE_FORBIDDEN_PREFIXES = ['mission_', 'command_'];
  const SAVE_READ_ONLY_TOOLS = new Set([
    'ui_windows', 'ui_elements', 'desktop_observe', 'windows_list',
    'screen_look', 'screen_region_look', 'image_look', 'image_read_text',
    'clipboard_get', 'workspace_read', 'workspace_list', 'workspace_search',
    'document_read', 'document_batch', 'project_brief', 'project_diagnostics',
    'project_commands', 'code_read', 'web_search', 'web_wiki', 'web_fetch',
    'web_research', 'web_check_claims', 'browser_read', 'browser_tab_read',
    'browser_tabs', 'browser_snapshot', 'recall', 'memory_about',
    'disk_free_space', 'disk_cleanup_suggest', 'weather_now', 'currency_rate',
    'calendar_upcoming', 'calendar_briefing', 'calendar_prep', 'mail_unread',
    'apps_find', 'apps_scan', 'apps_usage', 'app_search', 'deals_hanging',
    'list_reminders', 'library_list', 'skills_list', 'skill_read',
    'goal_list', 'long_task_list', 'task_list', 'command_list',
  ]);
  const SAVE_FAILED_STATUSES = new Set(['error', 'failed', 'refused', 'unverified', 'cancelled', 'canceled', 'pending', 'running', 'skipped']);

  function hasSaveableTurnActions(item, fallbackPhrase = '') {
    if (!item || item.kind !== 'assistant' || item.cancelled) return false;
    const phrase = String(item.userPhrase || fallbackPhrase || '').trim();
    if (phrase) {
      if (Array.from(phrase).length > 200) return false;
      const storeMod = typeof window !== 'undefined' ? window.NoxAetherStore : null;
      if (storeMod && typeof storeMod.buildClientCommandDraft === 'function') {
        const probe = storeMod.buildClientCommandDraft(phrase, item.actions || [], []);
        return Boolean(probe && probe.ok);
      }
    }
    const actions = Array.isArray(item.actions) ? item.actions : [];
    return actions.some((a) => {
      if (!a || typeof a !== 'object') return false;
      const tool = typeof a.tool === 'string' ? a.tool.trim() : '';
      if (!tool) return false;
      const st = typeof a.status === 'string' ? a.status.trim().toLowerCase() : '';
      if (a.ok === false || SAVE_FAILED_STATUSES.has(st)) return false;
      if (st !== 'confirmed' && st !== 'done' && !(st === '' && a.ok === true)) return false;
      if (SAVE_DENY_TOOLS.has(tool) || SAVE_FORBIDDEN_PREFIXES.some((p) => tool.startsWith(p))) return false;
      if (SAVE_READ_ONLY_TOOLS.has(tool)) return false;
      return true;
    });
  }

  function createChatView({ store, bridge, orbStage }) {
    const ui = window.JarvisUI || {};
    const md = window.NoxAetherMarkdown;
    const { icon } = window.NoxAetherIcons;
    const time = window.NoxAetherTime;
    const scrub = typeof ui.scrub === 'function' ? ui.scrub : (s) => String(s || '');
    const toolTitle = typeof ui.toolTitle === 'function' ? ui.toolTitle : (t) => String(t || 'Шаг');
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

    // Приветствие занимает свободное место между шапкой и полем ввода.
    const emptyHero = document.createElement('div');
    emptyHero.className = 'ae-empty-hero';

    const emptyTitle = document.createElement('h1');
    emptyTitle.className = 'ae-empty-title';
    emptyTitle.setAttribute('aria-live', 'polite');
    emptyHero.append(emptyTitle);

    function renderGreeting(st) {
      const easterEgg = /^nox\.\.\?$/i.test(st.currentDraftText.trim());
      const hour = new Date().getHours();
      let greeting = 'Я рядом';
      if (easterEgg) greeting = 'Nox..?';
      else if (st.dictation.recording) greeting = 'Слушаю.';
      else if (hour >= 5 && hour < 12) greeting = 'Кофе, чай, что желаете?';
      else if (hour >= 18) greeting = 'Добрый вечер.';
      if (emptyTitle.textContent !== greeting) emptyTitle.textContent = greeting;
      emptyHero.classList.toggle('is-easter-egg', easterEgg);
    }

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

    // Одно поле ввода внизу пустого и открытого чата.
    let stickBottom = true;

    const composer = window.NoxAetherComposer.createComposer({
      store,
      bridge,
      onSendTrigger: () => {
        stickBottom = true;
      },
      onTyping: (text, caret) => {
        if (store.isEmptyChat()) renderGreeting(store.state);
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

    function elapsedLabel(ms) {
      return `${(Math.max(0, ms) / 1000).toFixed(1)} с`;
    }

    function buildDetailsPanel(turn, liveWork) {
      const acts = Array.isArray(turn.actions) ? turn.actions : [];
      const searchUrls = new Set((turn.searchSources || []).map((source) => source.url));
      const srcs = Array.isArray(turn.sources) ? turn.sources.filter((source) => !searchUrls.has(source.url)) : [];
      const expandable = acts.length > 0 || srcs.length > 0;
      if (!expandable && !liveWork) return null;

      const wrap = document.createElement('div');
      wrap.className = 'ae-details-wrap';

      const row = document.createElement('div');
      row.className = 'ae-step-line';
      const panelId = `aeTurnDetails-${turn.id}`;
      const toggle = document.createElement(expandable ? 'button' : 'div');
      toggle.className = 'ae-details-toggle';
      if (expandable) {
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', String(Boolean(turn.detailsOpen)));
        toggle.setAttribute('aria-controls', panelId);
        toggle.addEventListener('click', () => {
          pendingFocusTurnId = turn.id;
          store.toggleTurnDetails(turn.id);
        });
      }
      const status = turn.cancelled ? 'cancelled' : turn.workStatus;
      const labelText = liveWork?.text || WORK_LABELS[status] || 'Ход работы';
      row.dataset.state = liveWork?.state || status || '';

      const dot = document.createElement('span');
      dot.className = 'ae-step-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'ae-step-label';
      label.textContent = labelText;
      toggle.title = labelText;
      if (liveWork) label.setAttribute('role', 'status');
      toggle.append(dot, label);
      const elapsedMs = liveWork ? Date.now() - turn.startedAt : turn.workElapsedMs;
      if (Number.isFinite(elapsedMs)) {
        const elapsed = document.createElement('span');
        elapsed.className = 'ae-work-time';
        elapsed.setAttribute('aria-hidden', 'true');
        elapsed.textContent = elapsedLabel(elapsedMs);
        toggle.append(elapsed);
      }
      if (expandable) toggle.append(icon(turn.detailsOpen ? 'chevronDown' : 'chevronRight', 'ae-details-chev'));
      row.append(toggle);
      if (liveWork) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'ae-btn ae-btn-ghost ae-live-stop';
        stop.setAttribute('aria-keyshortcuts', 'Escape');
        stop.title = 'Остановить текущий ход (Esc)';
        stop.append(icon('stop'), 'Стоп');
        stop.addEventListener('click', async () => {
          stop.disabled = true;
          try {
            await store.stopRun();
          } finally {
            stop.disabled = false;
          }
        });
        row.append(stop);
      }
      wrap.append(row);

      if (expandable) {
        const panel = document.createElement('div');
        panel.className = 'ae-details-panel';
        panel.id = panelId;
        panel.hidden = !turn.detailsOpen;
        if (!turn.detailsOpen) {
          wrap.append(panel);
          return wrap;
        }

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

            const badge = document.createElement('span');
            badge.className = 'ae-act-state';
            badge.dataset.status = a.status || '';
            badge.textContent = ACTION_LABELS[a.status] || 'Статус неизвестен';

            top.append(title, badge);
            row.append(top);

            if (a.summary) {
              const sum = document.createElement('div');
              sum.className = 'ae-act-summary';
              sum.textContent = scrub(a.summary);
              row.append(sum);
            }
            if (a.evidence && !String(a.summary || '').includes(a.evidence)) {
              const evidence = document.createElement('div');
              evidence.className = 'ae-act-evidence';
              evidence.textContent = scrub(a.evidence);
              row.append(evidence);
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

    function buildOutcomeActionsBar(item) {
      const actionsBar = document.createElement('div');
      actionsBar.className = item.savedCommandId ? 'ae-outcome-actions is-saved' : 'ae-outcome-actions';

      if (item.savedCommandId) {
        const row = document.createElement('div');
        row.className = 'ae-save-cmd-row';

        const savedBtn = document.createElement('button');
        savedBtn.type = 'button';
        savedBtn.className = 'ae-save-cmd-btn is-saved';
        savedBtn.disabled = true;
        savedBtn.setAttribute('aria-pressed', 'true');
        savedBtn.append(icon('check'));
        const savedLabel = document.createElement('span');
        savedLabel.textContent = 'Сохранено как команда';
        savedBtn.append(savedLabel);

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'ae-save-cmd-open';
        openBtn.append(icon('external'));
        const openLabel = document.createElement('span');
        openLabel.textContent = 'Открыть';
        openBtn.append(openLabel);
        openBtn.addEventListener('click', () => {
          if (typeof store.openSavedCommand === 'function') store.openSavedCommand(item.savedCommandId);
        });

        row.append(savedBtn, openBtn);

        const sub = document.createElement('div');
        sub.className = 'ae-save-cmd-sub';
        sub.textContent = 'В следующий раз — сразу, без нейросети';

        actionsBar.append(row, sub);
        return actionsBar;
      }

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'ae-save-cmd-btn';
      saveBtn.disabled = Boolean(item.savingCommand);
      saveBtn.append(icon('commands'));
      const saveLabel = document.createElement('span');
      saveLabel.textContent = item.savingCommand ? 'Сохраняем…' : 'Сохранить как команду';
      saveBtn.append(saveLabel);
      saveBtn.addEventListener('click', () => {
        if (typeof store.saveTurnAsCommand === 'function') store.saveTurnAsCommand(item.id);
      });
      actionsBar.append(saveBtn);

      if (item.savedCommandError) {
        const errSpan = document.createElement('span');
        errSpan.className = 'ae-save-cmd-error';
        errSpan.textContent = scrub(item.savedCommandError);
        actionsBar.append(errSpan);
      }

      return actionsBar;
    }

    function buildArtifactCard(artifact) {
      const card = document.createElement('div');
      card.className = 'ae-artifact-card';
      const extension = /\.([a-z\d]+)$/i.exec(artifact.path)?.[1].toLowerCase();
      const typeIcon = icon(Object.hasOwn(ARTIFACT_ICONS, extension) ? ARTIFACT_ICONS[extension] : 'file', 'ae-artifact-icon');
      const info = document.createElement('div');
      info.className = 'ae-artifact-info';
      const name = document.createElement('strong');
      name.className = 'ae-artifact-name';
      name.textContent = artifact.name || artifact.path.split(/[\\/]/).at(-1);
      name.title = name.textContent;
      info.append(name);

      const meta = document.createElement('span');
      meta.className = 'ae-artifact-meta';
      const bits = [window.NoxAetherComposer.formatFileSize(artifact.size)];
      if (Number.isInteger(artifact.slides)) bits.push(countLabel(artifact.slides, { one: 'слайд', few: 'слайда', many: 'слайдов' }));
      if (Number.isInteger(artifact.rows)) bits.push(countLabel(artifact.rows, { one: 'строка', few: 'строки', many: 'строк' }));
      meta.textContent = bits.filter(Boolean).join(' · ');
      if (meta.textContent) info.append(meta);

      if (artifact.path !== name.textContent) {
        const location = document.createElement('span');
        location.className = 'ae-artifact-path';
        location.textContent = artifact.path;
        location.title = artifact.path;
        info.append(location);
      }
      const controls = document.createElement('div');
      controls.className = 'ae-artifact-actions';
      for (const [action, buttonText, glyph, failure] of [
        ['open', 'Открыть', 'external', 'Не удалось открыть файл.'],
        ['reveal', 'Показать в папке', 'folder', 'Не удалось показать файл в папке.'],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        btn.disabled = !bridge.has('artifactAction');
        btn.append(icon(glyph), buttonText);
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const res = await bridge.call('artifactAction', { path: artifact.path, action });
            if (res?.ok === false) store.toast(failure, 'error');
          } catch {
            store.toast(failure, 'error');
          } finally {
            btn.disabled = false;
          }
        });
        controls.append(btn);
      }
      card.append(typeIcon, info, controls);
      return card;
    }

    function buildPartialCard(items) {
      const card = document.createElement('div');
      card.className = 'ae-partial-card';
      const list = document.createElement('ul');
      for (const item of items) {
        const row = document.createElement('li');
        const status = document.createElement('span');
        status.className = 'ae-partial-state';
        status.dataset.status = item.status;
        status.textContent = PARTIAL_LABELS[item.status];
        const text = document.createElement('span');
        text.textContent = scrub(item.label);
        if (item.reason) {
          const reason = document.createElement('span');
          reason.className = 'ae-partial-reason';
          reason.textContent = ` — ${scrub(item.reason)}`;
          text.append(reason);
        }
        row.append(status, text);
        list.append(row);
      }
      card.append(list);
      return card;
    }

    function buildClarification(options, enabled) {
      const row = document.createElement('div');
      row.className = 'ae-clarification';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Варианты ответа');
      for (const option of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
        btn.textContent = scrub(option);
        btn.disabled = !enabled;
        btn.addEventListener('click', () => composer.sendChoice(option));
        row.append(btn);
      }
      return row;
    }

    const expandedReplies = new WeakSet();
    function foldReply(item, body) {
      const wrapper = document.createElement('div');
      wrapper.className = 'ae-long-reply';
      const preview = document.createElement('p');
      preview.className = 'ae-long-preview';
      const text = [...body.children].map((block) => block.textContent).join(' ').replace(/\s+/g, ' ').trim();
      const characters = Array.from(text);
      preview.textContent = characters.length > 360 ? `${characters.slice(0, 360).join('').replace(/\s+\S*$/, '')}…` : text;
      const details = document.createElement('details');
      details.open = expandedReplies.has(item);
      details.addEventListener('toggle', () => {
        if (details.open) expandedReplies.add(item);
        else expandedReplies.delete(item);
      });
      const summary = document.createElement('summary');
      const show = document.createElement('span');
      show.className = 'ae-long-show';
      show.textContent = 'Показать полностью';
      const hide = document.createElement('span');
      hide.className = 'ae-long-hide';
      hide.textContent = 'Свернуть ответ';
      summary.append(show, hide);
      details.append(summary, body);
      wrapper.append(preview, details);
      return wrapper;
    }

    function renderTurnItem(item, {
      isActive = false, isLastError = false, canClarify = false, existing = null,
      fallbackPhrase = '', liveWork = null, keepWork = false,
    } = {}) {
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
        const userStamp = time.formatClock(Number(item.at));
        if (userStamp) {
          const stampEl = document.createElement('span');
          stampEl.className = 'ae-msg-time';
          stampEl.textContent = userStamp;
          msg.insertBefore(stampEl, bubble);
        }
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

        if (isLastError && (item.retryPayload || store.state.lastSentPayload)) {
          const retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.className = 'ae-btn ae-btn-secondary ae-btn-sm';
          retryBtn.append(icon('refresh'), 'Повторить');
          retryBtn.addEventListener('click', () => {
            const p = item.retryPayload || store.state.lastSentPayload;
            if (p) store.sendChatMessage(p.text, p.files);
          });
          bar.append(retryBtn);
        }

        if (bar.children.length) row.append(bar);
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
      const msg = existing || document.createElement('article');
      msg.className = isActive ? 'ae-msg is-assistant is-live' : 'ae-msg is-assistant';
      msg.dataset.id = item.id;

      const hasText = Boolean(item.text?.trim());
      const cancelled = !isActive && item.cancelled;
      const preparing = isActive && !hasText && !liveWork;
      const savedWork = keepWork ? msg.querySelector('.ae-details-wrap') : null;
      const focusedWork = document.activeElement?.closest?.('.ae-step-line');
      const restoreStop = !savedWork && focusedWork?.closest('.ae-msg') === msg
        && document.activeElement.classList.contains('ae-live-stop');
      let reply = msg.querySelector('.ae-reply');
      for (const child of Array.from(msg.children)) {
        if (child !== reply && child !== savedWork) child.remove();
      }
      if (hasText || preparing || cancelled) {
        if (!reply) {
          reply = document.createElement('div');
          reply.className = 'ae-reply';
          const head = document.createElement('div');
          head.className = 'ae-reply-head';
          const author = document.createElement('div');
          author.className = 'ae-reply-author';
          author.textContent = 'Nox';
          head.append(author);
          const content = document.createElement('div');
          content.className = 'ae-reply-content';
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'ae-msg-copy';
          copyBtn.title = 'Скопировать ответ';
          copyBtn.setAttribute('aria-label', 'Скопировать ответ');
          copyBtn.append(icon('copy'));
          reply.append(head, content, copyBtn);
          msg.append(reply);
        }
      } else {
        reply?.remove();
      }

      if (reply) {
        const head = reply.querySelector('.ae-reply-head');
        const stamp = time.formatClock(Number(item.at ?? item.startedAt));
        let stampEl = head.querySelector('.ae-msg-time');
        if (stamp) {
          if (!stampEl) {
            stampEl = document.createElement('span');
            stampEl.className = 'ae-msg-time';
            head.append(stampEl);
          }
          stampEl.textContent = stamp;
        } else {
          stampEl?.remove();
        }
      }

      const replyContent = reply?.querySelector('.ae-reply-content');
      if (preparing && !replyContent.querySelector('.ae-reply-thinking')) {
        const status = document.createElement('div');
        status.className = 'ae-reply-thinking';
        status.setAttribute('role', 'status');
        const label = document.createElement('span');
        label.className = 'ae-reply-thinking-label';
        label.textContent = 'Думаю';
        const dots = document.createElement('span');
        dots.className = 'ae-reply-dots';
        dots.setAttribute('aria-hidden', 'true');
        dots.textContent = '…';
        status.append(label, dots);
        replyContent.replaceChildren(status);
      }

      if (hasText || cancelled) {
        const body = document.createElement('div');
        body.className = 'ae-assistant-body md';
        if (hasText) body.append(md.renderMarkdown(item.text, { onOpenUrl: openSourceUrl }));
        if (cancelled) {
          const stopped = document.createElement('p');
          stopped.className = 'ae-reply-stopped';
          stopped.textContent = hasText ? 'Остановлено. Ответ не завершён.' : 'Остановлено.';
          body.append(stopped);
        }
        const shouldFold = !isActive && !cancelled && item.text?.length > 1600;
        replyContent.replaceChildren(shouldFold ? foldReply(item, body) : body);
      }

      if (reply?.parentElement === msg) {
        const copyBtn = reply.querySelector('.ae-msg-copy');
        const copyText = cancelled ? replyContent.innerText || replyContent.textContent : item.text;
        copyBtn.disabled = preparing;
        copyBtn.onclick = async () => {
          if (await md.copyPlain(copyText)) {
            copyBtn.replaceChildren(icon('check'));
            setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1500);
          }
        };
      }

      const details = savedWork || buildDetailsPanel(item, liveWork);
      if (details && !savedWork) {
        msg.insertBefore(details, reply?.parentElement === msg ? reply : null);
        if (restoreStop) details.querySelector('.ae-live-stop')?.focus({ preventScroll: true });
      }

      const partial = Array.isArray(item.partial) ? item.partial.filter((part) => part?.label && Object.hasOwn(PARTIAL_LABELS, part.status)) : [];
      if (partial.length) msg.append(buildPartialCard(partial));

      for (const artifact of Array.isArray(item.artifacts) ? item.artifacts : []) {
        if (typeof artifact?.path === 'string' && artifact.path) msg.append(buildArtifactCard(artifact));
      }

      const options = Array.isArray(item.clarification) ? item.clarification.filter((option) => typeof option === 'string' && option.trim()) : [];
      if (options.length >= 2) msg.append(buildClarification(options.slice(0, 3), canClarify));

      if (!isActive && hasText && item.searchSources?.length) {
        const loadIcon = bridge.has('sourceIcon') ? (host) => bridge.call('sourceIcon', host) : null;
        msg.append(window.NoxAetherSources.createSourcesPopover(item.searchSources, openSourceUrl, loadIcon));
      }

      const actions = item.actions || [];
      const action = actions.length === 1 ? actions[0] : actions.findLast((a) => a.tool === 'presentation_open');
      if (!isActive && !item.cancelled && !partial.length && ['confirmed', 'unverified', 'failed', 'error', 'refused'].includes(action?.status)) {
        const outcome = document.createElement('div');
        outcome.className = 'ae-action-outcome';
        outcome.dataset.status = action.status;
        const label = document.createElement('span');
        label.textContent = action.tool === 'presentation_open' && action.status === 'unverified'
          ? 'Открытие презентации не подтверждено' : ACTION_LABELS[action.status];
        outcome.append(icon(action.status === 'confirmed' ? 'check' : 'alert'), label);
        if (action.evidence) {
          const evidence = document.createElement('span');
          evidence.className = 'ae-action-evidence';
          evidence.textContent = scrub(action.evidence);
          outcome.append(evidence);
        }
        msg.append(outcome);
      }

      if (!isActive && !item.cancelled && (item.savedCommandId || hasSaveableTurnActions(item, fallbackPhrase))) {
        msg.append(buildOutcomeActionsBar(item));
      }

      return msg;
    }

    function renderBanner(st) {
      if (st.limitBanner) {
        bannerWrap.hidden = false;
        const banner = document.createElement('div');
        banner.className = 'ae-banner is-warn';
        banner.setAttribute('role', 'status');
        banner.textContent = st.limitBanner;
        bannerWrap.replaceChildren(banner);
        return;
      }
      if (st.link === 'none') {
        bannerWrap.hidden = false;
        const b = document.createElement('div');
        b.className = 'ae-banner is-warn';
        b.textContent = 'Открыто в автономном режиме предпросмотра: связь с ядром отключена.';
        bannerWrap.replaceChildren(b);
        return;
      }
      if (!st.hasKey && !st.account?.signedIn && st.link === 'electron') {
        bannerWrap.hidden = false;
        const b = document.createElement('div');
        b.className = 'ae-banner is-info';
        const sp = document.createElement('span');
        sp.textContent = 'Команды «Открой Блокнот» и «Открой Калькулятор» работают без аккаунта. Для свободного диалога подключите аккаунт или ключ.';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ae-link-btn';
        btn.textContent = 'Открыть настройки';
        btn.addEventListener('click', () => store.setRoute('settings'));
        b.append(sp, btn);
        bannerWrap.replaceChildren(b);
        return;
      }
      bannerWrap.hidden = true;
      bannerWrap.replaceChildren();
    }

    let lastFeedItems = null;
    let lastInteractiveKey = '';
    let lastActiveSig = '';
    let lastLiveWorkSig = '';
    let activeMessage = null;
    let liveElapsedTimer = null;

    function renderElapsed() {
      const startedAt = store.state.activeTurn?.startedAt;
      if (!Number.isFinite(startedAt)) return;
      const text = elapsedLabel(Date.now() - startedAt);
      const elapsed = activeMessage?.querySelector('.ae-work-time');
      if (elapsed && elapsed.textContent !== text) elapsed.textContent = text;
    }

    function getLiveWork(st) {
      const active = st.activeTurn;
      if (!active || !(st.trackerBusy || st.sendingLock)) return null;
      if (st.approvals.queue.length || st.trackerState === 'waiting_approval') {
        return { state: 'waiting', text: 'Ждёт решения' };
      }
      if (active.actions.length || st.handsActive || ['searching', 'verifying'].includes(st.trackerState)) {
        return { state: 'running', text: store.getLiveWorkText() || 'Выполняется' };
      }
      return null;
    }

    function toggleElapsedTimer(on) {
      if (on && !liveElapsedTimer) {
        liveElapsedTimer = setInterval(renderElapsed, 100);
      } else if (!on && liveElapsedTimer) {
        clearInterval(liveElapsedTimer);
        liveElapsedTimer = null;
      }
    }

    function render(st) {
      renderBanner(st);
      approvalCard.render(st);
      composer.render(st);
      const liveWork = getLiveWork(st);
      toggleElapsedTimer(Boolean(liveWork));

      const isEmpty = store.isEmptyChat();
      root.classList.toggle('is-empty', isEmpty);
      root.classList.toggle('is-docked', !isEmpty);
      emptyHero.hidden = !isEmpty;
      feedWrap.hidden = isEmpty;
      if (isEmpty) {
        renderGreeting(st);
        toBottomBtn.hidden = true;
        return;
      }

      // При поступлении текста меняется только текущий ответ.
      const active = st.activeTurn;
      const interactive = !st.trackerBusy && !st.sendingLock;
      const lastRetry = interactive ? st.feedItems.findLast((item) => item.kind === 'error' || item.kind === 'user') : null;
      const lastDialogItem = interactive ? st.feedItems.findLast((item) => ['assistant', 'user', 'error'].includes(item.kind)) : null;
      const retryId = lastRetry?.kind === 'error' ? lastRetry.id : '';
      const clarifyId = lastDialogItem?.clarification?.length ? lastDialogItem.id : '';
      const interactiveKey = `${st.activeChatId}:${retryId}:${clarifyId}`;
      const liveWorkSig = active ? JSON.stringify([
        active.id, liveWork, active.detailsOpen, active.sources.length,
        active.actions.map((action) => [action.id, action.status, action.summary, action.evidence]),
      ]) : '';
      const activeSig = active ? `${liveWorkSig}:${active.text}` : '';
      const rebuilt = st.feedItems !== lastFeedItems || interactiveKey !== lastInteractiveKey;

      if (rebuilt) {
        lastFeedItems = st.feedItems;
        lastInteractiveKey = interactiveKey;
        const frag = document.createDocumentFragment();
        let prevUserPhrase = '';
        for (const item of st.feedItems) {
          if (item.kind === 'user' && item.text) prevUserPhrase = String(item.text).trim();
          const existing = activeMessage?.dataset.id === item.id ? activeMessage : null;
          frag.append(renderTurnItem(item, {
            isLastError: item.id === retryId,
            canClarify: item.id === clarifyId,
            existing,
            fallbackPhrase: prevUserPhrase,
          }));
        }
        feed.replaceChildren(frag);
        activeMessage = null;
      }
      if (rebuilt || activeSig !== lastActiveSig) {
        lastActiveSig = activeSig;
        if (activeMessage && activeMessage.dataset.id !== active?.id) {
          activeMessage.remove();
          activeMessage = null;
        }
        if (active) {
          activeMessage = renderTurnItem(active, {
            isActive: true, existing: activeMessage, liveWork, keepWork: liveWorkSig === lastLiveWorkSig,
          });
          if (activeMessage.parentElement !== feed) feed.append(activeMessage);
        }
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
      lastLiveWorkSig = liveWorkSig;
      if (liveWork) renderElapsed();
    }

    return {
      el: root,
      focusComposer: () => composer.focus(),
      insertStarter: (text) => {
        composer.insertStarter(text);
        composer.focus();
      },
      widgetDock: dockWrap,
      render,
      destroy: () => {
        if (liveElapsedTimer) clearInterval(liveElapsedTimer);
      },
    };
  }

  window.NoxAetherChatView = { createChatView };
})();
