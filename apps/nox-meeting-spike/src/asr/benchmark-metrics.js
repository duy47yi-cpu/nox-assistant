'use strict';

/**
 * Normalizes transcript text for fair WER/CER evaluation across punctuation/casing variants.
 * Replaces Russian 'ё' -> 'е' by default to avoid penalizing standard ASR orthography drift.
 *
 * @param {string} text
 * @param {object} [options]
 * @returns {string}
 */
function normalizeTextForEval(text, options = {}) {
  if (typeof text !== 'string') {
    return '';
  }
  const normalizeYo = options.normalizeYo !== false;
  let normalized = text.toLowerCase();
  if (normalizeYo) {
    normalized = normalized.replace(/ё/g, 'е');
  }
  normalized = normalized.replace(/[\p{P}\p{S}]+/gu, ' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * Computes minimum Levenshtein edit distance plus S/D/I breakdown between two token arrays.
 *
 * @param {Array<string>} ref
 * @param {Array<string>} hyp
 * @returns {{ distance: number, substitutions: number, deletions: number, insertions: number }}
 */
function levenshteinBreakdown(ref, hyp) {
  const m = ref.length;
  const n = hyp.length;
  const cost = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  const op = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  // Op codes: 0 = match/sub, 1 = deletion (from ref), 2 = insertion (into hyp)

  for (let i = 1; i <= m; i += 1) {
    cost[i][0] = i;
    op[i][0] = 1;
  }
  for (let j = 1; j <= n; j += 1) {
    cost[0][j] = j;
    op[0][j] = 2;
  }

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (ref[i - 1] === hyp[j - 1]) {
        cost[i][j] = cost[i - 1][j - 1];
        op[i][j] = 0;
      } else {
        const subCost = cost[i - 1][j - 1] + 1;
        const delCost = cost[i - 1][j] + 1;
        const insCost = cost[i][j - 1] + 1;
        if (subCost <= delCost && subCost <= insCost) {
          cost[i][j] = subCost;
          op[i][j] = 0;
        } else if (delCost <= insCost) {
          cost[i][j] = delCost;
          op[i][j] = 1;
        } else {
          cost[i][j] = insCost;
          op[i][j] = 2;
        }
      }
    }
  }

  let i = m;
  let j = n;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  while (i > 0 || j > 0) {
    const code = op[i][j];
    if (i > 0 && j > 0 && code === 0) {
      if (ref[i - 1] !== hyp[j - 1]) {
        substitutions += 1;
      }
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || code === 1)) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }

  return {
    distance: cost[m][n],
    substitutions,
    deletions,
    insertions,
  };
}

/**
 * Computes Word Error Rate (WER) on normalized reference vs hypothesis text.
 *
 * @param {string} referenceText
 * @param {string} hypothesisText
 * @param {object} [options]
 * @returns {object}
 */
function wordErrorRate(referenceText, hypothesisText, options = {}) {
  const refNorm = normalizeTextForEval(referenceText, options);
  const hypNorm = normalizeTextForEval(hypothesisText, options);
  const refWords = refNorm ? refNorm.split(' ') : [];
  const hypWords = hypNorm ? hypNorm.split(' ') : [];

  const breakdown = levenshteinBreakdown(refWords, hypWords);
  const denom = refWords.length;
  const wer = denom === 0 ? (hypWords.length === 0 ? 0 : 1) : breakdown.distance / denom;

  return {
    wer: Number(wer.toFixed(4)),
    werPercent: Number((wer * 100).toFixed(2)),
    wordErrors: breakdown.distance,
    refWords: denom,
    hypWords: hypWords.length,
    substitutions: breakdown.substitutions,
    deletions: breakdown.deletions,
    insertions: breakdown.insertions,
  };
}

/**
 * Computes Character Error Rate (CER) on normalized reference vs hypothesis text.
 *
 * @param {string} referenceText
 * @param {string} hypothesisText
 * @param {object} [options]
 * @returns {object}
 */
function characterErrorRate(referenceText, hypothesisText, options = {}) {
  const refNorm = normalizeTextForEval(referenceText, options);
  const hypNorm = normalizeTextForEval(hypothesisText, options);
  const refChars = Array.from(options.includeSpaces ? refNorm : refNorm.replace(/\s+/g, ''));
  const hypChars = Array.from(options.includeSpaces ? hypNorm : hypNorm.replace(/\s+/g, ''));

  const breakdown = levenshteinBreakdown(refChars, hypChars);
  const denom = refChars.length;
  const cer = denom === 0 ? (hypChars.length === 0 ? 0 : 1) : breakdown.distance / denom;

  return {
    cer: Number(cer.toFixed(4)),
    cerPercent: Number((cer * 100).toFixed(2)),
    charErrors: breakdown.distance,
    refChars: denom,
    hypChars: hypChars.length,
  };
}

function percentile(sortedNumbers, p) {
  if (!sortedNumbers.length) {
    return 0;
  }
  const idx = Math.min(
    sortedNumbers.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedNumbers.length) - 1)
  );
  return sortedNumbers[idx];
}

/**
 * Summarizes latency sample array in milliseconds.
 *
 * @param {Array<number>} samples
 * @returns {{ count: number, minMs: number, meanMs: number, p50Ms: number, p95Ms: number, maxMs: number }}
 */
function summarizeLatencySamples(samples) {
  const valid = (samples || []).filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  if (!valid.length) {
    return { count: 0, minMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: Number(sorted[0].toFixed(3)),
    meanMs: Number((sum / sorted.length).toFixed(3)),
    p50Ms: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

/**
 * Summarizes Real-Time Factor (RTF) and CPU load metrics.
 *
 * @param {{ wallTimeMs: number, decodeTimeMs: number, cpuTimeMs: number, audioDurationMs: number }} input
 * @returns {object}
 */
function summarizeRtf(input) {
  const audioMs = Number.isFinite(input.audioDurationMs) && input.audioDurationMs > 0
    ? input.audioDurationMs
    : 0;
  const wallMs = Number.isFinite(input.wallTimeMs) && input.wallTimeMs >= 0 ? input.wallTimeMs : 0;
  const decodeMs = Number.isFinite(input.decodeTimeMs) && input.decodeTimeMs >= 0
    ? input.decodeTimeMs
    : wallMs;
  const cpuMs = Number.isFinite(input.cpuTimeMs) && input.cpuTimeMs >= 0 ? input.cpuTimeMs : 0;

  if (audioMs === 0) {
    return {
      audioDurationMs: 0,
      wallTimeMs: Number(wallMs.toFixed(3)),
      decodeTimeMs: Number(decodeMs.toFixed(3)),
      cpuTimeMs: Number(cpuMs.toFixed(3)),
      wallRtf: 0,
      decodeRtf: 0,
      cpuRtf: 0,
      cpuPercentOfWall: 0,
      fasterThanRealtime: false,
    };
  }

  const wallRtf = wallMs / audioMs;
  const decodeRtf = decodeMs / audioMs;
  const cpuRtf = cpuMs / audioMs;
  const cpuPercentOfWall = wallMs > 0 ? (cpuMs / wallMs) * 100 : 0;

  return {
    audioDurationMs: Math.round(audioMs),
    wallTimeMs: Number(wallMs.toFixed(3)),
    decodeTimeMs: Number(decodeMs.toFixed(3)),
    cpuTimeMs: Number(cpuMs.toFixed(3)),
    wallRtf: Number(wallRtf.toFixed(4)),
    decodeRtf: Number(decodeRtf.toFixed(4)),
    cpuRtf: Number(cpuRtf.toFixed(4)),
    cpuPercentOfWall: Number(cpuPercentOfWall.toFixed(2)),
    fasterThanRealtime: decodeRtf < 1,
  };
}

module.exports = {
  normalizeTextForEval,
  levenshteinBreakdown,
  wordErrorRate,
  characterErrorRate,
  summarizeLatencySamples,
  summarizeRtf,
};
