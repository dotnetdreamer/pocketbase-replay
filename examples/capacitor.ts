import { Capacitor } from '@capacitor/core';
// Registers the App plugin, whose appStateChange event pauses and resumes recording.
import '@capacitor/app';
import { startReplay } from 'pocketbase-replay';

// CapacitorHttp, pause and resume, and this build's archived images and fonts are picked up at run time.
export function recordApp(deviceId: string, appVersion: string) {
  return startReplay({
    endpoint: 'https://replay.example.com',
    metadata: () => ({ deviceId, platform: Capacitor.getPlatform(), appVersion }),
  });
}
