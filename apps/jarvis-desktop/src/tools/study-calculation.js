'use strict';

// Ограниченный разбор чисел и линейных выражений. Пользовательский текст не исполняется.
function expression(text) {
  const normalized = text.trim().toLowerCase().replace(/[−–]/g, '-').replace(/,/g, '.')
    .replace(/[×·]/g, '*').replace(/[÷:]/g, '/').replace(/х/g, 'x')
    .replace(/(\d)\s*(?=[x(])/g, '$1*');
  if (!normalized || normalized.length > 160 || /[^\d.x+*/()\s-]/.test(normalized)) return null;
  const tokens = normalized.match(/(?:\d+(?:\.\d+)?|\.\d+)|[^\s]/g) || [];
  let at = 0;
  const bad = () => { throw new Error('неподдерживаемое выражение'); };

  // Пара [коэффициент при x, свободный член].
  function atom() {
    const token = tokens[at++];
    if (token === '+' || token === '-') {
      const [x, y] = atom();
      return token === '-' ? [-x, -y] : [x, y];
    }
    if (token === '(') {
      const value = sum();
      if (tokens[at++] !== ')') bad();
      return value;
    }
    if (token === 'x') return [1, 0];
    if (token && /^\d*\.?\d+$/.test(token)) return [0, Number(token)];
    return bad();
  }

  function product() {
    let [x, y] = atom();
    while (tokens[at] === '*' || tokens[at] === '/') {
      const op = tokens[at++];
      const [a, b] = atom();
      if (op === '*') {
        if (x && a) bad();
        [x, y] = [x * b + y * a, y * b];
      } else {
        if (a || !b) bad();
        [x, y] = [x / b, y / b];
      }
    }
    return [x, y];
  }

  function sum() {
    let [x, y] = product();
    while (tokens[at] === '+' || tokens[at] === '-') {
      const sign = tokens[at++] === '+' ? 1 : -1;
      const [a, b] = product();
      x += sign * a;
      y += sign * b;
    }
    return [x, y];
  }

  try {
    const result = sum();
    return at === tokens.length && result.every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

const UNITS = new Map([
  ['мм', ['length', 0.001]], ['см', ['length', 0.01]], ['дм', ['length', 0.1]],
  ['м', ['length', 1]], ['км', ['length', 1000]], ['г', ['mass', 0.001]], ['кг', ['mass', 1]],
  ['с', ['time', 1]], ['мин', ['time', 60]], ['ч', ['time', 3600]],
]);
const UNIT_NAMES = /^(мм|см|дм|м|км|г|кг|с|мин|ч|миллиметр\p{L}*|сантиметр\p{L}*|дециметр\p{L}*|метр\p{L}*|километр\p{L}*|грамм\p{L}*|килограмм\p{L}*|секунд\p{L}*|минут\p{L}*|час\p{L}*)$/iu;
const UNIT_ROOTS = [['миллиметр', 'мм'], ['сантиметр', 'см'], ['дециметр', 'дм'], ['метр', 'м'], ['километр', 'км'],
  ['грамм', 'г'], ['килограмм', 'кг'], ['секунд', 'с'], ['минут', 'мин'], ['час', 'ч']];

function unit(text) {
  const value = text?.trim().toLowerCase() || '';
  if (!UNIT_NAMES.test(value)) return '';
  return UNITS.has(value) ? value : UNIT_ROOTS.find(([word]) => value.startsWith(word))?.[1] || '';
}

function expectedAnswer(exercise) {
  const text = exercise.trim().replace(/[−–]/g, '-').replace(/[.!?]+$/, '');
  const conversion = /^(?:переведи(?:те)?|вырази(?:те)?)\s+(-?\d+(?:[.,]\d+)?)\s*(\p{L}+)\s+в\s+(\p{L}+)$/iu.exec(text);
  if (conversion) {
    const from = UNITS.get(unit(conversion[2]));
    const target = unit(conversion[3]);
    const to = UNITS.get(target);
    const value = from && to && from[0] === to[0] ? Number(conversion[1].replace(',', '.')) * from[1] / to[1] : NaN;
    return Number.isFinite(value) ? { value, unit: target } : null;
  }
  const formula = text.replace(/^(?:реши(?:те)?(?: уравнение)?|вычисли(?:те)?|посчитай(?:те)?|найди(?:те)? значение(?: выражения)?)\s*:?\s*/iu, '');
  const sides = formula.replace(/=\s*$/, '').split('=');
  const left = expression(sides[0]);
  if (!left) return null;
  if (sides.length === 1 && !left[0] && /[+*/−–×·÷:-]/u.test(sides[0])) return { value: left[1] };
  if (sides.length !== 2) return null;
  const right = expression(sides[1]);
  if (!right || left[0] === right[0]) return null;
  const value = (right[1] - left[1]) / (left[0] - right[0]);
  return Number.isFinite(value) ? { value } : null;
}

function checkCalculation(expected, ownerText) {
  if (!expected) return null;
  const text = ownerText.trim().replace(/[.!?]+$/, '');
  const tail = text.split(/[=\n]/u).at(-1).trim()
    .replace(/^(?:мой\s+)?(?:ответ|решение|итог)\s*:\s*/iu, '');
  const match = /^([\d.,()+*/:−–×·÷\s-]+)(?:\s*(\p{L}+))?$/u.exec(tail);
  if (!match || /(?:^|\s)(?:или|либо)(?:\s|$)/iu.test(text)) return 'incomplete';
  const answer = expression(match[1]);
  if (!answer || answer[0]) return 'incomplete';
  if (match[2] && unit(match[2]) !== expected.unit) return 'incorrect';
  const tolerance = Math.max(1e-10, Math.abs(expected.value) * Number.EPSILON * 8);
  return Math.abs(expected.value - answer[1]) <= tolerance ? 'correct' : 'incorrect';
}

module.exports = { expectedAnswer, checkCalculation };
