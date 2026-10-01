import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startObservability } from '../src/index';
import { subscribeCapture } from '../src/observability-capture';
import type { AutomaticCapture, ObservabilityOptions } from '../src/observability-types';

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
function fakeWindow() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
    fire: (type: string, event: unknown = {}) => { for (const listener of Array.from(listeners.get(type) ?? [])) listener(event); },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}
const options: ObservabilityOptions = { endpoint: 'https://pb.test', metadata: () => ({ deviceId: 'device-one', platform: 'web', appVersion: '1' }) };
const config = { enabled: true, errorsEnabled: true, logsEnabled: true, token: 't'.repeat(64), expiresIn: 14400000 };

test('automatic error collection is explicitly enabled and releases both listeners', async () => {
  const window = fakeWindow(), captures: AutomaticCapture[] = [];
  await withGlobals({ window }, () => {
    const manual = subscribeCapture((capture) => captures.push(capture), { ...options, errors: true });
    assert.equal(window.count('error'), 0); manual();
    const remove = subscribeCapture((capture) => captures.push(capture), { ...options, errors: { captureUnhandled: true } });
    const error = new TypeError('unhandled'); window.fire('error', { error }); window.fire('unhandledrejection', { reason: 'rejected' });
    assert.equal(captures.length, 2); assert.equal(captures[0].kind, 'error');
    assert.equal((captures[0] as { error: unknown }).error, error);
    assert.equal(window.count('error'), 1); assert.equal(window.count('unhandledrejection'), 1);
    remove(); assert.equal(window.count('error'), 0); assert.equal(window.count('unhandledrejection'), 0);
  });
});

test('console observers preserve original calls, filter levels and stop in either order', async () => {
  const calls: unknown[][] = [], original = (...args: unknown[]) => { calls.push(args); };
  const console = { debug: original, info: original, log: original, warn: original, error: original };
  const first: AutomaticCapture[] = [], second: AutomaticCapture[] = [];
  await withGlobals({ console }, () => {
    const removeFirst = subscribeCapture((capture) => first.push(capture), { ...options, logs: { captureConsole: true } });
    const removeSecond = subscribeCapture((capture) => second.push(capture), { ...options, logs: { captureConsole: ['error'] } });
    console.info('hello', { attempts: 1 }); console.error('error');
    assert.equal(calls.length, 2); assert.equal(first.length, 2); assert.equal(second.length, 1);
    removeFirst(); console.error('second');
    assert.equal(first.length, 2); assert.equal(second.length, 2); assert.notEqual(console.error, original);
    removeSecond(); assert.equal(console.error, original); assert.equal(console.info, original);
    console.error('unobserved'); assert.equal(calls.length, 4); assert.equal(second.length, 2);
  });
});

test('console recursion and throwing observers are contained across multiple clients', async () => {
  let called = 0;
  const original = () => { called++; }, console = { debug: original, info: original, log: original, warn: original, error: original };
  await withGlobals({ console }, () => {
    let first = 0, second = 0;
    const removeFirst = subscribeCapture(() => { first++; console.info('recursive'); throw Error('hook'); }, { ...options, logs: { captureConsole: true } });
    const removeSecond = subscribeCapture(() => { second++; console.info('recursive'); }, { ...options, logs: { captureConsole: true } });
    assert.doesNotThrow(() => console.info('start'));
    assert.equal(first, 1); assert.equal(second, 1); assert.equal(called, 3);
    removeSecond(); removeFirst(); assert.equal(console.info, original);
  });
});

test('a later console wrapper is preserved and its stopped observer stays inert after capture restarts', async () => {
  const original = () => {}, console = { debug: original, info: original, log: original, warn: original, error: original };
  await withGlobals({ console }, () => {
    const remove = subscribeCapture(() => {}, { ...options, logs: { captureConsole: true } });
    const previous = console.error, later = (...args: unknown[]) => previous(...args);
    console.error = later; remove(); assert.equal(console.error, later); assert.equal(console.info, original);
    let captured = 0;
    const removeRestarted = subscribeCapture(() => { captured++; }, { ...options, logs: { captureConsole: true } });
    console.error('restarted'); assert.equal(captured, 1);
    removeRestarted(); assert.equal(console.error, later);
  });
});

test('real startObservability captures web errors/logs and stop releases its lifecycle and capture hooks', async () => {
  const window = fakeWindow(), posts: { url: string; body: any }[] = [];
  const original = () => {}, console = { debug: original, info: original, log: original, warn: original, error: original };
  await withGlobals({ window, console }, async () => {
    const client = startObservability({ ...options, errors: { captureUnhandled: true }, logs: { captureConsole: true },
      transport: { post: async (url, body) => { posts.push({ url, body: JSON.parse(body) }); return url.endsWith('/config') ? config : { ok: true }; } } });
    try {
      await client.refresh();
      window.fire('error', { error: new Error('runtime failure') });
      window.fire('unhandledrejection', { reason: 'promise failure' });
      console.warn('request delayed', { elapsed: 15 }); await client.flush();
      const errors = posts.find((post) => post.url.endsWith('/errors'))!.body.events;
      assert.deepEqual(errors.map((event: any) => event.message), ['runtime failure', 'promise failure']);
      assert.ok(errors.every((event: any) => event.handled === false));
      const logs = posts.find((post) => post.url.endsWith('/logs'))!.body.events;
      assert.equal(logs[0].level, 'warn'); assert.equal(logs[0].attributes.arguments[1].elapsed, 15);
    } finally { client.stop(); }
    assert.equal(window.count('error'), 0); assert.equal(window.count('unhandledrejection'), 0);
    assert.equal(window.count('pagehide'), 0); assert.equal(window.count('pageshow'), 0); assert.equal(console.warn, original);
  });
});

test('server-off console capture does not serialize arguments', async () => {
  const original = () => {}, console = { debug: original, info: original, log: original, warn: original, error: original };
  let inspected = 0;
  await withGlobals({ console }, async () => {
    const client = startObservability({ ...options, logs: { captureConsole: true }, transport: { post: async () => ({ enabled: false }) } });
    try {
      await client.refresh();
      const value = new Proxy({}, { ownKeys: () => { inspected++; return []; } });
      console.info(value); assert.equal(inspected, 0);
    } finally { client.stop(); }
  });
});
