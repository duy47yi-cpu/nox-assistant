'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rectFromPoints, clampRect, checkRect, toPixels, describeRect, MIN_SIDE } = require('../src/screen/region');

const SCREEN = { width: 1920, height: 1080 };

test('рамку можно тянуть в любую сторону', () => {
  assert.deepEqual(rectFromPoints({ x: 300, y: 200 }, { x: 100, y: 50 }), { x: 100, y: 50, width: 200, height: 150 });
});

test('приведение к границам: дробные точки округляются, выход за экран обрезается', () => {
  assert.deepEqual(clampRect({ x: -10.4, y: 5.6, width: 100.2, height: 50 }, SCREEN), { x: 0, y: 6, width: 90, height: 50 });
  assert.deepEqual(clampRect({ x: 1900, y: 1000, width: 100, height: 200 }, SCREEN), { x: 1900, y: 1000, width: 20, height: 80 });
  assert.deepEqual(clampRect({ x: 5000, y: 0, width: 10, height: 10 }, SCREEN), { x: 5000, y: 0, width: 0, height: 10 });
  assert.equal(clampRect({ x: NaN, y: 0, width: 1, height: 1 }, SCREEN), null);
  assert.equal(clampRect(null, SCREEN), null);
});

test('проверка: целые, внутри экрана, не меньше минимума', () => {
  assert.equal(checkRect({ x: 10, y: 10, width: 200, height: 100 }, SCREEN).ok, true);
  assert.match(checkRect({ x: 10.5, y: 10, width: 200, height: 100 }, SCREEN).error, /целыми/);
  assert.match(checkRect({ x: 1800, y: 10, width: 200, height: 100 }, SCREEN).error, /границы/);
  assert.match(checkRect({ x: -1, y: 10, width: 20, height: 20 }, SCREEN).error, /границы/);
  assert.match(checkRect({ x: 10, y: 10, width: MIN_SIDE - 1, height: 100 }, SCREEN).error, /мала/);
  assert.equal(checkRect(null, SCREEN).ok, false);
});

test('перевод в пиксели снимка учитывает масштаб Windows', () => {
  assert.deepEqual(toPixels({ x: 10, y: 20, width: 100, height: 50 }, 1.5), { x: 15, y: 30, width: 150, height: 75 });
  assert.deepEqual(toPixels({ x: 10, y: 20, width: 100, height: 50 }, 0), { x: 10, y: 20, width: 100, height: 50 });
});

test('описание области простыми словами', () => {
  assert.equal(describeRect({ x: 0, y: 0, width: 400, height: 300 }, SCREEN), 'область 400×300 в левой верхней части экрана');
  assert.equal(describeRect({ x: 860, y: 440, width: 200, height: 200 }, SCREEN), 'область 200×200 в середине экрана');
  assert.equal(describeRect({ x: 1500, y: 900, width: 300, height: 100 }, SCREEN), 'область 300×100 в правой нижней части экрана');
  assert.equal(describeRect({ x: 0, y: 0, width: 1920, height: 1080 }, SCREEN), 'область 1920×1080, почти весь экран');
  assert.equal(describeRect(null, SCREEN), 'область не выбрана');
});
