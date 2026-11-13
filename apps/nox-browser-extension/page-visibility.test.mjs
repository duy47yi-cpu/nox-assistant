import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from './page.mjs';

// Minimal fake DOM: computed styles are per element, like getComputedStyle in a browser.
const baseStyle = (overrides = {}) => ({
  display: 'block',
  visibility: 'visible',
  contentVisibility: 'visible',
  opacity: '1',
  color: 'rgb(0, 0, 0)',
  webkitTextFillColor: 'rgb(0, 0, 0)',
  fontSize: '16px',
  clipPath: 'none',
  clip: 'auto',
  overflowX: 'visible',
  overflowY: 'visible',
  position: 'static',
  filter: 'none',
  webkitTextSecurity: 'none',
  backgroundClip: 'border-box',
  webkitBackgroundClip: 'border-box',
  backgroundImage: 'none',
  webkitTextStrokeWidth: '0px',
  webkitTextStrokeColor: 'rgba(0, 0, 0, 0)',
  textShadow: 'none',
  ...overrides,
});

class FakeElement {
  constructor({ tagName = 'DIV', style = {}, parent = null, attrs = {}, box = null, excluded = false, checkVisibility = undefined } = {}) {
    this.tagName = tagName;
    this.parentElement = parent;
    this.style = baseStyle(style);
    this.attrs = attrs;
    this.box = box;
    this.excluded = excluded;
    this.open = attrs.open;
    this.checkVisibility = checkVisibility;
  }

  closest() {
    let current = this;
    while (current) {
      if (current.excluded) return current;
      current = current.parentElement;
    }
    return null;
  }

  hasAttribute(name) {
    return Boolean(this.attrs[name]);
  }

  getBoundingClientRect() {
    const box = this.box || { left: 0, top: 0, width: 1200, height: 10000 };
    return { ...box };
  }
}

const DEFAULT_RECT = { left: 8, top: 20, width: 200, height: 18 };
const textNode = (parent, nodeValue, rects = [DEFAULT_RECT]) => ({ parentElement: parent, nodeValue, rects });

function makeScene(view = {}) {
  const documentElement = new FakeElement({ tagName: 'HTML', box: { left: 0, top: 0, width: 1200, height: 10000 } });
  documentElement.scrollWidth = view.scrollWidth ?? 1200;
  const body = new FakeElement({ tagName: 'BODY', parent: documentElement, box: { left: 0, top: 0, width: 1200, height: 10000 } });
  return { documentElement, body, view };
}

function runScene(scene, nodes, title = 'Page') {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    NodeFilter: globalThis.NodeFilter,
    getComputedStyle: globalThis.getComputedStyle,
  };
  let selected = null;
  globalThis.document = {
    title,
    designMode: scene.view.designMode || 'off',
    body: scene.body,
    documentElement: scene.documentElement,
    createTreeWalker: () => ({ nextNode: () => nodes.shift() ?? null }),
    createRange: () => ({
      selectNodeContents(node) {
        selected = node;
      },
      getClientRects() {
        return selected?.rects ?? [];
      },
      getBoundingClientRect() {
        const rect = selected?.rects?.[0];
        return rect ? { ...rect } : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      },
    }),
  };
  globalThis.window = { innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0, ...scene.view };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.getComputedStyle = element => element.style || baseStyle();
  try {
    return extractPage();
  } finally {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  }
}

function extractFrom(style, { rect = DEFAULT_RECT, box = null, attrs = {}, tagName = 'DIV', view = {} } = {}) {
  const scene = makeScene(view);
  const element = new FakeElement({ tagName, parent: scene.body, style, box, attrs });
  return { out: runScene(scene, [textNode(element, 'MARKER', [rect])]), scene, element };
}

test('P1-5 opacity:0 is not extracted', () => {
  const { out } = extractFrom({ opacity: '0' });
  assert.equal(out.text, '');
});

test('P1-5 opacity:0 on an ancestor is not extracted', () => {
  const scene = makeScene();
  const faded = new FakeElement({ parent: scene.body, style: { opacity: '0' } });
  const text = new FakeElement({ tagName: 'P', parent: faded });
  const out = runScene(scene, [textNode(text, 'MARKER')]);
  assert.equal(out.text, '');
});

test('P1-5 font-size:0 is not extracted', () => {
  const { out } = extractFrom({ fontSize: '0px' }, { rect: { left: 8, top: 20, width: 0, height: 0 } });
  assert.equal(out.text, '');
});

test('P1-5 font-size:0 is not extracted even if a rect is reported', () => {
  const { out } = extractFrom({ fontSize: '0px' });
  assert.equal(out.text, '');
});

test('P1-5 color:transparent is not extracted', () => {
  const { out } = extractFrom({ color: 'rgba(0, 0, 0, 0)', webkitTextFillColor: 'rgba(0, 0, 0, 0)' });
  assert.equal(out.text, '');
});

test('P1-5 -webkit-text-fill-color:transparent is not extracted', () => {
  const { out } = extractFrom({ color: 'rgb(0, 0, 0)', webkitTextFillColor: 'rgba(0, 0, 0, 0)' });
  assert.equal(out.text, '');
});

test('P1-5 position:absolute left:-9999px is not extracted', () => {
  const { out } = extractFrom({ position: 'absolute' }, { rect: { left: -9999, top: 20, width: 180, height: 18 } });
  assert.equal(out.text, '');
});

test('P1-5 text-indent:-9999px is not extracted', () => {
  const { out } = extractFrom({}, { rect: { left: -9991, top: 20, width: 180, height: 18 } });
  assert.equal(out.text, '');
});

test('P1-5 height:0 with overflow:hidden is not extracted', () => {
  const { out } = extractFrom({ overflowX: 'hidden', overflowY: 'hidden' }, { box: { left: 0, top: 0, width: 400, height: 0 } });
  assert.equal(out.text, '');
});

test('P1-5 height:0 overflow:hidden on an ancestor is not extracted', () => {
  const scene = makeScene();
  const hider = new FakeElement({
    parent: scene.body,
    style: { overflowX: 'hidden', overflowY: 'hidden' },
    box: { left: 0, top: 0, width: 400, height: 0 },
  });
  const text = new FakeElement({ tagName: 'P', parent: hider });
  const out = runScene(scene, [textNode(text, 'MARKER')]);
  assert.equal(out.text, '');
});

test('P1-5 clip-path:inset(100%) is not extracted', () => {
  const { out } = extractFrom({ clipPath: 'inset(100%)' }, { box: { left: 0, top: 0, width: 400, height: 40 } });
  assert.equal(out.text, '');
});

test('P1-5 legacy clip:rect(0,0,0,0) is not extracted', () => {
  const { out } = extractFrom({ clip: 'rect(0px, 0px, 0px, 0px)', position: 'absolute' }, { box: { left: 0, top: 0, width: 400, height: 40 } });
  assert.equal(out.text, '');
});

test('P1-5 transform:scale(0) is not extracted', () => {
  const { out } = extractFrom({}, { rect: { left: 0, top: 0, width: 0, height: 0 } });
  assert.equal(out.text, '');
});

test('P1-5 filter:opacity(0) is not extracted', () => {
  const { out } = extractFrom({ filter: 'opacity(0)' });
  assert.equal(out.text, '');
});

test('P1-5 position:fixed offscreen is not extracted', () => {
  const { out } = extractFrom({ position: 'fixed' }, { rect: { left: -9999, top: 20, width: 180, height: 18 } });
  assert.equal(out.text, '');
});

test('P1-5 content far right of the page is not extracted', () => {
  const { out } = extractFrom({}, { rect: { left: 5000, top: 20, width: 180, height: 18 } });
  assert.equal(out.text, '');
});

test('P1-5 content-visibility:hidden is not extracted', () => {
  const { out } = extractFrom({ contentVisibility: 'hidden' });
  assert.equal(out.text, '');
});

test('P1-5 display:none on an ancestor is not extracted', () => {
  const scene = makeScene();
  const hidden = new FakeElement({ parent: scene.body, style: { display: 'none' } });
  const text = new FakeElement({ tagName: 'P', parent: hidden });
  const out = runScene(scene, [textNode(text, 'MARKER')]);
  assert.equal(out.text, '');
});

test('P1-5 visibility:hidden is not extracted', () => {
  const { out } = extractFrom({ visibility: 'hidden' });
  assert.equal(out.text, '');
});

test('P1-5 inert subtree is not extracted', () => {
  const { out } = extractFrom({}, { attrs: { inert: true } });
  assert.equal(out.text, '');
});

test('P1-5 closed details content is not extracted, its summary is', () => {
  const scene = makeScene();
  const details = new FakeElement({ tagName: 'DETAILS', parent: scene.body, attrs: { open: false } });
  const summary = new FakeElement({ tagName: 'SUMMARY', parent: details });
  const body = new FakeElement({ tagName: 'P', parent: details });
  const out = runScene(scene, [textNode(summary, 'SUMMARY_TEXT'), textNode(body, 'BODY_TEXT')]);
  assert.equal(out.text, 'SUMMARY_TEXT');
});

test('P1-5 open details content is extracted', () => {
  const scene = makeScene();
  const details = new FakeElement({ tagName: 'DETAILS', parent: scene.body, attrs: { open: true } });
  const summary = new FakeElement({ tagName: 'SUMMARY', parent: details });
  const body = new FakeElement({ tagName: 'P', parent: details });
  const out = runScene(scene, [textNode(summary, 'SUMMARY_TEXT'), textNode(body, 'BODY_TEXT')]);
  assert.equal(out.text, 'SUMMARY_TEXT\nBODY_TEXT');
});

test('P1-5 visibility:hidden overridden to visible by a descendant is extracted', () => {
  const scene = makeScene();
  const hidden = new FakeElement({ parent: scene.body, style: { visibility: 'hidden' } });
  const visible = new FakeElement({ tagName: 'SPAN', parent: hidden, style: { visibility: 'visible' } });
  const out = runScene(scene, [textNode(visible, 'VISIBLE_OVERRIDE')]);
  assert.equal(out.text, 'VISIBLE_OVERRIDE');
});

test('P1-5 display:contents wrapper does not hide its text (Chrome checkVisibility quirk)', () => {
  const scene = makeScene();
  const wrapper = new FakeElement({ parent: scene.body, style: { display: 'contents' }, checkVisibility: () => false });
  const out = runScene(scene, [textNode(wrapper, 'CONTENT')]);
  assert.equal(out.text, 'CONTENT');
});

test('P1-5 normal article text is extracted', () => {
  const scene = makeScene();
  const article = new FakeElement({ tagName: 'ARTICLE', parent: scene.body });
  const heading = new FakeElement({ tagName: 'H1', parent: article });
  const paragraph = new FakeElement({ tagName: 'P', parent: article });
  const out = runScene(scene, [textNode(heading, 'Заголовок'), textNode(paragraph, 'Обычный видимый текст статьи.')]);
  assert.equal(out.text, 'Заголовок\nОбычный видимый текст статьи.');
});

test('P1-5 text below the fold on a long page is extracted', () => {
  const scene = makeScene({ scrollWidth: 1200 });
  const article = new FakeElement({ tagName: 'ARTICLE', parent: scene.body, box: { left: 0, top: 0, width: 1200, height: 9000 } });
  const out = runScene(scene, [textNode(article, 'LONG_PAGE_END', [{ left: 8, top: 8500, width: 300, height: 18 }])]);
  assert.equal(out.text, 'LONG_PAGE_END');
});

test('P1-5 text in a scrollable pane below its visible box is extracted', () => {
  const scene = makeScene();
  const pane = new FakeElement({
    parent: scene.body,
    style: { overflowY: 'auto' },
    box: { left: 0, top: 0, width: 1200, height: 600 },
  });
  const paragraph = new FakeElement({ tagName: 'P', parent: pane });
  const out = runScene(scene, [textNode(paragraph, 'SCROLLABLE_ARTICLE', [{ left: 8, top: 3000, width: 300, height: 18 }])]);
  assert.equal(out.text, 'SCROLLABLE_ARTICLE');
});

test('P1-5 text clipped outside an overflow:hidden box is not extracted', () => {
  const scene = makeScene();
  const pane = new FakeElement({
    parent: scene.body,
    style: { overflowX: 'hidden', overflowY: 'hidden' },
    box: { left: 0, top: 0, width: 1200, height: 600 },
  });
  const paragraph = new FakeElement({ tagName: 'P', parent: pane });
  const out = runScene(scene, [textNode(paragraph, 'CLIPPED_AWAY', [{ left: 8, top: 3000, width: 300, height: 18 }])]);
  assert.equal(out.text, '');
});

test('P1-5 partially clipped text inside its box is extracted', () => {
  const scene = makeScene();
  const pane = new FakeElement({
    parent: scene.body,
    style: { overflowX: 'hidden', overflowY: 'hidden' },
    box: { left: 0, top: 0, width: 1200, height: 600 },
  });
  const paragraph = new FakeElement({ tagName: 'P', parent: pane });
  const out = runScene(scene, [textNode(paragraph, 'EDGE_TEXT', [{ left: 8, top: 590, width: 300, height: 18 }])]);
  assert.equal(out.text, 'EDGE_TEXT');
});

test('P1-5 partially transparent text (alpha 0.4) is extracted', () => {
  const { out } = extractFrom({ color: 'rgba(0, 0, 0, 0.4)', webkitTextFillColor: 'rgba(0, 0, 0, 0.4)' });
  assert.equal(out.text, 'MARKER');
});

test('P1-5 text with one visible rect among hidden ones is extracted', () => {
  const scene = makeScene();
  const element = new FakeElement({ parent: scene.body });
  const out = runScene(scene, [textNode(element, 'PARTIAL', [
    { left: -9999, top: 20, width: 100, height: 18 },
    { left: 10, top: 20, width: 100, height: 18 },
  ])]);
  assert.equal(out.text, 'PARTIAL');
});

test('P1-5 forms, editable fields and private blocks stay excluded', () => {
  const scene = makeScene();
  const privateBlock = new FakeElement({ parent: scene.body, excluded: true });
  const editable = new FakeElement({ parent: scene.body, excluded: true });
  const visible = new FakeElement({ tagName: 'P', parent: scene.body });
  const out = runScene(scene, [
    textNode(privateBlock, 'PRIVATE'),
    textNode(editable, 'EDITABLE'),
    textNode(visible, 'PUBLIC'),
  ]);
  assert.equal(out.text, 'PUBLIC');
});

test('P1-5 UTF-8 and title limits hold with geometry enabled', () => {
  const scene = makeScene();
  const paragraph = new FakeElement({ tagName: 'P', parent: scene.body });
  const long = 'Я'.repeat(100000);
  const out = runScene(scene, [textNode(paragraph, long, [{ left: 8, top: 20, width: 100000, height: 18 }])], 'T'.repeat(2000));
  assert.ok(Buffer.byteLength(out.text, 'utf8') <= 49280);
  assert.ok(Buffer.byteLength(out.title, 'utf8') <= 600);
  assert.equal(long.startsWith(out.text), true);
});

test('P1-5 extractor stays fast on a large page', () => {
  const scene = makeScene();
  const nodes = [];
  for (let index = 0; index < 4000; index += 1) {
    const paragraph = new FakeElement({ tagName: 'P', parent: scene.body });
    nodes.push(textNode(paragraph, `node-${index}`, [{ left: 8, top: 20 + index, width: 120, height: 16 }]));
  }
  const started = performance.now();
  const out = runScene(scene, nodes);
  const elapsed = performance.now() - started;
  assert.ok(out.text.startsWith('node-0\nnode-1'));
  assert.ok(out.text.length > 30000, `expected a large extracted text, got ${out.text.length}`);
  assert.ok(elapsed < 5000, `extractor took ${elapsed.toFixed(0)} ms`);
});

test('P1-5 -webkit-text-security (password dots) is not extracted', () => {
  const { out } = extractFrom({ webkitTextSecurity: 'disc' });
  assert.equal(out.text, '');
});

test('P1-5 gradient text painted through background-clip:text is extracted', () => {
  const { out } = extractFrom({
    color: 'rgba(0, 0, 0, 0)',
    webkitTextFillColor: 'rgba(0, 0, 0, 0)',
    backgroundClip: 'text',
    backgroundImage: 'linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255))',
  });
  assert.equal(out.text, 'MARKER');
});

test('P1-5 outlined text with a transparent fill is extracted', () => {
  const { out } = extractFrom({
    color: 'rgba(0, 0, 0, 0)',
    webkitTextFillColor: 'rgba(0, 0, 0, 0)',
    webkitTextStrokeWidth: '1px',
    webkitTextStrokeColor: 'rgb(0, 0, 0)',
  });
  assert.equal(out.text, 'MARKER');
});

test('P1-5 text painted only by an opaque text-shadow is extracted', () => {
  const { out } = extractFrom({
    color: 'rgba(0, 0, 0, 0)',
    webkitTextFillColor: 'rgba(0, 0, 0, 0)',
    textShadow: 'rgb(0, 0, 0) 0px 0px 2px',
  });
  assert.equal(out.text, 'MARKER');
});

test('P1-5 transparent shadow over transparent fill is not extracted', () => {
  const { out } = extractFrom({
    color: 'rgba(0, 0, 0, 0)',
    webkitTextFillColor: 'rgba(0, 0, 0, 0)',
    textShadow: 'rgba(0, 0, 0, 0) 0px 0px 2px',
  });
  assert.equal(out.text, '');
});

test('P1-5 editable designMode documents are not extracted', () => {
  const scene = makeScene({ designMode: 'on' });
  const paragraph = new FakeElement({ tagName: 'P', parent: scene.body });
  const out = runScene(scene, [textNode(paragraph, 'EDITABLE_DOCUMENT')], 'Editable');
  assert.deepEqual(out, { title: 'Editable', text: '' });
});

test('P1-5 modern color() syntax with zero alpha is not extracted', () => {
  const { out } = extractFrom({ color: 'color(srgb 0 0 0 / 0)', webkitTextFillColor: 'color(srgb 0 0 0 / 0)' });
  assert.equal(out.text, '');
});

test('P1-5 modern color() syntax with visible alpha is extracted', () => {
  const { out } = extractFrom({ color: 'color(srgb 0 0 0 / 0.8)', webkitTextFillColor: 'color(srgb 0 0 0 / 0.8)' });
  assert.equal(out.text, 'MARKER');
});
