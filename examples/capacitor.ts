import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { startReplay, ReplayHttpError } from 'pocketbase-replay';

const native = ['android', 'ios'].includes(Capacitor.getPlatform());

export function recordApp(deviceId: string) {
  return startReplay({
    endpoint: 'https://replay.example.com',
    metadata: () => ({ deviceId, platform: Capacitor.getPlatform(), appVersion: '1.0.0' }),
    transport: native ? {
      async post(url, body) {
        const response = await CapacitorHttp.post({
          url, data: body, headers: { 'Content-Type': 'text/plain' },
          connectTimeout: 8000, readTimeout: 8000,
        });
        if (response.status < 200 || response.status >= 300) throw new ReplayHttpError(response.status);
        return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      },
    } : undefined,
    subscribeActive(listener) {
      let removed = false;
      const handle = App.addListener('appStateChange', ({ isActive }) => listener(isActive));
      void handle.then((value) => { if (removed) void value.remove(); }).catch(() => {});
      return () => { removed = true; void handle.then((value) => value.remove()).catch(() => {}); };
    },
  });
}
