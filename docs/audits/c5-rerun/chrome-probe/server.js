'use strict';
// Audit probe server: records the HTTP upgrade request headers from a real Chrome service worker.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const bridgeDir = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'nox-browser-bridge');
const load = createRequire(path.join(bridgeDir, 'package.json'));
const { WebSocketServer } = load('ws');

const OUT = path.join(__dirname, 'probe-result.json');
const PORT = 28417;
const results = [];

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  results.push({
    at: new Date().toISOString(),
    url: req.url,
    origin: req.headers.origin ?? null,
    host: req.headers.host ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  });
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws);
  });
});

wss.on('connection', ws => {
  ws.on('message', data => {
    results.push({ message: data.toString().slice(0, 500) });
    write();
  });
  ws.on('error', () => {});
});

function write() {
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}

write();
server.listen(PORT, '127.0.0.1', () => {
  results.push({ listening: `127.0.0.1:${PORT}`, at: new Date().toISOString() });
  write();
});

setTimeout(() => {
  write();
  process.exit(0);
}, 20000);
