'use strict';
// Окно диктовки в поле другой программы: показывает состояние микрофона, куда уйдёт текст и сам текст.
// Окно не берёт фокус: курсор остаётся в чужом поле. Вся логика — в ядре (src/voice/field-dictation.js).
(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('.dictate');
  const MIC = { starting: 'Включаю микрофон…', listening: 'Слушаю', stopped: 'Микрофон остановлен', error: 'Микрофон не работает', off: 'Микрофон выключен' };
  const act = (name) => window.jarvis.fieldDictation(name);

  function render(s) {
    if (!s || !s.phase) return;
    const rec = s.phase === 'recording';
    root.dataset.mic = rec ? s.mic : 'off';
    $('micLabel').textContent = rec ? MIC[s.mic] || MIC.off
      : s.phase === 'capturing' ? 'Смотрю, куда вставлять…'
        : s.phase === 'inserting' ? 'Вставляю…'
          : s.phase === 'done' ? 'Готово' : 'Диктовка';
    $('target').textContent = s.target ? `Куда: ${s.target}` : '';
    $('target').title = s.target || '';
    $('text').textContent = s.text || '';
    $('text').dataset.empty = rec ? 'Говорите — текст появится здесь.' : '';
    $('message').textContent = s.message || '';
    $('hint').textContent = rec ? 'Вставить — Ctrl+Alt+D · Отмена — Esc' : '';
    $('insert').hidden = !rec;
    $('insert').disabled = !s.text;
    $('copy').hidden = !(s.text && (s.phase === 'kept' || rec));
    $('cancel').textContent = rec ? 'Отмена' : 'Закрыть';
    $('cancel').hidden = s.phase === 'capturing' || s.phase === 'inserting';
  }

  $('insert').addEventListener('click', () => act('insert'));
  $('cancel').addEventListener('click', () => act('cancel'));
  $('copy').addEventListener('click', async () => {
    const r = await act('copy');
    if (r && r.ok) $('message').textContent = 'Текст скопирован.';
  });
  window.jarvis.onFieldDictation(render);
  act('state').then(render);
})();
