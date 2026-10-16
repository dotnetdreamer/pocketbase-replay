import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import { test } from 'node:test';
import type { ReplayEvent } from '../viewer/decode';

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
// The server's reading of recordings, as PocketBase runs it, must name everything as the dashboard does.
const server = createRequire(import.meta.url)('../server/pb_hooks/lib/activity-core.js') as {
  collect(events: ReplayEvent[]): Record<string, unknown>[];
  createCollector(saved?: unknown): { add(event: ReplayEvent): void; take(): Record<string, unknown>[]; save(): unknown; gap(): void };
};

const meta = (timestamp: number, href: string): ReplayEvent => ({ type: 4, timestamp, data: { href, width: 390, height: 844 } });
const snapshot = (timestamp: number, node: unknown): ReplayEvent => ({ type: 2, timestamp, data: { node, initialOffset: { top: 0, left: 0 } } });
const click = (timestamp: number, id: number, type = 2): ReplayEvent => ({ type: 3, timestamp, data: { source: 2, type, id, x: 4, y: 4 } });
const input = (timestamp: number, id: number, extra: Record<string, unknown> = {}): ReplayEvent => ({ type: 3, timestamp, data: { source: 5, id, text: '***', isChecked: false, ...extra } });
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
      element(61, 'input', { type: 'email', placeholder: 'Email address', id: 'email' }),
      element(62, 'input', { type: 'checkbox', 'aria-label': 'Accept terms', name: 'terms' }),
      element(63, 'select', { name: 'country' }),
    ]),
  ]),
] };

function recording(): ReplayEvent[] {
  return [
    meta(1000, 'https://app.test/home'), snapshot(1000, page),
    click(1100, 10), click(1200, 12), click(1300, 14), click(1400, 20), click(1500, 30), click(1600, 40), click(1700, 60), click(1800, 999),
    click(1900, 20, 4),
    input(1950, 61), input(1960, 61), input(1970, 62, { isChecked: true }), input(1980, 63),
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
    custom(2710, 'pbr/network', { kind: 'fetch', method: 'post', url: 'https://app.test/api/items', status: 201, duration: 35 }),
    custom(2720, 'pbr/network', { kind: 'xhr', method: 'GET', url: 'https://api.other.test/v1/users', status: 404, duration: 1234 }),
    custom(2730, 'pbr/network', { kind: 'fetch', method: 'GET', url: 'https://app.test/slow', status: 0, duration: 30000, failed: 'timeout' }),
    custom(2740, 'pbr/network', { url: 42 }),
    custom(2750, 'pbr/console', { level: 'warn', text: 'Low disk' }),
    custom(2760, 'pbr/console', { level: 'error', text: 'Uncaught TypeError: x is not a function', uncaught: true }),
    custom(2770, 'pbr/console', { level: 'toString', text: 5 }),
    custom(2780, 'pbr/pocketbase', {
      request: 'abcdefghij0123456789', method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', status: 400,
      duration: 120, server: true, linked: true, message: 'Failed to create record.', invalid: [{ field: 'total', code: 'validation_required' }, { field: 7 }],
      query: { filter: true, sort: '-created', expand: 'drop me; DROP', fields: 'id,total' },
    }),
    custom(2790, 'pbr/pocketbase', { request: 'zzzzzzzzzz0123456789', method: 'GET', path: '/api/collections/orders/records', collection: 'orders', action: 'list', status: 200, items: 0, total: 0, server: true }),
    custom(2795, 'pbr/pocketbase', { request: 'yyyyyyyyyy0123456789', method: 'POST', path: '/api/batch', action: 'batch', status: 200, batch: [{ method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', status: 200 }, 'x'] }),
    custom(2796, 'pbr/pocketbase', { method: 'POST', path: '/api/realtime', action: 'realtime', status: 204, topics: ['orders', 'bad topic'], failed: 'abort', message: 'custom text' }),
    custom(2800, 'pbr/navigation', { url: 'https://app.test/orders' }),
    meta(2900, 'https://app.test/orders'),
    // A new full snapshot replaces the whole page.
    snapshot(3000, { type: 0, id: 1, childNodes: [element(10, 'div', { class: 'fresh' }, [textNode(11, 'Rebuilt')])] }),
    click(3100, 10), click(3200, 20),
    custom(3300, 'pbr/navigation', { url: 'https://other.test/x' }),
    custom(3400, 'pbr/trigger', { reason: 'error' }),
    custom(3500, 'pbr/trigger'),
    custom(3600, 'other/tag', { text: 'ignored' }),
    { type: 3, timestamp: 3700, data: null },
    null as unknown as ReplayEvent,
    { type: 5, timestamp: Number.NaN, data: { tag: 'pbr/console', payload: { text: 'no time' } } },
  ];
}

const withoutInputs = (items: Record<string, unknown>[]) => items.filter((item) => item.kind !== 'input');

test('the server reads a recording exactly as the dashboard activity panel does', async () => {
  const { collectActivity } = await viewer;
  const events = recording();
  assert.deepEqual(withoutInputs(server.collect(events)), JSON.parse(JSON.stringify(collectActivity(events))));
});

test('form fields are named by what the page shows next to them, and typing is one entry', () => {
  const inputs = server.collect(recording()).filter((item) => item.kind === 'input');
  assert.deepEqual(inputs, [
    { kind: 'input', timestamp: 1950, title: 'input#email[type=email] "Email address"', detail: 'Changed', severity: 'info' },
    { kind: 'input', timestamp: 1970, title: 'input[type=checkbox] "Accept terms"', detail: 'Changed', severity: 'info' },
    { kind: 'input', timestamp: 1980, title: 'select "country"', detail: 'Option selected', severity: 'info' },
  ]);
  // The masked value never reaches an entry, nor whether a box was checked.
  assert.ok(!JSON.stringify(inputs).includes('***'));
  assert.ok(!/Checked|Unchecked/.test(JSON.stringify(inputs)));
});

test('a recording read in parts, its state saved between them, reads the same as in one go', () => {
  const events = recording();
  const whole = server.collect(events);
  for (let split = 1; split < events.length; split++) {
    const first = server.createCollector();
    for (const event of events.slice(0, split)) first.add(event);
    const items = first.take();
    // The state crosses runs as stored JSON.
    const second = server.createCollector(JSON.parse(JSON.stringify(first.save())));
    for (const event of events.slice(split)) second.add(event);
    const joined = items.concat(second.take());
    // Typing split across two parts is two entries; everything else is the same.
    assert.deepEqual(withoutInputs(joined), withoutInputs(whole), `split at event ${split}`);
  }
});

test('after a missing part, clicks stay unnamed until the next full snapshot', () => {
  const collector = server.createCollector();
  for (const event of [meta(1000, 'https://app.test/'), snapshot(1000, page), click(1100, 10)]) collector.add(event);
  collector.gap();
  for (const event of [click(1200, 10), snapshot(1300, page), click(1400, 10)]) collector.add(event);
  assert.deepEqual(collector.take().filter((item) => item.kind === 'click').map((item) => item.title),
    ['button#save "Save changes"', 'Unknown element', 'button#save "Save changes"']);
});

test('reading half a million events stays fast and its saved state stays small', async () => {
  const { collectActivity } = await viewer;
  const rows = 2000;
  const list = element(2, 'ul', {}, Array.from({ length: rows }, (_, index) => element(1000 + index * 2, 'li', {}, [textNode(1001 + index * 2, `Row ${index}`)])));
  const events: ReplayEvent[] = [meta(0, 'https://app.test/'), snapshot(0, { type: 0, id: 1, childNodes: [list] })];
  let oldest = 0, newest = rows - 1;
  while (events.length < 500_000) {
    const timestamp = events.length;
    if (events.length % 4) {
      events.push(mutation(timestamp, { texts: [{ id: 1001 + newest * 2, value: `Row ${newest} at ${timestamp}` }] }));
    } else {
      newest++;
      events.push(mutation(timestamp, {
        removes: [{ parentId: 2, id: 1000 + oldest++ * 2 }],
        adds: [{ parentId: 2, nextId: null, node: element(1000 + newest * 2, 'li') }, { parentId: 1000 + newest * 2, nextId: null, node: textNode(1001 + newest * 2, `Row ${newest}`) }],
      }));
    }
    if (events.length % 5000 === 0) events.push(click(events.length, 1000 + newest * 2));
  }
  const started = performance.now();
  const collector = server.createCollector();
  for (const event of events) collector.add(event);
  const items = collector.take();
  assert.ok(performance.now() - started < 5000);
  assert.deepEqual(items, JSON.parse(JSON.stringify(collectActivity(events))));
  // Only the rows on the page are carried over: about 2,000 elements and their text.
  assert.ok(JSON.stringify(collector.save()).length < 200_000);
});
