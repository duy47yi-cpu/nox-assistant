/* Безопасный рендер Markdown + LaTeX + Копирование кода для Nox Aether.
 * Никакого innerHTML от модели или пользователя: только текстовые узлы и DOM API. */
(function (root) {
  'use strict';

  function sanitizeText(raw) {
    const U = root.JarvisUI;
    return U && typeof U.humanize === 'function' ? U.humanize(raw == null ? '' : String(raw)) : String(raw == null ? '' : raw);
  }

  function scrubText(raw) {
    const U = root.JarvisUI;
    return U && typeof U.scrub === 'function' ? U.scrub(raw == null ? '' : String(raw)) : sanitizeText(raw);
  }

  function appendTextLines(parent, text) {
    const parts = String(text).split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) parent.append(document.createElement('br'));
      if (parts[i]) parent.append(document.createTextNode(parts[i]));
    }
  }

  function appendBoldAndLinks(parent, text, onOpenUrl) {
    const re = /(\*\*(?=\S)([\s\S]*?\S)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))/g;
    let at = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > at) appendTextLines(parent, text.slice(at, m.index));
      if (m[2] !== undefined) {
        const strong = document.createElement('strong');
        appendTextLines(strong, m[2]);
        parent.append(strong);
      } else if (m[3] && m[4]) {
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'ae-md-link';
        a.textContent = m[3];
        a.title = m[4];
        a.addEventListener('click', (e) => {
          e.preventDefault();
          if (typeof onOpenUrl === 'function') onOpenUrl(m[4]);
        });
        parent.append(a);
      }
      at = m.index + m[0].length;
    }
    if (at < text.length) appendTextLines(parent, text.slice(at));
  }

  const MATH_RE = /(\$\$[^$]+\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?=\S)[^$\n]*[\\^_=][^$\n]*\$)/;

  function appendMath(parent, text, onOpenUrl) {
    if (!root.NoxMath || !/[$\\]/.test(text)) {
      appendBoldAndLinks(parent, text, onOpenUrl);
      return;
    }
    String(text).split(MATH_RE).forEach((part, idx) => {
      if (!part) return;
      if (idx % 2 === 0) {
        appendBoldAndLinks(parent, part, onOpenUrl);
        return;
      }
      const block = part.startsWith('$$') || part.startsWith('\\[');
      const cut = part.startsWith('$$') || part.startsWith('\\') ? 2 : 1;
      parent.append(root.NoxMath.render(part.slice(cut, -cut), block));
    });
  }

  function appendInline(parent, text, onOpenUrl) {
    for (const part of String(text).split(/(`[^`\n]+`)/)) {
      if (!part) continue;
      if (part.length > 2 && part[0] === '`' && part[part.length - 1] === '`') {
        const code = document.createElement('code');
        code.textContent = part.slice(1, -1);
        parent.append(code);
      } else {
        appendMath(parent, part, onOpenUrl);
      }
    }
  }

  function isTableRow(line) {
    return /^\s*\|.+\|\s*$/.test(line);
  }

  function isTableDivider(line) {
    return /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line);
  }

  function splitTableRow(line) {
    return line.trim().slice(1, -1).split('|').map((cell) => cell.trim());
  }

  function copyPlain(text) {
    const val = String(text || '');
    if (!val) return Promise.resolve(false);
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(val).then(() => true).catch(() => legacyCopy(val));
    }
    return Promise.resolve(legacyCopy(val));
  }

  function legacyCopy(val) {
    const area = document.createElement('textarea');
    area.value = val;
    area.setAttribute('readonly', '');
    area.className = 'sr-only';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }

  function renderMarkdown(rawText, options = {}) {
    const onOpenUrl = options.onOpenUrl || null;
    const text = scrubText(rawText).replace(/\r\n?/g, '\n');
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    let para = [];
    let list = null;
    let lastLi = null;

    const flushPara = () => {
      if (!para.length) return;
      const p = document.createElement('p');
      appendInline(p, para.join('\n'), onOpenUrl);
      frag.append(p);
      para = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        flushPara();
        list = null;
        const lang = line.replace(/^\s*```/, '').trim().slice(0, 24);
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ae-codeblock';
        const bar = document.createElement('div');
        bar.className = 'ae-codebar';
        const tag = document.createElement('span');
        tag.className = 'ae-codelang';
        tag.textContent = lang || 'код';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ae-codecopy';
        copyBtn.textContent = 'Копировать';
        const codeText = buf.join('\n');
        copyBtn.addEventListener('click', async () => {
          const ok = await copyPlain(codeText);
          if (ok) {
            copyBtn.textContent = 'Скопировано';
            setTimeout(() => { if (copyBtn.isConnected) copyBtn.textContent = 'Копировать'; }, 1600);
          }
        });
        bar.append(tag, copyBtn);
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = codeText;
        pre.append(code);
        wrap.append(bar, pre);
        frag.append(wrap);
        continue;
      }

      if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        flushPara();
        list = null;
        const headers = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        i -= 1;
        const tableWrap = document.createElement('div');
        tableWrap.className = 'ae-table-wrap';
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        for (const h of headers) {
          const th = document.createElement('th');
          appendInline(th, h, onOpenUrl);
          htr.append(th);
        }
        thead.append(htr);
        const tbody = document.createElement('tbody');
        for (const r of rows) {
          const tr = document.createElement('tr');
          for (let c = 0; c < headers.length; c += 1) {
            const td = document.createElement('td');
            appendInline(td, r[c] || '', onOpenUrl);
            tr.append(td);
          }
          tbody.append(tr);
        }
        table.append(thead, tbody);
        tableWrap.append(table);
        frag.append(tableWrap);
        continue;
      }

      if (!line.trim()) {
        flushPara();
        list = null;
        continue;
      }

      if (/^\s*\$\$\s*$/.test(line)) {
        const end = lines.findIndex((l, k) => k > i && /^\s*\$\$\s*$/.test(l));
        if (end > i) {
          flushPara();
          list = null;
          const p = document.createElement('p');
          appendInline(p, '$$' + lines.slice(i + 1, end).join(' ') + '$$', onOpenUrl);
          frag.append(p);
          i = end;
          continue;
        }
      }

      const starNote = !list && /^\s*\*\s+(.*)$/.exec(line);
      const nextIsStar = starNote && i + 1 < lines.length && /^\s*\*\s+/.test(lines[i + 1]);
      if (starNote && !nextIsStar) {
        flushPara();
        const p = document.createElement('p');
        p.className = 'md-footnote';
        p.append(document.createTextNode('* '));
        appendInline(p, starNote[1], onOpenUrl);
        frag.append(p);
        continue;
      }

      const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
      const ol = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const type = ul ? 'ul' : 'ol';
        if (!list || list.type !== type) {
          const L = document.createElement(type);
          if (ol && ol[1] !== '1') L.start = Number(ol[1]);
          frag.append(L);
          list = { type, el: L };
        }
        lastLi = document.createElement('li');
        appendInline(lastLi, ul ? ul[1] : ol[2], onOpenUrl);
        list.el.append(lastLi);
        continue;
      }

      if (list && lastLi && /^\s{2,}\S/.test(line)) {
        lastLi.append(document.createTextNode(' '));
        appendInline(lastLi, line.trim(), onOpenUrl);
        continue;
      }
      list = null;

      const bq = /^\s*>\s?(.*)$/.exec(line);
      if (bq) {
        flushPara();
        const quote = document.createElement('blockquote');
        appendInline(quote, bq[1], onOpenUrl);
        frag.append(quote);
        continue;
      }

      const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        flushPara();
        const tagName = h[1].length <= 2 ? 'h3' : 'h4';
        const heading = document.createElement(tagName);
        heading.className = 'ae-md-h';
        appendInline(heading, h[2], onOpenUrl);
        frag.append(heading);
        continue;
      }

      para.push(line);
    }

    flushPara();
    return frag;
  }

  const api = { renderMarkdown, copyPlain, sanitizeText, scrubText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NoxAetherMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
