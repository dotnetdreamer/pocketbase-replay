import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedContentFilter, insideBlocked } from '../src/blocked';
import type { ReplayEvent } from '../src/types';

// Shaped as rrweb 2.1.6 sends them: blocked elements are empty placeholders sized by rr_width and rr_height, a
// same-origin iframe's document arrives as its own mutation whatever the block rules say, and a blocked element's
// shadow root and the stylesheets adopted there are still watched.
const placeholder = (id: number, tagName: string) => ({ type: 2, tagName, attributes: { rr_width: '304px', rr_height: '154px' }, childNodes: [], id });
const text = (id: number, textContent: string, rootId?: number) => ({ type: 3, textContent, id, ...(rootId ? { rootId } : {}) });
const element = (id: number, tagName: string, childNodes: unknown[] = [], rootId?: number) => ({ type: 2, tagName, attributes: {}, childNodes, id, ...(rootId ? { rootId } : {}) });
const mutation = (data: Record<string, unknown>, timestamp = 2): ReplayEvent => ({
  type: 3, timestamp, data: { source: 0, adds: [], removes: [], texts: [], attributes: [], ...data },
});
const incremental = (data: Record<string, unknown>): ReplayEvent => ({ type: 3, timestamp: 3, data });
const frameDocument = (id: number, secret: string) => ({
  type: 0, id, childNodes: [element(id + 1, 'html', [element(id + 2, 'head', [], id), element(id + 3, 'body', [element(id + 4, 'p', [text(id + 5, secret, id)], id)], id)], id)],
});
const meta: ReplayEvent = { type: 4, timestamp: 0, data: { href: 'https://app.test/', width: 1280, height: 800 } };
const snapshot = (...body: unknown[]): ReplayEvent => ({
  type: 2, timestamp: 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [element(2, 'html', [element(3, 'body', body)])] } },
});

// The page as the recorder sees it through rrweb's node ids: each node under its parent, a shadow root's content under
// its host and an iframe's document under the iframe, and which elements the block rules match right now.
function page() {
  const parents = new Map<number, number | null>([[1, null], [2, 1], [3, 2]]);
  const blocked = new Set<number>();
  const asked: number[] = [];
  const add = (parent: number, ...ids: number[]) => { for (const id of ids) parents.set(id, parent); };
  const check = (id: number) => {
    asked.push(id);
    if (!parents.has(id)) return true;
    for (let node: number | null = id; node !== null; node = parents.get(node) ?? null) if (blocked.has(node)) return true;
    return false;
  };
  return { blocked, asked, add, check };
}

// Visible text in 4 and 5, a blocked iframe 6 and a blocked shadow host 7.
function recording() {
  const dom = page();
  dom.add(3, 4, 6, 7); dom.add(4, 5);
  dom.blocked.add(6).add(7);
  const hide = blockedContentFilter(dom.check);
  const sent: ReplayEvent[] = [];
  const pass = (event: ReplayEvent) => { const kept = hide(event); if (kept) sent.push(kept); return kept; };
  pass(meta);
  pass(snapshot(element(4, 'p', [text(5, 'Visible page text')]), placeholder(6, 'iframe'), placeholder(7, 'div')));
  return { dom, pass, sent };
}

test('a blocked iframe\'s document, and everything later added or changed inside it, never leaves the recorder', () => {
  const { dom, pass, sent } = recording();
  dom.add(6, 20); dom.add(20, 21); dom.add(21, 22, 23); dom.add(23, 24); dom.add(24, 25);
  assert.equal(pass(mutation({ adds: [{ parentId: 6, nextId: null, node: frameDocument(20, 'IFRAME_EXISTING') }], isAttachIframe: true })), null);
  // An iframe added later is a placeholder too, and its document goes the same way.
  dom.add(3, 30); dom.blocked.add(30);
  const added = mutation({ adds: [{ parentId: 3, nextId: null, node: placeholder(30, 'iframe') }] });
  assert.equal(pass(added), added);
  dom.add(30, 40); dom.add(40, 41); dom.add(41, 42, 43);
  assert.equal(pass(mutation({ adds: [{ parentId: 30, nextId: null, node: frameDocument(40, 'IFRAME_DYNAMIC') }], isAttachIframe: true })), null);
  dom.add(23, 50); dom.add(50, 51);
  assert.equal(pass(mutation({ adds: [{ parentId: 23, nextId: null, node: element(50, 'span', [], 20) }, { parentId: 50, nextId: null, node: text(51, 'IFRAME_MUTATION', 20) }] })), null);
  // A batch that touches the page and the iframe keeps only the page's part.
  dom.add(3, 60); dom.add(60, 61); dom.add(43, 62);
  const mixed = pass(mutation({
    adds: [{ parentId: 3, nextId: null, node: element(60, 'p') }, { parentId: 60, nextId: null, node: text(61, 'Added to the page') }, { parentId: 43, nextId: null, node: text(62, 'IFRAME_ADDED') }],
    texts: [{ id: 5, value: 'Page text changed' }, { id: 25, value: 'IFRAME_TEXT' }],
    attributes: [{ id: 4, attributes: { class: 'page' } }, { id: 24, attributes: { title: 'IFRAME_ATTRIBUTE' } }],
    removes: [{ parentId: 23, id: 50 }, { parentId: 3, id: 4 }],
  }));
  assert.deepEqual(mixed!.data.adds, [{ parentId: 3, nextId: null, node: element(60, 'p') }, { parentId: 60, nextId: null, node: text(61, 'Added to the page') }]);
  assert.deepEqual(mixed!.data.texts, [{ id: 5, value: 'Page text changed' }]);
  assert.deepEqual(mixed!.data.attributes, [{ id: 4, attributes: { class: 'page' } }]);
  assert.deepEqual(mixed!.data.removes, [{ parentId: 3, id: 4 }]);
  // Inputs, scrolls, clicks and styles inside the iframe name its nodes, and so does a click on the iframe itself,
  // which rrweb never sends; the same on the page still go.
  for (const data of [{ source: 5, id: 25, text: '*', isChecked: false }, { source: 3, id: 20, x: 0, y: 40 }, { source: 2, type: 2, id: 24, x: 1, y: 2 },
    { source: 2, type: 2, id: 6, x: 1, y: 2 }, { source: 15, id: 20, styleIds: [1], styles: [{ styleId: 1, rules: [{ rule: '.secret {}' }] }] },
    { source: 8, id: 22, adds: [{ rule: 'p {}' }] }]) {
    assert.equal(pass(incremental(data)), null, JSON.stringify(data));
  }
  for (const data of [{ source: 5, id: 4, text: '*', isChecked: false }, { source: 3, id: 1, x: 0, y: 40 }, { source: 2, type: 2, id: 5, x: 1, y: 2 }, { source: 4, width: 800, height: 600 }]) {
    const event = incremental(data);
    assert.equal(pass(event), event, JSON.stringify(data));
  }
  const selection = pass(incremental({ source: 14, ranges: [{ start: 5, startOffset: 0, end: 5, endOffset: 4 }, { start: 25, startOffset: 0, end: 25, endOffset: 2 }] }));
  assert.deepEqual(selection!.data.ranges, [{ start: 5, startOffset: 0, end: 5, endOffset: 4 }]);
  assert.equal(pass(incremental({ source: 14, ranges: [{ start: 25, startOffset: 0, end: 5, endOffset: 2 }] })), null);
  const moves = pass(incremental({ source: 1, positions: [{ x: 1, y: 1, id: 4, timeOffset: 0 }, { x: 2, y: 2, id: 25, timeOffset: 5 }] }));
  assert.deepEqual(moves!.data.positions, [{ x: 1, y: 1, id: 4, timeOffset: 0 }]);
  assert.doesNotMatch(JSON.stringify(sent), /IFRAME_/);
  assert.match(JSON.stringify(sent), /Visible page text/);
});

test('content rrweb adds to a blocked element\'s shadow root is dropped with every later change to it', () => {
  const { dom, pass, sent } = recording();
  dom.add(7, 70); dom.add(70, 71);
  assert.equal(pass(mutation({ adds: [{ parentId: 7, nextId: null, node: { ...element(70, 'p'), isShadow: true } }, { parentId: 70, nextId: null, node: text(71, 'SHADOW_TEXT') }] })), null);
  assert.equal(pass(mutation({ texts: [{ id: 71, value: 'SHADOW_CHANGED' }] })), null);
  dom.add(70, 72);
  assert.equal(pass(mutation({ adds: [{ parentId: 70, nextId: null, node: text(72, 'SHADOW_LATER') }] })), null);
  assert.equal(pass(mutation({ removes: [{ parentId: 7, id: 70, isShadow: true }] })), null);
  // rrweb names a node it never recorded, such as one already inside the shadow root when recording began, as -1.
  for (const data of [{ source: 2, type: 2, id: -1, x: 5, y: 5 }, { source: 3, id: -1, x: 0, y: 10 }]) assert.equal(pass(incremental(data)), null);
  // The placeholder itself stays part of the page: it can go.
  const removed = mutation({ removes: [{ parentId: 3, id: 7 }] });
  assert.equal(pass(removed), removed);
  assert.doesNotMatch(JSON.stringify(sent), /SHADOW_/);
});

test('stylesheets adopted inside blocked content never leave, nor any later change to them', () => {
  const { dom, pass, sent } = recording();
  dom.add(6, 20); dom.add(2, 8);
  // As a page sent them: rules adopted by the blocked host's shadow root, then changed by stylesheet number only, and
  // the same inside the iframe's document.
  for (const data of [
    { source: 15, id: 7, styleIds: [1], styles: [{ styleId: 1, rules: [{ rule: '.probe::before { content: "SHADOW_STYLE_ADOPT"; }', index: 0 }] }] },
    { source: 8, styleId: 1, adds: [{ rule: '.probe::after{content:"SHADOW_STYLE_INSERT"}', index: 1 }] },
    { source: 8, styleId: 1, replaceSync: '.probe::before{content:"SHADOW_STYLE_REPLACE"}' },
    { source: 13, styleId: 1, set: { property: 'content', value: '"SHADOW_STYLE_DECLARATION"' }, index: [0] },
    { source: 15, id: 20, styleIds: [2], styles: [{ styleId: 2, rules: [{ rule: 'p::before { content: "IFRAME_STYLE_ADOPT"; }', index: 0 }] }] },
    { source: 8, styleId: 2, adds: [{ rule: 'p::after{content:"IFRAME_STYLE_INSERT"}', index: 1 }] },
  ]) assert.equal(pass(incremental(data)), null, JSON.stringify(data));
  // The page's own stylesheets, adopted or in a style element, still go.
  for (const data of [
    { source: 15, id: 1, styleIds: [3], styles: [{ styleId: 3, rules: [{ rule: 'body { color: red; }', index: 0 }] }] },
    { source: 8, styleId: 3, adds: [{ rule: 'p { margin: 0; }', index: 1 }] },
    { source: 8, id: 8, adds: [{ rule: 'h1 { margin: 0; }', index: 0 }] },
  ]) { const event = incremental(data); assert.equal(pass(event), event, JSON.stringify(data)); }
  // rrweb numbers stylesheets afresh with each full snapshot, so the page's may now carry a number a blocked one had.
  pass(meta);
  pass(snapshot(element(4, 'p', [text(5, 'Visible page text')]), placeholder(6, 'iframe'), placeholder(7, 'div')));
  for (const data of [
    { source: 15, id: 1, styleIds: [1], styles: [{ styleId: 1, rules: [{ rule: 'body { color: blue; }', index: 0 }] }] },
    { source: 8, styleId: 1, adds: [{ rule: 'p { margin: 1px; }', index: 1 }] },
  ]) { const event = incremental(data); assert.equal(pass(event), event, JSON.stringify(data)); }
  assert.equal(pass(incremental({ source: 15, id: 7, styleIds: [2], styles: [{ styleId: 2, rules: [{ rule: 'p { content: "SHADOW_STYLE_AGAIN"; }', index: 0 }] }] })), null);
  assert.equal(pass(incremental({ source: 8, styleId: 2, replaceSync: 'p { content: "SHADOW_STYLE_AGAIN_REPLACE"; }' })), null);
  assert.doesNotMatch(JSON.stringify(sent), /SHADOW_|IFRAME_/);
});

test('an element blocked after it was recorded keeps its existing content to itself, with or without a new snapshot', () => {
  const { dom, pass, sent } = recording();
  dom.add(3, 9); dom.add(9, 10); dom.add(10, 11);
  pass(mutation({ adds: [{ parentId: 3, nextId: null, node: element(9, 'div') }, { parentId: 9, nextId: null, node: element(10, 'span') }, { parentId: 10, nextId: null, node: text(11, 'PUBLIC_BEFORE_BLOCK') }] }));
  // data-replay-block is set on it. rrweb sends nothing for that, yet still sends changes to what lies deeper inside.
  dom.blocked.add(9);
  assert.equal(pass(mutation({ texts: [{ id: 11, value: 'PRIVATE_AFTER_BLOCK_TEXT' }] })), null);
  assert.equal(pass(mutation({ attributes: [{ id: 10, attributes: { title: 'PRIVATE_AFTER_BLOCK_TITLE' } }] })), null);
  // A full snapshot shows it as a placeholder, and rrweb still knows its old content.
  pass(meta);
  pass(snapshot(element(4, 'p', [text(5, 'Visible page text')]), placeholder(6, 'iframe'), placeholder(7, 'div'), placeholder(9, 'div')));
  assert.equal(pass(mutation({ texts: [{ id: 11, value: 'PRIVATE_AFTER_SNAPSHOT' }] })), null);
  const mixed = pass(mutation({ texts: [{ id: 11, value: 'PRIVATE_MIXED' }, { id: 5, value: 'Page text changed' }] }));
  assert.deepEqual(mixed!.data.texts, [{ id: 5, value: 'Page text changed' }]);
  assert.doesNotMatch(JSON.stringify(sent), /PRIVATE_/);
  assert.match(JSON.stringify(sent), /PUBLIC_BEFORE_BLOCK/);
});

test('an element no longer blocked is recorded again straight away, and after the next snapshot', () => {
  const { dom, pass, sent } = recording();
  // The shadow host stops being blocked: rrweb sends that attribute change, then what is added to its shadow root.
  dom.blocked.delete(7);
  const unblocked = mutation({ attributes: [{ id: 7, attributes: { 'data-replay-block': null } }] });
  assert.equal(pass(unblocked), unblocked);
  dom.add(7, 75); dom.add(75, 76);
  const added = mutation({ adds: [{ parentId: 7, nextId: null, node: { ...element(75, 'span'), isShadow: true } }, { parentId: 75, nextId: null, node: text(76, 'PUBLIC_UNBLOCK_ADD') }] });
  assert.equal(pass(added), added);
  pass(meta);
  pass(snapshot(element(4, 'p', [text(5, 'Visible page text')]), placeholder(6, 'iframe'), element(7, 'div', [{ ...element(75, 'span', [text(76, 'PUBLIC_UNBLOCK_ADD')]), isShadow: true }])));
  const later = mutation({ texts: [{ id: 76, value: 'PUBLIC_UNBLOCK_LATER' }] });
  assert.equal(pass(later), later);
  assert.match(JSON.stringify(sent), /PUBLIC_UNBLOCK_LATER/);
});

test('without blocked content every event passes through unchanged, and each node is looked up once per event', () => {
  const { dom, pass, sent } = recording();
  dom.add(3, 80); dom.add(80, 81);
  const events = [
    mutation({ adds: [{ parentId: 3, nextId: null, node: element(80, 'p') }, { parentId: 80, nextId: null, node: text(81, 'Added') }], texts: [{ id: 5, value: 'Changed' }], attributes: [{ id: 4, attributes: { class: 'a' } }, { id: 4, attributes: { title: 'b' } }] }),
    incremental({ source: 2, type: 2, id: 4, x: 1, y: 2 }),
    { type: 5, timestamp: 4, data: { tag: 'pbr/trigger', payload: { reason: 'checkout' } } },
  ];
  dom.asked.length = 0;
  for (const event of events) assert.equal(pass(event), event);
  // Node 80 is known from its own add; 4 is looked up again for the click, a later event.
  assert.deepEqual(dom.asked, [3, 5, 4, 4]);
  assert.equal(sent.length, 2 + events.length);
});

// Just what insideBlocked reads of a DOM node.
interface FakeNode {
  nodeType: number; parentNode: FakeNode | null; parentElement: FakeNode | null; matched?: boolean;
  host?: FakeNode; defaultView?: { frameElement: FakeNode | null } | null;
  closest?: (selector: string) => FakeNode | null; getRootNode: () => FakeNode;
}

test('the page check follows a node out through shadow roots and same-origin iframes, and fails closed', () => {
  const selectors: string[] = [];
  const node = (nodeType: number, parentNode: FakeNode | null, extra: Partial<FakeNode> = {}): FakeNode => {
    const self: FakeNode = {
      nodeType, parentNode, parentElement: parentNode?.nodeType === 1 ? parentNode : null, ...extra,
      getRootNode: () => { let top = self; while (top.parentNode) top = top.parentNode; return top; },
    };
    if (nodeType === 1 && !self.closest) {
      self.closest = (selector) => {
        selectors.push(selector);
        for (let at: FakeNode | null = self; at?.nodeType === 1; at = at.parentNode) if (at.matched) return at;
        return null;
      };
    }
    return self;
  };
  const top = node(9, null);
  const body = node(1, node(1, top));
  const blocked = node(1, body, { matched: true });
  const deep = node(3, node(1, blocked));
  const shown = node(3, node(1, body));
  // Shadow roots of a blocked host, of a host inside a blocked element, and of one in plain view.
  const shadow = (host: FakeNode) => node(11, null, { host });
  const blockedShadow = node(3, node(1, shadow(blocked)));
  const nestedShadow = node(1, shadow(node(1, blocked)));
  const shownShadow = node(3, shadow(node(1, body)));
  // A same-origin iframe's document, one whose window has gone, and a node already taken out of the page.
  const frame = node(1, body, { matched: true });
  const frameDocument = node(9, null, { defaultView: { frameElement: frame } });
  const inFrame = node(3, node(1, node(1, frameDocument)));
  const goneFrame = node(1, node(9, null, { defaultView: null }));
  const detached = node(3, node(1, null));
  const check = (target: FakeNode | null) => insideBlocked(target as unknown as Node, '[data-replay-block]', top as unknown as Document);
  assert.equal(check(top), false);
  assert.equal(check(shown), false);
  assert.equal(check(shownShadow), false);
  assert.equal(check(blocked), true);
  assert.equal(check(deep), true);
  assert.equal(check(blockedShadow), true);
  assert.equal(check(nestedShadow), true);
  assert.equal(check(frameDocument), true);
  assert.equal(check(inFrame), true);
  assert.equal(check(goneFrame), true);
  assert.equal(check(detached), true);
  assert.equal(check(null), true);
  assert.ok(selectors.length && selectors.every((selector) => selector === '[data-replay-block]'));
  const unreadable = node(1, body, { closest: () => { throw new Error('unreadable'); } });
  assert.equal(check(unreadable), true);
});
