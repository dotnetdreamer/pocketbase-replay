import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVTOOLS_LIMITS, startDevtools } from '../src/devtools';
import { subscribeCapture } from '../src/observability-capture';
import type { AutomaticCapture } from '../src/observability-types';
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

// Methods on a prototype, as History's are in a browser.
class FakeHistory {
  constructor(private readonly go: (url: unknown) => void) {}
  pushState(_state: unknown, _title: string, url?: unknown) { this.go(url); return 'pushed'; }
  replaceState(_state: unknown, _title: string, url?: unknown) { this.go(url); return 'replaced'; }
}

class FakeXhr {
  readyState = 0;
  status = 0;
  private synchronous = false;
  private readonly listeners = new Map<string, (() => void)[]>();
  open(_method: string, _url: unknown, async = true) { this.readyState = 1; this.status = 0; this.synchronous = !async; return 'opened'; }
  send() {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    if (this.synchronous) this.finish(200, 'load');
    return 'sent';
  }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  finish(status: number, type: 'load' | 'error' | 'abort' | 'timeout') {
    this.status = status; this.readyState = 4;
    for (const name of [type, 'loadend']) for (const listener of this.listeners.get(name) ?? []) listener.call(this);
  }
}

function fakePage(href = 'https://app.test/start') {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const location = { href };
  return {
    location,
    history: new FakeHistory((url) => { if (url !== undefined && url !== null) location.href = new URL(String(url), location.href).href; }),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener); },
    fire: (type: string, event: unknown = {}) => { for (const listener of Array.from(listeners.get(type) ?? [])) listener(event); },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  } as Record<string, any>;
}

function fakeConsole(calls: { level: string; self: unknown; args: unknown[] }[] = []) {
  const methods: Record<string, (...args: unknown[]) => unknown> = {};
  for (const level of ['debug', 'info', 'log', 'warn', 'error']) {
    methods[level] = function (this: unknown, ...args: unknown[]) { calls.push({ level, self: this, args }); return `${level} done`; };
  }
  return methods;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const options = (extra: Partial<RecorderOptions> = {}): RecorderOptions => ({
  endpoint: 'https://pb.test/', metadata: () => ({ deviceId: 'device-one', platform: 'web', appVersion: '1' }), ...extra,
});
const payloads = (events: ReplayEvent[], tag: string) => events
  .filter((event) => event.type === 5 && event.data.tag === tag).map((event) => event.data.payload as Record<string, any>);

test('loads without a DOM and does nothing', async () => {
  assert.equal(typeof (globalThis as { window?: unknown }).window, 'undefined');
  const events: ReplayEvent[] = [];
  const fetchBefore = globalThis.fetch;
  const consoleBefore = console.log;
  const stop = startDevtools((event) => events.push(event), options({ recordNetwork: true, recordConsole: true }));
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(console.log, consoleBefore);
  assert.doesNotThrow(stop);
  assert.doesNotThrow(stop);
  assert.deepEqual(events, []);
});

test('records page changes without query, hash, credentials or tokens and skips repeats', async () => {
  const window = fakePage('https://app.test/start?invite=secret');
  const events: ReplayEvent[] = [];
  const jwt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(12)}`;
  await withGlobals({ window }, () => {
    const stop = startDevtools((event) => events.push(event), options());
    assert.ok(Object.prototype.hasOwnProperty.call(window.history, 'pushState'));
    window.history.replaceState({}, '', '/start?other=1');
    assert.equal(window.history.pushState({}, '', '/orders/42?secret=1#details'), 'pushed');
    window.history.replaceState({}, '', '/orders/42?page=2');
    window.history.pushState({}, '', `https://user:pass@app.test/reset/${jwt}`);
    window.location.href = 'https://app.test/back';
    window.fire('popstate');
    window.location.href = 'https://app.test/back#section';
    window.fire('hashchange');
    window.fire('popstate');
    assert.deepEqual(payloads(events, 'pbr/navigation').map((payload) => payload.url),
      ['https://app.test/orders/42', 'https://app.test/reset/[masked]', 'https://app.test/back']);
    assert.ok(events.every((event) => event.type === 5 && Number.isFinite(event.timestamp)));
    stop();
    assert.equal(Object.prototype.hasOwnProperty.call(window.history, 'pushState'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(window.history, 'replaceState'), false);
    assert.equal(window.count('popstate'), 0);
    assert.equal(window.count('hashchange'), 0);
    window.history.pushState({}, '', '/after');
    assert.equal(payloads(events, 'pbr/navigation').length, 3);
  });
});

test('network and console capture stay off unless the server turns them on', async () => {
  const window = fakePage();
  const fetch = async () => ({ status: 200 });
  window.fetch = fetch;
  window.XMLHttpRequest = FakeXhr;
  const open = FakeXhr.prototype.open;
  const console = fakeConsole();
  const log = console.log;
  await withGlobals({ window, console }, () => {
    const stop = startDevtools(() => {}, options({ recordNetwork: false }));
    assert.equal(window.fetch, fetch);
    assert.equal(FakeXhr.prototype.open, open);
    assert.equal(console.log, log);
    assert.equal(window.count('error'), 0);
    stop();
  });
});

test('configured private words are removed from decoded navigation and network paths without reading request values', async () => {
  const window = fakePage('https://app.test/start');
  const calls: unknown[][] = [];
  window.fetch = async (...args: unknown[]) => { calls.push(args); return { status: 200 }; };
  window.XMLHttpRequest = FakeXhr;
  const events: ReplayEvent[] = [];
  let words = ['Alice/Smith', 'a+b[1]', 'Zoë'];
  await withGlobals({ window }, async () => {
    const stop = startDevtools((event) => events.push(event), options({ recordNetwork: true, sensitiveText: () => words }));
    window.history.pushState({}, '', '/customers/%61LICE/%53mith?token=private#private');
    window.history.pushState({}, '', '/names/Z%6f%C3%AB');
    window.history.pushState({}, '', '/names/ALICE%2Fsmith%3Fstatus%23details');
    assert.deepEqual(payloads(events, 'pbr/navigation').map(({ url }) => url), [
      'https://app.test/customers/*', 'https://app.test/names/*', 'https://app.test/names/*%3Fstatus%23details',
    ]);
    const target = 'https://user:pass@api.test/items/%61%2Bb%5B1%5D?token=private#private';
    const init = { method: 'POST', get headers(): never { throw new Error('headers read'); }, get body(): never { throw new Error('body read'); } };
    await window.fetch(target, init);
    assert.equal(calls[0][0], target);
    assert.equal(calls[0][1], init);
    const xhr = new FakeXhr();
    xhr.open('GET', '/customers/%61lice/%73mith'); xhr.send(); xhr.finish(200, 'load');
    words = ['NextPrivate'];
    await window.fetch('/next/%6eEXTprivate');
    await window.fetch('/malformed/%E0%A4%A/NextPrivate');
    const longPrefix = 'https://api.test/' + 'x'.repeat(DEVTOOLS_LIMITS.urlChars - 'https://api.test/'.length - 2) + '/';
    await window.fetch(longPrefix + 'NextPrivate');
    assert.deepEqual(payloads(events, 'pbr/network').map(({ url }) => url), [
      'https://api.test/items/*', 'https://app.test/customers/*', 'https://app.test/next/*', 'https://app.test/*', longPrefix + '*',
    ]);
    assert.doesNotMatch(JSON.stringify(events), /alice|smith|zoë|a\+b\[1\]|nextprivate|private#|user:pass|%E0%A4/i);
    stop();
  });
});

test('sensitive URL path redaction cannot turn replay uploads into captured network requests', async () => {
  const window = fakePage('https://app.test/');
  window.fetch = async () => ({ status: 200 });
  window.XMLHttpRequest = FakeXhr;
  const events: ReplayEvent[] = [];
  await withGlobals({ window }, async () => {
    const stop = startDevtools((event) => events.push(event), options({ recordNetwork: true, sensitiveText: () => ['api', 'replay'] }));
    await window.fetch('https://pb.test/api/replay/chunks');
    const own = new FakeXhr(); own.open('POST', 'https://pb.test/api/replay/errors'); own.send(); own.finish(200, 'load');
    await window.fetch('https://api.test/api/items');
    assert.deepEqual(payloads(events, 'pbr/network').map(({ url }) => url), ['https://api.test/*/items']);
    stop();
  });
});

test('records fetch requests with status, whole-millisecond duration and finish time, and returns the original result', async () => {
  const window = fakePage('https://app.test/home');
  const calls: { self: unknown; args: unknown[] }[] = [];
  const pending: ReturnType<typeof deferred<unknown>>[] = [];
  window.fetch = function (this: unknown, ...args: unknown[]) {
    calls.push({ self: this, args });
    const next = deferred<unknown>();
    pending.push(next);
    return next.promise;
  };
  const events: ReplayEvent[] = [];
  await withGlobals({ window }, async () => {
    const stop = startDevtools((event) => events.push(event), options({ recordNetwork: true }));
    const response = { status: 201 };
    const started = Date.now();
    const first = window.fetch('https://api.test/items?q=private#x', { method: 'post', headers: { Authorization: 'secret' }, body: 'secret' });
    assert.equal(calls[0].self, window);
    assert.equal(calls[0].args[0], 'https://api.test/items?q=private#x');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const finishing = Date.now();
    pending[0].resolve(response);
    assert.equal(await first, response);
    const [request] = payloads(events, 'pbr/network');
    assert.deepEqual(Object.keys(request), ['kind', 'method', 'url', 'status', 'duration']);
    assert.deepEqual({ ...request, duration: 0 }, { kind: 'fetch', method: 'POST', url: 'https://api.test/items', status: 201, duration: 0 });
    assert.ok(Number.isInteger(request.duration) && request.duration >= 25, `duration ${request.duration}`);
    assert.ok(events[0].timestamp >= finishing && events[0].timestamp >= started + 25);
    assert.doesNotMatch(JSON.stringify(events), /secret|private|Authorization/);

    // A Request object, a URL object and a relative path.
    const requestLike = window.fetch({ url: 'https://api.test/orders/7?token=abc', method: 'delete' });
    pending[1].resolve({ status: 204 });
    await requestLike;
    const overridden = window.fetch({ url: 'https://api.test/orders/8', method: 'get' }, { method: 'PATCH' });
    pending[2].resolve({ status: 200 });
    await overridden;
    const url = window.fetch(new URL('https://api.test/u?x=1'));
    pending[3].resolve({ status: 404 });
    await url;
    const relative = window.fetch('/local/path?x=1');
    pending[4].resolve({ status: 500 });
    await relative;
    assert.deepEqual(payloads(events, 'pbr/network').slice(1).map((payload) => [payload.method, payload.url, payload.status]), [
      ['DELETE', 'https://api.test/orders/7', 204], ['PATCH', 'https://api.test/orders/8', 200],
      ['GET', 'https://api.test/u', 404], ['GET', 'https://app.test/local/path', 500],
    ]);

    // Failures keep their exact error and report what went wrong.
    const failures = [
      [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'abort'],
      [Object.assign(new Error('slow'), { name: 'TimeoutError' }), 'timeout'],
      [new TypeError('Failed to fetch'), 'error'],
    ] as const;
    for (const [error] of failures) {
      const failed = window.fetch('https://api.test/fail');
      pending[pending.length - 1].reject(error);
      await assert.rejects(failed, (thrown) => thrown === error);
    }
    assert.deepEqual(payloads(events, 'pbr/network').slice(5).map((payload) => [payload.status, payload.failed]),
      failures.map(([, failed]) => [0, failed]));
    stop();
    assert.notEqual(typeof window.fetch, 'undefined');
  });
});

test('skips only the replay and diagnostics API on the replay server', async () => {
  const window = fakePage('https://app.test/');
  window.fetch = async () => ({ status: 200 });
  window.XMLHttpRequest = FakeXhr;
  const events: ReplayEvent[] = [];
  await withGlobals({ window }, async () => {
    const stop = startDevtools((event) => events.push(event), options({ recordNetwork: true, endpoint: 'https://pb.test///' }));
    for (const url of ['https://pb.test/api/replay/chunks', 'https://pb.test/api/replay/observability/config',
      'https://pb.test/api/replay?x=1', 'https://pb.test/api/collections/posts/records', 'https://pb.test/api/replays', 'https://pb.testing.example/api/replay/chunks']) {
      await window.fetch(url, { method: 'POST' });
    }
    const xhr = new FakeXhr();
    xhr.open('POST', 'https://pb.test/api/replay/errors');
    xhr.send();
    xhr.finish(200, 'load');
    assert.deepEqual(payloads(events, 'pbr/network').map((payload) => payload.url),
      ['https://pb.test/api/collections/posts/records', 'https://pb.test/api/replays', 'https://pb.testing.example/api/replay/chunks']);
    stop();
  });
});

test('records each XMLHttpRequest once, including failures, synchronous requests and reuse', async () => {
  const window = fakePage('https://app.test/');
  window.XMLHttpRequest = FakeXhr;
  const { open, send } = FakeXhr.prototype;
  const events: ReplayEvent[] = [];
  await withGlobals({ window }, () => {
    const stop = startDevtools((event) => events.push(event), options({ recordNetwork: true }));
    const xhr = new FakeXhr();
    assert.equal(xhr.open('get', '/api/items?q=1'), 'opened');
    assert.equal(xhr.send(), 'sent');
    xhr.finish(200, 'load');
    xhr.finish(200, 'load');
    for (const type of ['error', 'abort', 'timeout'] as const) {
      xhr.open('PUT', 'https://api.test/save');
      xhr.send();
      xhr.finish(0, type);
    }
    const synchronous = new FakeXhr();
    synchronous.open('GET', '/sync', false);
    synchronous.send();
    // Opened again before the first request finished: only the second is reported.
    const reopened = new FakeXhr();
    reopened.open('GET', '/first');
    reopened.send();
    reopened.open('GET', '/second');
    reopened.send();
    reopened.finish(503, 'load');
    // A send that throws reaches the app unchanged and records nothing.
    assert.throws(() => new FakeXhr().send(), /InvalidStateError/);
    assert.deepEqual(payloads(events, 'pbr/network').map(({ kind, method, url, status, failed }) => [kind, method, url, status, failed]), [
      ['xhr', 'GET', 'https://app.test/api/items', 200, undefined],
      ['xhr', 'PUT', 'https://api.test/save', 0, 'error'],
      ['xhr', 'PUT', 'https://api.test/save', 0, 'abort'],
      ['xhr', 'PUT', 'https://api.test/save', 0, 'timeout'],
      ['xhr', 'GET', 'https://app.test/sync', 200, undefined],
      ['xhr', 'GET', 'https://app.test/second', 503, undefined],
    ]);
    assert.ok(payloads(events, 'pbr/network').every((payload) => Number.isInteger(payload.duration) && payload.duration >= 0));
    stop();
    assert.equal(FakeXhr.prototype.open, open);
    assert.equal(FakeXhr.prototype.send, send);
    // Listeners left on a used object stay quiet once capture stops.
    xhr.open('GET', '/late');
    xhr.send();
    xhr.finish(200, 'load');
    assert.equal(payloads(events, 'pbr/network').length, 6);
  });
});

test('records console output and uncaught errors with private text redacted', async () => {
  const window = fakePage();
  const calls: { level: string; self: unknown; args: unknown[] }[] = [];
  const console = fakeConsole(calls);
  const originals = { ...console };
  const events: ReplayEvent[] = [];
  await withGlobals({ window, console }, () => {
    const stop = startDevtools((event) => events.push(event), options({ recordConsole: true, sensitiveText: () => ['Alice Smith'] }));
    const argument = { password: 'hunter2', count: 2, nested: { email: 'alice@example.com' } };
    assert.equal(console.log('Hello Alice Smith', argument, 5, null, undefined), 'log done');
    assert.equal(calls[0].self, console);
    assert.deepEqual(calls[0].args, ['Hello Alice Smith', argument, 5, null, undefined]);
    console.error(new TypeError('bad token=abc123 for alice@example.com'));
    console.warn('Bearer abc.def.ghi at https://api.test/path?key=1#frag');
    console.debug('debug'); console.info('info');
    console.log('x'.repeat(5000));
    window.fire('error', { error: new RangeError('Too deep'), message: 'Uncaught RangeError: Too deep' });
    window.fire('error', { error: null, message: 'Uncaught Script error.' });
    window.fire('unhandledrejection', { reason: new Error('nope') });
    window.fire('unhandledrejection', { reason: 'plain reason' });
    window.fire('unhandledrejection', { reason: undefined });
    const logged = payloads(events, 'pbr/console');
    assert.deepEqual(logged.slice(0, 5), [
      { level: 'log', text: 'Hello [redacted] {"password":"[redacted]","count":2,"nested":{"email":"[redacted]"}} 5 null undefined' },
      { level: 'error', text: 'TypeError: bad token=[redacted] for [redacted]' },
      { level: 'warn', text: 'Bearer [redacted] at https://api.test/path' },
      { level: 'debug', text: 'debug' },
      { level: 'info', text: 'info' },
    ]);
    assert.equal(logged[5].text.length, DEVTOOLS_LIMITS.textChars);
    assert.deepEqual(logged.slice(6), [
      { level: 'error', text: 'Uncaught RangeError: Too deep', uncaught: true },
      { level: 'error', text: 'Uncaught Script error.', uncaught: true },
      { level: 'error', text: 'Uncaught (in promise) Error: nope', uncaught: true },
      { level: 'error', text: 'Uncaught (in promise) plain reason', uncaught: true },
      { level: 'error', text: 'Uncaught (in promise) undefined', uncaught: true },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /hunter2|alice@example|Alice Smith|abc123|key=1/);
    // An error's name and message are enough; its stack is never formatted, and a throwing getter is survived.
    let stackReads = 0;
    const tracked = new SyntaxError('tracked');
    Object.defineProperty(tracked, 'stack', { get: () => { stackReads++; return 'at secret.js:1:1'; } });
    const hostile = new Error('hidden');
    Object.defineProperty(hostile, 'message', { get: () => { throw new Error('getter failed'); } });
    console.warn('Problems:', tracked, hostile);
    assert.equal(stackReads, 0);
    assert.equal(payloads(events, 'pbr/console').at(-1)!.text, 'Problems: SyntaxError: tracked Error');
    stop();
    for (const level of Object.keys(originals)) assert.equal(console[level], originals[level]);
    assert.equal(window.count('error'), 0);
    assert.equal(window.count('unhandledrejection'), 0);
    console.log('after stop');
    assert.equal(payloads(events, 'pbr/console').length, logged.length + 1);
  });
});

test('console hooks chain with diagnostics capture in either start and stop order', async () => {
  const diagnostics = { endpoint: 'https://pb.test', metadata: () => ({ deviceId: 'device-one', platform: 'web', appVersion: '1' }), logs: { captureConsole: true } };
  for (const order of [['devtools', 'diagnostics'], ['diagnostics', 'devtools']] as const) {
    for (const stopOrder of [order, [...order].reverse()]) {
      const calls: { level: string; self: unknown; args: unknown[] }[] = [];
      const console = fakeConsole(calls);
      const original = console.info;
      await withGlobals({ window: fakePage(), console }, () => {
        const events: ReplayEvent[] = [], captures: AutomaticCapture[] = [];
        const stops: Record<string, () => void> = {};
        for (const name of order) {
          stops[name] = name === 'devtools' ? startDevtools((event) => events.push(event), options({ recordConsole: true }))
            : subscribeCapture((capture) => captures.push(capture), diagnostics);
        }
        console.info('both');
        assert.equal(calls.length, 1);
        assert.equal(events.length, 1);
        assert.equal(captures.length, 1);
        stops[stopOrder[0]]();
        console.info('one');
        assert.equal(calls.length, 2);
        assert.equal(events.length, stopOrder[0] === 'devtools' ? 1 : 2);
        assert.equal(captures.length, stopOrder[0] === 'devtools' ? 2 : 1);
        stops[stopOrder[1]]();
        console.info('none');
        assert.equal(calls.length, 3);
        assert.deepEqual(calls.map((call) => call.args[0]), ['both', 'one', 'none']);
        assert.equal(events.length + captures.length, 3);
        // Both stopped: at most an inactive wrapper is left, and a new capture starts cleanly on top of it.
        const restarted = startDevtools((event) => events.push(event), options({ recordConsole: true }));
        console.info('again');
        assert.equal(events.length + captures.length, 4);
        restarted();
        if (stopOrder[1] === 'devtools' && order[0] === 'devtools') assert.equal(console.info, original);
      });
    }
  }
});

test('drops events beyond each per-minute allowance with one notice per window', async () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const window = fakePage('https://app.test/0');
    window.fetch = async () => ({ status: 200 });
    const calls: { level: string; self: unknown; args: unknown[] }[] = [];
    const console = fakeConsole(calls);
    const events: ReplayEvent[] = [];
    await withGlobals({ window, console }, async () => {
      const stop = startDevtools((event) => events.push(event), options({ recordConsole: true, recordNetwork: true }));
      for (let index = 0; index < 150; index++) console.log(`message ${index}`);
      assert.equal(calls.length, 150);
      let logged = payloads(events, 'pbr/console');
      assert.equal(logged.length, DEVTOOLS_LIMITS.console + 1);
      assert.deepEqual(logged[DEVTOOLS_LIMITS.console], { level: 'warn', text: 'Replay skipped console messages: more than 100 in a minute' });
      assert.equal(logged[DEVTOOLS_LIMITS.console - 1].text, 'message 99');
      for (let index = 0; index < 120; index++) await window.fetch(`https://api.test/${index}`);
      assert.equal(payloads(events, 'pbr/network').length, DEVTOOLS_LIMITS.network);
      for (let index = 1; index <= 60; index++) window.history.pushState({}, '', `/${index}`);
      assert.equal(payloads(events, 'pbr/navigation').length, DEVTOOLS_LIMITS.navigation);
      logged = payloads(events, 'pbr/console');
      assert.deepEqual(logged.slice(-2).map((payload) => payload.text), [
        'Replay skipped network requests: more than 100 in a minute', 'Replay skipped page changes: more than 50 in a minute']);
      now += DEVTOOLS_LIMITS.windowMs - 1;
      console.log('still dropped');
      assert.equal(payloads(events, 'pbr/console').length, logged.length);
      now += 1;
      console.log('new window');
      assert.equal(payloads(events, 'pbr/console').at(-1)!.text, 'new window');
      // A clock set back starts a new window rather than stalling capture.
      for (let index = 0; index < 120; index++) console.log('burst');
      now -= 3_600_000;
      console.log('after the clock moved back');
      assert.equal(payloads(events, 'pbr/console').at(-1)!.text, 'after the clock moved back');
      assert.ok(events.slice(0, -1).every((event, index) => !index || event.timestamp >= events[index - 1].timestamp));
      stop();
    });
  } finally { Date.now = realNow; }
});

test('restores only what is still its own and stays inert under a later wrapper', async () => {
  const window = fakePage();
  const originalOpen = FakeXhr.prototype.open;
  let fetched = 0;
  window.fetch = async () => { fetched++; return { status: 200 }; };
  window.XMLHttpRequest = FakeXhr;
  const console = fakeConsole();
  const events: ReplayEvent[] = [];
  await withGlobals({ window, console }, async () => {
    const stop = startDevtools((event) => events.push(event), options({ recordConsole: true, recordNetwork: true }));
    const later: Record<string, number> = {};
    const wrap = (owner: Record<string, any>, key: string) => {
      const previous = owner[key];
      const wrapper = function (this: unknown, ...args: unknown[]) { later[key] = (later[key] ?? 0) + 1; return previous.apply(this, args); };
      owner[key] = wrapper;
      return wrapper;
    };
    const wrappers = {
      fetch: wrap(window, 'fetch'), open: wrap(FakeXhr.prototype as unknown as Record<string, any>, 'open'),
      pushState: wrap(window.history, 'pushState'), warn: wrap(console, 'warn'),
    };
    stop();
    assert.equal(window.fetch, wrappers.fetch);
    assert.equal(FakeXhr.prototype.open, wrappers.open);
    assert.equal(window.history.pushState, wrappers.pushState);
    assert.equal(console.warn, wrappers.warn);
    await window.fetch('https://api.test/x');
    const xhr = new FakeXhr();
    xhr.open('GET', '/x');
    xhr.send();
    xhr.finish(200, 'load');
    window.history.pushState({}, '', '/moved');
    assert.equal(console.warn('quiet'), 'warn done');
    assert.equal(fetched, 1);
    assert.deepEqual(later, { fetch: 1, open: 1, pushState: 1, warn: 1 });
    assert.equal(window.location.href, 'https://app.test/moved');
    assert.deepEqual(events, []);
  });
  FakeXhr.prototype.open = originalOpen;
});

test('the recorder installs no page hooks when rrweb cannot start', async () => {
  const window = fakePage();
  window.fetch = async () => ({ status: 200 });
  const console = fakeConsole();
  await withGlobals({ window, console }, async () => {
    const { recorder } = await import('../src/recorder');
    const { fetch } = window, { log } = console;
    let stop: unknown;
    // Without a real DOM rrweb either throws or returns nothing; both leave the page untouched.
    try { stop = recorder.start(() => {}, options({ recordNetwork: true, recordConsole: true })); } catch { stop = undefined; }
    assert.equal(stop, undefined);
    assert.equal(window.fetch, fetch);
    assert.equal(console.log, log);
    assert.equal(Object.prototype.hasOwnProperty.call(window.history, 'pushState'), false);
    assert.equal(window.count('popstate'), 0);
  });
});

test('never lets a failing hook, a throwing original or a re-entrant call reach the app', async () => {
  const window = fakePage();
  const failure = new Error('original failed');
  window.fetch = () => { throw failure; };
  const console = fakeConsole();
  console.error = () => { throw failure; };
  let emitted = 0;
  await withGlobals({ window, console }, async () => {
    const stop = startDevtools(() => {
      emitted++;
      console.log('logged while emitting');
      throw new Error('engine failed');
    }, options({ recordConsole: true, recordNetwork: true, sensitiveText: () => { console.info('host callback'); throw new Error('host failed'); } }));
    assert.throws(() => window.fetch('https://api.test'), (error) => error === failure);
    assert.throws(() => console.error('boom'), (error) => error === failure);
    assert.equal(console.log('fine'), 'log done');
    window.history.pushState({}, '', '/next');
    assert.equal(window.location.href, 'https://app.test/next');
    // The error call never returned, so nothing was captured for it; the log and the page change were.
    assert.equal(emitted, 2);
    stop();
  });
  const frozen = Object.freeze(fakeConsole());
  await withGlobals({ window: fakePage(), console: frozen }, () => {
    const stop = startDevtools(() => {}, options({ recordConsole: true }));
    assert.equal(frozen.log('still works'), 'log done');
    stop();
  });
});
