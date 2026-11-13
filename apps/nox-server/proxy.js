'use strict';

const net = require('node:net');

function canonicalizeIpv6(ip) {
  try {
    const url = new URL(`http://[${ip}]/`);
    const host = url.hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mapped) {
      const hi = Number.parseInt(mapped[1], 16);
      const lo = Number.parseInt(mapped[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return host;
  } catch {
    return ip.toLowerCase();
  }
}

/**
 * Приводит IP к каноничному виду и разворачивает IPv4-mapped IPv6 (::ffff:a.b.c.d).
 */
function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (!ip) return '';
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1 && ip.includes(':')) ip = ip.slice(0, zoneIdx);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) {
    const v4 = ip.slice(7);
    if (net.isIPv4(v4)) return v4;
  }
  const ver = net.isIP(ip);
  if (!ver) return '';
  return ver === 6 ? canonicalizeIpv6(ip) : ip;
}

const LOOPBACK_LIST = new net.BlockList();
LOOPBACK_LIST.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_LIST.addAddress('::1', 'ipv6');

function isLoopbackAddress(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  return LOOPBACK_LIST.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
}

function buildTrustedList(trustedProxies) {
  const list = new net.BlockList();
  let entries;
  if (trustedProxies === undefined || trustedProxies === null) {
    // По умолчанию при trustProxy=true доверяем только локальному reverse-proxy на loopback.
    entries = ['127.0.0.0/8', '::1'];
  } else if (Array.isArray(trustedProxies)) {
    entries = trustedProxies;
  } else if (typeof trustedProxies === 'string') {
    entries = trustedProxies.split(',');
  } else {
    throw new Error('trustedProxies должен быть строкой или массивом');
  }

  let count = 0;
  for (const rawEntry of entries) {
    const item = String(rawEntry ?? '').trim();
    if (!item) continue;
    const slashIdx = item.indexOf('/');
    if (slashIdx !== -1) {
      const addrPart = item.slice(0, slashIdx).trim();
      const prefixStr = item.slice(slashIdx + 1).trim();
      const ip = normalizeIp(addrPart);
      if (!ip || !/^\d+$/.test(prefixStr)) {
        throw new Error(`некорректная подсеть в trustedProxies: ${item}`);
      }
      const prefix = Number(prefixStr);
      const family = net.isIPv4(ip) ? 'ipv4' : 'ipv6';
      const maxPrefix = family === 'ipv4' ? 32 : 128;
      if (prefix < 0 || prefix > maxPrefix) {
        throw new Error(`некорректная маска в trustedProxies: ${item}`);
      }
      list.addSubnet(ip, prefix, family);
      count += 1;
    } else {
      const ip = normalizeIp(item);
      if (!ip) {
        throw new Error(`некорректный IP в trustedProxies: ${item}`);
      }
      list.addAddress(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
      count += 1;
    }
  }
  return { list, empty: count === 0 };
}

function parseForwardedProto(rawHeader) {
  const raw = Array.isArray(rawHeader) ? rawHeader.join(',') : String(rawHeader ?? '');
  const parts = raw.split(',').map((s) => s.trim().toLowerCase());
  if (parts.length === 0) return '';
  for (const part of parts) {
    if (part !== 'http' && part !== 'https') return '';
  }
  return parts[parts.length - 1];
}

/**
 * Создаёт определитель клиентского IP и защищённого транспорта без доверия клиентским заголовкам.
 */
function createProxyResolver({ trustProxy = false, trustedProxies } = {}) {
  const enabled = Boolean(trustProxy);
  const { list, empty } = enabled ? buildTrustedList(trustedProxies) : { list: null, empty: true };

  function isTrustedPeer(ip) {
    if (!enabled || empty || !ip) return false;
    return list.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
  }

  function peerAddress(req) {
    return normalizeIp(req?.socket?.remoteAddress || '');
  }

  function clientIp(req) {
    const peer = peerAddress(req);
    if (!peer) return 'unknown';
    if (!isTrustedPeer(peer)) return peer;

    const rawXff = req?.headers?.['x-forwarded-for'];
    if (rawXff === undefined) return peer;
    const xffStr = Array.isArray(rawXff) ? rawXff.join(',') : String(rawXff);
    if (!xffStr.trim()) return peer;

    // Разбираем цепочку справа налево: последний доверенный прокси дописывает реального клиента справа.
    const parts = xffStr.split(',');
    let lastTrusted = '';
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const hop = normalizeIp(parts[i]);
      if (!hop) {
        // Некорректный или пустой элемент прерывает обход, не доверяя подделанной левой части.
        return lastTrusted || peer;
      }
      if (!isTrustedPeer(hop)) return hop;
      lastTrusted = hop;
    }
    return lastTrusted || peer;
  }

  function isSecureTransport(req) {
    if (req?.socket?.encrypted) return true;
    const peer = peerAddress(req);
    if (!peer) return false;
    if (!isTrustedPeer(peer)) {
      return isLoopbackAddress(peer);
    }

    const rawProto = req?.headers?.['x-forwarded-proto'];
    if (rawProto !== undefined) {
      return parseForwardedProto(rawProto) === 'https';
    }

    // Без X-Forwarded-Proto удалённое соединение по открытому HTTP не считается защищённым.
    return isLoopbackAddress(peer) && isLoopbackAddress(clientIp(req));
  }

  return {
    trustProxy: enabled,
    isTrustedPeer,
    peerAddress,
    clientIp,
    isSecureTransport,
  };
}

module.exports = {
  normalizeIp,
  isLoopbackAddress,
  createProxyResolver,
};
