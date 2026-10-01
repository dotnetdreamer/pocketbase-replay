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

async function request(path, body, token = '', method = body === undefined ? 'GET' : 'POST', status = 200) {
  const response = await fetch(endpoint + path, {
    method, headers: { 'Content-Type': path.startsWith('/api/collections') ? 'application/json' : 'text/plain;charset=UTF-8', ...(token ? { Authorization: token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

try {
  execFileSync(process.execPath, [join(root, 'scripts/install.mjs'), '--target', work], { stdio: 'pipe' });
  execFileSync(resolve(binary), ['superuser', 'upsert', identity, password, '--dir', join(work, 'pb_data')], { cwd: work, stdio: 'pipe' });
  server = spawn(resolve(binary), ['serve', `--http=127.0.0.1:${port}`, '--dir', join(work, 'pb_data')], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REPLAY_AUTH_URL: '', REPLAY_ERASE_KEY: eraseKey, REPLAY_AUTH_COLLECTION: 'observability_test_users' } });
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
  const meta = { deviceId: 'observability-e2e-device', platform: 'web', appVersion: '1.0.0', room: 'TEST1' };
  const initial = await request(settingsPath, undefined, admin);
  check('new features default off', () => { assert.equal(initial.errors_enabled, false); assert.equal(initial.logs_enabled, false); });
  const disabled = await request(configPath, meta);
  check('disabled configuration creates no upload credential', () => { assert.equal(disabled.errorsEnabled, false); assert.equal(disabled.logsEnabled, false); assert.ok(!disabled.token); });
  for (const path of [settingsPath, '/api/replay/issues', '/api/replay/logs', '/api/replay/alerts']) await request(path, undefined, '', 'GET', 401);
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
