import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { test } from 'node:test';
import type { ReplayEvent } from '../viewer/decode';
import type { Activity } from '../viewer/devtools';

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

const id = (n: number) => `req${String(n).padStart(17, '0')}`;
const call = (timestamp: number, payload: unknown): ReplayEvent => ({ type: 5, timestamp, data: { tag: 'pbr/pocketbase', payload } });
const calls = [
  call(1000, { request: id(1), method: 'GET', path: '/api/collections/posts/records', collection: 'posts', action: 'list', status: 200, duration: 85,
    linked: true, server: true, items: 0, total: 0, page: 1, perPage: 30, query: { filter: true, sort: '-created' } }),
  call(2000, { request: id(2), method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', status: 400, duration: 120,
    linked: true, server: true, message: 'Failed to create record.', invalid: [{ field: 'total', code: 'validation_required', message: 'Cannot be blank.' }] }),
  call(3000, { request: id(3), method: 'PATCH', path: '/api/collections/orders/records/o1', collection: 'orders', action: 'update', record: 'o1',
    status: 0, failed: 'abort', duration: 3, server: true }),
  call(4000, { request: id(4), method: 'POST', path: '/api/batch', action: 'batch', status: 200, duration: 40, batch: [
    { method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', status: 200 },
    { method: 'DELETE', path: '/api/collections/orders/records/o2', collection: 'orders', action: 'delete', record: 'o2', status: 404 },
  ] }),
  call(5000, { request: id(5), method: 'GET', path: '/api/collections/orders/records/o3', collection: 'orders', action: 'view', record: 'o3',
    status: 404, duration: 2400, linked: true, server: true, message: "The requested resource wasn't found." }),
  call(6000, { request: id(6), method: 'GET', path: '/api/health', status: 0, failed: 'error', duration: 10000, linked: true, server: true }),
  call(7000, { request: id(7), method: 'DELETE', path: '/api/collections/orders/records/o4', collection: 'orders', action: 'delete', record: 'o4', status: 403,
    duration: 9, message: 'Only superusers can perform this action.' }),
];

test('PocketBase calls become activity named by collection and action, with outcome, counts and refused fields', async () => {
  const { collectActivity } = await viewer;
  const items = collectActivity([...calls,
    call(8000, { request: 'not an id', method: 'get<script>', path: 42, collection: 'bad name', action: 'drop', status: -1,
      query: { sort: 'title="secret"', filter: 'yes' }, invalid: [{ field: 1 }, { field: 'ok', code: 'c' }], topics: ['orders', 'bad name'] }),
    call(9000, 'not an object'),
  ]);
  assert.deepEqual(items.map((item) => [item.kind, item.title, item.detail, item.severity]), [
    ['pocketbase', 'posts.list', '200 · 0 of 0 items · 85 ms', 'info'],
    ['pocketbase', 'orders.create', '400 · Invalid: total · 120 ms', 'error'],
    ['pocketbase', 'orders.update o1', 'Cancelled · 3 ms', 'warn'],
    ['pocketbase', 'Batch', '200 · 2 requests · 40 ms', 'info'],
    ['pocketbase', 'orders.view o3', '404 · 2.4 s', 'error'],
    ['pocketbase', 'GET /api/health', 'Failed · 10 s', 'error'],
    ['pocketbase', 'orders.delete o4', '403 · 9 ms', 'error'],
    ['pocketbase', 'GETSCRIPT /', 'No response · orders · Invalid: ok', 'error'],
    ['pocketbase', 'GET /', 'No response', 'error'],
  ]);
  assert.deepEqual(items[1].pocketbase, {
    method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', request: id(2), status: 400, duration: 120,
    linked: true, server: true, message: 'Failed to create record.', invalid: [{ field: 'total', code: 'validation_required' }],
  });
  assert.deepEqual(items[0].pocketbase!.query, { filter: true, sort: '-created' });
  assert.equal(items[7].pocketbase!.request, '');
  assert.deepEqual(items[7].pocketbase!.query, {});
  assert.deepEqual(items[3].pocketbase!.batch!.map((part) => [part.action, part.record, part.status]), [['create', undefined, 200], ['delete', 'o2', 404]]);
});

test('only calls the replay server can explain are asked about: failed, empty or slow, and sent to that server', async () => {
  const { collectActivity, explainable } = await viewer;
  const items = collectActivity(calls);
  assert.deepEqual(explainable(items), [
    { request: id(1), method: 'GET', path: '/api/collections/posts/records', status: 200, items: 0 },
    { request: id(2), method: 'POST', path: '/api/collections/orders/records', status: 400, message: 'Failed to create record.', fields: 1 },
    { request: id(5), method: 'GET', path: '/api/collections/orders/records/o3', status: 404, message: "The requested resource wasn't found.", fields: 0 },
    { request: id(6), method: 'GET', path: '/api/health', status: 0 },
  ]);
  assert.equal(explainable(items, 2).length, 2);
});

test('explanations arrive in place: pending while asked, then found with a short verdict, or nothing, or a failure', async () => {
  const { collectActivity, loadExplanations } = await viewer;
  const items = collectActivity(calls);
  const bodies: unknown[] = [];
  let answer: (value: unknown) => void = () => {};
  const loading = loadExplanations(async (path, body) => {
    assert.equal(path, '/api/replay/requests');
    bodies.push(body);
    return new Promise((resolve) => { answer = resolve; });
  }, 'session00000001', items);
  assert.deepEqual(items.map((item) => item.explanation?.state), ['pending', 'pending', undefined, undefined, 'pending', 'pending', undefined]);
  answer({ logs: true, items: [
    { request: id(1), rule: { name: 'listRule', expression: '@request.auth.id != ""' }, verdict: 'filtered' },
    { request: id(2), server: { status: 400, ms: 1.8, auth: '', error: 'Failed to create record.', details: 'create rule failure: sql: no rows in result set' },
      rule: { name: 'createRule', expression: '@request.auth.id != ""' }, verdict: 'rule' },
    { request: id(5), server: { status: 404, ms: 0.3, auth: 'users' }, rule: { name: 'viewRule', expression: 'owner = @request.auth.id' }, verdict: 'rule', record: 'exists',
      issue: { id: 'issue000000001', title: 'TypeError: boom' } },
    { request: id(6) },
    { request: 'unasked0000000000000', verdict: 'hook' },
  ] });
  await loading;
  assert.deepEqual(bodies, [{ sessionId: 'session00000001', requests: [
    { request: id(1), method: 'GET', path: '/api/collections/posts/records', status: 200, items: 0 },
    { request: id(2), method: 'POST', path: '/api/collections/orders/records', status: 400, message: 'Failed to create record.', fields: 1 },
    { request: id(5), method: 'GET', path: '/api/collections/orders/records/o3', status: 404, message: "The requested resource wasn't found.", fields: 0 },
    { request: id(6), method: 'GET', path: '/api/health', status: 0 },
  ] }]);
  assert.deepEqual(items.map((item) => item.explanation?.state), ['found', 'found', undefined, undefined, 'found', 'none', undefined]);
  assert.deepEqual(items.map((item) => item.detail), ['200 · 0 of 0 items · 85 ms · listRule may hide rows', '400 · Invalid: total · 120 ms · Blocked by createRule',
    'Cancelled · 3 ms', '200 · 2 requests · 40 ms', '404 · 2.4 s · Blocked by viewRule', 'Failed · 10 s', '403 · 9 ms']);
  const found = items[4].explanation;
  assert.ok(found?.state === 'found');
  assert.deepEqual(found.value, { request: id(5), server: { status: 404, ms: 0.3, auth: 'users' },
    rule: { name: 'viewRule', expression: 'owner = @request.auth.id' }, verdict: 'rule', record: 'exists', issue: { id: 'issue000000001', title: 'TypeError: boom' } });

  // A server without the route, or a dashboard that moved on, leaves the calls as the app saw them.
  const failing = collectActivity(calls);
  await loadExplanations(async () => { throw new Error('Not found'); }, 'session00000001', failing);
  assert.deepEqual(failing.filter((item) => item.explanation).map((item) => item.explanation!.state), ['failed', 'failed', 'failed', 'failed']);
  const unreadable = collectActivity(calls);
  await loadExplanations(async () => ({ logs: false, items: [] }), 'session00000001', unreadable);
  assert.deepEqual(unreadable.find((item) => item.explanation)!.explanation, { state: 'none', logs: false });
  const stale = collectActivity(calls);
  await loadExplanations(async () => ({ logs: true, items: [{ request: id(2), verdict: 'rule' }] }), 'session00000001', stale, () => false);
  assert.equal(stale[1].explanation?.state, 'pending');
  assert.equal(stale[1].detail, '400 · Invalid: total · 120 ms');
  let asked = false;
  await loadExplanations(async () => { asked = true; return {}; }, 'session00000001', collectActivity([calls[2], calls[3]]));
  assert.equal(asked, false);
});

test('all qualifying calls are explained sequentially in batches of at most 200', async () => {
  const { collectActivity, loadExplanations } = await viewer;
  const items = collectActivity(Array.from({ length: 475 }, (_, index) => call(index + 1000, {
    request: id(index + 1), method: 'GET', path: '/api/collections/posts/records/missing', status: 404, server: true,
  })));
  const sizes: number[] = [];
  const asked: string[] = [];
  let active = 0;
  await loadExplanations(async (_path, body) => {
    assert.equal(active++, 0, 'the next batch waits for the current request');
    const payload = body as { requests: { request: string }[] };
    sizes.push(payload.requests.length);
    asked.push(...payload.requests.map((request) => request.request));
    await new Promise((resolve) => setTimeout(resolve, 0));
    active--;
    return { logs: true, items: payload.requests.map(({ request }) => ({ request, server: { status: 404 } })) };
  }, 'session00000001', items);
  assert.deepEqual(sizes, [200, 200, 75]);
  assert.deepEqual(asked, Array.from({ length: 475 }, (_, index) => id(index + 1)));
  assert.ok(items.every((item) => item.explanation?.state === 'found'));
});

test('explanation request bodies respect the UTF-8 byte budget with multibyte paths', async () => {
  const { collectActivity, loadExplanations } = await viewer;
  const items = collectActivity(Array.from({ length: 235 }, (_, index) => call(index + 1000, {
    request: id(index + 1), method: 'GET', path: `/api/custom/${'密'.repeat(285)}`, status: 404, server: true,
  })));
  const batches: number[] = [];
  let count = 0;
  await loadExplanations(async (_path, body) => {
    const payload = body as { requests: { request: string }[] };
    assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 60_000);
    assert.ok(payload.requests.length <= 200);
    batches.push(payload.requests.length);
    count += payload.requests.length;
    return { logs: true, items: [] };
  }, 'session00000001', items);
  assert.equal(count, 235);
  assert.ok(batches.length > 2, 'the byte budget limits each batch before the item-count budget');
  assert.ok(items.every((item) => item.explanation?.state === 'none'));
});

test('a failed explanation batch preserves earlier answers and continues to later calls', async () => {
  const { collectActivity, loadExplanations } = await viewer;
  const items = collectActivity(Array.from({ length: 450 }, (_, index) => call(index + 1000, {
    request: id(index + 1), method: 'GET', path: '/api/health', status: 500, server: true,
  })));
  let batch = 0;
  await loadExplanations(async (_path, body) => {
    const payload = body as { requests: { request: string }[] };
    batch++;
    if (batch === 2) throw new Error('temporary request failure');
    return { logs: true, items: payload.requests.map(({ request }) => ({ request, verdict: 'server' })) };
  }, 'session00000001', items);
  assert.equal(batch, 3);
  assert.ok(items.slice(0, 200).every((item) => item.explanation?.state === 'found'));
  assert.ok(items.slice(200, 400).every((item) => item.explanation?.state === 'failed'));
  assert.ok(items.slice(400).every((item) => item.explanation?.state === 'found'));
});

test('a dashboard that moves on stops the remaining explanation batches without applying the stale answer', async () => {
  const { collectActivity, loadExplanations } = await viewer;
  const items = collectActivity(Array.from({ length: 450 }, (_, index) => call(index + 1000, {
    request: id(index + 1), method: 'GET', path: '/api/health', status: 500, server: true,
  })));
  let current = true;
  let requests = 0;
  await loadExplanations(async (_path, body) => {
    requests++;
    current = false;
    return { logs: true, items: (body as { requests: { request: string }[] }).requests.map(({ request }) => ({ request, verdict: 'server' })) };
  }, 'session00000001', items, () => current);
  assert.equal(requests, 1);
  assert.ok(items.every((item) => item.explanation?.state === 'pending'));
  assert.ok(items.every((item) => item.detail === '500'));
});

test('a verdict worked out from what the app was told reads as likely, in the row and in its details', async () => {
  const { collectActivity, createDevtoolsPanel, loadExplanations } = await viewer;
  const items = collectActivity([call(1000, { request: id(1), method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create',
    status: 400, duration: 30, server: true, message: 'Failed to create record.' }), call(2000, { request: id(2), method: 'POST', path: '/api/collections/orders/records',
    collection: 'orders', action: 'create', status: 400, duration: 30, server: true, message: 'Something went wrong while processing your request.' })]);
  await loadExplanations(async () => ({ logs: true, items: [
    { request: id(1), rule: { name: 'createRule', expression: '@request.auth.id != ""' }, verdict: 'rule', likely: true },
    { request: id(2), rule: { name: 'createRule', expression: '' }, verdict: 'hook', likely: true },
  ] }), 'session00000001', items);
  assert.deepEqual(items.map((item) => item.detail), ['400 · 30 ms · Likely blocked by createRule', '400 · 30 ms · Likely a hook error']);
  const doc = new FakeDocument();
  const container = doc.createElement('section');
  const panel = createDevtoolsPanel(container as unknown as HTMLElement, { seek: () => {} });
  panel.show(items, 1000);
  container.find('devtools-row')[0].dispatch('click');
  assert.equal(container.find('devtools-inspect-verdict')[0].text(),
    'The current createRule may have refused this call; the rule or a hook may have changed since it was recorded');
  container.find('devtools-row')[1].dispatch('click');
  assert.equal(container.find('devtools-inspect-verdict')[0].text(),
    'Most likely an error thrown in a hook or route: PocketBase gave its answer for errors it did not expect');
});

test('a likely hook error on a call that sent a filter, sort, expand or fields may be a query PocketBase could not read', async () => {
  const { collectActivity, createDevtoolsPanel, loadExplanations } = await viewer;
  const generic = 'Something went wrong while processing your request.';
  const items = collectActivity([
    call(1000, { request: id(1), method: 'GET', path: '/api/collections/posts/records', collection: 'posts', action: 'list', status: 400, duration: 5,
      server: true, message: generic, query: { filter: true } }),
    call(2000, { request: id(2), method: 'GET', path: '/api/collections/posts/records', collection: 'posts', action: 'list', status: 400, duration: 5,
      server: true, message: generic }),
    call(3000, { request: id(3), method: 'GET', path: '/api/collections/posts/records', collection: 'posts', action: 'list', status: 400, duration: 5,
      server: true, message: generic, query: { unreadable: true } }),
  ]);
  await loadExplanations(async () => ({ logs: true, items: [1, 2, 3].map((number) => ({ request: id(number), verdict: 'hook', likely: true })) }),
    'session00000001', items);
  assert.deepEqual(items.map((item) => item.detail), ['400 · 5 ms · Likely an unreadable query or a hook error', '400 · 5 ms · Likely a hook error',
    '400 · 5 ms · Likely an unreadable query or a hook error']);
  const doc = new FakeDocument();
  const container = doc.createElement('section');
  createDevtoolsPanel(container as unknown as HTMLElement, { seek: () => {} }).show(items, 1000);
  container.find('devtools-row')[0].dispatch('click');
  assert.equal(container.find('devtools-inspect-verdict')[0].text(),
    "PocketBase most likely could not read this call's filter, sort, expand or fields, or a hook threw an error: it gives both the same answer");
  container.find('devtools-row')[2].dispatch('click');
  assert.equal(container.find('devtools-inspect-verdict')[0].text(),
    "PocketBase most likely could not read this call's filter, sort, expand or fields, or a hook threw an error: it gives both the same answer");
});

test('failed PocketBase calls get timeline marks like failed requests; cancelled and successful ones do not', async () => {
  const { collectActivity, timelineMarks } = await viewer;
  assert.deepEqual(timelineMarks(collectActivity(calls), { duration: 100 }).map((mark) => mark.tag), [
    'PocketBase call failed: orders.create (400)', 'PocketBase call failed: orders.view o3 (404)',
    'PocketBase call failed: GET /api/health (failed)', 'PocketBase call failed: orders.delete o4 (403)',
  ]);
});

// Just enough of the DOM for the panel, as in devtools-viewer.test.ts, with the lookups the details use.
class FakeNode {
  children: FakeNode[] = [];
  parent?: FakeNode;
  className = ''; textContent = ''; hidden = false; tabIndex = 0; title = ''; type = ''; id = '';
  scrollTop = 0; clientHeight = 100; offsetHeight = 20;
  dataset: Record<string, string> = {};
  readonly classList = { add: (name: string) => { if (!this.classes().includes(name)) this.className = `${this.className} ${name}`.trim(); } };
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly tagName: string, readonly ownerDocument: FakeDocument) {}
  classes(): string[] { return this.className.split(' ').filter(Boolean); }
  get offsetTop(): number { const item = this.parent, list = item?.parent; return item && list ? list.children.indexOf(item) * 20 : 0; }
  get parentElement(): FakeNode | undefined { return this.parent; }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  append(...nodes: (FakeNode | string)[]) {
    for (const node of nodes) {
      const items = typeof node === 'string' ? [Object.assign(new FakeNode('#text', this.ownerDocument), { textContent: node })]
        : node.tagName === '#fragment' ? node.children.splice(0) : [node];
      for (const child of items) { child.parent = this; this.children.push(child); }
    }
  }
  replaceChildren(...nodes: FakeNode[]) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined; }
  querySelector(selector: string): FakeNode | null { return this.find(selector.slice(1))[0] ?? null; }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  dispatch(type: string) {
    const event = { target: this, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
    for (let node: FakeNode | undefined = this; node; node = node.parent) for (const listener of node.listeners.get(type) ?? []) listener(event);
  }
  closest(selector: string): FakeNode | null {
    for (let node: FakeNode | undefined = this; node; node = node.parent) if (node.classes().includes(selector.slice(1))) return node;
    return null;
  }
  focus() { this.ownerDocument.activeElement = this; }
  find(className: string): FakeNode[] {
    return [...(this.classes().includes(className) ? [this] : []), ...this.children.flatMap((child) => child.find(className))];
  }
  text(): string { return this.tagName === '#text' ? this.textContent : this.textContent + this.children.map((child) => child.text()).join(''); }
}
class FakeDocument {
  activeElement?: FakeNode;
  createElement(tag: string) { return new FakeNode(tag.toUpperCase(), this); }
  createDocumentFragment() { return new FakeNode('#fragment', this); }
}

test('legacy client and server validation messages cannot reappear in activity or call details', async () => {
  const { collectActivity, createDevtoolsPanel, loadExplanations } = await viewer;
  let fieldMessageReads = 0;
  const legacyField = { field: 'pin', code: 'validation_invalid', get message() { fieldMessageReads++; return 'PIN 827461 refused'; } };
  const items = collectActivity([call(1000, {
    request: id(1), method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', status: 400,
    server: true, message: 'PIN 827461 refused', invalid: [legacyField],
  })]);
  await loadExplanations(async () => ({ logs: true, items: [{
    request: id(1), server: { status: 400, error: 'PIN 827461 refused', details: 'secret query: PIN 827461', fields: [legacyField] },
    verdict: 'validation',
  }] }), 'session00000001', items);
  assert.deepEqual(items[0].pocketbase!.invalid, [{ field: 'pin', code: 'validation_invalid' }]);
  assert.equal(items[0].pocketbase!.message, undefined);
  assert.equal(fieldMessageReads, 0, 'neither the legacy client nor server field-message getter is read');
  assert.doesNotMatch(JSON.stringify(items), /827461|secret query/);
  const doc = new FakeDocument();
  const container = doc.createElement('section');
  createDevtoolsPanel(container as unknown as HTMLElement, { seek: () => {} }).show(items, 1000);
  container.find('devtools-row')[0].dispatch('click');
  assert.doesNotMatch(container.text(), /827461|secret query/);
  assert.match(container.text(), /validation_invalid/);
});

test('a selected PocketBase call opens its details with what the server said, and its issue opens from there', async () => {
  const { collectActivity, createDevtoolsPanel } = await viewer;
  const doc = new FakeDocument();
  const container = doc.createElement('section');
  const opened: string[] = [];
  const seeks: number[] = [];
  const panel = createDevtoolsPanel(container as unknown as HTMLElement, { seek: (at) => seeks.push(at), openIssue: (issue) => opened.push(issue) });
  const items: Activity[] = collectActivity(calls);
  items[1].explanation = { state: 'found', value: { request: id(2), server: { status: 400, ms: 1.8, auth: '', details: 'create rule failure: sql: no rows in result set' },
    rule: { name: 'createRule', expression: '@request.auth.id != ""' }, verdict: 'rule' } };
  items[4].explanation = { state: 'found', value: { request: id(5), server: { status: 404, ms: 0.3, auth: 'users' }, rule: { name: 'viewRule', expression: 'owner = @request.auth.id' },
    verdict: 'rule', record: 'exists', issue: { id: 'issue000000001', title: 'TypeError: boom' } } };
  items[5].explanation = { state: 'pending' };
  panel.show(items, 1000);
  const filter = container.find('devtools-filter').find((button) => button.children[0].textContent === 'PocketBase')!;
  assert.equal(filter.find('devtools-count')[0].textContent, '7');
  const rows = () => container.find('devtools-row');
  const details = () => container.find('devtools-inspect');
  assert.deepEqual(rows().map((row) => row.getAttribute('aria-expanded')), ['false', 'false', 'false', 'false', 'false', 'false', 'false']);
  assert.equal(rows()[1].getAttribute('aria-controls'), `devtools-call-${id(2)}`);

  rows()[1].dispatch('click');
  assert.deepEqual(seeks, [2000]);
  assert.equal(rows()[1].getAttribute('aria-expanded'), 'true');
  assert.equal(details().length, 1);
  assert.equal(details()[0].id, `devtools-call-${id(2)}`);
  assert.deepEqual(details()[0].children.map((child) => child.text()), [
    'POST /api/collections/orders/records', 'Status 400 · 120 ms (server 1.8 ms) · Not signed in', 'Failed to create record.',
    'total (validation_required)', 'The createRule refused this call', 'createRule: @request.auth.id != ""',
    'PocketBase logged create rule failure: sql: no rows in result set',
  ]);

  // Another call closes the first; the issue button opens the issue.
  rows()[4].dispatch('click');
  assert.deepEqual(rows().map((row) => row.getAttribute('aria-expanded')), ['false', 'false', 'false', 'false', 'true', 'false', 'false']);
  assert.equal(details().length, 1);
  const lines = details()[0].children.map((child) => child.text());
  assert.ok(lines.includes('The record exists, so the viewRule hid it from this account'));
  assert.ok(lines.includes('Status 404 · 2.4 s (server 0.3 ms) · Signed in to users'));
  details()[0].find('devtools-inspect-issue')[0].dispatch('click');
  assert.deepEqual(opened, ['issue000000001']);
  assert.deepEqual(seeks, [2000, 5000]);

  // Details stay open when the list is drawn again with the server's answers, and close on a second click.
  panel.show(items, 1000);
  assert.equal(rows()[4].getAttribute('aria-expanded'), 'true');
  assert.equal(details().length, 1);
  rows()[4].dispatch('click');
  assert.equal(details().length, 0);

  // A call still being asked about, one sent elsewhere, and one the server knows nothing of say so.
  rows()[5].dispatch('click');
  assert.equal(details()[0].find('devtools-inspect-note')[0].text(), 'Asking the server about this call...');
  rows()[6].dispatch('click');
  assert.equal(details()[0].find('devtools-inspect-note')[0].text(), 'Sent to a server other than the replay server, so only what the app saw is shown');
  items[5].explanation = { state: 'none', logs: true };
  panel.show(items, 1000);
  rows()[5].dispatch('click');
  assert.match(details()[0].find('devtools-inspect-note')[0].text(), /^The server has nothing on this call/);
  panel.clear();
  panel.show(items, 1000);
  assert.equal(details().length, 0);
});
