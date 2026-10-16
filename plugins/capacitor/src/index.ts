import { Capacitor } from '@capacitor/core';

import { NATIVE_PLUGIN_NAME, NativeReplay } from './native.js';
import { createPlugin } from './plugin.js';
import { watchShadowRoots } from './shadow-roots.js';

export * from './definitions.js';

// Screenshot mode can inspect a closed shadow root only if it saw it attached, so on Android and iOS the watch
// begins when the app loads the plugin, before its components render. It notes closed roots and changes nothing.
if (Capacitor.isNativePlatform() && typeof window !== 'undefined') watchShadowRoots(window);

export const PocketBaseReplay = createPlugin({
  platform: () => Capacitor.getPlatform(),
  nativeAvailable: () => Capacitor.isPluginAvailable(NATIVE_PLUGIN_NAME),
  native: NativeReplay,
  // Loaded by start(), so bundlers split the client out of the app's first chunk.
  loadClient: () => import('pocketbase-replay'),
});
