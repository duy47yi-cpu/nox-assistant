'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;

function eligible(args = {}) {
  if ((args.purpose || 'chat') !== 'chat' || args.toolChoice !== 'none') return false;
  if (args.taskId != null || args.taskBudgetUsd != null || typeof args.onDelta === 'function') return false;
  if (args.signal && (typeof args.signal.aborted !== 'boolean' || args.signal.aborted)) return false;
  if (!Array.isArray(args.messages) || args.messages.length === 0 || args.messages.length > 100) return false;
  return args.messages.every((message) => message && typeof message.role === 'string' && typeof message.content === 'string');
}

function createResponseCache({ now = Date.now, ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  if (typeof now !== 'function') throw new Error('response cache: часы должны быть функцией');
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('response cache: срок должен быть целым числом больше нуля');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('response cache: размер должен быть целым числом больше нуля');
  const entries = new Map();

  function key(args, scope) {
    try {
      const exact = JSON.stringify({
        scope, messages: args.messages, tools: args.tools || [], toolChoice: args.toolChoice,
        tier: args.tier, thinking: args.thinking, maxTokens: args.maxTokens,
      });
      return crypto.createHash('sha256').update(exact).digest('hex');
    } catch {
      return null;
    }
  }

  function get(args, scope) {
    if (!eligible(args)) return null;
    const id = key(args, scope);
    if (!id) return null;
    const item = entries.get(id);
    if (!item) return null;
    if (item.expiresAt <= now()) {
      entries.delete(id);
      return null;
    }
    entries.delete(id);
    entries.set(id, item);
    const result = { content: item.content, reasoningContent: null, toolCalls: [] };
    Object.defineProperty(result, 'stats', {
      enumerable: false,
      value: { cached: true, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, requestChars: item.requestChars, attempts: 0, ms: 0 },
    });
    return result;
  }

  function set(args, result, scope) {
    if (!eligible(args) || !result || typeof result.content !== 'string' || !result.content.trim()) return false;
    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
    const id = key(args, scope);
    if (!id) return false;
    const requestChars = JSON.stringify({ messages: args.messages, tools: args.tools || [] }).length;
    entries.delete(id);
    entries.set(id, { content: result.content, requestChars, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return true;
  }

  return { get, set, clear: () => entries.clear(), get size() { return entries.size; } };
}

module.exports = { createResponseCache, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
