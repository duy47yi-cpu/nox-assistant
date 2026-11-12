// Injected into every captured page (reference and clone alike) before the page's own scripts.
// Plain browser JavaScript: it exposes window.__replica for capture.mjs and nothing else.
(() => {
  if (window.top !== window || window.__replica) return;

  // Seeded Math.random (mulberry32) so particles, shuffles and generated ids repeat across captures.
  let seed = 1337;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const px = (v) => round(parseFloat(v) || 0);

  const ids = new WeakMap();
  const els = [];
  const idOf = (el) => {
    if (!ids.has(el)) {
      ids.set(el, els.length);
      els.push(el);
    }
    return ids.get(el);
  };

  // Any CSS colour (rgb, hsl, oklch, color-mix…) → #rrggbb[aa] through a 1px canvas; null when invisible.
  let ctx;
  const hexes = new Map();
  function hex(c) {
    if (!c || c === 'transparent') return null;
    if (hexes.has(c)) return hexes.get(c);
    ctx ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const h = a === 0 ? null : '#' + [r, g, b, ...(a < 255 ? [a] : [])].map((v) => v.toString(16).padStart(2, '0')).join('');
    hexes.set(c, h);
    return h;
  }
  const hexAll = (s) => s.replace(/(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color)\([^)]*\)/g, (m) => hex(m) || '#0000');

  // What a visitor can see: text, media, controls and boxes that paint something. Flex/grid wrappers
  // are kept as 'layout' for the outline; every other element is transparent to Replica.
  const MEDIA = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed']);
  const FIELD = new Set(['input', 'textarea', 'select']);
  const SKIP = new Set(['script', 'style', 'template', 'noscript', 'head', 'link', 'meta', 'title', 'br', 'wbr', 'source', 'track']);
  const TEXTY = new Set(['heading', 'link', 'button', 'text', 'field']);
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];

  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
  const border = (cs) => SIDES.map((d) => (cs[`border${d}Style`] === 'none' || !hex(cs[`border${d}Color`]) ? 0 : px(cs[`border${d}Width`])));

  // The opaque colour behind an element: the nearest ancestor background, else the white canvas.
  // ponytail: ignores positioned overlap and translucent layers; dark-canvas pages read as white here.
  const behindMemo = new WeakMap();
  function behind(el) {
    const p = el && parentOf(el);
    if (!p || p.nodeType !== 1) return '#ffffff';
    if (!behindMemo.has(p)) {
      const h = hex(getComputedStyle(p).backgroundColor);
      behindMemo.set(p, h && h.length === 7 ? h : behind(p));
    }
    return behindMemo.get(p);
  }
  // A background the same colour as what is behind it paints nothing a visitor can see.
  const fill = (el, cs) => {
    const h = hex(cs.backgroundColor);
    return h && h !== behind(el) ? h : null;
  };
  const paints = (el, cs) => !!fill(el, cs) || cs.backgroundImage !== 'none' || cs.boxShadow !== 'none' || border(cs).some(Boolean);

  function kindOf(el, cs) {
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
    if (FIELD.has(tag)) return 'field';
    if (MEDIA.has(tag)) return 'media';
    if (ownText(el)) return 'text';
    if (paints(el, cs)) return 'box';
    if (/flex|grid/.test(cs.display)) return 'layout';
    return null;
  }

  function rootOf(sel) {
    const root = sel ? document.querySelector(sel) : document.documentElement;
    if (!root) throw new Error(`--selector matched nothing: ${sel}`);
    return root;
  }

  // Root box in document coordinates; the whole document when there is no selector.
  function boxOf(root) {
    if (root === document.documentElement) {
      return { x: 0, y: 0, w: root.clientWidth, h: Math.max(root.scrollHeight, document.body?.scrollHeight || 0, innerHeight) };
    }
    const r = root.getBoundingClientRect();
    return { x: round(r.left + scrollX), y: round(r.top + scrollY), w: round(r.width), h: round(r.height) };
  }

  function walk(root, visit) {
    const go = (el) => {
      if (SKIP.has(el.localName)) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || visit(el, cs) === false) return;
      for (const child of el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : el.children) go(child);
    };
    go(root);
  }

  const parentOf = (el) => el.parentElement || el.getRootNode().host;

  // Opacity as seen on screen: own opacity, times any filter: opacity(), times every ancestor's.
  function opacity(el, memo) {
    if (!el || el.nodeType !== 1) return 1;
    let v = memo.get(el);
    if (v === undefined) {
      const cs = getComputedStyle(el);
      let f = 1;
      for (const m of cs.filter.matchAll(/opacity\(([\d.]+)(%?)\)/g)) f *= m[2] ? m[1] / 100 : +m[1];
      v = parseFloat(cs.opacity) * f * opacity(parentOf(el), memo);
      memo.set(el, v);
    }
    return v;
  }

  // [x, y, w, h] relative to the root box; null when the element has no size (or, with clip, lies outside the root).
  // min: the smallest size that counts as there. Motion samples pass 0, so a bar growing from width 0
  // or a dot popping from scale(0) is measured from its first frame.
  function place(el, box, clip, d = 1, min = 1) {
    const r = el.getBoundingClientRect();
    if (r.width < min || r.height < min) return null;
    const x = r.left + scrollX - box.x;
    const y = r.top + scrollY - box.y;
    if (clip && (x + r.width <= 0 || y + r.height <= 0 || x >= box.w || y >= box.h)) return null;
    return [round(x, d), round(y, d), round(r.width, d), round(r.height, d)];
  }

  function ident(el, k) {
    const n = { tag: el.localName };
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    if (cls) n.cls = cls;
    if (k === 'media') {
      const src = el.currentSrc || el.src || el.poster || el.getAttribute('data') || '';
      if (src && typeof src === 'string') n.src = src.slice(0, 300);
      const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || el.querySelector?.('title')?.textContent;
      if (alt) n.alt = norm(alt).slice(0, 120);
    } else if (TEXTY.has(k)) {
      const t = norm(k === 'field' ? el.value || el.placeholder || el.getAttribute('aria-label') : el.innerText || el.textContent);
      if (t) n.text = t.slice(0, 160);
    }
    return n;
  }

  function layoutOf(cs) {
    const gap = cs.rowGap === cs.columnGap ? `${px(cs.rowGap)}` : `${px(cs.rowGap)}/${px(cs.columnGap)}`;
    const align = [
      !/normal|flex-start|start/.test(cs.justifyContent) && `jc ${cs.justifyContent}`,
      !/normal|stretch/.test(cs.alignItems) && `ai ${cs.alignItems}`,
    ].filter(Boolean);
    if (cs.display.includes('grid')) return [`grid cols[${cs.gridTemplateColumns}]`, `gap ${gap}`, ...align].join(' ');
    return [`flex ${cs.flexDirection}${cs.flexWrap === 'wrap' ? ' wrap' : ''}`, `gap ${gap}`, ...align].join(' ');
  }

  // Computed style, keeping only what differs from the browser default so the blueprint stays short.
  function styleOf(el, cs, k) {
    const s = {};
    if (TEXTY.has(k)) {
      s.ff = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      s.fs = px(cs.fontSize);
      s.fw = +cs.fontWeight;
      s.lh = cs.lineHeight === 'normal' ? 'normal' : px(cs.lineHeight);
      s.ls = cs.letterSpacing === 'normal' ? 0 : px(cs.letterSpacing);
      s.c = hex(cs.color);
      if (cs.textTransform !== 'none') s.tt = cs.textTransform;
      if (cs.fontStyle !== 'normal') s.fst = cs.fontStyle;
      if (cs.textDecorationLine !== 'none') s.td = cs.textDecorationLine;
      if (!/start|left/.test(cs.textAlign)) s.ta = cs.textAlign;
    }
    const bg = fill(el, cs);
    if (bg) s.bg = bg;
    if (cs.backgroundImage !== 'none') s.bgi = hexAll(cs.backgroundImage).slice(0, 400);
    if (cs.borderRadius !== '0px') s.r = cs.borderRadius;
    const bw = border(cs);
    if (bw.some(Boolean)) {
      s.bw = new Set(bw).size === 1 ? `${bw[0]}` : bw.join(' ');
      s.bc = hex(cs[`border${SIDES[bw.findIndex(Boolean)]}Color`]);
    }
    if (cs.boxShadow !== 'none') s.sh = hexAll(cs.boxShadow);
    if (+cs.opacity < 1) s.o = round(+cs.opacity, 2);
    if (cs.filter !== 'none') s.fl = cs.filter;
    if (cs.backdropFilter !== 'none') s.bf = cs.backdropFilter;
    if (/fixed|sticky|absolute/.test(cs.position)) s.pos = cs.position;
    if (/flex|grid/.test(cs.display)) s.lay = layoutOf(cs);
    const pad = SIDES.map((d) => px(cs[`padding${d}`]));
    if (pad.some(Boolean)) s.pad = pad.join(' ');
    return s;
  }

  // Index path from the root, stable across viewports when the DOM is the same.
  function pathOf(el, root) {
    const out = [];
    for (let e = el; e && e !== root; e = parentOf(e)) {
      const p = parentOf(e);
      out.push(p ? [...(p.shadowRoot && e.parentNode === p.shadowRoot ? p.shadowRoot.children : p.children)].indexOf(e) : 0);
    }
    return out.reverse().join('.');
  }

  // ── virtual time ────────────────────────────────────────────────────────────────────────────
  // Playwright's clock drives timers, rAF and performance.now. CSS and Web Animations run on the
  // document timeline, which capture.mjs freezes over CDP; seek() moves each one to the virtual clock.
  const seen = new WeakMap();
  const declared = [];
  let t0 = 0;

  function describe(a, now) {
    const e = a.effect;
    const el = e?.target;
    const t = e?.getTiming?.() || {};
    const keyframes = (e?.getKeyframes?.() || []).map(({ composite, computedOffset, offset, easing, ...props }) => ({
      at: round(computedOffset, 3),
      ...(easing && easing !== 'linear' && { easing }),
      ...props,
    }));
    return {
      at: now,
      ...(el && { el: idOf(el), ...ident(el, kindOf(el, getComputedStyle(el)) || 'box') }),
      ...(e?.pseudoElement && { pseudo: e.pseudoElement }),
      type: a.constructor.name,
      name: a.animationName || a.transitionProperty || a.id || '',
      duration: t.duration,
      delay: t.delay,
      easing: t.easing,
      iterations: t.iterations,
      direction: t.direction,
      fill: t.fill,
      keyframes: JSON.stringify(keyframes).length < 2500 ? keyframes : '(large)',
    };
  }

  function seek() {
    const now = performance.now();
    for (const a of document.getAnimations()) {
      if (a.timeline !== document.timeline || a.playState === 'paused' || a.playState === 'idle') continue;
      if (!seen.has(a)) {
        seen.set(a, { at: now, from: Number(a.currentTime) || 0 });
        if (declared.length < 1000) declared.push(Object.assign(describe(a, now), { target: a.effect?.target }));
      }
      const s = seen.get(a);
      a.currentTime = s.from + (now - s.at) * a.playbackRate;
    }
    // ponytail: videos are held on their first frame; seeking them per frame needs async decode waits.
    for (const v of document.querySelectorAll('video')) if (!v.paused) v.pause();
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────
  let rootSel = null;
  let origin = { x: 0, y: 0, w: 0, h: 0 };

  function mark(sel) {
    rootSel = sel;
    origin = boxOf(rootOf(sel));
    t0 = performance.now();
    return { box: origin, scroll: [scrollX, scrollY], viewport: [innerWidth, innerHeight] };
  }

  // One motion frame: [id, x, y, w, h, opacity, rotation°, color, background] per visible thing.
  function sample() {
    const rows = [];
    const memo = new Map();
    const root = rootOf(rootSel);
    // With a selector, what's inside is measured against the root where it is now, and the root's own
    // movement is one row: a header changing height above the component shifts it once, not every child.
    let at = origin;
    if (rootSel) {
      at = boxOf(root);
      const cs = getComputedStyle(root);
      rows.push([idOf(root), round(at.x - origin.x, 3), round(at.y - origin.y, 3), at.w, at.h, round(opacity(root, memo), 4), 0, hex(cs.color), fill(root, cs)]);
    }
    walk(root, (el, cs) => {
      if (rootSel && el === root) return;
      const k = kindOf(el, cs);
      if (!k || k === 'layout') return;
      let b = place(el, at, false, 3, 0);
      if (!b) return k !== 'media';
      const m = cs.transform === 'none' ? null : new DOMMatrixReadOnly(cs.transform);
      const rot = m ? Math.atan2(m.b, m.a) : 0;
      // A turning element's bounding box swells and shrinks; report the box it turns, around the same centre.
      if (rot && el.offsetWidth) {
        const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot)), W = el.offsetWidth, H = el.offsetHeight;
        const f = b[2] / (W * c + H * s), cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2;
        b = [round(cx - (W * f) / 2, 3), round(cy - (H * f) / 2, 3), round(W * f, 3), round(H * f, 3)];
      }
      const o = cs.visibility === 'hidden' ? 0 : opacity(el, memo);
      rows.push([idOf(el), ...b, round(o, 4), round((rot * 180) / Math.PI), hex(cs.color), fill(el, cs)]);
      return k !== 'media';
    });
    return { t: round(performance.now() - t0), rows };
  }

  function describeIds(list) {
    return list.map((id) => {
      const el = els[id];
      const k = (el && kindOf(el, getComputedStyle(el))) || 'box';
      return { id, k: k === 'layout' ? 'box' : k, ...(el ? ident(el, k) : { tag: '?' }) };
    });
  }

  function cssVars() {
    const names = new Set();
    const scan = (rules) => {
      for (const r of rules) {
        if (r.cssRules) scan(r.cssRules);
        if (r.style && /(^|,)\s*(:root|html|:host)\s*(,|$)/.test(r.selectorText || '')) {
          for (const p of r.style) if (p.startsWith('--')) names.add(p);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        scan(sheet.cssRules);
      } catch {} // cross-origin sheet
    }
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries([...names].slice(0, 400).map((n) => [n, hexAll(cs.getPropertyValue(n).trim()).slice(0, 200)]));
  }

  function fonts() {
    const faces = [];
    const scan = (rules, base) => {
      for (const r of rules) {
        if (r.cssRules) scan(r.cssRules, base);
        if (r instanceof CSSFontFaceRule) {
          const src = (r.style.getPropertyValue('src').match(/url\(["']?([^"')]+)/) || [])[1];
          faces.push({
            family: r.style.getPropertyValue('font-family').replace(/["']/g, '').trim(),
            weight: r.style.getPropertyValue('font-weight') || '400',
            style: r.style.getPropertyValue('font-style') || 'normal',
            ...(src && { src: new URL(src, base).href }),
          });
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        scan(sheet.cssRules, sheet.href || location.href);
      } catch {}
    }
    const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/["']/g, '')} ${f.weight} ${f.style}`);
    const links = [...document.querySelectorAll('link[rel~=stylesheet]')].map((l) => l.href).filter((h) => /font|typekit/i.test(h));
    return { faces: faces.slice(0, 80), loaded: [...new Set(loaded)], links };
  }

  // The settled page: every visible thing with its box, identity and computed style.
  function blueprint(sel) {
    const root = rootOf(sel);
    const box = boxOf(root);
    const memo = new Map();
    const index = new Map();
    const nodes = [];
    walk(root, (el, cs) => {
      if (nodes.length >= 3000) return false; // ponytail: hard cap; scope big pages with --selector
      const k = kindOf(el, cs);
      if (!k) return;
      const o = cs.visibility === 'hidden' ? 0 : opacity(el, memo);
      if (o < 0.02) return cs.visibility === 'hidden' ? undefined : false;
      const b = place(el, box, true);
      if (!b) return k !== 'media';
      let up = parentOf(el);
      while (up && !index.has(up)) up = parentOf(up);
      const n = { id: idOf(el), p: up ? index.get(up) : null, k, ...ident(el, k), path: pathOf(el, root), box: b, s: styleOf(el, cs, k) };
      if (o < 0.98) n.s.eo = round(o, 2);
      if (n.tag === 'svg' && el.outerHTML.length <= 4000) n.svg = el.outerHTML;
      if (el.dataset?.replica === 'placeholder') n.ph = 1;
      index.set(el, n.id);
      nodes.push(n);
      return k !== 'media';
    });
    return {
      url: location.href,
      title: document.title,
      viewport: [innerWidth, innerHeight],
      root: { selector: sel || null, box },
      nodes,
      vars: cssVars(),
      fonts: fonts(),
    };
  }

  // Only what runs inside the captured root, one-shot animations before endless loops: on a busy page
  // the hero's own entrance would otherwise drown among hundreds of decorative loops further down.
  const declaredList = () => {
    const root = rootOf(rootSel);
    return declared
      .filter((d) => !d.target || root.contains(d.target))
      .sort((a, b) => (a.iterations === Infinity) - (b.iterations === Infinity))
      .slice(0, 300)
      .map(({ at, target, ...d }) => ({ start: round(at - t0), ...d }));
  };

  function center(sel) {
    const el = rootOf(sel);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  window.__replica = { seek, mark, sample, blueprint, describeIds, declared: declaredList, center };
})();
