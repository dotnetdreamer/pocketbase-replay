import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// The package's own name resolves to its built files, the way an app imports it.
import { PocketBaseReplay } from 'capacitor-pocketbase-replay';

test('the built package resolves to compiled JavaScript', () => {
  assert.ok(fileURLToPath(import.meta.resolve('capacitor-pocketbase-replay')).endsWith(join('dist', 'index.js')));
});

test('the packed Swift manifest includes sources for every declared target', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json'];
  const executable = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const commandArgs = process.platform === 'win32' ? ['/d', '/c', 'npm.cmd', ...args] : args;
  const [packed] = JSON.parse(execFileSync(executable, commandArgs, { cwd: root, encoding: 'utf8' }));
  const files: string[] = packed.files.map((file: { path: string }) => file.path);
  const manifest = readFileSync(join(root, 'Package.swift'), 'utf8');
  const targets = [...manifest.matchAll(/path:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(files.includes('Package.swift'));
  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.ok(files.some((file) => file.startsWith(`${target}/`) && file.endsWith('.swift')), `${target} must ship with the Swift manifest`);
  }
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
