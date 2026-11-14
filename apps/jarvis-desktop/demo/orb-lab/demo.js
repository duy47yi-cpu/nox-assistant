(() => {
  'use strict';
  const info = {
    flux: { title: 'Поток', description: 'Световые нити огибают объём. Направление света и глубина важнее свечения.', number: 'N / 01' },
    membrane: { title: 'Мембрана', description: 'Единая поверхность дышит и изгибается. Сетка следует форме, а не просто вращается.', number: 'N / 02' },
    resonance: { title: 'Резонанс', description: 'Тонкие линии пересекаются в пространстве. По ним проходит свет, а не хаотичная рябь.', number: 'N / 03' },
  };
  const states = { idle: 'Готов', listening: 'Слушает', thinking: 'Думает', speaking: 'Отвечает', success: 'Готово', error: 'Ошибка' };
  const orb = new NoxOrbLab(document.getElementById('orb'), { variant: 'flux' });
  let selected = 'flux', state = 'idle', simulatedVoice = false, voiceTime = 0, voiceRaf = 0, paused = false;
  const buttons = (selector) => [...document.querySelectorAll(selector)];
  function press(list, current) { list.forEach((button) => { const yes = button === current; button.classList.toggle('selected', yes); button.setAttribute('aria-pressed', String(yes)); }); }
  function chooseVariant(id) {
    selected = id; orb.setVariant(id);
    const data = info[id];
    document.getElementById('variantTitle').textContent = data.title;
    document.getElementById('variantDescription').textContent = data.description;
    document.querySelector('.measure').textContent = data.number;
    press(buttons('[data-variant]'), document.querySelector('[data-variant="' + id + '"]'));
    describe();
  }
  function chooseState(id) {
    state = id; orb.setState(id);
    document.getElementById('stateLabel').textContent = states[id];
    press(buttons('[data-state]'), document.querySelector('[data-state="' + id + '"]'));
    describe();
  }
  function describe() {
    document.getElementById('stage').setAttribute('aria-label', info[selected].title + ': сфера в состоянии «' + states[state] + '»');
  }
  buttons('[data-variant]').forEach((button) => button.addEventListener('click', () => chooseVariant(button.dataset.variant)));
  buttons('[data-state]').forEach((button) => button.addEventListener('click', () => chooseState(button.dataset.state)));
  document.getElementById('motion').addEventListener('input', (event) => {
    document.getElementById('motionValue').value = event.target.value + '%';
    orb.setTune({ motion: Number(event.target.value) / 100 });
  });
  document.getElementById('light').addEventListener('input', (event) => {
    document.getElementById('lightValue').value = event.target.value + '%';
    orb.setTune({ light: Number(event.target.value) / 100 });
  });
  document.getElementById('reduce').addEventListener('click', (event) => {
    const yes = event.currentTarget.getAttribute('aria-pressed') !== 'true';
    event.currentTarget.setAttribute('aria-pressed', String(yes)); orb.setAnimated(!yes);
  });
  document.getElementById('pause').addEventListener('click', (event) => {
    paused = !paused; event.currentTarget.setAttribute('aria-pressed', String(paused));
    event.currentTarget.setAttribute('aria-label', paused ? 'Продолжить' : 'Пауза');
    event.currentTarget.textContent = paused ? '▶' : 'Ⅱ'; orb.setAnimated(!paused && document.getElementById('reduce').getAttribute('aria-pressed') !== 'true');
  });
  function voiceFrame(now) {
    if (!simulatedVoice) return;
    const dt = voiceTime ? Math.min((now - voiceTime) / 1000, .05) : 0; voiceTime = now;
    const t = now / 1000;
    const envelope = Math.max(0, Math.sin(t * 2.6) * .58 + Math.sin(t * 7.1) * .22 + .25);
    orb.setVoice(envelope);
    voiceRaf = requestAnimationFrame(voiceFrame);
  }
  document.getElementById('voice').addEventListener('click', (event) => {
    simulatedVoice = !simulatedVoice;
    event.currentTarget.setAttribute('aria-pressed', String(simulatedVoice));
    event.currentTarget.textContent = simulatedVoice ? 'Остановить отклик голоса' : 'Показать отклик голоса';
    if (!simulatedVoice) { cancelAnimationFrame(voiceRaf); orb.setVoice(0); return; }
    chooseState('listening'); voiceTime = 0; voiceRaf = requestAnimationFrame(voiceFrame);
  });
  const observer = new ResizeObserver(() => orb.resize()); observer.observe(document.getElementById('stage'));
  window.addEventListener('pagehide', () => { cancelAnimationFrame(voiceRaf); observer.disconnect(); orb.destroy(); }, { once: true });
  // Точка для проверки демо. Не участвует в основном приложении.
  window.orbDemo = { orb, chooseVariant, chooseState, snapshot: () => orb.snapshot() };
})();