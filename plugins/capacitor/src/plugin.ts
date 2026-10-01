import type { PluginListenerHandle } from '@capacitor/core';
import type { ReplayController, ReplayOptions } from 'pocketbase-replay';

import type { PocketBaseReplayPlugin } from './definitions.js';
import type { NativeReplayPlugin } from './native.js';

type SubscribeActive = NonNullable<ReplayOptions['subscribeActive']>;

export interface PluginRuntime {
  platform: () => string;
  nativeAvailable: () => boolean;
  native: NativeReplayPlugin;
  loadClient: () => Promise<{ startReplay: (options: ReplayOptions) => ReplayController }>;
}

function quietly(action: () => Promise<unknown>): void {
  try { action().catch(() => {}); } catch { /* Cleanup must not reach the app. */ }
}

function nativeLifecycle(native: NativeReplayPlugin): SubscribeActive {
  return (listener) => {
    let removed = false;
    let handle: PluginListenerHandle | undefined;
    native.addListener('appStateChange', (state) => {
      try {
        if (!removed && typeof state?.isActive === 'boolean') listener(state.isActive);
      } catch { /* Recording stays optional. */ }
    }).then((found) => {
      // The client may unsubscribe before the bridge hands back the handle.
      if (removed) quietly(() => found.remove()); else handle = found;
    }, () => {});
    return () => {
      removed = true;
      const found = handle;
      handle = undefined;
      if (found) quietly(() => found.remove());
    };
  };
}

export function createPlugin(runtime: PluginRuntime): PocketBaseReplayPlugin {
  let controller: ReplayController | undefined;
  // Every start and stop takes a new number, so a start still loading the client knows it was overtaken.
  let generation = 0;

  function halt(): void {
    const running = controller;
    controller = undefined;
    running?.stop();
  }

  function subscribeActive(): SubscribeActive | undefined {
    const platform = runtime.platform();
    // Before `npx cap sync` there is no native half, and the client keeps its own detection.
    if ((platform !== 'android' && platform !== 'ios') || !runtime.nativeAvailable()) return undefined;
    return nativeLifecycle(runtime.native);
  }

  return {
    async start(options) {
      const run = ++generation;
      halt();
      const { startReplay } = await runtime.loadClient();
      if (run !== generation) return;
      controller = startReplay({ ...options, subscribeActive: options.subscribeActive ?? subscribeActive() });
    },
    async stop() {
      generation++;
      halt();
    },
    async flush() {
      await controller?.flush();
    },
    async refresh() {
      await controller?.refresh();
    },
    async getMetrics() {
      return { metrics: controller?.getMetrics() ?? null };
    },
  };
}
