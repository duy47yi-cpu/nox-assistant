'use strict';

// Сводка по журналу скорости ходов (data/turns.jsonl).
// Запуск: npm run turns            — последние 20 ходов и общая сводка
//         npm run turns -- 50      — последние 50 ходов
//         node scripts/turns-report.js путь\к\turns.jsonl [N]
// В журнале нет текстов сообщений: только время, число сообщений, токены и имена инструментов.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function resolveFile(arg) {
  if (arg && !/^\d+$/.test(arg)) return arg;
  let dataDir = process.env.NOX_DATA_DIR;
  if (!dataDir) {
    const { makeConfig } = require('../src/config/env');
    dataDir = makeConfig(ROOT)('NOX_DATA_DIR');
  }
  return path.join(dataDir || path.join(ROOT, 'data'), 'turns.jsonl');
}

function readRecords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // битая строка: пропускаем
    }
  }
  return out;
}

const sec = (ms) => `${(Number(ms || 0) / 1000).toFixed(1)}с`;

function pct(values, p) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

function main() {
  const args = process.argv.slice(2);
  const file = resolveFile(args.find((a) => !/^\d+$/.test(a)));
  const limit = Number(args.find((a) => /^\d+$/.test(a))) || 20;
  if (!fs.existsSync(file)) {
    console.log(`журнала нет: ${file}`);
    console.log('Он появится после первого хода с моделью (NOX_TURNS_LOG не должен быть off).');
    process.exit(1);
  }
  const records = readRecords(file);
  const turns = records.filter((r) => r.kind === 'turn').slice(-limit);
  const byTurn = new Map();
  for (const r of records) {
    if (r.kind === 'turn') continue;
    if (!byTurn.has(r.turn)) byTurn.set(r.turn, []);
    byTurn.get(r.turn).push(r);
  }

  console.log(`файл: ${file}`);
  console.log(`ходов в сводке: ${turns.length}\n`);
  for (const t of turns) {
    const parts = byTurn.get(t.turn) || [];
    const models = parts.filter((r) => r.kind === 'model');
    const tools = parts.filter((r) => r.kind === 'tool');
    console.log(
      `${new Date(t.ts).toLocaleString('ru-RU')}  ход ${t.turn}  всего ${sec(t.ms)}  итог: ${t.outcome}  `
      + `модель ${t.modelCalls}× = ${sec(t.modelMs)}  инструменты ${t.toolCalls} = ${sec(t.toolWallMs)}`
      + `${t.waitMs ? `  ожидание подтверждения ${sec(t.waitMs)}` : ''}`,
    );
    for (const m of models) {
      const tok = m.promptTokens != null ? `  вход ${m.promptTokens} ток.${m.cachedTokens ? ` (кэш ${m.cachedTokens})` : ''}, выход ${m.completionTokens}` : '';
      const why = m.reasoningTokens != null ? `${m.reasoningTokens} ток.` : `${m.reasoningChars} симв.`;
      console.log(
        `    модель #${m.round}: ${sec(m.ms)}  сообщений ${m.messages}, инструментов ${m.tools}, запрос ${Math.round((m.requestChars || 0) / 1024)} КБ${tok}`
        + `  размышления ${why}  → ${m.ok === false ? `ошибка ${m.error}` : (m.toolCalls && m.toolCalls.length ? m.toolCalls.join(', ') : 'ответ текстом')}`
        + `${m.toolChoice === 'none' ? '  [без инструментов]' : ''}`,
      );
    }
    for (const x of tools) {
      console.log(`    инструмент ${x.name}: ${sec(x.ms)}  ${x.ok ? 'ok' : 'ошибка'}  ${x.decision}${x.repeat ? '  ПОВТОР' : ''}${x.waitMs ? `  ждал ${sec(x.waitMs)}` : ''}`);
    }
  }

  const models = records.filter((r) => r.kind === 'model' && turns.some((t) => t.turn === r.turn));
  const total = turns.map((t) => t.ms);
  const modelShare = turns.reduce((a, t) => a + t.modelMs, 0) / Math.max(1, turns.reduce((a, t) => a + t.ms, 0));
  console.log('\nСводка:');
  console.log(`  ход: медиана ${sec(pct(total, 0.5))}, 90% ${sec(pct(total, 0.9))}, максимум ${sec(Math.max(0, ...total))}`);
  console.log(`  вызов модели: медиана ${sec(pct(models.map((m) => m.ms), 0.5))}, 90% ${sec(pct(models.map((m) => m.ms), 0.9))}`);
  console.log(`  вызовов модели на ход: в среднем ${(models.length / Math.max(1, turns.length)).toFixed(1)}`);
  console.log(`  доля времени модели: ${Math.round(modelShare * 100)}%`);
  const prompt = models.map((m) => m.promptTokens).filter((v) => Number.isFinite(v));
  if (prompt.length) console.log(`  входных токенов на вызов: медиана ${pct(prompt, 0.5)}`);
  const reasoning = models.map((m) => m.reasoningChars || 0);
  console.log(`  размышлений на вызов: медиана ${pct(reasoning, 0.5)} симв.`);
  const outcomes = {};
  for (const t of turns) outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1;
  console.log(`  итоги: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

main();
