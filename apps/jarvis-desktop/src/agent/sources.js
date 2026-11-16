'use strict';

const SEARCH_TOOLS = new Set(['web_search', 'web_research', 'web_wiki']);
const iconCache = new Map();
const MAX_ICON_BYTES = 64 * 1024;

async function fetchIcon(host) {
  try {
    const response = await fetch(`https://icons.duckduckgo.com/ip3/${host}.ico`, {
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok || !response.body) return null;
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_ICON_BYTES) return null;
      chunks.push(chunk);
    }
    const image = Buffer.concat(chunks);
    const signature = image.subarray(0, 8).toString('hex');
    const type = signature === '89504e470d0a1a0a' ? 'png'
      : signature.startsWith('00000100') ? 'x-icon' : null;
    return type ? `data:image/${type};base64,${image.toString('base64')}` : null;
  } catch {
    return null;
  }
}

function sourceIcon(host) {
  if (typeof host !== 'string' || host.length > 253 || !/^(?:[a-z\d-]{1,63}\.)+[a-z][a-z\d-]{1,62}$/i.test(host)) return null;
  if (!iconCache.has(host)) {
    if (iconCache.size >= 128) iconCache.delete(iconCache.keys().next().value);
    const pending = fetchIcon(host);
    iconCache.set(host, pending);
    pending.then((icon) => { if (!icon && iconCache.get(host) === pending) iconCache.delete(host); });
  }
  return iconCache.get(host);
}

function mergeSources(target, rows) {
  for (const row of rows || []) {
    if (typeof row?.url !== 'string' || row.url.length > 2048) continue;
    let url;
    try { url = new URL(row.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    url.hash = '';
    if (target.has(url.href)) continue;
    const title = typeof row.title === 'string' ? row.title.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    target.set(url.href, { url: url.href, title: title || url.hostname, host: url.hostname });
  }
}

function collectSearchSources(target, name, result) {
  if (!SEARCH_TOOLS.has(name) || result?.ok !== true || !result.data) return;
  const { results, sources } = result.data;
  const rows = name === 'web_search' ? results : name === 'web_research' ? sources : [result.data];
  if (Array.isArray(rows)) mergeSources(target, rows);
}

function chatHistoryRows(history) {
  const rows = [];
  const calls = new Map();
  const sources = new Map();
  for (const message of history) {
    if (message.role === 'user' && !message.fromTool) {
      calls.clear();
      sources.clear();
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = call?.function?.name;
        if (SEARCH_TOOLS.has(name)) calls.set(call.id, name);
      }
    }
    if (message.role === 'tool' && calls.has(message.tool_call_id)) {
      try {
        collectSearchSources(sources, calls.get(message.tool_call_id), JSON.parse(message.content));
      } catch { /* В старой истории результат может быть скрыт или обрезан. */ }
      calls.delete(message.tool_call_id);
    }
    const isReply = message.role === 'assistant' && !message.tool_calls?.length;
    const replyDetails = isReply && (message.artifacts?.length || message.clarification?.length || message.partial?.length);
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || (!message.content.trim() && !replyDetails)) continue;
    const row = { role: message.role, text: message.content.slice(0, 2000) };
    if (isReply) {
      for (const field of ['artifacts', 'clarification', 'partial']) {
        if (Array.isArray(message[field]) && message[field].length) row[field] = message[field];
      }
      if (Array.isArray(message.searchSources)) mergeSources(sources, message.searchSources);
      if (sources.size) row.searchSources = [...sources.values()];
      sources.clear();
    }
    rows.push(row);
  }
  return rows.slice(-100);
}

module.exports = { collectSearchSources, chatHistoryRows, sourceIcon };
