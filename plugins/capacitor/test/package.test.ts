import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// The package's own name resolves to its built files, the way an app imports it.
import { PocketBaseReplay } from 'capacitor-pocketbase-replay';

test('the built package resolves to compiled JavaScript', () => {
  assert.ok(fileURLToPath(import.meta.resolve('capacitor-pocketbase-replay')).endsWith(join('dist', 'index.js')));
});

test('the built package drives the real client, which stays off without an endpoint', async () => {
  await PocketBaseReplay.start({ endpoint: '', metadata: () => ({ deviceId: 'package-test', platform: 'web', appVersion: 'test' }) });
  await PocketBaseReplay.refresh();
  await PocketBaseReplay.flush();
  const { metrics } = await PocketBaseReplay.getMetrics();
  assert.equal(metrics?.recording, false);
  assert.equal(metrics?.sessionId, null);
  await PocketBaseReplay.stop();
  assert.deepEqual(await PocketBaseReplay.getMetrics(), { metrics: null });
});
