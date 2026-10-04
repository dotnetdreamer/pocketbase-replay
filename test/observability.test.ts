import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ReplayHttpError } from '../src/errors';
import { createObservability, OBSERVABILITY_LIMITS } from '../src/observability';
import type { ObservabilityOptions, ObservabilityRuntime } from '../src/observability-types';
import type { ReplayMetadata } from '../src/types';

const token = 't'.repeat(64), replayToken = 's'.repeat(64), sessionId = 'session00000001';
const server = createRequire(import.meta.url)('../server/pb_hooks/lib/observability-core.js');
const enabledConfig = { enabled: true, errorsEnabled: true, logsEnabled: true, token, expiresIn: 14400000, uploadIntervalMs: 10000, maxBatchEvents: 20 };
async function drain(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<ObservabilityOptions> = {}) {
  let now = Date.UTC(2026, 9, 1), timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const posts: { url: string; body: Record<string, any> }[] = [];
  let metadata: ReplayMetadata = { deviceId: 'device-one', platform: 'web', appVersion: '1', room: 'ROOM' };
  const state = { config: { ...enabledConfig }, post: async (_url: string, _body: Record<string, any>): Promise<unknown> => ({ ok: true }) };
  const runtime: ObservabilityRuntime = {
    now: () => now,
    schedule: (run, ms) => { const id = ++timerId; timers.set(id, { at: now + ms, run }); return id; },
    cancel: (timer) => { timers.delete(timer as number); },
  };
  const options: ObservabilityOptions = {
    endpoint: 'https://pb.test/', errors: true, logs: true, metadata: () => metadata,
    transport: { post: async (url, raw) => {
      const body = JSON.parse(raw); posts.push({ url, body });
      return url.endsWith('/config') ? state.config : state.post(url, body);
    } }, ...overrides,
  };
  return {
    options, runtime, state, posts, timers, now: () => now,
    setMetadata: (value: ReplayMetadata) => { metadata = value; },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of Array.from(timers)) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await drain();
    },
  };
}

test('diagnostic ingestion sends its API key on config, errors, logs and exit beacons', async () => {
  const f = fixture({ apiKey: ' diagnostic-ingestion-key ' });
  const beacons: { url: string; body: Record<string, any> }[] = [];
  f.options.transport!.beacon = (url, raw) => { beacons.push({ url, body: JSON.parse(raw) }); return true; };
  const client = createObservability(f.options, f.runtime);
  try {
    await client.refresh();
    client.captureException(new Error('error upload')); client.captureLog('warn', 'log upload');
    await client.flush(); await client.refresh();
    assert.deepEqual(new Set(f.posts.map((post) => post.url.split('/').pop())), new Set(['config', 'errors', 'logs']));
    for (const post of f.posts) assert.equal(post.body.apiKey, 'diagnostic-ingestion-key');
    client.captureLog('info', 'exit upload'); client.stop();
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].body.apiKey, 'diagnostic-ingestion-key');
    assert.equal(beacons[0].body.events[0].message, 'exit upload');
  } finally { client.stop(); }
});

test('diagnostics omit an absent or empty API key from legacy envelopes', async () => {
  for (const apiKey of [undefined, '', '  ']) {
    const f = fixture({ apiKey });
    const client = createObservability(f.options, f.runtime);
    try {
      await client.refresh();
      assert.deepEqual(f.posts[0].body, {
        deviceId: 'device-one', accountId: '', authToken: '', platform: 'web', appVersion: '1', room: 'ROOM',
      });
      client.captureLog('info', 'legacy upload'); await client.flush();
      const batch = f.posts.find((post) => post.url.endsWith('/logs'))!.body;
      assert.deepEqual(Object.keys(batch), ['token', 'events']);
    } finally { client.stop(); }
  }
});

test('saved diagnostic credentials are isolated by ingestion key without storing the raw key', async () => {
  const saved = new Map<string, string>();
  const storage = { get: (key: string) => saved.get(key) ?? null, set: (key: string, value: string) => { saved.set(key, value); }, remove: (key: string) => { saved.delete(key); } };
  const first = fixture({ apiKey: 'first-ingestion-key' });
  const before = createObservability(first.options, { ...first.runtime, storage });
  await before.refresh(); before.stop();
  assert.equal(saved.size, 1);
  assert.equal(Array.from(saved).some(([key, value]) => (key + value).includes('first-ingestion-key')), false);
  const reload = fixture({ apiKey: 'first-ingestion-key' });
  const after = createObservability(reload.options, { ...reload.runtime, storage });
  await after.refresh(); after.stop();
  assert.equal(reload.posts[0].body.token, token);
  for (const apiKey of ['second-ingestion-key', undefined]) {
    const other = fixture({ apiKey });
    const stranger = createObservability(other.options, { ...other.runtime, storage });
    await stranger.refresh(); stranger.stop();
    assert.equal(other.posts[0].body.token, undefined);
  }
});

test('keyed diagnostic credentials stay in memory when secure storage scoping is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const saved = new Map<string, string>();
    const storage = { get: (key: string) => saved.get(key) ?? null, set: (key: string, value: string) => { saved.set(key, value); }, remove: (key: string) => { saved.delete(key); } };
    const f = fixture({ apiKey: 'ingestion-key' });
    const client = createObservability(f.options, { ...f.runtime, storage });
    await client.refresh(); client.stop();
    assert.equal(saved.size, 0);
    const reload = fixture({ apiKey: 'ingestion-key' });
    const after = createObservability(reload.options, { ...reload.runtime, storage });
    await after.refresh(); after.stop();
    assert.equal(reload.posts[0].body.token, undefined);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); else delete (globalThis as { crypto?: Crypto }).crypto;
  }
});

test('explicit grouping keys survive sanitization, crowded attributes and beforeSend', async () => {
  const f = fixture({ sensitiveText: () => ['private-customer'], beforeSend: event => ({ ...event, message: 'Updated message' }) });
  const client = createObservability(f.options, f.runtime);
  await client.refresh();
  const attributes = Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['field' + i, i]));
  client.captureException(new Error('Checkout failed'), { groupingKey: ' checkout-private-customer ', attributes });
  await client.flush();
  const sent = f.posts.find(post => post.url.endsWith('/errors'))!.body.events[0];
  assert.equal(sent.attributes.groupingKey, 'checkout-[redacted]');
  assert.equal(sent.message, 'Updated message');
  assert.equal(Object.keys(sent.attributes).length <= 20, true);
  assert.equal(server.batch(f.posts.find(post => post.url.endsWith('/errors'))!.body, 'error', f.now()).events[0].attributes.groupingKey, 'checkout-[redacted]');
  client.stop();
});

test('both features stay off without local opt-ins or a server opt-in', async () => {
  const off = fixture({ errors: undefined, logs: undefined });
  const client = createObservability(off.options, off.runtime);
  assert.equal(client.captureException(new Error('off')), null);
  assert.equal(client.captureLog('info', 'off'), null);
  await client.refresh(); await client.flush();
  assert.equal(off.posts.length, 0); assert.equal(off.timers.size, 0);
  const f = fixture(); f.state.config.enabled = false;
  const serverOff = createObservability(f.options, f.runtime);
  await serverOff.refresh();
  assert.equal(serverOff.captureException('off'), null);
  assert.equal(serverOff.captureLog('info', 'off'), null);
  assert.equal(f.posts.filter((post) => !post.url.endsWith('/config')).length, 0);
  serverOff.stop();
});

test('standalone errors and logs send bounded payloads accepted by the server contract', async () => {
  const f = fixture({ replay: { getSessionContext: () => ({ sessionId, token: replayToken }) }, service: 'payments' });
  const client = createObservability(f.options, f.runtime);
  await client.refresh();
  const error = new TypeError('checkout failed'); error.stack = 'TypeError: checkout failed\n at checkout (https://app.test/index.js:2:3)';
  const id = client.captureException(error, { attributes: { order: 5 } });
  const logId = client.captureLog('warn', 'request retried', { attempts: 2 });
  assert.ok(id); assert.ok(logId);
  await client.flush();
  const errors = f.posts.find((post) => post.url.endsWith('/errors'))!;
  const logs = f.posts.find((post) => post.url.endsWith('/logs'))!;
  assert.equal(errors.body.token, token);
  assert.equal(errors.body.events[0].id, id);
  assert.equal(errors.body.events[0].name, 'TypeError');
  assert.equal(errors.body.events[0].sessionToken, replayToken);
  assert.equal(errors.body.events[0].handled, true);
  assert.equal(logs.body.events[0].level, 'warn');
  assert.equal('kind' in errors.body.events[0], false);
  server.batch(errors.body, 'error', f.now()); server.batch(logs.body, 'log', f.now());
  assert.equal(client.getMetrics().uploadedEvents, 2);
  await client.refresh();
  assert.equal(f.posts.filter((post) => post.url.endsWith('/config')).at(-1)!.body.token, token);
  client.stop(); assert.equal(f.timers.size, 0);
});

test('redacts strings and structured secrets, avoids getters, handles cycles and sanitizes beforeSend output', async () => {
  let getterCalls = 0;
  const attributes: Record<string, unknown> = { authorization: 'secret', email: 'alice@example.com', password: 'hidden', nested: { url: 'wss://user:pass@socket.test/path?token=hidden' } };
  attributes.circular = attributes;
  Object.defineProperty(attributes, 'unsafe', { enumerable: true, get: () => { getterCalls++; throw Error('getter'); } });
  attributes.deep = { a: { b: { c: { d: { e: 'hidden' } } } } };
  for (let i = 0; i < 20; i++) attributes[`large${i}`] = 'x'.repeat(10000);
  let sawSanitized = false;
  const f = fixture({ sensitiveText: () => ['Private Player'], beforeSend: (event) => {
    sawSanitized = !JSON.stringify(event).includes('secret');
    return { ...event, message: `${event.message} token=from-hook bob@example.com`, attributes: { ...event.attributes, apiKey: 'hook-key' } };
  } });
  const client = createObservability(f.options, f.runtime); await client.refresh();
  assert.ok(client.captureException('Private Player alice@example.com Bearer abc https://user:pass@app.test/path?secret=abc', { attributes }));
  await client.flush();
  const body = f.posts.find((post) => post.url.endsWith('/errors'))!.body;
  const wire = JSON.stringify(body);
  for (const secret of ['Private Player', 'alice@example.com', 'bob@example.com', 'from-hook', 'hook-key', 'user:pass', '?secret']) assert.equal(wire.includes(secret), false, secret);
  assert.equal(sawSanitized, true); assert.equal(getterCalls, 0);
  assert.equal(body.events[0].attributes.unsafe, '[getter]');
  assert.equal(Buffer.byteLength(JSON.stringify(body.events[0].attributes)) <= 4096, true);
  server.batch(body, 'error', f.now()); client.stop();
});

test('beforeSend may drop events or fail without throwing into the app and recursion is ignored', async () => {
  const f = fixture({ beforeSend: (event) => { assert.equal(client.captureLog('info', 'recursive'), null); if (event.message === 'throw') throw Error('hook'); return null; } });
  const client = createObservability(f.options, f.runtime); await client.refresh();
  assert.equal(client.captureLog('info', 'drop'), null);
  assert.doesNotThrow(() => client.captureException('throw'));
  await client.flush(); assert.equal(client.getMetrics().droppedEvents, 2);
  assert.equal(f.posts.some((post) => post.url.endsWith('/logs') || post.url.endsWith('/errors')), false); client.stop();
});

test('transient failures retry the same event IDs and permanent rejection drops only that batch', async () => {
  const f = fixture(); let calls = 0;
  f.state.post = async () => { if (++calls === 1) throw new ReplayHttpError(503); return { ok: true }; };
  const client = createObservability(f.options, f.runtime); await client.refresh();
  const id = client.captureLog('info', 'retry'); await client.flush();
  assert.equal(client.getMetrics().queuedEvents, 1); assert.equal(calls, 1);
  await f.advance(999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2);
  const batches = f.posts.filter((post) => post.url.endsWith('/logs'));
  assert.deepEqual(batches.map((post) => post.body.events[0].id), [id, id]);
  assert.equal(client.getMetrics().uploadedEvents, 1);
  f.state.post = async () => { throw new ReplayHttpError(400); };
  client.captureException('invalid'); await client.flush();
  assert.equal(client.getMetrics().queuedEvents, 0); assert.equal(client.getMetrics().droppedEvents, 1); client.stop();
});

test('retry exhaustion and queue limits bound memory without blocking capture', async () => {
  const f = fixture(); const held = deferred<unknown>(); f.state.post = async () => held.promise;
  const client = createObservability(f.options, f.runtime); await client.refresh();
  for (let i = 0; i < OBSERVABILITY_LIMITS.queueEvents + 30; i++) client.captureLog('debug', `entry ${i}`);
  assert.equal(client.getMetrics().queuedEvents, OBSERVABILITY_LIMITS.queueEvents);
  assert.equal(client.getMetrics().droppedEvents, 30);
  assert.ok(client.getMetrics().queuedBytes <= OBSERVABILITY_LIMITS.queueBytes);
  f.state.post = async () => { throw Error('offline'); };
  held.reject(Error('offline')); await drain();
  for (let i = 0; i < 4; i++) await f.advance(OBSERVABILITY_LIMITS.maxRetryMs);
  assert.ok(client.getMetrics().droppedEvents >= 50);
  client.stop(); assert.equal(f.timers.size, 0);
});

test('account changes drop the old account\'s queue, keep capturing for the new one and renew without the old token', async () => {
  const f = fixture(); const client = createObservability(f.options, f.runtime); await client.refresh();
  client.captureLog('info', 'old account');
  f.setMetadata({ deviceId: 'device-one', accountId: 'next-user', authToken: 'next-auth', platform: 'web', appVersion: '1' });
  assert.ok(client.captureLog('info', 'during account change')); await drain();
  assert.equal(client.getMetrics().droppedEvents, 1);
  assert.equal(f.posts.filter((post) => post.url.endsWith('/config')).at(-1)!.body.token, undefined);
  assert.ok(client.captureLog('info', 'new account')); await client.flush();
  const sent = f.posts.filter((post) => post.url.endsWith('/logs')).flatMap((post) => post.body.events.map((event: any) => event.message));
  assert.deepEqual(sent, ['during account change', 'new account']); client.stop();
});

test('stopping during a config or upload prevents later capture, retry and refresh work', async () => {
  const held = deferred<unknown>(), posts: string[] = [];
  const f = fixture({ transport: { post: async (url) => { posts.push(url); return held.promise; } } });
  const client = createObservability(f.options, f.runtime);
  client.stop(); held.resolve(enabledConfig); await drain();
  assert.equal(client.captureException('late'), null); assert.equal(client.getMetrics().errorsEnabled, false);
  await f.advance(60000); assert.equal(posts.length, 1); assert.equal(f.timers.size, 0);
  const second = fixture(), pending = deferred<unknown>(); second.state.post = async () => pending.promise;
  const uploading = createObservability(second.options, second.runtime); await uploading.refresh();
  uploading.captureLog('error', 'pending'); const flush = uploading.flush(); uploading.stop();
  pending.reject(Error('offline')); await flush; await second.advance(60000);
  assert.equal(second.posts.filter((post) => post.url.endsWith('/logs')).length, 1); assert.equal(second.timers.size, 0);
});

test('an old upload completion cannot remove events captured under a changed account', async () => {
  const f = fixture(), pending = deferred<unknown>(); let uploads = 0;
  f.state.post = async () => ++uploads === 1 ? pending.promise : { ok: true };
  const client = createObservability(f.options, f.runtime); await client.refresh();
  client.captureLog('info', 'old account'); const firstFlush = client.flush();
  f.setMetadata({ deviceId: 'device-one', accountId: 'next-user', authToken: 'auth-token', platform: 'web', appVersion: '1' });
  await client.refresh(); assert.ok(client.captureLog('info', 'new account'));
  pending.resolve({ ok: true }); await firstFlush;
  assert.equal(client.getMetrics().queuedEvents, 1);
  await client.flush();
  assert.deepEqual(f.posts.filter((post) => post.url.endsWith('/logs')).map((post) => post.body.events[0].message), ['old account', 'new account']);
  assert.equal(client.getMetrics().queuedEvents, 0); client.stop();
});

test('a stale config response cannot attach a new account to the old context', async () => {
  const first = deferred<unknown>(), second = deferred<unknown>(); const uploads: Record<string, any>[] = []; let calls = 0;
  const f = fixture({ transport: { post: async (url, raw) => {
    if (!url.endsWith('/config')) { uploads.push(JSON.parse(raw)); return { ok: true }; }
    return ++calls === 1 ? first.promise : second.promise;
  } } });
  const client = createObservability(f.options, f.runtime);
  f.setMetadata({ deviceId: 'device-two', platform: 'web', appVersion: '1' });
  first.resolve(enabledConfig); await drain();
  assert.equal(calls, 2);
  // Waits for device two's own answer instead of borrowing device one's credential.
  assert.ok(client.captureLog('info', 'waiting')); await client.flush();
  assert.equal(uploads.length, 0);
  second.resolve({ ...enabledConfig, token: 'u'.repeat(64) }); await drain();
  assert.ok(client.captureLog('info', 'fresh')); await client.flush();
  assert.deepEqual(uploads.map((body) => [body.token, body.events.map((event: any) => event.message)]),
    [['u'.repeat(64), ['waiting']], ['u'.repeat(64), ['fresh']]]);
  client.stop();
});

test('one feature can remain enabled when the other is disabled and invalid sessions are omitted', async () => {
  const f = fixture({ session: () => ({ sessionId: 'bad', token: 'bad' }) }); f.state.config.errorsEnabled = false;
  const client = createObservability(f.options, f.runtime); await client.refresh();
  assert.equal(client.captureException('off'), null); assert.ok(client.captureLog('info', 'on'));
  await client.flush(); const body = f.posts.find((post) => post.url.endsWith('/logs'))!.body;
  assert.equal(body.events[0].sessionId, undefined); assert.equal(body.events[0].sessionToken, undefined);
  client.stop();
});

test('errors captured before the first answer are kept, sent once it arrives, and dropped if the server is off', async () => {
  const held = deferred<unknown>(); const f = fixture();
  f.options.transport = { post: async (url, raw) => {
    const body = JSON.parse(raw); f.posts.push({ url, body });
    return url.endsWith('/config') ? held.promise : { ok: true };
  } };
  const client = createObservability(f.options, f.runtime);
  assert.ok(client.captureException(new Error('boot crash')));
  assert.ok(client.captureLog('warn', 'boot slow'));
  assert.equal(client.getMetrics().queuedEvents, 2);
  held.resolve(enabledConfig); await drain(); await client.flush();
  assert.deepEqual(f.posts.filter((post) => !post.url.endsWith('/config')).map((post) => post.body.events[0].message), ['boot crash', 'boot slow']);
  assert.equal(client.getMetrics().queuedEvents, 0); client.stop();

  const off = fixture(); off.state.config = { ...enabledConfig, enabled: false };
  const disabled = createObservability(off.options, off.runtime);
  assert.ok(disabled.captureException(new Error('boot crash')));
  await drain();
  assert.equal(disabled.getMetrics().queuedEvents, 0); assert.equal(disabled.getMetrics().droppedEvents, 1);
  assert.equal(disabled.captureException(new Error('later')), null);
  assert.equal(off.posts.filter((post) => !post.url.endsWith('/config')).length, 0); disabled.stop();
});

test('a renewed or replaced credential keeps the queue, and an expired one renews before sending', async () => {
  const f = fixture(); const client = createObservability(f.options, f.runtime); await client.refresh();
  f.state.post = async () => { throw new ReplayHttpError(503); };
  client.captureLog('info', 'queued before renewal'); await client.flush();
  f.state.config = { ...enabledConfig, token: 'v'.repeat(64) };
  f.state.post = async () => ({ ok: true });
  await client.refresh();
  assert.equal(client.getMetrics().queuedEvents, 1);
  await f.advance(OBSERVABILITY_LIMITS.retryMs);
  const sent = f.posts.filter((post) => post.url.endsWith('/logs'));
  assert.equal(sent.at(-1)!.body.token, 'v'.repeat(64));
  assert.equal(sent.at(-1)!.body.events[0].message, 'queued before renewal');
  // Four hours later, without a refresh in between: the capture is still taken and waits for a new credential.
  f.state.config = { ...enabledConfig, token: 'w'.repeat(64) };
  await f.advance(14400000 + 1);
  assert.ok(client.captureException(new Error('after expiry'))); await drain(); await client.flush();
  const last = f.posts.filter((post) => post.url.endsWith('/errors')).at(-1)!;
  assert.equal(last.body.token, 'w'.repeat(64)); assert.equal(last.body.events[0].message, 'after expiry');
  assert.equal(client.getMetrics().droppedEvents, 0); client.stop();
});

test('a refused credential is renewed and the same entries retried; a feature turned off drops only its entries', async () => {
  const f = fixture(); const client = createObservability(f.options, f.runtime); await client.refresh();
  let refusals = 1;
  f.state.post = async () => { if (refusals-- > 0) throw new ReplayHttpError(401); return { ok: true }; };
  const id = client.captureLog('info', 'kept through a 401');
  f.state.config = { ...enabledConfig, token: 'x'.repeat(64) };
  // The next flush, ten seconds on, asks for a new credential and sends the same entry with it.
  await client.flush(); await f.advance(10000); await client.flush();
  const logs = f.posts.filter((post) => post.url.endsWith('/logs'));
  assert.deepEqual(logs.map((post) => [post.body.token, post.body.events[0].id]), [[token, id], ['x'.repeat(64), id]]);
  assert.equal(f.posts.filter((post) => post.url.endsWith('/config')).at(-1)!.body.token, undefined);

  f.state.post = async (url) => { if (url.endsWith('/logs')) throw new ReplayHttpError(403); return { ok: true }; };
  f.state.config = { ...enabledConfig, token: 'x'.repeat(64), logsEnabled: false };
  client.captureLog('info', 'logs were turned off'); client.captureException(new Error('errors still on'));
  await client.flush(); await f.advance(10000); await client.flush();
  assert.equal(client.getMetrics().queuedEvents, 0);
  assert.equal(f.posts.filter((post) => post.url.endsWith('/errors')).at(-1)!.body.events[0].message, 'errors still on');
  assert.equal(client.captureLog('info', 'off now'), null); client.stop();
});

test('the upload credential survives a reload for the same account and device only', async () => {
  const saved = new Map<string, string>();
  const storage = { get: (key: string) => saved.get(key) ?? null, set: (key: string, value: string) => { saved.set(key, value); }, remove: (key: string) => { saved.delete(key); } };
  const first = fixture(); const before = createObservability(first.options, { ...first.runtime, storage }); await before.refresh(); before.stop();
  assert.equal(saved.size, 1);
  const reload = fixture(); const after = createObservability(reload.options, { ...reload.runtime, storage }); await after.refresh();
  assert.equal(reload.posts.find((post) => post.url.endsWith('/config'))!.body.token, token); after.stop();
  const other = fixture(); other.setMetadata({ deviceId: 'device-two', platform: 'web', appVersion: '1' });
  const stranger = createObservability(other.options, { ...other.runtime, storage }); await stranger.refresh();
  assert.equal(other.posts.find((post) => post.url.endsWith('/config'))!.body.token, undefined); stranger.stop();
  const off = fixture(); off.state.config = { ...enabledConfig, enabled: false };
  const disabled = createObservability(off.options, { ...off.runtime, storage }); await disabled.refresh();
  assert.equal(saved.size, 0); disabled.stop();
});

test('an oversized entry loses attributes and the end of its stack instead of being dropped', async () => {
  const f = fixture(); const client = createObservability(f.options, f.runtime); await client.refresh();
  // Arabic script is two bytes a character in UTF-8 and CJK is three, so this is well over 16 KiB as JSON.
  const error = new Error('خرابی '.repeat(300)); error.stack = 'Error\n' + `    at ${'渲'.repeat(30)} (a.js:1:1)\n`.repeat(200);
  assert.ok(client.captureException(error, { attributes: { note: 'ب'.repeat(1000) } }));
  await client.flush();
  const sent = f.posts.find((post) => post.url.endsWith('/errors'))!.body;
  assert.ok(Buffer.byteLength(JSON.stringify(sent.events[0])) <= OBSERVABILITY_LIMITS.eventBytes);
  assert.deepEqual(sent.events[0].attributes, { truncated: true });
  assert.ok(sent.events[0].stack.length < 8000 && sent.events[0].stack.length > 1000);
  assert.ok(sent.events[0].message.startsWith('خرابی'));
  server.batch(sent, 'error', f.now()); client.stop();
});

test('oversized exceptions preserve explicit grouping and bound keys from beforeSend', async () => {
  const f = fixture({ beforeSend: event => ({ ...event, attributes: { ...event.attributes, groupingKey: 'stable-' + 'x'.repeat(200) } }) });
  const client = createObservability(f.options, f.runtime);
  await client.refresh();
  const error = new Error('Oversized grouping probe');
  error.stack = 'at ' + '渲'.repeat(7970);
  client.captureException(error, { groupingKey: 'known-error', attributes: { note: 'ب'.repeat(1000) } });
  await client.flush();
  const sent = f.posts.find(post => post.url.endsWith('/errors'))!.body;
  assert.equal(sent.events[0].attributes.groupingKey, ('stable-' + 'x'.repeat(200)).slice(0, 128));
  assert.equal(sent.events[0].attributes.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(sent.events[0])) <= OBSERVABILITY_LIMITS.eventBytes);
  server.batch(sent, 'error', f.now());
  client.stop();
});

test('V8 stacks and DOMException names and messages are captured, though both are getters', async () => {
  const f = fixture(); const client = createObservability(f.options, f.runtime); await client.refresh();
  assert.equal('value' in Object.getOwnPropertyDescriptor(new Error('probe'), 'stack')!, false, 'this V8 defines stack as a getter');
  client.captureException(new TypeError('Cannot read properties of undefined'));
  client.captureException(new DOMException("play() failed because the user didn't interact with the document first", 'NotAllowedError'));
  const hostile = new Proxy({}, { get: () => { throw new Error('refused'); } });
  assert.ok(client.captureException(hostile));
  await client.flush();
  const [typeError, domError, refused] = f.posts.find((post) => post.url.endsWith('/errors'))!.body.events;
  assert.match(typeError.stack, /^TypeError: Cannot read properties of undefined\n\s+at /);
  assert.equal(domError.name, 'NotAllowedError');
  assert.equal(domError.message, "play() failed because the user didn't interact with the document first");
  assert.equal(refused.name, 'Error');
  client.stop();
});

test('with the server unreachable, a stream of entries asks for a credential at most every 5 seconds', async () => {
  const f = fixture(); let configs = 0;
  f.options.transport = { post: async (url) => { if (url.endsWith('/config')) { configs++; throw new ReplayHttpError(0); } return { ok: true }; } };
  const client = createObservability(f.options, f.runtime); await drain();
  for (let i = 0; i < 100; i++) { client.captureLog('info', `entry ${i}`); await f.advance(100); }
  // Ten seconds of entries, every 100 ms: the start, then at most one more ask per 5 seconds.
  assert.ok(configs <= 3, `asked ${configs} times`);
  assert.equal(client.getMetrics().queuedEvents, 100);
  f.options.transport.post = async (url) => url.endsWith('/config') ? enabledConfig : { ok: true };
  // Back online: the next flush, at most ten seconds away, gets a credential and sends the backlog.
  await f.advance(10000); await drain(); await client.flush();
  assert.equal(client.getMetrics().queuedEvents, 0); assert.equal(client.getMetrics().uploadedEvents, 100);
  client.stop();
});
