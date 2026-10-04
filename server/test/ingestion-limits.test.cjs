const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const limits = require('../pb_hooks/lib/ingestion-limits.js');
const security = require('../pb_hooks/lib/ingestion-security.js');
const replay = require('../pb_hooks/lib/replay.js');
const observability = require('../pb_hooks/lib/observability.js');
const { fixture, exception, now } = require('./helpers/observability-fixture.cjs');

const defaults = {
  replay: { config_requests_per_ip_minute: 120, start_requests_per_ip_minute: 30, upload_requests_per_ip_minute: 240, upload_mb_per_ip_hour: 64, sessions_per_device_hour: 12, sessions_per_ip_hour: 120, sessions_per_hour: 3000 },
  observability: { config_requests_per_ip_minute: 120, upload_requests_per_ip_minute: 120, upload_mb_per_ip_hour: 8, sessions_per_device_hour: 30, sessions_per_ip_hour: 120, sessions_per_hour: 20000 },
};
const hash = value => createHash('sha256').update(value).digest('hex');
const MB = 1024 * 1024;

function enabledFixture() {
  const f = fixture();
  replay.saveSettings(f.event({ mode: 'percentage', percentage: 100, account_ids: [], retention_days: 14, daily_limit_mb: 1024 }));
  f.enable();
  return f;
}

function stored(f, key) { return JSON.parse(f.app.findFirstRecordByData('replay_settings', 'key', key).getString('value')); }
function write(f, key, value) {
  let row;
  try { row = f.app.findFirstRecordByData('replay_settings', 'key', key); }
  catch (_) { row = new global.Record(f.app.findCollectionByNameOrId('replay_settings')); row.set('key', key); }
  row.set('value', typeof value === 'string' ? value : JSON.stringify(value));
  f.app.save(row);
}
function save(f, replayPatch, diagnosticsPatch) {
  return limits.saveSettings(f.event({ ...(replayPatch ? { replay: replayPatch } : {}), ...(diagnosticsPatch ? { observability: diagnosticsPatch } : {}) }));
}
function chunk(recording, seq = 0) {
  const raw = JSON.stringify([{ type: 2, timestamp: now, data: {} }]);
  return {
    sessionId: recording.sessionId, token: recording.token, seq, startedAt: now, endedAt: now,
    room: '', encoding: 'gzip-base64', data: gzipSync(raw).toString('base64'), rawBytes: Buffer.byteLength(raw), eventCount: 1, hasSnapshot: true,
  };
}
function log(token, id, message = 'A log entry') { return { token, events: [{ id, timestamp: now, message }] }; }

test('limits default to the existing values and missing stored fields retain those defaults', () => {
  const f = fixture();
  try {
    assert.deepEqual(limits.getSettings(f.event()), defaults);
    assert.deepEqual(limits.replayConfig(f.app), defaults.replay);
    assert.equal(f.records('replay_settings', "key = 'replay_limits'").length, 0);
    write(f, 'replay_limits', { start_requests_per_ip_minute: 17 });
    assert.deepEqual(limits.getSettings(f.event()).replay, { ...defaults.replay, start_requests_per_ip_minute: 17 });
    assert.deepEqual(save(f, { sessions_per_hour: 500 }).replay, { ...defaults.replay, start_requests_per_ip_minute: 17, sessions_per_hour: 500 });
  } finally { f.close(); }
});

test('limits APIs require superuser authentication before accessing settings', () => {
  const app = new Proxy({}, { get: () => { throw new Error('Unauthenticated data access'); } });
  for (const action of ['getSettings', 'saveSettings']) {
    assert.throws(() => limits[action]({ app, hasSuperuserAuth: () => false }), { status: 401 });
    assert.throws(() => limits[action]({ app, auth: { id: 'ordinary-user' }, hasSuperuserAuth: () => false }), { status: 403 });
  }
});

test('limits reject empty, unknown and invalid fields before mutating either settings group', () => {
  const f = fixture();
  try {
    const before = JSON.stringify(f.records('replay_settings').map(row => row.data));
    const invalid = [{}, [], null, { other: {} }, { replay: {} }, { observability: {} }, { replay: [] }, { observability: null }, { replay: { unexpected: 1 } }, { observability: { daily_limit_mb: 1 } }];
    for (const [group, fields] of Object.entries(defaults)) {
      for (const name of Object.keys(fields)) {
        const maximum = name === 'upload_mb_per_ip_hour' ? 1048576 : 1000000;
        for (const value of [0, -1, 1.5, null, '10', true, maximum + 1, Number.MAX_SAFE_INTEGER + 1]) invalid.push({ [group]: { [name]: value } });
      }
    }
    for (const body of invalid) {
      const e = f.event(); e.request.body = JSON.stringify(body);
      assert.throws(() => limits.saveSettings(e), { status: 400 });
      assert.equal(JSON.stringify(f.records('replay_settings').map(row => row.data)), before);
    }
    for (const [group, fields] of Object.entries(defaults)) {
      for (const name of Object.keys(fields)) {
        const maximum = name === 'upload_mb_per_ip_hour' ? 1048576 : 1000000;
        assert.equal(limits.saveSettings(f.event({ [group]: { [name]: maximum } }))[group][name], maximum);
      }
    }
  } finally { f.close(); }
});

test('partial saves preserve diagnostics non-rate settings, omitted limits, and ingestion keys and toggles', () => {
  const f = enabledFixture();
  try {
    observability.saveSettings(f.event({ errors_retention_days: 91, logs_retention_days: 43, daily_limit_mb: 77, alert_webhook_url: 'https://alerts.test/path', alerts_enabled: false }));
    security.createKey(f.event({ label: 'Application' }));
    security.saveSettings(f.event({ requireApiKey: true, requireAccount: true }));
    const telemetryBefore = observability.config(f.app);
    const securityBefore = security.getSettings(f.event());
    const changed = save(f, { config_requests_per_ip_minute: 37 }, { sessions_per_hour: 400 });
    assert.deepEqual(changed, { replay: { ...defaults.replay, config_requests_per_ip_minute: 37 }, observability: { ...defaults.observability, sessions_per_hour: 400 } });
    assert.deepEqual(stored(f, 'observability'), { ...telemetryBefore, sessions_per_hour: 400 });
    assert.deepEqual(stored(f, 'replay_limits'), changed.replay);
    assert.deepEqual(security.getSettings(f.event()), securityBefore);
    assert.deepEqual(save(f, { sessions_per_device_hour: 6 }).observability, changed.observability);
    assert.equal(save(f, undefined, { upload_mb_per_ip_hour: 2 }).replay.config_requests_per_ip_minute, 37);
    assert.deepEqual(limits.getSettings(f.event()), { replay: { ...changed.replay, sessions_per_device_hour: 6 }, observability: { ...changed.observability, upload_mb_per_ip_hour: 2 } });
  } finally { f.close(); }
});

test('saving diagnostics limits alone does not create replay limits storage', () => {
  const f = fixture();
  try {
    assert.equal(save(f, undefined, { config_requests_per_ip_minute: 7 }).observability.config_requests_per_ip_minute, 7);
    assert.equal(f.records('replay_settings', "key = 'replay_limits'").length, 0);
  } finally { f.close(); }
});

test('both groups save atomically and failed saves leave caches unchanged', () => {
  const f = enabledFixture();
  try {
    save(f, { config_requests_per_ip_minute: 10 }, { config_requests_per_ip_minute: 10 });
    const before = limits.getSettings(f.event());
    const telemetryBefore = stored(f, 'observability');
    const cacheBefore = new Map(f.store);
    const original = f.app.save;
    f.app.save = row => { if (row.getString('key') === 'observability') throw new Error('Simulated write failure'); return original(row); };
    assert.throws(() => save(f, { config_requests_per_ip_minute: 20 }, { config_requests_per_ip_minute: 20 }), /Simulated write failure/);
    assert.deepEqual(limits.getSettings(f.event()), before);
    assert.deepEqual(stored(f, 'observability'), telemetryBefore);
    assert.deepEqual(f.store, cacheBefore);
  } finally { f.close(); }
});

test('replay config, start and upload rates change immediately without resetting request counters', () => {
  for (const kind of ['config', 'start', 'upload']) {
    const f = enabledFixture();
    try {
      const recording = replay.start(f.event(f.metadata));
      const field = { config: 'config_requests_per_ip_minute', start: 'start_requests_per_ip_minute', upload: 'upload_requests_per_ip_minute' }[kind];
      save(f, { [field]: 1 });
      let seq = 0;
      const request = { config: () => replay.publicConfig(f.event(f.metadata)), start: () => replay.start(f.event(f.metadata)), upload: () => replay.upload(f.event(chunk(recording, seq++))) }[kind];
      if (kind !== 'start') request();
      assert.throws(request, { status: 429, message: 'Too many replay requests' });
      const before = f.store.get('replay:request-rate');
      save(f, { [field]: 3 });
      assert.equal(f.store.get('replay:request-rate'), before);
      assert.ok(request());
      save(f, { [field]: 1 });
      assert.throws(request, { status: 429 });
      save(f, { [field]: 3 });
      assert.ok(request());
      assert.throws(request, { status: 429 });
    } finally { f.close(); }
  }
});

test('replay session admission applies each configured device, IP and server-wide limit', () => {
  for (const scope of ['device', 'ip', 'server']) {
    const f = enabledFixture();
    try {
      const field = { device: 'sessions_per_device_hour', ip: 'sessions_per_ip_hour', server: 'sessions_per_hour' }[scope];
      save(f, { [field]: 2 });
      const start = index => {
        const e = f.event({ ...f.metadata, deviceId: scope === 'device' ? 'same-device' : 'device-' + index });
        e.realIP = () => scope === 'ip' ? '192.0.2.1' : '192.0.2.' + (index + 1);
        return replay.start(e);
      };
      start(0); start(1);
      assert.throws(() => start(2), { status: 429, message: 'Too many replay sessions' });
      save(f, { [field]: 3 });
      assert.equal(f.records('replay_sessions').length, 2);
      assert.equal(start(2).enabled, true);
      save(f, { [field]: 1 });
      assert.throws(() => start(3), { status: 429 });
    } finally { f.close(); }
  }
});

test('replay session limits are read again inside the admission transaction', () => {
  const f = enabledFixture();
  try {
    save(f, { sessions_per_hour: 2 });
    replay.start(f.event(f.metadata));
    const original = f.app.runInTransaction;
    f.app.runInTransaction = callback => {
      write(f, 'replay_limits', { ...defaults.replay, sessions_per_hour: 1 });
      return original(callback);
    };
    assert.throws(() => replay.start(f.event(f.metadata)), { status: 429, message: 'Too many replay sessions' });
    assert.equal(f.records('replay_sessions').length, 1);
  } finally { f.close(); }
});

test('replay upload volume limits retain consumed bytes when raised or lowered', () => {
  const f = enabledFixture();
  try {
    const recording = replay.start(f.event(f.metadata));
    const payload = chunk(recording);
    const bytes = Buffer.from(payload.data, 'base64').length;
    const initial = MB - bytes + 1;
    f.store.set('replay:ip-bytes', JSON.stringify({ hour: Math.floor(Date.now() / 3600000), keys: { [hash('127.0.0.1')]: initial } }));
    const before = f.store.get('replay:ip-bytes');
    save(f, { upload_mb_per_ip_hour: 1 });
    assert.equal(f.store.get('replay:ip-bytes'), before);
    assert.throws(() => replay.upload(f.event(payload)), { status: 429, message: 'Replay upload budget reached' });
    save(f, { upload_mb_per_ip_hour: 2 });
    assert.deepEqual(replay.upload(f.event(payload)), { ok: true });
    assert.equal(JSON.parse(f.store.get('replay:ip-bytes')).keys[hash('127.0.0.1')], initial + bytes);
    save(f, { upload_mb_per_ip_hour: 1 });
    assert.throws(() => replay.upload(f.event(chunk(recording, 1))), { status: 429 });
  } finally { f.close(); }
});

test('limits API updates existing diagnostics cache and immediately enforces config and each upload route', () => {
  const f = enabledFixture();
  try {
    const telemetry = observability.publicConfig(f.event(f.metadata));
    const oldRequests = f.store.get('observability:requests');
    save(f, undefined, { config_requests_per_ip_minute: 1, upload_requests_per_ip_minute: 1 });
    assert.equal(f.store.get('observability:requests'), oldRequests);
    assert.equal(JSON.parse(f.store.get('observability:settings')).value.upload_requests_per_ip_minute, 1);
    assert.throws(() => observability.publicConfig(f.event({ ...f.metadata, token: telemetry.token })), { status: 429 });
    save(f, undefined, { config_requests_per_ip_minute: 2 });
    assert.equal(observability.publicConfig(f.event({ ...f.metadata, token: telemetry.token })).token, telemetry.token);
    observability.errors(f.event({ token: telemetry.token, events: [exception('error-one')] }));
    observability.logsUpload(f.event(log(telemetry.token, 'log-one')));
    assert.throws(() => observability.errors(f.event({ token: telemetry.token, events: [exception('error-two')] })), { status: 429 });
    assert.throws(() => observability.logsUpload(f.event(log(telemetry.token, 'log-two'))), { status: 429 });
    const counters = f.store.get('observability:requests');
    save(f, undefined, { upload_requests_per_ip_minute: 2 });
    assert.equal(f.store.get('observability:requests'), counters);
    assert.equal(observability.errors(f.event({ token: telemetry.token, events: [exception('error-two')] })).accepted, 1);
    assert.equal(observability.logsUpload(f.event(log(telemetry.token, 'log-two'))).accepted, 1);
  } finally { f.close(); }
});

test('diagnostics session and shared upload volume limits continue to use canonical settings', () => {
  const f = enabledFixture();
  try {
    save(f, undefined, { sessions_per_device_hour: 1, upload_mb_per_ip_hour: 1 });
    const telemetry = observability.publicConfig(f.event(f.metadata));
    assert.throws(() => observability.publicConfig(f.event(f.metadata)), { status: 429, message: 'Too many observability sessions' });
    assert.equal(observability.publicConfig(f.event({ ...f.metadata, token: telemetry.token })).token, telemetry.token);
    save(f, undefined, { sessions_per_device_hour: 2 });
    assert.ok(observability.publicConfig(f.event(f.metadata)).token);
    const state = JSON.stringify({ hour: Math.floor(Date.now() / 3600000), keys: { [hash('127.0.0.1')]: MB } });
    f.store.set('observability:bytes', state);
    assert.throws(() => observability.logsUpload(f.event(log(telemetry.token, 'limited-log'))), { status: 429, message: 'Observability upload budget reached' });
    assert.throws(() => observability.errors(f.event({ token: telemetry.token, events: [exception('limited-error')] })), { status: 429 });
    save(f, undefined, { upload_mb_per_ip_hour: 2 });
    assert.equal(f.store.get('observability:bytes'), state);
    assert.equal(observability.logsUpload(f.event(log(telemetry.token, 'limited-log'))).accepted, 1);
    assert.equal(observability.errors(f.event({ token: telemetry.token, events: [exception('limited-error')] })).accepted, 1);
    assert.deepEqual(limits.getSettings(f.event()).observability, { ...defaults.observability, sessions_per_device_hour: 2, upload_mb_per_ip_hour: 2 });
  } finally { f.close(); }
});

test('direct replay limit edits refresh within five seconds and malformed stored values fail closed', () => {
  const f = fixture();
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  try {
    assert.equal(limits.replayConfig(f.app).config_requests_per_ip_minute, 120);
    write(f, 'replay_limits', { config_requests_per_ip_minute: 9 });
    assert.equal(limits.replayConfig(f.app).config_requests_per_ip_minute, 120);
    clock += 5001;
    assert.equal(limits.replayConfig(f.app).config_requests_per_ip_minute, 9);
    for (const value of ['{broken', { config_requests_per_ip_minute: '12' }, { config_requests_per_ip_minute: 0 }, { unknown: 1 }, [], null]) {
      write(f, 'replay_limits', value);
      assert.throws(() => limits.getSettings(f.event()), { status: 503, message: 'Invalid replay rate limits' });
      assert.throws(() => limits.replayConfig(f.app, true), { status: 503 });
      clock += 5001;
      assert.throws(() => limits.replayConfig(f.app), { status: 503 });
    }
    const app = { store: () => ({ get: () => undefined }), findRecordsByFilter: () => { throw new Error('Database unavailable'); } };
    assert.throws(() => limits.replayConfig(app), { status: 503, message: 'Replay rate limits unavailable' });
  } finally { Date.now = originalNow; f.close(); }
});

test('limits responses prevent caching and route errors preserve their status', () => {
  const f = fixture();
  try {
    const headers = {};
    const e = f.event();
    e.response = { header: () => ({ set: (key, value) => { headers[key] = value; } }) };
    e.json = (status, body) => ({ status, body });
    assert.deepEqual(limits.route(e, 'getSettings'), { status: 200, body: defaults });
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    e.hasSuperuserAuth = () => false;
    assert.equal(limits.route(e, 'getSettings').status, 401);
  } finally { f.close(); }
});
