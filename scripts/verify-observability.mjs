#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { gzipSync } from 'fflate';

const binary = process.env.REPLAY_PB_BIN;
if (!binary) throw new Error('Set REPLAY_PB_BIN to a PocketBase 0.39.9 binary');
const root = fileURLToPath(new URL('../', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'pb-observability-check-'));
const port = Number(process.env.REPLAY_TEST_PORT || 8099);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const endpoint = `http://localhost:${port}`;
const identity = 'observability@local.test';
const password = 'observability-local-test-123';
const eraseKey = randomBytes(32).toString('hex');
let server;
let hooks;
let output = '';
let checks = 0;
const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, body, token = '', method = body === undefined ? 'GET' : 'POST', status = 200, headers = {}) {
  const response = await fetch(endpoint + path, {
    method, headers: { 'Content-Type': path.startsWith('/api/collections') ? 'application/json' : 'text/plain;charset=UTF-8', ...(token ? { Authorization: token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

async function startPocketBase() {
  server = spawn(resolve(binary), ['serve', `--http=127.0.0.1:${port}`, '--dir', join(work, 'pb_data')], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REPLAY_AUTH_URL: '', REPLAY_ERASE_KEY: eraseKey, REPLAY_AUTH_COLLECTION: 'observability_test_users', REPLAY_TRUSTED_PROXY: 'X-Replay-Test-IP' } });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { output = (output + data).slice(-30000); });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(endpoint + '/api/health');
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('PocketBase did not start: ' + output);
    await wait(100);
  }
}

try {
  execFileSync(process.execPath, [join(root, 'scripts/install.mjs'), '--target', work], { stdio: 'pipe' });
  execFileSync(resolve(binary), ['superuser', 'upsert', identity, password, '--dir', join(work, 'pb_data')], { cwd: work, stdio: 'pipe' });
  await startPocketBase();
  const received = [];
  hooks = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ path: req.url, body: JSON.parse(body) }); res.writeHead(req.url === '/refuse' ? 500 : 204); res.end(); });
  });
  hooks.listen(0, '127.0.0.1');
  await once(hooks, 'listening');
  const hookURL = `http://127.0.0.1:${hooks.address().port}`;
  const admin = (await request('/api/collections/_superusers/auth-with-password', { identity, password })).token;
  const settingsPath = '/api/replay/observability/settings';
  const configPath = '/api/replay/observability/config';
  const securityPath = '/api/replay/security';
  const limitsPath = securityPath + '/limits';
  const meta = { deviceId: 'observability-e2e-device', platform: 'web', appVersion: '1.0.0', room: 'TEST1' };
  const initialSecurity = await request(securityPath, undefined, admin);
  check('ingestion security is optional and defaults to accepting legacy clients', () => {
    assert.deepEqual(initialSecurity, { requireApiKey: false, requireAccount: false, keys: [] });
  });
  const initialLimits = await request(limitsPath, undefined, admin);
  check('the limits panel reports the existing replay and diagnostics defaults', () => {
    assert.deepEqual(initialLimits, {
      replay: { config_requests_per_ip_minute: 120, start_requests_per_ip_minute: 30, upload_requests_per_ip_minute: 240,
        upload_mb_per_ip_hour: 64, sessions_per_device_hour: 12, sessions_per_ip_hour: 120, sessions_per_hour: 3000 },
      observability: { config_requests_per_ip_minute: 120, upload_requests_per_ip_minute: 120, upload_mb_per_ip_hour: 8,
        sessions_per_device_hour: 30, sessions_per_ip_hour: 120, sessions_per_hour: 20000 },
    });
  });
  const initial = await request(settingsPath, undefined, admin);
  check('new features default off', () => { assert.equal(initial.errors_enabled, false); assert.equal(initial.logs_enabled, false); });
  const disabled = await request(configPath, meta);
  check('disabled configuration creates no upload credential', () => { assert.equal(disabled.errorsEnabled, false); assert.equal(disabled.logsEnabled, false); assert.ok(!disabled.token); });
  for (const path of [settingsPath, securityPath, '/api/replay/issues', '/api/replay/logs', '/api/replay/alerts']) await request(path, undefined, '', 'GET', 401);
  check('all dashboard reads require a superuser', () => assert.ok(true));

  const settings = { errors_enabled: true, logs_enabled: true, alerts_enabled: true, errors_retention_days: 30, logs_retention_days: 14, daily_limit_mb: 64,
    sessions_per_device_hour: 30, sessions_per_ip_hour: 120, sessions_per_hour: 20000,
    config_requests_per_ip_minute: 120, upload_requests_per_ip_minute: 120, upload_mb_per_ip_hour: 8 };
  await request(settingsPath, settings, admin);
  const config = await request(configPath, meta);
  check('features can be enabled independently of recording', () => { assert.equal(config.errorsEnabled, true); assert.equal(config.logsEnabled, true); assert.ok(config.token); });
  const refreshed = await request(configPath, { ...meta, token: config.token });
  check('configuration refresh reuses its upload credential', () => assert.equal(refreshed.token, config.token));
  const error = { id: 'error-e2e-1', timestamp: Date.now(), name: 'TypeError', message: 'Checkout failed', stack: 'TypeError: Checkout failed\n    at checkout (https://example.test/app.js:10:2)', service: 'shop', handled: true, attributes: { order: 'example', password: 'never-store-this' } };
  await request('/api/replay/errors', { token: config.token, events: [error] });
  await request('/api/replay/errors', { token: config.token, events: [error] });
  const list = await request('/api/replay/issues?q=Checkout&service=shop', undefined, admin);
  assert.equal(list.items.length, 1);
  const issue = list.items[0];
  const detail = await request(`/api/replay/issues/${issue.id}`, undefined, admin);
  check('duplicate retries create one exception and one issue', () => { assert.equal(detail.items.length, 1); assert.ok(!JSON.stringify(detail).includes('never-store-this')); });
  await request(`/api/replay/issues/${issue.id}`, { status: 'resolved' }, admin);
  await request('/api/replay/errors', { token: config.token, events: [{ ...error, id: 'error-e2e-late', timestamp: error.timestamp - 1000 }] });
  const late = await request(`/api/replay/issues/${issue.id}`, undefined, admin);
  check('an older occurrence delivered after the fix does not reopen the issue', () => { assert.equal(late.issue.status, 'resolved'); assert.ok(late.issue.resolvedAt > 0); });
  await request('/api/replay/errors', { token: config.token, events: [{ ...error, id: 'error-e2e-2', timestamp: Date.now() + 1000 }] });
  const regressed = await request(`/api/replay/issues/${issue.id}`, undefined, admin);
  check('recurrence reopens a resolved issue', () => { assert.equal(regressed.issue.status, 'open'); assert.equal(regressed.items.length, 3); });
  const alerts = await request('/api/replay/alerts', undefined, admin);
  check('new and regressed issues create dashboard alerts', () => { assert.equal(alerts.items.length, 2); assert.ok(alerts.items.some(item => item.kind === 'regressed')); });
  await request(`/api/replay/alerts/${alerts.items[0].id}/acknowledge`, {}, admin);
  await request(`/api/replay/issues/${issue.id}`, { status: 'ignored' }, admin);
  await request('/api/replay/errors', { token: config.token, events: [{ ...error, id: 'error-e2e-3' }] });
  const ignored = await request(`/api/replay/issues/${issue.id}`, undefined, admin);
  check('ignored issues stay ignored on recurrence', () => assert.equal(ignored.issue.status, 'ignored'));
  const log = { id: 'log-e2e-1', timestamp: Date.now(), level: 'warn', message: 'Payment retry', service: 'shop', attributes: { attempt: 2, authorization: 'never-store-this' } };
  await request('/api/replay/logs', { token: config.token, events: [log] });
  await request('/api/replay/logs', { token: config.token, events: [log] });
  const logs = await request('/api/replay/logs?q=Payment&level=warn&service=shop', undefined, admin);
  check('logs can be searched and filtered with idempotent ingestion', () => { assert.equal(logs.items.length, 1); assert.ok(!JSON.stringify(logs).includes('never-store-this')); });
  await request(`/api/replay/logs/${logs.items[0].id}`, undefined, admin);
  await request('/api/replay/logs', { token: 'invalid', events: [log] }, '', 'POST', 401);
  await request('/api/replay/logs', { token: config.token, events: [{ ...log, id: 'bad-level', level: 'invalid' }] }, '', 'POST', 400);
  const nearLimit = 'x'.repeat(4096 - ' token=a a@b.co'.length) + ' token=a a@b.co';
  const redacted = await request('/api/replay/logs', { token: config.token, events: [{ ...log, id: 'near-limit', message: nearLimit }] });
  const reused = await request('/api/replay/logs', { token: config.token, events: [{ ...log, message: 'Same ID, other text' }, { ...log, id: 'beside-a-conflict' }] });
  check('redaction near the length limit and a reused event ID do not refuse the batch', () => {
    assert.equal(redacted.accepted, 1);
    assert.deepEqual([reused.accepted, reused.conflicts], [1, 1]);
  });
  await request('/api/replay/logs', { token: config.token, events: Array.from({ length: 21 }, (_, i) => ({ ...log, id: 'oversized-' + i })) }, '', 'POST', 400);
  check('invalid credentials, severity and oversized batches are refused', () => assert.ok(true));
  await request(settingsPath, { ...settings, logs_enabled: false }, admin);
  await request('/api/replay/logs', { token: config.token, events: [{ ...log, id: 'disabled-log' }] }, '', 'POST', 403);
  const errorsOnly = await request(configPath, { ...meta, token: config.token });
  check('each feature has its own server switch', () => { assert.equal(errorsOnly.errorsEnabled, true); assert.equal(errorsOnly.logsEnabled, false); });
  await request(settingsPath, settings, admin);

  const privateConfig = await request(configPath, { ...meta, deviceId: 'custom-sender-device', room: 'token=private-room' });
  const customLog = { ...log, id: 'toString', service: 'custom-sender', message: '{"token":"private-json-secret"}' };
  await request('/api/replay/logs', { token: privateConfig.token, events: [customLog] });
  await request(configPath, { ...meta, deviceId: 'custom-sender-device', room: 'NEW-ROOM', token: privateConfig.token });
  const retried = await request('/api/replay/logs', { token: privateConfig.token, events: [customLog] });
  const customStored = await request('/api/replay/logs?service=custom-sender', undefined, admin);
  check('custom sender retries remain idempotent across room changes and redact credentials', () => {
    assert.equal(retried.duplicates, 1);
    assert.equal(customStored.items.length, 1);
    assert.ok(!JSON.stringify(customStored).includes('private-json-secret'));
    assert.ok(!JSON.stringify(customStored).includes('private-room'));
  });

  const { startObservability } = await import('../dist/index.js');
  const diagnostics = startObservability({ endpoint, metadata: () => meta, errors: true, logs: true,
    service: 'sdk-e2e', sensitiveText: () => ['customer-one'], subscribeActive: () => () => {},
    beforeSend: event => event.kind === 'log' && event.level === 'debug' ? null : event });
  try {
    assert.ok(diagnostics.captureException(new TypeError('SDK boot failed before its settings arrived')));
    await diagnostics.refresh();
    assert.ok(diagnostics.captureException(new Error('SDK customer-one failed'), { attributes: { nested: { password: 'never-store-this', note: 'customer-one' } } }));
    assert.ok(diagnostics.captureLog('info', 'SDK customer-one started', { attempt: 1 }));
    assert.equal(diagnostics.captureLog('debug', 'Dropped by configuration'), null);
    await diagnostics.flush();
    const sdkLogs = await request('/api/replay/logs?service=sdk-e2e', undefined, admin);
    const boot = await request('/api/replay/issues?q=before+its+settings', undefined, admin);
    const bootOccurrence = (await request(`/api/replay/issues/${boot.items[0].id}`, undefined, admin)).items[0];
    check('built SDK keeps an error from before its first answer, with the V8 stack', () => {
      assert.equal(boot.items.length, 1);
      assert.match(bootOccurrence.stack, /^TypeError: SDK boot failed before its settings arrived\n\s+at /);
    });
    check('built SDK sends exceptions and logs with configurable filtering and redaction', () => {
      assert.equal(diagnostics.getMetrics().uploadedEvents, 3);
      assert.equal(sdkLogs.items.length, 1);
      assert.ok(!JSON.stringify(sdkLogs).includes('customer-one'));
    });
  } finally { diagnostics.stop(); }

  await request('/api/replay/settings', { mode: 'percentage', percentage: 100, account_ids: [], retention_days: 14 }, admin);
  const recording = await request('/api/replay/start', meta);
  const timestamp = Date.now();
  const snapshot = [
    { type: 4, timestamp, data: { href: 'https://example.test', width: 390, height: 844 } },
    { type: 2, timestamp: timestamp + 1, data: { initialOffset: { top: 0, left: 0 }, node: { type: 0, id: 1, childNodes: [
      { type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [
        { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: [] },
        { type: 2, id: 4, tagName: 'body', attributes: {}, childNodes: [
          { type: 2, id: 5, tagName: 'h1', attributes: {}, childNodes: [{ type: 3, id: 6, textContent: 'Checkout fixture' }] },
        ] },
      ] },
    ] } } },
  ];
  const raw = Buffer.from(JSON.stringify(snapshot));
  await request('/api/replay/chunks', { sessionId: recording.sessionId, token: recording.token, seq: 0,
    startedAt: timestamp, endedAt: timestamp + 1, room: 'TEST1', encoding: 'gzip-base64',
    data: Buffer.from(gzipSync(raw)).toString('base64'), rawBytes: raw.length, eventCount: snapshot.length, hasSnapshot: true });
  const linked = { ...log, id: 'linked-log', sessionId: recording.sessionId, sessionToken: recording.token };
  await request('/api/replay/logs', { token: config.token, events: [linked] });
  await request('/api/replay/errors', { token: config.token, events: [{ ...error, id: 'linked-error', service: 'replay-e2e', sessionId: recording.sessionId, sessionToken: recording.token }] });
  const linkedLogs = await request('/api/replay/logs?sessionId=' + recording.sessionId, undefined, admin);
  check('errors and logs correlate securely with a playable recording', () => {
    assert.equal(linkedLogs.items.length, 1);
    assert.equal(linkedLogs.items[0].replayAvailable, true);
    assert.ok(!JSON.stringify(linkedLogs).includes(recording.token));
  });
  await request('/api/replay/logs', { token: config.token, events: [{ ...linked, id: 'forged-link', sessionToken: 'X'.repeat(64) }] });
  const foreignConfig = await request(configPath, { ...meta, deviceId: 'foreign-device' });
  await request('/api/replay/logs', { token: foreignConfig.token, events: [{ ...linked, id: 'foreign-link' }] });
  const unlinked = await request('/api/replay/logs?q=Payment&service=shop', undefined, admin);
  check('replay linkage refuses forged credentials and other devices, keeping the entries unlinked', () => {
    assert.equal(unlinked.items.filter((item) => item.sessionId === recording.sessionId).length, 1);
    // The first log, the one beside the reused ID, the linked one, and the forged and foreign attempts.
    assert.equal(unlinked.items.length, 5);
  });

  const disposable = await request('/api/replay/start', { ...meta, deviceId: 'delete-device' });
  const disposableConfig = await request(configPath, { ...meta, deviceId: 'delete-device' });
  await request('/api/replay/logs', { token: disposableConfig.token, events: [{ ...log, id: 'delete-linked-log', sessionId: disposable.sessionId, sessionToken: disposable.token }] });
  await request('/api/replay/sessions/' + disposable.sessionId, undefined, admin, 'DELETE');
  const keptSessionLogs = await request('/api/replay/logs?sessionId=' + disposable.sessionId, undefined, admin);
  const lateLink = await request('/api/replay/logs', { token: disposableConfig.token, events: [{ ...log, id: 'late-link', sessionId: disposable.sessionId, sessionToken: disposable.token }] });
  check('deleting a recording keeps its errors and logs, and later entries for it still arrive', () => {
    assert.equal(keptSessionLogs.items.length, 1);
    assert.equal(keptSessionLogs.items[0].replayAvailable, false);
    assert.equal(lateLink.accepted, 1);
  });

  await request('/api/collections', { name: 'observability_test_users', type: 'auth', passwordAuth: { enabled: true, identityFields: ['email'] } }, admin);
  const user = await request('/api/collections/observability_test_users/records', { email: 'account@local.test', password: 'local-account-test-123', passwordConfirm: 'local-account-test-123' }, admin);
  const auth = await request('/api/collections/observability_test_users/auth-with-password', { identity: 'account@local.test', password: 'local-account-test-123' });
  const accountMeta = { ...meta, accountId: user.id, authToken: auth.token, deviceId: 'account-device' };
  const accountConfig = await request(configPath, accountMeta);
  await request('/api/replay/logs', { token: accountConfig.token, events: [{ ...log, id: 'account-log' }] });
  await request('/api/replay/errors', { token: accountConfig.token, events: [{ ...error, id: 'account-error' }] });
  await request('/api/replay/issues', undefined, auth.token, 'GET', 403);
  assert.equal((await request('/api/replay/logs?accountId=' + user.id, undefined, admin)).items.length, 1);
  const erasure = await request('/api/replay/accounts/' + user.id, undefined, admin, 'DELETE');
  const erasedLogs = await request('/api/replay/logs?accountId=' + user.id, undefined, admin);
  const events = await request(`/api/replay/issues/${issue.id}`, undefined, admin);
  check('account erasure removes errors and logs', () => {
    assert.equal(erasedLogs.items.length, 0);
    assert.ok(events.items.every(event => event.accountId !== user.id));
  });
  check('the dashboard erase reports its diagnostics and, like recordings, does not block the account', () => {
    assert.deepEqual([erasure.deletedErrors, erasure.deletedLogs, erasure.remainingErrors, erasure.remainingLogs], [1, 1, 0, 0]);
  });
  assert.equal((await request(configPath, accountMeta)).enabled, true);
  const forgetResponse = await fetch(endpoint + '/api/replay/forget', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-replay-erase-key': eraseKey }, body: JSON.stringify({ accountId: user.id }) });
  assert.equal(forgetResponse.status, 200);
  const forgotten = await request(configPath, accountMeta);
  check('accounts erased through the trusted route cannot immediately restart collection', () => assert.equal(forgotten.enabled, false));

  await request(settingsPath, { ...settings, alert_webhook_url: hookURL + '/hook' }, admin);
  await request('/api/replay/alerts/test', { alert_webhook_url: hookURL + '/hook' }, admin);
  await request('/api/replay/alerts/test', { alert_webhook_url: hookURL + '/refuse' }, admin, 'POST', 502);
  await request('/api/replay/errors', { token: config.token, events: [{ ...error, id: 'webhook-issue', name: 'RangeError', stack: 'RangeError: x\n    at alpha (https://example.test/a.js:1:1)\n    at beta (https://example.test/a.js:2:2)' }] });
  const waiting = (await request('/api/replay/alerts', undefined, admin)).items.find((item) => item.title.startsWith('RangeError'));
  check('a configured webhook receives the test alert, reports a refusal, and queues new alerts', () => {
    assert.equal(received[0].path, '/hook');
    assert.match(received[0].body.text, /^Test alert: /);
    assert.equal(waiting.delivery, 'pending');
  });

  const volume = await request('/api/replay/logs/volume?service=shop', undefined, admin);
  const listed = await request('/api/replay/logs?service=shop', undefined, admin);
  check('log volume counts the same entries as the filtered list', () => {
    const counted = volume.buckets.reduce((sum, bucket) => sum + Object.values(bucket.counts).reduce((a, b) => a + b, 0), 0);
    assert.equal(volume.total, listed.totalItems);
    assert.equal(counted, listed.totalItems);
    assert.ok(volume.buckets.length >= 1 && volume.buckets.length <= 61);
  });

  const cronDeadline = Date.now() + 70000;
  while (!received.some((body) => body.body.alerts?.some((item) => item.id === waiting.id))) {
    if (Date.now() > cronDeadline) throw new Error('The minute job did not deliver its queued alert');
    await wait(250);
  }
  const delivered = (await request('/api/replay/alerts', undefined, admin)).items.find((item) => item.id === waiting.id);
  check('the real minute job delivers a queued webhook and marks it sent', () => assert.equal(delivered.delivery, 'sent'));

  await request(settingsPath, { ...settings, sessions_per_device_hour: 1 }, admin);
  const limitedMeta = { ...meta, deviceId: 'configured-limit-device' };
  const limited = await request(configPath, limitedMeta);
  await request(configPath, limitedMeta, '', 'POST', 429);
  const renewed = await request(configPath, { ...limitedMeta, token: limited.token });
  check('configured session limits apply while credential renewal remains allowed', () => assert.equal(renewed.token, limited.token));
  await request(settingsPath, settings, admin);

  await request('/api/replay/errors', { token: config.token, events: [
    { ...error, id: 'explicit-grouping-first', service: 'stable-group', attributes: { groupingKey: 'payment' } },
    { ...error, id: 'explicit-grouping-second', service: 'stable-group', name: 'PaymentException', message: 'Different platform message', stack: 'other@capacitor://localhost/different.js:99:1', attributes: { groupingKey: 'payment' } },
  ] });
  const grouped = await request('/api/replay/issues?service=stable-group', undefined, admin);
  check('an explicit grouping key joins different stacks and exception names', () => { assert.equal(grouped.items.length, 1); assert.equal(grouped.items[0].occurrenceCount, 2); });

  const legacyAttributes = await request('/api/replay/errors', { token: config.token, events: [
    { ...error, id: 'legacy-grouping-attribute', attributes: { groupingKey: 42 } },
    { ...error, id: 'legacy-batch-neighbor' },
  ] });
  check('older arbitrary grouping attributes do not reject neighboring errors', () => assert.equal(legacyAttributes.accepted, 2));

  const allErrors = (await request('/api/collections/replay_errors/records?perPage=500', undefined, admin)).items;
  const allLogs = (await request('/api/collections/replay_logs/records?perPage=500', undefined, admin)).items;
  const originalBytes = allLogs[0].byteSize;
  const originalTotal = [...allErrors, ...allLogs].reduce((sum, item) => sum + item.byteSize, 0);
  const budgetRow = (await request('/api/collections/replay_settings/records?perPage=500', undefined, admin)).items.find((item) => item.key === 'observability:daily-bytes');
  const cap = 1024 * 1024, seeded = cap - 1000;
  try {
    await request(settingsPath, { ...settings, daily_limit_mb: 1 }, admin);
    await request('/api/collections/replay_logs/records/' + allLogs[0].id, { byteSize: seeded - (originalTotal - originalBytes) }, admin, 'PATCH');
    await request('/api/collections/replay_settings/records/' + budgetRow.id, { value: JSON.stringify({ at: Date.now(), bytes: seeded }) }, admin, 'PATCH');
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(endpoint + '/api/replay/logs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: config.token, events: [{ ...log, id: 'concurrent-budget-' + i }] }),
    })));
    const budget = JSON.parse((await request('/api/collections/replay_settings/records/' + budgetRow.id, undefined, admin)).value);
    check('concurrent HTTP uploads admit one entry within the remaining storage budget', () => {
      assert.equal(responses.filter((response) => response.status === 200).length, 1);
      assert.equal(responses.filter((response) => response.status === 429).length, 11);
      assert.ok(budget.bytes <= cap);
    });
  } finally {
    await request('/api/collections/replay_logs/records/' + allLogs[0].id, { byteSize: originalBytes }, admin, 'PATCH');
    const finalLogs = (await request('/api/collections/replay_logs/records?perPage=500', undefined, admin)).items;
    const finalTotal = [...allErrors, ...finalLogs].reduce((sum, item) => sum + item.byteSize, 0);
    await request('/api/collections/replay_settings/records/' + budgetRow.id, { value: JSON.stringify({ at: Date.now(), bytes: finalTotal }) }, admin, 'PATCH');
    await request(settingsPath, settings, admin);
  }

  const securityMeta = { ...meta, deviceId: 'ingestion-security-device' };
  const legacyRecording = await request('/api/replay/start', securityMeta);
  const legacyContext = await request(configPath, securityMeta);
  const chunkFor = (session, seq, apiKey) => ({ sessionId: session.sessionId, token: session.token, seq,
    startedAt: timestamp, endedAt: timestamp + 1, room: 'TEST1', encoding: 'gzip-base64',
    data: Buffer.from(gzipSync(raw)).toString('base64'), rawBytes: raw.length, eventCount: snapshot.length,
    hasSnapshot: true, ...(apiKey ? { apiKey } : {}) });
  const diagnosticFor = (context, kind, id, apiKey) => ({ token: context.token,
    events: [{ ...(kind === 'errors' ? error : log), id, service: 'security-e2e' }], ...(apiKey ? { apiKey } : {}) });
  const diagnosticUpload = (context, id, apiKey, status = 200) => Promise.all(['errors', 'logs'].map(kind =>
    request('/api/replay/' + kind, diagnosticFor(context, kind, id + '-' + kind, apiKey), '', 'POST', status)));
  const safeSecurity = (value, secrets = []) => {
    assert.deepEqual(Object.keys(value).sort(), ['keys', 'requireAccount', 'requireApiKey']);
    for (const key of value.keys) assert.deepEqual(Object.keys(key).sort(), ['createdAt', 'id', 'label', 'prefix']);
    for (const secret of secrets) assert.ok(!JSON.stringify(value).includes(secret));
  };
  const setSecurity = (requireApiKey, requireAccount) => request(securityPath, { requireApiKey, requireAccount }, admin);

  for (const credential of ['', auth.token]) {
    const status = credential ? 403 : 401;
    await request(securityPath, undefined, credential, 'GET', status);
    await request(securityPath, { requireApiKey: false, requireAccount: false }, credential, 'POST', status);
    await request(securityPath + '/keys', { label: 'Unauthorized key' }, credential, 'POST', status);
    await request(securityPath + '/keys/' + 'x'.repeat(24), undefined, credential, 'DELETE', status);
  }
  check('anonymous clients and ordinary accounts cannot manage ingestion security or keys', () => assert.ok(true));
  await request(securityPath, { requireApiKey: true, requireAccount: false }, admin, 'POST', 400);
  const afterRejectedEnable = await request(securityPath, undefined, admin);
  check('a missing key cannot accidentally lock out ingestion', () => {
    assert.deepEqual(afterRejectedEnable, initialSecurity);
    assert.equal(legacyRecording.enabled, true);
    assert.equal(legacyContext.enabled, true);
  });

  const firstKey = await request(securityPath + '/keys', { label: 'Browser fixture' }, admin);
  const keySettings = await request(securityPath, undefined, admin);
  check('key creation reveals the secret once and subsequent reads expose only safe metadata', () => {
    assert.match(firstKey.apiKey, /^pbr_[A-Za-z0-9]{64}$/);
    assert.equal(firstKey.key.label, 'Browser fixture');
    assert.equal(firstKey.key.prefix, firstKey.apiKey.slice(0, 12));
    assert.deepEqual(keySettings.keys, [firstKey.key]);
    safeSecurity(keySettings, [firstKey.apiKey]);
  });
  const enabledSecurity = await setSecurity(true, false);
  safeSecurity(enabledSecurity, [firstKey.apiKey]);
  for (const apiKey of [undefined, 'pbr_' + 'X'.repeat(64)]) {
    const body = { ...securityMeta, ...(apiKey ? { apiKey } : {}) };
    for (const path of ['/api/replay/config', '/api/replay/start', configPath]) await request(path, body, '', 'POST', 401);
    await request('/api/replay/chunks', chunkFor(legacyRecording, 0, apiKey), '', 'POST', 401);
    await diagnosticUpload(legacyContext, 'invalid-api-key', apiKey, 401);
  }
  check('enabling API keys immediately protects all configuration, credential and upload routes', () => assert.ok(true));
  const securedMeta = { ...securityMeta, apiKey: firstKey.apiKey };
  assert.equal((await request('/api/replay/config', securedMeta)).enabled, true);
  const securedRecording = await request('/api/replay/start', securedMeta);
  const securedContext = await request(configPath, securedMeta);
  await request('/api/replay/chunks', chunkFor(securedRecording, 0, firstKey.apiKey));
  const securedUploads = await diagnosticUpload(securedContext, 'valid-api-key', firstKey.apiKey);
  await request('/api/replay/chunks', chunkFor(legacyRecording, 0, firstKey.apiKey));
  await diagnosticUpload(legacyContext, 'legacy-with-api-key', firstKey.apiKey);
  check('a valid API key permits recording, errors and logs, including earlier credentials', () => {
    assert.equal(securedRecording.enabled, true);
    assert.equal(securedContext.enabled, true);
    assert.ok(securedUploads.every(result => result.accepted === 1));
  });

  const replacementKey = await request(securityPath + '/keys', { label: 'Rotation fixture' }, admin);
  const revoked = await request(securityPath + '/keys/' + firstKey.key.id, undefined, admin, 'DELETE');
  safeSecurity(revoked, [firstKey.apiKey, replacementKey.apiKey]);
  await request('/api/replay/chunks', chunkFor(securedRecording, 1, firstKey.apiKey), '', 'POST', 401);
  await diagnosticUpload(securedContext, 'revoked-api-key', firstKey.apiKey, 401);
  for (const path of ['/api/replay/config', '/api/replay/start', configPath]) await request(path, securedMeta, '', 'POST', 401);
  await request('/api/replay/chunks', chunkFor(securedRecording, 1, replacementKey.apiKey));
  await diagnosticUpload(securedContext, 'rotated-api-key', replacementKey.apiKey);
  await request(securityPath + '/keys/' + replacementKey.key.id, undefined, admin, 'DELETE', 400);
  check('revocation immediately refuses existing uploads while another key supports rotation', () => {
    assert.deepEqual(revoked.keys, [replacementKey.key]);
  });

  await setSecurity(false, false);
  const restoredConfig = await request('/api/replay/config', securityMeta);
  const restoredRecording = await request('/api/replay/start', { ...securityMeta, deviceId: 'security-disabled-device' });
  const restoredContext = await request(configPath, { ...securityMeta, deviceId: 'security-disabled-device' });
  await request('/api/replay/chunks', chunkFor(securedRecording, 2));
  await diagnosticUpload(securedContext, 'security-disabled');
  const withoutKeys = await request(securityPath + '/keys/' + replacementKey.key.id, undefined, admin, 'DELETE');
  check('disabling API keys restores legacy ingestion and permits revoking the last key', () => {
    assert.equal(restoredConfig.enabled, true);
    assert.equal(restoredRecording.enabled, true);
    assert.equal(restoredContext.enabled, true);
    assert.deepEqual(withoutKeys, initialSecurity);
  });

  const securityUser = await request('/api/collections/observability_test_users/records', {
    email: 'security@local.test', password: 'local-security-test-123', passwordConfirm: 'local-security-test-123',
  }, admin);
  const securityAuth = await request('/api/collections/observability_test_users/auth-with-password', {
    identity: 'security@local.test', password: 'local-security-test-123',
  });
  const verifiedMeta = { ...securityMeta, deviceId: 'verified-security-device', accountId: securityUser.id, authToken: securityAuth.token };
  const accountRecording = await request('/api/replay/start', verifiedMeta);
  const verifiedContext = await request(configPath, verifiedMeta);
  const accountsOnly = await setSecurity(false, true);
  for (const path of ['/api/replay/config', '/api/replay/start', configPath]) {
    await request(path, securityMeta, '', 'POST', 401);
    await request(path, { ...securityMeta, accountId: securityUser.id }, '', 'POST', 401);
  }
  await request('/api/replay/chunks', chunkFor(restoredRecording, 0), '', 'POST', 401);
  await diagnosticUpload(restoredContext, 'anonymous-account-required', undefined, 401);
  const verifiedReplayConfig = await request('/api/replay/config', verifiedMeta);
  const renewedAccountContext = await request(configPath, { ...verifiedMeta, token: verifiedContext.token });
  const verifiedRecording = await request('/api/replay/start', verifiedMeta);
  await request('/api/replay/chunks', chunkFor(accountRecording, 0));
  await request('/api/replay/chunks', chunkFor(verifiedRecording, 0));
  const verifiedUploads = await diagnosticUpload(verifiedContext, 'verified-account-required');
  check('verified-account enforcement works independently and refuses earlier anonymous credentials', () => {
    assert.equal(accountsOnly.requireApiKey, false);
    assert.deepEqual(accountsOnly.keys, []);
    assert.equal(verifiedReplayConfig.enabled, true);
    assert.equal(renewedAccountContext.token, verifiedContext.token);
    assert.ok(verifiedUploads.every(result => result.accepted === 1));
  });

  const combinedKey = await request(securityPath + '/keys', { label: 'Account and key fixture' }, admin);
  await setSecurity(true, true);
  await request(configPath, verifiedMeta, '', 'POST', 401);
  await request(configPath, { ...securityMeta, apiKey: combinedKey.apiKey }, '', 'POST', 401);
  const combined = await request(configPath, { ...verifiedMeta, token: verifiedContext.token, apiKey: combinedKey.apiKey });
  await request('/api/replay/chunks', chunkFor(verifiedRecording, 1, combinedKey.apiKey));
  await diagnosticUpload(combined, 'account-and-api-key', combinedKey.apiKey);
  check('both optional protections can be enabled together', () => assert.equal(combined.enabled, true));
  await setSecurity(false, false);
  await request('/api/replay/chunks', chunkFor(restoredRecording, 0));
  await diagnosticUpload(restoredContext, 'account-requirement-disabled');
  const finalSecurity = await request(securityPath + '/keys/' + combinedKey.key.id, undefined, admin, 'DELETE');
  check('turning off account enforcement restores uploads from existing anonymous credentials', () => {
    assert.deepEqual(finalSecurity, initialSecurity);
  });

  const savedLimits = await request(limitsPath, undefined, admin);
  const savedRecordingSettings = await request('/api/replay/settings', undefined, admin);
  const savedDiagnosticSettings = await request(settingsPath, undefined, admin);
  for (const credential of ['', auth.token]) {
    const status = credential ? 403 : 401;
    await request(limitsPath, undefined, credential, 'GET', status);
    await request(limitsPath, { replay: { sessions_per_device_hour: 12 } }, credential, 'POST', status);
  }
  check('only superusers can read or change upload limits', () => assert.ok(true));
  for (const body of [
    {}, { replay: {} }, { unknown: {} }, { replay: null },
    { replay: { config_requests_per_ip_minute: 0 } },
    { replay: { start_requests_per_ip_minute: 1.5 } },
    { replay: { unknown_limit: 1 } },
    { observability: { upload_requests_per_ip_minute: '5' } },
    { observability: { start_requests_per_ip_minute: 1 } },
    { replay: { upload_mb_per_ip_hour: 1048577 } },
    { replay: { sessions_per_device_hour: 2 }, observability: { sessions_per_ip_hour: 0 } },
  ]) {
    await request(limitsPath, body, admin, 'POST', 400);
    assert.deepEqual(await request(limitsPath, undefined, admin), savedLimits);
  }
  check('invalid limit updates reject the complete change without altering either group', () => assert.ok(true));

  try {
    // Documentation-only addresses give each probe its own counters in this isolated fixture.
    const replayHeaders = { 'X-Replay-Test-IP': '198.51.100.41' };
    const sessionHeaders = { 'X-Replay-Test-IP': '198.51.100.42' };
    const diagnosticsHeaders = { 'X-Replay-Test-IP': '198.51.100.43' };
    const liveRequest = (path, body, headers, status = 200) => request(path, body, '', 'POST', status, headers);
    const limitMeta = { ...meta, deviceId: 'replay-request-limit-device' };
    const remainingMinute = 60000 - Date.now() % 60000;
    if (remainingMinute < 10000) await wait(remainingMinute + 20);
    const rateMinute = Math.floor(Date.now() / 60000);
    const lowRequests = { config_requests_per_ip_minute: 2, start_requests_per_ip_minute: 2, upload_requests_per_ip_minute: 2 };
    const partial = await request(limitsPath, { replay: lowRequests }, admin);
    check('partial limit updates preserve omitted fields, the other group and recording settings', () => {
      assert.deepEqual(partial, { replay: { ...savedLimits.replay, ...lowRequests }, observability: savedLimits.observability });
    });
    assert.deepEqual(await request('/api/replay/settings', undefined, admin), savedRecordingSettings);
    for (let i = 0; i < 2; i++) await liveRequest('/api/replay/config', limitMeta, replayHeaders);
    await liveRequest('/api/replay/config', limitMeta, replayHeaders, 429);
    const limitedRecording = await liveRequest('/api/replay/start', limitMeta, replayHeaders);
    await liveRequest('/api/replay/start', limitMeta, replayHeaders);
    await liveRequest('/api/replay/start', limitMeta, replayHeaders, 429);
    await liveRequest('/api/replay/chunks', chunkFor(limitedRecording, 0), replayHeaders);
    await liveRequest('/api/replay/chunks', chunkFor(limitedRecording, 1), replayHeaders);
    await liveRequest('/api/replay/chunks', chunkFor(limitedRecording, 2), replayHeaders, 429);
    check('saved replay limits independently guard real configuration, starts and chunk uploads', () => assert.ok(true));

    await request(limitsPath, { replay: { config_requests_per_ip_minute: 3, start_requests_per_ip_minute: 3, upload_requests_per_ip_minute: 3 } }, admin);
    await liveRequest('/api/replay/config', limitMeta, replayHeaders);
    await liveRequest('/api/replay/config', limitMeta, replayHeaders, 429);
    await liveRequest('/api/replay/start', limitMeta, replayHeaders);
    await liveRequest('/api/replay/start', limitMeta, replayHeaders, 429);
    await liveRequest('/api/replay/chunks', chunkFor(limitedRecording, 2), replayHeaders);
    await liveRequest('/api/replay/chunks', chunkFor(limitedRecording, 3), replayHeaders, 429);
    check('raising replay limits resumes requests without resetting accumulated counters', () => {
      assert.equal(Math.floor(Date.now() / 60000), rateMinute);
    });
    await request(limitsPath, { replay: savedLimits.replay }, admin);

    const deviceMeta = { ...meta, deviceId: 'replay-device-limit-device' };
    await liveRequest('/api/replay/start', deviceMeta, sessionHeaders);
    await request(limitsPath, { replay: { sessions_per_device_hour: 1 } }, admin);
    await liveRequest('/api/replay/start', deviceMeta, sessionHeaders, 429);
    await liveRequest('/api/replay/start', { ...deviceMeta, deviceId: 'other-replay-limit-device' }, sessionHeaders);
    await request(limitsPath, { replay: { sessions_per_device_hour: 2 } }, admin);
    await liveRequest('/api/replay/start', deviceMeta, sessionHeaders);
    await liveRequest('/api/replay/start', deviceMeta, sessionHeaders, 429);
    check('lowering a replay device limit counts existing sessions and keeps other devices independent', () => assert.ok(true));
    await request(limitsPath, { replay: savedLimits.replay }, admin);

    const diagnosticMeta = { ...meta, deviceId: 'diagnostic-panel-limit-device' };
    const diagnosticContext = await liveRequest(configPath, diagnosticMeta, diagnosticsHeaders);
    const diagnosticChanges = { config_requests_per_ip_minute: 1, upload_requests_per_ip_minute: 1, sessions_per_device_hour: 1 };
    const editedAt = Date.now();
    await request(limitsPath, { observability: diagnosticChanges }, admin);
    await liveRequest(configPath, { ...diagnosticMeta, token: diagnosticContext.token }, diagnosticsHeaders, 429);
    check('diagnostic limits replace the live configuration cache immediately', () => {
      assert.ok(Date.now() - editedAt < 5000);
    });
    await request(limitsPath, { observability: { config_requests_per_ip_minute: 2 } }, admin);
    const renewedDiagnostic = await liveRequest(configPath, { ...diagnosticMeta, token: diagnosticContext.token }, diagnosticsHeaders);
    await liveRequest(configPath, { ...diagnosticMeta, token: diagnosticContext.token }, diagnosticsHeaders, 429);
    for (const kind of ['errors', 'logs']) {
      await liveRequest('/api/replay/' + kind, diagnosticFor(diagnosticContext, kind, 'limited-first-' + kind), diagnosticsHeaders);
      await liveRequest('/api/replay/' + kind, diagnosticFor(diagnosticContext, kind, 'limited-second-' + kind), diagnosticsHeaders, 429);
    }
    await request(limitsPath, { observability: { upload_requests_per_ip_minute: 2 } }, admin);
    for (const kind of ['errors', 'logs']) {
      await liveRequest('/api/replay/' + kind, diagnosticFor(diagnosticContext, kind, 'limited-second-' + kind), diagnosticsHeaders);
      await liveRequest('/api/replay/' + kind, diagnosticFor(diagnosticContext, kind, 'limited-third-' + kind), diagnosticsHeaders, 429);
    }
    await request(limitsPath, { observability: { config_requests_per_ip_minute: savedLimits.observability.config_requests_per_ip_minute } }, admin);
    await liveRequest(configPath, diagnosticMeta, diagnosticsHeaders, 429);
    await liveRequest(configPath, { ...diagnosticMeta, token: diagnosticContext.token }, diagnosticsHeaders);
    check('diagnostic request counters and device limits change without disrupting credential renewal', () => {
      assert.equal(renewedDiagnostic.token, diagnosticContext.token);
    });
    const currentDiagnosticChanges = { ...diagnosticChanges, config_requests_per_ip_minute: savedLimits.observability.config_requests_per_ip_minute, upload_requests_per_ip_minute: 2 };
    const diagnosticSettingsAfterLimits = await request(settingsPath, undefined, admin);
    check('the limits panel updates canonical diagnostic settings while preserving feature, retention and storage settings', () => {
      assert.deepEqual(diagnosticSettingsAfterLimits, { ...savedDiagnosticSettings, ...currentDiagnosticChanges });
    });

    const persisted = await request(limitsPath, { replay: { upload_mb_per_ip_hour: 63, sessions_per_hour: 2999 }, observability: { upload_mb_per_ip_hour: 7, sessions_per_hour: 19999 } }, admin);
    server.kill('SIGTERM');
    await once(server, 'exit');
    await startPocketBase();
    const afterRestart = await request(limitsPath, undefined, admin);
    check('both limit groups persist across a real PocketBase restart', () => assert.deepEqual(afterRestart, persisted));
  } finally {
    await request(limitsPath, savedLimits, admin);
    assert.deepEqual(await request(limitsPath, undefined, admin), savedLimits);
    assert.deepEqual(await request('/api/replay/settings', undefined, admin), savedRecordingSettings);
    assert.deepEqual(await request(settingsPath, undefined, admin), savedDiagnosticSettings);
    assert.deepEqual(await request(securityPath, undefined, admin), finalSecurity);
  }
  check('integration checks restore recording, diagnostic, security and limit settings for the dashboard fixture', () => assert.ok(true));

  console.log(`Observability integration passed: ${checks} checks`);
  if (process.argv.includes('--serve')) {
    console.log(`Dashboard fixture: ${endpoint}/dash/replay (${identity} / ${password})`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (hooks) hooks.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
  await rm(work, { recursive: true, force: true });
}
