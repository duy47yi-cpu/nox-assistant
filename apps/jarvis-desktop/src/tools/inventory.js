const { runPowerShell } = require('./system');

const SCAN_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Инструменты списка программ: поиск, повторный скан и снимок запущенного. Только чтение, ничего не запускают.
function inventoryTools({ inventory, usage, runPS = runPowerShell }) {
  const appsFind = {
    name: 'apps_find',
    description: 'Найти программу в списке установленных у владельца (по части названия). Нужно, если не уверен, что программа есть.',
    risk: 'T0',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 100 },
      },
      required: ['query'],
    },
    async run(args) {
      if (!inventory.scannedAt) {
        return { ok: false, summary: 'список программ ещё не прочитан', data: {} };
      }
      const hits = inventory.find(args.query).slice(0, 10);
      if (hits.length === 0) return { ok: true, summary: `в списке программ нет: ${args.query}`, data: { matches: [] } };
      return {
        ok: true,
        summary: hits.map((e) => e.name).join(', '),
        data: { matches: hits.map((e) => ({ name: e.name, path: e.path })) },
      };
    },
  };

  // Повторный скан: не чаще раза в сутки. Джарвис вызывает его сам, когда считает нужным.
  const appsScan = {
    name: 'apps_scan',
    description: 'Перечитать список установленных программ. Не чаще раза в сутки; вызывай, если список явно устарел или владелец просит обновить.',
    risk: 'T0',
    parameters: { type: 'object', properties: {} },
    async run(args) {
      const last = inventory.scannedAt ? Date.parse(inventory.scannedAt) : 0;
      if (last && Date.now() - last < SCAN_MIN_INTERVAL_MS) {
        return { ok: true, summary: 'список свежий, перечитывать не нужно', data: { count: inventory.entries.length } };
      }
      const res = await inventory.scan(runPS);
      return res.ok
        ? { ok: true, summary: `список обновлён: ${res.count} записей`, data: { count: res.count } }
        : { ok: false, summary: `не получилось: ${res.error}`, data: {} };
    },
  };

  // Что запущено из списка прямо сейчас. Раз в сутки, если не просили явно.
  const appsUsage = {
    name: 'apps_usage',
    description: 'Посмотреть, какие программы из списка сейчас запущены, и чем владелец пользуется чаще всего. Не чаще раза в сутки.',
    risk: 'T0',
    parameters: { type: 'object', properties: { force: { type: 'boolean' } } },
    async run(args) {
      const res = await usage.snapshot(inventory, runPS, { force: args.force === true });
      if (res.skipped) {
        return { ok: true, summary: `${res.summary}; самые частые: ${usage.topApps().join(', ') || 'пока нет данных'}`, data: { top: usage.topApps() } };
      }
      return res.ok
        ? { ok: true, summary: `${res.summary}; самые частые: ${usage.topApps().join(', ') || 'пока нет данных'}`, data: { seen: res.seen, top: usage.topApps() } }
        : { ok: false, summary: res.summary, data: {} };
    },
  };

  return [appsFind, appsScan, appsUsage];
}

module.exports = { inventoryTools, SCAN_MIN_INTERVAL_MS };
