// Executed only in the selected top frame after an explicit owner gesture. Never reads form values.
// Only text the owner can actually see is returned. CSS-hidden, transparent, zero-size, clipped and
// unreachable text is skipped; when visibility cannot be measured, the text is treated as hidden.
export function extractPage() {
  const excluded =
    'input,textarea,select,option,button,script,style,noscript,template,iframe,svg,canvas,object,embed,[contenteditable],[hidden],[inert],[aria-hidden="true"],[role="textbox"],[role="combobox"],[role="searchbox"],[data-private],[data-sensitive]';
  const root = document.body;
  if (!root) return { title: '', text: '' };

  const encoder = new TextEncoder();
  const maxTextBytes = 49280;
  const maxTitleBytes = 600;
  const sliceUtf8 = (str, limit) => {
    if (encoder.encode(str).byteLength <= limit) return str;
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
        if (pairEnd > lo && encoder.encode(str.slice(0, pairEnd)).byteLength <= limit) lo = pairEnd;
        break;
      }
      if (encoder.encode(str.slice(0, end)).byteLength <= limit) lo = end;
      else hi = end - 1;
    }
    if (lo > 0) {
      const last = str.charCodeAt(lo - 1);
      if (last >= 0xd800 && last <= 0xdbff) lo--;
    }
    return str.slice(0, lo);
  };

  if (typeof document.designMode === 'string' && document.designMode.toLowerCase() === 'on') {
    return { title: sliceUtf8(String(document.title || ''), maxTitleBytes), text: '' };
  }

  const MIN_OPACITY = 0.05;
  const MIN_GLYPH_PX = 0.5;
  const MIN_VISIBLE_PX = 1;
  const MIN_CLIPPED_PX = 2;
  const OFFSCREEN_MARGIN_PX = 2000;

  const view = typeof window !== 'undefined' && window ? window : {};
  const documentElement = document.documentElement || root;
  const toNumber = value => {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  };
  const parsePx = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value) return null;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  };
  const scrollX = toNumber(view.scrollX ?? view.pageXOffset);
  const scrollY = toNumber(view.scrollY ?? view.pageYOffset);
  const viewportWidth = toNumber(view.innerWidth);
  const viewportHeight = toNumber(view.innerHeight);
  const documentWidth = Math.max(
    viewportWidth,
    toNumber(documentElement.scrollWidth),
    root !== documentElement ? toNumber(root.scrollWidth) : 0
  );

  const styleCache = new Map();
  const styleOf = element => {
    if (!element) return null;
    if (styleCache.has(element)) return styleCache.get(element);
    let style = null;
    try {
      style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    } catch {
      style = null;
    }
    styleCache.set(element, style);
    return style;
  };

  const rectOf = element => {
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    try {
      const box = element.getBoundingClientRect();
      if (!box) return null;
      const left = toNumber(box.left);
      const top = toNumber(box.top);
      const width = Math.max(0, toNumber(box.width) || toNumber(box.right) - left);
      const height = Math.max(0, toNumber(box.height) || toNumber(box.bottom) - top);
      return { left, top, width, height, right: left + width, bottom: top + height };
    } catch {
      return null;
    }
  };

  const alphaOf = value => {
    if (typeof value !== 'string' || !value) return 1;
    const text = value.trim().toLowerCase();
    if (text === 'transparent') return 0;
    if (text === 'currentcolor' || text === 'inherit' || text === 'initial' || text === 'unset') return 1;
    if (text[0] === '#') {
      if (text.length === 5) return Number.parseInt(text[4] + text[4], 16) / 255;
      if (text.length === 9) return Number.parseInt(text.slice(7, 9), 16) / 255;
      return 1;
    }
    const match = /^([a-z-]+)\(([^)]*)\)$/.exec(text);
    if (!match) return 1;
    const body = match[2].trim();
    let alphaText = null;
    if (body.includes('/')) alphaText = body.split('/').pop();
    else if (match[1] === 'rgb' || match[1] === 'rgba') {
      const parts = body.split(',').map(part => part.trim());
      if (parts.length === 4) alphaText = parts[3];
    }
    if (alphaText === null) return 1;
    const token = alphaText.trim();
    const alpha = token.endsWith('%') ? Number.parseFloat(token) / 100 : Number.parseFloat(token);
    return Number.isFinite(alpha) ? alpha : 1;
  };

  const filterAlpha = style => {
    if (!style || typeof style.filter !== 'string' || !style.filter || style.filter === 'none') return 1;
    let alpha = 1;
    const pattern = /opacity\(\s*([0-9.]+)(%?)\s*\)/gi;
    let match;
    while ((match = pattern.exec(style.filter))) {
      const value = Number.parseFloat(match[1]) / (match[2] === '%' ? 100 : 1);
      if (Number.isFinite(value)) alpha *= Math.max(0, Math.min(1, value));
    }
    return alpha;
  };

  const shadowPaints = value => {
    if (typeof value !== 'string' || !value || value === 'none') return false;
    const colors = value.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi);
    if (!colors) return false;
    return colors.some(color => alphaOf(color) > MIN_OPACITY);
  };

  const textRenderable = element => {
    const style = styleOf(element);
    if (!style) return false;
    const security = typeof style.webkitTextSecurity === 'string' ? style.webkitTextSecurity.trim().toLowerCase() : '';
    if (security && security !== 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const fillText = typeof style.webkitTextFillColor === 'string' ? style.webkitTextFillColor.trim() : 'currentcolor';
    // Glyphs are painted with the text fill colour, not the `color` property; both resolve
    // `currentcolor` to the same value (verified in Chrome 156).
    const paintAlpha =
      !fillText || fillText.toLowerCase() === 'currentcolor' ? alphaOf(style.color) : alphaOf(fillText);
    if (paintAlpha <= MIN_OPACITY) {
      const backgroundClip = `${style.backgroundClip || ''} ${style.webkitBackgroundClip || ''}`.toLowerCase();
      const hasBackground = typeof style.backgroundImage === 'string' && style.backgroundImage !== 'none';
      const strokeWidth = parsePx(style.webkitTextStrokeWidth);
      const strokeVisible =
        strokeWidth !== null && strokeWidth > 0 && alphaOf(style.webkitTextStrokeColor) > MIN_OPACITY;
      if (!(backgroundClip.includes('text') && hasBackground) && !strokeVisible && !shadowPaints(style.textShadow)) {
        return false;
      }
    }
    const fontSize = parsePx(style.fontSize);
    if (fontSize !== null && fontSize <= MIN_GLYPH_PX) return false;
    return true;
  };

  const clipPathRect = (element, style) => {
    const raw = style && typeof style.clipPath === 'string' ? style.clipPath.trim() : 'none';
    if (!raw || raw === 'none') return null;
    const match = /^inset\(\s*(.*)\)$/i.exec(raw);
    if (!match) return false;
    const body = match[1].split(/\bround\b/i)[0].trim();
    if (!body) return false;
    const parts = body.split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    const box = rectOf(element);
    if (!box) return false;
    const resolve = (token, axis) => {
      if (token === 'auto') return 0;
      if (token.endsWith('%')) {
        const percent = Number.parseFloat(token);
        if (!Number.isFinite(percent)) return null;
        return ((axis === 'x' ? box.width : box.height) * percent) / 100;
      }
      return parsePx(token);
    };
    const topToken = parts[0];
    const rightToken = parts.length > 1 ? parts[1] : topToken;
    const bottomToken = parts.length > 2 ? parts[2] : topToken;
    const leftToken = parts.length > 3 ? parts[3] : rightToken;
    const top = resolve(topToken, 'y');
    const right = resolve(rightToken, 'x');
    const bottom = resolve(bottomToken, 'y');
    const left = resolve(leftToken, 'x');
    if (top === null || right === null || bottom === null || left === null) return false;
    const clip = {
      left: box.left + left,
      top: box.top + top,
      right: box.right - right,
      bottom: box.bottom - bottom,
      clipX: true,
      clipY: true,
    };
    if (clip.right - clip.left < MIN_VISIBLE_PX || clip.bottom - clip.top < MIN_VISIBLE_PX) return false;
    return clip;
  };

  const legacyClipRect = (element, style) => {
    const raw = style && typeof style.clip === 'string' ? style.clip.trim() : 'auto';
    if (!raw || raw === 'auto') return null;
    const match = /^rect\((.*)\)$/i.exec(raw);
    if (!match) return false;
    const parts = match[1].split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 4) return false;
    const box = rectOf(element);
    if (!box) return false;
    const values = parts.map(parsePx);
    if (values.some(value => value === null)) return false;
    const [top, right, bottom, left] = values;
    const clip = {
      left: box.left + left,
      top: box.top + top,
      right: box.left + right,
      bottom: box.top + bottom,
      clipX: true,
      clipY: true,
    };
    if (clip.right - clip.left < MIN_VISIBLE_PX || clip.bottom - clip.top < MIN_VISIBLE_PX) return false;
    return clip;
  };

  const overflowClipOf = (element, style) => {
    if (!style) return null;
    const read = (own, fallback) => {
      const value = typeof own === 'string' ? own : fallback;
      return typeof value === 'string' ? value.trim().toLowerCase() : 'visible';
    };
    const x = read(style.overflowX, style.overflow);
    const y = read(style.overflowY, style.overflow);
    const clipX = x !== 'visible';
    const clipY = y !== 'visible';
    if (!clipX && !clipY) return null;
    const box = rectOf(element);
    if (!box) return false;
    if ((clipX && box.width < MIN_VISIBLE_PX) || (clipY && box.height < MIN_VISIBLE_PX)) return false;
    // auto/scroll/overlay content can be brought into view; hidden/clip content cannot.
    const scrollable = value => value === 'auto' || value === 'scroll' || value === 'overlay';
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      clipX: clipX && !scrollable(x),
      clipY: clipY && !scrollable(y),
    };
  };

  const blankState = { hidden: false, opacity: 1, fixed: false, clips: [] };
  const stateCache = new Map();
  const stateOf = element => {
    if (!element) return blankState;
    if (stateCache.has(element)) return stateCache.get(element);
    const parent = stateOf(element.parentElement);
    let state;
    if (parent.hidden) {
      state = parent;
    } else {
      const style = styleOf(element);
      if (!style) {
        state = { hidden: true, opacity: parent.opacity, fixed: parent.fixed, clips: parent.clips };
      } else {
        const display = style.display;
        const noBox = display === 'contents';
        let hidden = display === 'none' || style.contentVisibility === 'hidden';
        let opacity = parent.opacity;
        if (!hidden && !noBox) {
          const ownOpacity = parsePx(style.opacity);
          const alpha = ownOpacity === null ? 1 : Math.max(0, Math.min(1, ownOpacity));
          opacity *= alpha * filterAlpha(style);
          if (opacity <= MIN_OPACITY) hidden = true;
        }
        if (!hidden && !noBox && typeof element.checkVisibility === 'function') {
          try {
            if (
              !element.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                opacityProperty: true,
                visibilityProperty: true,
              })
            ) {
              hidden = true;
            }
          } catch {
            // Older engines: the explicit checks above already cover the same properties.
          }
        }
        const ownClips = [];
        if (!hidden && !noBox) {
          const clipPath = clipPathRect(element, style);
          if (clipPath === false) hidden = true;
          else if (clipPath) ownClips.push(clipPath);
        }
        if (!hidden && !noBox) {
          const legacy = legacyClipRect(element, style);
          if (legacy === false) hidden = true;
          else if (legacy) ownClips.push(legacy);
        }
        if (!hidden && !noBox) {
          const overflow = overflowClipOf(element, style);
          if (overflow === false) hidden = true;
          else if (overflow) ownClips.push(overflow);
        }
        if (!hidden && typeof element.hasAttribute === 'function') {
          try {
            if (element.hasAttribute('inert')) hidden = true;
          } catch {
            // ignore
          }
        }
        const fixed = parent.fixed || style.position === 'fixed';
        // Fixed boxes escape ancestor overflow clipping; they still keep their own clips.
        const clips = fixed ? ownClips : ownClips.length ? parent.clips.concat(ownClips) : parent.clips;
        state = { hidden, opacity, fixed, clips };
      }
    }
    stateCache.set(element, state);
    return state;
  };

  const detailsCache = new Map();
  const insideClosedDetails = element => {
    if (!element) return false;
    if (detailsCache.has(element)) return detailsCache.get(element);
    let hidden = false;
    let current = element;
    while (current) {
      if (current.tagName === 'DETAILS' && current.open === false) {
        let summary = null;
        let member = element;
        while (member && member !== current) {
          if (member.tagName === 'SUMMARY') {
            summary = member;
            break;
          }
          member = member.parentElement;
        }
        if (!summary) {
          hidden = true;
          break;
        }
      }
      current = current.parentElement;
    }
    detailsCache.set(element, hidden);
    return hidden;
  };

  const geometryAvailable = typeof document.createRange === 'function';
  const textRects = node => {
    if (!geometryAvailable) return null;
    let range = null;
    try {
      range = document.createRange();
      range.selectNodeContents(node);
    } catch {
      return null;
    }
    let list = null;
    try {
      list = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
    } catch {
      list = null;
    }
    if (list && list.length) {
      const rects = [];
      for (let index = 0; index < list.length; index += 1) rects.push(list[index]);
      return rects;
    }
    if (typeof range.getBoundingClientRect === 'function') {
      try {
        const box = range.getBoundingClientRect();
        if (box && (box.width || box.height || box.right || box.bottom)) return [box];
      } catch {
        // ignore
      }
    }
    return list ? [] : null;
  };

  const rectVisible = (rect, state) => {
    if (!rect) return false;
    const left = toNumber(rect.left);
    const top = toNumber(rect.top);
    const right = rect.right === undefined ? left + toNumber(rect.width) : toNumber(rect.right);
    const bottom = rect.bottom === undefined ? top + toNumber(rect.height) : toNumber(rect.bottom);
    if (right - left < MIN_VISIBLE_PX || bottom - top < MIN_VISIBLE_PX) return false;
    if (state.fixed) {
      if (right < -OFFSCREEN_MARGIN_PX || bottom < -OFFSCREEN_MARGIN_PX) return false;
      if (left > viewportWidth + OFFSCREEN_MARGIN_PX || top > viewportHeight + OFFSCREEN_MARGIN_PX) return false;
    } else {
      const documentLeft = left + scrollX;
      if (right + scrollX < -OFFSCREEN_MARGIN_PX || bottom + scrollY < -OFFSCREEN_MARGIN_PX) return false;
      if (documentLeft > documentWidth + OFFSCREEN_MARGIN_PX) return false;
    }
    for (let index = 0; index < state.clips.length; index += 1) {
      const clip = state.clips[index];
      if (clip.clipX) {
        const overlapWidth = Math.min(right, clip.right) - Math.max(left, clip.left);
        if (overlapWidth < MIN_CLIPPED_PX) return false;
      }
      if (clip.clipY) {
        const overlapHeight = Math.min(bottom, clip.bottom) - Math.max(top, clip.top);
        if (overlapHeight < MIN_CLIPPED_PX) return false;
      }
    }
    return true;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const parts = [];
  let bytes = 0;
  let node;
  while ((node = walker.nextNode()) && bytes < maxTextBytes) {
    const element = node.parentElement;
    if (!element || element.closest(excluded)) continue;
    const value = node.nodeValue.replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (!textRenderable(element) || insideClosedDetails(element)) continue;
    const state = stateOf(element);
    if (state.hidden) continue;
    const rects = textRects(node);
    if (rects !== null) {
      let shown = false;
      for (let index = 0; index < rects.length; index += 1) {
        if (rectVisible(rects[index], state)) {
          shown = true;
          break;
        }
      }
      if (!shown) continue;
    }
    const separatorBytes = parts.length > 0 ? 1 : 0;
    const remaining = maxTextBytes - bytes - separatorBytes;
    if (remaining <= 0) break;
    const chunk = sliceUtf8(value, remaining);
    if (!chunk) break;
    parts.push(chunk);
    bytes += separatorBytes + encoder.encode(chunk).byteLength;
  }
  return {
    title: sliceUtf8(String(document.title || ''), maxTitleBytes),
    text: sliceUtf8(parts.join('\n'), maxTextBytes),
  };
}

export function allowedOrigin(url) {
  if (typeof url !== 'string' || new TextEncoder().encode(url).byteLength > 512) return null;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

// Deliberately no execution path until Nox policy is agreed and enforced.
export function prepareAction() {
  return { ok: false, error: 'Действия на странице пока отключены.' };
}
