import { gzip, gzipSync, strToU8 } from 'fflate';
import { createReplay } from './engine';
import type { ReplayController, ReplayOptions, ReplayTransport } from './types';

export type { ReplayController, ReplayOptions, ReplayMetadata, ReplayMetrics, ReplayTransport } from './types';

export class ReplayHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Replay HTTP ${status}`);
  }
}

export function fetchTransport(): ReplayTransport {
  return {
    post: async (url, body) => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body, credentials: 'omit', signal: abort.signal, keepalive: body.length <= 60000 && typeof document !== 'undefined' && document.visibilityState === 'hidden',
        });
        if (!response.ok) throw new ReplayHttpError(response.status);
        return await response.json();
      } finally { clearTimeout(timeout); }
    },
    beacon: (url, body) => typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' })) : false,
  };
}

export function startReplay(options: ReplayOptions): ReplayController {
  return createReplay({ ...options, transport: options.transport ?? fetchTransport() }, {
    now: () => Date.now(),
    performanceNow: () => typeof performance === 'undefined' ? Date.now() : performance.now(),
    schedule: (callback, ms) => setTimeout(callback, ms),
    cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    loadRecorder: async () => (await import('./recorder')).recorder,
    compress: (raw) => new Promise((resolve, reject) => {
      let done = false;
      let cancel: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cancel?.();
        reject(new Error('Replay compression timed out'));
      }, 10000);
      try {
        cancel = gzip(strToU8(raw), { level: 1 }, (error, data) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(data);
        });
      } catch (error) {
        done = true;
        clearTimeout(timer);
        reject(error);
      }
    }),
    compressSync: (raw) => gzipSync(strToU8(raw), { level: 1 }),
    subscribe: (active) => {
      const pagehide = () => active(false, true);
      const pageshow = () => active(true);
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', pagehide);
        window.addEventListener('pageshow', pageshow);
      }
      let remove: (() => void) | undefined;
      try { remove = options.subscribeActive?.((value) => active(value)); } catch { /* Recording stays optional. */ }
      return () => {
        if (typeof window !== 'undefined') {
          window.removeEventListener('pagehide', pagehide);
          window.removeEventListener('pageshow', pageshow);
        }
        try { remove?.(); } catch { /* Cleanup must not reach the app. */ }
      };
    },
  });
}
