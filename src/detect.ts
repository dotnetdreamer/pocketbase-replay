import { ReplayHttpError } from './errors';
import type { ReplayTransport } from './types';

type Plugin = Record<string, unknown>;
interface CapacitorGlobal { getPlatform?: unknown; Plugins?: unknown }
interface HttpResponse { status?: unknown; data?: unknown }

// Capacitor is read from the page at call time, so the package never imports it.
function nativeCapacitor(): CapacitorGlobal | undefined {
  try {
    const capacitor = (globalThis as { Capacitor?: unknown }).Capacitor as CapacitorGlobal | null | undefined;
    if (!capacitor || typeof capacitor.getPlatform !== 'function') return undefined;
    const platform = (capacitor.getPlatform as () => unknown).call(capacitor);
    return platform === 'android' || platform === 'ios' ? capacitor : undefined;
  } catch { return undefined; }
}

function pluginOf(capacitor: CapacitorGlobal, name: string): Plugin | undefined {
  try {
    const plugins = capacitor.Plugins as Record<string, unknown> | null | undefined;
    const plugin = plugins && typeof plugins === 'object' ? plugins[name] : undefined;
    return plugin && (typeof plugin === 'object' || typeof plugin === 'function') ? plugin as Plugin : undefined;
  } catch { return undefined; }
}

export function nativeTransport(): ReplayTransport | undefined {
  const capacitor = nativeCapacitor();
  const http = capacitor && pluginOf(capacitor, 'CapacitorHttp');
  let method: 'post' | 'request';
  try {
    if (!http) return undefined;
    if (typeof http.post === 'function') method = 'post';
    else if (typeof http.request === 'function') method = 'request';
    else return undefined;
  } catch { return undefined; }
  // No beacon: a native pause flushes through this request instead.
  return {
    post: async (url, body) => {
      const request = { url, method: 'POST', headers: { 'Content-Type': 'text/plain' }, data: body, connectTimeout: 8000, readTimeout: 8000 };
      const response = await (http[method] as (options: typeof request) => Promise<HttpResponse>).call(http, request);
      const status = Number(response?.status);
      if (!(status >= 200 && status < 300)) throw new ReplayHttpError(Number.isFinite(status) ? status : 0);
      return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    },
  };
}

function quietly(action: () => unknown): void {
  try {
    const result = action() as PromiseLike<unknown> | undefined;
    if (result && typeof result.then === 'function') result.then(undefined, () => {});
  } catch { /* Cleanup must not reach the app. */ }
}

function nativeLifecycle(app: Plugin, listener: (active: boolean) => void): () => void {
  let removed = false;
  let handle: { remove: () => unknown } | undefined;
  const keep = (value: unknown) => {
    try {
      const candidate = value as { remove?: unknown } | null | undefined;
      if (!candidate || typeof candidate.remove !== 'function') return;
      const found = candidate as { remove: () => unknown };
      if (removed) quietly(() => found.remove()); else handle = found;
    } catch { /* An odd handle is left alone. */ }
  };
  try {
    const result = (app.addListener as (event: string, callback: (state: { isActive?: unknown }) => void) => unknown)
      .call(app, 'appStateChange', (state) => {
        try {
          if (!removed && state && typeof state.isActive === 'boolean') listener(state.isActive);
        } catch { /* Recording stays optional. */ }
      });
    // Capacitor hands back a promise of the handle; its own remove() on that promise is deprecated.
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') (result as PromiseLike<unknown>).then(keep, () => {});
    else keep(result);
  } catch { /* Pause and resume stay with pagehide and pageshow. */ }
  return () => {
    removed = true;
    const found = handle;
    handle = undefined;
    if (found) quietly(() => found.remove());
  };
}

export function autoLifecycle(listener: (active: boolean) => void): () => void {
  const capacitor = nativeCapacitor();
  if (capacitor) {
    // The Android WebView reports visibilitychange late, so native apps use the OS signal alone.
    const app = pluginOf(capacitor, 'App');
    try { return app && typeof app.addListener === 'function' ? nativeLifecycle(app, listener) : () => {}; } catch { return () => {}; }
  }
  try {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {};
    const change = () => { try { listener(document.visibilityState !== 'hidden'); } catch { /* Recording stays optional. */ } };
    document.addEventListener('visibilitychange', change);
    return () => { try { document.removeEventListener('visibilitychange', change); } catch { /* Cleanup must not reach the app. */ } };
  } catch { return () => {}; }
}

export function pageVisible(): boolean {
  try { return typeof document === 'undefined' || document.visibilityState !== 'hidden'; } catch { return true; }
}
