const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../pb_hooks/lib/observability-core.js');
const observability = require('../pb_hooks/lib/observability.js');
const replay = require('../pb_hooks/lib/replay.js');
const hash = value => createHash('sha256').update(value).digest('hex');
const now = Date.now();

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const collections = new Map();
  const store = new Map();
  let sequence = 0;
  let tokens = 0;
  let depth = 0;
  class Row {
    constructor(collection, data) { this.collection = collection; this.data = data || {}; this.id = this.data.id || ''; }
    set(key, value) { this.data[key] = value; }
    getString(key) { return this.data[key] === undefined ? '' : String(this.data[key]); }
    getFloat(key) { return Number(this.data[key]) || 0; }
    getInt(key) { return this.getFloat(key); }
    getBool(key) { return !!this.data[key]; }
  }
  function statement(sql, params) {
    const prepared = database.prepare(sql.replace(/\{:(\w+)\}/g, '$$$1'));
    const bound = {};
    for (const [key, value] of Object.entries(params || {})) if (sql.includes('{:' + key + '}')) bound[key] = typeof value === 'boolean' ? Number(value) : value;
    return { prepared, bound };
  }
  function query(sql, params, all) {
    const { prepared, bound } = statement(sql, params);
    return all ? prepared.all(bound) : prepared.get(bound);
  }
  function records(name, where, sort, limit, offset, params) {
    const order = sort ? ' ORDER BY ' + sort.split(',').map(value => value.startsWith('-') ? value.slice(1) + ' DESC' : value + ' ASC').join(',') : '';
    return query('SELECT * FROM ' + name + ' WHERE ' + (where || '1=1').replace(/&&/g, ' AND ').replace(/\|\|/g, ' OR ') + order + ' LIMIT ' + (limit || 10000) + ' OFFSET ' + (offset || 0), params, true)
      .map(data => new Row(collections.get(name), data));
  }
  const app = {
    store: () => ({ get: key => store.get(key), set: (key, value) => store.set(key, value) }),
    findCollectionByNameOrId: name => { if (!collections.has(name)) throw new Error('Missing collection ' + name); return collections.get(name); },
    findRecordsByFilter: records,
    findRecordById: (name, id) => { const rows = records(name, 'id = {:id}', '', 1, 0, { id }); if (!rows.length) throw new Error('Not found'); return rows[0]; },
    findFirstRecordByData: (name, key, value) => { const rows = records(name, key + ' = {:value}', '', 1, 0, { value }); if (!rows.length) throw new Error('Not found'); return rows[0]; },
    findAuthRecordByToken: token => { if (token !== 'alice-token') throw new Error('Invalid auth'); return { id: 'alice', isSuperuser: () => false, getBool: () => false }; },
    runInTransaction: fn => {
      if (depth) return fn(app);
      database.exec('BEGIN'); depth++;
      try { const result = fn(app); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } finally { depth--; }
    },
    save: item => {
      if (item.fields) {
        item.id = item.name;
        const fields = item.fields.map(field => {
          const relation = field.type === 'relation' ? ' REFERENCES ' + field.collectionId + '(id)' + (field.cascadeDelete ? ' ON DELETE CASCADE' : '') : '';
          return field.name + ' ' + (['number', 'bool'].includes(field.type) ? 'INTEGER DEFAULT 0' : 'TEXT DEFAULT \'\'') + relation;
        });
        database.exec('CREATE TABLE ' + item.name + '(id TEXT PRIMARY KEY,' + fields.join(',') + ')');
        for (const index of item.indexes || []) database.exec(index);
        collections.set(item.name, item);
        return;
      }
      if (!item.id) item.id = String(++sequence).padStart(15, '0');
      item.data.id = item.id;
      const validFields = new Set(item.collection.fields.map(field => field.name).concat('id'));
      const entries = Object.entries(item.data).filter(([key]) => validFields.has(key));
      const fields = entries.map(([key]) => key);
      database.prepare('INSERT INTO ' + item.collection.name + '(' + fields.join(',') + ') VALUES (' + fields.map(() => '?').join(',') + ') ON CONFLICT(id) DO UPDATE SET ' + fields.map(key => key + '=excluded.' + key).join(','))
        .run(...entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value));
    },
    delete: item => {
      if (item.fields) { database.exec('DROP TABLE ' + item.name); collections.delete(item.name); return; }
      database.prepare('DELETE FROM ' + item.collection.name + ' WHERE id=?').run(item.id);
    },
    db: () => ({ newQuery: sql => {
      const bound = params => ({
        one: result => Object.assign(result, query(sql, params)),
        all: rows => { for (const data of query(sql, params, true)) rows.push(Object.assign(new global.DynamicModel({}), data)); },
        execute: () => { const { prepared, bound: values } = statement(sql, params); return prepared.run(values); },
      });
      return Object.assign(bound({}), { bind: bound });
    } }),
    settings: () => ({ meta: { appURL: 'https://replay.test/' } }),
    recordQuery: name => {
      let predicate = { sql: '1=1', params: {} }; let order; let limit; let offset;
      const result = {
        andWhere: value => { predicate = value; return result; },
        orderBy: (...values) => { order = values.join(','); return result; },
        limit: value => { limit = value; return result; },
        offset: value => { offset = value; return result; },
        all: destination => {
          for (const data of query('SELECT * FROM ' + name + ' WHERE ' + predicate.sql + ' ORDER BY ' + order + ' LIMIT ' + limit + ' OFFSET ' + offset, predicate.params, true)) destination.push(new Row(collections.get(name), data));
        },
      };
      return result;
    },
  };
  global.Record = Row;
  global.DynamicModel = function (value) { Object.assign(this, value); };
  global.arrayOf = () => [];
  global.$dbx = { exp: (sql, params) => ({ sql, params }) };
  global.$security = { sha256: hash, equal: (a, b) => a === b, randomString: length => String(++tokens).padStart(length, 'r') };
  global.$os = { getenv: () => '' };
  global.readerToString = value => value;
  const webhooks = [];
  let webhookStatus = 200;
  global.$http = { send: request => { webhooks.push({ ...request, body: JSON.parse(request.body) }); if (webhookStatus instanceof Error) throw webhookStatus; return { statusCode: webhookStatus }; } };
  function migrate(file) {
    let up;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_migrations', file), 'utf8'), {
      migrate: value => { up = value; }, Collection: function (value) { Object.assign(this, value); }, Record: Row, console,
    });
    up(app);
  }
  migrate('1795600000_replay.js');
  migrate('1795600002_observability.js');
  const event = (body, queryValues, id, authenticated = true) => ({
    app, hasSuperuserAuth: () => authenticated, realIP: () => '127.0.0.1',
    request: { body: JSON.stringify(body || {}), pathValue: () => id || '', url: { query: () => ({ get: key => (queryValues || {})[key] || '' }) } },
  });
  const metadata = { deviceId: 'device', accountId: 'alice', authToken: 'alice-token', platform: 'web', appVersion: '1.0' };
  function enable(value) { return observability.saveSettings(event({ errors_enabled: true, logs_enabled: true, ...value })); }
  function token() { return observability.publicConfig(event(metadata)).token; }
  return {
    app, event, metadata, enable, token, database, collections, records, store, webhooks,
    webhookAnswers: value => { webhookStatus = value; }, close: () => database.close(),
  };
}

function exception(id, patch) {
  return { id, timestamp: now, type: 'TypeError', message: 'Cannot load item 42', stack: 'TypeError: Cannot load item 42\n    at render (https://app.test/app.js:12:2)', service: 'client', ...patch };
}

test('capture settings are independent, default off, and corrupt settings fail closed', () => {
  const f = fixture();
  assert.deepEqual(observability.config(f.app), core.DEFAULTS);
  assert.equal(observability.publicConfig(f.event(f.metadata)).enabled, false);
  assert.equal(observability.saveSettings(f.event({ logs_enabled: true })).errors_enabled, false);
  const config = observability.publicConfig(f.event(f.metadata));
  assert.equal(config.logsEnabled, true);
  assert.equal(config.errorsEnabled, false);
  const row = f.app.findFirstRecordByData('replay_settings', 'key', 'observability');
  row.set('value', '{broken'); f.app.save(row);
  assert.deepEqual(observability.config(f.app), core.DEFAULTS);
  for (const patch of [{ errors_enabled: 'true' }, { logs_retention_days: 0 }, { errors_retention_days: 366 }, { daily_limit_mb: 0 }]) assert.throws(() => core.settings({ ...core.DEFAULTS, ...patch }), { status: 400 });
  f.close();
});

test('tokens reuse verified metadata, do not disclose accounts, expire, and honor erasure', () => {
  const f = fixture(); f.enable();
  assert.throws(() => observability.publicConfig(f.event({ ...f.metadata, authToken: 'bad' })), { status: 401 });
  const first = observability.publicConfig(f.event(f.metadata));
  const second = observability.publicConfig(f.event({ ...f.metadata, token: first.token }));
  assert.equal(first.token, second.token);
  assert.equal(f.records('replay_observability_sessions').length, 1);
  assert.equal(first.expiresAt, second.expiresAt);
  const row = f.app.findFirstRecordByData('replay_observability_sessions', 'tokenHash', hash(first.token));
  assert.equal(row.getString('tokenHash'), hash(first.token));
  assert.ok(!Object.values(row.data).includes(first.token));
  row.set('expiresAt', 1); f.app.save(row);
  assert.throws(() => observability.errors(f.event({ token: first.token, events: [exception('a')] })), { status: 410 });
  replay.eraseAccountBatch(f.app, 'alice', true);
  assert.equal(observability.publicConfig(f.event(f.metadata)).enabled, false);
  assert.equal(f.records('replay_observability_sessions').length, 0);
  f.close();
});

test('errors group by normalized frames, dedupe retries, alert once, and reopen resolved issues', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const upload = events => observability.errors(f.event({ token, events }));
  assert.deepEqual(upload([exception('first'), exception('second', { message: 'Cannot load item 99', stack: 'TypeError: Cannot load item 99\n    at render (https://app.test/app.js:300:8)' })]), { ok: true, accepted: 2, duplicates: 0, conflicts: 0 });
  assert.deepEqual(upload([exception('first')]), { ok: true, accepted: 0, duplicates: 1, conflicts: 0 });
  const issues = observability.issues(f.event());
  assert.equal(issues.totalItems, 1);
  assert.equal(issues.items[0].occurrenceCount, 2);
  assert.equal(observability.alerts(f.event()).totalItems, 1);
  const id = issues.items[0].id;
  const resolved = observability.updateIssue(f.event({ status: 'resolved' }, {}, id));
  assert.ok(resolved.resolvedAt >= now);
  // Captured before the fix and delivered late, by a device that was offline: still resolved, no alert.
  upload([exception('late', { timestamp: now - 60000 })]);
  assert.equal(observability.issue(f.event({}, {}, id)).issue.status, 'resolved');
  assert.equal(observability.alerts(f.event()).totalItems, 1);
  upload([exception('third', { timestamp: resolved.resolvedAt + 1000 })]);
  assert.equal(observability.issue(f.event({}, {}, id)).issue.status, 'open');
  const alerts = observability.alerts(f.event());
  assert.deepEqual(alerts.items.map(item => item.kind), ['regressed', 'created']);
  const alert = observability.acknowledge(f.event({}, {}, alerts.items[0].id));
  assert.equal(alert.acknowledged, true);
  observability.updateIssue(f.event({ status: 'ignored' }, {}, id));
  upload([exception('fourth', { timestamp: resolved.resolvedAt + 2000 })]);
  assert.equal(observability.issue(f.event({}, {}, id)).issue.status, 'ignored');
  assert.equal(observability.alerts(f.event()).totalItems, 2);
  // A reused ID with other content is counted and skipped; the rest of its batch is still stored.
  assert.deepEqual(upload([exception('first', { message: 'changed' }), exception('fifth')]), { ok: true, accepted: 1, duplicates: 0, conflicts: 1 });
  f.close();
});

test('logs store structured redacted data and filter literal search, severity, service, dates and identities', () => {
  const f = fixture(); f.enable(); const token = f.token();
  observability.logsUpload(f.event({ token, events: [
    { id: 'warn', timestamp: now, level: 'warn', service: 'network', message: 'Retry token=private alice@example.com https://alice:password@app.test/path?token=private#private', attributes: { token: 'private', nested: { authorization: 'private', code: 'E_42', route: 'https://app.test/path?secret=private' } } },
    { id: 'debug', timestamp: now - 1000, level: 'debug', service: 'client', message: 'Completed', attributes: { code: 'E_41' } },
  ] }));
  const filtered = observability.logs(f.event({}, { q: 'e_42', level: 'warn', service: 'network', accountId: 'alice', deviceId: 'device', from: String(now - 10), to: String(now + 10) }));
  assert.equal(filtered.totalItems, 1);
  const log = observability.log(f.event({}, {}, filtered.items[0].id));
  assert.doesNotMatch(JSON.stringify(log), /private|alice@example.com|alice:password/);
  assert.equal(log.attributes.token, '[redacted]');
  assert.equal(log.attributes.nested.code, 'E_42');
  assert.equal(log.replayAvailable, false);
  assert.equal(observability.logs(f.event({}, { q: '%' })).totalItems, 0);
  assert.equal(observability.logs(f.event({}, { account: 'bob' })).totalItems, 0);
  assert.throws(() => observability.logs(f.event({}, { level: 'unknown' })), { status: 400 });
  f.close();
});

test('custom sender content redacts quoted JSON credentials and API keys before persistence', () => {
  const f = fixture(); f.enable();
  const token = observability.publicConfig(f.event({ ...f.metadata, room: 'token=private-room' })).token;
  const message = '{"token":"private-secret", "api_key":"private-api", "password":"private-password"}';
  observability.logsUpload(f.event({ token, events: [{ id: 'quoted', timestamp: now, message, attributes: { apiKey: 'private-key' } }] }));
  const log = observability.logs(f.event()).items[0];
  assert.doesNotMatch(JSON.stringify(log), /private-secret|private-api|private-password|private-key|private-room/);
  assert.doesNotMatch(JSON.stringify(f.records('replay_observability_sessions')[0].data), /private-room/);
  assert.equal(log.attributes.apiKey, '[redacted]');
  assert.doesNotMatch(core.redact('{"token":"escaped\\\"private-secret"}'), /private-secret/);
  f.close();
});

test('batches are atomic, bounded, and require both client credentials and enabled server features', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const good = { id: 'good', timestamp: now, message: 'Completed' };
  assert.throws(() => observability.logsUpload(f.event({ token: 'x'.repeat(64), events: [good] })), { status: 401 });
  assert.throws(() => observability.logsUpload(f.event({ token, events: [good, { ...good, id: 'bad', level: 'unknown' }] })), { status: 400 });
  assert.equal(f.records('replay_logs').length, 0);
  assert.throws(() => observability.logsUpload(f.event({ token, events: Array.from({ length: 21 }, (_, i) => ({ ...good, id: String(i) })) })), { status: 400 });
  assert.throws(() => core.event({ ...good, attributes: { data: 'x'.repeat(4097) } }, 'log', now), { status: 413 });
  assert.throws(() => core.event({ ...good, sessionId: 'a'.repeat(15) }, 'log', now), { status: 400 });
  assert.equal(core.batch({ token, events: ['toString', 'constructor', '__proto__'].map(id => ({ ...good, id })) }, 'log', now).events.length, 3);
  f.enable({ logs_enabled: false });
  assert.throws(() => observability.logsUpload(f.event({ token, events: [good] })), { status: 403 });
  assert.equal(observability.errors(f.event({ token, events: [exception('error')] })).accepted, 1);
  f.close();
});

test('custom retries keep their identity when a reused context changes its fallback room', () => {
  const f = fixture(); f.enable();
  const token = observability.publicConfig(f.event({ ...f.metadata, room: 'room-A' })).token;
  const event = { id: 'custom', timestamp: now, message: 'Completed' };
  assert.equal(observability.logsUpload(f.event({ token, events: [event] })).accepted, 1);
  assert.equal(observability.publicConfig(f.event({ ...f.metadata, token, room: 'room-B' })).token, token);
  assert.equal(observability.logsUpload(f.event({ token, events: [event] })).duplicates, 1);
  observability.logsUpload(f.event({ token, events: [{ ...event, id: 'later' }] }));
  const logs = observability.logs(f.event()).items;
  assert.equal(logs.find(item => item.id === f.records('replay_logs', "eventId = 'custom'")[0].id).room, 'room-A');
  assert.equal(f.records('replay_logs', "eventId = 'later'")[0].getString('room'), 'room-B');
  f.close();
});

test('session links need the recording secret, a failed link keeps the entry, and deleting a recording keeps diagnostics', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const row = new Record(f.app.findCollectionByNameOrId('replay_sessions'));
  row.set('accountId', 'alice'); row.set('deviceId', 'device'); row.set('tokenHash', hash('s'.repeat(64))); row.set('chunkCount', 1); f.app.save(row);
  const event = exception('linked', { sessionId: row.id, sessionToken: 's'.repeat(64) });
  assert.equal(observability.errors(f.event({ token, events: [{ ...event, id: 'forged', sessionToken: 't'.repeat(64) }] })).accepted, 1);
  assert.equal(f.records('replay_errors', "eventId = 'forged'")[0].getString('sessionId'), '');
  observability.errors(f.event({ token, events: [event] }));
  observability.logsUpload(f.event({ token, events: [{ id: 'log', timestamp: now, message: 'Linked', sessionId: row.id, sessionToken: 's'.repeat(64) }] }));
  const issue = observability.issues(f.event()).items[0];
  assert.equal(observability.issue(f.event({}, { sessionId: row.id }, issue.id)).items[0].replayAvailable, true);
  assert.equal(observability.issues(f.event({}, { sessionId: row.id })).totalItems, 1);
  assert.equal(f.records('replay_errors', "eventId = 'linked'")[0].getString('sessionToken'), '');
  replay.remove(f.event({}, {}, row.id));
  assert.equal(f.records('replay_errors').length, 2);
  assert.equal(f.records('replay_logs').length, 1);
  assert.equal(observability.logs(f.event({}, { sessionId: row.id })).items[0].replayAvailable, false);
  // An entry queued before the recording was deleted still arrives, without its link, and its batch is not refused.
  const late = observability.logsUpload(f.event({ token, events: [
    { id: 'unrelated', timestamp: now, message: 'Unrelated' },
    { id: 'late-link', timestamp: now, message: 'Late', sessionId: row.id, sessionToken: 's'.repeat(64) },
  ] }));
  assert.equal(late.accepted, 2);
  assert.equal(f.records('replay_logs', "eventId = 'late-link'")[0].getString('sessionId'), '');
  f.close();
});

test('account erasure preserves other accounts and replaces summaries that came from deleted events', () => {
  const f = fixture(); f.enable(); const alice = f.token();
  const bob = observability.publicConfig(f.event({ deviceId: 'bob-device', platform: 'web' })).token;
  observability.errors(f.event({ token: bob, events: [exception('bob', { message: 'Bob message', timestamp: now - 10 })] }));
  observability.errors(f.event({ token: alice, events: [exception('alice', { message: 'Alice private message' })] }));
  observability.logsUpload(f.event({ token: alice, events: [{ id: 'alice-log', timestamp: now, message: 'Private message' }] }));
  const result = replay.eraseAccount(f.event({}, {}, 'alice'));
  assert.deepEqual(result, { ok: true, deletedSessions: 0, remainingSessions: 0, deletedErrors: 1, deletedLogs: 1, remainingErrors: 0, remainingLogs: 0 });
  const issue = observability.issues(f.event()).items[0];
  assert.equal(issue.occurrenceCount, 1);
  assert.equal(issue.message, 'Bob message');
  assert.equal(observability.alerts(f.event()).items[0].title, 'TypeError: Bob message');
  assert.throws(() => observability.errors(f.event({ token: alice, events: [exception('again')] })), { status: 401 });
  // Like recordings, a dashboard deletion does not block the account; the trusted erase route does.
  assert.equal(observability.publicConfig(f.event(f.metadata)).enabled, true);
  replay.eraseAccountBatch(f.app, 'alice', true);
  assert.equal(observability.publicConfig(f.event(f.metadata)).enabled, false);
  f.close();
});

test('daily budgets use durable bytes, retries are free, alerts can be disabled, and retention is independent', () => {
  const f = fixture(); f.enable({ alerts_enabled: false, daily_limit_mb: 1, errors_retention_days: 30, logs_retention_days: 1 }); const token = f.token();
  observability.errors(f.event({ token, events: [exception('first')] }));
  assert.equal(observability.alerts(f.event()).totalItems, 0);
  const stored = f.records('replay_errors')[0]; stored.set('byteSize', 1024 * 1024); f.app.save(stored);
  // The sum is cached for a minute, so a change made behind its back is only seen after that.
  assert.equal(observability.errors(f.event({ token, events: [exception('cached')] })).accepted, 1);
  f.store.delete('observability:daily-bytes');
  assert.equal(observability.errors(f.event({ token, events: [exception('first')] })).duplicates, 1);
  assert.throws(() => observability.errors(f.event({ token, events: [exception('blocked')] })), { status: 429 });
  assert.equal(f.records('replay_errors').length, 2);
  f.records('replay_errors', "eventId = 'cached'").forEach(row => f.app.delete(row));
  f.store.delete('observability:daily-bytes');
  f.enable({ daily_limit_mb: 64 });
  observability.logsUpload(f.event({ token, events: [{ id: 'old', timestamp: now - 2 * 86400000, message: 'Expired' }] }));
  const log = f.records('replay_logs')[0]; log.set('receivedAt', now - 2 * 86400000); f.app.save(log);
  stored.set('receivedAt', now - 2 * 86400000); f.app.save(stored);
  observability.sweep(f.app);
  assert.equal(f.records('replay_logs').length, 0);
  assert.equal(f.records('replay_errors').length, 1);
  stored.set('receivedAt', now - 31 * 86400000); f.app.save(stored);
  observability.sweep(f.app);
  assert.equal(f.records('replay_errors').length, 0);
  assert.equal(f.records('replay_issues').length, 0);
  f.close();
});

test('stored byte accounting includes Unicode summaries and alerts rather than assuming one byte per character', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const message = '😀'.repeat(900);
  observability.errors(f.event({ token, events: [exception('unicode', { message })] }));
  const row = f.records('replay_errors')[0];
  const issue = observability.issues(f.event()).items[0];
  const alert = observability.alerts(f.event()).items[0];
  const minimum = core.bytes(JSON.stringify({ message })) + core.bytes(JSON.stringify(issue)) + core.bytes(JSON.stringify(alert));
  assert.ok(row.getInt('byteSize') >= minimum);
  assert.equal(core.bytes(message), 3600);
  f.close();
});

test('per-IP request limits and per-device context creation stay bounded, and a full IP map keeps serving', () => {
  const f = fixture(); f.enable();
  const firstToken = f.token();
  for (let i = 1; i < 30; i++) f.token();
  assert.throws(() => f.token(), { status: 429, message: 'Too many observability sessions' });
  assert.equal(f.records('replay_observability_sessions').length, 30);
  for (let i = 0; i < 120 - 31; i++) assert.equal(observability.publicConfig(f.event({ ...f.metadata, token: firstToken })).token, firstToken);
  assert.throws(() => observability.publicConfig(f.event({ ...f.metadata, token: firstToken })), { status: 429, message: 'Too many observability requests' });
  assert.equal(f.records('replay_observability_sessions').length, 30);
  const keys = {};
  for (let i = 0; i < 4096; i++) keys['config:ip' + i] = 1;
  f.store.set('observability:requests', JSON.stringify({ minute: Math.floor(Date.now() / 60000), keys }));
  const other = { ...f.event({ ...f.metadata, deviceId: 'other-device' }), realIP: () => '10.0.0.9' };
  assert.equal(observability.publicConfig(other).enabled, true);
  f.close();
});

test('all observability read and management routes require superuser authentication before touching data', () => {
  for (const name of ['getSettings', 'saveSettings', 'issues', 'issue', 'updateIssue', 'removeIssue', 'logs', 'log', 'volume', 'removeLog', 'alerts', 'acknowledge', 'removeAlert', 'testAlert']) {
    assert.throws(() => observability[name]({ hasSuperuserAuth: () => false }), { status: 401 }, name);
    assert.throws(() => observability[name]({ hasSuperuserAuth: () => false, auth: { id: 'user' } }), { status: 403 }, name);
  }
});

test('migration keeps collections private and hook wiring caps ingest bodies', () => {
  const f = fixture();
  for (const name of ['replay_observability_sessions', 'replay_issues', 'replay_errors', 'replay_logs', 'replay_alerts']) {
    const collection = f.collections.get(name);
    for (const key of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) assert.equal(collection[key], null);
  }
  const routes = []; const crons = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pb_hooks/710_observability.pb.js'), 'utf8'), {
    routerAdd: (method, route, handler, limit) => routes.push({ method, route, handler, limit }),
    cronAdd: (name, schedule) => crons.push({ name, schedule }), $apis: { bodyLimit: value => value },
  });
  for (const route of ['/api/replay/errors', '/api/replay/logs']) assert.equal(routes.find(row => row.route === route && row.method === 'POST').limit, 65536);
  for (const route of ['/api/replay/logs/volume', '/api/replay/alerts/test']) assert.ok(routes.some(row => row.route === route), route);
  for (const route of routes) assert.match(route.handler.toString(), /require\(`\$\{__hooks\}\/lib\/observability\.js`\)/);
  assert.equal(crons[0].schedule, '* * * * *');
  f.close();
});

test('a refresh slides a live credential forward, writing it at most every ten minutes', () => {
  const f = fixture(); f.enable();
  const first = observability.publicConfig(f.event(f.metadata));
  const row = () => f.records('replay_observability_sessions')[0];
  // Nine minutes in: still fresh enough, so nothing is written.
  row().set('expiresAt', first.expiresAt - 9 * 60000); f.app.save(Object.assign(row(), { data: { ...row().data, expiresAt: first.expiresAt - 9 * 60000 } }));
  const quiet = observability.publicConfig(f.event({ ...f.metadata, token: first.token }));
  assert.equal(quiet.token, first.token);
  assert.equal(row().getFloat('expiresAt'), first.expiresAt - 9 * 60000);
  // Eleven minutes in: the same credential gets a full four hours again.
  const stale = row(); stale.set('expiresAt', Date.now() + core.LIMITS.contextMs - 11 * 60000); f.app.save(stale);
  const renewed = observability.publicConfig(f.event({ ...f.metadata, token: first.token }));
  assert.equal(renewed.token, first.token);
  assert.ok(renewed.expiresIn > core.LIMITS.contextMs - 1000);
  assert.equal(f.records('replay_observability_sessions').length, 1);
  // A changed app version is saved on the same credential.
  observability.publicConfig(f.event({ ...f.metadata, appVersion: '2.0', token: first.token }));
  assert.equal(row().getString('appVersion'), '2.0');
  f.close();
});

test('redaction never pushes a field past its stored limit', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const message = 'x'.repeat(4096 - ' token=a a@b.co'.length) + ' token=a a@b.co';
  assert.equal(message.length, 4096);
  assert.equal(observability.logsUpload(f.event({ token, events: [{ id: 'full', timestamp: now, message }] })).accepted, 1);
  const stored = f.records('replay_logs')[0].getString('message');
  assert.equal(stored.length, 4096);
  assert.doesNotMatch(stored, /token=a\b|a@b\.co/);
  const event = core.event({ id: 'e', timestamp: now, message: 'm', name: 'a@b.co'.repeat(21), stack: 's'.repeat(8186) + ' a@b.c', service: 'x@y.zz'.repeat(21) }, 'error', now);
  assert.ok(event.name.length <= 128 && event.service.length <= 128 && event.stack.length <= 8192);
  f.close();
});

test('issue grouping survives platform origins, build hashes and engines, and minified frames fall back to the message', () => {
  const hashText = value => hash(value);
  const chrome = 'TypeError: x is undefined\n    at renderBoard (https://localhost/assets/index-BHg5Ehe4.js:1:2345)\n    at async loadGame (https://localhost/assets/index-BHg5Ehe4.js:1:999)\n    at Array.forEach (<anonymous>)';
  const safari = 'renderBoard@capacitor://localhost/assets/index-Qx81_a-Z.js:1:2001\nloadGame@capacitor://localhost/assets/index-Qx81_a-Z.js:1:700\nforEach@[native code]';
  assert.deepEqual(core.frames(chrome), ['renderBoard@/assets/index.js', 'loadGame@/assets/index.js']);
  assert.deepEqual(core.frames(safari), core.frames(chrome));
  const base = { service: 'game', name: 'TypeError', message: 'x is undefined' };
  assert.equal(core.fingerprint({ ...base, stack: chrome }, hashText), core.fingerprint({ ...base, stack: safari }, hashText));
  assert.equal(core.fingerprint({ ...base, stack: chrome }, hashText), core.fingerprint({ ...base, message: 'other text', stack: chrome }, hashText));
  assert.deepEqual(core.frames('Error: a@b failed\n    at main.3f2a1b9c.chunk.js:1:2'), ['?@main.chunk.js']);
  // Minified: every frame is "?@index.js", so different messages are different issues and changing ids are not.
  const minified = 'Error: m\n    at Ze (https://localhost/assets/index-AAAAAAAA.js:1:1)\n    at Qt (https://localhost/assets/index-AAAAAAAA.js:1:9)';
  const nextBuild = minified.replace(/AAAAAAAA/g, 'BBBBBBBB').replace('Ze', 'Xa').replace('Qt', 'Lp');
  const of = (message, stack) => core.fingerprint({ ...base, name: 'Error', message, stack }, hashText);
  assert.equal(of('Record k3x9a8b7c6d5e4f not found (404)', minified), of('Record q1w2e3r4t5y6u7i not found (500)', nextBuild));
  assert.notEqual(of('Socket closed', minified), of('Wallet refused', minified));
  assert.equal(of('Request 3f2a1b9c-0000-4000-8000-1234567890ab failed', minified), of('Request 9a8b7c6d-1111-4222-8333-abcdefabcdef failed', minified));
});

test('alerts reach a webhook once per minute, in the format the service reads, and give up after ten failures', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const upload = (id, patch) => observability.errors(f.event({ token, events: [exception(id, patch)] }));
  upload('no-hook');
  assert.equal(observability.alerts(f.event()).items[0].delivery, 'none');
  assert.throws(() => observability.saveSettings(f.event({ alert_webhook_url: 'https://user:pass@hooks.test/x' })), { status: 400 });
  assert.throws(() => observability.saveSettings(f.event({ alert_webhook_url: 'ftp://hooks.test/x' })), { status: 400 });
  observability.saveSettings(f.event({ alert_webhook_url: 'https://hooks.test/alerts?key=1' }));
  // An older dashboard that leaves the address out keeps it.
  assert.equal(observability.saveSettings(f.event({ errors_enabled: true, logs_enabled: true })).alert_webhook_url, 'https://hooks.test/alerts?key=1');
  upload('first-new', { name: 'RangeError', stack: 'RangeError: a\n    at one (https://app.test/a.js:1:1)\n    at two (https://app.test/a.js:2:2)' });
  upload('second-new', { name: 'SyntaxError', stack: 'SyntaxError: b\n    at three (https://app.test/b.js:1:1)\n    at four (https://app.test/b.js:2:2)' });
  observability.sweep(f.app);
  assert.equal(f.webhooks.length, 1);
  assert.equal(f.webhooks[0].url, 'https://hooks.test/alerts?key=1');
  assert.equal(f.webhooks[0].body.alerts.length, 2);
  assert.match(f.webhooks[0].body.text, /^New issue: RangeError: Cannot load item 42\nNew issue: SyntaxError: Cannot load item 42\nhttps:\/\/replay\.test\/dash\/replay$/);
  assert.deepEqual(observability.alerts(f.event()).items.map(item => item.delivery).sort(), ['none', 'sent', 'sent']);
  observability.sweep(f.app);
  assert.equal(f.webhooks.length, 1);

  f.webhookAnswers(500);
  upload('failing', { name: 'EvalError', stack: 'EvalError: c\n    at five (https://app.test/c.js:1:1)\n    at six (https://app.test/c.js:2:2)' });
  for (let i = 0; i < 9; i++) observability.sweep(f.app);
  assert.equal(f.records('replay_alerts', "delivery = 'pending'").length, 1);
  f.webhookAnswers(new Error('connection refused'));
  observability.sweep(f.app);
  assert.equal(f.records('replay_alerts', "delivery = 'failed'").length, 1);
  assert.equal(f.webhooks.length, 11);

  f.webhookAnswers(200);
  for (const [url, shape] of [['https://discord.com/api/webhooks/1/x', ['content']], ['https://hooks.slack.com/services/T/B/x', ['text']], ['https://chat.googleapis.com/v1/spaces/x', ['text']]]) {
    assert.deepEqual(observability.testAlert(f.event({ alert_webhook_url: url })), { ok: true });
    assert.deepEqual(Object.keys(f.webhooks.at(-1).body), shape, url);
  }
  assert.match(f.webhooks.at(-1).body.text, /^Test alert: /);
  f.webhookAnswers(404);
  assert.throws(() => observability.testAlert(f.event({ alert_webhook_url: 'https://hooks.test/missing' })), { status: 502 });
  observability.saveSettings(f.event({ alert_webhook_url: '' }));
  assert.throws(() => observability.testAlert(f.event({})), { status: 400 });
  // Alerts still waiting when the address is removed have nowhere to go.
  f.app.db().newQuery("UPDATE replay_alerts SET delivery = 'pending'").execute();
  observability.sweep(f.app);
  assert.equal(f.records('replay_alerts', "delivery = 'pending'").length, 0);
  f.close();
});

test('log volume counts each level per time bucket for the same filters as the list', () => {
  const f = fixture(); f.enable(); const token = f.token();
  const start = now - 60 * 60000;
  const events = [
    { id: 'a', timestamp: start, level: 'info', message: 'boot' },
    { id: 'b', timestamp: start + 30000, level: 'info', message: 'boot' },
    { id: 'c', timestamp: start + 30 * 60000, level: 'warn', message: 'slow' },
    { id: 'd', timestamp: start + 60 * 60000, level: 'error', message: 'failed' },
    { id: 'e', timestamp: start + 60 * 60000, level: 'error', message: 'other', service: 'api' },
  ];
  observability.logsUpload(f.event({ token, events }));
  const all = observability.volume(f.event({}, {}));
  assert.equal(all.total, 5);
  // An hour is 60 one-minute buckets, which is not under 60, so it gets five-minute ones.
  assert.equal(all.bucketMs, 300000);
  assert.equal(all.from, start);
  assert.equal(all.buckets.length, 13);
  assert.deepEqual(all.buckets[0].counts, { info: 2 });
  assert.deepEqual(all.buckets[6].counts, { warn: 1 });
  assert.deepEqual(all.buckets[12].counts, { error: 2 });
  assert.equal(all.buckets.reduce((sum, bucket) => sum + Object.values(bucket.counts).reduce((a, b) => a + b, 0), 0), 5);
  const filtered = observability.volume(f.event({}, { service: 'api' }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.buckets.length, 1);
  const day = observability.volume(f.event({}, { from: String(start - 12 * 3600000), to: String(start + 12 * 3600000) }));
  assert.equal(day.bucketMs, 1800000);
  assert.ok(day.buckets.length <= 61);
  assert.equal(observability.volume(f.event({}, { level: 'fatal' })).buckets.length, 0);
  f.close();
});
