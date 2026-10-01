import { Capacitor } from '@capacitor/core';

import { NATIVE_PLUGIN_NAME, NativeReplay } from './native.js';
import { createPlugin } from './plugin.js';

export * from './definitions.js';

export const PocketBaseReplay = createPlugin({
  platform: () => Capacitor.getPlatform(),
  nativeAvailable: () => Capacitor.isPluginAvailable(NATIVE_PLUGIN_NAME),
  native: NativeReplay,
  // Loaded by start(), so bundlers split the client out of the app's first chunk.
  loadClient: () => import('pocketbase-replay'),
});
