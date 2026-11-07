// Иконки трея и окна рисуются кодом: без внешних файлов и без зависимостей.
const zlib = require('zlib');
const { nativeImage } = require('electron');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // фильтр None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // глубина 8 бит
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Круг с кольцом по краю, сглаженный край, прозрачный фон.
function orbPixel(size) {
  const c = (size - 1) / 2;
  return (x, y) => {
    const d = Math.hypot(x - c, y - c) / c;
    if (d > 1) return [0, 0, 0, 0];
    const alpha = Math.min(1, (1 - d) * size * 0.8);
    const [r, g, b] = d > 0.78 ? [120, 220, 255] : [40, 140, 220];
    return [r, g, b, Math.round(255 * alpha)];
  };
}

function makeIcon(size) {
  return nativeImage.createFromBuffer(encodePng(size, orbPixel(size)));
}

module.exports = {
  trayIcon: () => makeIcon(16),
  windowIcon: () => makeIcon(64),
};
