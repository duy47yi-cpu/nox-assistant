'use strict';

// Журнал скорости ходов: одна JSON-строка на событие (вызов модели, инструмент, итог хода).
// Тексты сообщений и аргументы инструментов сюда не пишутся: только имена, длины и миллисекунды.
// Без пути журнал выключен. Сбой записи ход не роняет.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

class TurnLog {
  constructor(file, { maxBytes = MAX_BYTES } = {}) {
    // Только строка: объект превратился бы в файл «[object Object]» в текущей папке.
    this.file = typeof file === 'string' && file ? file : null;
    this.maxBytes = maxBytes;
  }

  get enabled() {
    return Boolean(this.file);
  }

  write(record) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
      // Ротация только по концу хода, чтобы строки одного хода не разошлись по двум файлам.
      if (record.kind === 'turn' && fs.statSync(this.file).size > this.maxBytes) {
        fs.renameSync(this.file, this.file.replace(/\.jsonl$/, '') + '.old.jsonl');
      }
    } catch {
      // журнал скорости вспомогательный: ошибки записи игнорируем
    }
  }
}

module.exports = { TurnLog };
