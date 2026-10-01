import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { createReplay, REPLAY_LIMITS } from '../src/engine';
import { fetchTransport, ReplayHttpError } from '../src/index';
import { serializeEvent } from '../src/privacy';
import type { ReplayChunk, ReplayEvent, ReplayMetadata, ReplayOptions, ReplayRuntime } from '../src/types';

async function settle(): Promise<void> { for (let i = 0; i < 25; i++) await Promise.resolve(); }

interface HarnessSetup {
  enabled?: boolean;
  offline?: boolean;
  options?: Partial<ReplayOptions>;
  rules?: Record<string, unknown>;
  validSelector?: (selector: string) => boolean;
}

function harness(initial: HarnessSetup = {}) {
  let now = 1790500000000;
  let clock = 0;
  let enabled = initial.enabled !== false;
  let offline = initial.offline === true;
  let failureStatus = 0;
  let configStatus = 0;
  let startStatus = 0;
  let startExtra: Record<string, unknown> = {};
  let rules = initial.rules ?? {};
  const captured: ReplayOptions[] = [];
  let loads = 0;
  let starts = 0;
  let stops = 0;
  let removed = 0;
  let sessionNumber = 0;
  let held: Promise<void> | undefined;
  let refuseBeacon: (chunk: ReplayChunk) => boolean = () => false;
  let callback: ((event: ReplayEvent) => void) | undefined;
  let activity: ((active: boolean, unloading?: boolean) => void) | undefined;
  let metadata: ReplayMetadata = { deviceId: 'device-one', platform: 'web', appVersion: '1.0', room: '' };
  const timers = new Map<number, { callback: () => void; at: number }>();
  let timerId = 0;
  const requests: { url: string; body: string }[] = [];
  const attempts: ReplayChunk[] = [];
  const accepted: ReplayChunk[] = [];
  const beacons: ReplayChunk[] = [];
  const snapshot = () => {
    callback?.({ type: 4, timestamp: now++, data: { href: 'https://example.test/?secret=yes#token', width: 400, height: 800 } });
    callback?.({ type: 2, timestamp: now++, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } });
  };
  const runtime: ReplayRuntime = {
    now: () => now, performanceNow: () => clock += 0.01,
    schedule: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, at: now + ms }); return id; },
    cancel: (timer) => { timers.delete(timer as number); },
    loadRecorder: async () => {
      loads++;
      return { start: (emit, options) => { captured.push(options); callback = emit; starts++; snapshot(); return () => { stops++; callback = undefined; }; }, snapshot };
    },
    compress: async (raw) => gzipSync(strToU8(raw)),
    compressSync: (raw) => gzipSync(strToU8(raw)),
    subscribe: (active) => { activity = active; return () => { removed++; activity = undefined; }; },
    validSelector: initial.validSelector,
  };
  const controller = createReplay({
    endpoint: 'https://replay.test', metadata: () => metadata,
    ...initial.options,
    transport: {
      post: async (url, body) => {
        requests.push({ url, body });
        if (url.endsWith('/config') || url.endsWith('/start')) {
          if (offline) throw new TypeError('Failed to fetch');
          if (url.endsWith('/config')) {
            if (configStatus) throw new ReplayHttpError(configStatus);
            return { enabled, uploadIntervalMs: 25000, ...rules };
          }
          if (startStatus) throw new ReplayHttpError(startStatus);
          return { enabled, sessionId: `session-${++sessionNumber}`, token: 'upload-secret', expiresAt: now + 14400000, ...rules, ...startExtra };
        }
        const chunk = JSON.parse(body) as ReplayChunk;
        attempts.push(chunk);
        if (held) await held;
        if (offline) throw new TypeError('Failed to fetch');
        if (failureStatus) throw new ReplayHttpError(failureStatus);
        accepted.push(chunk);
        return { ok: true };
      },
      beacon: (_url, body) => {
        const chunk = JSON.parse(body) as ReplayChunk;
        if (refuseBeacon(chunk)) return false;
        beacons.push(chunk);
        return true;
      },
    },
  }, runtime);
  return {
    controller, runtime, requests, attempts, accepted, beacons, timers, captured,
    rules: (value: Record<string, unknown>) => { rules = value; },
    enabled: (value: boolean) => { enabled = value; }, offline: (value: boolean) => { offline = value; },
    failureStatus: (value: number) => { failureStatus = value; },
    configStatus: (value: number) => { configStatus = value; },
    startStatus: (value: number) => { startStatus = value; },
    startReply: (value: Record<string, unknown>) => { startExtra = value; },
    holdUploads: () => { let release = () => {}; held = new Promise((resolve) => { release = () => { held = undefined; resolve(); }; }); return release; },
    refuseBeacon: (value: (chunk: ReplayChunk) => boolean) => { refuseBeacon = value; },
    metadata: (value: Partial<ReplayMetadata>) => { metadata = { ...metadata, ...value }; },
    activity: (value: boolean, unloading = false) => activity?.(value, unloading),
    counts: () => ({ loads, starts, stops, removed, sessionNumber }),
    emit: (text = 'menu opened') => callback?.({ type: 3, timestamp: now++, data: { source: 0, texts: [{ id: 2, value: text }], attributes: [], removes: [], adds: [] } }),
    raw: (event: ReplayEvent) => callback?.(event),
    advance: async (ms: number) => {
      now += ms;
      const ready = Array.from(timers.entries()).filter(([, timer]) => timer.at <= now);
      for (const [id, timer] of ready) { timers.delete(id); timer.callback(); await settle(); }
      await settle();
    },
  };
}

function events(chunk: ReplayChunk): ReplayEvent[] {
  return JSON.parse(strFromU8(gunzipSync(Uint8Array.from(Buffer.from(chunk.data, 'base64'))))) as ReplayEvent[];
}

function texts(chunk: ReplayChunk): string[] {
  return events(chunk).flatMap((event) => (event.data.texts as { value: string }[] | undefined ?? []).map((text) => text.value));
}

test('disabled sampling never loads rrweb; a settings refresh starts and stops capture', async () => {
  const h = harness({ enabled: false });
  await settle();
  assert.equal(h.counts().loads, 0);
  h.enabled(true);
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().loads, 1);
  assert.equal(h.controller.getMetrics().recording, true);
  h.emit();
  h.enabled(false);
  await h.controller.refresh();
  await h.controller.flush();
  assert.equal(h.controller.getMetrics().recording, false);
  assert.equal(h.controller.getMetrics().bufferedBytes, 0);
  assert.equal(h.controller.getMetrics().queuedBytes, 0);
  h.controller.stop();
});

test('records a full snapshot, masks URLs, compresses and uploads a bounded envelope', async () => {
  const h = harness(); await settle();
  h.emit('shop opened');
  await h.controller.flush();
  assert.equal(h.accepted.length, 1);
  const chunk = h.accepted[0];
  assert.equal(chunk.seq, 0);
  assert.equal(chunk.hasSnapshot, true);
  assert.equal(chunk.eventCount, 3);
  assert.equal(events(chunk)[0].data.href, 'https://example.test/');
  assert.match(JSON.stringify(events(chunk)), /shop opened/);
  assert.equal(chunk.rawBytes, Buffer.byteLength(JSON.stringify(events(chunk))));
  assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < REPLAY_LIMITS.targetBodyBytes);
  assert.ok(h.controller.getMetrics().mainThreadMs > 0);
  h.controller.stop();
});

test('a transient failure retries the identical session and sequence', async () => {
  const h = harness(); await settle();
  h.offline(true);
  await h.controller.flush();
  h.offline(false);
  await h.advance(REPLAY_LIMITS.retryMs);
  await h.controller.flush();
  assert.equal(h.attempts.length, 2);
  assert.deepEqual(h.attempts[0], h.attempts[1]);
  assert.equal(h.accepted.length, 1);
  h.controller.stop();
});

test('offline overflow drops old deltas and resumes with a full snapshot', async () => {
  const h = harness(); await settle();
  h.offline(true);
  for (let i = 0; i < REPLAY_LIMITS.queueChunks + 1; i++) {
    h.emit(`menu ${i}`);
    await h.controller.flush();
    await h.advance(0);
  }
  assert.ok(h.controller.getMetrics().droppedChunks > 0);
  assert.ok(h.controller.getMetrics().queuedBytes <= REPLAY_LIMITS.queueBytes);
  assert.ok(h.controller.getMetrics().bufferedBytes <= REPLAY_LIMITS.rawQueueBytes);
  h.offline(false);
  await h.advance(REPLAY_LIMITS.retryMs);
  await h.controller.flush();
  assert.ok(h.accepted.length > 0);
  assert.equal(h.accepted[0].hasSnapshot, true);
  assert.ok(events(h.accepted[0]).some((event) => event.type === 2));
  h.controller.stop();
});

test('config poll failures from the network, 429 or 5xx keep the session, queue and capture', async () => {
  for (const failure of ['network', 429, 503] as const) {
    const h = harness(); await settle();
    h.emit('before outage');
    h.failureStatus(503); await h.controller.flush();
    const queued = h.controller.getMetrics().queuedBytes;
    assert.ok(queued > 0);
    if (failure === 'network') h.offline(true); else h.configStatus(failure);
    await h.controller.refresh();
    let metrics = h.controller.getMetrics();
    assert.equal(metrics.sessionId, 'session-1', String(failure));
    assert.equal(metrics.recording, true);
    assert.equal(metrics.queuedBytes, queued);
    await h.advance(REPLAY_LIMITS.configIntervalMs);
    metrics = h.controller.getMetrics();
    assert.equal(metrics.sessionId, 'session-1');
    assert.equal(metrics.recording, true);
    assert.ok(metrics.queuedBytes >= queued);
    assert.equal(h.counts().stops, 0);
    h.emit('during outage');
    h.offline(false); h.configStatus(0); h.failureStatus(0);
    await h.advance(REPLAY_LIMITS.maxRetryMs); await h.controller.flush();
    assert.equal(h.counts().sessionNumber, 1);
    assert.deepEqual(h.accepted.map((chunk) => chunk.sessionId), h.accepted.map(() => 'session-1'));
    assert.deepEqual(h.accepted.map((chunk) => chunk.seq), h.accepted.map((_chunk, index) => index));
    assert.equal(h.accepted[0].hasSnapshot, true);
    const uploaded = h.accepted.flatMap(texts);
    assert.ok(uploaded.includes('before outage'));
    assert.ok(uploaded.includes('during outage'));
    h.controller.stop();
  }
});

test('a failed poll before any session simply tries again at the next poll', async () => {
  const h = harness({ offline: true }); await settle();
  assert.equal(h.controller.getMetrics().sessionId, null);
  assert.equal(h.counts().loads, 0);
  h.offline(false); h.startStatus(429);
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.controller.getMetrics().sessionId, null);
  h.startStatus(0);
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  assert.equal(h.controller.getMetrics().recording, true);
  h.controller.stop();
});

test('an auth or other client error on the config poll turns recording off', async () => {
  for (const status of [401, 403, 400]) {
    const h = harness(); await settle();
    h.failureStatus(503); await h.controller.flush();
    h.configStatus(status); await h.controller.refresh();
    const metrics = h.controller.getMetrics();
    assert.equal(metrics.sessionId, null, String(status));
    assert.equal(metrics.recording, false);
    assert.equal(metrics.queuedBytes, 0);
    assert.equal(metrics.bufferedBytes, 0);
    h.controller.stop();
  }
});

test('a rejected chunk is dropped for a fresh snapshot, and three rejections in a row stop recording', async () => {
  const h = harness(); await settle();
  h.failureStatus(400); await h.controller.flush();
  assert.equal(h.attempts.length, 1);
  assert.equal(h.controller.getMetrics().queuedBytes, 0);
  assert.ok(h.controller.getMetrics().droppedChunks >= 1);
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  await h.advance(0); await h.controller.flush();
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[1].seq, 1);
  assert.equal(h.attempts[1].hasSnapshot, true);
  await h.advance(5000); await h.controller.flush();
  assert.equal(h.attempts.length, 3);
  assert.equal(h.controller.getMetrics().sessionId, null);
  assert.equal(h.controller.getMetrics().recording, false);
  h.failureStatus(0);
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().sessionNumber, 1);
  assert.equal(h.counts().starts, 1);
  h.controller.stop();
});

test('an accepted chunk resets the rejection count', async () => {
  const h = harness(); await settle();
  h.failureStatus(409); await h.controller.flush();
  await h.advance(0);
  h.failureStatus(0); await h.controller.flush();
  assert.equal(h.accepted.length, 1);
  h.failureStatus(422);
  h.emit('one'); await h.controller.flush();
  await h.advance(5000); await h.controller.flush();
  assert.equal(h.attempts.length, 4);
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  assert.equal(h.controller.getMetrics().recording, true);
  h.controller.stop();
});

test('server errors on upload back off before resending, and a success resets the delay', async () => {
  const h = harness(); await settle();
  h.failureStatus(503); await h.controller.flush();
  assert.equal(h.attempts.length, 1);
  await h.controller.flush();
  await h.advance(REPLAY_LIMITS.retryMs - 1000); await h.controller.flush();
  assert.equal(h.attempts.length, 1);
  await h.advance(1000); await h.controller.flush();
  assert.equal(h.attempts.length, 2);
  await h.advance(REPLAY_LIMITS.retryMs * 2 - 1000); await h.controller.flush();
  assert.equal(h.attempts.length, 2);
  h.failureStatus(0);
  await h.advance(1000); await h.controller.flush();
  assert.equal(h.attempts.length, 3);
  assert.equal(h.accepted.length, 1);
  assert.deepEqual(h.attempts.map((chunk) => chunk.seq), [0, 0, 0]);
  h.failureStatus(503);
  h.emit('later'); await h.controller.flush();
  assert.equal(h.attempts.length, 4);
  await h.advance(REPLAY_LIMITS.retryMs); await h.controller.flush();
  assert.equal(h.attempts.length, 5);
  assert.equal(h.attempts[4].seq, 1);
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  h.controller.stop();
});

test('a clock stepped back during a back-off does not stretch the wait', async () => {
  const h = harness(); await settle();
  h.failureStatus(503); await h.controller.flush();
  assert.equal(h.attempts.length, 1);
  await h.advance(-3600000);
  h.failureStatus(0); await h.controller.flush();
  assert.equal(h.attempts.length, 2);
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0].seq, 0);
  h.controller.stop();
});

test('a clock stepped back does not stretch the wait before a recovery snapshot', async () => {
  const h = harness(); await settle();
  h.failureStatus(400); await h.controller.flush();
  await h.advance(0);
  await h.advance(-3600000);
  await h.controller.flush();
  assert.equal(h.attempts.length, 2);
  h.failureStatus(0);
  await h.advance(5000); await h.controller.flush();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0].hasSnapshot, true);
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  h.controller.stop();
});

test('identity changes discard private pending data and mint another session', async () => {
  const h = harness(); await settle();
  h.offline(true); h.emit('old account view'); await h.controller.flush();
  h.offline(false);
  h.metadata({ accountId: 'account-two', authToken: 'private-token' });
  await h.controller.refresh();
  h.emit('new account view'); await h.controller.flush();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0].sessionId, 'session-2');
  assert.equal(h.accepted[0].seq, 0);
  assert.doesNotMatch(JSON.stringify(events(h.accepted[0])), /old account view|private-token/);
  h.controller.stop();
});

test('the main auth token is sent only together with an account id', async () => {
  const h = harness(); await settle();
  const lastConfig = () => JSON.parse(h.requests.filter((request) => request.url.endsWith('/config')).pop()!.body) as ReplayMetadata;
  h.metadata({ authToken: 'main-token' }); await h.controller.refresh();
  assert.equal(lastConfig().authToken, '');
  h.metadata({ accountId: 'account-one' }); await h.controller.refresh();
  assert.equal(lastConfig().authToken, 'main-token');
  h.metadata({ accountId: '' }); await h.controller.refresh();
  assert.equal(lastConfig().authToken, '');
  h.controller.stop();
});

test('room boundaries retain each event under its own room', async () => {
  const h = harness(); await settle();
  h.emit('lobby');
  h.metadata({ room: 'ABCDE' }); h.emit('room A');
  await h.controller.flush();
  h.metadata({ room: 'PABCDE' }); h.emit('room B');
  await h.controller.flush();
  assert.deepEqual(h.accepted.map((chunk) => chunk.room), ['', 'ABCDE', 'PABCDE']);
  assert.match(JSON.stringify(events(h.accepted[1])), /room A/);
  h.controller.stop();
});

test('a clock that steps backwards never produces a chunk that ends before it starts', async () => {
  const h = harness(); await settle();
  h.raw({ type: 3, timestamp: 1790400000000, data: { source: 0, texts: [], attributes: [], removes: [], adds: [] } });
  await h.controller.flush();
  assert.equal(h.accepted.length, 1);
  assert.equal(h.accepted[0].endedAt, h.accepted[0].startedAt);
  h.controller.stop();
});

test('an expired or full session is replaced straight away', async () => {
  const h = harness(); await settle();
  h.failureStatus(410); await h.controller.flush();
  h.failureStatus(0); await settle();
  assert.equal(h.controller.getMetrics().sessionId, 'session-2');
  assert.equal(h.controller.getMetrics().recording, true);
  await h.controller.flush();
  assert.equal(h.accepted[0].sessionId, 'session-2');
  assert.equal(h.accepted[0].seq, 0);
  assert.equal(h.accepted[0].hasSnapshot, true);
  h.controller.stop();
});

test('a session rolls over to a new one instead of sending seq 2048', async () => {
  const h = harness(); await settle();
  assert.equal(REPLAY_LIMITS.sessionChunks, 2048);
  for (let i = 0; i < REPLAY_LIMITS.sessionChunks; i++) { h.emit(`tap ${i}`); await h.controller.flush(); }
  assert.equal(h.accepted.length, REPLAY_LIMITS.sessionChunks);
  assert.equal(h.accepted[h.accepted.length - 1].seq, REPLAY_LIMITS.sessionChunks - 1);
  h.emit('one more'); await h.controller.flush(); await settle();
  assert.equal(h.controller.getMetrics().sessionId, 'session-2');
  await h.controller.flush();
  const next = h.accepted[REPLAY_LIMITS.sessionChunks];
  assert.equal(next.sessionId, 'session-2');
  assert.equal(next.seq, 0);
  assert.equal(next.hasSnapshot, true);
  assert.ok(h.attempts.every((chunk) => chunk.seq < REPLAY_LIMITS.sessionChunks));
  h.controller.stop();
});

test('pause flushes once, resume takes a snapshot, stop removes every listener and timer', async () => {
  const h = harness(); await settle();
  h.emit(); h.activity(false); await settle();
  assert.equal(h.counts().stops, 1);
  assert.equal(h.accepted.length, 1);
  h.activity(false); await settle();
  assert.equal(h.counts().stops, 1);
  h.activity(true); await settle();
  assert.equal(h.counts().starts, 2);
  await h.controller.flush();
  assert.equal(h.accepted[1].hasSnapshot, true);
  h.controller.stop(); h.controller.stop();
  assert.equal(h.counts().removed, 1);
  assert.equal(h.timers.size, 0);
});

test('pagehide sends a small compressed tail and retains it for idempotent resume', async () => {
  const h = harness(); await settle();
  await h.controller.flush();
  h.emit('last tap'); h.activity(false, true);
  assert.equal(h.beacons.length, 1);
  assert.match(JSON.stringify(events(h.beacons[0])), /last tap/);
  h.activity(true); await settle(); await h.controller.flush();
  assert.deepEqual(h.accepted[1], h.beacons[0]);
  h.controller.stop();
});

test('a refused beacon for the upload already on the wire does not hold back the tail', async () => {
  const h = harness(); await settle();
  const release = h.holdUploads();
  const flushing = h.controller.flush(); await settle();
  assert.deepEqual(h.attempts.map((chunk) => chunk.seq), [0]);
  h.refuseBeacon((chunk) => chunk.seq === 0);
  h.emit('last tap'); h.activity(false, true);
  assert.deepEqual(h.beacons.map((chunk) => chunk.seq), [1]);
  assert.deepEqual(texts(h.beacons[0]), ['last tap']);
  release(); await flushing; await settle();
  assert.deepEqual(h.accepted.map((chunk) => chunk.seq), [0, 1]);
  h.controller.stop();
});

test('a refused beacon for a chunk not yet on the wire keeps later chunks back', async () => {
  const h = harness(); await settle();
  h.failureStatus(503); await h.controller.flush();
  h.refuseBeacon((chunk) => chunk.seq === 0);
  h.emit('last tap'); h.activity(false, true);
  assert.equal(h.beacons.length, 0);
  h.controller.stop();
});

test('revoked chunk authorization stops capture and discards queued data', async () => {
  const h = harness(); await settle();
  h.failureStatus(403); await h.controller.flush();
  assert.equal(h.controller.getMetrics().recording, false);
  assert.equal(h.controller.getMetrics().queuedBytes, 0);
  assert.equal(h.controller.getMetrics().sessionId, null);
  h.controller.stop();
});

test('pagehide drops another account\'s pending data even without an explicit refresh', async () => {
  const h = harness(); await settle();
  h.emit('old account view');
  h.metadata({ accountId: 'account-two', authToken: 'private-token' });
  h.activity(false, true);
  assert.equal(h.beacons.length, 0);
  assert.equal(h.controller.getMetrics().bufferedBytes, 0);
  h.controller.stop();
});

test('late worker results cannot upload data after the settings switch turns off', async () => {
  const h = harness(); await settle();
  let release: ((compressed: Uint8Array) => void) | undefined;
  h.runtime.compress = () => new Promise((resolve) => { release = resolve; });
  const flushing = h.controller.flush(); await settle();
  h.enabled(false); await h.controller.refresh();
  release?.(gzipSync(strToU8('[]'))); await flushing;
  assert.equal(h.accepted.length, 0);
  assert.equal(h.controller.getMetrics().queuedBytes, 0);
  h.controller.stop();
});

test('compression failure is contained and recovery uploads a fresh snapshot', async () => {
  const h = harness(); await settle();
  const compress = h.runtime.compress;
  h.runtime.compress = async () => { throw new Error('worker blocked'); };
  await h.controller.flush();
  assert.equal(h.accepted.length, 0);
  h.runtime.compress = compress;
  await h.advance(0); await h.controller.flush();
  assert.equal(h.accepted[0].hasSnapshot, true);
  assert.ok(h.controller.getMetrics().errors > 0);
  h.controller.stop();
});

test('unload during compression sends one chunk with the in-flight, pending and buffered events', async () => {
  const h = harness(); await settle();
  const compress = h.runtime.compress;
  let release: (() => void) | undefined;
  h.runtime.compress = (raw) => new Promise((resolve) => { release = () => { void compress(raw).then(resolve); }; });
  h.emit('first');
  const flushing = h.controller.flush(); await settle();
  h.emit('second'); void h.controller.flush(); await settle();
  h.emit('third');
  h.activity(false, true);
  assert.equal(h.beacons.length, 1);
  const tail = h.beacons[0];
  assert.equal(tail.seq, 0);
  assert.equal(tail.hasSnapshot, true);
  assert.deepEqual(events(tail).map((event) => event.type), [4, 2, 3, 3, 3]);
  assert.deepEqual(texts(tail), ['first', 'second', 'third']);
  assert.equal(h.controller.getMetrics().bufferedBytes, 0);
  h.runtime.compress = compress;
  release?.(); await flushing; await settle();
  assert.deepEqual(h.attempts, [tail]);
  assert.equal(h.controller.getMetrics().queuedBytes, 0);
  h.activity(true); await settle(); await h.controller.flush();
  assert.deepEqual(h.accepted.map((chunk) => chunk.seq), [0, 1]);
  assert.deepEqual(h.accepted.flatMap(texts).filter((text) => text === 'first'), ['first']);
  h.controller.stop();
});

test('unload over the raw budget leaves the in-flight compression to finish normally', async () => {
  const h = harness(); await settle();
  const compress = h.runtime.compress;
  let release: (() => void) | undefined;
  h.runtime.compress = (raw) => new Promise((resolve) => { release = () => { void compress(raw).then(resolve); }; });
  const flushing = h.controller.flush(); await settle();
  h.emit('x'.repeat(REPLAY_LIMITS.unloadRawBytes));
  h.activity(false, true);
  assert.equal(h.beacons.length, 0);
  h.runtime.compress = compress;
  release?.(); await flushing; await settle();
  assert.deepEqual(h.accepted.map((chunk) => chunk.seq), [0, 1]);
  assert.equal(h.accepted[0].hasSnapshot, true);
  assert.ok(texts(h.accepted[1])[0].length === REPLAY_LIMITS.unloadRawBytes);
  h.controller.stop();
});

test('oversize DOM events stop capture instead of repeated snapshot work', async () => {
  const h = harness(); await settle();
  h.emit('x'.repeat(REPLAY_LIMITS.eventBytes + 1));
  await h.advance(1000); await h.controller.refresh();
  assert.equal(h.controller.getMetrics().recording, false);
  assert.equal(h.controller.getMetrics().bufferedBytes, 0);
  assert.equal(h.counts().starts, 1);
  h.controller.stop();
});

test('fetchTransport keeps small requests alive only once the page is hidden, and reports HTTP status', async () => {
  const original = globalThis.fetch;
  const page = globalThis as unknown as { document?: { visibilityState: string } };
  const calls: RequestInit[] = [];
  let status = 200;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    return new Response('{"ok":true}', { status });
  }) as typeof fetch;
  try {
    const transport = fetchTransport();
    page.document = { visibilityState: 'visible' };
    await transport.post('https://replay.test/api/replay/chunks', 'x'.repeat(60000));
    page.document.visibilityState = 'hidden';
    await transport.post('https://replay.test/api/replay/chunks', 'x'.repeat(60000));
    await transport.post('https://replay.test/api/replay/chunks', 'x'.repeat(60001));
    assert.deepEqual(calls.map((init) => init.keepalive), [false, true, false]);
    status = 503;
    await assert.rejects(transport.post('https://replay.test/api/replay/chunks', '{}'), (error: unknown) => error instanceof ReplayHttpError && error.status === 503);
  } finally { globalThis.fetch = original; delete page.document; }
});

test('a /config success clears a network back-off but not a 429 back-off', async () => {
  const busy = harness();
  await settle();
  busy.emit('before');
  busy.failureStatus(429);
  await busy.controller.flush();
  const refused = busy.attempts.length;
  await busy.controller.refresh();
  busy.emit('after poll');
  await busy.controller.flush();
  assert.equal(busy.attempts.length, refused, 'a 429 back-off survives a healthy config poll');
  busy.controller.stop();

  const tunnel = harness();
  await settle();
  tunnel.emit('before');
  tunnel.offline(true);
  await tunnel.controller.flush();
  tunnel.offline(false);
  const blocked = tunnel.attempts.length;
  await tunnel.controller.refresh();
  await tunnel.controller.flush();
  assert.ok(tunnel.attempts.length > blocked, 'back online, the queue goes out without waiting out the back-off');
  tunnel.controller.stop();
});

test('a phone clock hours ahead keeps its session when the server sends expiresIn', async () => {
  const h = harness({ enabled: false });
  await settle();
  // The server's absolute expiry is already past by this device's clock.
  h.startReply({ expiresAt: 1790500000000 - 3600000, expiresIn: 14400000 });
  h.enabled(true);
  await h.controller.refresh();
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  assert.equal(h.controller.getMetrics().recording, true);
  h.controller.stop();
});

test('privacy scrub covers snapshots, attribute mutations, CSS, inputs and known account text', () => {
  const event: ReplayEvent = {
    type: 3, timestamp: 1, data: {
      source: 0, attributes: [{ id: 1, attributes: {
        href: 'https://user:password@example.test/path?token=private#secret',
        src: 'data:image/png;base64,private', title: 'Alice', 'aria-label': 'Alice email',
        'data-token': 'private', 'data-state': 'open', value: 'private input', class: 'red-player',
        style: 'background:url("https://example.test/image?token=private")',
      } }],
      texts: [{ id: 2, value: 'Welcome ALICE (alice@example.test)' }],
    },
  };
  const text = serializeEvent(event, ['Alice', 'alice@example.test', 'red']);
  assert.doesNotMatch(text, /private|password|token|ALICE|alice@example/);
  assert.equal(JSON.parse(text).data.texts[0].value, 'Welcome * (*)');
  assert.match(text, /data-state/);
  assert.match(text, /red-player/);
  assert.match(text, /https:\/\/example.test\/path/);
  const input = JSON.parse(serializeEvent({ type: 3, timestamp: 2, data: { source: 5, text: 'unmasked secret', id: 3 } }));
  assert.equal(input.data.text, '*');
  const style = serializeEvent({ type: 2, timestamp: 3, data: { node: {
    tagName: 'style', childNodes: [{ type: 3, textContent: '.red-player { color:red; background:url(/image?token=private) }' }],
  } } }, ['red']);
  assert.match(style, /red-player/);
  assert.match(style, /color:red/);
  assert.doesNotMatch(style, /private|token/);
});

test('server privacy rules reach the recorder after the host rules, skipping empty ones', async () => {
  const h = harness({
    options: { maskTextSelector: ' .host-name ', blockSelector: ' \n ' },
    rules: { maskTextSelector: '.chat,\n[class*="name"]', blockSelector: '.avatar' },
  });
  await settle();
  assert.equal(h.captured.length, 1);
  assert.equal(h.captured[0].maskTextSelector, '.host-name,.chat,\n[class*="name"]');
  assert.equal(h.captured[0].blockSelector, '.avatar');
  assert.equal(h.captured[0].endpoint, 'https://replay.test');
  h.controller.stop();

  const older = harness({ options: { maskTextSelector: '.host-name', blockSelector: '.photo' } });
  await settle();
  assert.equal(older.captured[0].maskTextSelector, '.host-name');
  assert.equal(older.captured[0].blockSelector, '.photo');
  older.controller.stop();

  const serverOnly = harness({ rules: { maskTextSelector: '', blockSelector: '.avatar' } });
  await settle();
  assert.equal(serverOnly.captured[0].maskTextSelector, '');
  assert.equal(serverOnly.captured[0].blockSelector, '.avatar');
  serverOnly.controller.stop();
});

test('changed server rules restart capture with a fresh snapshot in the same session', async () => {
  const h = harness({ rules: { maskTextSelector: '.chat', blockSelector: '' } });
  await settle();
  h.emit('before');
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().starts, 1, 'the same rules do not restart');
  h.rules({ maskTextSelector: '.chat, .name', blockSelector: '.avatar' });
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().stops, 1);
  assert.equal(h.counts().starts, 2);
  assert.equal(h.captured[1].maskTextSelector, '.chat, .name');
  assert.equal(h.captured[1].blockSelector, '.avatar');
  assert.equal(h.controller.getMetrics().recording, true);
  h.emit('after');
  await h.controller.flush();
  const uploaded = h.accepted.flatMap(events);
  assert.equal(uploaded.filter((event) => event.type === 2).length, 2);
  assert.deepEqual(h.accepted.flatMap(texts), ['before', 'after']);
  assert.equal(h.counts().sessionNumber, 1);
  h.controller.stop();
});

test('data: images upload only while the server turns recordImages on, and a change restarts capture', async () => {
  const avatar = 'data:image/svg+xml;base64,PHN2Zy8+';
  const picture = () => ({ type: 3, timestamp: 0, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 2, attributes: { src: avatar } }] } }) as ReplayEvent;
  const sources = (chunk: ReplayChunk) => events(chunk).flatMap((event) => (event.data.attributes as { attributes: { src?: string } }[] | undefined ?? []).map((item) => item.attributes.src));
  const h = harness({ rules: { maskTextSelector: '', blockSelector: '' } });
  await settle();
  h.raw(picture());
  h.rules({ maskTextSelector: '', blockSelector: '', recordImages: true });
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().starts, 2);
  h.raw(picture());
  await h.controller.flush();
  assert.deepEqual(h.accepted.flatMap(sources), ['', avatar]);
  h.controller.stop();
});

test('an unreadable or invalid server rule fails closed until a later poll fixes it', async () => {
  const validSelector = (selector: string) => !selector.includes('!');
  const h = harness({ enabled: false, validSelector });
  await settle();
  h.rules({ maskTextSelector: '.chat!', blockSelector: '' });
  h.enabled(true);
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().loads, 0);
  assert.equal(h.counts().sessionNumber, 0, 'no session is opened for rules the client cannot apply');
  assert.equal(h.controller.getMetrics().recording, false);
  const errors = h.controller.getMetrics().errors;
  assert.ok(errors > 0);
  h.rules({ maskTextSelector: 42, blockSelector: '' });
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().starts, 0);
  assert.ok(h.controller.getMetrics().errors > errors);
  h.rules({ maskTextSelector: '.chat', blockSelector: '' });
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().starts, 1);
  assert.equal(h.captured[0].maskTextSelector, '.chat');
  assert.equal(h.controller.getMetrics().recording, true);
  h.controller.stop();
});

test('a rule that turns invalid while recording stops capture but keeps what was already recorded', async () => {
  const h = harness({ rules: { maskTextSelector: '.chat' }, validSelector: (selector) => !selector.includes('!') });
  await settle();
  h.emit('before');
  h.rules({ maskTextSelector: '.chat', blockSelector: '.avatar!' });
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().stops, 1);
  assert.equal(h.counts().starts, 1);
  assert.equal(h.controller.getMetrics().recording, false);
  assert.equal(h.controller.getMetrics().sessionId, 'session-1');
  h.emit('while stopped');
  await h.controller.flush();
  assert.deepEqual(h.accepted.flatMap(texts), ['before']);
  h.rules({ maskTextSelector: '.chat', blockSelector: '.avatar' });
  await h.advance(REPLAY_LIMITS.configIntervalMs);
  assert.equal(h.counts().starts, 2);
  assert.equal(h.captured[1].blockSelector, '.avatar');
  assert.equal(h.controller.getMetrics().recording, true);
  h.controller.stop();
});

test('an invalid host rule or a failing selector check also fails closed', async () => {
  const host = harness({ options: { maskTextSelector: '.name,' }, validSelector: (selector) => !/,\s*(,|$)/.test(selector) });
  await settle();
  assert.equal(host.counts().starts, 0);
  assert.equal(host.controller.getMetrics().recording, false);
  host.controller.stop();

  const broken = harness({ rules: { maskTextSelector: '.chat' }, validSelector: () => { throw new Error('no DOM'); } });
  await settle();
  assert.equal(broken.counts().starts, 0);
  assert.ok(broken.controller.getMetrics().errors > 0);
  broken.controller.stop();
});

test('packaged app origins map static assets to this build\'s archive on the replay server', async () => {
  const page = globalThis as unknown as { location?: { origin: string; href: string } };
  const archived = 'https://replay.test/replay-assets/1.4.60/assets/scene.png';
  const cases: [string, string, string, Partial<ReplayOptions>, string][] = [
    ['https://localhost', 'https://localhost/', '1.4.60', {}, archived],
    ['capacitor://localhost', 'capacitor://localhost/', '1.4.60', {}, archived],
    ['capacitor-electron://-', 'capacitor-electron://-/', '1.4.60', {}, archived],
    ['null', 'capacitor-electron://-/index.html', '1.4.60', {}, archived],
    ['https://example.test', 'https://example.test/', '1.4.60', {}, '/assets/scene.png'],
    ['https://localhost:8443', 'https://localhost:8443/', '1.4.60', {}, '/assets/scene.png'],
    ['https://localhost', 'https://localhost/', '', {}, '/assets/scene.png'],
    ['https://localhost', 'https://localhost/', '../escape', {}, '/assets/scene.png'],
    ['https://localhost', 'https://localhost/', '1.4.60', { assetBaseUrl: '' }, '/assets/scene.png'],
    ['https://localhost', 'https://localhost/', '1.4.60', { assetBaseUrl: 'https://cdn.test/build/' }, 'https://cdn.test/build/assets/scene.png'],
  ];
  try {
    for (const [origin, href, appVersion, options, expected] of cases) {
      page.location = { origin, href };
      const h = harness({ options });
      h.metadata({ appVersion });
      await settle();
      h.raw({ type: 3, timestamp: 1790500001000, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 5, attributes: { src: '/assets/scene.png?token=SECRET' } }] } });
      await h.controller.flush();
      const mutation = events(h.accepted[0]).find((event) => event.type === 3)!;
      const attributes = (mutation.data.attributes as { attributes: { src: string } }[])[0].attributes;
      assert.equal(attributes.src, expected, JSON.stringify({ origin, href, appVersion, options }));
      h.controller.stop();
    }
  } finally { delete page.location; }
});
