import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RecorderOptions, ReplayEvent } from 'pocketbase-replay';
import { createScreenshotRecorder } from '../src/screenshot';
import { inspectScreen } from '../src/screenshot-privacy';
import { watchShadowRoots } from '../src/shadow-roots';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const rect = (x = 0, y = 0, width = 100, height = 100) => ({ x, y, width, height });
class TextNode {
  nodeType = 3;
  parentElement: ElementNode | null = null;
  constructor(public textContent: string, public boxes = [rect()]) {}
  get ownerDocument() { return this.parentElement?.ownerDocument; }
}
class ElementNode {
  nodeType = 1;
  parentElement: ElementNode | null = null;
  childNodes: (ElementNode | TextNode)[] = [];
  shadowRoot: ElementNode | null = null;
  mode: 'open' | 'closed' = 'open';
  attributes = new Set<string>();
  scrollLeft = 0;
  scrollTop = 0;
  box = rect();
  ownerDocument!: FakeDocument;
  style: Record<string, string> = { display: 'block', visibility: 'visible', backgroundImage: 'none', listStyleImage: 'none', filter: 'none', textShadow: 'none', content: 'none' };
  constructor(public tagName: string) {}
  get localName() { return this.tagName.toLowerCase(); }
  append(...children: (ElementNode | TextNode)[]) { for (const child of children) { child.parentElement = this; this.childNodes.push(child); if (child instanceof ElementNode) child.ownerDocument = this.ownerDocument; } return this; }
  getBoundingClientRect() { return this.box; }
  attachShadow(init: { mode: 'open' | 'closed' }) { const root = new ElementNode('SHADOW'); root.ownerDocument = this.ownerDocument; root.mode = init.mode; if (init.mode === 'open') this.shadowRoot = root; return root; }
  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      if (part === '[contenteditable]:not([contenteditable="false"])') return this.attributes.has('contenteditable');
      if (part.startsWith('[')) return this.attributes.has(part.slice(1, -1));
      if (part === '.rr-block') return this.attributes.has('rr-block');
      return part.toLowerCase() === this.tagName.toLowerCase();
    });
  }
  querySelectorAll(): ElementNode[] { return this.childNodes.flatMap((child) => child instanceof ElementNode ? [child, ...child.querySelectorAll()] : []); }
  closest(selector: string): ElementNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
}
class FakeDocument {
  visibilityState = 'visible';
  documentElement = new ElementNode('HTML');
  listeners = new Map<string, Set<(event: any) => void>>();
  animations: { playState: string; pending?: boolean }[] = [];
  defaultView: any;
  invalid = false;
  constructor() { this.documentElement.ownerDocument = this; }
  querySelector(selector: string) { if (this.invalid || selector.includes('INVALID[')) throw new Error('Invalid selector'); return null; }
  querySelectorAll() { return [this.documentElement, ...this.documentElement.querySelectorAll()]; }
  createRange() {
    let node: TextNode;
    return { selectNodeContents(value: TextNode) { node = value; }, getClientRects() { return node.boxes; }, detach() {} };
  }
  getAnimations() { return this.animations; }
  addEventListener(type: string, listener: (event: any) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(listener); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  dispatch(type: string, target: ElementNode, x: number, y: number) { for (const listener of this.listeners.get(type) ?? []) listener({ type, clientX: x, clientY: y, composedPath: () => [target] }); }
}
const options = (extra: Partial<RecorderOptions> = {}): RecorderOptions => ({ endpoint: 'https://replay.example.com', metadata: () => ({ deviceId: 'device', platform: 'ios', appVersion: '1' }), ...extra });
function environment() {
  const doc = new FakeDocument();
  const observers: { pending: number; disconnected: boolean }[] = [];
  class Observer {
    pending = 0;
    disconnected = false;
    constructor(_callback: () => void) { observers.push(this); }
    observe() {}
    takeRecords() { const pending = this.pending; this.pending = 0; return Array(pending).fill({}); }
    disconnect() { this.disconnected = true; }
  }
  const win: any = { document: doc, innerWidth: 100, innerHeight: 100, scrollX: 0, scrollY: 0, crypto: globalThis.crypto, location: { href: 'https://app.example.com/orders?token=private#private' }, MutationObserver: Observer, Element: ElementNode, getComputedStyle: (el: ElementNode, pseudo?: string) => pseudo ? { display: 'none', content: 'none' } : el.style, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  const add = (tag: string, parent = doc.documentElement): ElementNode => { const el = new ElementNode(tag); el.ownerDocument = doc; parent.append(el); return el; };
  return { doc, win, add, observers };
}
async function drain() { for (let index = 0; index < 10; index++) await Promise.resolve(); }
async function installed(callback: (env: ReturnType<typeof environment>, timers: Map<number, { run: () => void; ms: number }>) => Promise<void>) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const env = environment(), timers = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: env.win });
  globalThis.setTimeout = ((run: () => void, ms: number) => { const id = next++; timers.set(id, { run, ms }); return id; }) as any;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as any;
  try { await callback(env, timers); } finally {
    globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete (globalThis as any).window;
  }
}

test('native frames use a guarded plan, rrweb image snapshots, deduplication and explicit fresh snapshots', async () => installed(async ({ win }, timers) => {
  const events: ReplayEvent[] = [], requests: any[] = [];
  let data = PNG;
  const adapter = createScreenshotRecorder({ async captureScreenshot(request) {
    requests.push(request);
    const plan = JSON.parse(win.__pocketbaseReplayScreenshot(request.requestId));
    assert.equal(plan.requestId, request.requestId); assert.equal(plan.width, 100); assert.equal(plan.height, 100);
    assert.match(plan.revision, /^[a-z0-9]+:[a-z0-9]+$/);
    assert.equal(win.__pocketbaseReplayScreenshot('other'), null);
    return { data, width: 100, height: 100 };
  } });
  assert.equal(adapter.imageSnapshots, true);
  const stop = adapter.start((event) => events.push(event), options())!;
  await drain();
  assert.deepEqual(events.map((event) => event.type), [4, 2]);
  assert.equal(events[0].data.href, 'https://app.example.com/orders');
  const serialized = JSON.stringify(events[1]); assert.ok(serialized.includes(PNG)); assert.ok(serialized.includes('"id":8'));
  assert.equal(Object.keys(win).includes('__pocketbaseReplayScreenshot'), false);
  assert.equal(win.__pocketbaseReplayScreenshot(requests[0].requestId), null);
  const tick = () => { const [id, timer] = [...timers][0]; timers.delete(id); timer.run(); };
  tick(); await drain(); assert.equal(events.length, 2, 'unchanged screenshot emits no image mutation');
  data = PNG.slice(0, -4) + 'AAAA'; tick(); await drain();
  assert.equal(events.length, 3); assert.deepEqual(events[2].data.attributes, [{ id: 6, attributes: { src: data } }]);
  adapter.snapshot(); await drain(); assert.deepEqual(events.slice(-2).map((event) => event.type), [4, 2]);
  assert.equal(requests[0].maxDimension, 1280); assert.equal([...timers.values()][0].ms, 1000);
  stop(); assert.equal(timers.size, 0); assert.equal(win.__pocketbaseReplayScreenshot, undefined);
}));

test('a stale capture cannot emit or delete another recorder’s privacy probe', async () => installed(async ({ win, observers }) => {
  const events: ReplayEvent[] = [];
  let resolve!: (value: any) => void;
  const adapter = createScreenshotRecorder({ captureScreenshot: () => new Promise((done) => { resolve = done; }) });
  const stop = adapter.start((event) => events.push(event), options())!;
  stop();
  const other = () => null; Object.defineProperty(win, '__pocketbaseReplayScreenshot', { configurable: true, value: other });
  resolve({ data: PNG, width: 100, height: 100 }); await drain();
  assert.equal(events.length, 0); assert.equal(observers[0].disconnected, true); assert.equal(win.__pocketbaseReplayScreenshot, other);
}));

test('layout mutation, unsafe results and failed native captures retry without rapid loops', async () => installed(async ({ win, observers }, timers) => {
  const events: ReplayEvent[] = [];
  let attempts = 0;
  const adapter = createScreenshotRecorder({ async captureScreenshot(request) {
    attempts++; assert.ok(win.__pocketbaseReplayScreenshot(request.requestId));
    if (attempts === 1) observers[0].pending++;
    if (attempts === 2) return { data: 'data:image/png;base64,raw-private-data', width: 100, height: 100 };
    throw new Error('unsupported');
  } }, { intervalMs: 1, maxDimension: 99999 });
  const stop = adapter.start((event) => events.push(event), options())!;
  await drain();
  for (let index = 0; index < 3; index++) { assert.equal([...timers.values()][0].ms, 500); const [id, timer] = [...timers][0]; timers.delete(id); timer.run(); await drain(); }
  assert.equal(events.length, 0); assert.equal(attempts, 4); stop();
}));

test('privacy plans cover controls, overflowing descendants, blocked media, images, rich text and server image rules', () => {
  const { win, doc, add } = environment();
  const field = add('INPUT'); field.box = rect(1, 2, 10, 10);
  Object.defineProperty(field, 'value', { get() { throw new Error('input values must never be read'); } });
  const mask = add('DIV'); mask.attributes.add('data-replay-mask'); mask.box = rect(20, 20, 20, 20);
  const child = add('BUTTON', mask); child.box = rect(70, 20, 20, 20); child.append(new TextNode('secret button', [rect(70, 20, 30, 10)]));
  const image = add('IMG'); image.box = rect(50, 50, 10, 10);
  const media = add('CANVAS'); media.box = rect(60, 60, 20, 20);
  const one = add('SPAN'); one.append(new TextNode('Rich', [rect(1, 70, 10, 10)]));
  const two = add('SPAN'); two.append(new TextNode('Secret', [rect(11, 70, 20, 10)]));
  const screen = inspectScreen(win, options({ recordImages: true, sensitiveText: () => ['RichSecret'] }), {}, 1)!;
  assert.ok(screen);
  for (const box of [field.box, image.box, media.box, rect(1, 70, 10, 10), rect(11, 70, 20, 10)]) assert.ok(screen.rects.some((value) => JSON.stringify(value) === JSON.stringify(box)));
  assert.deepEqual(screen.privateAreas.get(mask as any), rect(20, 20, 80, 20));
  assert.equal(screen.privateElements.get(child as any), mask);
  assert.equal(inspectScreen(win, options({ recordImages: true }), { maskAllImages: false }, 1)!.privateElements.has(image as any), false);
  assert.equal(inspectScreen(win, options({ recordImages: false }), { maskAllImages: false }, 1)!.privateElements.has(image as any), true);
  doc.invalid = true; assert.equal(inspectScreen(win, options(), {}, 1), null);
});

test('masked keypad clicks and hover share a generic target and location; visible public labels omit accessibility secrets', async () => installed(async ({ win, add, doc }) => {
  const mask = add('DIV'); mask.attributes.add('data-replay-mask'); mask.box = rect(0, 0, 100, 50);
  const one = add('BUTTON', mask); one.box = rect(0, 0, 50, 50); one.append(new TextNode('1', [one.box]));
  const two = add('BUTTON', mask); two.box = rect(50, 0, 50, 50); two.append(new TextNode('2', [two.box]));
  const button = add('BUTTON'); button.box = rect(0, 60, 100, 30); button.append(new TextNode('Pay now', [button.box]));
  Object.defineProperty(button, 'ariaLabel', { get() { throw new Error('accessibility label must not be read'); } });
  const events: ReplayEvent[] = [];
  const adapter = createScreenshotRecorder({ async captureScreenshot(request) { assert.ok(win.__pocketbaseReplayScreenshot(request.requestId)); return { data: PNG, width: 100, height: 100 }; } });
  const stop = adapter.start((event) => events.push(event), options())!; await drain();
  doc.dispatch('click', one, 10, 10); doc.dispatch('click', two, 75, 10); doc.dispatch('pointermove', two, 75, 10);
  const targets = events.filter((event) => event.type === 3 && (event.data.adds as any[])?.length).map((event) => (event.data.adds as any[])[0].node);
  assert.equal(targets.length, 2); assert.deepEqual(targets.map((target) => target.tagName), ['div', 'div']); assert.equal(targets[0].attributes.style, targets[1].attributes.style);
  assert.equal(JSON.stringify(targets).includes('"1"'), false); assert.equal(JSON.stringify(targets).includes('"2"'), false);
  const interactions = events.filter((event) => event.data.source === 2); assert.deepEqual(interactions.map((event) => [event.data.x, event.data.y]), [[50, 25], [50, 25]]);
  assert.deepEqual(events.at(-1)!.data.positions, [{ x: 50, y: 25, id: 6, timeOffset: 0 }]);
  doc.dispatch('click', button, 20, 75); assert.ok(JSON.stringify(events.at(-2)).includes('Pay now')); stop();
}));

test('a drag inspects the page once per sampled pointer position, not on every move', async () => installed(async ({ win, add, doc }) => {
  const button = add('BUTTON'); button.box = rect(0, 0, 100, 30); button.append(new TextNode('Pay now', [button.box]));
  const events: ReplayEvent[] = [];
  const adapter = createScreenshotRecorder({ async captureScreenshot(request) { assert.ok(win.__pocketbaseReplayScreenshot(request.requestId)); return { data: PNG, width: 100, height: 100 }; } });
  const stop = adapter.start((event) => events.push(event), options())!; await drain();
  let inspections = 0;
  const query = doc.querySelector.bind(doc);
  // Each inspection checks the mask and block selectors first.
  doc.querySelector = (selector: string) => { inspections++; return query(selector); };
  for (let x = 0; x < 30; x++) doc.dispatch('pointermove', button, x, 10);
  assert.equal(inspections, 2);
  assert.deepEqual(events.filter((event) => event.data.source === 1).map((event) => event.data.positions), [[{ x: 0, y: 10, id: 6, timeOffset: 0 }]]);
  stop();
}));

test('animation, zoom, hidden documents and uninspectable pages never reach the native bridge', async () => installed(async ({ win, doc }, timers) => {
  let calls = 0;
  doc.animations = [{ playState: 'running' }];
  const adapter = createScreenshotRecorder({ async captureScreenshot() { calls++; return { data: PNG, width: 100, height: 100 }; } });
  const stop = adapter.start(() => {}, options())!; await drain(); assert.equal(calls, 0); assert.equal([...timers.values()][0].ms, 1000);
  doc.animations = []; doc.visibilityState = 'hidden'; adapter.snapshot(); await drain(); assert.equal(calls, 0);
  doc.visibilityState = 'visible'; win.visualViewport = { scale: 2, offsetLeft: 0, offsetTop: 0, width: 50, height: 50 }; adapter.snapshot(); await drain(); assert.equal(calls, 0);
  stop();
}));

test('visibility overrides and private text with ancestor shadows or filters are masked conservatively', () => {
  const { win, add } = environment();
  const hidden = add('DIV'); hidden.style.visibility = 'hidden';
  const visible = add('INPUT', hidden); visible.style.visibility = 'visible'; visible.box = rect(20, 20, 20, 20);
  let screen = inspectScreen(win, options(), {}, 0)!;
  assert.ok(screen.privateElements.has(visible as any), 'a hidden parent cannot hide visible private descendants from inspection');
  const shadow = add('DIV'); shadow.style.textShadow = '200px 0 2px red';
  const text = add('SPAN', shadow); text.append(new TextNode('ShadowSecret', [rect(5, 50, 20, 10)]));
  screen = inspectScreen(win, options({ sensitiveText: () => ['ShadowSecret'] }), {}, 0)!;
  assert.deepEqual(screen.privateAreas.get(text as any), rect(), 'sensitive text discovered after its parent still covers shadows');
  const filter = add('DIV'); filter.style.filter = 'drop-shadow(200px 0 red)';
  const control = add('INPUT', filter); control.box = rect(2, 2, 20, 20);
  screen = inspectScreen(win, options(), {}, 0)!;
  assert.deepEqual(screen.privateAreas.get(control as any), rect(), 'ancestor effects can paint outside private child bounds');
});

test('pending snapshot requests serialize behind one capture and logical viewports can exceed encoded pixel dimensions', async () => installed(async ({ win }, timers) => {
  win.innerWidth = 2000; win.innerHeight = 2000;
  let resolve!: (value: any) => void, calls = 0;
  const events: ReplayEvent[] = [];
  const adapter = createScreenshotRecorder({ captureScreenshot() { calls++; return new Promise((done) => { resolve = done; }); } }, { maxDimension: 256 });
  const stop = adapter.start((event) => events.push(event), options())!;
  adapter.snapshot(); adapter.snapshot(); assert.equal(calls, 1);
  resolve({ data: PNG, width: 2000, height: 2000 }); await drain();
  assert.deepEqual(events.map((event) => event.type), [4, 2]);
  assert.equal([...timers.values()][0].ms, 0, 'explicit pending snapshot runs immediately after the capture finishes');
  const [id, timer] = [...timers][0]; timers.delete(id); timer.run(); assert.equal(calls, 2);
  resolve({ data: PNG, width: 2000, height: 2000 }); await drain();
  assert.deepEqual(events.map((event) => event.type), [4, 2, 4, 2]); stop();
}));

test('empty pseudo-elements with images and CSS border images respect both local and server image settings', () => {
  const { win, add } = environment();
  const pseudo = add('DIV'), border = add('DIV'); border.style.borderImageSource = 'url(private-border.png)';
  const ordinary = win.getComputedStyle;
  win.getComputedStyle = (el: ElementNode, selector?: string) => el === pseudo && selector === '::before' ? { display: 'block', content: '""', backgroundImage: 'url(private-avatar.png)' } : ordinary(el, selector);
  let screen = inspectScreen(win, options({ recordImages: true }), {}, 0)!;
  assert.deepEqual(screen.privateAreas.get(pseudo as any), rect()); assert.ok(screen.privateElements.has(border as any));
  screen = inspectScreen(win, options({ recordImages: true }), { maskAllImages: false }, 0)!;
  assert.equal(screen.privateElements.has(pseudo as any), false); assert.equal(screen.privateElements.has(border as any), false);
  screen = inspectScreen(win, options({ recordImages: false }), { maskAllImages: false }, 0)!;
  assert.deepEqual(screen.privateAreas.get(pseudo as any), rect()); assert.ok(screen.privateElements.has(border as any));
});

test('private text masks include font overhang outside the DOM range box', () => {
  const { win, add } = environment();
  const span = add('SPAN'); span.style.fontSize = '64px'; span.append(new TextNode('ItalicSecret', [rect(10, 10, 20, 20)]));
  const screen = inspectScreen(win, options({ sensitiveText: () => ['ItalicSecret'] }), {}, 0)!;
  assert.ok(screen.rects.some((value) => value.x <= -54 && value.y <= -54 && value.width >= 148 && value.height >= 148));
});

const whole = (value: { x: number; y: number; width: number; height: number }) => value.x === 0 && value.y === 0 && value.width === 100 && value.height === 100;

test('a closed shadow root attached while watched is inspected like an open one, for every later recorder too', async () => installed(async ({ win, add }, timers) => {
  const host = add('DIV'), plans: any[] = [];
  const adapter = createScreenshotRecorder({ async captureScreenshot(request) { plans.push(JSON.parse(win.__pocketbaseReplayScreenshot(request.requestId))); return { data: PNG, width: 100, height: 100 }; } });
  let stop = adapter.start(() => {}, options())!;
  await drain();
  const root = host.attachShadow({ mode: 'closed' });
  assert.equal(root.mode, 'closed'); assert.equal(host.shadowRoot, null, 'the watch preserves closed-root behavior');
  const field = new ElementNode('INPUT'); field.ownerDocument = host.ownerDocument; field.box = rect(10, 20, 30, 15); root.append(field);
  Object.defineProperty(field, 'value', { get() { throw new Error('closed-root values must never be read'); } });
  adapter.snapshot(); await drain();
  assert.deepEqual(plans.at(-1).rects, [rect(10, 20, 30, 15)], 'only the input inside the closed root is masked');
  stop(); assert.equal(timers.size, 0);
  // The watch outlives the recorder, so a later one still sees the root.
  stop = adapter.start(() => {}, options())!; await drain();
  assert.deepEqual(plans.at(-1).rects, [rect(10, 20, 30, 15)]);
  stop();
}));

test('Angular and Ionic hosts without shadow roots are inspected like other elements once the page is watched', () => {
  const { win, add } = environment();
  const app = add('APP-ROOT'), ionApp = add('ION-APP', app), content = add('ION-CONTENT', ionApp);
  const card = add('INPUT', content); card.box = rect(10, 20, 30, 15);
  const title = add('H1', content); title.append(new TextNode('Orders', [rect(10, 50, 40, 10)]));
  assert.ok(inspectScreen(win, options(), {}, 0)!.rects.some(whole), 'unwatched, an unknown host could hide a closed root');
  const screen = inspectScreen(win, options(), {}, 0, undefined, watchShadowRoots(win)!)!;
  assert.deepEqual(screen.rects, [rect(10, 20, 30, 15)]);
});

test('a custom element upgraded before the watch began may hide a closed root, so it still masks the viewport', () => {
  // A prototype of its own: the watch on the shared test prototype began in an earlier test.
  class Fresh extends ElementNode {}
  const { win, doc } = environment();
  win.Element = Fresh;
  win.customElements = { get: (name: string) => name === 'pay-widget' ? Fresh : undefined };
  const make = (tag: string, box: ReturnType<typeof rect>) => { const node = new Fresh(tag); node.ownerDocument = doc; node.box = box; doc.documentElement.append(node); return node; };
  const early = make('PAY-WIDGET', rect(0, 0, 20, 20));
  const undefinedEarly = make('APP-ROOT', rect(0, 80, 20, 20));
  const roots = watchShadowRoots(win)!;
  const later = make('PAY-WIDGET', rect(50, 50, 20, 20));
  assert.equal(roots.unseen(early), true); assert.equal(roots.unseen(undefinedEarly), false); assert.equal(roots.unseen(later), false);
  assert.ok(inspectScreen(win, options(), {}, 0, undefined, roots)!.rects.some(whole));
  doc.documentElement.childNodes.splice(doc.documentElement.childNodes.indexOf(early), 1);
  const closed = later.attachShadow({ mode: 'closed' });
  const pin = new Fresh('INPUT'); pin.ownerDocument = doc; pin.box = rect(55, 55, 10, 5); closed.append(pin);
  assert.deepEqual(inspectScreen(win, options(), {}, 0, undefined, roots)!.rects, [rect(55, 55, 10, 5)]);
});

test('the shadow root watch changes nothing the page can observe and tells listeners about new roots', () => {
  class Fresh extends ElementNode {}
  const { win, doc } = environment();
  win.Element = Fresh;
  const roots = watchShadowRoots(win)!;
  assert.equal(watchShadowRoots(win)!.of(doc.documentElement), null, 'a second call reuses the watch');
  assert.notEqual(Fresh.prototype.attachShadow, ElementNode.prototype.attachShadow);
  let calls = 0;
  const unlisten = roots.listen(() => { calls++; });
  const open = new Fresh('DIV'), closed = new Fresh('DIV');
  const openRoot = open.attachShadow({ mode: 'open' }), closedRoot = closed.attachShadow({ mode: 'closed' });
  assert.equal(open.shadowRoot, openRoot); assert.equal(closed.shadowRoot, null);
  assert.equal(roots.of(open), openRoot); assert.equal(roots.of(closed), closedRoot);
  assert.equal(calls, 2);
  unlisten(); new Fresh('DIV').attachShadow({ mode: 'open' }); assert.equal(calls, 2);
});

test('slotted text inherits a shadow mask even when it overflows a zero-size slot', () => {
  const { win, add } = environment();
  const host = add('DIV'), text = new TextNode('Private slotted text', [rect(120, 10, 50, 10)]); host.append(text);
  const shadow = host.attachShadow({ mode: 'open' });
  const mask = add('DIV', shadow); mask.attributes.add('data-replay-mask'); mask.box = rect(0, 0, 10, 10);
  const slot = add('SLOT', mask); slot.box = rect(0, 0, 0, 0); (slot as any).assignedNodes = () => [text];
  const screen = inspectScreen(win, options(), {}, 0)!;
  assert.ok(screen); assert.ok(screen.rects.some((value) => value.x === 120 && value.width === 50));
  assert.deepEqual(screen.privateAreas.get(mask as any), rect(0, 0, 170, 20));
  assert.equal(screen.privateElements.get(host as any), mask, 'the light-DOM parent cannot name masked assigned text in a tap label');
});
