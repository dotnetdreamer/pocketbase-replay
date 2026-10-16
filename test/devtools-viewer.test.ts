import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { test } from 'node:test';
import { shortenIdle, type ReplayEvent } from '../viewer/decode';
import { replayOffset, type ErrorOccurrence, type LogEntry } from '../viewer/observability';
import type { Activity, TimelineMark } from '../viewer/devtools';

// viewer/devtools.ts imports its stylesheet for esbuild; Node has no loader for CSS.
const loaders = nodeModule as unknown as {
  registerHooks?: (hooks: { load: (url: string, context: unknown, next: (url: string, context: unknown) => unknown) => unknown }) => void;
  register: (specifier: string, parent: string) => void;
};
if (loaders.registerHooks) {
  loaders.registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
} else {
  loaders.register(`data:text/javascript,${encodeURIComponent(
    'export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`, import.meta.url);
}
const viewer = import('../viewer/devtools');

const meta = (timestamp: number, href: string): ReplayEvent => ({ type: 4, timestamp, data: { href, width: 390, height: 844 } });
const snapshot = (timestamp: number, node: unknown): ReplayEvent => ({ type: 2, timestamp, data: { node, initialOffset: { top: 0, left: 0 } } });
const click = (timestamp: number, id: number, type = 2): ReplayEvent => ({ type: 3, timestamp, data: { source: 2, type, id, x: 4, y: 4 } });
const mutation = (timestamp: number, data: Record<string, unknown>): ReplayEvent =>
  ({ type: 3, timestamp, data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data } });
const custom = (timestamp: number, tag: string, payload?: unknown): ReplayEvent => ({ type: 5, timestamp, data: { tag, payload } });
const element = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) => ({ type: 2, id, tagName, attributes, childNodes });
const textNode = (id: number, textContent: string) => ({ type: 3, id, textContent });

const page = { type: 0, id: 1, childNodes: [
  { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
  element(3, 'html', {}, [
    element(4, 'head', {}, [element(5, 'style', {}, [{ type: 3, id: 6, textContent: '.a { color: red }', isStyle: true }])]),
    element(7, 'body', {}, [
      element(10, 'button', { id: 'save', class: 'primary big' }, [
        element(11, 'svg', {}, [element(12, 'path')]),
        element(13, 'span', {}, [textNode(14, '\n    Save   changes\n  ')]),
      ]),
      element(20, 'a', { class: 'nav-link active', href: '/settings' }, [textNode(21, 'Settings')]),
      element(30, 'p', { class: 'name' }, [textNode(31, '*')]),
      element(40, 'div', { class: 'card' }, [
        element(41, 'script', {}, [textNode(42, 'var hidden = 1')]),
        textNode(43, 'A very long description that goes on and on beyond the label budget'),
      ]),
      element(50, 'ul', { role: 'list' }),
      element(60, 'input', { type: 'text', value: '*' }),
    ]),
  ]),
] };

test('names each click by its element as recorded at that moment, through snapshots and mutations', async () => {
  const { collectActivity } = await viewer;
  const events = [
    meta(1000, 'https://app.test/home'), snapshot(1000, page),
    click(1100, 10), click(1200, 12), click(1300, 14), click(1400, 20), click(1500, 30), click(1600, 40), click(1700, 60), click(1800, 999),
    click(1900, 20, 4),
    mutation(2000, { adds: [
      { parentId: 50, nextId: null, node: element(51, 'li', { class: 'item' }) },
      { parentId: 51, nextId: null, node: textNode(52, 'Second') },
      { parentId: 50, nextId: 51, node: element(53, 'li') },
      { parentId: 53, nextId: null, node: textNode(54, 'First') },
    ] }),
    click(2100, 50), click(2150, 52),
    mutation(2200, { texts: [{ id: 21, value: 'Preferences' }], attributes: [{ id: 20, attributes: { class: 'menu', id: 'prefs' } }] }),
    click(2300, 20),
    mutation(2400, { attributes: [{ id: 20, attributes: { id: null } }], removes: [{ parentId: 50, id: 53 }] }),
    click(2500, 20), click(2600, 50), click(2700, 54),
    // A new full snapshot replaces the whole page.
    snapshot(3000, { type: 0, id: 1, childNodes: [element(10, 'div', { class: 'fresh' }, [textNode(11, 'Rebuilt')])] }),
    click(3100, 10), click(3200, 20),
  ];
  const clicks = collectActivity(events).filter((item) => item.kind === 'click');
  assert.deepEqual(clicks.map((item) => item.title), [
    'button#save "Save changes"', 'button#save "Save changes"', 'button#save "Save changes"', 'a.nav-link "Settings"', 'p.name "*"',
    'div.card "A very long description that goes on and…"', 'input', 'Unknown element', 'a.nav-link "Settings"',
    'ul "First Second"', 'li.item "Second"', 'a#prefs "Preferences"', 'a.menu "Preferences"', 'ul "Second"', 'Unknown element',
    'div.fresh "Rebuilt"', 'Unknown element',
  ]);
  assert.deepEqual(clicks.map((item) => item.timestamp), [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2100, 2150, 2300, 2500, 2600, 2700, 3100, 3200]);
  assert.equal(clicks[8].detail, 'Double click');
  assert.equal(clicks[0].detail, undefined);
  assert.ok(clicks.every((item) => item.severity === 'info'));
});

test('turns network, console, page and trigger events into activity and skips malformed ones', async () => {
  const { collectActivity } = await viewer;
  const items = collectActivity([
    meta(1000, 'https://app.test/home'), snapshot(1000, page),
    custom(1100, 'pbr/network', { kind: 'fetch', method: 'post', url: 'https://app.test/api/items', status: 201, duration: 35 }),
    custom(1200, 'pbr/network', { kind: 'xhr', method: 'GET', url: 'https://api.other.test/v1/users', status: 404, duration: 1234 }),
    custom(1300, 'pbr/network', { kind: 'fetch', method: 'GET', url: 'https://app.test/slow', status: 0, duration: 30000, failed: 'timeout' }),
    custom(1400, 'pbr/network', { kind: 'fetch', method: 'GET', url: 'https://app.test', status: 0, duration: 3, failed: 'abort' }),
    custom(1500, 'pbr/network', { url: 42 }),
    custom(1600, 'pbr/console', { level: 'warn', text: 'Low disk' }),
    custom(1700, 'pbr/console', { level: 'error', text: 'Uncaught TypeError: x is not a function', uncaught: true }),
    custom(1800, 'pbr/console', { level: 'toString', text: 5 }),
    custom(1900, 'pbr/navigation', { url: 'https://app.test/orders' }),
    meta(2000, 'https://app.test/orders'), snapshot(2000, page),
    custom(2100, 'pbr/navigation', { url: 'https://other.test/x' }),
    custom(2200, 'pbr/trigger', { reason: 'error' }),
    custom(2300, 'pbr/trigger'),
    custom(2400, 'other/tag', { text: 'ignored' }),
    { type: 3, timestamp: 2500, data: null },
    null as unknown as ReplayEvent,
    { type: 5, timestamp: Number.NaN, data: { tag: 'pbr/console', payload: { text: 'no time' } } },
  ]);
  assert.deepEqual(items, [
    { kind: 'navigation', timestamp: 1000, title: '/home', severity: 'info' },
    { kind: 'network', timestamp: 1100, title: 'POST /api/items', detail: '201 · 35 ms', severity: 'info', status: 201, duration: 35 },
    { kind: 'network', timestamp: 1200, title: 'GET api.other.test/v1/users', detail: '404 · 1.2 s', severity: 'error', status: 404, duration: 1234 },
    { kind: 'network', timestamp: 1300, title: 'GET /slow', detail: 'Timed out · 30 s', severity: 'error', status: 0, duration: 30000, failed: 'timeout' },
    { kind: 'network', timestamp: 1400, title: 'GET /', detail: 'Cancelled · 3 ms', severity: 'error', status: 0, duration: 3, failed: 'abort' },
    { kind: 'network', timestamp: 1500, title: 'GET (no URL)', detail: 'No response', severity: 'error', status: 0 },
    { kind: 'console', timestamp: 1600, title: 'Low disk', detail: 'Warning', severity: 'warn', level: 'warn' },
    { kind: 'console', timestamp: 1700, title: 'Uncaught TypeError: x is not a function', detail: 'Uncaught error', severity: 'error', level: 'error', uncaught: true },
    { kind: 'console', timestamp: 1800, title: '(empty message)', detail: 'Log', severity: 'info', level: 'log' },
    { kind: 'navigation', timestamp: 1900, title: '/orders', severity: 'info' },
    { kind: 'navigation', timestamp: 2100, title: 'other.test/x', severity: 'info' },
    { kind: 'trigger', timestamp: 2200, title: 'Recording triggered (error)', severity: 'info' },
    { kind: 'trigger', timestamp: 2300, title: 'Recording triggered', severity: 'info' },
  ]);
});

test('labels stay fast across half a million events with a churning list', async () => {
  const { collectActivity } = await viewer;
  const rows = 2000;
  const list = element(2, 'ul', {}, Array.from({ length: rows }, (_, index) => element(1000 + index * 2, 'li', {}, [textNode(1001 + index * 2, `Row ${index}`)])));
  const events: ReplayEvent[] = [meta(0, 'https://app.test/'), snapshot(0, { type: 0, id: 1, childNodes: [list] })];
  const none: never[] = [];
  let oldest = 0, newest = rows - 1, clickCount = 0;
  // A virtual list: the oldest row leaves the top as a new one joins the bottom, between text updates.
  while (events.length < 500_000) {
    const timestamp = events.length;
    if (events.length % 4) {
      events.push({ type: 3, timestamp, data: { source: 0, texts: [{ id: 1001 + newest * 2, value: `Row ${newest} at ${timestamp}` }], attributes: none, removes: none, adds: none } });
    } else {
      newest++;
      events.push(mutation(timestamp, {
        removes: [{ parentId: 2, id: 1000 + oldest++ * 2 }],
        adds: [{ parentId: 2, nextId: null, node: element(1000 + newest * 2, 'li') }, { parentId: 1000 + newest * 2, nextId: null, node: textNode(1001 + newest * 2, `Row ${newest}`) }],
      }));
    }
    if (events.length % 5000 === 0) { events.push(click(events.length, 1000 + newest * 2)); clickCount++; }
  }
  const started = performance.now();
  const clicks = collectActivity(events).filter((item) => item.kind === 'click');
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `took ${Math.round(elapsed)} ms`);
  assert.equal(clicks.length, clickCount);
  assert.match(clicks.at(-1)!.title, /^li "Row \d+/);
  assert.equal(collectActivity([...events, click(600_000, 1000)]).at(-1)!.title, 'Unknown element');
});

test('maps stored errors and logs by level, newest last', async () => {
  const { diagnosticActivity } = await viewer;
  const errors = [
    { id: 'e1', timestamp: 2000, level: 'error', service: 'web', name: 'TypeError', message: 'boom', stack: '', handled: false },
    { id: 'e2', timestamp: 1000, level: 'fatal', service: '', name: 'RangeError', message: '', stack: '', handled: true },
    { id: 'e3', timestamp: 'later' },
  ] as unknown as ErrorOccurrence[];
  const logs = [
    { id: 'l1', timestamp: 1500, level: 'warn', service: 'api', message: 'Slow response' },
    { id: 'l2', timestamp: 2500, level: 'error', service: '', message: 'Write failed' },
    { id: 'l3', timestamp: 500, level: 'trace', service: '', message: '' },
    null,
  ] as unknown as LogEntry[];
  assert.deepEqual(diagnosticActivity(errors, logs), [
    { kind: 'log', timestamp: 500, title: '(empty log)', detail: 'Trace log', severity: 'info', level: 'trace' },
    { kind: 'error', timestamp: 1000, title: 'RangeError', detail: 'Handled fatal error', severity: 'error', level: 'fatal' },
    { kind: 'log', timestamp: 1500, title: 'Slow response', detail: 'Warning log · api', severity: 'warn', level: 'warn' },
    { kind: 'error', timestamp: 2000, title: 'TypeError: boom', detail: 'Unhandled error · web', severity: 'error', level: 'error', uncaught: true },
    { kind: 'log', timestamp: 2500, title: 'Write failed', detail: 'Error log', severity: 'error', level: 'error' },
  ]);
  assert.deepEqual(diagnosticActivity(undefined as unknown as ErrorOccurrence[], null as unknown as LogEntry[]), []);
});

test('hides stored copies of recorded console lines and uncaught errors', async () => {
  const { diagnosticActivity, mergeActivity } = await viewer;
  const recorded: Activity[] = [
    { kind: 'console', timestamp: 1000, title: 'Saved order 42', detail: 'Log', severity: 'info', level: 'log' },
    { kind: 'console', timestamp: 2000, title: 'Uncaught TypeError: x is not a function', detail: 'Uncaught error', severity: 'error', level: 'error', uncaught: true },
    { kind: 'console', timestamp: 3000, title: 'Uncaught (in promise) plain', detail: 'Uncaught error', severity: 'error', level: 'error', uncaught: true },
    { kind: 'console', timestamp: 4000, title: 'Retrying', detail: 'Warning', severity: 'warn', level: 'warn' },
    { kind: 'console', timestamp: 4100, title: 'Retrying', detail: 'Warning', severity: 'warn', level: 'warn' },
    { kind: 'click', timestamp: 5000, title: 'button "Retrying"', severity: 'info' },
  ];
  const diagnostics = diagnosticActivity([
    { timestamp: 2001, name: 'TypeError', message: 'x is not a function', handled: false, level: 'error' },
    // Caught and reported by the app, so it is not the uncaught error the recorder saw.
    { timestamp: 2002, name: 'TypeError', message: 'x is not a function', handled: true, level: 'error' },
    { timestamp: 3001, name: 'Error', message: 'plain', handled: false, level: 'error' },
    { timestamp: 9000, name: 'TypeError', message: 'x is not a function', handled: false, level: 'error' },
  ] as unknown as ErrorOccurrence[], [
    { timestamp: 1001, level: 'info', message: 'Saved order 42' },
    { timestamp: 1002, level: 'error', message: 'Saved order 42' },
    { timestamp: 4001, level: 'warn', message: 'Retrying' },
    { timestamp: 4101, level: 'warn', message: 'Retrying' },
    { timestamp: 4102, level: 'warn', message: 'Retrying' },
    { timestamp: 7000, level: 'info', message: 'Saved order 42' },
  ] as unknown as LogEntry[]);
  const merged = mergeActivity(recorded, diagnostics);
  assert.deepEqual(merged.map((item) => [item.timestamp, item.kind]), [
    [1000, 'console'], [1002, 'log'], [2000, 'console'], [2002, 'error'], [3000, 'console'], [4000, 'console'], [4100, 'console'], [4102, 'log'],
    [5000, 'click'], [7000, 'log'], [9000, 'error'],
  ]);
  assert.deepEqual(mergeActivity(recorded, []), recorded);
});

test('marks errors, failed requests and triggers, thinned and capped', async () => {
  const { ACTIVITY_LIMITS, MARK_COLORS, timelineMarks } = await viewer;
  const items: Activity[] = [
    { kind: 'console', timestamp: 0, title: 'start', severity: 'info' },
    { kind: 'console', timestamp: 10_000, title: 'Failed to save', severity: 'error', level: 'error' },
    { kind: 'console', timestamp: 20_000, title: 'Uncaught TypeError: x', severity: 'error', level: 'error', uncaught: true },
    { kind: 'error', timestamp: 30_000, title: 'RangeError: deep', severity: 'error' },
    { kind: 'log', timestamp: 40_000, title: 'Write failed', severity: 'error' },
    { kind: 'log', timestamp: 45_000, title: 'Slow', severity: 'warn' },
    { kind: 'network', timestamp: 50_000, title: 'GET /api', status: 500, severity: 'error' },
    { kind: 'network', timestamp: 60_000, title: 'GET /slow', status: 0, failed: 'abort', severity: 'error' },
    { kind: 'network', timestamp: 65_000, title: 'GET /ok', status: 200, severity: 'info' },
    { kind: 'trigger', timestamp: 70_000, title: 'Recording triggered (error)', severity: 'info' },
    { kind: 'console', timestamp: 100_000, title: 'end', severity: 'info' },
  ];
  assert.deepEqual(timelineMarks(items), [
    { timestamp: 10_000, tag: 'Console error: Failed to save', color: MARK_COLORS.error },
    { timestamp: 20_000, tag: 'Uncaught TypeError: x', color: MARK_COLORS.error },
    { timestamp: 30_000, tag: 'RangeError: deep', color: MARK_COLORS.error },
    { timestamp: 40_000, tag: 'Error log: Write failed', color: MARK_COLORS.error },
    { timestamp: 50_000, tag: 'Request failed: GET /api (500)', color: MARK_COLORS.request },
    { timestamp: 60_000, tag: 'Request failed: GET /slow (cancelled)', color: MARK_COLORS.request },
    { timestamp: 70_000, tag: 'Recording triggered (error)', color: MARK_COLORS.trigger },
  ]);

  // Close marks share one spot, named after the most important of them.
  const burst: Activity[] = [
    { kind: 'network', timestamp: 0, title: 'GET /a', status: 503, severity: 'error' },
    ...Array.from({ length: 50 }, (_, index): Activity => ({ kind: 'console', timestamp: 300 + index * 10, title: `e${index}`, severity: 'error', level: 'error' })),
    { kind: 'console', timestamp: 100_000, title: 'end', severity: 'info' },
  ];
  assert.deepEqual(timelineMarks(burst), [{ timestamp: 300, tag: 'Console error: e0 (+50 more)', color: MARK_COLORS.error }]);

  // Far more spots than allowed: errors are kept before failed requests, and the result stays in time order.
  const crowded: Activity[] = Array.from({ length: 170 }, (_, index): Activity => index % 10 === 3
    ? { kind: 'error', timestamp: index * 10_000, title: `Error ${index}`, severity: 'error' }
    : { kind: 'network', timestamp: index * 10_000, title: `GET /${index}`, status: 500, severity: 'error' });
  const capped = timelineMarks(crowded, { duration: 900_000 });
  assert.equal(capped.length, ACTIVITY_LIMITS.marks);
  assert.equal(capped.filter((mark) => mark.color === MARK_COLORS.error).length, 17);
  assert.ok(capped.every((mark, index) => !index || mark.timestamp > capped[index - 1].timestamp));

  // Spacing follows the player's timeline, and marks already drawn keep their spots.
  const squeezed = timelineMarks([
    { kind: 'error', timestamp: 1_000_000, title: 'A', severity: 'error' },
    { kind: 'error', timestamp: 1_060_000, title: 'B', severity: 'error' },
  ], { position: (timestamp) => timestamp === 1_000_000 ? 5000 : 5050, duration: 10_000 });
  assert.deepEqual(squeezed.map((mark) => mark.tag), ['A (+1 more)']);
  const existing: TimelineMark[] = [{ timestamp: 10_000, tag: 'Console error: Failed to save', color: MARK_COLORS.error }];
  const later = timelineMarks([...items, { kind: 'error', timestamp: 10_500, title: 'Close by', severity: 'error' }], { existing });
  assert.equal(later.length, 6);
  assert.ok(!later.some((mark) => mark.timestamp === 10_000 || mark.timestamp === 10_500));
  const full = Array.from({ length: ACTIVITY_LIMITS.marks }, (_, index): TimelineMark => ({ timestamp: index, tag: `${index}`, color: MARK_COLORS.error }));
  assert.deepEqual(timelineMarks(items, { existing: full }), []);
  assert.deepEqual(timelineMarks([]), []);
});

test('finds the same replay offset as replayOffset, in logarithmic time', async () => {
  const { createReplayOffset } = await viewer;
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const at = (timestamp: number): ReplayEvent => ({ type: 3, timestamp, data: {} });
  const recordings = [
    [at(1_000_000), at(1_004_000), at(3_404_000), at(3_405_000)],
    [at(50_000), at(50_000), at(51_000), at(20_000), at(21_000), at(80_000), at(80_000), at(81_000)],
    Array.from({ length: 3000 }, (_, index) => index).reduce<ReplayEvent[]>((events) => {
      const previous = events.length ? events[events.length - 1].timestamp : 1_700_000_000_000;
      const roll = random();
      // Mostly small steps, some long quiet stretches, and now and then a clock set back.
      const step = roll < 0.05 ? -Math.round(random() * 600_000) : roll < 0.1 ? Math.round(random() * 3_600_000) : Math.round(random() * 2000);
      events.push(at(previous + step));
      return events;
    }, []),
  ];
  for (const original of recordings) {
    const shortened = shortenIdle(original).events;
    const offset = createReplayOffset(original, shortened);
    const low = Math.min(...original.map((event) => event.timestamp)), high = Math.max(...original.map((event) => event.timestamp));
    const probes = [Number.NaN, Number.POSITIVE_INFINITY, low - 1, high + 1, ...original.flatMap((event) => [event.timestamp - 1, event.timestamp, event.timestamp + 0.5])];
    for (let index = 0; index < 3000; index++) probes.push(low + random() * (high - low));
    for (const probe of probes) assert.equal(offset(probe), replayOffset(original, shortened, probe), `at ${probe}`);
  }
  assert.equal(createReplayOffset([], [])(5), 0);
  assert.equal(createReplayOffset([at(1)], [])(5), 0);
});

test('leaves recorded activity events out of the player and formats elapsed time', async () => {
  const { clockText, withoutActivity } = await viewer;
  const events: ReplayEvent[] = [
    meta(0, 'https://app.test/'), custom(1, 'pbr/network', {}), custom(2, 'pbr/console', {}), custom(3, 'pbr/trigger'),
    custom(4, 'Nothing recorded for 2 min', {}), click(5, 1), custom(6, 'pbr/navigation', {}),
  ];
  assert.deepEqual(withoutActivity(events).map((event) => event.timestamp), [0, 4, 5]);
  assert.deepEqual([0, 999, 61_000, 600_000, 3_723_000, -3_000].map(clockText), ['0:00', '0:00', '1:01', '10:00', '1:02:03', '-0:03']);
});

// Just enough of the DOM for the panel: elements, attributes, events that bubble, and list layout.
class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  className = ''; textContent = ''; hidden = false; tabIndex = 0; title = ''; type = '';
  scrollTop = 0; clientHeight = 100; offsetHeight = 20;
  dataset: Record<string, string> = {};
  readonly classList = { add: (name: string) => { if (!this.classes().includes(name)) this.className = `${this.className} ${name}`.trim(); } };
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}
  classes(): string[] { return this.className.split(' ').filter(Boolean); }
  // Rows are 20px tall, one per list item.
  get offsetTop(): number { const item = this.parent, list = item?.parent; return item && list ? list.children.indexOf(item) * 20 : 0; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...nodes: FakeNode[]) {
    for (const node of nodes) {
      for (const child of node.tagName === '#fragment' ? node.children.splice(0) : [node]) { child.parent = this; this.children.push(child); }
    }
  }
  replaceChildren(...nodes: FakeNode[]) { this.children = []; this.append(...nodes); }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string, extra: Record<string, unknown> = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...extra };
    for (let node: FakeNode | undefined = this; node; node = node.parent) for (const listener of node.listeners.get(type) ?? []) listener(event);
    return event;
  }
  closest(selector: string): FakeNode | null {
    for (let node: FakeNode | undefined = this; node; node = node.parent) if (node.classes().includes(selector.slice(1))) return node;
    return null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  find(className: string): FakeNode[] {
    return [...(this.classes().includes(className) ? [this] : []), ...this.children.flatMap((child) => child.find(className))];
  }
  part(className: string): string { return this.find(className)[0]?.textContent ?? ''; }
}
class FakeDocument {
  activeElement?: FakeNode;
  createElement(tag: string) { return new FakeNode(tag.toUpperCase(), this); }
  createDocumentFragment() { return new FakeNode('#fragment', this); }
}

async function panelFixture() {
  const { createDevtoolsPanel } = await viewer;
  const doc = new FakeDocument();
  const container = doc.createElement('section');
  container.setAttribute('aria-label', 'Session activity');
  const seeks: number[] = [];
  const panel = createDevtoolsPanel(container as unknown as HTMLElement, { seek: (timestamp) => seeks.push(timestamp) });
  const rows = () => container.find('devtools-row');
  const filter = (label: string) => container.find('devtools-filter').find((button) => button.children[0].textContent === label)!;
  return { panel, container, doc, seeks, rows, filter };
}

const sample: Activity[] = [
  { kind: 'navigation', timestamp: 1000, title: '/home', severity: 'info' },
  { kind: 'network', timestamp: 2000, title: 'GET /api/items', detail: '200 · 35 ms', severity: 'info', status: 200, duration: 35 },
  { kind: 'click', timestamp: 3000, title: 'button#save "Save"', severity: 'info' },
  { kind: 'console', timestamp: 4000, title: 'Failed to save', detail: 'Error', severity: 'error', level: 'error' },
  { kind: 'network', timestamp: 5000, title: 'POST /api/save', detail: '500 · 80 ms', severity: 'error', status: 500, duration: 80 },
  { kind: 'log', timestamp: 6000, title: 'Saved', detail: 'Info log', severity: 'info', level: 'info' },
  { kind: 'error', timestamp: 70_000, title: 'TypeError: boom', detail: 'Unhandled error', severity: 'error', level: 'error' },
];

test('the panel lists activity with filters, counts and rows that seek', async () => {
  const { panel, container, seeks, rows, filter } = await panelFixture();
  assert.equal(container.hidden, true);
  panel.show([...sample].reverse(), 1000, (timestamp) => timestamp - 1000);
  assert.equal(container.hidden, false);
  assert.deepEqual(container.find('devtools-filter').map((button) => [button.children[0].textContent, button.part('devtools-count'), button.getAttribute('aria-pressed')]), [
    ['All', '7', 'true'], ['PocketBase', '0', 'false'], ['Network', '2', 'false'], ['Console', '2', 'false'], ['Clicks', '1', 'false'], ['Pages', '1', 'false'],
    ['Errors', '3', 'false'],
  ]);
  assert.equal(container.find('devtools-filters')[0].getAttribute('role'), 'group');
  assert.deepEqual(rows().map((row) => [row.part('devtools-time'), row.part('devtools-kind'), row.part('devtools-title'), row.part('devtools-detail')]), [
    ['0:00', 'Page', '/home', ''], ['0:01', 'Network', 'GET /api/items', '200 · 35 ms'], ['0:02', 'Click', 'button#save "Save"', ''],
    ['0:03', 'Console', 'Failed to save', 'Error'], ['0:04', 'Network', 'POST /api/save', '500 · 80 ms'], ['0:05', 'Log', 'Saved', 'Info log'],
    ['1:09', 'Error', 'TypeError: boom', 'Unhandled error'],
  ]);
  assert.ok(rows().every((row) => row.tagName === 'BUTTON' && row.type === 'button'));
  assert.deepEqual(rows().map((row) => row.tabIndex), [0, -1, -1, -1, -1, -1, -1]);
  rows()[2].find('devtools-title')[0].dispatch('click');
  assert.deepEqual(seeks, [3000]);
  assert.equal(rows()[2].getAttribute('aria-current'), 'true');
  assert.deepEqual(rows().map((row) => row.tabIndex), [-1, -1, 0, -1, -1, -1, -1]);

  filter('Errors').dispatch('click');
  assert.equal(filter('Errors').getAttribute('aria-pressed'), 'true');
  assert.equal(filter('All').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(rows().map((row) => row.part('devtools-title')), ['Failed to save', 'POST /api/save', 'TypeError: boom']);
  assert.ok(rows().every((row) => row.dataset.severity === 'error'));
  filter('Clicks').dispatch('click');
  assert.deepEqual(rows().map((row) => row.part('devtools-title')), ['button#save "Save"']);
  // Diagnostics arriving later keep the chosen filter.
  panel.show([...sample, { kind: 'click', timestamp: 8000, title: 'a "More"', severity: 'info' }], 1000);
  assert.deepEqual(rows().map((row) => row.part('devtools-title')), ['button#save "Save"', 'a "More"']);
  assert.equal(filter('Clicks').part('devtools-count'), '2');
  panel.show(sample.filter((item) => item.kind !== 'click'), 1000);
  assert.equal(rows().length, 0);
  assert.equal(container.find('devtools-list')[0].hidden, true);
  assert.equal(container.part('devtools-empty'), 'No clicks recorded');
  panel.clear();
  assert.equal(container.hidden, true);
  assert.equal(rows().length, 0);
  assert.equal(filter('All').getAttribute('aria-pressed'), 'true');
  assert.equal(filter('All').part('devtools-count'), '');
});

test('the panel marks the row for the playback moment and follows it unless the list was just used', async () => {
  const { panel, container, rows } = await panelFixture();
  const list = container.find('devtools-list')[0];
  const many: Activity[] = Array.from({ length: 30 }, (_, index) => ({ kind: 'click', timestamp: 1000 + index * 1000, title: `Row ${index}`, severity: 'info' }));
  let now = 1_000_000;
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true, writable: true });
  try {
    panel.show(many, 1000);
    const current = () => rows().findIndex((row) => row.getAttribute('aria-current') === 'true');
    panel.setTime(500);
    assert.equal(current(), -1);
    panel.setTime(1000);
    assert.equal(current(), 0);
    panel.setTime(4500);
    assert.equal(current(), 3);
    // Rows still in view need no scrolling; five 20px rows fit the 100px list.
    assert.equal(list.scrollTop, 0);
    // A seek lands within rounding of a row's time.
    panel.setTime(5999.999);
    assert.equal(current(), 5);
    assert.ok(list.scrollTop > 0 && list.scrollTop <= 100, `scrollTop ${list.scrollTop}`);
    panel.setTime(21_000);
    assert.equal(current(), 20);
    assert.ok(list.scrollTop > 300 && list.scrollTop <= 20 * 20, `scrollTop ${list.scrollTop}`);
    const followed = list.scrollTop;
    list.dispatch('wheel');
    panel.setTime(29_000);
    assert.equal(current(), 28);
    assert.equal(list.scrollTop, followed);
    now += 5000;
    panel.setTime(29_500);
    assert.equal(current(), 28);
    panel.setTime(30_000);
    assert.equal(current(), 29);
    assert.ok(list.scrollTop > followed);
    panel.setTime(Number.NaN);
    assert.equal(current(), 29);
  } finally {
    delete (performance as unknown as Record<string, unknown>).now;
  }
});

test('the panel moves through rows with the keyboard and windows very long lists', async () => {
  const { ACTIVITY_LIMITS } = await viewer;
  const { panel, container, doc, rows, seeks } = await panelFixture();
  const many: Activity[] = Array.from({ length: 5000 }, (_, index) => ({ kind: 'network', timestamp: index * 100, title: `GET /${index}`, severity: 'info', status: 200 }));
  panel.show(many, 0);
  assert.equal(rows().length, ACTIVITY_LIMITS.rows);
  // Counts use the locale's digit grouping.
  assert.match(container.part('devtools-note'), /^Showing 2\D?000 of 5\D?000 rows/);
  assert.equal(container.find('devtools-note')[0].hidden, false);
  const key = (row: FakeNode, name: string) => row.dispatch('keydown', { key: name });
  key(rows()[0], 'ArrowDown');
  assert.equal(doc.activeElement, rows()[1]);
  assert.deepEqual([rows()[0].tabIndex, rows()[1].tabIndex], [-1, 0]);
  assert.equal(key(rows()[1], 'End').defaultPrevented, true);
  assert.equal(doc.activeElement?.part('devtools-title'), 'GET /4999');
  assert.equal(rows().at(-1)!.part('devtools-title'), 'GET /4999');
  key(doc.activeElement!, 'Home');
  assert.equal(doc.activeElement?.part('devtools-title'), 'GET /0');
  assert.equal(key(doc.activeElement!, 'a').defaultPrevented, false);
  // Playback far ahead moves the window once the list has not been used for a while.
  const realNow = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { value: () => realNow() + 60_000, configurable: true, writable: true });
  try {
    panel.setTime(450_000);
    const current = rows().find((row) => row.getAttribute('aria-current') === 'true');
    assert.equal(current?.part('devtools-title'), 'GET /4500');
    current!.dispatch('click');
    assert.deepEqual(seeks, [450_000]);
  } finally {
    delete (performance as unknown as Record<string, unknown>).now;
  }
});

test('the panel says when stored entries were left out, and forgets it on the next recording', async () => {
  const { panel, container } = await panelFixture();
  const note = () => container.find('devtools-note')[0];
  panel.show(sample, 1000);
  assert.equal(note().hidden, true);
  panel.show(sample, 1000, undefined, 'Showing the newest 1,000 of 1,201 stored logs. Use Issues or Logs for this session to see them all');
  assert.equal(note().hidden, false);
  assert.match(note().textContent, /1,000 of 1,201 stored logs/);
  panel.clear();
  panel.show(sample, 1000);
  assert.equal(note().hidden, true);
  assert.equal(note().textContent, '');
});

// Answers the list routes like the server: newest first, 50 a page.
function storedLogs(total: number, failAt = 0) {
  const asked: string[] = [];
  const request = async (path: string) => {
    asked.push(path);
    const page = Number(new URL(path, 'https://replay.test').searchParams.get('page'));
    if (page === failAt) throw new Error('Request failed (502)');
    const items = Array.from({ length: Math.max(0, Math.min(50, total - (page - 1) * 50)) }, (_, index) => ({ id: `log-${(page - 1) * 50 + index}` }));
    return { items, page, perPage: 50, totalItems: total, totalPages: Math.ceil(total / 50) };
  };
  return { request, asked };
}

test('stored diagnostics load past 200 entries, and a busy session names what it left out', async () => {
  const { loadDiagnostics, diagnosticsNotice, DIAGNOSTIC_PAGES } = await viewer;
  const none = { items: [], total: 0 };
  const some = storedLogs(201);
  const all = await loadDiagnostics(some.request, '/api/replay/logs', 'session00000001');
  assert.deepEqual([all.items.length, all.total, some.asked.length], [201, 201, 5]);
  assert.equal(some.asked[0], '/api/replay/logs?sessionId=session00000001&page=1');
  assert.equal(diagnosticsNotice(none, all), '');
  const busy = await loadDiagnostics(storedLogs(1201).request, '/api/replay/logs', 'session00000001');
  assert.deepEqual([busy.items.length, busy.total], [DIAGNOSTIC_PAGES * 50, 1201]);
  assert.equal(diagnosticsNotice(none, busy), 'Showing the newest 1,000 of 1,201 stored logs. Use Issues or Logs for this session to see them all');
  const failing = await loadDiagnostics(storedLogs(300, 3).request, '/api/replay/errors', 'session00000001');
  assert.deepEqual([failing.items.length, failing.total], [100, 300]);
  assert.equal(diagnosticsNotice(failing, busy), 'Showing the newest 100 of 300 stored errors and 1,000 of 1,201 stored logs. Use Issues or Logs for this session to see them all');
  let open = true;
  const switching = storedLogs(500);
  const stale = await loadDiagnostics(async (path) => { const result = await switching.request(path); open = false; return result; }, '/api/replay/logs', 'session00000001', () => open);
  assert.deepEqual([stale.items.length, switching.asked.length], [0, 1]);
});
