'use strict';

// Область экрана, которую владелец обвёл рамкой. Чистые функции без ввода-вывода.
// Координаты — точки экрана Windows (DIP) относительно экрана, где обводили.

const MIN_SIDE = 8; // меньше — это щелчок, а не рамка

const isInt = (v) => Number.isInteger(v);

// Прямоугольник из двух точек рамки: тянуть можно в любую сторону.
function rectFromPoints(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

// Приведение к целым точкам и границам экрана bounds {width, height}. Возвращает null для мусора.
function clampRect(rect, bounds) {
  if (!rect || !bounds) return null;
  const nums = [rect.x, rect.y, rect.width, rect.height, bounds.width, bounds.height];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const x1 = Math.max(0, Math.round(rect.x));
  const y1 = Math.max(0, Math.round(rect.y));
  const x2 = Math.min(Math.round(bounds.width), Math.round(rect.x + rect.width));
  const y2 = Math.min(Math.round(bounds.height), Math.round(rect.y + rect.height));
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

// Строгая проверка: целые координаты, внутри экрана, не меньше MIN_SIDE по каждой стороне.
function checkRect(rect, bounds, { min = MIN_SIDE } = {}) {
  if (!rect || !bounds) return { ok: false, error: 'область не задана' };
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(isInt)) return { ok: false, error: 'координаты области должны быть целыми' };
  if (x < 0 || y < 0 || x + width > bounds.width || y + height > bounds.height) return { ok: false, error: 'область выходит за границы экрана' };
  if (width < min || height < min) return { ok: false, error: `область слишком мала: нужно хотя бы ${min}×${min}` };
  return { ok: true, rect: { x, y, width, height } };
}

// Перевод в настоящие пиксели снимка: scale = ширина снимка / ширина экрана в точках.
function toPixels(rect, scale) {
  const s = typeof scale === 'number' && scale > 0 ? scale : 1;
  return {
    x: Math.round(rect.x * s), y: Math.round(rect.y * s),
    width: Math.round(rect.width * s), height: Math.round(rect.height * s),
  };
}

// Человеческое описание: «область 400×300 в левой верхней части экрана».
function describeRect(rect, bounds) {
  if (!rect) return 'область не выбрана';
  const size = `${rect.width}×${rect.height}`;
  if (!bounds || !bounds.width || !bounds.height) return `область ${size}`;
  const cx = (rect.x + rect.width / 2) / bounds.width;
  const cy = (rect.y + rect.height / 2) / bounds.height;
  const col = cx < 1 / 3 ? 'левой' : cx > 2 / 3 ? 'правой' : '';
  const row = cy < 1 / 3 ? 'верхней' : cy > 2 / 3 ? 'нижней' : '';
  if (rect.width * rect.height >= bounds.width * bounds.height * 0.8) return `область ${size}, почти весь экран`;
  const where = [col, row].filter(Boolean).join(' ');
  return where ? `область ${size} в ${where} части экрана` : `область ${size} в середине экрана`;
}

module.exports = { MIN_SIDE, rectFromPoints, clampRect, checkRect, toPixels, describeRect };
