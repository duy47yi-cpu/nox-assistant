'use strict';

// Системный промпт с текущим временем. Модель не знает, сколько сейчас времени,
// поэтому без этого напоминания и брифинг ставятся вслепую.
// extra — необязательный готовый блок (память для фона), идёт последней строкой.
function withClock(base, now = () => new Date(), extra = '') {
  return () => {
    const stamp = now().toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'short' });
    return `${base}\nСейчас: ${stamp} (локальное время владельца).${extra ? `\n${extra}` : ''}`;
  };
}

module.exports = { withClock };
