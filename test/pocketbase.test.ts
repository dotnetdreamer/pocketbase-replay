import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVTOOLS_LIMITS, startDevtools } from '../src/devtools';
import {
  describeBatch, describeCall, describeFailure, describeQuery, describeResult, describeTopics, linkValue, originOf, queryOf, requestId,
} from '../src/pocketbase';
import type { RecorderOptions, ReplayEvent } from '../src/types';

async function withGlobals(values: Record<string, unknown>, run: () => Promise<void> | void): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try { await run(); } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

// Shaped as the PocketBase JS SDK's errors are: the server's answer is in `response`.
class ClientResponseError extends Error {
  status: number; response: Record<string, unknown>; isAbort: boolean;
  constructor(status: number, response: Record<string, unknown> = {}, isAbort = false) {
    super(typeof response.message === 'string' ? response.message : 'Something went wrong');
    this.name = `ClientResponseError ${status}`; this.status = status; this.response = response; this.isAbort = isAbort;
  }
}

interface Route { status: number; data?: unknown; fail?: unknown }

// A page with fetch and a client that sends the way the SDK does: one options object, handed to its fetch.
function setup(href: string, routes: (url: string, init: Record<string, any>) => Route) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const fetches: { url: string; init: Record<string, any> }[] = [];
  const page: Record<string, any> = {
    location: { href },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (type: string, listener: (event: unknown) => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
  };
  page.fetch = async function (url: string, init: Record<string, any> = {}) {
    fetches.push({ url, init });
    const route = routes(url, init);
    if (route.fail) throw route.fail;
    return { status: route.status, json: async () => route.data ?? {} };
  };
  const sent: { path: string; options: Record<string, any> }[] = [];
  const client = {
    baseURL: 'https://pb.test',
    async send(path: string, options: Record<string, any> = {}) {
      sent.push({ path, options });
      const call = (options.fetch as typeof page.fetch | undefined) ?? page.fetch;
      let response: { status: number; json: () => Promise<unknown> };
      try { response = await call(this.baseURL + path, options); } catch (error) { throw new ClientResponseError(0, {}, (error as Error)?.name === 'AbortError'); }
      const data = await response.json() as Record<string, unknown>;
      if (response.status >= 400) throw new ClientResponseError(response.status, data);
      return data;
    },
  };
  return { page, client, fetches, sent };
}

const options = (client: unknown, extra: Partial<RecorderOptions> = {}): RecorderOptions => ({
  endpoint: 'https://pb.test', metadata: () => ({ deviceId: 'device-one', platform: 'web', appVersion: '1' }),
  pocketbase: client as RecorderOptions['pocketbase'], recordPocketbase: true, ...extra,
});
const payloads = (events: ReplayEvent[], tag = 'pbr/pocketbase') => events
  .filter((event) => event.type === 5 && event.data.tag === tag).map((event) => event.data.payload as Record<string, any>);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

test('calls are named by how PocketBase routes them, without query, fragment or control characters', () => {
  const cases: [string, string, Record<string, string>][] = [
    ['GET', '/api/collections/posts/records?filter=(title%3D%22secret%22)#x', { collection: 'posts', action: 'list' }],
    ['POST', '/api/collections/posts/records', { collection: 'posts', action: 'create' }],
    ['get', '/api/collections/posts/records/abc123', { collection: 'posts', action: 'view', record: 'abc123' }],
    ['PATCH', '/api/collections/posts/records/abc123', { collection: 'posts', action: 'update', record: 'abc123' }],
    ['DELETE', '/api/collections/posts/records/abc123', { collection: 'posts', action: 'delete', record: 'abc123' }],
    ['POST', '/api/collections/users/auth-with-password', { collection: 'users', action: 'auth-with-password' }],
    ['GET', '/api/collections/users/auth-methods', { collection: 'users', action: 'auth-methods' }],
    ['POST', '/api/collections/_superusers/impersonate/u1', { collection: '_superusers', action: 'impersonate', record: 'u1' }],
    ['POST', '/api/batch', { action: 'batch' }],
    ['POST', '/api/realtime', { action: 'realtime' }],
    ['POST', '/api/files/token', { action: 'file-token' }],
    ['PUT', '/api/collections/posts/records', { collection: 'posts' }],
    ['GET', '/api/collections/bad%20name/records', {}],
    ['GET', '/api/health', {}],
    ['GET', 'api/collections/posts/records/', { collection: 'posts' }],
  ];
  for (const [method, path, expected] of cases) {
    const call = describeCall(method, path);
    assert.deepEqual({ collection: call.collection, action: call.action, record: call.record },
      { collection: expected.collection, action: expected.action, record: expected.record }, `${method} ${path}`);
    assert.doesNotMatch(call.path, /[?#]|secret/);
    assert.ok(call.path.startsWith('/'));
  }
  assert.equal(describeCall(undefined, undefined).method, 'GET');
  assert.equal(describeCall('GET', '/api/x\u0000y\n').path, '/api/xy');
  assert.equal(describeCall('GET', `/api/${'x'.repeat(400)}`).path.length, 300);
});

test('a list keeps whether it was filtered and which fields it sorted, expanded or picked, never the filter itself', () => {
  assert.deepEqual(describeQuery({ filter: 'email = "alice@example.test"', sort: '-created,title', expand: 'author.profile',
    fields: 'id,description:excerpt(200,true)', skipTotal: true, page: 2 }),
  { filter: true, sort: '-created,title', expand: 'author.profile', fields: 'id,description:excerpt(200,true)', skipTotal: true });
  assert.deepEqual(describeQuery({ sort: 'title="secret"', expand: 'x'.repeat(201), filter: '  ' }), { unreadable: true });
  assert.deepEqual(describeQuery({ fields: 'id', sort: 'title="secret"' }), { fields: 'id', unreadable: true });
  assert.equal(describeQuery('filter=x'), undefined);
});

test('the query is read as the SDK sends it: top-level list options over query over the older params', () => {
  assert.deepEqual(describeQuery(queryOf({ method: 'GET', filter: 'owner = "alice"', sort: '-created',
    query: { page: 1, perPage: 30, sort: 'title', expand: 'author' }, params: { fields: 'id,title', expand: 'old' } })),
  { filter: true, sort: '-created', expand: 'author', fields: 'id,title' });
  assert.equal(queryOf(undefined), undefined);
  assert.deepEqual(queryOf({ query: 'not an object' }), {});
});

test('an answer adds counts and ids only; a sign-in names the account but its token is never read', () => {
  assert.deepEqual(describeResult({ method: 'GET', path: '/x', action: 'list', collection: 'posts' },
    { page: 2, perPage: 30, totalItems: 42, items: [{ secret: 'a' }, { secret: 'b' }] }), { items: 2, total: 42, page: 2, perPage: 30 });
  assert.deepEqual(describeResult({ method: 'GET', path: '/x', action: 'list' }, { page: 1, perPage: 30, totalItems: -1, items: [] }),
    { items: 0, page: 1, perPage: 30 });
  assert.deepEqual(describeResult({ method: 'POST', path: '/x', action: 'create' }, { id: 'new123', title: 'secret' }), { record: 'new123' });
  let tokenRead = false;
  const answer = { record: { id: 'u1', email: 'alice@example.test' }, get token() { tokenRead = true; return 'jwt'; } };
  assert.deepEqual(describeResult({ method: 'POST', path: '/x', collection: 'users', action: 'auth-with-password' }, answer), { record: 'u1' });
  assert.equal(tokenRead, false);
  assert.deepEqual(describeResult({ method: 'GET', path: '/x', action: 'view' }, { id: 'not an id!' }), {});
});

test('a failure keeps names and codes while omitting custom and field messages that can echo rejected values', () => {
  const error = new ClientResponseError(400, { message: 'Failed for alice@example.test and Wonderland', data: {
    total: { code: 'validation_required', message: 'Cannot be blank.' },
    email: { code: 'validation_invalid_email', message: 'alice@example.test is invalid' },
    'bad field!': { code: 'x', message: 'y' }, nested: { requests: {} }, odd: { code: 'has space', message: 'z' },
  } });
  assert.deepEqual(describeFailure(error, ['Wonderland']), { status: 400, invalid: [
    { field: 'total', code: 'validation_required' },
    { field: 'email', code: 'validation_invalid_email' },
  ] });
  assert.deepEqual(describeFailure(new ClientResponseError(0, {}, true)), { status: 0, failed: 'abort' });
  assert.deepEqual(describeFailure(new ClientResponseError(0, { message: 'Failed to connect' })), { status: 0, failed: 'error' });
  assert.deepEqual(describeFailure(Object.assign(new Error('x'), { name: 'AbortError' })), { status: 0, failed: 'abort' });
  const hostile = { get status() { throw new Error('no'); } };
  assert.deepEqual(describeFailure(hostile), { status: 0, failed: 'error' });
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`f${index}`, { code: 'validation_required' }]));
  assert.equal(describeFailure(new ClientResponseError(400, { data: many })).invalid!.length, 20);
});

test('only fixed PocketBase error messages are kept and validation message getters are never read', () => {
  const standard = [
    'Failed to create record.', 'Failed to update record.', 'Failed to delete record.',
    "The requested resource wasn't found.", 'Only superusers can perform this action.',
    'Something went wrong while processing your request.', 'Failed to authenticate.', 'Missing or invalid authentication.',
  ];
  for (const message of standard) {
    assert.equal(describeFailure({ status: 400, response: { message: ` ${message} ` } }).message, message);
  }
  let fieldMessageReads = 0;
  const error = { status: 400, response: { message: 'PIN 827461 refused', data: {
    pin: { code: 'validation_invalid', get message() { fieldMessageReads++; throw new Error('827461'); } },
  } } };
  const recorded = describeFailure(error);
  assert.deepEqual(recorded, { status: 400, invalid: [{ field: 'pin', code: 'validation_invalid' }] });
  assert.equal(fieldMessageReads, 0);
  assert.doesNotMatch(JSON.stringify(recorded), /827461/);
  assert.deepEqual(describeFailure({ status: 400, response: { message: 'Failed to create record. PIN 827461' } }), { status: 400 });
});

test('a batch lists its calls with their statuses and a subscription its collections, never bodies or options', () => {
  const body = { requests: [
    { method: 'POST', url: '/api/collections/orders/records?expand=x', body: { total: 'secret' } },
    { method: 'DELETE', url: '/api/collections/orders/records/o1' },
  ] };
  assert.deepEqual(describeBatch(body, [{ status: 200, body: { secret: 1 } }, { status: 404 }]), [
    { method: 'POST', path: '/api/collections/orders/records', collection: 'orders', action: 'create', status: 200 },
    { method: 'DELETE', path: '/api/collections/orders/records/o1', collection: 'orders', action: 'delete', record: 'o1', status: 404 },
  ]);
  const form = { get: (key: string) => key === '@jsonPayload' ? JSON.stringify(body) : null };
  assert.equal(describeBatch(form).length, 2);
  assert.equal(describeBatch({ requests: Array.from({ length: 60 }, () => ({ method: 'GET', url: '/api/health' })) }).length, 50);
  assert.deepEqual(describeBatch('nope'), []);
  assert.deepEqual(describeTopics({ clientId: 'c', subscriptions: ['posts', 'posts/abc', 'comments?options={"query":{"secret":1}}', 'bad name', 'posts/*'] }),
    ['posts', 'comments']);
});

test('request ids are 20 lowercase letters and digits, and the link carries a session id only when it is valid', () => {
  const ids = new Set(Array.from({ length: 200 }, requestId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{20}$/);
  assert.equal(linkValue('a'.repeat(20), 'session00000001'), `${'a'.repeat(20)}.session00000001`);
  for (const session of [null, '', 'short', 'UPPERCASE000001', 'session0000001x2']) assert.equal(linkValue('a'.repeat(20), session), 'a'.repeat(20));
  assert.equal(originOf('/api', 'https://app.test/x'), 'https://app.test');
  assert.equal(originOf('capacitor://localhost/index.html'), '');
  assert.equal(originOf('not a url'), '');
});

test('nothing is recorded or changed unless the server records PocketBase calls and the app passed its client', async () => {
  const { page, client } = setup('https://pb.test/app', () => ({ status: 200, data: {} }));
  const original = client.send;
  await withGlobals({ window: page }, async () => {
    for (const extra of [{ recordPocketbase: false }, { pocketbase: undefined }, { pocketbase: { send: 'no' } as never }]) {
      const events: ReplayEvent[] = [];
      const stop = startDevtools((event) => events.push(event), options(client, extra));
      assert.equal(client.send, original);
      await client.send('/api/collections/posts/records');
      stop();
      assert.equal(payloads(events).length, 0);
    }
  });
});

test('a call to the same server is linked with its id and the live session, and network rows leave it alone', async () => {
  const { page, client, fetches, sent } = setup('https://pb.test/app', (url, init) => url.endsWith('/records') && init.method === 'POST'
    ? { status: 400, data: { message: 'Failed to create record.', data: { total: { code: 'validation_required', message: 'Cannot be blank.' } } } }
    : url.includes('/records/') ? { status: 200, data: { id: 'abc123', title: 'secret title' } }
    : { status: 200, data: { page: 1, perPage: 30, totalItems: 0, items: [] } });
  const original = client.send;
  const events: ReplayEvent[] = [];
  let session: string | null = 'session00000001';
  await withGlobals({ window: page }, async () => {
    const stop = startDevtools((event) => events.push(event), options(client, { recordNetwork: true, replaySession: () => session }));
    assert.notEqual(client.send, original);
    // As the SDK's getList sends it: list options at the top level, page and size in the query.
    const listed = await client.send('/api/collections/posts/records', { query: { page: 1, perPage: 30 }, filter: 'title = "secret"', headers: { 'X-App': 'kept' } });
    assert.deepEqual(listed, { page: 1, perPage: 30, totalItems: 0, items: [] });
    session = null;
    const failure = await client.send('/api/collections/orders/records', { method: 'POST', body: { total: 'secret value' } }).catch((error: unknown) => error);
    assert.ok(failure instanceof ClientResponseError);
    const viewed = await client.send('/api/collections/posts/records/abc123');
    assert.equal(viewed.id, 'abc123');
    stop();
    assert.equal(client.send, original);
  });
  // The app's own headers stay, and the link header names the call and, while there is one, the recording.
  const [first, second, third] = sent.map((call) => call.options);
  assert.match(first.headers['X-Replay-Request'], /^[a-z0-9]{20}\.session00000001$/);
  assert.equal(first.headers['X-App'], 'kept');
  assert.match(second.headers['X-Replay-Request'], /^[a-z0-9]{20}$/);
  assert.equal(fetches.length, 3);
  assert.equal(payloads(events, 'pbr/network').length, 0);
  const recorded = payloads(events);
  assert.deepEqual(recorded.map((payload) => [payload.collection, payload.action, payload.status, payload.linked, payload.server]), [
    ['posts', 'list', 200, true, true], ['orders', 'create', 400, true, true], ['posts', 'view', 200, true, true],
  ]);
  assert.equal(recorded[0].request, first.headers['X-Replay-Request'].split('.')[0]);
  assert.deepEqual({ items: recorded[0].items, total: recorded[0].total, query: recorded[0].query }, { items: 0, total: 0, query: { filter: true } });
  assert.deepEqual({ message: recorded[1].message, invalid: recorded[1].invalid },
    { message: 'Failed to create record.', invalid: [{ field: 'total', code: 'validation_required' }] });
  assert.equal(recorded[2].record, 'abc123');
  for (const payload of recorded) assert.ok(Number.isInteger(payload.duration) && payload.duration >= 0);
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});

test('trace markers are opt-in and clone the SDK query without changing caller-owned options', async () => {
  const { page, client, sent } = setup('https://pb.test/', () => ({ status: 200, data: {} }));
  const query = Object.freeze({ page: 2, sort: 'title', expand: 'owner', __replayRequest: 'reserved-old-value' });
  const params = Object.freeze({ fields: 'id,title', expand: 'old' });
  const headers = Object.freeze({ 'X-App': 'kept' });
  const given = Object.freeze({ query, params, headers, filter: 'owner = "private-person"', sort: '-created' });
  const events: ReplayEvent[] = [];
  await withGlobals({ window: page }, async () => {
    const ordinary = startDevtools((event) => events.push(event), options(client));
    await client.send('/api/collections/posts/records', { query: { page: 1 } });
    ordinary();
    assert.deepEqual(sent[0].options.query, { page: 1 });

    const tracing = startDevtools((event) => events.push(event), options(client, { tracePocketbaseRequests: true, replaySession: () => 'session00000001' }));
    await client.send('/api/collections/posts/records', given);
    tracing();
  });
  const traced = sent[1].options;
  assert.notEqual(traced, given);
  assert.notEqual(traced.query, query);
  assert.notEqual(traced.headers, headers);
  assert.equal(traced.params, params);
  assert.deepEqual(traced.query, { page: 2, sort: '-created', expand: 'owner', fields: 'id,title', filter: 'owner = "private-person"',
    __replayRequest: traced.headers['X-Replay-Request'] });
  assert.match(traced.query.__replayRequest, /^[a-z0-9]{20}\.session00000001$/);
  assert.deepEqual(query, { page: 2, sort: 'title', expand: 'owner', __replayRequest: 'reserved-old-value' });
  assert.deepEqual(headers, { 'X-App': 'kept' });
  assert.deepEqual(params, { fields: 'id,title', expand: 'old' });
  assert.doesNotMatch(JSON.stringify(events), /private-person|__replayRequest|reserved-old-value/);
});

test('trace markers need the replay server, a permitted header shape and a completed cross-origin link check', async () => {
  const endpoint = 'https://trace-pb.test';
  const same = setup('https://trace-app.test/', () => ({ status: 200, data: {} }));
  same.client.baseURL = endpoint;
  await withGlobals({ window: same.page }, async () => {
    const stop = startDevtools(() => {}, options(same.client, { endpoint, tracePocketbaseRequests: true }));
    await same.client.send('/api/health', { query: { original: 'kept' } });
    await settle();
    await same.client.send('/api/health', { query: { original: 'kept' } });
    stop();
  });
  assert.deepEqual(same.sent[0].options.query, { original: 'kept' });
  assert.equal(same.sent[0].options.headers?.['X-Replay-Request'], undefined);
  assert.equal(same.sent[1].options.query.__replayRequest, same.sent[1].options.headers['X-Replay-Request']);

  const other = setup('https://pb.test/', () => ({ status: 200, data: {} }));
  other.client.baseURL = 'https://elsewhere.test';
  await withGlobals({ window: other.page }, async () => {
    const stop = startDevtools(() => {}, options(other.client, { tracePocketbaseRequests: true }));
    await other.client.send('/api/health', { query: { original: 'kept' } });
    stop();
  });
  assert.deepEqual(other.sent[0].options.query, { original: 'kept' });

  const unconventional = setup('https://pb.test/', () => ({ status: 200, data: {} }));
  class HeaderBag {}
  const bag = new HeaderBag();
  await withGlobals({ window: unconventional.page }, async () => {
    const stop = startDevtools(() => {}, options(unconventional.client, { tracePocketbaseRequests: true }));
    await unconventional.client.send('/api/health', { headers: bag, query: { original: 'kept' } });
    stop();
  });
  assert.equal(unconventional.sent[0].options.headers, bag);
  assert.deepEqual(unconventional.sent[0].options.query, { original: 'kept' });
});

test('another origin gets the link header only after one check request shows CORS lets it through', async () => {
  let allow = true;
  const { page, client, fetches, sent } = setup('https://app.test/', (url) => url.endsWith('/api/replay/link')
    ? (allow ? { status: 200, data: { ok: true } } : { status: 0, fail: new TypeError('Failed to fetch') }) : { status: 200, data: {} });
  const events: ReplayEvent[] = [];
  await withGlobals({ window: page }, async () => {
    const stop = startDevtools((event) => events.push(event), options(client, { endpoint: 'https://pb.test/', recordNetwork: true }));
    await client.send('/api/health');
    await settle();
    await client.send('/api/health');
    stop();
  });
  assert.equal(fetches.filter((call) => call.url === 'https://pb.test/api/replay/link').length, 1);
  assert.equal(fetches.find((call) => call.url.endsWith('/link'))!.init.headers['X-Replay-Request'], 'check');
  assert.equal(sent[0].options.headers?.['X-Replay-Request'], undefined);
  assert.match(sent[1].options.headers['X-Replay-Request'], /^[a-z0-9]{20}$/);
  assert.deepEqual(payloads(events).map((payload) => [payload.linked, payload.server]), [[undefined, true], [true, true]]);
  assert.equal(payloads(events, 'pbr/network').length, 0);

  // A refused check keeps the header off, and it is asked again only after a while.
  allow = false;
  const other = setup('https://app.test/', (url) => url.endsWith('/api/replay/link') ? { status: 0, fail: new TypeError('Failed to fetch') } : { status: 200, data: {} });
  other.client.baseURL = 'https://refused.test';
  await withGlobals({ window: other.page }, async () => {
    const stop = startDevtools(() => {}, options(other.client, { endpoint: 'https://refused.test' }));
    for (let i = 0; i < 3; i++) { await other.client.send('/api/health'); await settle(); }
    stop();
  });
  assert.equal(other.fetches.filter((call) => call.url.endsWith('/api/replay/link')).length, 1);
  assert.ok(other.sent.every((call) => call.options.headers?.['X-Replay-Request'] === undefined));
  assert.ok(DEVTOOLS_LIMITS.linkRetryMs >= 60000);
});

test('a client on another server is recorded but never linked, and a header object of another kind is left untouched', async () => {
  const { page, client, sent } = setup('https://app.test/', () => ({ status: 200, data: {} }));
  client.baseURL = 'https://elsewhere.test';
  const events: ReplayEvent[] = [];
  await withGlobals({ window: page }, async () => {
    const stop = startDevtools((event) => events.push(event), options(client, { endpoint: 'https://app.test' }));
    await client.send('/api/collections/posts/records');
    stop();
  });
  assert.equal(sent[0].options.headers, undefined);
  assert.deepEqual([payloads(events)[0].linked, payloads(events)[0].server], [undefined, undefined]);

  const same = setup('https://pb.test/', () => ({ status: 200, data: {} }));
  class HeaderBag { constructor(readonly values: Record<string, string>) {} }
  const bag = new HeaderBag({ A: 'b' });
  await withGlobals({ window: same.page }, async () => {
    const stop = startDevtools(() => {}, options(same.client));
    await same.client.send('/api/health', { headers: bag });
    stop();
  });
  assert.equal(same.sent[0].options.headers, bag);
});

test('the app gets its exact answers and errors, its own fetch is used, and failures without a response are named', async () => {
  const { page, client } = setup('https://pb.test/', (url) => url.includes('cancel')
    ? { status: 0, fail: Object.assign(new Error('aborted'), { name: 'AbortError' }) }
    : url.includes('down') ? { status: 0, fail: new TypeError('Failed to fetch') } : { status: 204 });
  const appFetches: string[] = [];
  const events: ReplayEvent[] = [];
  await withGlobals({ window: page }, async () => {
    const stop = startDevtools((event) => events.push(event), options(client));
    const answer = await client.send('/api/collections/posts/records/p1', { method: 'DELETE', fetch: (url: string, init: unknown) => { appFetches.push(url); return page.fetch(url, init); } });
    assert.deepEqual(answer, {});
    for (const path of ['/api/cancel', '/api/down']) await assert.rejects(client.send(path), (error) => error instanceof ClientResponseError);
    // Calls to the replay API itself are passed straight through.
    await client.send('/api/replay/settings');
    stop();
  });
  assert.deepEqual(appFetches, ['https://pb.test/api/collections/posts/records/p1']);
  assert.deepEqual(payloads(events).map((payload) => [payload.action ?? payload.path, payload.status, payload.failed]), [
    ['delete', 204, undefined], ['/api/cancel', 0, 'abort'], ['/api/down', 0, 'error'],
  ]);
});

test('batches and subscriptions describe their parts, and PocketBase calls have their own per-minute allowance', async () => {
  const { page, client } = setup('https://pb.test/', (url) => url.endsWith('/api/batch')
    ? { status: 200, data: [{ status: 200, body: { secret: 1 } }, { status: 400 }] } : { status: 204 });
  const events: ReplayEvent[] = [];
  await withGlobals({ window: page }, async () => {
    const stop = startDevtools((event) => events.push(event), options(client));
    await client.send('/api/batch', { method: 'POST', body: { requests: [
      { method: 'POST', url: '/api/collections/orders/records', body: { secret: 'x' } }, { method: 'PATCH', url: '/api/collections/orders/records/o1' },
    ] } });
    await client.send('/api/realtime', { method: 'POST', body: { clientId: 'abc', subscriptions: ['orders', 'orders/o1?options=secret'] } });
    for (let i = 0; i < DEVTOOLS_LIMITS.pocketbase + 5; i++) await client.send('/api/health');
    stop();
  });
  const recorded = payloads(events);
  assert.deepEqual(recorded[0].batch.map((item: Record<string, unknown>) => [item.collection, item.action, item.status]),
    [['orders', 'create', 200], ['orders', 'update', 400]]);
  assert.deepEqual(recorded[1].topics, ['orders']);
  assert.equal(recorded.length, DEVTOOLS_LIMITS.pocketbase);
  const notices = payloads(events, 'pbr/console').filter((payload) => /PocketBase calls/.test(payload.text));
  assert.equal(notices.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});

test('a wrapper added after the recorder keeps working, with the recorder inert inside it', async () => {
  const { page, client } = setup('https://pb.test/', () => ({ status: 200, data: {} }));
  const events: ReplayEvent[] = [];
  await withGlobals({ window: page }, async () => {
    const stop = startDevtools((event) => events.push(event), options(client));
    const ours = client.send;
    const outer = function (this: unknown, ...args: unknown[]) { return (ours as (...values: unknown[]) => Promise<unknown>).apply(this, args); };
    client.send = outer as typeof client.send;
    stop();
    assert.equal(client.send, outer);
    await client.send('/api/health');
  });
  assert.equal(payloads(events).length, 0);
});
