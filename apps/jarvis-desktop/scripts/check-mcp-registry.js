'use strict';

// Проверка записей каталога MCP в реестрах: пакеты npm, пакеты PyPI и HTTP-адреса сервисов.
// Только сетевые GET. Ничего не устанавливает, не запускает серверы и не пишет секреты.
//
// Запуск из apps/jarvis-desktop:
//   node scripts/check-mcp-registry.js                 — таблица и итог, код 1 при промахах
//   node scripts/check-mcp-registry.js --json          — только JSON в stdout
//   node scripts/check-mcp-registry.js --out report.json
//   node scripts/check-mcp-registry.js --allow-fail    — код 0 даже при промахах
//   node scripts/check-mcp-registry.js --only stripe --only git
//
// Для stdio-записей: npx.cmd -y <пакет> ищем в реестре npm, uvx <пакет> — в PyPI.
// Для http-записей: делаем GET и читаем только статус (тело не скачиваем).
// Записи, которых нет в реестре, отмечаются в отчёте; каталог скрипт не меняет.

const fs = require('fs');
const path = require('path');
const https = require('https');

const { CATALOG } = require('../src/mcp/catalog');

const TIMEOUT_MS = 25000;
const CONCURRENCY = 5;
const USER_AGENT = 'nox-mcp-registry-check/1.0 (Nox Assistant catalog verification; GET only)';

function argValue(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}
function has(name) {
  return process.argv.includes('--' + name);
}

function normalizePypiName(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

// Разбор пакета из запуска: npx.cmd -y '<пакет>' / uvx '<пакет>'.
function parsePackage(entry) {
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (entry.command === 'npx.cmd') {
    if (args[0] !== '-y') return { ok: false, error: 'у npx первым аргументом должно быть -y' };
    if (!args[1]) return { ok: false, error: 'у npx нет пакета' };
    const spec = String(args[1]);
    let base = spec;
    let version = '';
    const at = spec.indexOf('@', 1);
    if (at > 0) {
      base = spec.slice(0, at);
      version = spec.slice(at + 1);
    }
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(base)) return { ok: false, error: 'имя npm-пакета с недопустимыми знаками: ' + spec };
    if (version && !/^(latest|[\w.*^~<>=| -]+)$/.test(version)) return { ok: false, error: 'странная метка версии npm: ' + version };
    return { ok: true, registry: 'npm', package: base, spec, version };
  }
  if (entry.command === 'uvx') {
    if (!args[0]) return { ok: false, error: 'у uvx нет пакета' };
    const spec = String(args[0]);
    const at = spec.indexOf('@');
    const base = at > 0 ? spec.slice(0, at) : spec;
    const version = at > 0 ? spec.slice(at + 1) : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base)) return { ok: false, error: 'имя PyPI-пакета с недопустимыми знаками: ' + spec };
    return { ok: true, registry: 'pypi', package: normalizePypiName(base), spec, version };
  }
  return { ok: false, error: 'неизвестная команда запуска: ' + entry.command };
}

function get(url, options) {
  const settings = options || {};
  return new Promise((resolve) => {
    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    const request = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: settings.accept || 'application/json' },
      timeout: TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode || 0;
      if (settings.headersOnly) {
        // Тело не скачиваем: статус уже известен.
        response.destroy();
        done({ status, headers: response.headers, body: null });
        return;
      }
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        get(next, options).then(done);
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          request.destroy(new Error('ответ больше 4 МБ'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => done({ status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error('таймаут ' + TIMEOUT_MS + ' мс')));
    request.on('error', (err) => done({ status: 0, error: err && err.message ? err.message : String(err), body: null }));
  });
}

async function withRetry(fn, attempts) {
  const limit = attempts || 3;
  let last = null;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    last = await fn();
    if (last && last.status && last.status !== 429 && last.status < 500) return last;
    if (last && last.status === 404) return last;
    if (attempt < limit - 1) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
  }
  return last;
}

async function checkNpm(item) {
  const url = 'https://registry.npmjs.org/' + encodeURIComponent(item.package);
  const response = await withRetry(() => get(url));
  if (response.status === 200 && response.body) {
    let data = null;
    try { data = JSON.parse(response.body); } catch (err) { data = null; }
    if (!data) return { found: false, status: 200, version: null, note: 'реестр вернул не JSON' };
    const latest = data['dist-tags'] && data['dist-tags'].latest ? data['dist-tags'].latest : null;
    const versions = data.versions && typeof data.versions === 'object' ? Object.keys(data.versions) : [];
    const version = latest || versions[versions.length - 1] || null;
    return { found: true, status: 200, version, note: latest ? 'version=latest' : 'версия не по метке latest' };
  }
  if (response.status === 404) return { found: false, status: 404, version: null, note: 'пакет не найден в npm' };
  if (!response.status) return { found: false, status: 0, version: null, note: response.error || 'нет ответа' };
  return { found: false, status: response.status, version: null, note: 'реестр ответил ' + response.status };
}

async function checkPypi(item) {
  const url = 'https://pypi.org/pypi/' + encodeURIComponent(item.package) + '/json';
  const response = await withRetry(() => get(url));
  if (response.status === 200 && response.body) {
    let data = null;
    try { data = JSON.parse(response.body); } catch (err) { data = null; }
    if (!data || !data.info) return { found: false, status: 200, version: null, note: 'PyPI вернул не JSON' };
    const canonical = data.info.name ? normalizePypiName(data.info.name) : item.package;
    const note = canonical !== item.package ? 'каноническое имя: ' + data.info.name : '';
    if (data.info.yanked) return { found: true, status: 200, version: data.info.version || null, note: [note, 'все версии yanked'].filter(Boolean).join('; ') };
    return { found: true, status: 200, version: data.info.version || null, note };
  }
  if (response.status === 404) return { found: false, status: 404, version: null, note: 'пакет не найден в PyPI' };
  if (!response.status) return { found: false, status: 0, version: null, note: response.error || 'нет ответа' };
  return { found: false, status: response.status, version: null, note: 'PyPI ответил ' + response.status };
}

async function checkUrl(item) {
  const response = await withRetry(() => get(item.url, { headersOnly: true, accept: 'text/event-stream, application/json;q=0.9, */*;q=0.1' }));
  const status = response.status || 0;
  // 2xx/3xx — адрес существует; 401/403/405 — существует, но просит вход или другой метод.
  const reachable = (status >= 200 && status < 400) || status === 401 || status === 403 || status === 405;
  const note = reachable
    ? (status >= 200 && status < 400 ? 'адрес отвечает' : 'адрес существует, нужен вход или другой метод')
    : (status === 404 ? 'адрес не найден' : status ? 'статус ' + status : (response.error || 'нет ответа'));
  return { found: reachable, status, version: null, note };
}

function targetOf(entry) {
  return entry.transport === 'http' ? entry.url : [entry.command].concat(entry.args || []).join(' ');
}

async function checkEntry(entry) {
  const base = { id: entry.id, transport: entry.transport, verified: entry.verified, target: targetOf(entry) };
  if (entry.transport === 'http') {
    const result = await checkUrl(entry);
    return { ...base, kind: 'url', package: entry.url, ...result };
  }
  const parsed = parsePackage(entry);
  if (!parsed.ok) return { ...base, kind: 'launch', package: null, found: false, status: 0, version: null, note: parsed.error };
  const result = parsed.registry === 'npm' ? await checkNpm(parsed) : await checkPypi(parsed);
  return {
    ...base,
    kind: parsed.registry,
    registry: parsed.registry,
    package: parsed.registry === 'npm' ? (parsed.version ? parsed.package + '@' + parsed.version : parsed.package) : parsed.spec,
    queried: parsed.package,
    ...result,
  };
}

async function runPool(items, worker, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit || CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = {
          id: items[index].id,
          transport: items[index].transport,
          verified: items[index].verified,
          target: targetOf(items[index]),
          kind: 'error',
          package: null,
          found: false,
          status: 0,
          version: null,
          note: err && err.message ? err.message : String(err),
        };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function pad(text, width) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length >= width) return value.slice(0, width - 1) + '…';
  return value + ' '.repeat(width - value.length);
}

function printTable(results) {
  const widths = [22, 7, 46, 16, 12, 7];
  console.log([pad('сервис', widths[0]), pad('транспорт', widths[1]), pad('пакет / адрес', widths[2]),
    pad('статус', widths[3]), pad('версия', widths[4]), pad('verified', widths[5])].join(' '));
  console.log(widths.map((width) => '-'.repeat(width)).join(' '));
  for (const row of results) {
    const status = row.found ? 'найден' : 'НЕ НАЙДЕН';
    const mark = row.found && row.verified !== true ? '→ true?'
      : (!row.found && row.verified === true ? 'ОШИБКА' : String(row.verified));
    console.log([pad(row.id, widths[0]), pad(row.transport, widths[1]), pad(row.package || row.target, widths[2]),
      pad(status + (row.status ? ' ' + row.status : ''), widths[3]), pad(row.version || '—', widths[4]), pad(mark, widths[5])].join(' '));
    if (!row.found && row.note) console.log('  ! ' + row.note);
  }
}

async function main() {
  const only = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--only' && process.argv[index + 1]) only.push(String(process.argv[index + 1]));
  }
  const selected = only.length ? CATALOG.filter((entry) => only.includes(entry.id)) : CATALOG.slice();
  if (!selected.length) {
    console.error('check-mcp-registry: нет записей для проверки (--only ничего не нашёл)');
    process.exitCode = 1;
    return;
  }
  const started = Date.now();
  const results = await runPool(selected, checkEntry, CONCURRENCY);
  const found = results.filter((row) => row.found).length;
  const missing = results.filter((row) => !row.found);
  const payload = {
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    total: results.length,
    found,
    missing: missing.length,
    results,
  };

  const outFile = argValue('out', '');
  if (outFile) {
    const target = path.resolve(process.cwd(), outFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
  }

  if (has('json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printTable(results);
    console.log('');
    console.log('Итого: найдено ' + found + ' из ' + results.length + ', нет ' + missing.length
      + ', время ' + Math.round(payload.elapsedMs / 1000) + ' с.');
    const shouldBeTrue = results.filter((row) => row.found && row.verified !== true).map((row) => row.id);
    const shouldBeFalse = results.filter((row) => !row.found && row.verified === true).map((row) => row.id);
    if (shouldBeTrue.length) console.log('Можно поставить verified:true: ' + shouldBeTrue.join(', '));
    if (shouldBeFalse.length) console.log('Стоит проверить/исправить (verified:true, но не найдено): ' + shouldBeFalse.join(', '));
  }

  if (missing.length && !has('allow-fail')) process.exitCode = 1;
}

main().catch((err) => {
  console.error('check-mcp-registry: ' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
});
