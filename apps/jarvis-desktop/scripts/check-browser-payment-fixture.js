'use strict';

// Локальный стенд для проверки настоящего скрипта browser_click в чистом браузере.
// Никаких платёжных запросов и пользовательских данных здесь нет.
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../src/tools/browser.js'), 'utf8');
const match = /const CLICK_FN = `([\s\S]*?)`;/.exec(source);
if (!match) throw new Error('Скрипт browser_click не найден');
const clickFn = vm.runInNewContext('`' + match[1] + '`');
const html = `<!doctype html><meta charset="utf-8"><title>Nox test</title>
<button id="payment">Продолжить</button><button id="normal">Дальше</button>
<output id="result">ожидание</output>
<script>
let clicks = 0;
const payment = document.querySelector('#payment');
const normal = document.querySelector('#normal');
payment.addEventListener('focus', () => { payment.textContent = 'Оплатить'; });
payment.addEventListener('click', () => { clicks++; });
normal.addEventListener('click', () => { clicks++; });
window.__noxEls = [payment, normal];
const click = ${clickFn};
const blocked = click(1);
const passed = click(2);
const result = document.querySelector('#result');
result.textContent = JSON.stringify({ blocked, passed, clicks });
result.dataset.status = !blocked.ok && blocked.why === 'payment' && passed.ok && clicks === 1 ? 'passed' : 'failed';
</script>`;

const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
server.listen(18766, '127.0.0.1', () => console.log('http://127.0.0.1:18766/'));
