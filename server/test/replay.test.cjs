const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../pb_hooks/lib/replay-core.js');
const replay = require('../pb_hooks/lib/replay.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = Date.now();
const defaults = { mode: 'off', percentage: 0, account_ids: [], retention_days: 14, daily_limit_mb: 1024, mask_selector: '', block_selector: '', record_images: false };
const MB = 1024 * 1024;

function validChunk() {
  const raw = JSON.stringify([{ type: 2, timestamp: now, data: { node: { type: 0, childNodes: [] } } }]);
  return {
    sessionId: 'abc123def456ghi', token: 'a'.repeat(64), seq: 0,
    startedAt: now, endedAt: now, room: 'ABCDE', encoding: 'gzip-base64',
    data: gzipSync(raw).toString('base64'), rawBytes: Buffer.byteLength(raw), eventCount: 1, hasSnapshot: true,
  };
}

function memoryStore() {
  const map = new Map();
  return { map, get: key => map.get(key), set: (key, value) => map.set(key, value) };
}

function settingRows(settings) {
  return Object.keys(settings).map(key => ({ getString: field => field === 'key' ? key : JSON.stringify(settings[key]) }));
}

function globals(authURL) {
  global.$os = { getenv: name => name === 'REPLAY_AUTH_URL' ? (authURL || '') : '' };
  global.$security = { sha256: hash, equal: (a, b) => a === b, randomString: length => 'r'.repeat(length) };
  global.readerToString = value => value;
  global.DynamicModel = function (value) { Object.assign(this, value); };
  global.Record = function () {
    this.data = {};
    this.set = (key, value) => { this.data[key] = value; };
  };
}

function selectedDevice(percentage, wanted) {
  for (let i = 0; ; i++) {
    const id = 'device-' + i;
    if (core.enabled({ ...defaults, mode: 'percentage', percentage }, { deviceId: id, accountId: '' }, hash) === wanted) return id;
  }
}

test('settings default to off and reject invalid or unbounded edits', () => {
  assert.deepEqual(core.settings(defaults), defaults);
  for (const edit of [
    { mode: 'all' }, { percentage: NaN }, { percentage: 101 }, { percentage: '10' }, { retention_days: 0 }, { retention_days: 366 },
    { account_ids: 'abc' }, { account_ids: [''] }, { account_ids: new Array(2001).fill('abc') },
    { daily_limit_mb: 0 }, { daily_limit_mb: 1048577 }, { daily_limit_mb: 1.5 }, { daily_limit_mb: '10' }, { daily_limit_mb: undefined },
  ]) {
    assert.throws(() => core.settings({ ...defaults, ...edit }), { status: 400 });
  }
  assert.deepEqual(core.settings({ ...defaults, account_ids: ['a', 'a', 'b'] }).account_ids, ['a', 'b']);
  assert.equal(core.settings({ ...defaults, daily_limit_mb: 1048576 }).daily_limit_mb, 1048576);
});

test('bad sampling settings fail closed without shortening valid retention', () => {
  const app = { findRecordsByFilter: () => [
    { getString: key => key === 'key' ? 'mode' : '"percentage"' },
    { getString: key => key === 'key' ? 'percentage' : 'malformed' },
    { getString: key => key === 'key' ? 'retention_days' : '365' },
  ] };
  assert.deepEqual(replay.config(app), { ...defaults, retention_days: 365 });
});

test('the daily limit is read with the other settings and falls back to its default', () => {
  let query;
  const stored = { mode: 'percentage', percentage: 5, account_ids: [], retention_days: 30 };
  const app = { findRecordsByFilter: (name, filter, sort, limit) => { query = { name, filter, limit }; return settingRows(stored); } };
  assert.deepEqual(replay.config(app), { ...defaults, ...stored, daily_limit_mb: 1024 });
  assert.match(query.filter, /key = 'daily_limit_mb'/);
  assert.equal(query.limit, 8);
  stored.daily_limit_mb = 2048;
  assert.equal(replay.config(app).daily_limit_mb, 2048);
  stored.daily_limit_mb = 0;
  assert.deepEqual(replay.config(app), { ...defaults, retention_days: 30 });
});

test('saving settings keeps the stored daily limit when an older form leaves it out', () => {
  globals();
  const rows = new Map(Object.entries({ ...defaults, daily_limit_mb: 300 }).map(([key, value]) => [key, { key, value: JSON.stringify(value) }]));
  const app = {
    runInTransaction: fn => fn(app),
    findRecordsByFilter: () => Array.from(rows.values()).map(row => ({ getString: field => row[field] })),
    findFirstRecordByData: (_name, _field, key) => { if (!rows.has(key)) throw new Error('missing'); return { set: (field, value) => { rows.get(key)[field] = value; } }; },
    findCollectionByNameOrId: name => ({ name }),
    save: () => {},
  };
  const e = body => ({ app, hasSuperuserAuth: () => true, request: { body: JSON.stringify(body) } });
  const form = { mode: 'percentage', percentage: 10, account_ids: [], retention_days: 14 };
  assert.equal(replay.saveSettings(e(form)).daily_limit_mb, 300);
  assert.equal(rows.get('daily_limit_mb').value, '300');
  assert.equal(replay.saveSettings(e({ ...form, daily_limit_mb: 50 })).daily_limit_mb, 50);
  assert.equal(replay.getSettings(e({})).daily_limit_mb, 50);
  assert.throws(() => replay.saveSettings(e({ ...form, daily_limit_mb: 0 })), { status: 400 });
});

test('selector settings accept long CSS lists and refuse control characters or oversized text', () => {
  const list = '.chat-message,\n\t[class*="name"],\r\n.avatar';
  const cfg = core.settings({ ...defaults, mask_selector: list, block_selector: '.avatar' });
  assert.equal(cfg.mask_selector, list);
  assert.equal(cfg.block_selector, '.avatar');
  assert.equal(core.settings({ ...defaults, mask_selector: 'x'.repeat(20000) }).mask_selector.length, 20000);
  const { mask_selector: _mask, block_selector: _block, record_images: _images, ...older } = defaults;
  assert.deepEqual(core.settings(older), defaults);
  for (const key of ['mask_selector', 'block_selector']) {
    for (const value of ['x'.repeat(20001), '.a\u0000', '.a\u001b[31m', '.a\u007f', '.a\u000b', 42, ['.a'], { selector: '.a' }]) {
      assert.throws(() => core.settings({ ...defaults, [key]: value }), { status: 400, message: 'Invalid ' + key }, JSON.stringify(value));
    }
  }
});

test('record_images is off unless saved as true and refuses anything but a boolean', () => {
  assert.equal(core.DEFAULTS.record_images, false);
  assert.equal(core.settings({ ...defaults, record_images: undefined }).record_images, false);
  assert.equal(core.settings({ ...defaults, record_images: true }).record_images, true);
  for (const value of ['true', 1, 0, 'on', [true], {}]) {
    assert.throws(() => core.settings({ ...defaults, record_images: value }), { status: 400, message: 'Invalid record_images' }, JSON.stringify(value));
  }
  const app = { findRecordsByFilter: (_name, filter) => { assert.match(filter, /key = 'record_images'/); return settingRows({ ...defaults, record_images: true }); } };
  assert.equal(replay.config(app).record_images, true);
});

test('selector settings are read with the others and survive a fallback only when valid', () => {
  let query;
  const stored = { ...defaults, mode: 'percentage', percentage: 5, mask_selector: '.chat, [class*="name"]', block_selector: '.avatar' };
  const app = { findRecordsByFilter: (name, filter, sort, limit) => { query = { filter, limit }; return settingRows(stored); } };
  assert.deepEqual(replay.config(app), stored);
  assert.match(query.filter, /key = 'mask_selector' \|\| key = 'block_selector'/);
  assert.equal(query.limit, Object.keys(core.DEFAULTS).length);
  stored.mode = 'everyone';
  assert.deepEqual(replay.config(app), { ...defaults, mask_selector: stored.mask_selector, block_selector: '.avatar' });
  stored.mode = 'percentage';
  stored.block_selector = '.avatar\u0000';
  assert.deepEqual(replay.config(app), { ...defaults, mask_selector: stored.mask_selector });
});

test('saving settings keeps stored selectors when a form leaves them out and replaces them when given', () => {
  globals();
  const start = { ...defaults, mask_selector: '.chat', block_selector: '.avatar' };
  const rows = new Map(Object.entries(start).map(([key, value]) => [key, { key, value: JSON.stringify(value) }]));
  const created = [];
  const app = {
    runInTransaction: fn => fn(app),
    findRecordsByFilter: () => Array.from(rows.values()).map(row => ({ getString: field => row[field] })),
    findFirstRecordByData: (_name, _field, key) => { if (!rows.has(key)) throw new Error('missing'); return { set: (field, value) => { rows.get(key)[field] = value; } }; },
    findCollectionByNameOrId: name => ({ name }),
    save: row => { if (row.data) { created.push(row.data.key); rows.set(row.data.key, { ...row.data }); } },
  };
  const e = body => ({ app, hasSuperuserAuth: () => true, request: { body: JSON.stringify(body) } });
  const form = { mode: 'percentage', percentage: 10, account_ids: [], retention_days: 14, daily_limit_mb: 50 };
  const kept = replay.saveSettings(e(form));
  assert.equal(kept.mask_selector, '.chat');
  assert.equal(kept.block_selector, '.avatar');
  assert.equal(rows.get('mask_selector').value, JSON.stringify('.chat'));
  const edited = replay.saveSettings(e({ ...form, mask_selector: '.chat,\n.name', block_selector: '' }));
  assert.equal(edited.mask_selector, '.chat,\n.name');
  assert.equal(rows.get('mask_selector').value, JSON.stringify('.chat,\n.name'));
  assert.equal(rows.get('block_selector').value, '""');
  assert.deepEqual(replay.getSettings(e({})), { ...form, mask_selector: '.chat,\n.name', block_selector: '', record_images: false });
  assert.throws(() => replay.saveSettings(e({ ...form, mask_selector: '.a\u0007' })), { status: 400 });
  assert.equal(rows.get('mask_selector').value, JSON.stringify('.chat,\n.name'));

  rows.delete('mask_selector'); rows.delete('block_selector');
  assert.equal(replay.saveSettings(e(form)).mask_selector, '');
  assert.deepEqual(created, ['mask_selector', 'block_selector']);
  assert.equal(rows.get('mask_selector').value, '""');
});

test('sampling is stable, covers anonymous users, and accounts need verified identity', () => {
  const identity = { deviceId: 'device-a', accountId: '' };
  assert.equal(core.enabled(defaults, identity, hash), false);
  assert.equal(core.enabled({ ...defaults, mode: 'percentage', percentage: 100 }, identity, hash), true);
  assert.equal(core.enabled({ ...defaults, mode: 'percentage', percentage: 0 }, identity, hash), false);
  const cfg = { ...defaults, mode: 'percentage', percentage: 50 };
  assert.equal(core.enabled(cfg, identity, hash), core.enabled(cfg, identity, hash));
  const accounts = { ...defaults, mode: 'accounts', account_ids: ['alice'] };
  assert.equal(core.enabled(accounts, identity, hash), false);
  assert.equal(core.enabled(accounts, { ...identity, accountId: 'alice' }, hash), true);
  assert.equal(core.enabled(accounts, { ...identity, accountId: 'bob' }, hash), false);
});

test('chunk validator measures compressed bytes without decompressing', () => {
  const input = validChunk();
  const result = core.chunk(input, now);
  assert.equal(result.compressedBytes, Buffer.from(input.data, 'base64').byteLength);
  assert.equal(result.seq, 0);
  for (const patch of [
    { seq: -1 }, { seq: 1.5 }, { seq: 2 ** 53 }, { seq: '3' }, { data: 'not gzip' }, { data: input.data + '=' },
    { encoding: 'json' }, { rawBytes: core.LIMITS.rawBytes + 1 }, { rawBytes: 1 },
    { eventCount: 0 }, { eventCount: 50001 }, { hasSnapshot: 'true' },
    { startedAt: now + 24 * 60 * 60 * 1000 + 1 }, { endedAt: now - 1 }, { room: 'a|b' },
    { sessionId: '../../passwords' }, { sessionId: 'A'.repeat(15) },
  ]) assert.throws(() => core.chunk({ ...input, ...patch }, now));
  assert.throws(() => core.chunk({ ...input, token: 'a'.repeat(63) }, now), { status: 401 });
  assert.throws(() => core.chunk({ ...input, data: 'H4sI' + 'A'.repeat(524288) }, now));
});

test('chunk validator leaves the seq ceiling to the session and tolerates a day of clock skew', () => {
  const input = validChunk();
  assert.equal(core.chunk({ ...input, seq: 2048 }, now).seq, 2048);
  assert.equal(core.chunk({ ...input, seq: 100000 }, now).seq, 100000);
  const ahead = now + 20 * 60 * 60 * 1000;
  assert.equal(core.chunk({ ...input, startedAt: ahead, endedAt: ahead + 1000 }, now).endedAt, ahead + 1000);
  assert.equal(core.LIMITS.sessionBytes, 40 * MB);
});

test('metadata cannot smuggle newlines, oversized identity, or room separators', () => {
  const input = { deviceId: 'device', platform: 'android', appVersion: '1.4.32' };
  assert.equal(core.metadata(input).accountId, '');
  for (const patch of [{ deviceId: '' }, { deviceId: 'x'.repeat(129) }, { platform: 'web\nHeader' }, { authToken: 'x'.repeat(8193) }, { room: 'a|b' }]) assert.throws(() => core.metadata({ ...input, ...patch }), { status: 400 });
});

test('viewer gaps include lost first chunks and gaps between pages', () => {
  assert.deepEqual(core.gaps([{ seq: 2 }, { seq: 4 }], -1), [0, 1, 3]);
  assert.deepEqual(core.gaps([{ seq: 8 }, { seq: 9 }], 5), [6, 7]);
});

test('auth service URL is operator configured and cannot include a query or credentials', () => {
  assert.equal(core.authURL(''), '');
  assert.equal(core.authURL('http://main-pocketbase:8090/api/collections/users/auth-refresh'), 'http://main-pocketbase:8090/api/collections/users/auth-refresh');
  for (const value of ['file:///etc/passwd', 'https://pb.test/api/collections/users/auth-refresh?next=https://evil.test', 'https://user:pass@pb.test/api/collections/users/auth-refresh', 'https://pb.test/other']) assert.throws(() => core.authURL(value), { status: 503 });
});

test('account identity comes from verified local tokens and supplied invalid auth fails closed', () => {
  globals();
  const app = { findAuthRecordByToken: token => {
    if (token !== 'valid') throw new Error('invalid');
    return { id: 'alice', isSuperuser: () => false, getBool: () => false };
  } };
  assert.equal(replay.account(app, { accountId: '', authToken: '' }), '');
  assert.throws(() => replay.account(app, { accountId: 'alice', authToken: '' }), { status: 401 });
  assert.throws(() => replay.account(app, { accountId: '', authToken: 'invalid' }), { status: 401 });
  assert.throws(() => replay.account(app, { accountId: 'bob', authToken: 'valid' }), { status: 401 });
  assert.equal(replay.account(app, { accountId: '', authToken: 'valid' }), 'alice');
  assert.equal(replay.account(app, { accountId: 'alice', authToken: 'valid' }), 'alice');
});

test('external auth accepts only its trusted account and never falls back to local auth', () => {
  const url = 'http://main-pocketbase:8090/api/collections/users/auth-refresh';
  globals(url);
  let calls = 0;
  global.$http = { send: options => {
    calls++;
    assert.equal(options.url, url);
    assert.equal(options.headers.Authorization, 'secret');
    return { statusCode: 200, json: { record: { id: 'remote', collectionName: 'users' } } };
  } };
  const app = { store: () => memoryStore(), findAuthRecordByToken: () => { throw new Error('must not use local auth'); } };
  assert.equal(replay.account(app, { authToken: 'secret', accountId: 'remote' }), 'remote');
  assert.throws(() => replay.account(app, { authToken: 'secret', accountId: 'forged' }), { status: 401 });
  global.$http.send = () => { calls++; return { statusCode: 401 }; };
  assert.throws(() => replay.account(app, { authToken: 'secret', accountId: '' }), { status: 401 });
  global.$http.send = () => { calls++; return { statusCode: 200, json: { record: { id: 'admin', collectionName: '_superusers' } } }; };
  assert.throws(() => replay.account(app, { authToken: 'secret', accountId: 'admin' }), { status: 401 });
  global.$http.send = () => { calls++; return { statusCode: 200, json: { record: { id: 'remote', collectionName: 'users', banned: true } } }; };
  assert.throws(() => replay.account(app, { authToken: 'secret', accountId: 'remote' }), { status: 401 });
  assert.equal(calls, 5);
});

test('remote auth refusals are 401 while outages are 503, and neither is cached', () => {
  globals('http://main-pocketbase:8090/api/collections/users/auth-refresh');
  const store = memoryStore();
  const app = { store: () => store };
  const meta = { authToken: 'token', accountId: 'alice' };
  for (const statusCode of [401, 403, 404, 400]) {
    global.$http = { send: () => ({ statusCode, json: { message: 'no' } }) };
    assert.throws(() => replay.account(app, meta), { status: 401, message: 'Invalid account token' });
  }
  for (const statusCode of [429, 500, 502, 503]) {
    global.$http = { send: () => ({ statusCode }) };
    assert.throws(() => replay.account(app, meta), { status: 503, message: 'Account service unavailable' });
  }
  global.$http = { send: () => { throw new Error('dial tcp: i/o timeout'); } };
  assert.throws(() => replay.account(app, meta), { status: 503 });
  assert.equal(store.map.size, 0);
});

test('verified remote tokens are cached for ten minutes, pruned, and capped', () => {
  globals('http://main-pocketbase:8090/api/collections/users/auth-refresh');
  const store = memoryStore();
  const app = { store: () => store };
  let calls = 0;
  global.$http = { send: () => { calls++; return { statusCode: 200, json: { record: { id: 'alice', collectionName: 'users' } } }; } };
  assert.equal(replay.account(app, { authToken: 'token', accountId: 'alice' }), 'alice');
  assert.equal(replay.account(app, { authToken: 'token', accountId: 'alice' }), 'alice');
  assert.equal(calls, 1);
  const cache = JSON.parse(store.map.get('replay:verified'));
  const entry = cache[hash('token')];
  assert.equal(entry.id, 'alice');
  assert.ok(entry.exp > Date.now() + 9 * 60 * 1000 && entry.exp <= Date.now() + 10 * 60 * 1000);
  assert.equal(JSON.stringify(cache).includes('token"'), false);

  entry.exp = Date.now() - 1;
  cache.stale = { id: 'old', exp: Date.now() - 1 };
  store.set('replay:verified', JSON.stringify(cache));
  assert.equal(replay.account(app, { authToken: 'token', accountId: 'alice' }), 'alice');
  assert.equal(calls, 2);
  assert.deepEqual(Object.keys(JSON.parse(store.map.get('replay:verified'))), [hash('token')]);

  const full = {};
  for (let i = 0; i < 5000; i++) full['k' + i] = { id: 'x', exp: Date.now() + 60000 + i };
  store.set('replay:verified', JSON.stringify(full));
  assert.equal(replay.account(app, { authToken: 'other', accountId: 'alice' }), 'alice');
  assert.equal(replay.account(app, { authToken: 'other', accountId: 'alice' }), 'alice');
  assert.equal(calls, 3, 'a full cache still caches the new token');
  const capped = JSON.parse(store.map.get('replay:verified'));
  assert.equal(Object.keys(capped).length, 1000);
  assert.ok(capped[hash('other')] && capped.k4999 && !capped.k0, 'keeps the freshest entries');
});

function serverFixture(settings) {
  globals('http://main-pocketbase:8090/api/collections/users/auth-refresh');
  const store = memoryStore();
  const sessions = new Map();
  const chunks = [];
  const state = { settings, daily: 0, sums: 0, saved: [] };
  function session(fields) {
    const row = { id: fields.id, data: { ...fields } };
    row.getString = key => String(row.data[key] ?? '');
    row.getFloat = key => Number(row.data[key] ?? 0);
    row.getInt = key => Number(row.data[key] ?? 0);
    row.getBool = key => !!row.data[key];
    row.set = (key, value) => { row.data[key] = value; };
    sessions.set(row.id, row);
    return row;
  }
  const app = {
    store: () => store,
    runInTransaction: fn => fn(app),
    findCollectionByNameOrId: name => ({ name }),
    findRecordById: (_name, id) => { if (!sessions.has(id)) throw new Error('missing'); return sessions.get(id); },
    findRecordsByFilter: (name, _filter, _sort, _limit, _offset, params) => {
      if (name === 'replay_settings') return params && params.key ? [] : settingRows(state.settings);
      if (name === 'replay_chunks') return chunks.filter(row => row.data.session === params.id && row.data.seq === params.seq);
      throw new Error('Unexpected collection');
    },
    save: row => { if (row.data && row.data.session) chunks.push(row); state.saved.push(row); },
    db: () => ({ newQuery: sql => ({ bind: () => ({ one: result => {
      if (!sql.includes('SUM(compressedBytes)')) throw new Error('Unexpected SQL');
      state.sums++;
      result.total = state.daily;
    } }) }) }),
  };
  const request = (body, ip) => ({ app, realIP: () => ip || '203.0.113.7', request: { body: JSON.stringify(body) } });
  return { app, store, sessions, chunks, state, session, request };
}

test('config and start skip account verification for claims that cannot be selected', () => {
  const fixture = serverFixture({ ...defaults, mode: 'accounts', account_ids: ['alice'] });
  let calls = 0;
  global.$http = { send: () => { calls++; return { statusCode: 200, json: { record: { id: 'alice', collectionName: 'users' } } }; } };
  const base = { deviceId: 'device-a', platform: 'web' };
  assert.equal(replay.publicConfig(fixture.request({ ...base, accountId: 'bob', authToken: 'bob-token' })).enabled, false);
  assert.equal(replay.publicConfig(fixture.request({ ...base, authToken: 'bob-token' })).enabled, false);
  assert.deepEqual(replay.start(fixture.request({ ...base, accountId: 'bob', authToken: 'bob-token' })), { enabled: false });
  assert.equal(calls, 0);
  assert.equal(replay.publicConfig(fixture.request({ ...base, accountId: 'alice', authToken: 'alice-token' })).enabled, true);
  assert.equal(replay.publicConfig(fixture.request({ ...base, accountId: 'alice', authToken: 'alice-token' })).enabled, true);
  assert.equal(calls, 1);

  fixture.state.settings = { ...defaults, mode: 'percentage', percentage: 50 };
  const skipped = selectedDevice(50, false);
  const picked = selectedDevice(50, true);
  assert.equal(replay.publicConfig(fixture.request({ ...base, deviceId: skipped, authToken: 'other-token' })).enabled, false);
  assert.deepEqual(replay.start(fixture.request({ ...base, deviceId: skipped, authToken: 'other-token' })), { enabled: false });
  assert.equal(replay.publicConfig(fixture.request({ ...base, deviceId: picked })).enabled, true);
  assert.equal(calls, 1);

  fixture.state.settings = { ...defaults, mode: 'accounts', account_ids: ['carol'] };
  global.$http = { send: () => ({ statusCode: 502 }) };
  assert.throws(() => replay.publicConfig(fixture.request({ ...base, accountId: 'carol', authToken: 'carol-token' })), { status: 503 });
});

test('config and start send the privacy rules whenever they answer enabled', () => {
  const fixture = serverFixture({ ...defaults, mode: 'percentage', percentage: 100, mask_selector: '.chat,\n[class*="name"]', block_selector: '.avatar' });
  fixture.app.db = () => ({ newQuery: () => ({ bind: () => ({ one: result => { result.total = 0; } }) }) });
  const base = { deviceId: 'device-a', platform: 'web' };
  assert.deepEqual(replay.publicConfig(fixture.request(base)), {
    enabled: true, uploadIntervalMs: core.LIMITS.uploadIntervalMs, maskTextSelector: '.chat,\n[class*="name"]', blockSelector: '.avatar', recordImages: false,
  });
  const started = replay.start(fixture.request(base));
  assert.equal(started.enabled, true);
  assert.equal(started.maskTextSelector, '.chat,\n[class*="name"]');
  assert.equal(started.blockSelector, '.avatar');

  fixture.state.settings = { ...defaults, mode: 'percentage', percentage: 100 };
  assert.equal(replay.publicConfig(fixture.request(base)).maskTextSelector, '');
  assert.equal(replay.publicConfig(fixture.request(base)).blockSelector, '');
  assert.equal(replay.start(fixture.request(base)).blockSelector, '');
  assert.equal(replay.start(fixture.request(base)).recordImages, false);

  fixture.state.settings = { ...defaults, mode: 'percentage', percentage: 100, record_images: true };
  assert.equal(replay.publicConfig(fixture.request(base)).recordImages, true);
  assert.equal(replay.start(fixture.request(base)).recordImages, true);

  fixture.state.settings = { ...defaults, mask_selector: '.chat' };
  assert.deepEqual(replay.publicConfig(fixture.request(base)), { enabled: false, uploadIntervalMs: core.LIMITS.uploadIntervalMs });
  assert.deepEqual(replay.start(fixture.request(base)), { enabled: false });
});

function uploadFixture(settings) {
  const fixture = serverFixture({ ...defaults, mode: 'percentage', percentage: 100, ...settings });
  fixture.session({
    id: 'abc123def456ghi', tokenHash: hash('a'.repeat(64)), expiresAt: Date.now() + 60000,
    accountId: '', deviceId: 'device-a', chunkCount: 0, compressedBytes: 0, rawBytes: 0, eventCount: 0, rooms: '', endedAt: 0,
  });
  return fixture;
}

test('a seq past the session chunk limit is answered as a full session', () => {
  const fixture = uploadFixture();
  assert.throws(() => replay.upload(fixture.request({ ...validChunk(), seq: 2048 })), { status: 410, message: 'Replay session is full' });
  assert.equal(fixture.chunks.length, 0);
  assert.deepEqual(replay.upload(fixture.request({ ...validChunk(), seq: 2047 })), { ok: true });
  assert.equal(fixture.chunks.length, 1);
});

test('uploads stop at the daily storage budget, counted with SQL once a minute', () => {
  const fixture = uploadFixture({ daily_limit_mb: 1 });
  const chunk = validChunk();
  const bytes = core.chunk(chunk, Date.now()).compressedBytes;
  fixture.state.daily = MB - bytes - 10;
  assert.deepEqual(replay.upload(fixture.request({ ...chunk, seq: 0 })), { ok: true });
  assert.equal(JSON.parse(fixture.store.map.get('replay:daily-bytes')).bytes, MB - 10);
  assert.throws(() => replay.upload(fixture.request({ ...chunk, seq: 1 })), { status: 429, message: 'Replay storage budget reached' });
  assert.equal(fixture.state.sums, 1);
  assert.equal(fixture.chunks.length, 1);

  const cached = JSON.parse(fixture.store.map.get('replay:daily-bytes'));
  cached.at = Date.now() - 61000;
  fixture.store.set('replay:daily-bytes', JSON.stringify(cached));
  fixture.state.daily = 0;
  assert.deepEqual(replay.upload(fixture.request({ ...chunk, seq: 1 })), { ok: true });
  assert.equal(fixture.state.sums, 2);
});

test('each IP gets 64 MiB of compressed chunks per hour', () => {
  const fixture = uploadFixture();
  const chunk = validChunk();
  const bytes = core.chunk(chunk, Date.now()).compressedBytes;
  assert.deepEqual(replay.upload(fixture.request({ ...chunk, seq: 0 })), { ok: true });
  const state = JSON.parse(fixture.store.map.get('replay:ip-bytes'));
  assert.equal(state.keys[hash('203.0.113.7')], bytes);
  state.keys[hash('203.0.113.7')] = 64 * MB - bytes + 1;
  fixture.store.set('replay:ip-bytes', JSON.stringify(state));
  assert.throws(() => replay.upload(fixture.request({ ...chunk, seq: 1 })), { status: 429, message: 'Replay upload budget reached' });
  assert.deepEqual(replay.upload(fixture.request({ ...chunk, seq: 1 }, '198.51.100.9')), { ok: true });

  const full = { hour: state.hour, keys: {} };
  for (let i = 0; i < 4096; i++) full.keys['k' + i] = 1;
  fixture.store.set('replay:ip-bytes', JSON.stringify(full));
  assert.deepEqual(replay.upload(fixture.request({ ...chunk, seq: 2 }, '192.0.2.1')), { ok: true });
  assert.equal(Object.keys(JSON.parse(fixture.store.map.get('replay:ip-bytes')).keys).length, 4096);
  assert.equal(fixture.chunks.length, 3);
});

test('a repeated chunk is not charged to the budgets twice', () => {
  const fixture = uploadFixture();
  const chunk = validChunk();
  replay.upload(fixture.request(chunk));
  const ipBefore = fixture.store.map.get('replay:ip-bytes');
  const dailyBefore = fixture.store.map.get('replay:daily-bytes');
  const first = fixture.chunks[0];
  first.getString = key => String(first.data[key]);
  first.getFloat = key => Number(first.data[key]);
  first.getBool = key => !!first.data[key];
  assert.deepEqual(replay.upload(fixture.request(chunk)), { ok: true });
  assert.equal(fixture.chunks.length, 1);
  assert.equal(fixture.store.map.get('replay:ip-bytes'), ipBefore);
  assert.equal(fixture.store.map.get('replay:daily-bytes'), dailyBefore);
});

test('admin API checks authentication before querying data', () => {
  for (const action of ['getSettings', 'saveSettings', 'sessions', 'chunks', 'remove', 'eraseAccount']) {
    assert.throws(() => replay[action]({ hasSuperuserAuth: () => false }), { status: 401 });
  }
});

test('the room filter counts and lists with one case-insensitive exact token predicate', () => {
  globals();
  const rows = [];
  for (let i = 0; i < 35; i++) rows.push({ id: 'match' + String(i).padStart(10, '0'), rooms: '|LOBBY|ABCDE|', startedAt: now - i });
  rows.push({ id: 'lower', rooms: '|abcde|', startedAt: now });
  rows.push({ id: 'longer', rooms: '|ABCDEF|', startedAt: now });
  const seen = [];
  function matches(where, params, row) {
    for (const part of where.split(' AND ')) {
      if (part === '1 = 1') continue;
      if (part !== 'instr(upper(rooms), upper({:room})) > 0') throw new Error('Unexpected predicate ' + part);
      if (!row.rooms.toUpperCase().includes(params.room.toUpperCase())) return false;
    }
    return true;
  }
  const app = {
    db: () => ({ newQuery: sql => ({ bind: params => ({ one: result => {
      const where = sql.replace('SELECT COUNT(*) AS total FROM replay_sessions WHERE ', '');
      seen.push({ kind: 'count', where, params });
      result.total = rows.filter(row => matches(where, params, row)).length;
    } }) }) }),
    recordQuery: name => {
      assert.equal(name, 'replay_sessions');
      const query = { limit: 0, offset: 0 };
      const builder = {
        andWhere: exp => { query.exp = exp; return builder; },
        orderBy: (...columns) => { query.order = columns; return builder; },
        limit: value => { query.limit = value; return builder; },
        offset: value => { query.offset = value; return builder; },
        all: out => {
          seen.push({ kind: 'list', where: query.exp.sql, params: query.exp.params });
          const found = rows.filter(row => matches(query.exp.sql, query.exp.params, row)).sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
          for (const row of found.slice(query.offset, query.offset + query.limit)) out.push({ id: row.id, getString: key => key === 'rooms' ? row.rooms : '', getFloat: key => key === 'startedAt' ? row.startedAt : 0 });
          assert.deepEqual(query.order, ['startedAt DESC', 'id DESC']);
        },
      };
      return builder;
    },
  };
  global.$dbx = { exp: (sql, params) => ({ sql, params }) };
  global.arrayOf = () => [];
  const query = values => ({ get: key => values[key] || '' });
  const e = values => ({ app, hasSuperuserAuth: () => true, request: { url: { query: () => query(values) } } });
  const first = replay.sessions(e({ room: 'ABCDE' }));
  assert.equal(first.totalItems, 36);
  assert.equal(first.totalPages, 2);
  assert.equal(first.items.length, 30);
  const second = replay.sessions(e({ room: 'ABCDE', page: '2' }));
  assert.equal(second.items.length, 6);
  const lower = replay.sessions(e({ room: 'abcde' }));
  assert.equal(lower.totalItems, 36);
  assert.equal(lower.items.length, 30);
  assert.ok(!lower.items.some(item => item.id === 'longer'));
  for (const room of ['ABC%', 'abc_e']) {
    const wildcard = replay.sessions(e({ room }));
    assert.equal(wildcard.totalItems, 0);
    assert.equal(wildcard.items.length, 0);
  }
  assert.throws(() => replay.sessions(e({ room: 'A|B' })), { status: 400 });
  for (let i = 0; i < seen.length; i += 2) {
    assert.equal(seen[i].kind, 'count');
    assert.equal(seen[i + 1].kind, 'list');
    assert.equal(seen[i].where, seen[i + 1].where);
    assert.deepEqual(seen[i].params, seen[i + 1].params);
    assert.doesNotMatch(seen[i].where, /LIKE|~/);
  }
  assert.equal(seen[0].params.room, '|ABCDE|');
});

function eraseFixture(extra) {
  const sessions = new Map([['one', { id: 'one', account: 'alice', startedAt: now + 1 }], ['two', { id: 'two', account: 'alice', startedAt: now + 2 }], ['three', { id: 'three', account: 'bob', startedAt: now + 3 }]]);
  const chunks = new Map([['c1', 'one'], ['c2', 'two'], ['c3', 'three']]);
  for (const row of extra || []) {
    sessions.set(row.id, row);
    chunks.set('chunk-' + row.id, row.id);
  }
  const markers = new Map();
  const queries = [];
  const selected = (params, limit) => Array.from(sessions.values())
    .filter(row => params.account !== undefined ? row.account === params.account : row.startedAt < params.cutoff)
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
  const app = {
    runInTransaction: fn => fn(app),
    findCollectionByNameOrId: name => ({ name }),
    save: row => markers.set(row.key, row),
    findRecordsByFilter: (name, _where, sort, limit, _offset, params) => {
      if (name === 'replay_settings') return params && params.key ? Array.from(markers.values()).filter(row => row.key === params.key) : [];
      assert.equal(sort, 'startedAt,id');
      return selected(params, limit);
    },
    db: () => ({ newQuery: sql => ({ bind: params => ({
      one: result => { result.total = Array.from(sessions.values()).filter(row => row.account === params.account).length; },
      execute: () => {
        queries.push(sql);
        if (sql.startsWith('DELETE FROM replay_settings')) return;
        const ids = params.account === undefined ? Object.values(params) : null;
        if (ids) assert.match(sql, /IN \(\{:id0\}(, \{:id\d+\})*\)$/);
        if (sql.startsWith('DELETE FROM replay_chunks')) {
          for (const [key, session] of chunks) if (ids ? ids.includes(session) : sessions.get(session)?.account === params.account) chunks.delete(key);
        } else if (sql.startsWith('DELETE FROM replay_sessions')) {
          for (const [key, row] of sessions) if (ids ? ids.includes(key) : row.account === params.account) sessions.delete(key);
        } else if (!sql.startsWith('DELETE FROM replay_settings')) throw new Error('Unexpected SQL');
      },
    }) }) }),
  };
  global.DynamicModel = function (value) { Object.assign(this, value); };
  global.Record = function () { this.set = (key, value) => { this[key] = value; }; this.getString = key => this[key]; };
  global.$security = { sha256: hash, equal: (a, b) => a === b };
  return { app, sessions, chunks, markers, queries };
}

test('trusted erase key is required and repeated batches are idempotent', () => {
  const fixture = eraseFixture();
  const expected = 'erase-key-'.repeat(8);
  let configured = expected;
  let supplied = 'wrong';
  global.$os = { getenv: () => configured };
  global.$security = { sha256: hash, equal: (a, b) => a === b };
  global.readerToString = value => value;
  const e = { app: fixture.app, request: { body: JSON.stringify({ accountId: 'alice' }), header: { get: () => supplied } } };
  assert.throws(() => replay.forget(e), { status: 401 });
  assert.equal(fixture.sessions.size, 3);
  configured = '';
  assert.throws(() => replay.forget(e), { status: 503 });
  configured = expected;
  supplied = expected;
  assert.deepEqual(replay.forget(e), { ok: true, deletedSessions: 2, remainingSessions: 0 });
  assert.deepEqual(replay.forget(e), { ok: true, deletedSessions: 0, remainingSessions: 0 });
  assert.deepEqual(Array.from(fixture.sessions.keys()), ['three']);
  assert.deepEqual(Array.from(fixture.chunks.keys()), ['c3']);
  assert.equal(replay.isForgotten(fixture.app, 'alice'), true);
  assert.equal(replay.isForgotten(fixture.app, 'bob'), false);
  assert.equal(fixture.markers.size, 1);
  const marker = Array.from(fixture.markers.values())[0];
  assert.match(marker.key, /^erase:[a-f0-9]{58}$/);
  assert.ok(Number(marker.value) > Date.now() + 23 * 60 * 60 * 1000);
  marker.set('value', '1');
  assert.equal(replay.isForgotten(fixture.app, 'alice'), false);
});

test('account erasure removes up to 200 sessions per call, oldest first', () => {
  const extra = [];
  for (let i = 0; i < 448; i++) extra.push({ id: 'heavy' + String(i).padStart(10, '0'), account: 'carol', startedAt: 1000 + i });
  const fixture = eraseFixture(extra);
  assert.deepEqual(replay.eraseAccountBatch(fixture.app, 'carol', true), { ok: true, deletedSessions: 200, remainingSessions: 248 });
  assert.equal(fixture.sessions.has('heavy0000000199'), false);
  assert.equal(fixture.sessions.has('heavy0000000200'), true);
  assert.equal(fixture.chunks.has('chunk-heavy0000000199'), false);
  assert.equal(fixture.chunks.has('chunk-heavy0000000200'), true);
  assert.deepEqual(replay.eraseAccountBatch(fixture.app, 'carol', true), { ok: true, deletedSessions: 200, remainingSessions: 48 });
  assert.deepEqual(replay.eraseAccountBatch(fixture.app, 'carol', true), { ok: true, deletedSessions: 48, remainingSessions: 0 });
  assert.deepEqual(Array.from(fixture.sessions.keys()).sort(), ['one', 'three', 'two']);
  assert.equal(fixture.chunks.size, 3);
});

test('local account deletion erases replay before continuing and skips remote identities', () => {
  const fixture = eraseFixture();
  global.$os = { getenv: () => '' };
  let continued = false;
  replay.deleteLocalAccount({ app: fixture.app, record: { id: 'alice' }, next: () => {
    assert.deepEqual(Array.from(fixture.sessions.keys()), ['three']);
    assert.deepEqual(Array.from(fixture.chunks.keys()), ['c3']);
    continued = true;
  } });
  assert.equal(continued, true);
  global.$os = { getenv: () => 'https://main.example/api/collections/users/auth-refresh' };
  replay.deleteLocalAccount({ record: { id: 'bob' }, next: () => true });
  assert.equal(fixture.sessions.size, 1);
});

test('the retention sweep deletes whole expired sessions in batches of 20 within its time budget', () => {
  const day = 86400000;
  const extra = [];
  for (let i = 0; i < 45; i++) extra.push({ id: 'old' + String(i).padStart(12, '0'), account: '', startedAt: now - 20 * day + i });
  for (let i = 0; i < 3; i++) extra.push({ id: 'new' + String(i).padStart(12, '0'), account: '', startedAt: now - day });
  const fixture = eraseFixture(extra);
  const findSessions = fixture.app.findRecordsByFilter;
  const batches = [];
  fixture.app.findRecordsByFilter = (name, where, sort, limit, offset, params) => {
    if (name === 'replay_sessions') batches.push({ where, limit });
    return name === 'replay_settings' ? settingRows({ ...defaults, retention_days: 14 }) : findSessions(name, where, sort, limit, offset, params);
  };
  replay.sweep(fixture.app);
  assert.deepEqual(batches.map(batch => batch.limit), [20, 20, 20]);
  assert.equal(batches[0].where, 'startedAt < {:cutoff}');
  assert.deepEqual(Array.from(fixture.sessions.keys()).filter(id => id.startsWith('old')), []);
  assert.equal(Array.from(fixture.sessions.keys()).filter(id => id.startsWith('new')).length, 3);
  assert.equal(Array.from(fixture.chunks.values()).filter(id => id.startsWith('old')).length, 0);
  assert.ok(fixture.queries.some(sql => sql.startsWith("DELETE FROM replay_settings WHERE id IN (SELECT id FROM replay_settings WHERE key LIKE 'erase:%'")));
  assert.ok(fixture.sessions.has('one') && fixture.sessions.has('three'));
});

test('the retention sweep stops batching after about five seconds', () => {
  const extra = [];
  for (let i = 0; i < 100; i++) extra.push({ id: 'old' + String(i).padStart(12, '0'), account: '', startedAt: 10 + i });
  const fixture = eraseFixture(extra);
  const findSessions = fixture.app.findRecordsByFilter;
  const realNow = Date.now;
  let clock = realNow();
  fixture.app.findRecordsByFilter = (name, where, sort, limit, offset, params) => {
    if (name === 'replay_settings') return settingRows(defaults);
    clock += 3000;
    return findSessions(name, where, sort, limit, offset, params);
  };
  Date.now = () => clock;
  try { replay.sweep(fixture.app); } finally { Date.now = realNow; }
  assert.equal(Array.from(fixture.sessions.keys()).filter(id => id.startsWith('old')).length, 60);
});

test('REPLAY_TRUSTED_PROXY sets the trusted proxy header only when it differs', () => {
  let env = '';
  global.$os = { getenv: name => name === 'REPLAY_TRUSTED_PROXY' ? env : '' };
  const settings = { trustedProxy: { headers: [], useLeftmostIP: false }, rateLimits: { enabled: false } };
  let saves = 0;
  global.unmarshal = (data, dst) => { dst.trustedProxy = { ...dst.trustedProxy, ...data.trustedProxy }; };
  const app = { settings: () => settings, save: value => { assert.equal(value, settings); saves++; } };
  const warn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  try {
    assert.equal(replay.trustProxy(app), false);
    env = 'X-Forwarded-For, X-Real-IP';
    assert.equal(replay.trustProxy(app), false);
    assert.equal(warnings.length, 1);
    env = 'X-Forwarded-For';
    assert.equal(replay.trustProxy(app), true);
    assert.deepEqual(settings.trustedProxy, { headers: ['X-Forwarded-For'], useLeftmostIP: false });
    assert.equal(replay.trustProxy(app), false);
    settings.trustedProxy.useLeftmostIP = true;
    assert.equal(replay.trustProxy(app), true);
    assert.equal(settings.trustedProxy.useLeftmostIP, false);
    env = 'CF-Connecting-IP';
    assert.equal(replay.trustProxy(app), true);
    assert.deepEqual(settings.trustedProxy.headers, ['CF-Connecting-IP']);
    assert.equal(saves, 3);
    app.save = () => { throw new Error('validation failed'); };
    env = 'X-Forwarded-For';
    assert.equal(replay.trustProxy(app), false);
    assert.equal(warnings.length, 2);
    assert.equal(settings.rateLimits.enabled, false);
  } finally { console.warn = warn; }
});

test('migration adds only its collections and leaves unrelated data intact', () => {
  const sentinel = { id: 'sentinel', name: 'existing', fields: [{ name: 'title', type: 'text' }] };
  const collections = new Map([['existing', sentinel]]);
  const savedRows = [];
  let up, down;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_migrations/1795600000_replay.js'), 'utf8'), {
    migrate: (a, b) => { up = a; down = b; },
    Collection: function (data) { Object.assign(this, data, { id: data.name }); },
    Record: function (collection) { this.collection = collection.name; this.set = (key, value) => { this[key] = value; }; },
  });
  const app = {
    findCollectionByNameOrId: name => { if (!collections.has(name)) throw new Error('missing'); return collections.get(name); },
    save: item => item.name ? collections.set(item.name, item) : savedRows.push(item),
    delete: item => collections.delete(item.name),
  };
  up(app);
  assert.equal(collections.get('existing'), sentinel);
  assert.equal(collections.size, 4);
  for (const name of ['replay_settings', 'replay_sessions', 'replay_chunks']) {
    const collection = collections.get(name);
    for (const rule of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) assert.equal(collection[rule], null);
  }
  assert.equal(savedRows.length, 4);
  assert.throws(() => up(app), /already exists/);
  down(app);
  assert.equal(collections.size, 1);
  assert.equal(collections.get('existing'), sentinel);
});

function dedicatedMigration(rules, users) {
  const settings = { rateLimits: { enabled: false, rules, excludedIPs: [] }, trustedProxy: { headers: [], useLeftmostIP: false } };
  const saved = [];
  let up, down;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_migrations_dedicated/1795600001_replay_dedicated.js'), 'utf8'), {
    migrate: (a, b) => { up = a; down = b; },
    unmarshal: (data, dst) => {
      for (const key of Object.keys(data)) {
        dst[key] = data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]) ? { ...dst[key], ...JSON.parse(JSON.stringify(data[key])) } : data[key];
      }
    },
  });
  const app = {
    settings: () => settings,
    save: item => saved.push(item),
    findCollectionByNameOrId: name => { if (name !== 'users' || !users) throw new Error('missing'); return users; },
  };
  up(app);
  down(app);
  return { settings, saved };
}

test('dedicated migration turns the rate limiter on, keeps its rules, and closes public sign-up', () => {
  const live = [
    { label: '*:auth', audience: '', duration: 3, maxRequests: 2 },
    { label: '*:create', audience: '', duration: 5, maxRequests: 20 },
    { label: '/api/batch', audience: '', duration: 1, maxRequests: 3 },
    { label: '/api/', audience: '', duration: 10, maxRequests: 300 },
  ];
  const users = { name: 'users', type: 'auth', createRule: '' };
  const result = dedicatedMigration(live.map(rule => ({ ...rule })), users);
  assert.equal(result.settings.rateLimits.enabled, true);
  assert.deepEqual(result.settings.rateLimits.rules, live);
  assert.deepEqual(result.settings.rateLimits.excludedIPs, []);
  assert.equal(users.createRule, null);
  assert.deepEqual(result.saved, [result.settings, users]);

  const missing = dedicatedMigration(live.slice(1).map(rule => ({ ...rule })), null);
  assert.equal(missing.settings.rateLimits.enabled, true);
  assert.deepEqual(missing.settings.rateLimits.rules, [...live.slice(1), live[0]]);
  assert.deepEqual(missing.saved, [missing.settings]);
});

test('hook wiring loads handlers inside each isolated route and bounds upload bodies', () => {
  const routes = [];
  const crons = [];
  const bootstraps = [];
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_hooks/700_replay.pb.js'), 'utf8'), {
    routerAdd: (method, route, handler, middleware) => routes.push({ method, route, handler, middleware }),
    cronAdd: (name, schedule, handler) => crons.push({ name, schedule, handler }),
    onBootstrap: handler => bootstraps.push(handler),
    $apis: { bodyLimit: bytes => bytes },
    $os: { getenv: () => '' },
    onRecordDelete: () => {},
    __hooks: '/pb/pb_hooks',
    require: file => { calls.push('require ' + file); return { trustProxy: app => calls.push('trustProxy ' + app) }; },
  });
  assert.equal(routes.find(row => row.route === '/api/replay/chunks').middleware, 524288);
  assert.equal(routes.find(row => row.route === '/api/replay/start').middleware, 16384);
  const saveLimit = routes.find(row => row.method === 'POST' && row.route === '/api/replay/settings').middleware;
  assert.ok(saveLimit >= 2000 * 131 + 2 * 3 * 20000 + 1000 && saveLimit <= 512 * 1024, 'a full account list and both selector lists fit');
  for (const row of routes) assert.match(row.handler.toString(), /require\(`\$\{__hooks\}\/lib\/replay\.js`\)/);
  assert.equal(crons[0].schedule, '* * * * *');
  assert.equal(routes.some(row => row.route === '/dash/{path...}'), false);
  assert.equal(bootstraps.length, 1);
  assert.match(bootstraps[0].toString(), /require\(`\$\{__hooks\}\/lib\/replay\.js`\)/);
  bootstraps[0]({ app: 'app', next: () => calls.push('next') });
  assert.deepEqual(calls, ['next', 'require /pb/pb_hooks/lib/replay.js', 'trustProxy app']);
});
