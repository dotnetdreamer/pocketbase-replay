import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginListenerHandle } from '@capacitor/core';
import type { ReplayController, ReplayMetrics, ReplayOptions } from 'pocketbase-replay';
import type { AppState, NativeReplayPlugin } from '../src/native';
import { createPlugin } from '../src/plugin';

type Client = Awaited<ReturnType<Parameters<typeof createPlugin>[0]['loadClient']>>;

const options: ReplayOptions = {
  endpoint: 'https://replay.example.com',
  metadata: () => ({ deviceId: 'device-one', platform: 'android', appVersion: '1.4.60' }),
};

async function drain(): Promise<void> { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }

function fakeClient() {
  const started: ReplayOptions[] = [];
  const recorders: { stopped: number; flushed: number; refreshed: number }[] = [];
  const startReplay = (value: ReplayOptions): ReplayController => {
    const recorder = { stopped: 0, flushed: 0, refreshed: 0 };
    started.push(value);
    recorders.push(recorder);
    return {
      stop: () => { recorder.stopped++; },
      flush: async () => { recorder.flushed++; },
      refresh: async () => { recorder.refreshed++; },
      getMetrics: () => ({ recording: true, events: recorders.length }) as ReplayMetrics,
    };
  };
  return { started, recorders, client: { startReplay } };
}

function fakeNative() {
  const listeners: ((state: AppState) => void)[] = [];
  const state = { removed: 0, held: false, release: () => {} };
  const native: NativeReplayPlugin = {
    addListener(event, listener) {
      assert.equal(event, 'appStateChange');
      listeners.push(listener);
      const handle: PluginListenerHandle = { remove: async () => { state.removed++; } };
      if (!state.held) return Promise.resolve(handle);
      return new Promise((resolve) => { state.release = () => resolve(handle); });
    },
  };
  const emit = (value: unknown) => { for (const listener of listeners) listener(value as AppState); };
  return { native, listeners, state, emit };
}

function plugin(platform: string, client: Client, native = fakeNative().native, available = true) {
  return createPlugin({ platform: () => platform, nativeAvailable: () => available, native, loadClient: async () => client });
}

test('on the web, start passes the options through and leaves pause and resume to the client', async () => {
  const { started, client } = fakeClient();
  const { native, listeners } = fakeNative();
  await plugin('web', client, native).start(options);
  assert.equal(started.length, 1);
  assert.equal(started[0].endpoint, options.endpoint);
  assert.equal(started[0].metadata, options.metadata);
  assert.equal(started[0].subscribeActive, undefined);
  assert.equal(listeners.length, 0);
});

test('on Android and iOS, pause and resume come from the native plugin', async () => {
  for (const platform of ['android', 'ios']) {
    const { started, client } = fakeClient();
    const { native, listeners, state, emit } = fakeNative();
    await plugin(platform, client, native).start(options);
    const seen: boolean[] = [];
    const unsubscribe = started[0].subscribeActive!((active) => seen.push(active));
    assert.equal(listeners.length, 1);
    emit({ isActive: false });
    emit({ isActive: true });
    emit({ isActive: 'yes' });
    emit(null);
    assert.deepEqual(seen, [false, true]);
    await drain();
    unsubscribe();
    await drain();
    emit({ isActive: false });
    assert.deepEqual(seen, [false, true]);
    assert.equal(state.removed, 1);
  }
});

test('a listener handle that arrives after unsubscribing is removed at once', async () => {
  const { started, client } = fakeClient();
  const { native, state } = fakeNative();
  state.held = true;
  await plugin('android', client, native).start(options);
  const unsubscribe = started[0].subscribeActive!(() => {});
  unsubscribe();
  assert.equal(state.removed, 0);
  state.release();
  await drain();
  assert.equal(state.removed, 1);
});

test('an error thrown by the client listener stays out of the native callback', async () => {
  const { started, client } = fakeClient();
  const { native, emit } = fakeNative();
  await plugin('ios', client, native).start(options);
  started[0].subscribeActive!(() => { throw new Error('listener failed'); });
  assert.doesNotThrow(() => emit({ isActive: false }));
});

test('without a synced native plugin, or off Android and iOS, the client keeps its own detection', async () => {
  for (const [platform, available] of [['android', false], ['ios', false], ['electron', true]] as const) {
    const { started, client } = fakeClient();
    const { native, listeners } = fakeNative();
    await plugin(platform, client, native, available).start(options);
    assert.equal(started[0].subscribeActive, undefined, platform);
    assert.equal(listeners.length, 0);
  }
});

test("the app's own subscribeActive is kept", async () => {
  const { started, client } = fakeClient();
  const { native, listeners } = fakeNative();
  const subscribeActive = () => () => {};
  await plugin('android', client, native).start({ ...options, subscribeActive });
  assert.equal(started[0].subscribeActive, subscribeActive);
  assert.equal(listeners.length, 0);
});

test('before start, flush and refresh do nothing and there are no metrics', async () => {
  const { recorders, client } = fakeClient();
  const replay = plugin('web', client);
  await replay.flush();
  await replay.refresh();
  await replay.stop();
  assert.deepEqual(await replay.getMetrics(), { metrics: null });
  await replay.start(options);
  await replay.flush();
  await replay.refresh();
  assert.deepEqual(recorders[0], { stopped: 0, flushed: 1, refreshed: 1 });
  assert.deepEqual(await replay.getMetrics(), { metrics: { recording: true, events: 1 } });
  await replay.stop();
  assert.equal(recorders[0].stopped, 1);
  assert.deepEqual(await replay.getMetrics(), { metrics: null });
});

test('starting again stops the running recorder first', async () => {
  const { started, recorders, client } = fakeClient();
  const replay = plugin('web', client);
  await replay.start(options);
  await replay.start({ ...options, endpoint: 'https://second.example.com' });
  assert.equal(started.length, 2);
  assert.equal(recorders[0].stopped, 1);
  assert.equal(recorders[1].stopped, 0);
  await replay.flush();
  assert.deepEqual(recorders.map((recorder) => recorder.flushed), [0, 1]);
});

test('while the client loads, only the latest start or stop takes effect', async () => {
  const { started, client } = fakeClient();
  const loading: (() => void)[] = [];
  const load = () => { for (const resolve of loading.splice(0)) resolve(); };
  const replay = createPlugin({
    platform: () => 'web', nativeAvailable: () => false, native: fakeNative().native,
    loadClient: () => new Promise<Client>((resolve) => { loading.push(() => resolve(client)); }),
  });
  const first = replay.start(options);
  const second = replay.start({ ...options, endpoint: 'https://second.example.com' });
  load();
  await Promise.all([first, second]);
  assert.deepEqual(started.map((value) => value.endpoint), ['https://second.example.com']);

  const third = replay.start(options);
  await replay.stop();
  load();
  await third;
  assert.equal(started.length, 1);
  assert.deepEqual(await replay.getMetrics(), { metrics: null });
});

test('a client that fails to load rejects start, and a later start still works', async () => {
  const { started, client } = fakeClient();
  let fail = true;
  const replay = createPlugin({
    platform: () => 'web', nativeAvailable: () => false, native: fakeNative().native,
    loadClient: async () => { if (fail) throw new Error('chunk failed to load'); return client; },
  });
  await assert.rejects(replay.start(options), /chunk failed to load/);
  assert.deepEqual(await replay.getMetrics(), { metrics: null });
  fail = false;
  await replay.start(options);
  assert.equal(started.length, 1);
});
