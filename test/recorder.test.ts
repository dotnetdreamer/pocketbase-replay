import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync, gunzipSync, strFromU8, strToU8, zlibSync } from 'fflate';
import { createRequire } from 'node:module';
import { createReplay, REPLAY_LIMITS, triggerLabel } from '../src/engine';
import { createObservability } from '../src/observability';
import { fetchTransport, ReplayHttpError } from '../src/index';
import { serializeEvent } from '../src/privacy';
import type { RecorderOptions, ReplayChunk, ReplayEvent, ReplayMetadata, ReplayOptions, ReplayRuntime } from '../src/types';

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
  let failure: (() => void) | undefined;
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
    subscribeErrors: (listener) => { failure = listener; return () => { failure = undefined; }; },
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
    fail: () => failure?.(),
    listening: () => failure !== undefined,
    counts: () => ({ loads, starts, stops, removed, sessionNumber }),
    emit: (text = 'menu opened') => callback?.({ type: 3, timestamp: now++, data: { source: 0, texts: [{ id: 2, value: text }], attributes: [], removes: [], adds: [] } }),
    raw: (event: ReplayEvent) => callback?.(event),
    // An idle page: time passes and no timer is due yet.
    skip: (ms: number) => { now += ms; },
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

test('an ingestion key accompanies config, start, regular chunks and page-exit chunks', async () => {
  const h = harness({ options: { apiKey: ' replay-ingestion-key ' } });
  try {
    await settle();
    h.emit('first upload');
    await h.controller.flush();
    h.emit('exit upload');
    h.activity(false, true);
    assert.deepEqual(h.requests.map((request) => request.url.split('/').pop()), ['config', 'start', 'chunks']);
    for (const request of h.requests) assert.equal(JSON.parse(request.body).apiKey, 'replay-ingestion-key');
    assert.equal(h.beacons.length, 1);
    assert.equal(h.beacons[0].apiKey, 'replay-ingestion-key');
    assert.deepEqual(texts(h.beacons[0]), ['exit upload']);
  } finally { h.controller.stop(); }
});

test('an omitted or empty ingestion key leaves legacy request envelopes unchanged', async () => {
  for (const apiKey of [undefined, '', '  ']) {
    const h = harness({ options: { apiKey } });
    try {
      await settle();
      await h.controller.flush();
      assert.deepEqual(JSON.parse(h.requests[0].body), {
        deviceId: 'device-one', accountId: '', platform: 'web', appVersion: '1.0', room: '', authToken: '', features: ['trigger'],
      });
      for (const request of h.requests) assert.equal('apiKey' in JSON.parse(request.body), false);
      h.emit('exit upload'); h.activity(false, true);
      assert.equal('apiKey' in h.beacons[0], false);
    } finally { h.controller.stop(); }
  }
});

test('replay correlation returns a detached context only for the current live identity', async () => {
  const h = harness();
  assert.equal(h.controller.getSessionContext(), null);
  await settle();
  assert.deepEqual(h.controller.getSessionContext(), { sessionId: 'session-1', token: 'upload-secret' });
  const context = h.controller.getSessionContext()!; context.token = 'changed';
  assert.equal(h.controller.getSessionContext()!.token, 'upload-secret');
  h.metadata({ accountId: 'signed-in-user', authToken: 'account-token' });
  assert.equal(h.controller.getSessionContext(), null);
  await h.controller.refresh();
  assert.equal(h.controller.getSessionContext()!.sessionId, 'session-2');
  h.enabled(false); await h.controller.refresh();
  assert.equal(h.controller.getSessionContext(), null);
  h.controller.stop(); assert.equal(h.controller.getSessionContext(), null);
});

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

test('client data attribute opt-in reaches uploaded DOM events', async () => {
  const h = harness({ options: { preserveDataAttributes: { 'data-screen': ['language', 'game'] } } });
  await settle();
  h.raw({ type: 3, timestamp: 1790500001000, data: { source: 0, attributes: [
    { id: 2, attributes: { 'data-screen': 'language', 'data-player-name': 'Alice' } },
  ] } });
  await h.controller.flush();
  const mutation = events(h.accepted[0]).find((event) => event.type === 3)!;
  assert.deepEqual((mutation.data.attributes as { attributes: Record<string, unknown> }[])[0].attributes, { 'data-screen': 'language' });
  h.controller.stop();
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

function triggerMarks(chunks: ReplayChunk[]): unknown[] {
  return chunks.flatMap(events).filter((event) => event.type === 5 && event.data.tag === 'pbr/trigger').map((event) => event.data.payload);
}

function urls(h: { requests: { url: string }[] }): string[] {
  return h.requests.map((request) => request.url.split('/').pop()!);
}

test('trigger mode records on the device and sends nothing before a trigger, not even at page exit', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    assert.deepEqual(urls(h), ['config']);
    assert.equal(h.counts().starts, 1);
    assert.equal(h.controller.getMetrics().recording, true);
    assert.equal(h.controller.getSessionContext(), null);
    h.emit('kept on the device');
    await h.controller.flush();
    await h.advance(30000);
    assert.equal(h.attempts.length, 0);
    assert.ok(h.controller.getMetrics().bufferedBytes > 0);
    h.activity(false, true);
    assert.equal(h.beacons.length, 0);
    assert.equal(urls(h).includes('start'), false);
  } finally { h.controller.stop(); }
});

test('a trigger starts a session with its reason, uploads the kept history from a full snapshot, then stays live for a minute', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    h.emit('before the error');
    const context = await h.controller.trigger(' checkout-failed ');
    assert.deepEqual(context, { sessionId: 'session-1', token: 'upload-secret' });
    const start = JSON.parse(h.requests.find((request) => request.url.endsWith('/start'))!.body);
    assert.equal(start.trigger, 'checkout-failed');
    assert.deepEqual(start.features, ['trigger']);
    await settle();
    assert.equal(h.accepted[0].seq, 0);
    assert.equal(h.accepted[0].hasSnapshot, true);
    assert.ok(h.accepted.flatMap(texts).includes('before the error'));
    assert.deepEqual(triggerMarks(h.accepted), [{ reason: 'checkout-failed' }]);
    assert.deepEqual(h.controller.getSessionContext(), context);
    h.emit('right after');
    await h.controller.flush();
    assert.ok(h.accepted.flatMap(texts).includes('right after'));
    await h.advance(REPLAY_LIMITS.liveMs + 5000);
    await h.advance(0);
    h.emit('kept again');
    await h.controller.flush();
    h.activity(false, true);
    assert.equal(h.accepted.concat(h.beacons).flatMap(texts).includes('kept again'), false);
    assert.equal(h.controller.getSessionContext(), null);
    assert.equal(urls(h).filter((url) => url === 'start').length, 1);
  } finally { h.controller.stop(); }
});

test('the device keeps from the newest full snapshot at least a minute old and drops older parts', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    h.emit('first minute');
    await h.advance(REPLAY_LIMITS.checkoutMs);
    h.emit('second minute');
    await h.advance(REPLAY_LIMITS.checkoutMs);
    h.emit('third minute');
    await h.controller.trigger('report');
    await settle();
    const uploaded = h.accepted.flatMap(texts);
    assert.equal(uploaded.includes('first minute'), false);
    assert.ok(uploaded.includes('second minute'));
    assert.ok(uploaded.includes('third minute'));
    assert.equal(h.accepted[0].hasSnapshot, true);
    assert.deepEqual(h.accepted.map((chunk) => chunk.seq), h.accepted.map((_chunk, index) => index));
  } finally { h.controller.stop(); }
});

test('a part too large to keep starts again from a fresh snapshot instead of growing', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    const large = 'x'.repeat(900 * 1024);
    for (let i = 0; i < 3; i++) h.emit(large);
    assert.ok(h.controller.getMetrics().droppedChunks > 0);
    assert.ok(h.controller.getMetrics().bufferedBytes <= REPLAY_LIMITS.keptBytes);
    await h.advance(5000);
    h.emit('after the restart');
    await h.controller.trigger('report');
    await settle();
    assert.equal(h.accepted[0].hasSnapshot, true);
    assert.ok(h.accepted.flatMap(texts).includes('after the restart'));
  } finally { h.controller.stop(); }
});

test('an uncaught error is a trigger in trigger mode only, unless triggerOnError is false', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    assert.equal(h.listening(), true);
    h.emit('before the crash');
    h.fail();
    await settle();
    assert.equal(JSON.parse(h.requests.find((request) => request.url.endsWith('/start'))!.body).trigger, 'error');
    assert.ok(h.accepted.flatMap(texts).includes('before the crash'));
  } finally { h.controller.stop(); }
  assert.equal(h.listening(), false);
  const quiet = harness({ rules: { uploadMode: 'trigger' }, options: { triggerOnError: false } });
  try { await settle(); assert.equal(quiet.listening(), false); } finally { quiet.controller.stop(); }
  const whole = harness();
  try { await settle(); assert.equal(whole.listening(), false); } finally { whole.controller.stop(); }
});

test('diagnostics respect triggerOnError false while explicit triggers still upload the replay', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' }, options: { triggerOnError: false } });
  const diagnostics: { url: string; body: any }[] = [];
  const observer = createObservability({
    endpoint: 'https://replay.test', metadata: () => ({ deviceId: 'device-one', platform: 'web', appVersion: '1' }),
    errors: true, logs: true, replay: h.controller,
    transport: { post: async (url, raw) => {
      diagnostics.push({ url, body: JSON.parse(raw) });
      return { enabled: true, errorsEnabled: true, logsEnabled: true, token: 't'.repeat(64), expiresIn: 14400000 };
    } },
  }, { now: h.runtime.now, schedule: h.runtime.schedule, cancel: h.runtime.cancel });
  try {
    await settle(); await observer.refresh();
    observer.captureException(new Error('handled failure'));
    observer.captureLog('error', 'error log');
    await settle(); await observer.flush();
    assert.equal(h.requests.some((request) => request.url.endsWith('/start')), false);
    assert.equal(h.accepted.length, 0);
    assert.ok(diagnostics.some((request) => request.url.endsWith('/errors')));
    assert.ok(diagnostics.some((request) => request.url.endsWith('/logs')));
    await h.controller.trigger('error');
    await h.controller.flush();
    assert.ok(h.accepted.length > 0);
  } finally { observer.stop(); h.controller.stop(); }
});

test('in whole-session mode a trigger only marks the timeline, once per reason within a few seconds', async () => {
  const h = harness();
  try {
    await settle();
    const context = await h.controller.trigger('report');
    assert.deepEqual(context, { sessionId: 'session-1', token: 'upload-secret' });
    await h.controller.trigger('report');
    await h.controller.flush();
    assert.deepEqual(triggerMarks(h.accepted), [{ reason: 'report' }]);
    await h.advance(REPLAY_LIMITS.markMs);
    await h.controller.trigger('report');
    await h.controller.trigger();
    await h.controller.flush();
    assert.deepEqual(triggerMarks(h.accepted), [{ reason: 'report' }, { reason: 'report' }, { reason: 'manual' }]);
    assert.equal(urls(h).filter((url) => url === 'start').length, 1);
  } finally { h.controller.stop(); }
  const off = harness({ enabled: false });
  try { await settle(); assert.equal(await off.controller.trigger('report'), null); } finally { off.controller.stop(); }
});

test('switching the server between whole sessions and triggers starts over in the new mode', async () => {
  const h = harness();
  try {
    await settle();
    assert.equal(h.controller.getMetrics().sessionId, 'session-1');
    h.rules({ uploadMode: 'trigger' });
    await h.controller.refresh();
    assert.equal(h.controller.getMetrics().sessionId, null);
    assert.equal(h.controller.getMetrics().recording, true);
    h.emit('kept');
    await h.controller.flush();
    const before = h.accepted.length;
    h.rules({});
    await h.controller.refresh();
    await h.controller.flush();
    assert.equal(h.controller.getMetrics().sessionId, 'session-2');
    assert.equal(h.accepted.slice(before).flatMap(texts).includes('kept'), false);
    assert.equal(h.accepted[before].hasSnapshot, true);
  } finally { h.controller.stop(); }
});

test('between triggers an ending session leaves the kept history for the next trigger\'s session', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  h.startReply({ expiresIn: 130000 });
  try {
    await settle();
    await h.controller.trigger('first');
    await settle();
    await h.advance(REPLAY_LIMITS.liveMs + 5000);
    await h.advance(60000);
    assert.equal(h.controller.getMetrics().sessionId, null);
    assert.equal(h.controller.getMetrics().recording, true);
    h.emit('after the session ended');
    const context = await h.controller.trigger('second');
    assert.equal(context!.sessionId, 'session-2');
    await settle();
    const second = h.accepted.filter((chunk) => chunk.sessionId === 'session-2');
    assert.equal(second[0].seq, 0);
    assert.equal(second[0].hasSnapshot, true);
    assert.ok(second.flatMap(texts).includes('after the session ended'));
  } finally { h.controller.stop(); }
});

test('a trigger whose session cannot start yet resolves null and starts at the next poll', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    h.emit('waiting for the server');
    h.startStatus(503);
    assert.equal(await h.controller.trigger('error'), null);
    assert.equal(h.accepted.length, 0);
    h.startStatus(0);
    await h.advance(REPLAY_LIMITS.configIntervalMs);
    await settle();
    assert.equal(h.controller.getMetrics().sessionId, 'session-1');
    assert.ok(h.accepted.flatMap(texts).includes('waiting for the server'));
  } finally { h.controller.stop(); }
});

test('an account change between triggers drops what the device kept for the old account', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    h.emit('old account');
    h.metadata({ accountId: 'someone-else', authToken: 'other-token' });
    await h.controller.refresh();
    h.emit('new account');
    await h.controller.trigger('report');
    await settle();
    const uploaded = h.accepted.flatMap(texts);
    assert.equal(uploaded.includes('old account'), false);
    assert.ok(uploaded.includes('new account'));
  } finally { h.controller.stop(); }
});

test('a trigger right after the device changes starts a session for the new device, without the old one\'s history', async () => {
  // Live, between triggers while the session is still open, and waiting for the snapshot that follows a live minute.
  for (const state of ['live', 'kept', 'awaiting snapshot']) {
    const h = harness({ rules: { uploadMode: 'trigger' } });
    try {
      await settle();
      await h.controller.trigger('first');
      await h.controller.flush();
      if (state !== 'live') { h.skip(REPLAY_LIMITS.liveMs + 1000); await h.controller.flush(); }
      if (state === 'kept') await h.advance(0);
      h.emit('device one');
      const before = h.accepted.length;
      h.metadata({ deviceId: 'device-two' });
      const context = await h.controller.trigger('after-switch');
      assert.equal(context?.sessionId, 'session-2', state);
      const starts = h.requests.filter((request) => request.url.endsWith('/start')).map((request) => JSON.parse(request.body));
      assert.deepEqual(starts.map((body) => [body.deviceId, body.trigger]), [['device-one', 'first'], ['device-two', 'after-switch']], state);
      assert.equal(h.controller.getMetrics().recording, true, state);
      await h.advance(0);
      h.emit('device two');
      await h.controller.flush();
      const later = h.accepted.slice(before);
      assert.ok(later.length && later.every((chunk) => chunk.sessionId === 'session-2'), state);
      assert.equal(later[0].hasSnapshot, true, state);
      assert.deepEqual(triggerMarks(later), [{ reason: 'after-switch' }], state);
      assert.ok(later.flatMap(texts).includes('device two'), state);
      assert.equal(h.accepted.flatMap(texts).includes('device one'), false, state);
      assert.deepEqual(h.controller.getSessionContext(), context, state);
    } finally { h.controller.stop(); }
  }
});

const replayServer = createRequire(import.meta.url)('../server/pb_hooks/lib/replay-core.js');

test('trigger labels are cleaned exactly as the server cleans them, so none can make it refuse the session', () => {
  for (const reason of ['checkout|failed', '  report  ', 'line\nbreak\u007f', 'x'.repeat(70), '😀'.repeat(40), 'a'.repeat(63) + '😀', '\t', '']) {
    assert.equal(triggerLabel(reason), replayServer.reason(reason) || 'manual', JSON.stringify(reason));
  }
  assert.equal(triggerLabel(undefined), 'manual');
});

test('a trigger reason with a pipe keeps the kept history and starts the session', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    h.emit('before the failure');
    const context = await h.controller.trigger('checkout|failed');
    assert.equal(context!.sessionId, 'session-1');
    assert.equal(JSON.parse(h.requests.find((request) => request.url.endsWith('/start'))!.body).trigger, 'checkout|failed');
    await settle();
    assert.ok(h.accepted.flatMap(texts).includes('before the failure'));
    assert.equal(h.controller.getMetrics().recording, true);
  } finally { h.controller.stop(); }
});

test('once the live minute passes on an idle page the session is no longer current, and a trigger continues it', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    const context = await h.controller.trigger('first');
    await settle();
    h.skip(REPLAY_LIMITS.liveMs + 1000);
    assert.equal(h.controller.getSessionContext(), null);
    assert.deepEqual(await h.controller.trigger('error'), context);
    assert.deepEqual(h.controller.getSessionContext(), context);
    h.emit('after the handled error');
    await h.controller.flush();
    assert.ok(h.accepted.flatMap(texts).includes('after the handled error'));
    assert.deepEqual(triggerMarks(h.accepted), [{ reason: 'first' }, { reason: 'error' }]);
    assert.equal(urls(h).filter((url) => url === 'start').length, 1);
  } finally { h.controller.stop(); }
});

test('a trigger right after the live minute ended still uploads from a fresh snapshot, with its mark after it', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    await h.controller.trigger('first');
    await settle();
    h.skip(REPLAY_LIMITS.liveMs + 1000);
    await h.controller.flush();
    assert.equal(h.controller.getSessionContext(), null);
    const before = h.accepted.length;
    await h.controller.trigger('again');
    await h.advance(0);
    h.emit('after the second trigger');
    await h.controller.flush();
    const later = h.accepted.slice(before);
    assert.ok(later.some((chunk) => chunk.hasSnapshot));
    assert.ok(later.flatMap(texts).includes('after the second trigger'));
    // The mark was made while that snapshot was pending; it waited for it instead of being dropped.
    assert.deepEqual(triggerMarks(later), [{ reason: 'again' }]);
    const order = later.flatMap(events);
    const snapshot = order.findIndex((event) => event.type === 2);
    const mark = order.findIndex((event) => event.type === 5 && event.data.tag === 'pbr/trigger');
    assert.ok(snapshot >= 0 && mark > snapshot);
    assert.ok(order[mark].timestamp >= order[snapshot].timestamp);
  } finally { h.controller.stop(); }
});

test('after a long sleep a trigger on a live session that has expired asks for a new session, keeping its mark', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  try {
    await settle();
    const first = await h.controller.trigger('first');
    await h.controller.flush();
    // The page slept for five hours with its timers held, so nothing ended the live minute and the session expired.
    h.skip(5 * 60 * 60 * 1000);
    const woken = await h.controller.trigger('after-wake');
    assert.equal(woken?.sessionId, 'session-2');
    assert.notEqual(woken?.sessionId, first?.sessionId);
    const starts = h.requests.filter((request) => request.url.endsWith('/start')).map((request) => JSON.parse(request.body).trigger);
    assert.deepEqual(starts, ['first', 'after-wake']);
    await h.advance(0);
    h.emit('after waking');
    await h.controller.flush();
    const second = h.accepted.filter((chunk) => chunk.sessionId === 'session-2');
    assert.equal(second[0].seq, 0);
    assert.equal(second[0].hasSnapshot, true);
    assert.deepEqual(triggerMarks(second), [{ reason: 'after-wake' }]);
    assert.ok(second.flatMap(texts).includes('after waking'));
    assert.deepEqual(h.controller.getSessionContext(), woken);
  } finally { h.controller.stop(); }
});

test('a session that ends during a live minute leaves recording running on the device for the next trigger', async () => {
  const h = harness({ rules: { uploadMode: 'trigger' } });
  h.startReply({ expiresIn: 70000 });
  try {
    await settle();
    await h.controller.trigger('first');
    await settle();
    const starts = h.counts().starts;
    // The poll 45 seconds in finds the session within 30 seconds of its end while the minute is still live.
    await h.advance(REPLAY_LIMITS.configIntervalMs);
    assert.equal(h.controller.getMetrics().sessionId, null);
    assert.equal(h.controller.getMetrics().recording, true);
    assert.equal(h.counts().starts, starts);
    assert.equal(h.controller.getSessionContext(), null);
    await h.advance(0);
    h.emit('kept after the session ended');
    const context = await h.controller.trigger('second');
    assert.equal(context?.sessionId, 'session-2');
    await settle();
    const second = h.accepted.filter((chunk) => chunk.sessionId === 'session-2');
    assert.equal(second[0].seq, 0);
    assert.equal(second[0].hasSnapshot, true);
    assert.ok(second.flatMap(texts).includes('kept after the session ended'));
  } finally { h.controller.stop(); }
});

test('the server turns PocketBase calls on for the recorder, which gets the live session to link them', async () => {
  type Recorder = import('../src/types').RecorderOptions;
  const client = { send: async () => ({}) };
  const h = harness({ options: { pocketbase: client }, rules: { recordPocketbase: true, tracePocketbaseRequests: true } });
  try {
    await settle();
    const recorder = h.captured[0] as Recorder;
    assert.equal(recorder.recordPocketbase, true);
    assert.equal(recorder.tracePocketbaseRequests, true);
    assert.equal(recorder.pocketbase, client);
    assert.equal(recorder.replaySession?.(), 'session-1');
    // Turning it off restarts capture with a fresh snapshot, like the other rules.
    h.rules({ recordPocketbase: false });
    await h.controller.refresh();
    assert.equal(h.captured.length, 2);
    assert.equal((h.captured[1] as Recorder).recordPocketbase, false);
    assert.equal((h.captured[1] as Recorder).tracePocketbaseRequests, false);
    // An older server never answers the setting, so nothing is recorded.
    const older = harness({ options: { pocketbase: client } });
    try { await settle(); assert.equal((older.captured[0] as Recorder).recordPocketbase, false); } finally { older.controller.stop(); }
    // Between triggers there is no live session to name.
    const kept = harness({ options: { pocketbase: client }, rules: { uploadMode: 'trigger', recordPocketbase: true } });
    try {
      await settle();
      assert.equal((kept.captured[0] as Recorder).replaySession?.(), null);
      await kept.controller.trigger('report');
      assert.equal((kept.captured[0] as Recorder).replaySession?.(), 'session-1');
    } finally { kept.controller.stop(); }
  } finally { h.controller.stop(); }
});

test('a full snapshot larger than the buffer keeps its meta event, so kept history still plays', async () => {
  const { recoverEvents } = await import('../viewer/decode');
  let now = 1790500000000;
  let emit: ((event: ReplayEvent) => void) | undefined;
  const chunks: ReplayChunk[] = [];
  const timers = new Map<number, { callback: () => void; at: number }>();
  let timerId = 0;
  // Larger than the 128 KiB buffer, as a page with inlined stylesheets easily is.
  const snapshot = () => {
    emit?.({ type: 4, timestamp: now++, data: { href: 'https://example.test/', width: 400, height: 800 } });
    emit?.({ type: 2, timestamp: now++, data: { node: { type: 0, id: 1, childNodes: [], css: 'x'.repeat(REPLAY_LIMITS.bufferBytes + 50000) }, initialOffset: { top: 0, left: 0 } } });
  };
  const replay = createReplay({
    endpoint: 'https://replay.test', metadata: () => ({ deviceId: 'device-one', platform: 'web', appVersion: '1.0', room: '' }),
    transport: { post: async (url, body) => {
      if (url.endsWith('/config')) return { enabled: true, uploadIntervalMs: 25000, uploadMode: 'trigger' };
      if (url.endsWith('/start')) return { enabled: true, sessionId: 'abcdefghij12345', token: 'T'.repeat(64), expiresIn: 14400000, uploadMode: 'trigger' };
      chunks.push(JSON.parse(body) as ReplayChunk);
      return { ok: true };
    } },
  }, {
    now: () => now, performanceNow: () => 0,
    schedule: (callback, ms) => { timers.set(++timerId, { callback, at: now + ms }); return timerId; },
    cancel: (timer) => { timers.delete(timer as number); },
    loadRecorder: async () => ({ start: (callback) => { emit = callback; snapshot(); return () => { emit = undefined; }; }, snapshot }),
    compress: async (raw) => gzipSync(strToU8(raw)), compressSync: (raw) => gzipSync(strToU8(raw)),
  });
  try {
    await settle();
    emit?.({ type: 3, timestamp: now++, data: { source: 2, type: 2, id: 1, x: 1, y: 1 } });
    assert.ok((await replay.trigger('report'))?.sessionId);
    await settle();
    await replay.flush();
    await settle();
    const types = chunks.flatMap(events).map((event) => event.type);
    assert.deepEqual(types.slice(0, 2), [4, 2]);
    const played = recoverEvents(chunks.map((chunk) => ({ seq: chunk.seq, rawBytes: chunk.rawBytes, data: chunk.data, encoding: chunk.encoding })));
    assert.equal(played.events[0].type, 4);
    assert.ok(played.events.some((event) => event.type === 2));
  } finally { replay.stop(); }
});

// An actual PNG with a gray masked quarter and noisy public pixels, large enough to cross a chunk boundary.
function nativeScreenshotPng(): string {
  const width = 256, height = 192, pixels = new Uint8Array((width * 4 + 1) * height);
  let random = 123456789;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 3; channel++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels[at + channel] = x < 64 ? 158 : random & 255;
    }
    pixels[at + 3] = 255;
  }
  const chunk = (name: string, data: Uint8Array): Buffer => {
    const bytes = Buffer.concat([Buffer.from(name), data]);
    let crc = -1;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(pixels)), chunk('IEND', new Uint8Array())]).toString('base64')}`;
}

function screenshotHarness(image: string, capability: boolean, initial: HarnessSetup = {}) {
  const h = harness(initial), settings: RecorderOptions[] = [];
  let emit: ((event: ReplayEvent) => void) | undefined;
  let timestamp = 1790500000000;
  const snapshot = () => {
    emit?.({ type: 4, timestamp: timestamp++, data: { href: 'capacitor://localhost/orders', width: 256, height: 192 } });
    emit?.({ type: 2, timestamp: timestamp++, data: { node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 3, tagName: 'html', attributes: {}, childNodes: [
        { type: 2, id: 5, tagName: 'body', attributes: {}, childNodes: [
          { type: 2, id: 6, tagName: 'img', attributes: { src: image, style: 'width:256px;height:192px' }, childNodes: [] },
          { type: 2, id: 8, tagName: 'div', attributes: { style: 'opacity:0' }, childNodes: [
            { type: 2, id: 9, tagName: 'div', attributes: { style: 'left:0;top:0;width:64px;height:192px' }, childNodes: [{ type: 3, id: 10, textContent: '*' }] },
            { type: 2, id: 11, tagName: 'button', attributes: {}, childNodes: [{ type: 3, id: 12, textContent: 'Pay now' }] },
          ] },
        ] },
      ] },
    ] }, initialOffset: { top: 0, left: 0 } } });
  };
  // Configuration fetches are asynchronous, so replacing the recorder before settling exercises the real engine path.
  h.runtime.loadRecorder = async () => ({ imageSnapshots: capability, start(callback, options) { emit = callback; settings.push(options); snapshot(); return () => { emit = undefined; }; }, snapshot });
  return { ...h, settings, send: (data: ReplayEvent['data'], type = 3) => emit?.({ type, timestamp: timestamp++, data }) };
}

test('only an image-snapshot recorder can retain a bounded masked PNG while server image recording is off', async () => {
  const image = nativeScreenshotPng();
  assert.ok(image.length > REPLAY_LIMITS.bufferBytes && image.length <= 256 * 1024 + 22);
  for (const capability of [false, true]) {
    const h = screenshotHarness(image, capability, { rules: { recordImages: false } });
    try {
      await settle();
      h.send({ source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 6, attributes: { src: image } }] });
      await h.controller.flush();
      const uploaded = h.accepted.flatMap(events);
      const snapshot = uploaded.find((event) => event.type === 2)!;
      const html = (snapshot.data.node as any).childNodes[0], imageNode = html.childNodes[0].childNodes[0];
      assert.equal(imageNode.attributes.src, capability ? image : '');
      const update = uploaded.find((event) => event.type === 3 && event.data.source === 0)!;
      assert.equal((update.data.attributes as any[])[0].attributes.src, capability ? image : '');
      assert.equal(h.controller.getMetrics().droppedEvents, 0);
    } finally { h.controller.stop(); }
  }
});

test('a large masked native snapshot survives trigger buffering with its meta, safe target and activity', async () => {
  const { recoverEvents } = await import('../viewer/decode');
  const image = nativeScreenshotPng();
  const h = screenshotHarness(image, true, { rules: { recordImages: false, uploadMode: 'trigger' } });
  try {
    await settle();
    h.send({ source: 2, type: 2, id: 9, x: 32, y: 96 });
    h.send({ source: 2, type: 2, id: 11, x: 200, y: 160 });
    h.send({ tag: 'pbr/network', payload: { url: 'https://app.example.com/api/health', method: 'GET', status: 200, duration: 5 } }, 5);
    assert.equal(h.accepted.length, 0);
    assert.ok((await h.controller.trigger('native-report'))?.sessionId);
    await settle(); await h.controller.flush(); await settle();
    assert.equal(h.accepted[0].hasSnapshot, true);
    const recovered = recoverEvents(h.accepted);
    assert.equal(recovered.gaps, 0);
    assert.deepEqual(recovered.events.slice(0, 2).map((event) => event.type), [4, 2]);
    assert.ok(JSON.stringify(recovered.events[1]).includes(image), 'the exact pre-masked PNG must survive serialization');
    assert.ok(JSON.stringify(recovered.events[1]).includes('left:0;top:0;width:64px;height:192px'));
    assert.ok(JSON.stringify(recovered.events[1]).includes('Pay now'));
    const clicks = recovered.events.filter((event) => event.type === 3 && (event.data as any).source === 2).map((event) => event.data);
    assert.deepEqual(clicks, [{ source: 2, type: 2, id: 9, x: 32, y: 96 }, { source: 2, type: 2, id: 11, x: 200, y: 160 }]);
    assert.ok(recovered.events.some((event) => event.type === 5 && (event.data as any).tag === 'pbr/network'));
    assert.ok(recovered.events.some((event) => event.type === 5 && (event.data as any).tag === 'pbr/trigger'));
    assert.equal(h.controller.getMetrics().droppedEvents, 0);
  } finally { h.controller.stop(); }
});

test('image snapshot capability leaves ordinary images gated and forwards server image settings to capture', async () => {
  const h = screenshotHarness(nativeScreenshotPng(), true, { rules: { recordImages: false } });
  const ordinary = 'data:image/svg+xml;base64,PHN2Zy8+';
  const source = (src: string) => ({ source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 20, attributes: { src } }] });
  try {
    await settle(); assert.equal(h.settings[0].recordImages, false);
    h.send(source(ordinary));
    h.send(source(`data:image/png;base64,iVBORw0KGgo${'A'.repeat(256 * 1024)}`));
    await h.controller.flush();
    const before = h.accepted.flatMap(events).filter((event) => event.type === 3 && event.data.source === 0);
    assert.deepEqual(before.map((event) => (event.data.attributes as any[])[0].attributes.src), ['', '']);
    h.rules({ recordImages: true }); await h.controller.refresh();
    assert.equal(h.settings.length, 2); assert.equal(h.settings[1].recordImages, true);
    h.send(source(ordinary)); await h.controller.flush();
    const after = h.accepted.flatMap(events).filter((event) => event.type === 3 && event.data.source === 0);
    assert.equal((after.at(-1)!.data.attributes as any[])[0].attributes.src, ordinary);
  } finally { h.controller.stop(); }
});

// Frames as a platform recorder sends them, on the engine's clock: a meta event and full snapshot whenever the engine
// asks for one, and a new screen image every second. Base64 of random bytes compresses as little as real PNG data.
function frameRecorder(h: ReturnType<typeof harness>, kib: number) {
  let clock = 1790500000000, frame = 0;
  let emit: ((event: ReplayEvent) => void) | undefined;
  const image = () => {
    const bytes = new Uint8Array(kib * 1024);
    let state = ++frame * 2654435761 >>> 0;
    for (let index = 0; index < bytes.length; index++) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; bytes[index] = state & 255; }
    return `data:image/png;base64,iVBORw0KGgo${Buffer.from(bytes).toString('base64').replace(/=+$/, '')}`;
  };
  const snapshot = () => {
    emit?.({ type: 4, timestamp: clock, data: { href: 'capacitor://localhost/', width: 390, height: 844 } });
    emit?.({ type: 2, timestamp: clock, data: { node: { type: 0, id: 1, childNodes: [{ type: 2, id: 6, tagName: 'img', attributes: { src: image() }, childNodes: [] }] }, initialOffset: { top: 0, left: 0 } } });
  };
  h.runtime.loadRecorder = async () => ({ imageSnapshots: true, start(callback) { emit = callback; snapshot(); return () => { emit = undefined; }; }, snapshot });
  return {
    clock: () => clock,
    async seconds(count: number, every = 1) {
      for (let index = 1; index <= count; index++) {
        await h.advance(1000); clock += 1000;
        if (index % every === 0) emit?.({ type: 3, timestamp: clock, data: { source: 0, texts: [], adds: [], removes: [], attributes: [{ id: 6, attributes: { src: image() } }] } });
        await settle();
      }
    },
  };
}

function frameTimes(chunks: ReplayChunk[]): number[] {
  const times = chunks.flatMap(events).filter((event) => event.type === 2 || (event.type === 3 && event.data.source === 0));
  return [...new Set(times.map((event) => event.timestamp))].sort((a, b) => a - b);
}

test('masked frames smaller than an upload are sent as they are sealed instead of being dropped at the next flush', async () => {
  for (const kib of [20, 60, 190]) {
    const h = harness();
    const frames = frameRecorder(h, kib);
    try {
      await settle();
      await frames.seconds(10);
      assert.ok(h.accepted.length > 0, `${kib} KiB frames upload before the flush timer`);
      await frames.seconds(50);
      await h.controller.flush();
      assert.equal(frameTimes(h.accepted).length, 61, `${kib} KiB: the snapshot and all 60 frames arrive`);
      assert.equal(h.controller.getMetrics().droppedChunks, 0);
      for (const chunk of h.accepted) {
        // The server takes at most 384 KiB of gzip data in a 512 KiB body.
        assert.ok(JSON.stringify(chunk).length <= 512 * 1024 && Buffer.from(chunk.data, 'base64').length <= 384 * 1024);
      }
    } finally { h.controller.stop(); }
  }
});

test('trigger mode keeps a minute of an occasionally changing screen, and at least half its allowance of constant change', async () => {
  // A new frame every 10 s keeps the designed minute or more. Frames every second fill the 6 MiB allowance first:
  // its newer half stays, about 38 frames of 60 KiB or 12 of 190 KiB, where one part could only be dropped whole.
  for (const [kib, every, minimumMs] of [[100, 10, 60000], [60, 1, 37000], [190, 1, 10000]] as const) {
    const h = harness({ rules: { uploadMode: 'trigger' } });
    const frames = frameRecorder(h, kib);
    try {
      await settle();
      for (let elapsed = 0; elapsed < 150; elapsed += 10) {
        await frames.seconds(10, every);
        // Trimming the oldest part is not a drop; losing everything kept is.
        assert.equal(h.controller.getMetrics().droppedChunks, 0, `${kib} KiB: nothing kept is lost at ${elapsed + 10} s`);
      }
      assert.equal(h.accepted.length, 0);
      const at = frames.clock();
      assert.ok((await h.controller.trigger('report'))?.sessionId);
      await settle(); await h.controller.flush(); await settle();
      const kept = frameTimes(h.accepted);
      assert.ok(at - kept[0] >= minimumMs, `${kib} KiB every ${every} s: kept ${at - kept[0]} ms before the trigger`);
      // What was kept is whole: every frame from the snapshot opening it up to the trigger.
      if (every === 1) assert.deepEqual(kept, Array.from({ length: (at - kept[0]) / 1000 + 1 }, (_, index) => kept[0] + index * 1000));
      assert.equal(h.controller.getMetrics().droppedChunks, 0);
    } finally { h.controller.stop(); }
  }
});
