import type { PluginListenerHandle } from '@capacitor/core';
import type { ObservabilityController, ObservabilityOptions, ReplayController, ReplayOptions } from 'pocketbase-replay';

import type { PocketBaseReplayPlugin } from './definitions.js';
import type { NativeReplayPlugin } from './native.js';

type SubscribeActive = NonNullable<ReplayOptions['subscribeActive']>;

export interface PluginRuntime {
  platform: () => string;
  nativeAvailable: () => boolean;
  native: NativeReplayPlugin;
  loadClient: () => Promise<{
    startReplay: (options: ReplayOptions) => ReplayController;
    startObservability: (options: ObservabilityOptions) => ObservabilityController;
  }>;
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
  let observability: ObservabilityController | undefined;
  // Every start and stop takes a new number, so a start still loading the client knows it was overtaken.
  let generation = 0;
  let observabilityGeneration = 0;

  function halt(): void {
    const running = controller;
    controller = undefined;
    running?.stop();
  }
  function haltObservability(): void {
    const running = observability;
    observability = undefined;
    running?.stop();
  }
  function observabilityOptions(options: ObservabilityOptions): ObservabilityOptions {
    return { ...options, subscribeActive: options.subscribeActive ?? subscribeActive(),
      replay: options.replay ?? { getSessionContext: () => controller?.getSessionContext() ?? null } };
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
      // Only options that ask for errors or logs replace the running capture; a replay-only start leaves it running.
      const capture = !!(options.errors || options.logs);
      const captureRun = capture ? ++observabilityGeneration : 0;
      halt();
      if (capture) haltObservability();
      const { startReplay, startObservability } = await runtime.loadClient();
      // Both controllers ask the server for their settings themselves, and capture queues until the answer.
      if (capture && captureRun === observabilityGeneration) observability = startObservability(observabilityOptions(options));
      if (run !== generation) return;
      controller = startReplay({ ...options, subscribeActive: options.subscribeActive ?? subscribeActive() });
    },
    async stop() {
      generation++; observabilityGeneration++;
      halt(); haltObservability();
    },
    async flush() {
      await Promise.all([controller?.flush(), observability?.flush()]);
    },
    async refresh() {
      await Promise.all([controller?.refresh(), observability?.refresh()]);
    },
    async getMetrics() {
      return { metrics: controller?.getMetrics() ?? null };
    },
    async startObservability(options) {
      const run = ++observabilityGeneration;
      haltObservability();
      const { startObservability } = await runtime.loadClient();
      if (run !== observabilityGeneration) return;
      observability = startObservability(observabilityOptions(options));
    },
    async stopObservability() {
      observabilityGeneration++;
      haltObservability();
    },
    async captureException({ error, ...context }) {
      return { id: observability?.captureException(error, context) ?? null };
    },
    async captureLog({ level, message, attributes }) {
      return { id: observability?.captureLog(level, message, attributes) ?? null };
    },
    async getObservabilityMetrics() {
      return { metrics: observability?.getMetrics() ?? null };
    },
  };
}
