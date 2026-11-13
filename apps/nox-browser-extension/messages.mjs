export const VERSION = 'nox-bridge-2';
export const MAX_FRAME_BYTES = 65536;
export const MAX_TEXT_BYTES = 49152;
export const MAX_TITLE_BYTES = 512;
export const MAX_ORIGIN_BYTES = 512;
export const GRANT_TTL_MS = 60000;
export const MAX_SESSION_TTL_MS = 3600000;
export const DEFAULT_READ_TIMEOUT_MS = 10000;
export const MAX_READ_TIMEOUT_MS = 30000;

// Legacy unauthenticated snapshot transport remains permanently disabled.
export const SNAPSHOT_TRANSPORT_ENABLED = false;

const encoder = new TextEncoder();

export const validHex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export const utf8Bytes = value => encoder.encode(value).byteLength;

export function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function truncateUtf8(str, maxBytes) {
  if (typeof str !== 'string' || maxBytes < 0) return { text: '', truncated: Boolean(str) };
  if (utf8Bytes(str) <= maxBytes) return { text: str, truncated: false };
  if (maxBytes === 0) return { text: '', truncated: str.length > 0 };

  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    let end = mid;
    if (end > 0) {
      const prev = str.charCodeAt(end - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) end--;
    }
    if (end === lo) {
      const pairEnd = lo + 2 <= hi ? lo + 2 : lo;
      if (pairEnd > lo && utf8Bytes(str.slice(0, pairEnd)) <= maxBytes) lo = pairEnd;
      break;
    }
    if (utf8Bytes(str.slice(0, end)) <= maxBytes) lo = end;
    else hi = end - 1;
  }
  if (lo > 0) {
    const last = str.charCodeAt(lo - 1);
    if (last >= 0xd800 && last <= 0xdbff) lo--;
  }
  return { text: str.slice(0, lo), truncated: true };
}

// Guarantees the signed JSON read_result frame never exceeds 64 KiB even under heavy JSON escaping.
export function fitReadResultFrame({ seq, requestId, origin, title, text, truncated = false }) {
  const titleCut = truncateUtf8(title, MAX_TITLE_BYTES);
  const textCut = truncateUtf8(text, MAX_TEXT_BYTES);
  let isTruncated = Boolean(truncated || titleCut.truncated || textCut.truncated);
  let finalText = textCut.text;

  const placeholderProof = '0'.repeat(64);
  const buildJson = (candidateText, candidateTruncated) =>
    JSON.stringify({
      type: 'read_result',
      seq,
      requestId,
      ok: true,
      origin,
      title: titleCut.text,
      text: candidateText,
      truncated: candidateTruncated,
      proof: placeholderProof,
    });

  if (utf8Bytes(buildJson(finalText, isTruncated)) > MAX_FRAME_BYTES) {
    isTruncated = true;
    let lo = 0;
    let hi = finalText.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      let end = mid;
      if (end > 0) {
        const prev = finalText.charCodeAt(end - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) end--;
      }
      if (end === lo) {
        const pairEnd = lo + 2 <= hi ? lo + 2 : lo;
        if (pairEnd > lo && utf8Bytes(buildJson(finalText.slice(0, pairEnd), true)) <= MAX_FRAME_BYTES) {
          lo = pairEnd;
        }
        break;
      }
      if (utf8Bytes(buildJson(finalText.slice(0, end), true)) <= MAX_FRAME_BYTES) lo = end;
      else hi = end - 1;
    }
    if (lo > 0) {
      const last = finalText.charCodeAt(lo - 1);
      if (last >= 0xd800 && last <= 0xdbff) lo--;
    }
    finalText = finalText.slice(0, lo);
    if (utf8Bytes(buildJson(finalText, true)) > MAX_FRAME_BYTES) {
      throw new Error('read_result exceeds 64 KiB frame limit');
    }
  }

  return {
    origin,
    title: titleCut.text,
    text: finalText,
    truncated: isTruncated,
  };
}
