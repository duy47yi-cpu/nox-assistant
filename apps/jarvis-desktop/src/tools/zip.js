'use strict';

// Минимальный zip на встроенном zlib: чтение и запись для DOCX и XLSX (без сторонних пакетов).
// Не поддерживаются: zip64, шифрование, многотомные архивы.
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const MAX_ENTRIES = 1000;
const MAX_UNPACKED = 50 * 1024 * 1024;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function findEnd(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_END) return i;
  }
  return -1;
}

// Распаковка одной записи. Лимит по размеру из оглавления: сверх него zlib бросает ошибку (защита от zip-бомбы).
function extract(buf, local, method, csize, size, crc) {
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== SIG_LOCAL) throw new Error('архив повреждён');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  if (data.length !== csize) throw new Error('архив повреждён');
  let out;
  try {
    if (method === 0) out = data;
    else if (method === 8) out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
    else throw new Error('неподдерживаемое сжатие в архиве');
  } catch (err) {
    if (err instanceof RangeError) throw new Error('файл слишком большой после распаковки');
    if (err.message.startsWith('неподдерживаемое')) throw err;
    throw new Error('архив повреждён');
  }
  if (out.length !== size || crc32(out) !== crc) throw new Error('архив повреждён: контрольная сумма не сошлась');
  return out;
}

// Читает все записи архива: Map имя → Buffer. maxBytes — предел суммы распакованных данных.
function readZip(buf, { maxBytes = MAX_UNPACKED } = {}) {
  const end = findEnd(buf);
  if (end < 0) throw new Error('это не zip-архив: файл повреждён или зашифрован');
  const count = buf.readUInt16LE(end + 10);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('архив в формате zip64 не поддерживается');
  if (count > MAX_ENTRIES) throw new Error('в архиве слишком много файлов');
  const files = new Map();
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('оглавление архива повреждено');
    const flags = buf.readUInt16LE(p + 8);
    if (flags & 1) throw new Error('файл зашифрован паролем');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    total += size;
    if (total > maxBytes) throw new Error('файл слишком большой после распаковки');
    files.set(name, extract(buf, local, method, csize, size, crc));
  }
  return files;
}

// Пишет архив из записей {name, data}; данные сжимаются deflate, имена в UTF-8.
function writeZip(entries) {
  if (entries.length > 0xffff) throw new Error('слишком много записей');
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(SIG_LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(comp.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    const local = Buffer.concat([head, nameBuf, comp]);
    locals.push(local);
    centrals.push(cen, nameBuf);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { readZip, writeZip, crc32 };
