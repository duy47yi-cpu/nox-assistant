'use strict';

(function () {
  const STATE_LABELS = {
    idle: { text: 'Не записывает', pillClass: 'pill-idle' },
    starting: { text: 'Подключение…', pillClass: 'pill-paused' },
    recording: { text: 'Идёт синтетический поток', pillClass: 'pill-recording' },
    paused: { text: 'Пауза', pillClass: 'pill-paused' },
    stopping: { text: 'Завершение…', pillClass: 'pill-paused' },
    completed: { text: 'Завершено', pillClass: 'pill-completed' },
    cancelled: { text: 'Остановлено', pillClass: 'pill-paused' },
    error: { text: 'Ошибка подключения', pillClass: 'pill-error' },
  };

  const el = {
    statusPill: document.getElementById('statusPill'),
    statusText: document.getElementById('statusText'),
    timerBadge: document.getElementById('timerBadge'),
    queueBadge: document.getElementById('queueBadge'),
    alertBanner: document.getElementById('alertBanner'),
    scenarioSelect: document.getElementById('scenarioSelect'),
    consentBox: document.getElementById('consentBox'),
    captureConsentCheck: document.getElementById('captureConsentCheck'),
    storageConsentCheck: document.getElementById('storageConsentCheck'),
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnResume: document.getElementById('btnResume'),
    btnFinish: document.getElementById('btnFinish'),
    btnCancel: document.getElementById('btnCancel'),
    btnDelete: document.getElementById('btnDelete'),
    btnFaultDrop: document.getElementById('btnFaultDrop'),
    btnRevokeConsent: document.getElementById('btnRevokeConsent'),
    sessionIdLabel: document.getElementById('sessionIdLabel'),
    persistenceLabel: document.getElementById('persistenceLabel'),
    chunksLabel: document.getElementById('chunksLabel'),
    captionsStats: document.getElementById('captionsStats'),
    finalsList: document.getElementById('finalsList'),
    partialBox: document.getElementById('partialBox'),
    partialText: document.getElementById('partialText'),
    summaryContent: document.getElementById('summaryContent'),
    speakersContent: document.getElementById('speakersContent'),
    metricsContent: document.getElementById('metricsContent'),
  };

  let latestSnapshot = null;
  let elapsedTimer = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatClock(ms) {
    const safe = Math.max(0, Math.round(Number(ms) || 0));
    const totalSec = Math.floor(safe / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function showBanner(kind, message) {
    if (!message) {
      el.alertBanner.className = 'banner hidden';
      el.alertBanner.textContent = '';
      return;
    }
    el.alertBanner.className = `banner banner-${kind}`;
    el.alertBanner.textContent = message;
  }

  function updateElapsedTimer(snapshot) {
    if (!snapshot || !snapshot.startedAt) {
      el.timerBadge.textContent = '00:00';
      return;
    }
    const startMs = Date.parse(snapshot.startedAt);
    const endMs = snapshot.endedAt ? Date.parse(snapshot.endedAt) : Date.now();
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      el.timerBadge.textContent = formatClock(Math.max(0, endMs - startMs));
    }
  }

  function renderControls(snapshot) {
    const state = snapshot?.state || 'idle';
    const meta = STATE_LABELS[state] || STATE_LABELS.idle;
    el.statusPill.className = `pill ${meta.pillClass}`;
    el.statusPill.dataset.state = state;
    el.statusText.textContent = meta.text;

    const isIdleOrDone =
      state === 'idle' || state === 'completed' || state === 'cancelled' || state === 'error';
    const isRecording = state === 'recording';
    const isPaused = state === 'paused';
    const isActive = isRecording || isPaused;

    el.btnStart.disabled = !isIdleOrDone;
    el.btnPause.disabled = !isRecording;
    el.btnResume.disabled = !isPaused;
    el.btnFinish.disabled = !isActive && state !== 'error';
    el.btnCancel.disabled = !isActive;
    el.btnFaultDrop.disabled = !isRecording;
    el.btnRevokeConsent.disabled = !isActive;
    el.scenarioSelect.disabled = isActive || state === 'starting' || state === 'stopping';

    const bp = snapshot?.metrics?.backpressure;
    if (bp) {
      el.queueBadge.textContent = `Очередь: ${bp.depth}/${bp.maxChunks} (${bp.pressureState})`;
    }

    el.sessionIdLabel.textContent = snapshot?.sessionId || '—';
    const persist = snapshot?.persistence;
    if (persist?.saved) {
      el.persistenceLabel.textContent = 'Сохранено в изолированную папку C7';
    } else if (persist?.mode === 'save_failed') {
      el.persistenceLabel.textContent = `Ошибка записи: ${persist.error?.message || 'сбой диска'}`;
    } else if (snapshot?.privacy?.storageConsent) {
      el.persistenceLabel.textContent = 'Разрешено изолированное сохранение';
    } else {
      el.persistenceLabel.textContent = 'Только в памяти (без записи на диск)';
    }

    const m = snapshot?.metrics;
    if (m) {
      el.chunksLabel.textContent = `${m.chunksReceived} получ. / ${m.chunksProcessed} обраб.`;
    }
  }

  function renderTranscript(snapshot) {
    const finals = snapshot?.transcript?.finals || [];
    const partials = snapshot?.transcript?.partials || [];
    const stats = snapshot?.transcript?.stats || {};
    const speakers = snapshot?.timeline?.speakers || [];
    const speakerMap = new Map(speakers.map((s) => [s.speakerKey, s.label]));

    const deduped = (stats.dedupedExact || 0) + (stats.dedupedOverlap || 0);
    el.captionsStats.textContent = `Сегментов: ${finals.length} · Дублей снято: ${deduped}`;

    if (finals.length === 0) {
      const msg =
        snapshot?.state === 'recording'
          ? 'Поток активен, ожидаются первые финальные субтитры…'
          : 'Сейчас ничего не записывается. Отметьте согласие и запустите синтетический сценарий.';
      el.finalsList.innerHTML = `<div class="empty-state">${escapeHtml(msg)}</div>`;
    } else {
      el.finalsList.innerHTML = finals
        .map((seg) => {
          const speakerKey =
            seg.speakerHint || (seg.channel === 'microphone' ? 'local:mic' : 'remote:unidentified');
          const speakerLabel = speakerMap.get(speakerKey) || speakerKey;
          const repairedTag = seg.timestampRepaired
            ? '<span class="tag-repaired">время исправлено</span>'
            : '';
          const lateTag = seg.wasLate ? '<span class="tag-repaired">поздний ответ</span>' : '';
          return `
            <article class="segment-card">
              <div class="segment-meta">
                <span class="segment-time">${formatClock(seg.startMs)}–${formatClock(seg.endMs)}</span>
                <span class="speaker-badge">${escapeHtml(speakerLabel)}</span>
                ${repairedTag}
                ${lateTag}
              </div>
              <div class="segment-text">${escapeHtml(seg.text)}</div>
            </article>
          `;
        })
        .join('');
      el.finalsList.scrollTop = el.finalsList.scrollHeight;
    }

    if (partials.length > 0) {
      const latest = partials[partials.length - 1];
      el.partialBox.classList.remove('partial-idle');
      el.partialText.textContent = latest.text;
    } else {
      el.partialBox.classList.add('partial-idle');
      el.partialText.textContent =
        snapshot?.state === 'recording'
          ? 'Слушаю синтетический поток…'
          : 'Ожидание активного потока…';
    }
  }

  function renderSummary(snapshot) {
    const summary = snapshot?.summary;
    if (!summary) {
      el.summaryContent.innerHTML =
        '<div class="empty-state">Итоговый конспект появится после завершения сессии.</div>';
      return;
    }

    const topicsHtml =
      summary.topics.length === 0
        ? '<p class="muted-meta">Темы не выделены.</p>'
        : `<ul>${summary.topics
            .map(
              (t) =>
                `<li><strong>[${escapeHtml(t.timeRange)}] ${escapeHtml(t.title)}</strong> (${t.points.length} репл.)</li>`
            )
            .join('')}</ul>`;

    const decisionsHtml =
      summary.decisions.length === 0
        ? '<p class="muted-meta">Явных решений не зафиксировано.</p>'
        : `<ul>${summary.decisions
            .map((d) => `<li>[${escapeHtml(d.timecode)}] ${escapeHtml(d.text)}</li>`)
            .join('')}</ul>`;

    const actionsHtml =
      summary.actionItems.length === 0
        ? '<p class="muted-meta">Следующих шагов не выявлено.</p>'
        : `<ul>${summary.actionItems
            .map(
              (a) =>
                `<li>[${escapeHtml(a.timecode)}] ${escapeHtml(a.text)} <span class="muted-meta">(${escapeHtml(a.suggestedOwnerLabel)})</span></li>`
            )
            .join('')}</ul>`;

    const questionsHtml =
      summary.openQuestions.length === 0
        ? '<p class="muted-meta">Открытых вопросов нет.</p>'
        : `<ul>${summary.openQuestions
            .map((q) => `<li>[${escapeHtml(q.timecode)}] ${escapeHtml(q.text)}</li>`)
            .join('')}</ul>`;

    el.summaryContent.innerHTML = `
      <div class="summary-section">
        <h3>Обзор (${escapeHtml(summary.meta.status)})</h3>
        <p>${escapeHtml(summary.overview)}</p>
        <div class="muted-meta">Синтетический ввод: да · Сегментов: ${summary.meta.segmentCount} · Исправлено меток: ${summary.qualityNotes.repairedTimestamps}</div>
      </div>
      <div class="summary-section"><h3>Темы</h3>${topicsHtml}</div>
      <div class="summary-section"><h3>Решения</h3>${decisionsHtml}</div>
      <div class="summary-section"><h3>Следующие шаги</h3>${actionsHtml}</div>
      <div class="summary-section"><h3>Открытые вопросы</h3>${questionsHtml}</div>
      ${
        snapshot.summaryMarkdown
          ? `<details class="summary-section"><summary>Исходный Markdown конспекта</summary><pre class="mono" style="white-space:pre-wrap;margin:8px 0 0;">${escapeHtml(snapshot.summaryMarkdown)}</pre></details>`
          : ''
      }
    `;
  }

  function renderSpeakers(snapshot) {
    const speakers = snapshot?.timeline?.speakers || [];
    if (speakers.length === 0) {
      el.speakersContent.innerHTML =
        '<div class="empty-state">Участники появятся по ходу расшифровки. Имена из текста не выдумываются.</div>';
      return;
    }

    el.speakersContent.innerHTML = `
      <table class="kv-table">
        <thead>
          <tr><th>Канал / метка</th><th>Реплик</th><th>Время</th><th>Доля</th></tr>
        </thead>
        <tbody>
          ${speakers
            .map(
              (s) => `
            <tr>
              <td>
                <div>${escapeHtml(s.label)}</div>
                <div class="muted-meta">${s.identityVerified ? 'Подтверждено пользователем' : 'Личность не подтверждена'}</div>
              </td>
              <td class="mono">${s.turnCount}</td>
              <td class="mono">${formatClock(s.speakingMs)}</td>
              <td class="mono">${Math.round(s.shareRatio * 100)}%</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  function renderMetrics(snapshot) {
    const m = snapshot?.metrics;
    if (!m) return;
    const l = m.latency;
    el.metricsContent.innerHTML = `
      <div class="summary-section">
        <h3>Задержки конвейера C7 (без реального ASR)</h3>
        <p class="muted-meta">${escapeHtml(l.note)}</p>
        <table class="kv-table">
          <tbody>
            <tr><td>Ingest + очередь (p50 / p95 / max)</td><td class="mono">${l.pipelineIngestMs.p50Ms} / ${l.pipelineIngestMs.p95Ms} / ${l.pipelineIngestMs.maxMs} мс</td></tr>
            <tr><td>Сборка расшифровки (p50 / p95 / max)</td><td class="mono">${l.pipelineAssemblyMs.p50Ms} / ${l.pipelineAssemblyMs.p95Ms} / ${l.pipelineAssemblyMs.maxMs} мс</td></tr>
            <tr><td>Генерация конспекта</td><td class="mono">${l.summaryGenerationMs} мс</td></tr>
            <tr><td>Фиктивная задержка ASR (synthetic)</td><td class="mono">${l.simulatedAsrDelayMs.avgMs} мс (ср.)</td></tr>
          </tbody>
        </table>
      </div>
      <div class="summary-section">
        <h3>Надёжность и память</h3>
        <table class="kv-table">
          <tbody>
            <tr><td>Пик очереди фрагментов</td><td class="mono">${m.backpressure.peakChunks} шт. / ${m.backpressure.peakBytes} байт</td></tr>
            <tr><td>Сброшено по backpressure</td><td class="mono">${m.backpressure.droppedChunks}</td></tr>
            <tr><td>Перезапуски провайдера</td><td class="mono">${m.recovery.totalRestarts} / ${m.recovery.maxRestarts}</td></tr>
            <tr><td>Снято дублей / поздних финалов</td><td class="mono">${m.assembler.dedupedExact + m.assembler.dedupedOverlap} / ${m.assembler.lateFinals}</td></tr>
            <tr><td>Исправлено меток / активных таймеров</td><td class="mono">${m.assembler.repairedTimestamps} / ${m.activeTimers}</td></tr>
          </tbody>
        </table>
      </div>
    `;
  }

  function applySnapshot(snapshot) {
    latestSnapshot = snapshot;
    renderControls(snapshot);
    renderTranscript(snapshot);
    renderSummary(snapshot);
    renderSpeakers(snapshot);
    renderMetrics(snapshot);
    updateElapsedTimer(snapshot);

    if (snapshot?.lastError) {
      showBanner('error', `${snapshot.lastError.code}: ${snapshot.lastError.message}`);
    }
  }

  async function apiPost(path, body = {}) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'Ошибка запроса');
      err.code = data.code;
      throw err;
    }
    return data;
  }

  // Навигация по вкладкам правой панели
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach((b) => {
        const active = b.dataset.tab === target;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      });
      document.getElementById('tabSummary').classList.toggle('active', target === 'summary');
      document.getElementById('tabSpeakers').classList.toggle('active', target === 'speakers');
      document.getElementById('tabMetrics').classList.toggle('active', target === 'metrics');
    });
  });

  el.btnStart.addEventListener('click', async () => {
    el.consentBox.classList.remove('consent-highlight');
    showBanner(null, '');
    try {
      const snap = await apiPost('/api/session/start', {
        scenario: el.scenarioSelect.value,
        captureConsent: el.captureConsentCheck.checked,
        storageConsent: el.storageConsentCheck.checked,
      });
      applySnapshot(snap);
    } catch (err) {
      if (err.code === 'CONSENT_REQUIRED') {
        el.consentBox.classList.add('consent-highlight');
      }
      showBanner('error', err.message);
    }
  });

  el.btnPause.addEventListener('click', async () => {
    try {
      applySnapshot(await apiPost('/api/session/pause'));
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  el.btnResume.addEventListener('click', async () => {
    try {
      applySnapshot(await apiPost('/api/session/resume'));
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  el.btnFinish.addEventListener('click', async () => {
    try {
      applySnapshot(await apiPost('/api/session/finish'));
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  el.btnCancel.addEventListener('click', async () => {
    try {
      applySnapshot(await apiPost('/api/session/cancel'));
      showBanner('warn', 'Сессия прервана пользователем. Запись остановлена.');
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  el.btnDelete.addEventListener('click', async () => {
    try {
      const snap = await apiPost('/api/session/delete');
      el.captureConsentCheck.checked = false;
      el.storageConsentCheck.checked = false;
      el.consentBox.classList.remove('consent-highlight');
      applySnapshot(snap);
      showBanner('ok', 'Тестовая сессия удалена, временные данные очищены.');
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  el.btnFaultDrop.addEventListener('click', async () => {
    try {
      await apiPost('/api/session/fault', { kind: 'provider_drop' });
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  el.btnRevokeConsent.addEventListener('click', async () => {
    try {
      const snap = await apiPost('/api/session/revoke-consent');
      el.captureConsentCheck.checked = false;
      el.storageConsentCheck.checked = false;
      applySnapshot(snap);
      showBanner('warn', 'Согласие отозвано: поток остановлен, данные в памяти очищены.');
    } catch (err) {
      showBanner('error', err.message);
    }
  });

  async function refreshState() {
    const res = await fetch('/api/state', { cache: 'no-store' });
    const data = await res.json();
    applySnapshot(data);
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('snapshot', (ev) => {
      applySnapshot(JSON.parse(ev.data));
    });
    es.addEventListener('state_change', () => {
      void refreshState();
    });
    es.addEventListener('partial_transcript', () => {
      void refreshState();
    });
    es.addEventListener('final_transcript', () => {
      void refreshState();
    });
    es.addEventListener('summary_ready', () => {
      void refreshState();
    });
    es.addEventListener('recovery', (ev) => {
      const info = JSON.parse(ev.data);
      if (info.phase === 'restarting') {
        showBanner('warn', `Обрыв провайдера ASR: перезапуск (попытка ${info.attempt}/${info.maxRestarts})…`);
      } else if (info.phase === 'recovered') {
        showBanner('ok', `Соединение с ASR восстановлено (попытка ${info.attempt}).`);
      }
      void refreshState();
    });
    es.addEventListener('error', (ev) => {
      if (ev.data) {
        const info = JSON.parse(ev.data);
        showBanner('error', `${info.code || 'ERROR'}: ${info.message || 'Сбой соединения'}`);
        void refreshState();
      } else if (es.readyState === EventSource.CLOSED) {
        showBanner('error', 'Соединение с локальным сервером прототипа закрыто');
      }
    });
    es.addEventListener('storage_error', (ev) => {
      const info = JSON.parse(ev.data);
      showBanner('error', `Ошибка сохранения: ${info.message}`);
      void refreshState();
    });
  }

  elapsedTimer = setInterval(() => {
    if (latestSnapshot && latestSnapshot.state === 'recording') {
      updateElapsedTimer(latestSnapshot);
    }
  }, 500);

  void refreshState().then(connectEvents);
})();
