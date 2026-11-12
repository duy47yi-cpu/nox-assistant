/* Формулы в ответах: небольшое подмножество LaTeX без внешних библиотек.
 * parse(tex) — дерево узлов (без DOM, проверяется тестом); render(tex, block) — узел для ленты.
 * Узлы: {t:'text',v} | {t:'frac',num,den} | {t:'sqrt',body} | {t:'sup'|'sub'|'bar'|'rm',body}.
 * shortcut: матрицы, пределы, интегралы с границами и \begin{} не разбираются (показываются как текст);
 * когда понадобятся — ставить KaTeX по согласию владельца. */
(function (root) {
  'use strict';

  const SYMBOLS = {
    approx: '≈', times: '×', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', infty: '∞', odot: '⊙', sim: '∼', propto: '∝',
    ll: '≪', gg: '≫', equiv: '≡', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', degree: '°', circ: '∘',
    ldots: '…', dots: '…', cdots: '⋯', div: '÷', in: '∈', forall: '∀', exists: '∃', hbar: 'ℏ', ell: 'ℓ', angle: '∠',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
    iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
    upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    quad: ' ', qquad: '  ',
  };
  const WRAP = { text: 'rm', mathrm: 'rm', mathbf: 'rm', operatorname: 'rm', bar: 'bar', overline: 'bar' };
  const FUNCS = new Set(['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'lim', 'min', 'max']);

  function parse(tex) {
    const s = String(tex == null ? '' : tex);
    let i = 0;

    const push = (out, v) => {
      const last = out[out.length - 1];
      if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v });
    };
    // Один аргумент: {группа}, \команда или один символ.
    const arg = () => {
      while (s[i] === ' ') i++;
      if (s[i] === '{') { i++; return seq('}'); }
      const out = [];
      if (s[i] === '\\') command(out); else if (i < s.length) push(out, s[i++]);
      return out;
    };
    const command = (out) => {
      i++; // обратная черта
      const m = /^[A-Za-z]+/.exec(s.slice(i));
      if (!m) { // \, \; \! \{ \% и т. п.
        const ch = s[i++] || '';
        if (ch === ',' || ch === ';' || ch === ':' || ch === ' ') push(out, ' ');
        else if (ch !== '!') push(out, ch);
        return;
      }
      const name = m[0];
      i += name.length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') { const num = arg(); out.push({ t: 'frac', num, den: arg() }); return; }
      if (name === 'sqrt') { out.push({ t: 'sqrt', body: arg() }); return; }
      if (WRAP[name]) { out.push({ t: WRAP[name], body: arg() }); return; }
      if (name === 'left' || name === 'right') { if (s[i] === '.') i++; return; }
      if (FUNCS.has(name)) { out.push({ t: 'rm', body: [{ t: 'text', v: name }] }); return; }
      if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) { push(out, SYMBOLS[name]); return; }
      push(out, '\\' + name); // неизвестная команда остаётся как есть
    };
    function seq(close) {
      const out = [];
      while (i < s.length) {
        const ch = s[i];
        if (close && ch === close) { i++; break; }
        if (ch === '\\') command(out);
        else if (ch === '{') { i++; out.push(...seq('}')); }
        else if (ch === '^' || ch === '_') { i++; out.push({ t: ch === '^' ? 'sup' : 'sub', body: arg() }); }
        else if (ch === '~') { i++; push(out, ' '); }
        else { i++; push(out, ch); }
      }
      return out;
    }
    return seq('');
  }

  function build(nodes, doc) {
    const frag = doc.createDocumentFragment();
    const span = (cls, kids) => { const n = doc.createElement('span'); n.className = cls; if (kids) n.append(build(kids, doc)); return n; };
    for (const n of nodes) {
      if (n.t === 'text') {
        // Латинские буквы — курсивом (переменные), всё остальное прямым.
        for (const part of n.v.split(/([A-Za-z]+)/)) {
          if (!part) continue;
          if (/^[A-Za-z]+$/.test(part)) { const v = doc.createElement('i'); v.textContent = part; frag.append(v); }
          else frag.append(doc.createTextNode(part));
        }
      } else if (n.t === 'frac') {
        const f = span('m-frac');
        f.append(span('m-num', n.num), span('m-den', n.den));
        frag.append(f);
      } else if (n.t === 'sqrt') {
        const r = span('m-sqrt');
        r.append(doc.createTextNode('√'), span('m-rad', n.body));
        frag.append(r);
      } else if (n.t === 'sup' || n.t === 'sub') {
        const e = doc.createElement(n.t);
        e.append(build(n.body, doc));
        frag.append(e);
      } else if (n.t === 'bar') frag.append(span('m-bar', n.body));
      else if (n.t === 'rm') { const r = span('m-rm'); r.textContent = textOf(n.body); frag.append(r); }
    }
    return frag;
  }

  function textOf(nodes) {
    return nodes.map((n) => (n.t === 'text' ? n.v : n.t === 'frac' ? `${textOf(n.num)}/${textOf(n.den)}` : textOf(n.body || []))).join('');
  }

  function render(tex, block) {
    const node = document.createElement('span');
    node.className = block ? 'math math-block' : 'math';
    node.setAttribute('role', 'math');
    node.setAttribute('aria-label', String(tex).trim());
    try { node.append(build(parse(tex), document)); } catch { node.textContent = String(tex); }
    return node;
  }

  const api = { parse, render, textOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NoxMath = api;
})(typeof window !== 'undefined' ? window : globalThis);
