#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
let work;
const appId = 'io.pbreplay.verification';
const port = Number(process.env.REPLAY_TEST_PORT || 8099);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid REPLAY_TEST_PORT');
const endpointIndex = process.argv.indexOf('--endpoint');
const endpoint = endpointIndex < 0 ? `http://localhost:${port}` : process.argv[endpointIndex + 1];
const address = new URL(endpoint);
assert.ok(address.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(address.hostname), 'Use a loopback HTTP PocketBase fixture');
assert.equal(address.pathname, '/', 'Use the server origin without a path');
assert.ok(!address.username && !address.password && !address.search && !address.hash);
const reversePort = Number(address.port || 80);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
const adb = process.env.REPLAY_ADB_BIN || join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const maestro = process.env.REPLAY_MAESTRO_BIN || 'maestro';
let device = process.env.REPLAY_ANDROID_DEVICE || '';
let backend;
let backendOutput = '';
let installed = false;
let reversed = false;
let interrupted = false;
const running = new Set();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  running.add(child);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => signal ? reject(new Error(`${command} stopped: ${signal}`)) : resolve(code));
    });
    assert.equal(status, 0, `${command} failed`);
  } finally { running.delete(child); }
}

function adbCommand(args) { return execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8' }); }

async function write(path, contents) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }

async function request(path, body, token = '') {
  const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
}

function stop() {
  interrupted = true;
  for (const child of running) child.kill('SIGTERM');
  backend?.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  work = await mkdtemp(join(tmpdir(), 'pb-replay-android-'));
  const devices = execFileSync(adb, ['devices'], { encoding: 'utf8' }).split('\n').map(line => /^([^\s]+)\s+device\b/.exec(line)?.[1]).filter(Boolean);
  if (!device) {
    const emulators = devices.filter(id => id.startsWith('emulator-'));
    assert.equal(emulators.length, 1, 'Run one visible Android emulator, or set REPLAY_ANDROID_DEVICE');
    device = emulators[0];
  }
  assert.ok(devices.includes(device), 'The selected Android device is not ready');
  assert.equal(adbCommand(['shell', 'getprop', 'sys.boot_completed']).trim(), '1', 'Wait for Android to boot');
  console.log(`Testing on existing device ${device}; no emulator will be started`);
  execFileSync(maestro, ['--version'], { stdio: 'ignore' });

  if (endpointIndex < 0) {
    assert.ok(process.env.REPLAY_PB_BIN, 'Set REPLAY_PB_BIN, or pass --endpoint for an already-running loopback fixture');
    try {
      const health = await fetch(endpoint + '/api/health', { signal: AbortSignal.timeout(1000) });
      assert.ok(!health.ok, `${endpoint} is already in use; choose REPLAY_TEST_PORT or pass --endpoint`);
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    backend = spawn(process.execPath, [join(root, 'scripts/verify-observability.mjs'), '--serve'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REPLAY_TEST_PORT: String(port) } });
    for (const stream of [backend.stdout, backend.stderr]) stream.on('data', data => {
      const text = String(data); backendOutput = (backendOutput + text).slice(-30000); process.stdout.write(text);
    });
    const deadline = Date.now() + 180000;
    while (!backendOutput.includes('Dashboard fixture:')) {
      assert.ok(!interrupted, 'Interrupted');
      assert.equal(backend.exitCode, null, backendOutput);
      assert.ok(Date.now() < deadline, 'PocketBase fixture did not become ready');
      await wait(200);
    }
  }
  await request('/api/health');
  const auth = await request('/api/collections/_superusers/auth-with-password', { identity: 'observability@local.test', password: 'observability-local-test-123' });
  const settings = await request('/api/replay/observability/settings', undefined, auth.token);
  assert.ok(settings.errors_enabled && settings.logs_enabled, 'Enable errors and logs on the loopback verification fixture');

  const pluginAndroid = join(root, 'plugins/capacitor/android');
  const capacitorAndroid = join(root, 'plugins/capacitor/node_modules/@capacitor/android/capacitor');
  const copyOptions = { recursive: true, filter: path => !/(?:^|[/\\])(?:build|\.gradle)(?:[/\\]|$)/.test(path) };
  await cp(pluginAndroid, join(work, 'replay-plugin'), copyOptions);
  await cp(capacitorAndroid, join(work, 'capacitor'), copyOptions);
  await cp(join(pluginAndroid, 'gradle'), join(work, 'gradle'), { recursive: true });
  for (const file of ['gradlew', 'gradlew.bat']) await cp(join(pluginAndroid, file), join(work, file));
  await write(join(work, 'settings.gradle'), "include ':app', ':capacitor-android', ':replay-plugin'\nproject(':capacitor-android').projectDir = new File('capacitor')\n");
  await write(join(work, 'build.gradle'), "buildscript { repositories { google(); mavenCentral() }; dependencies { classpath 'com.android.tools.build:gradle:8.13.0' } }\nallprojects { repositories { google(); mavenCentral() } }\n");
  await write(join(work, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx1024m\norg.gradle.workers.max=2\nandroid.useAndroidX=true\n');
  await write(join(work, 'local.properties'), 'sdk.dir=' + sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:') + '\n');
  await write(join(work, 'app/build.gradle'), `apply plugin: 'com.android.application'
android { namespace '${appId}'; compileSdk 36; defaultConfig { applicationId '${appId}'; minSdk 24; targetSdk 36; versionCode 1; versionName '1' }; compileOptions { sourceCompatibility JavaVersion.VERSION_21; targetCompatibility JavaVersion.VERSION_21 } }
dependencies { implementation project(':capacitor-android'); implementation project(':replay-plugin'); implementation 'androidx.appcompat:appcompat:1.7.1' }
`);
  await write(join(work, 'app/src/main/AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.INTERNET"/><application android:label="Replay verification" android:theme="@style/AppTheme" android:usesCleartextTraffic="true"><activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTask" android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>');
  await write(join(work, 'app/src/main/res/values/styles.xml'), '<resources><style name="AppTheme" parent="Theme.AppCompat.Light.NoActionBar"/></resources>');
  await write(join(work, 'app/src/main/java/io/pbreplay/verification/MainActivity.java'), `package ${appId};
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.dotnetdreamer.pocketbasereplay.capacitor.PocketBaseReplayPlugin;
public class MainActivity extends BridgeActivity {
 @Override public void onCreate(Bundle savedInstanceState) { registerPlugin(PocketBaseReplayPlugin.class); super.onCreate(savedInstanceState); }
}
`);
  await write(join(work, 'app/src/main/assets/capacitor.config.json'), JSON.stringify({ appId, appName: 'Replay verification', webDir: 'public', server: { androidScheme: 'http' }, android: { webContentsDebuggingEnabled: true, allowMixedContent: true } }));
  await write(join(work, 'app/src/main/assets/capacitor.plugins.json'), '[]');
  await write(join(work, 'app/src/main/assets/public/index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><script defer src="app.js"></script></head><body>Starting Android verification</body></html>');
  await build({ entryPoints: [join(root, 'test/fixtures/observability-android.ts')], outfile: join(work, 'app/src/main/assets/public/app.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', define: { __REPLAY_ANDROID_ENDPOINT__: JSON.stringify(endpoint) }, alias: { 'pocketbase-replay': join(root, 'src/index.ts'), '@capacitor/core': join(root, 'plugins/capacitor/node_modules/@capacitor/core/dist/index.js') } });
  const java = process.env.JAVA_HOME || (process.platform === 'darwin' ? execFileSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' }).trim() : undefined);
  await run(process.platform === 'win32' ? join(work, 'gradlew.bat') : 'sh', process.platform === 'win32' ? [':app:assembleDebug', '--no-daemon', '--console=plain'] : [join(work, 'gradlew'), ':app:assembleDebug', '--no-daemon', '--console=plain'], { cwd: work, ...(process.platform === 'win32' ? { shell: true } : {}), env: { ...process.env, ...(java ? { JAVA_HOME: java } : {}) } });
  assert.ok(!interrupted, 'Interrupted');
  const mappings = adbCommand(['reverse', '--list']);
  const existing = mappings.split('\n').find(line => line.includes(` tcp:${reversePort} `));
  if (existing) assert.ok(existing.trim().endsWith(`tcp:${reversePort}`), 'The required reverse port belongs to another mapping');
  else { adbCommand(['reverse', `tcp:${reversePort}`, `tcp:${reversePort}`]); reversed = true; }
  await run(adb, ['-s', device, 'install', '-r', join(work, 'app/build/outputs/apk/debug/app-debug.apk')]);
  installed = true;
  adbCommand(['shell', 'pm', 'clear', appId]);
  const startedAt = Date.now();
  await run(maestro, ['--device', device, 'test', '--format', 'JUNIT', '--output', join(work, 'report.xml'), '--debug-output', join(work, 'maestro'), '--test-output-dir', join(work, 'artifacts'), join(root, 'scripts/e2e/observability-android.yaml')]);
  const query = new URLSearchParams({ service: 'android-native-verification', deviceId: 'android-observability-fixture', from: String(startedAt) });
  const issues = await request('/api/replay/issues?' + query, undefined, auth.token);
  const occurrences = [];
  for (const issue of issues.items) occurrences.push(...(await request(`/api/replay/issues/${issue.id}?${query}`, undefined, auth.token)).items);
  for (const message of ['Android startup before config', 'Android real JS stack', 'Android DOMException denied', 'Android grouped error alpha', 'Android grouped error beta', 'Android after replay-only start', 'Android native resumed error']) assert.ok(occurrences.some(event => event.message === message), `Missing persisted ${message}`);
  assert.ok(occurrences.find(event => event.message === 'Android real JS stack').stack.includes('androidStackProbe'));
  assert.equal(occurrences.find(event => event.message === 'Android DOMException denied').name, 'NotAllowedError');
  const grouped = occurrences.filter(event => event.message.startsWith('Android grouped error'));
  assert.equal(grouped.length, 2); assert.equal(grouped[0].issueId, grouped[1].issueId);
  const logs = await request('/api/replay/logs?' + query, undefined, auth.token);
  for (const message of ['Android background pending', 'Android native background', 'Android native resumed']) assert.ok(logs.items.some(event => event.message === message), `Missing persisted ${message}`);
  assert.ok(occurrences.every(event => event.platform === 'android') && logs.items.every(event => event.platform === 'android'));
  console.log(`Android verification passed: ${occurrences.length} persisted errors, ${logs.totalItems} lifecycle logs; real JS stack, DOMException, startup, grouping and native background/resume`);
  console.log((await readFile(join(work, 'report.xml'), 'utf8')).split('\n').slice(0, 3).join('\n'));
  if (process.argv.includes('--keep-open')) {
    console.log(`Fixture remains visible at ${endpoint}; press Ctrl+C to remove its app and temporary files`);
    while (!interrupted) await wait(200);
  }
} finally {
  for (const child of running) child.kill('SIGTERM');
  if (installed) {
    try { adbCommand(['shell', 'am', 'force-stop', appId]); adbCommand(['uninstall', appId]); } catch {}
  }
  if (reversed) { try { adbCommand(['reverse', '--remove', `tcp:${reversePort}`]); } catch {} }
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise(resolve => { backend.once('exit', resolve); setTimeout(resolve, 10000).unref(); });
  }
  if (work) await rm(work, { recursive: true, force: true });
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
