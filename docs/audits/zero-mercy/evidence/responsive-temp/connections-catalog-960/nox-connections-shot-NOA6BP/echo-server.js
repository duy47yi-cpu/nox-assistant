'use strict';
const readline = require('readline');
const TOOLS = [
  { name: 'repeat', title: 'Повтор', description: 'Повторить текст', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'sum', title: 'Сложить', description: 'Сложить два числа', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];
const rl = readline.createInterface({ input: process.stdin });
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo-fixture', version: '1.0.0' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); return; }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    const out = name === 'repeat' ? String(args.text || '') : String((Number(args.a) || 0) + (Number(args.b) || 0));
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: out }] } });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'метод не поддерживается' } });
});
process.stdin.on('end', () => process.exit(0));
