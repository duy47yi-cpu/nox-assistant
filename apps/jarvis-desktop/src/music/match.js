'use strict';

// Сверка названий видео с просьбой. Просьба идёт по-русски, названия часто по-английски:
// «тентасион» должно находить XXXTentacion. Сравниваем согласные после транслитерации, с допуском на одну-две ошибки.
// Чистые функции, без сети: решают, открыть видео сразу или спросить владельца.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(text) {
  let out = '';
  for (const ch of String(text).toLowerCase()) {
    out += Object.prototype.hasOwnProperty.call(CYR, ch) ? CYR[ch] : ch;
  }
  return out;
}

// Скелет слова: согласные в одном написании. Гласные пишут по-разному, поэтому их отбрасываем.
function skeleton(word) {
  let s = translit(word).replace(/[^a-z]/g, '');
  s = s.replace(/ph/g, 'f').replace(/th/g, 't').replace(/gh/g, '').replace(/sh|ch|zh/g, 's');
  s = s.replace(/[cz]/g, 's').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/w/g, 'v');
  return s.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}

// Слова из текста: буквы латиницы и кириллицы, без пунктуации.
function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-zа-яё]+/).filter(Boolean);
}

// Допуск на опечатки: короткие слова — точно, длинные — на одну-две буквы.
function tolerance(len) {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

function near(q, t) {
  if (q === t) return true;
  if (q.length >= 3 && t.includes(q)) return true;
  return levenshtein(q, t) <= tolerance(q.length);
}

// Доля слов просьбы, найденных в названии. total — сколько слов просьбы можно сверить.
function scoreTitle(query, title) {
  const qs = tokens(query).map(skeleton).filter((s) => s.length >= 2);
  if (!qs.length) return { ratio: 1, total: 0 };
  const ts = tokens(title).map(skeleton).filter(Boolean);
  const matched = qs.filter((q) => ts.some((t) => near(q, t))).length;
  return { ratio: matched / qs.length, total: qs.length };
}

// Выбор видео. confident — все слова просьбы нашлись в названии лучшего видео.
// options — до трёх лучших вариантов, чтобы владелец выбрал сам.
function chooseVideo(query, candidates, { options = 3 } = {}) {
  const list = Array.isArray(candidates) ? candidates.filter((v) => v && v.url) : [];
  if (!list.length) return { video: null, confident: false, options: [] };
  const scored = list
    .map((video, index) => ({ video, index, ratio: scoreTitle(query, video.title).ratio }))
    .sort((a, b) => b.ratio - a.ratio || a.index - b.index);
  const best = scored[0];
  return {
    video: best.video,
    confident: best.ratio >= 1,
    options: scored.slice(0, options).map((s) => s.video),
  };
}

// Ответ владельца на вопрос «какое видео»: «2», «второе», «вторая». Номер или null.
function parseChoice(text, max) {
  const t = String(text || '').trim().toLowerCase();
  const digit = /^(\d)(?![\d])/.exec(t);
  const word = /^(перв|втор|трет|один|одна|два|две|три)/.exec(t);
  let n = null;
  if (digit) n = Number(digit[1]);
  else if (word) n = { перв: 1, один: 1, одна: 1, втор: 2, два: 2, две: 2, трет: 3, три: 3 }[word[1]];
  return n && n >= 1 && n <= max ? n : null;
}

module.exports = { translit, skeleton, scoreTitle, chooseVideo, parseChoice };
