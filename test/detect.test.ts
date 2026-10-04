import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoLifecycle, nativeTransport, pageVisible } from '../src/detect';
import { ReplayHttpError, startObservability, startReplay } from '../src/index';
import type { ReplayController, ReplayMetadata, ReplayOptions } from '../src/types';

type Listener = () => void;
type AppListener = (state: { isActive?: unknown }) => void;
const page = globalThis as unknown as Record<string, unknown>;
const metadata = (): ReplayMetadata => ({ deviceId: 'device-one', platform: 'android', appVersion: '1.4.60' });

async function drain(): Promise<void> { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }

async function withGlobals(values: Record<string, unknown>, run: () => Promise<void> | void): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true });
  }
  try { await run(); } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete page[key];
    }
  }
}

// Real timers keep running after a failed assertion unless the controller stops.
async function running(options: ReplayOptions, run: (replay: ReplayController) => Promise<void> | void): Promise<void> {
  const replay = startReplay(options);
  try { await run(replay); } finally { replay.stop(); }
}

function fakeDocument(visibilityState: 'visible' | 'hidden') {
  const listeners = new Map<string, Set<Listener>>();
  return {
    visibilityState,
    addEventListener(type: string, listener: Listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener(type: string, listener: Listener) { listeners.get(type)?.delete(listener); },
    fire(type: string) { for (const listener of Array.from(listeners.get(type) ?? [])) listener(); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
    createElement: () => ({ matches: (selector: string) => { if (/!|,\s*$/.test(selector)) throw new SyntaxError('bad selector'); return false; } }),
  };
}

function fakeFetch(replies: Record<string, unknown> = {}) {
  const urls: string[] = [];
  const fetch = async (url: string | URL | Request) => {
    urls.push(String(url));
    const path = String(url).split('/').pop()!;
    return new Response(JSON.stringify(replies[path] ?? { enabled: false }), { status: 200 });
  };
  return { urls, fetch };
}

function fakeApp() {
  const listeners: AppListener[] = [];
  const state = { removed: 0 };
  const app = {
    addListener(event: string, listener: AppListener) {
      assert.equal(event, 'appStateChange');
      listeners.push(listener);
      return Promise.resolve({ remove: async () => { state.removed++; } });
    },
  };
  return { app, listeners, state };
}

const phone = (platform: string, plugins: Record<string, unknown>) => ({ getPlatform: () => platform, Plugins: plugins });

test('API keys survive automatic native transport for replay and diagnostics', async () => {
  for (const platform of ['android', 'ios']) {
    const calls: { url: string; data: string }[] = [];
    const http = { post: async (request: { url: string; data: string }) => {
      calls.push(request);
      return { status: 200, data: request.url.includes('/observability/config')
        ? { enabled: true, errorsEnabled: true, logsEnabled: true, token: 't'.repeat(64), expiresIn: 14400000 }
        : { enabled: false } };
    } };
    await withGlobals({ Capacitor: phone(platform, { CapacitorHttp: http }) }, async () => {
      await running({ endpoint: 'https://replay.test', metadata, apiKey: 'native-ingestion-key' }, async () => {
        const diagnostics = startObservability({ endpoint: 'https://replay.test', metadata, apiKey: 'native-ingestion-key', errors: true, logs: true });
        try {
          await diagnostics.refresh();
          diagnostics.captureException(new Error('native error')); diagnostics.captureLog('info', 'native log');
          await diagnostics.flush();
          for (const call of calls) assert.equal(JSON.parse(call.data).apiKey, 'native-ingestion-key');
          assert.deepEqual(new Set(calls.map((call) => call.url.split('/').pop())), new Set(['config', 'errors', 'logs']));
        } finally { diagnostics.stop(); }
      });
    });
  }
});

test('a phone posts through CapacitorHttp as text, parses string bodies and reports HTTP status', async () => {
  const calls: Record<string, unknown>[] = [];
  let reply: Record<string, unknown> = { status: 200, data: '{"enabled":false}' };
  const http = {
    post(this: unknown, request: Record<string, unknown>) {
      assert.equal(this, http);
      calls.push(request);
      return Promise.resolve(reply);
    },
  };
  for (const platform of ['android', 'ios']) {
    await withGlobals({ Capacitor: phone(platform, { CapacitorHttp: http }) }, async () => {
      const transport = nativeTransport();
      assert.ok(transport, platform);
      assert.equal(transport.beacon, undefined);
      reply = { status: 200, data: '{"enabled":false}' };
      assert.deepEqual(await transport.post('https://replay.test/api/replay/config', '{"deviceId":"d"}'), { enabled: false });
      reply = { status: 201, data: { ok: true } };
      assert.deepEqual(await transport.post('https://replay.test/api/replay/chunks', '{}'), { ok: true });
      for (const [status, expected] of [[401, 401], [503, 503], [302, 302], ['broken', 0], [undefined, 0]] as const) {
        reply = { status, data: '' };
        await assert.rejects(transport.post('https://replay.test/api/replay/chunks', '{}'),
          (error: unknown) => error instanceof ReplayHttpError && error.status === expected, String(status));
      }
    });
  }
  assert.deepEqual(calls[0], {
    url: 'https://replay.test/api/replay/config', method: 'POST', headers: { 'Content-Type': 'text/plain' },
    data: '{"deviceId":"d"}', connectTimeout: 8000, readTimeout: 8000,
  });
});

test('a CapacitorHttp without post() is called through request() as a POST', async () => {
  const calls: Record<string, unknown>[] = [];
  const http = { request: async (request: Record<string, unknown>) => { calls.push(request); return { status: 200, data: { enabled: true } }; } };
  await withGlobals({ Capacitor: phone('android', { CapacitorHttp: http }) }, async () => {
    assert.deepEqual(await nativeTransport()!.post('https://replay.test/api/replay/config', '{}'), { enabled: true });
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].data, '{}');
});

test('the web, Electron and odd or missing Capacitor globals fall back to fetch without throwing', async () => {
  const http = { post: async () => ({ status: 200, data: {} }) };
  const odd: unknown[] = [
    undefined, null, 42, 'android', {}, { getPlatform: 'android' },
    phone('web', { CapacitorHttp: http }), phone('electron', { CapacitorHttp: http }),
    { getPlatform: () => { throw new Error('bridge gone'); }, Plugins: { CapacitorHttp: http } },
    phone('android', {}), { getPlatform: () => 'android', Plugins: null }, phone('ios', { CapacitorHttp: 5 }),
    phone('android', { CapacitorHttp: {} }), phone('android', { CapacitorHttp: { post: 'yes' } }),
    phone('android', { CapacitorHttp: { get post() { throw new Error('proxy'); } } }),
    { getPlatform: () => 'android', get Plugins() { throw new Error('proxy'); } },
  ];
  for (const value of odd) {
    await withGlobals({ Capacitor: value }, () => { assert.equal(nativeTransport(), undefined, String(value)); });
  }
  Object.defineProperty(globalThis, 'Capacitor', { configurable: true, get() { throw new Error('blocked'); } });
  try { assert.equal(nativeTransport(), undefined); } finally { delete page.Capacitor; }
});

test('startReplay sends through CapacitorHttp on a phone and through fetch everywhere else', async () => {
  const web = fakeFetch();
  const native: string[] = [];
  const http = { post: async (request: { url: string }) => { native.push(request.url); return { status: 200, data: '{"enabled":false}' }; } };
  await withGlobals({ fetch: web.fetch, Capacitor: phone('android', { CapacitorHttp: http }) }, async () => {
    await running({ endpoint: 'https://replay.test/', metadata }, async (replay) => {
      await drain();
      assert.equal(replay.getMetrics().errors, 0);
    });
  });
  assert.deepEqual(native, ['https://replay.test/api/replay/config']);
  assert.deepEqual(web.urls, []);

  for (const value of [undefined, 42, phone('web', { CapacitorHttp: http }), { getPlatform: () => { throw new Error('x'); } }, phone('ios', { CapacitorHttp: 5, App: 'x' })]) {
    const fallback = fakeFetch();
    await withGlobals({ fetch: fallback.fetch, Capacitor: value, document: fakeDocument('visible') }, async () => {
      await running({ endpoint: 'https://replay.test', metadata }, async (replay) => {
        await drain();
        assert.equal(replay.getMetrics().errors, 0);
      });
    });
    assert.deepEqual(fallback.urls, ['https://replay.test/api/replay/config'], JSON.stringify(value));
  }
  assert.equal(native.length, 1);
});

test('host options still win over detection', async () => {
  const { app, listeners } = fakeApp();
  const native: string[] = [];
  const http = { post: async (request: { url: string }) => { native.push(request.url); return { status: 200, data: {} }; } };
  const posted: string[] = [];
  let subscribed = 0;
  const options: ReplayOptions = {
    endpoint: 'https://replay.test', metadata,
    transport: { post: async (url) => { posted.push(url); return { enabled: false }; } },
    subscribeActive: () => { subscribed++; return () => {}; },
  };
  await withGlobals({ Capacitor: phone('android', { CapacitorHttp: http, App: app }) }, async () => {
    await running(options, drain);
  });
  assert.deepEqual(posted, ['https://replay.test/api/replay/config']);
  assert.deepEqual(native, []);
  assert.equal(subscribed, 1);
  assert.equal(listeners.length, 0);
});

test('on a phone, pause and resume come from the App plugin and never from visibilitychange', async () => {
  const doc = fakeDocument('visible');
  const { app, listeners, state } = fakeApp();
  await withGlobals({ document: doc, Capacitor: phone('android', { App: app }) }, async () => {
    const seen: boolean[] = [];
    const stop = autoLifecycle((active) => seen.push(active));
    await drain();
    assert.equal(doc.count('visibilitychange'), 0);
    listeners[0]({ isActive: false });
    listeners[0]({ isActive: true });
    listeners[0]({ isActive: 'yes' });
    listeners[0](undefined as unknown as { isActive?: unknown });
    assert.deepEqual(seen, [false, true]);
    stop(); stop();
    await drain();
    assert.equal(state.removed, 1);
    listeners[0]({ isActive: false });
    assert.deepEqual(seen, [false, true]);
  });
});

test('an App listener handle that arrives after stop is removed, and odd handles never throw', async () => {
  let removed = 0;
  let release: (() => void) | undefined;
  const late = { addListener: () => new Promise((resolve) => { release = () => resolve({ remove: () => { removed++; } }); }) };
  await withGlobals({ Capacitor: phone('ios', { App: late }) }, async () => {
    const stop = autoLifecycle(() => {});
    stop();
    release!();
    await drain();
    assert.equal(removed, 1);
  });

  const direct = { addListener: () => ({ remove: () => { removed++; throw new Error('already gone'); } }) };
  const rejected = { addListener: () => Promise.reject(new Error('no plugin')) };
  const failingRemove = { addListener: () => Promise.resolve({ remove: () => Promise.reject(new Error('bridge gone')) }) };
  const throwing = { addListener: () => { throw new Error('no plugin'); } };
  const listenerThrows = { addListener: (_event: string, listener: AppListener) => { listener({ isActive: false }); return undefined; } };
  for (const plugin of [direct, rejected, failingRemove, throwing, listenerThrows, { addListener: 'nope' }, 7]) {
    await withGlobals({ Capacitor: phone('android', { App: plugin }) }, async () => {
      const stop = autoLifecycle(() => { throw new Error('host listener'); });
      await drain();
      stop();
      await drain();
    });
  }
  assert.equal(removed, 2);
});

test('the web and Electron follow document visibility', async () => {
  const { app, listeners } = fakeApp();
  for (const capacitor of [undefined, phone('web', { App: app }), phone('electron', { App: app })]) {
    const doc = fakeDocument('visible');
    await withGlobals({ document: doc, Capacitor: capacitor }, () => {
      const seen: boolean[] = [];
      const stop = autoLifecycle((active) => seen.push(active));
      doc.visibilityState = 'hidden'; doc.fire('visibilitychange');
      doc.visibilityState = 'visible'; doc.fire('visibilitychange');
      assert.deepEqual(seen, [false, true]);
      stop();
      assert.equal(doc.count('visibilitychange'), 0);
    });
  }
  assert.equal(listeners.length, 0);
  await withGlobals({ document: undefined, Capacitor: undefined }, () => { autoLifecycle(() => {})(); });
});

test('the first active state comes from the page when the host does not give one', async () => {
  await withGlobals({ document: undefined }, () => { assert.equal(pageVisible(), true); });
  await withGlobals({ document: fakeDocument('hidden') }, () => { assert.equal(pageVisible(), false); });
  await withGlobals({ document: fakeDocument('visible') }, () => { assert.equal(pageVisible(), true); });

  const doc = fakeDocument('hidden');
  const { app, listeners, state } = fakeApp();
  const native: string[] = [];
  const http = { post: async (request: { url: string }) => { native.push(request.url); return { status: 200, data: { enabled: false } }; } };
  await withGlobals({ document: doc, Capacitor: phone('android', { CapacitorHttp: http, App: app }) }, async () => {
    await running({ endpoint: 'https://replay.test', metadata }, async () => {
      await drain();
      assert.equal(native.length, 1);
      listeners[0]({ isActive: true });
      await drain();
      assert.equal(native.length, 2, 'coming to the front after a hidden start checks the settings again');
      listeners[0]({ isActive: true });
      await drain();
      assert.equal(native.length, 2);
    });
    await drain();
    assert.equal(state.removed, 1);
  });

  const hidden = fakeDocument('hidden');
  const web = fakeFetch();
  await withGlobals({ document: hidden, fetch: web.fetch, Capacitor: undefined }, async () => {
    await running({ endpoint: 'https://replay.test', metadata }, async () => {
      await drain();
      hidden.visibilityState = 'visible'; hidden.fire('visibilitychange');
      await drain();
      assert.equal(web.urls.length, 2);
    });
    assert.equal(hidden.count('visibilitychange'), 0);
  });
});

test('startReplay checks the server rules with the page before opening a session', async () => {
  for (const [maskTextSelector, expected] of [['.chat!', ['config']], ['.chat', ['config', 'start']], ['.chat,', ['config']]] as const) {
    const web = fakeFetch({ config: { enabled: true, uploadIntervalMs: 25000, maskTextSelector, blockSelector: '' } });
    await withGlobals({ document: fakeDocument('visible'), fetch: web.fetch, Capacitor: undefined }, async () => {
      await running({ endpoint: 'https://replay.test', metadata }, async (replay) => {
        await drain();
        assert.equal(replay.getMetrics().errors, expected.length === 1 ? 1 : 0, maskTextSelector);
      });
    });
    assert.deepEqual(web.urls.map((url) => url.split('/').pop()), expected, maskTextSelector);
  }
});
