#!/usr/bin/env node
// Synthetic local HTTP benchmark. Every run owns a fresh, temporary PocketBase database.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, platform, release, arch, cpus, totalmem } from 'node:os';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const options = { port: 8111, devices: 20, seconds: 30, 'requests-per-second': 5, 'idle-seconds': 10, 'cooldown-seconds': 5, 'sample-ms': 200, output: 'docs/benchmarks/local-pocketbase-replay' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!process.argv[i].startsWith('--') || !['pb', ...Object.keys(options)].includes(key) || !process.argv[i + 1]) throw new Error('Use --pb /path/to/pocketbase [--port 8111 --output docs/benchmarks/name]');
  options[key] = ['pb', 'output'].includes(key) ? process.argv[i + 1] : Number(process.argv[i + 1]);
}
assert.ok(options.pb, 'An explicit --pb binary path is required; this script never downloads a binary');
for (const key of ['port', 'devices', 'seconds', 'requests-per-second', 'idle-seconds', 'cooldown-seconds', 'sample-ms']) assert.ok(Number.isInteger(options[key]) && options[key] > 0, key);
assert.ok(options.port >= 1024 && options.port <= 65535 && options.port !== 8109, 'Use an unused local port; 8109 is reserved for the manual fixture');
assert.ok(options.devices <= 20 && options.seconds * options['requests-per-second'] <= 180, 'Keep this defaults-preserving sample at no more than 20 devices and 180 upload calls');
assert.ok(['darwin', 'linux'].includes(platform()), 'RSS/CPU sampling uses macOS or Linux ps');
const binary = resolve(root, options.pb);
const outputPrefix = resolve(root, options.output);
const endpoint = `http://127.0.0.1:${options.port}`;
const identity = 'resource-benchmark@local.test';
const password = randomBytes(24).toString('hex');
const work = await mkdtemp(join(tmpdir(), 'pb-resource-benchmark-'));
await mkdir(join(root, '.replay-evidence'), { recursive: true });
const evidence = await mkdtemp(join(root, '.replay-evidence', 'benchmark-'));
await mkdir(dirname(outputPrefix), { recursive: true });
let server;
let sampler;
let sampling = Promise.resolve();
let samplingBusy = false;
let samplerError;
let phase = 'startup';
let serverLog = '';
let admin = '';
const samples = [];
const requestResults = [];
const uploadResults = [];
const origin = performance.now();
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const pause = ms => sleep(ms, undefined, { signal: abort.signal });
const hash = value => createHash('sha256').update(value).digest('hex');
const round = value => Math.round(value * 1000000) / 1000000;

async function command(command, args) { return (await exec(command, args, { cwd: root })).stdout.trim(); }
function isAlive(child) { return !!child && child.exitCode === null && child.signalCode === null; }
async function stopServer() {
  if (!isAlive(server)) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  await exited;
}
async function manifest(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await manifest(path));
    else if (entry.isFile()) result.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: hash(await readFile(path)) });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function cpuSeconds(value) {
  let days = 0;
  if (value.includes('-')) { const parts = value.split('-'); days = Number(parts[0]); value = parts[1]; }
  return days * 86400 + value.split(':').reduce((sum, item) => sum * 60 + Number(item), 0);
}
async function sample() {
  const value = await command('ps', ['-p', String(server.pid), '-o', 'rss=,time=']);
  const [rss, time] = value.split(/\s+/);
  assert.ok(Number.isFinite(Number(rss)) && time, 'PocketBase process must remain available for ps sampling');
  const resolution = time.includes('.') ? 10 ** -time.split('.')[1].length : 1;
  const result = { elapsedSeconds: round((performance.now() - origin) / 1000), phase, rssKiB: Number(rss), cumulativeCpuSeconds: round(cpuSeconds(time)), cpuResolutionSeconds: resolution };
  samples.push(result);
  return result;
}
function summarize(start, end, currentPhase) {
  const selected = samples.filter(value => value.phase === currentPhase && value.elapsedSeconds >= start.elapsedSeconds && value.elapsedSeconds <= end.elapsedSeconds);
  const wallSeconds = end.elapsedSeconds - start.elapsedSeconds;
  const deltaCpuSeconds = end.cumulativeCpuSeconds - start.cumulativeCpuSeconds;
  return { wallSeconds: round(wallSeconds), cpuSeconds: round(deltaCpuSeconds), averageCpuPercentOfOneCore: round(deltaCpuSeconds / wallSeconds * 100), averageCpuPercentOfAllLogicalCores: round(deltaCpuSeconds / wallSeconds * 100 / cpus().length), rssStartMiB: round(start.rssKiB / 1024), rssEndMiB: round(end.rssKiB / 1024), sampledPeakRssMiB: round(Math.max(start.rssKiB, end.rssKiB, ...selected.map(value => value.rssKiB)) / 1024), samples: selected.length };
}
async function request(path, body, auth = false, upload) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const started = performance.now();
  try {
    const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': path.startsWith('/api/collections') ? 'application/json' : 'text/plain;charset=UTF-8', ...(auth ? { Authorization: admin } : {}) }, body: json, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]) });
    const data = await response.json();
    const result = { path, status: response.status, latencyMs: round(performance.now() - started), requestBodyBytes: json === undefined ? 0 : Buffer.byteLength(json), ...upload, acceptedEvents: data.accepted || 0 };
    requestResults.push(result);
    if (upload) uploadResults.push(result);
    else assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
    return data;
  } catch (error) {
    if (!upload) throw error;
    const result = { path, status: 0, latencyMs: round(performance.now() - started), requestBodyBytes: Buffer.byteLength(json), ...upload, acceptedEvents: 0, error: error.message };
    requestResults.push(result); uploadResults.push(result);
  }
}
async function databaseFiles() {
  const result = [];
  for (const entry of await readdir(join(work, 'pb_data'), { withFileTypes: true })) {
    if (entry.isFile() && /\.db(?:-wal|-shm)?$/.test(entry.name)) result.push({ file: entry.name, bytes: (await stat(join(work, 'pb_data', entry.name))).size });
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
function payloads(now) {
  let seed = 123456789;
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
  const text = length => Array.from({ length }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return alphabet[(seed >>> 0) % alphabet.length]; }).join('');
  const children = Array.from({ length: 100 }, (_, index) => ({ type: 2, id: 100 + index, tagName: 'div', attributes: { class: 'card', 'data-item': String(index) }, childNodes: [{ type: 3, id: 300 + index, textContent: 'Synthetic card ' + text(64) }] }));
  const incremental = Array.from({ length: 200 }, (_, index) => ({ type: 3, timestamp: now + index + 2, data: { source: 0, texts: [{ id: 300 + index % 100, value: 'Synthetic card update ' + text(64) }], attributes: [], removes: [], adds: [] } }));
  const snapshot = [
    { type: 4, timestamp: now, data: { href: 'https://benchmark.test/checkout', width: 390, height: 844 } },
    { type: 2, timestamp: now + 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [{ type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] }, { type: 2, id: 4, tagName: 'body', attributes: {}, childNodes: children }] }] } } },
    ...incremental,
  ];
  const encode = events => { const raw = Buffer.from(JSON.stringify(events)), gzip = gzipSync(raw, { level: 6 }); return { raw, gzip, data: gzip.toString('base64'), events: events.length }; };
  return { snapshot: encode(snapshot), incremental: encode(incremental) };
}

try {
  const probe = createServer();
  await new Promise((resolveProbe, reject) => { probe.once('error', reject); probe.listen(options.port, '127.0.0.1', resolveProbe); });
  await new Promise(resolveProbe => probe.close(resolveProbe));
  const sourceManifest = [...await manifest(join(root, 'server', 'pb_hooks')), ...await manifest(join(root, 'server', 'pb_migrations'))].sort((a, b) => a.path.localeCompare(b.path));
  const scriptSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  const binarySha256 = hash(await readFile(binary));
  const pocketbaseVersion = await command(binary, ['--version']);
  const gitCommit = await command('git', ['rev-parse', 'HEAD']);
  const hardware = { os: platform(), kernelRelease: release(), architecture: arch(), cpu: cpus()[0]?.model, logicalCores: cpus().length, ramBytes: totalmem() };
  if (platform() === 'darwin') {
    hardware.osVersion = await command('sw_vers', ['-productVersion']);
    hardware.osBuild = await command('sw_vers', ['-buildVersion']);
    hardware.model = await command('sysctl', ['-n', 'hw.model']);
    hardware.cpu = await command('sysctl', ['-n', 'machdep.cpu.brand_string']);
  }
  await writeFile(join(evidence, 'run-config.json'), JSON.stringify({ arguments: process.argv.slice(2), gitCommit, scriptSha256, binarySha256 }, null, 2) + '\n');
  await writeFile(join(evidence, 'benchmark-server.mjs'), await readFile(fileURLToPath(import.meta.url)));
  await exec(process.execPath, [join(root, 'scripts', 'install.mjs'), '--target', work], { cwd: root });
  await exec(binary, ['superuser', 'upsert', identity, password, '--dir', join(work, 'pb_data')], { cwd: work });
  server = spawn(binary, ['serve', '--http=127.0.0.1:' + options.port, '--dir', join(work, 'pb_data')], { cwd: work, env: { ...process.env, REPLAY_AUTH_URL: '', REPLAY_TRUSTED_PROXY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', value => { serverLog += value; });
  const deadline = performance.now() + 15000;
  for (;;) {
    if (!isAlive(server)) throw new Error('Benchmark PocketBase exited during startup');
    try { if ((await fetch(endpoint + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (performance.now() > deadline) throw new Error('Benchmark PocketBase did not start');
    await pause(100);
  }
  phase = 'setup';
  const setupStart = await sample();
  sampler = setInterval(() => {
    if (samplingBusy) return;
    samplingBusy = true;
    sampling = sample().catch(error => { samplerError = error; abort.abort(); }).finally(() => { samplingBusy = false; });
  }, options['sample-ms']);
  admin = (await request('/api/collections/_superusers/auth-with-password', { identity, password })).token;
  const originalRecording = await request('/api/replay/settings', undefined, true);
  const originalDiagnostics = await request('/api/replay/observability/settings', undefined, true);
  const configuredRecording = await request('/api/replay/settings', { ...originalRecording, mode: 'percentage', percentage: 100 }, true);
  const configuredDiagnostics = await request('/api/replay/observability/settings', { ...originalDiagnostics, errors_enabled: true, logs_enabled: true }, true);
  const configuredLimits = await request('/api/replay/security/limits', undefined, true);
  const security = await request('/api/replay/security', undefined, true);
  assert.equal(security.requireApiKey, false); assert.equal(security.requireAccount, false);
  const devices = [];
  for (let index = 0; index < options.devices; index++) {
    const metadata = { deviceId: 'bench-device-' + String(index).padStart(3, '0'), platform: 'web', appVersion: 'benchmark-v1', room: 'SIMULATED' };
    assert.equal((await request('/api/replay/config', metadata)).enabled, true);
    const recording = await request('/api/replay/start', metadata);
    const diagnostics = await request('/api/replay/observability/config', metadata);
    assert.equal(recording.enabled, true); assert.equal(diagnostics.enabled, true);
    devices.push({ metadata, recording, diagnostics, seq: 0 });
  }
  const setupEnd = await sample();
  const setupRequests = requestResults.length;
  console.log('Setup complete; sampling idle PocketBase for ' + options['idle-seconds'] + ' seconds');
  phase = 'idle'; const idleStart = await sample();
  await pause(options['idle-seconds'] * 1000);
  const idleEnd = await sample();
  const databaseBefore = await databaseFiles();
  const timestamp = Date.now();
  const templates = payloads(timestamp);
  await writeFile(join(evidence, 'snapshot.json'), templates.snapshot.raw);
  await writeFile(join(evidence, 'incremental.json'), templates.incremental.raw);
  const baseError = { timestamp, name: 'TypeError', message: 'Synthetic checkout request failed', stack: 'TypeError: Synthetic checkout request failed\n    at checkout (https://benchmark.test/assets/app.js:100:5)', service: 'backend-benchmark', handled: true, attributes: { fixture: 'synthetic-http', component: 'checkout' } };
  const baseLog = { timestamp, level: 'info', message: 'Synthetic checkout action completed', service: 'backend-benchmark', attributes: { fixture: 'synthetic-http', step: 'checkout', itemCount: 2, amount: 19.95 } };
  await writeFile(join(evidence, 'error-template.json'), JSON.stringify(baseError, null, 2) + '\n');
  await writeFile(join(evidence, 'log-template.json'), JSON.stringify(baseLog, null, 2) + '\n');
  console.log('Load started: ' + options.devices + ' synthetic devices, ' + options['requests-per-second'] + ' total upload requests/second for ' + options.seconds + ' seconds');
  phase = 'load'; const loadStart = await sample(); const loadOrigin = performance.now(); const uploads = [];
  const scheduled = options.seconds * options['requests-per-second'];
  for (let index = 0; index < scheduled; index++) {
    await pause(Math.max(0, loadOrigin + index * 1000 / options['requests-per-second'] - performance.now()));
    const device = devices[Math.floor(index / 3) % devices.length];
    const type = index % 3;
    if (type === 0) {
      const seq = device.seq++;
      const payload = seq === 0 ? templates.snapshot : templates.incremental;
      uploads.push(request('/api/replay/chunks', { sessionId: device.recording.sessionId, token: device.recording.token, seq, startedAt: timestamp, endedAt: timestamp + 201, room: 'SIMULATED', encoding: 'gzip-base64', data: payload.data, rawBytes: payload.raw.length, eventCount: payload.events, hasSnapshot: seq === 0 }, false, { kind: 'replay', replayRawBytes: payload.raw.length, replayCompressedBytes: payload.gzip.length, entries: payload.events }));
    } else if (type === 1) {
      const events = [{ ...baseError, id: 'bench-error-' + String(index).padStart(9, '0') }];
      uploads.push(request('/api/replay/errors', { token: device.diagnostics.token, events }, false, { kind: 'errors', entries: events.length }));
    } else {
      const events = Array.from({ length: 10 }, (_, event) => ({ ...baseLog, id: 'bench-log-' + String(index).padStart(9, '0') + '-' + String(event).padStart(2, '0'), timestamp: timestamp + event, level: event < 7 ? 'info' : event < 9 ? 'warn' : 'error' }));
      uploads.push(request('/api/replay/logs', { token: device.diagnostics.token, events }, false, { kind: 'logs', entries: events.length }));
    }
  }
  await pause(Math.max(0, loadOrigin + options.seconds * 1000 - performance.now()));
  await Promise.all(uploads);
  const loadEnd = await sample();
  const databaseAfterLoad = await databaseFiles();
  phase = 'cooldown'; const cooldownStart = await sample();
  await pause(options['cooldown-seconds'] * 1000);
  const cooldownEnd = await sample();
  clearInterval(sampler); sampler = undefined; await sampling;
  if (samplerError) throw samplerError;
  const storedRecords = {};
  for (const collection of ['replay_sessions', 'replay_observability_sessions', 'replay_chunks', 'replay_errors', 'replay_logs', 'replay_issues']) storedRecords[collection] = (await request('/api/collections/' + collection + '/records?perPage=1', undefined, true)).totalItems;
  const kinds = {};
  for (const kind of ['replay', 'errors', 'logs']) {
    const selected = uploadResults.filter(value => value.kind === kind);
    kinds[kind] = { calls: selected.length, successfulCalls: selected.filter(value => value.status === 200).length, plannedEntries: selected.reduce((sum, value) => sum + value.entries, 0), acceptedEntries: kind === 'replay' ? selected.filter(value => value.status === 200).reduce((sum, value) => sum + value.entries, 0) : selected.reduce((sum, value) => sum + value.acceptedEvents, 0), bodyBytesMin: Math.min(...selected.map(value => value.requestBodyBytes)), bodyBytesMax: Math.max(...selected.map(value => value.requestBodyBytes)), bodyBytesTotal: selected.reduce((sum, value) => sum + value.requestBodyBytes, 0) };
  }
  assert.equal(uploadResults.filter(value => value.status !== 200).length, 0, 'Every planned upload should succeed under unchanged defaults');
  assert.equal(uploadResults.length, scheduled, 'Every scheduled HTTP call must have a recorded result');
  for (const kind of ['errors', 'logs']) assert.equal(kinds[kind].acceptedEntries, kinds[kind].plannedEntries, 'All planned ' + kind + ' entries must be accepted');
  assert.equal(storedRecords.replay_sessions, options.devices);
  assert.equal(storedRecords.replay_observability_sessions, options.devices);
  assert.equal(storedRecords.replay_chunks, kinds.replay.successfulCalls);
  assert.equal(storedRecords.replay_errors, kinds.errors.acceptedEntries);
  assert.equal(storedRecords.replay_logs, kinds.logs.acceptedEntries);
  const latency = uploadResults.map(value => value.latencyMs).sort((a, b) => a - b);
  const statuses = {};
  uploadResults.forEach(value => { statuses[value.status] = (statuses[value.status] || 0) + 1; });
  const report = {
    schemaVersion: 1, measuredAtUtc: new Date().toISOString(), scope: 'Whole PocketBase process hosting PocketBase Replay; synthetic local HTTP ingestion, no browser recorder or dashboard workload',
    hardware, versions: { node: process.version, pocketbase: pocketbaseVersion, package: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version },
    provenance: { gitCommit, installedServerTreeSha256: hash(JSON.stringify(sourceManifest)), scriptSha256, pocketbaseBinarySha256: binarySha256, sourceManifest },
    reproduction: { command: `node scripts/benchmark-server.mjs --pb /path/to/pocketbase --port ${options.port} --devices ${options.devices} --seconds ${options.seconds} --requests-per-second ${options['requests-per-second']} --idle-seconds ${options['idle-seconds']} --cooldown-seconds ${options['cooldown-seconds']} --sample-ms ${options['sample-ms']} --output ${relative(root, outputPrefix).replaceAll('\\', '/')}`, samplesFile: basename(outputPrefix) + '.csv' },
    configuration: { recording: configuredRecording, diagnostics: configuredDiagnostics, security: { requireApiKey: security.requireApiKey, requireAccount: security.requireAccount }, limits: configuredLimits, rateLimitOverrides: [] },
    methodology: { sampler: 'ps -p <benchmark-only-pid> -o rss=,time=', sampleIntervalMs: options['sample-ms'], cpuTimeResolutionSeconds: Math.max(...samples.map(value => value.cpuResolutionSeconds)), rssUnit: 'KiB; converted to MiB by dividing by 1024', cpuDefinition: 'Cumulative process CPU time delta divided by measured wall time. 100% equals one logical core. Driver and ps processes are excluded.', setup: 'Starts occur before measured idle/load windows; setup CPU/wall measured separately after PocketBase health becomes ready.', idle: `Enabled collection and ${options.devices} replay/diagnostic credentials, no ingestion yet.`, limitations: ['Single short run on one developer laptop; no repeated-trial confidence interval.', 'Synthetic HTTP payloads and local loopback, with no TLS, reverse proxy, authentication verifier, browser capture or playback.', 'Sampled RSS can miss peaks shorter than the sampling interval; RSS is resident memory, not a minimum RAM requirement.', 'CPU quantized to ps TIME precision; Linux ps can report only whole seconds. Other workloads on this machine were not controlled.', 'No sustained traffic, concurrency ceiling, storage-retention or large-scale capacity claim.'] },
    workload: { simulatedDevices: options.devices, scheduledCalls: scheduled, targetUploadCallsPerSecond: options['requests-per-second'], plannedLoadSeconds: options.seconds, achievedUploadCallsPerSecond: round(uploadResults.length / (loadEnd.elapsedSeconds - loadStart.elapsedSeconds)), scheduling: `Open-loop request every ${1000 / options['requests-per-second']} ms; cycle replay, one-error batch, ten-log batch; rotate device after each three calls.`, setupRequests, replayPayloads: { initial: { rawBytes: templates.snapshot.raw.length, gzipBytes: templates.snapshot.gzip.length, events: templates.snapshot.events, fullSnapshotDomCards: 100 }, subsequent: { rawBytes: templates.incremental.raw.length, gzipBytes: templates.incremental.gzip.length, events: templates.incremental.events }, encoding: 'JSON rrweb-style events; gzip(level 6) then base64. 200 text mutations per chunk. First chunk per device includes meta and full DOM snapshot.' }, kinds, statuses, errors: uploadResults.filter(value => value.status !== 200), latencyMs: { minimum: latency[0], median: latency[Math.floor(latency.length * 0.5)], p95: latency[Math.ceil(latency.length * 0.95) - 1], maximum: latency.at(-1) } },
    measurements: { startupCpuSecondsByFirstReadySample: setupStart.cumulativeCpuSeconds, setup: summarize(setupStart, setupEnd, 'setup'), idle: summarize(idleStart, idleEnd, 'idle'), load: summarize(loadStart, loadEnd, 'load'), cooldown: summarize(cooldownStart, cooldownEnd, 'cooldown'), sampledPeakRssAcrossAllPhasesMiB: round(Math.max(...samples.map(value => value.rssKiB)) / 1024) },
    verification: { storedRecords, allPlannedUploadsAccepted: true },
    database: { beforeLoad: databaseBefore, afterLoad: databaseAfterLoad, beforeLoadTotalBytes: databaseBefore.reduce((sum, item) => sum + item.bytes, 0), afterLoadTotalBytes: databaseAfterLoad.reduce((sum, item) => sum + item.bytes, 0), meaning: 'Logical file sizes from stat, including main/auxiliary SQLite databases and current WAL/SHM files.' },
  };
  console.log(JSON.stringify({ idle: report.measurements.idle, load: report.measurements.load, storedRecords, acceptedCalls: uploadResults.length }, null, 2));
  await stopServer();
  report.database.afterCleanShutdown = await databaseFiles();
  report.database.afterCleanShutdownTotalBytes = report.database.afterCleanShutdown.reduce((sum, item) => sum + item.bytes, 0);
  const csv = 'elapsed_seconds,phase,rss_kib,cumulative_cpu_seconds,cpu_resolution_seconds\n' + samples.map(value => [value.elapsedSeconds, value.phase, value.rssKiB, value.cumulativeCpuSeconds, value.cpuResolutionSeconds].join(',')).join('\n') + '\n';
  await writeFile(outputPrefix + '.json', JSON.stringify(report, null, 2) + '\n');
  await writeFile(outputPrefix + '.csv', csv);
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(evidence, 'samples.csv'), csv);
  console.log('Report: ' + relative(root, outputPrefix + '.json'));
} catch (error) {
  if (samplerError) throw new Error('PocketBase resource sampling failed: ' + samplerError.message, { cause: samplerError });
  throw error;
} finally {
  if (sampler) clearInterval(sampler);
  await sampling.catch(() => {});
  await stopServer();
  await writeFile(join(evidence, 'server.log'), serverLog);
  await rm(work, { recursive: true, force: true });
}
