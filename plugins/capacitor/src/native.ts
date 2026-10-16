import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface AppState {
  isActive: boolean;
}

export interface NativeScreenshotOptions { requestId: string; maxDimension: number }
export interface NativeScreenshotResult { data: string; width: number; height: number }

// The Android and iOS half of the plugin. There is no web half: in a browser the client watches the page itself.
export interface NativeReplayPlugin {
  addListener(eventName: 'appStateChange', listener: (state: AppState) => void): Promise<PluginListenerHandle>;
  captureScreenshot(options: NativeScreenshotOptions): Promise<NativeScreenshotResult>;
}

export const NATIVE_PLUGIN_NAME = 'PocketBaseReplay';

export const NativeReplay = registerPlugin<NativeReplayPlugin>(NATIVE_PLUGIN_NAME);
