const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const security = require('../pb_hooks/lib/ingestion-security.js');
const replay = require('../pb_hooks/lib/replay.js');
const observability = require('../pb_hooks/lib/observability.js');
const { fixture, exception, now } = require('./helpers/observability-fixture.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const guest = { deviceId: 'guest-device', platform: 'web', appVersion: '1.0' };

function enabledFixture() {
  const f = fixture();
  replay.saveSettings(f.event({ mode: 'percentage', percentage: 100, account_ids: [], retention_days: 14, daily_limit_mb: 1024 }));
  f.enable();
  return f;
}

function toggles(f, requireApiKey, requireAccount = false) {
  return security.saveSettings(f.event({ requireApiKey, requireAccount }));
}

function key(f, label = 'Web application') { return security.createKey(f.event({ label })); }

function chunk(session, seq = 0, apiKey) {
  const raw = JSON.stringify([{ type: 2, timestamp: now, data: {} }]);
  return {
    sessionId: session.sessionId, token: session.token, seq, startedAt: now, endedAt: now,
    room: '', encoding: 'gzip-base64', data: gzipSync(raw).toString('base64'), rawBytes: Buffer.byteLength(raw), eventCount: 1, hasSnapshot: true,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

function log(token, id, apiKey) { return { token, events: [{ id, timestamp: now, message: 'A log entry' }], ...(apiKey === undefined ? {} : { apiKey }) }; }
function error(token, id, apiKey) { return { token, events: [exception(id)], ...(apiKey === undefined ? {} : { apiKey }) }; }

test('missing security settings leave anonymous replay, errors and logs working', () => {
  const f = enabledFixture();
  try {
    assert.deepEqual(security.getSettings(f.event()), { requireApiKey: false, requireAccount: false, keys: [] });
    assert.equal(f.records('replay_settings', "key = 'ingestion_security'").length, 0);
    assert.equal(replay.publicConfig(f.event(guest)).enabled, true);
    const recording = replay.start(f.event(guest));
    const telemetry = observability.publicConfig(f.event(guest));
    assert.deepEqual(replay.upload(f.event(chunk(recording))), { ok: true });
    assert.equal(observability.errors(f.event(error(telemetry.token, 'anonymous-error'))).accepted, 1);
    assert.equal(observability.logsUpload(f.event(log(telemetry.token, 'anonymous-log'))).accepted, 1);
    toggles(f, false);
    assert.equal(replay.publicConfig(f.event({ ...guest, apiKey: { invalid: true } })).enabled, true);
    assert.deepEqual(replay.upload(f.event(chunk(recording, 1, 'invalid'))), { ok: true });
  } finally { f.close(); }
});

test('security administration requires superuser authentication before accessing data', () => {
  const app = new Proxy({}, { get: () => { throw new Error('Data accessed before authentication'); } });
  for (const action of ['getSettings', 'saveSettings', 'createKey', 'revokeKey']) {
    assert.throws(() => security[action]({ app, hasSuperuserAuth: () => false }), { status: 401 });
    assert.throws(() => security[action]({ app, auth: { id: 'ordinary-user' }, hasSuperuserAuth: () => false }), { status: 403 });
  }
});

test('API keys are generated once, stored only as hashes, and omitted from management responses', () => {
  const f = fixture();
  try {
    const first = key(f, '  Browser  ');
    const second = key(f, 'Android');
    assert.match(first.apiKey, /^pbr_[A-Za-z0-9]{64}$/);
    assert.notEqual(first.apiKey, second.apiKey);
    assert.deepEqual(Object.keys(first.key).sort(), ['createdAt', 'id', 'label', 'prefix']);
    assert.equal(first.key.label, 'Browser');
    assert.equal(first.key.prefix, first.apiKey.slice(0, 12));
    const stored = f.app.findFirstRecordByData('replay_settings', 'key', 'ingestion_security').getString('value');
    assert.ok(!stored.includes(first.apiKey));
    assert.ok(!stored.includes(second.apiKey));
    assert.equal(JSON.parse(stored).keys[0].hash, hash(first.apiKey));
    const saved = toggles(f, true);
    assert.deepEqual(saved.keys, [first.key, second.key]);
    assert.deepEqual(security.getSettings(f.event()), saved);
    assert.ok(!JSON.stringify(saved).includes(hash(first.apiKey)));
    assert.ok(!JSON.stringify(saved).includes(first.apiKey));
  } finally { f.close(); }
});

test('toggle edits are strict, preserve keys, and prevent enabling without a key or revoking the last enabled key', () => {
  const f = fixture();
  try {
    assert.throws(() => toggles(f, true), { status: 400 });
    for (const value of ['true', 1, null, undefined]) {
      assert.throws(() => security.saveSettings(f.event({ requireApiKey: value, requireAccount: false })), { status: 400 });
      assert.throws(() => security.saveSettings(f.event({ requireApiKey: false, requireAccount: value })), { status: 400 });
    }
    assert.throws(() => security.saveSettings(f.event({ requireApiKey: false, requireAccount: false, keys: [] })), { status: 400 });
    const first = key(f);
    assert.deepEqual(toggles(f, true, true).keys, [first.key]);
    assert.throws(() => security.revokeKey(f.event({}, {}, first.key.id)), { status: 400 });
    assert.equal(security.getSettings(f.event()).keys.length, 1);
    toggles(f, false, false);
    assert.deepEqual(security.revokeKey(f.event({}, {}, first.key.id)), { requireApiKey: false, requireAccount: false, keys: [] });
    assert.throws(() => security.revokeKey(f.event({}, {}, first.key.id)), { status: 404 });
  } finally { f.close(); }
});

test('key labels and key counts are bounded and callers cannot supply key material', () => {
  const f = fixture();
  try {
    for (const label of ['', '   ', 'x'.repeat(65), 'bad\nlabel', 42, ['label']]) assert.throws(() => key(f, label), { status: 400 });
    assert.throws(() => security.createKey(f.event({ label: 'Browser', apiKey: 'chosen' })), { status: 400 });
    for (let i = 0; i < 32; i++) key(f, 'Application ' + i);
    assert.throws(() => key(f), { status: 400, message: 'Too many ingestion keys' });
    assert.equal(security.getSettings(f.event()).keys.length, 32);
  } finally { f.close(); }
});

test('enabling the API key requirement guards every bootstrap and upload route', () => {
  const f = enabledFixture();
  try {
    const recording = replay.start(f.event(f.metadata));
    const telemetry = observability.publicConfig(f.event(f.metadata));
    const created = key(f);
    toggles(f, true);
    const requests = [
      apiKey => replay.publicConfig(f.event({ ...f.metadata, apiKey })),
      apiKey => replay.start(f.event({ ...f.metadata, apiKey })),
      apiKey => replay.upload(f.event(chunk(recording, 0, apiKey))),
      apiKey => observability.publicConfig(f.event({ ...f.metadata, token: telemetry.token, apiKey })),
      apiKey => observability.errors(f.event(error(telemetry.token, 'protected-error', apiKey))),
      apiKey => observability.logsUpload(f.event(log(telemetry.token, 'protected-log', apiKey))),
    ];
    for (const request of requests) {
      for (const supplied of [undefined, '', 'pbr_' + 'a'.repeat(64), created.apiKey + 'extra', 42]) assert.throws(() => request(supplied), { status: 401, message: 'Invalid ingestion API key' });
      assert.ok(request(created.apiKey));
    }
    toggles(f, false);
    assert.equal(replay.publicConfig(f.event(f.metadata)).enabled, true);
    assert.deepEqual(replay.upload(f.event(chunk(recording, 1))), { ok: true });
    assert.equal(observability.logsUpload(f.event(log(telemetry.token, 'after-disabled'))).accepted, 1);
  } finally { f.close(); }
});

test('revoking a key immediately rejects existing replay and telemetry uploads while another key remains valid', () => {
  const f = enabledFixture();
  try {
    const first = key(f, 'Old key');
    const replacement = key(f, 'Replacement');
    toggles(f, true);
    const recording = replay.start(f.event({ ...f.metadata, apiKey: first.apiKey }));
    const telemetry = observability.publicConfig(f.event({ ...f.metadata, apiKey: first.apiKey }));
    const result = security.revokeKey(f.event({}, {}, first.key.id));
    assert.deepEqual(result.keys, [replacement.key]);
    const requests = [
      apiKey => replay.publicConfig(f.event({ ...f.metadata, apiKey })),
      apiKey => replay.start(f.event({ ...f.metadata, apiKey })),
      apiKey => replay.upload(f.event(chunk(recording, 0, apiKey))),
      apiKey => observability.publicConfig(f.event({ ...f.metadata, token: telemetry.token, apiKey })),
      apiKey => observability.errors(f.event(error(telemetry.token, 'revoked-error', apiKey))),
      apiKey => observability.logsUpload(f.event(log(telemetry.token, 'revoked-log', apiKey))),
    ];
    for (const request of requests) {
      assert.throws(() => request(first.apiKey), { status: 401 });
      assert.ok(request(replacement.apiKey));
    }
  } finally { f.close(); }
});

test('requiring an account rejects anonymous credential issuance and existing anonymous uploads independently of API keys', () => {
  const f = enabledFixture();
  try {
    const anonymousRecording = replay.start(f.event(guest));
    const anonymousTelemetry = observability.publicConfig(f.event(guest));
    const verifiedRecording = replay.start(f.event(f.metadata));
    const verifiedTelemetry = observability.publicConfig(f.event(f.metadata));
    toggles(f, false, true);
    for (const bootstrap of [replay.publicConfig, replay.start, observability.publicConfig]) {
      assert.throws(() => bootstrap(f.event(guest)), { status: 401, message: 'A verified account is required' });
      assert.throws(() => bootstrap(f.event({ ...guest, accountId: 'alice' })), { status: 401 });
      assert.throws(() => bootstrap(f.event({ ...f.metadata, authToken: 'forged' })), { status: 401 });
      assert.throws(() => bootstrap(f.event({ ...f.metadata, accountId: 'another-account' })), { status: 401 });
      assert.equal(bootstrap(f.event(f.metadata)).enabled, true);
    }
    assert.throws(() => replay.upload(f.event({ ...chunk(anonymousRecording), accountId: 'alice', authToken: 'alice-token' })), { status: 401 });
    assert.throws(() => observability.errors(f.event({ ...error(anonymousTelemetry.token, 'guest-error'), accountId: 'alice' })), { status: 401 });
    assert.throws(() => observability.logsUpload(f.event(log(anonymousTelemetry.token, 'guest-log'))), { status: 401 });
    assert.deepEqual(replay.upload(f.event(chunk(verifiedRecording))), { ok: true });
    assert.equal(observability.errors(f.event(error(verifiedTelemetry.token, 'verified-error'))).accepted, 1);
    assert.equal(observability.logsUpload(f.event(log(verifiedTelemetry.token, 'verified-log'))).accepted, 1);
    toggles(f, false, false);
    assert.deepEqual(replay.upload(f.event(chunk(anonymousRecording))), { ok: true });
    assert.equal(observability.logsUpload(f.event(log(anonymousTelemetry.token, 'guest-log'))).accepted, 1);
  } finally { f.close(); }
});

test('write transactions recheck a key revoked after the initial request check', () => {
  for (const operation of ['start', 'chunk', 'context', 'error', 'log']) {
    const f = enabledFixture();
    try {
      const first = key(f, 'Revoked during admission');
      key(f, 'Remaining key');
      toggles(f, true);
      const recording = replay.start(f.event({ ...f.metadata, apiKey: first.apiKey }));
      const telemetry = observability.publicConfig(f.event({ ...f.metadata, apiKey: first.apiKey }));
      const original = f.app.runInTransaction;
      f.app.runInTransaction = callback => {
        const row = f.app.findFirstRecordByData('replay_settings', 'key', 'ingestion_security');
        const value = JSON.parse(row.getString('value'));
        value.keys = value.keys.filter(item => item.id !== first.key.id);
        row.set('value', JSON.stringify(value)); f.app.save(row);
        return original(callback);
      };
      const request = {
        start: () => replay.start(f.event({ ...f.metadata, apiKey: first.apiKey })),
        chunk: () => replay.upload(f.event(chunk(recording, 0, first.apiKey))),
        context: () => observability.publicConfig(f.event({ ...f.metadata, token: telemetry.token, apiKey: first.apiKey })),
        error: () => observability.errors(f.event(error(telemetry.token, 'race-error', first.apiKey))),
        log: () => observability.logsUpload(f.event(log(telemetry.token, 'race-log', first.apiKey))),
      }[operation];
      assert.throws(request, { status: 401, message: 'Invalid ingestion API key' }, operation);
      assert.equal(f.records('replay_sessions').length, 1);
      assert.equal(f.records('replay_observability_sessions').length, 1);
      assert.equal(f.records('replay_chunks').length, 0);
      assert.equal(f.records('replay_errors').length, 0);
      assert.equal(f.records('replay_logs').length, 0);
    } finally { f.close(); }
  }
});

test('corrupt or unavailable persisted security settings fail closed', () => {
  const f = enabledFixture();
  try {
    key(f);
    const row = f.app.findFirstRecordByData('replay_settings', 'key', 'ingestion_security');
    for (const value of ['{broken', JSON.stringify({ requireApiKey: 'false', requireAccount: false, keys: [] }), JSON.stringify({ requireApiKey: true, requireAccount: false, keys: [] })]) {
      row.set('value', value); f.app.save(row);
      assert.throws(() => replay.publicConfig(f.event(f.metadata)), { status: 503, message: 'Invalid ingestion security settings' });
      assert.throws(() => observability.publicConfig(f.event(f.metadata)), { status: 503 });
      assert.throws(() => security.getSettings(f.event()), { status: 503 });
    }
    const app = { findRecordsByFilter: () => { throw new Error('Database unavailable'); } };
    assert.throws(() => security.check(app, {}), { status: 503, message: 'Ingestion security settings unavailable' });
  } finally { f.close(); }
});

test('security routes load their handlers in isolated hook contexts and bound mutation bodies', () => {
  const routes = [];
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_hooks/705_ingestion_security.pb.js'), 'utf8'), {
    routerAdd: (method, route, handler, middleware) => routes.push({ method, route, handler, middleware }),
    $apis: { bodyLimit: bytes => bytes }, __hooks: '/pb/pb_hooks',
    require: file => ({ route: (event, name) => { calls.push({ file, name, event }); return name; } }),
  });
  assert.deepEqual(routes.map(item => [item.method, item.route]), [
    ['GET', '/api/replay/security'], ['POST', '/api/replay/security'], ['POST', '/api/replay/security/keys'], ['DELETE', '/api/replay/security/keys/{id}'],
    ['GET', '/api/replay/security/limits'], ['POST', '/api/replay/security/limits'],
  ]);
  for (const route of routes) {
    if (route.method === 'POST') assert.equal(route.middleware, 16384);
    assert.equal(typeof route.handler({}), 'string');
  }
  assert.deepEqual(calls.map(item => item.name), ['getSettings', 'saveSettings', 'createKey', 'revokeKey', 'getSettings', 'saveSettings']);
  for (const [index, call] of calls.entries()) assert.equal(call.file, '/pb/pb_hooks/lib/' + (index < 4 ? 'ingestion-security.js' : 'ingestion-limits.js'));
});
