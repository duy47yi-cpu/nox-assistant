'use strict';

// Клиент стенда: устройство со своим ключом и сертификатом, список доверенных устройств и защита от повтора.
// Шифрование целиком на node:tls (TLS 1.3), своих кодеков нет. Текст поручений в журнал не пишется.
const fs = require('fs');
const path = require('path');
const http = require('http');
const tls = require('tls');
const { Duplex } = require('stream');
const { X509Certificate } = require('crypto');

const TLS13 = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' };
const MAX_LINE = 64 * 1024;
const hostOf = (id) => `${id}.link.nox`;
const roomOf = (a, b) => `/link/${[a, b].sort().join('~')}`;

// Запись со сбросом на диск: отметка о поручении должна пережить отключение питания.
function writeDurable(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

// Обычный Duplex поверх сокета посредника: TLS не знает, что под ним сеть (требование 2 стенда).
function asDuplex(sock) {
  const duplex = new Duplex({
    read() { sock.resume(); },
    write(chunk, enc, cb) { sock.write(chunk, cb); },
    final(cb) { sock.end(); cb(); },
    destroy(err, cb) { sock.destroy(); cb(err); },
  });
  sock.on('data', (chunk) => { if (!duplex.push(chunk)) sock.pause(); });
  sock.on('end', () => duplex.push(null));
  // TLS узнаёт о конце только по end на чтении: без push(null) закрытие канала до TLS не доходит.
  sock.on('close', () => { duplex.push(null); duplex.destroy(); });
  sock.on('error', (err) => duplex.destroy(err));
  return duplex;
}

function tunnel(port, room, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: room, headers: { Connection: 'Upgrade', Upgrade: 'nox-link' } });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, timeoutMs);
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.on('upgrade', (res, sock, head) => {
      clearTimeout(timer);
      if (head.length) sock.unshift(head);
      resolve(asDuplex(sock));
    });
    req.end();
  });
}

class Device {
  constructor(dir) {
    this.dir = dir;
    this.id = fs.readFileSync(path.join(dir, 'id'), 'utf8').trim();
    this.key = fs.readFileSync(path.join(dir, 'key.pem'));
    this.cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8');
    this.peers = readJson(path.join(dir, 'peers.json'), {});
    this.seen = new Set(readJson(path.join(dir, 'seen.json'), []));
    this.live = new Map(); // peerId -> Set<TLSSocket>
    this.onTask = () => {};
  }

  // Журнал диагностики: только события, идентификаторы и размеры. Текста поручений здесь нет.
  log(ev, extra = {}) {
    fs.appendFileSync(path.join(this.dir, 'diag.log'), `${JSON.stringify({ t: Date.now(), ev, ...extra })}\n`);
  }

  // Итог сопряжения: сертификат привязан к идентификатору второго устройства.
  pair(peerId, certPem) {
    this.peers[peerId] = { cert: certPem, fp: new X509Certificate(certPem).fingerprint256 };
    writeDurable(path.join(this.dir, 'peers.json'), JSON.stringify(this.peers));
  }

  revoke(peerId) {
    delete this.peers[peerId];
    writeDurable(path.join(this.dir, 'peers.json'), JSON.stringify(this.peers));
    for (const socket of this.live.get(peerId) || []) socket.destroy();
    this.log('revoke', { peer: peerId });
  }

  async connect(port, peerId, role, { timeoutMs = 3000 } = {}) {
    const peer = this.peers[peerId];
    if (!peer) throw new Error('peer_not_trusted');
    const raw = await tunnel(port, roomOf(this.id, peerId), timeoutMs);
    // Доверенный корень — ровно один сертификат этого устройства: чужой, даже с тем же именем, проверку не пройдёт.
    const opts = { ...TLS13, key: this.key, cert: this.cert, ca: [peer.cert] };
    let socket;
    try {
      socket = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        const done = (fn, value) => { clearTimeout(timer); fn(value); };
        raw.on('close', () => done(reject, new Error('transport_closed')));
        if (role === 'server') {
          const server = tls.createServer({ ...opts, requestCert: true, rejectUnauthorized: true });
          server.on('secureConnection', (s) => done(resolve, s));
          server.on('tlsClientError', (err) => done(reject, err));
          server.emit('connection', raw);
        } else {
          const s = tls.connect({ ...opts, socket: raw, servername: hostOf(peerId) }, () => done(resolve, s));
          s.on('error', (err) => done(reject, err));
        }
      });
    } catch (err) {
      raw.destroy();
      this.log('connect_failed', { peer: peerId, code: err.code || err.message });
      throw err;
    }
    // Важно: TLS-ошибка (например, подмена байта) не закрывает нижний канал сама. Без этого второй конец
    // не видит обрыв и поручение висит. Закрываем и TLS-сокет, и канал через посредника.
    socket.on('error', () => socket.destroy());
    socket.on('close', () => raw.destroy());
    const cert = socket.getPeerX509Certificate();
    if (!socket.authorized || !cert || cert.fingerprint256 !== peer.fp || !cert.checkHost(hostOf(peerId)) || !this.peers[peerId]) {
      socket.destroy();
      this.log('connect_failed', { peer: peerId, code: 'peer_cert_mismatch' });
      throw new Error('peer_cert_mismatch');
    }
    return this._session(socket, peerId, timeoutMs);
  }

  async _session(socket, peerId, timeoutMs) {
    if (!this.live.has(peerId)) this.live.set(peerId, new Set());
    this.live.get(peerId).add(socket);
    const pending = new Map();
    let buf = '';
    let gotHello;
    // В TLS 1.3 клиент считает рукопожатие готовым раньше, чем сервер проверит его сертификат.
    // Поэтому связь считается установленной только после «hello» от второй стороны.
    const hello = new Promise((resolve, reject) => {
      gotHello = resolve;
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      socket.once('close', () => { clearTimeout(timer); reject(new Error('closed_before_hello')); });
    });
    const handle = (m) => {
      if (m.hello) return gotHello();
      if (typeof m.ack === 'string') {
        const waiter = pending.get(m.ack);
        pending.delete(m.ack);
        return waiter && waiter.resolve(m.status);
      }
      if (typeof m.msgId !== 'string' || typeof m.text !== 'string') return socket.destroy();
      socket.write(`${JSON.stringify({ ack: m.msgId, status: this._accept(peerId, m) })}\n`);
    };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE) return socket.destroy();
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { return socket.destroy(); }
        handle(m);
      }
    });
    socket.on('close', () => {
      this.live.get(peerId).delete(socket);
      for (const waiter of pending.values()) waiter.reject(new Error('closed'));
      pending.clear();
      this.log('closed', { peer: peerId });
    });
    socket.write('{"hello":1}\n');
    try { await hello; } catch (err) { socket.destroy(); throw err; }
    this.log('connected', { peer: peerId, protocol: socket.getProtocol() });
    return {
      socket,
      send: (msgId, text) => new Promise((resolve, reject) => {
        if (socket.destroyed) return reject(new Error('closed'));
        pending.set(msgId, { resolve, reject });
        socket.write(`${JSON.stringify({ msgId, text })}\n`);
      }),
      close: () => socket.destroy(),
    };
  }

  // TLS не знает о повторах между соединениями: отметка пишется на диск до выполнения.
  _accept(peerId, m) {
    if (!this.peers[peerId]) return 'revoked';
    const key = `${peerId}:${m.msgId}`;
    if (this.seen.has(key)) {
      this.log('replay_blocked', { peer: peerId, msgId: m.msgId });
      return 'replay';
    }
    this.seen.add(key);
    writeDurable(path.join(this.dir, 'seen.json'), JSON.stringify([...this.seen]));
    this.log('task', { peer: peerId, msgId: m.msgId, bytes: Buffer.byteLength(m.text) });
    this.onTask(m.text, peerId);
    return 'done';
  }
}

module.exports = { Device, hostOf, roomOf, TLS13 };
