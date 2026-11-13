'use strict';

// Посредник стенда: сводит два подключения одной «комнаты» и пересылает байты как есть.
// Ключей у него нет. relay.seen — всё, что он видел; relay.mangle — подмена байтов для отрицательных тестов.
const http = require('http');

function startRelay() {
  const rooms = new Map();
  const socks = new Set();
  const relay = { seen: [], mangle: null, port: 0 };
  const server = http.createServer((req, res) => { res.writeHead(404).end(); });
  server.on('upgrade', (req, sock) => {
    socks.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => { socks.delete(sock); if (rooms.get(req.url) === sock) rooms.delete(req.url); });
    const other = rooms.get(req.url);
    if (!other) { rooms.set(req.url, sock); return; }
    rooms.delete(req.url);
    for (const s of [sock, other]) s.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: nox-link\r\n\r\n');
    const pipe = (from, to) => {
      from.on('data', (chunk) => { relay.seen.push(chunk); to.write(relay.mangle ? relay.mangle(chunk) : chunk); });
      // http-сервер держит сокеты полуоткрытыми: на FIN закрываем и вторую сторону, иначе обрыв не дойдёт.
      from.on('end', () => to.destroy());
      from.on('close', () => to.destroy());
    };
    pipe(sock, other);
    pipe(other, sock);
  });
  relay.dropAll = () => { for (const s of socks) s.destroy(); };
  relay.close = () => new Promise((resolve) => { relay.dropAll(); server.close(resolve); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { relay.port = server.address().port; resolve(relay); }));
}

module.exports = { startRelay };
