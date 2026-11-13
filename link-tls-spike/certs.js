'use strict';

// Сертификат устройства для стенда делает установленный openssl (идёт с Git): в node:crypto выпуска сертификатов нет.
// shortcut: для продукта нужен свой способ выпуска без внешней программы, см. README.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const OPENSSL = ['openssl', 'C:\\Program Files\\Git\\ucrt64\\bin\\openssl.exe', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe'];

function openssl(args) {
  for (const exe of OPENSSL) {
    try { return execFileSync(exe, args, { stdio: 'pipe' }); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  throw new Error('openssl не найден');
}

// Ключ ECDSA P-256: его понимают и OpenSSL в Node, и BoringSSL в Electron.
function createDevice(dir, id = randomUUID()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'id'), id);
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '3650',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', `/CN=${id}`, '-addext', `subjectAltName=DNS:${id}.link.nox`]);
  return id;
}

module.exports = { createDevice };
