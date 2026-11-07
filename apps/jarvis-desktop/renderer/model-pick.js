/* Выбор модели и глубины обдумывания у поля ввода: одна строка «Быстрая · думает кратко»,
 * по нажатию — панель с двумя переключателями на радиокнопках и честной ценой в лимите. */
(() => {
  'use strict';

  // Ядро читается при монтаже: в браузерной проверке dev-stub.js догружается позже этого файла.
  let api = null;

  const MODELS = [['fast', 'Быстрая'], ['smart', 'Умная']];
  const LEVELS = [['low', 'Кратко'], ['medium', 'Обычно'], ['high', 'Глубоко']];
  const SHORT = { low: 'думает кратко', medium: 'думает обычно', high: 'думает глубоко' };
  const COST = { low: 'Обычный расход лимита', medium: 'Лимит тратится в 1,5 раза быстрее', high: 'Лимит тратится в 2,5 раза быстрее' };
  const MODEL_HINT = { fast: 'Отвечает сразу. Подходит для команд и коротких вопросов.', smart: 'Сильнее в сложных поручениях и длинных текстах.' };

  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  // Сегмент — fieldset с радиокнопками: стрелки и Tab работают сами, диктор читает группу по legend.
  function segment(name, label, options, onChange) {
    const box = make('fieldset', 'pick');
    const seg = make('div', 'seg');
    const inputs = {};
    for (const [value, text] of options) {
      const opt = make('label', 'seg-opt');
      const input = document.createElement('input');
      Object.assign(input, { type: 'radio', name, value });
      input.addEventListener('change', () => { if (input.checked) onChange(value); });
      opt.append(input, make('span', '', text));
      seg.append(opt);
      inputs[value] = input;
    }
    box.append(make('legend', 'pick-name', label), seg);
    return { box, inputs, value: () => Object.keys(inputs).find((k) => inputs[k].checked) };
  }

  const trigger = make('button', 'pick-trigger');
  Object.assign(trigger, { type: 'button', id: 'pickTrigger' });
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const trigText = make('span', 'pick-trigger-text');
  const chev = make('span', 'pick-chev');
  chev.dataset.icon = 'chevron';
  chev.setAttribute('aria-hidden', 'true');
  trigger.append(trigText, chev);

  const cost = make('span', 'pick-cost');
  const panel = make('div', 'pick-panel');
  panel.id = 'pickPanel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Модель и обдумывание');
  trigger.setAttribute('aria-controls', panel.id);
  const modelNote = make('p', 'pick-note');
  const costNote = make('p', 'pick-note');

  const model = segment('pick-model', 'Модель', MODELS, (v) => { api.setModelTier(v); render(); });
  const level = segment('pick-level', 'Обдумывание', LEVELS, (v) => { api.setThinking(v); render(); });
  panel.append(model.box, modelNote, level.box, costNote);

  function render() {
    const m = model.value() || 'fast';
    const l = level.value() || 'low';
    trigText.textContent = `${MODELS.find(([k]) => k === m)[1]} · ${SHORT[l]}`;
    trigger.setAttribute('aria-label', `Модель: ${MODELS.find(([k]) => k === m)[1]}, ${SHORT[l]}. Изменить`);
    modelNote.textContent = MODEL_HINT[m];
    costNote.textContent = COST[l] + '.';
    cost.textContent = l === 'low' ? '' : COST[l];
  }

  function open(on) {
    panel.hidden = !on;
    trigger.setAttribute('aria-expanded', String(on));
    if (on) (panel.querySelector('input:checked') || panel.querySelector('input')).focus();
  }

  trigger.addEventListener('click', () => open(panel.hidden));
  // Esc закрывает только панель: дальше событие не идёт, иначе оно остановило бы Джарвиса.
  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    open(false);
    trigger.focus();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && !trigger.contains(e.target)) open(false);
  });

  async function mount() {
    api = window.jarvis;
    const composer = document.querySelector('#composer');
    if (!api || !api.setThinking || !composer || composer.querySelector('.composer-picks')) return;
    const row = make('div', 'composer-picks');
    row.append(trigger, cost, panel);
    composer.append(row);
    if (window.JarvisUI && window.JarvisUI.fillIcons) window.JarvisUI.fillIcons(row);
    let s = {};
    try { s = await api.getSettings(); } catch { /* значения по умолчанию */ }
    model.inputs[s.modelTier === 'smart' ? 'smart' : 'fast'].checked = true;
    level.inputs[COST[s.thinking] ? s.thinking : 'low'].checked = true;
    render();
  }
  if (document.readyState === 'complete') mount();
  else window.addEventListener('load', mount);
})();
