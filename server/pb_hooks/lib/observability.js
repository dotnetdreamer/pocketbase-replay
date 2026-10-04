const base = require('./replay-core.js');
const core = require('./observability-core.js');
const replay = require('./replay.js');
const security = require('./ingestion-security.js');

const VOLUME_STEPS = [60000, 300000, 900000, 1800000, 3600000, 10800000, 21600000, 43200000, 86400000, 604800000];

function readBody(e) {
  let raw;
  try { raw = readerToString(e.request.body); } catch (_) { base.fail(400, 'Unreadable body'); }
  if (!raw || core.bytes(raw) > core.LIMITS.envelopeBytes) base.fail(413, 'Body is too large');
  try { return base.object(JSON.parse(raw)); } catch (error) {
    if (error.status) throw error;
    base.fail(400, 'Invalid JSON');
  }
}

function config(app) {
  let value = Object.assign({}, core.DEFAULTS);
  try {
    const rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: 'observability' });
    if (rows.length) value = Object.assign(value, base.object(JSON.parse(rows[0].getString('value'))));
    return core.settings(value);
  } catch (_) {
    // Collection stays off; values that are still valid survive, so the next dashboard save does not wipe them.
    const fallback = Object.assign({}, core.DEFAULTS);
    for (const key of ['errors_retention_days', 'logs_retention_days', 'daily_limit_mb', 'sessions_per_device_hour', 'sessions_per_ip_hour', 'sessions_per_hour', 'config_requests_per_ip_minute', 'upload_requests_per_ip_minute', 'upload_mb_per_ip_hour']) {
      try { fallback[key] = core.settings(Object.assign({}, core.DEFAULTS, { [key]: value[key] }))[key]; } catch (_) {}
    }
    try { fallback.alert_webhook_url = core.webhook(value.alert_webhook_url); } catch (_) {}
    return fallback;
  }
}

function admin(e) {
  if (!e.hasSuperuserAuth()) base.fail(e.auth ? 403 : 401, 'Superuser authentication required');
}

function count(app, table, where, params) {
  const result = new DynamicModel({ total: 0 });
  app.db().newQuery('SELECT COUNT(*) AS total FROM ' + table + ' WHERE ' + where).bind(params || {}).one(result);
  return Number(result.total);
}

function load(store, key) {
  try { return JSON.parse(store.get(key) || '{}') || {}; } catch (_) { return {}; }
}

function rate(e, kind, max) {
  const store = e.app.store();
  const minute = Math.floor(Date.now() / 60000);
  let state = load(store, 'observability:requests');
  if (state.minute !== minute || !state.keys) state = { minute: minute, keys: {} };
  const key = kind + ':' + $security.sha256(e.realIP());
  // A full map stops custom counting for new IPs until the next minute.
  if (!state.keys[key] && Object.keys(state.keys).length >= 4096) return;
  const next = (state.keys[key] || 0) + 1;
  if (next > max) base.fail(429, 'Too many observability requests');
  state.keys[key] = next;
  store.set('observability:requests', JSON.stringify(state));
}

// Checked before the batch and charged after it, so refused uploads and repeated entries cost nothing.
function ipBudget(e, bytes, maxBytes) {
  const store = e.app.store();
  const key = $security.sha256(e.realIP());
  function read() {
    const hour = Math.floor(Date.now() / 3600000);
    const state = load(store, 'observability:bytes');
    return state.hour === hour && state.keys ? state : { hour: hour, keys: {} };
  }
  const state = read();
  // A full map stops per-IP counting for the hour; the daily budget still caps the disk.
  if (!state.keys[key] && Object.keys(state.keys).length >= 4096) return function () {};
  if ((state.keys[key] || 0) + bytes > maxBytes) base.fail(429, 'Observability upload budget reached');
  return function (spent) {
    const next = read();
    next.keys[key] = (next.keys[key] || 0) + spent;
    store.set('observability:bytes', JSON.stringify(next));
  };
}

// Keep the counter in the upload transaction, so the next upload sees it only after a successful commit.
function dailyBytes(tx, now) {
  let row;
  let cached;
  try {
    row = tx.findFirstRecordByData('replay_settings', 'key', 'observability:daily-bytes');
    cached = JSON.parse(row.getString('value'));
  } catch (_) {}
  if (cached && cached.at > now - 60000 && cached.at <= now && Number.isSafeInteger(cached.bytes) && cached.bytes >= 0) {
    return { row: row, at: cached.at, bytes: cached.bytes, refresh: false };
  }
  const result = new DynamicModel({ total: -0 });
  tx.db().newQuery('SELECT COALESCE((SELECT SUM(byteSize) FROM replay_errors WHERE receivedAt > {:since}), 0) + COALESCE((SELECT SUM(byteSize) FROM replay_logs WHERE receivedAt > {:since}), 0) AS total')
    .bind({ since: now - 86400000 }).one(result);
  const bytes = Number(result.total) || 0;
  if (!row) {
    row = new Record(tx.findCollectionByNameOrId('replay_settings'));
    row.set('key', 'observability:daily-bytes');
  }
  return { row: row, at: now, bytes: bytes, refresh: true };
}

function addDailyBytes(tx, cached, bytes) {
  if (!cached.refresh && !bytes) return;
  cached.row.set('value', JSON.stringify({ at: cached.at, bytes: cached.bytes + bytes }));
  tx.save(cached.row);
}

// Config and upload requests read the settings from memory, so a flood the rate limit refuses costs no
// database read. A save replaces the copy at once; a direct edit of the row is picked up within five seconds.
function cachedConfig(app) {
  const store = app.store();
  const now = Date.now();
  const cached = load(store, 'observability:settings');
  if (cached.at > now - 5000 && cached.at <= now && cached.value) return cached.value;
  const value = config(app);
  store.set('observability:settings', JSON.stringify({ at: now, value: value }));
  return value;
}

function getSettings(e) { admin(e); return config(e.app); }

function saveSettings(e) {
  admin(e);
  const value = readBody(e);
  let saved;
  e.app.runInTransaction(function (tx) {
    // An older dashboard leaves newer keys out; they keep their stored values.
    saved = core.settings(Object.assign(config(tx), value));
    let row;
    try { row = tx.findFirstRecordByData('replay_settings', 'key', 'observability'); } catch (_) {
      row = new Record(tx.findCollectionByNameOrId('replay_settings'));
      row.set('key', 'observability');
    }
    row.set('value', JSON.stringify(saved));
    tx.save(row);
  });
  e.app.store().set('observability:settings', JSON.stringify({ at: Date.now(), value: saved }));
  return saved;
}

function publicConfig(e) {
  const cfg = cachedConfig(e.app);
  rate(e, 'config', cfg.config_requests_per_ip_minute);
  const body = readBody(e);
  const admission = security.check(e.app, body);
  const meta = base.metadata(body);
  if (admission.requireAccount) {
    meta.accountId = replay.account(e.app, meta);
    security.requireAccount(admission, meta.accountId);
  }
  const result = {
    enabled: false, errorsEnabled: false, logsEnabled: false,
    uploadIntervalMs: core.LIMITS.uploadIntervalMs, maxBatchEvents: core.LIMITS.batchEvents,
  };
  if (!cfg.errors_enabled && !cfg.logs_enabled) return result;
  if (!admission.requireAccount) meta.accountId = replay.account(e.app, meta);
  if (replay.isForgotten(e.app, meta.accountId)) return result;
  const current = base.text(body.token, 'token', 64, false);
  if (current && !/^[A-Za-z0-9]{64}$/.test(current)) base.fail(401, 'Invalid observability token');
  const now = Date.now();
  const values = { deviceId: meta.deviceId, accountId: meta.accountId, platform: meta.platform, appVersion: meta.appVersion, room: core.label(meta.room, 128) };
  let token = current;
  let context;
  e.app.runInTransaction(function (tx) {
    security.check(tx, body, meta.accountId);
    if (replay.isForgotten(tx, meta.accountId)) return;
    result.errorsEnabled = cfg.errors_enabled;
    result.logsEnabled = cfg.logs_enabled;
    let changed = false;
    if (current) {
      const rows = tx.findRecordsByFilter('replay_observability_sessions', 'tokenHash = {:hash} && expiresAt > {:now}', '', 1, 0, { hash: $security.sha256(current), now: now });
      if (rows.length && rows[0].getString('deviceId') === meta.deviceId && rows[0].getString('accountId') === meta.accountId) context = rows[0];
    }
    if (context) {
      // A client that keeps refreshing keeps its credential, so its queued entries never meet an expiry.
      if (context.getFloat('expiresAt') < now + core.LIMITS.contextMs - core.LIMITS.contextRenewMs) {
        context.set('expiresAt', now + core.LIMITS.contextMs);
        changed = true;
      }
    } else {
      const params = { since: now - 3600000, device: meta.deviceId, ip: $security.sha256(e.realIP()) };
      if (count(tx, 'replay_observability_sessions', 'deviceId = {:device} AND issuedAt > {:since}', params) >= cfg.sessions_per_device_hour ||
          count(tx, 'replay_observability_sessions', 'ipHash = {:ip} AND issuedAt > {:since}', params) >= cfg.sessions_per_ip_hour ||
          count(tx, 'replay_observability_sessions', 'issuedAt > {:since}', params) >= cfg.sessions_per_hour) base.fail(429, 'Too many observability sessions');
      token = $security.randomString(64);
      context = new Record(tx.findCollectionByNameOrId('replay_observability_sessions'));
      context.set('tokenHash', $security.sha256(token));
      context.set('ipHash', params.ip);
      context.set('issuedAt', now);
      context.set('expiresAt', now + core.LIMITS.contextMs);
      changed = true;
    }
    for (const key of Object.keys(values)) {
      if (context.getString(key) !== values[key]) { context.set(key, values[key]); changed = true; }
    }
    if (changed) tx.save(context);
  });
  if (!context) return result;
  result.enabled = true;
  result.token = token;
  result.expiresAt = context.getFloat('expiresAt');
  result.expiresIn = result.expiresAt - now;
  return result;
}

// A link needs the recording's own upload secret and the same account and device as this credential.
// A link that fails is dropped and the entry kept: it is still this device's data, and the recording may
// only have been deleted since the entry was captured.
function linked(tx, context, sessionId, sessionToken) {
  let session;
  try { session = tx.findRecordById('replay_sessions', sessionId); } catch (_) { return false; }
  return $security.equal(session.getString('tokenHash'), $security.sha256(sessionToken)) &&
    session.getString('accountId') === context.getString('accountId') && session.getString('deviceId') === context.getString('deviceId');
}

function addAlert(tx, issue, kind, now, cfg) {
  const row = new Record(tx.findCollectionByNameOrId('replay_alerts'));
  row.set('issue', issue.id);
  row.set('title', issue.getString('title'));
  row.set('kind', kind);
  row.set('timestamp', now);
  row.set('acknowledged', false);
  row.set('delivery', cfg.alert_webhook_url ? 'pending' : 'none');
  tx.save(row);
}

function ingestion(e, kind) {
  const cfg = cachedConfig(e.app);
  rate(e, kind, cfg.upload_requests_per_ip_minute);
  const now = Date.now();
  const body = readBody(e);
  security.check(e.app, body);
  const value = core.batch(body, kind, now);
  const spend = ipBudget(e, core.bytes(JSON.stringify(value.events)), cfg.upload_mb_per_ip_hour * 1024 * 1024);
  let accepted = 0;
  let duplicates = 0;
  let conflicts = 0;
  let uploaded = 0;
  let stored = 0;
  const table = kind === 'error' ? 'replay_errors' : 'replay_logs';
  e.app.runInTransaction(function (tx) {
    let context;
    try { context = tx.findFirstRecordByData('replay_observability_sessions', 'tokenHash', $security.sha256(value.token)); } catch (_) { base.fail(401, 'Invalid observability token'); }
    security.check(tx, body, context.getString('accountId'));
    if (context.getFloat('expiresAt') <= now) base.fail(410, 'Observability session expired');
    if (!(kind === 'error' ? cfg.errors_enabled : cfg.logs_enabled) || replay.isForgotten(tx, context.getString('accountId'))) base.fail(403, 'Observability is disabled');
    const accountId = context.getString('accountId');
    const deviceId = context.getString('deviceId');
    const budget = dailyBytes(tx, Date.now());
    let daily = budget.bytes;
    value.events.forEach(function (item) {
      const sessionToken = item.sessionToken;
      delete item.sessionToken;
      // Hashed as sent, so a retry still matches after its recording link is dropped below.
      const payloadHash = $security.sha256(JSON.stringify(Object.assign({}, item, { accountId: accountId, deviceId: deviceId })));
      const old = tx.findRecordsByFilter(table, 'deviceId = {:device} && eventId = {:id}', '', 1, 0, { device: deviceId, id: item.eventId });
      if (old.length) {
        // A reused ID with different content is skipped and counted, not allowed to sink the rest of the batch.
        if ($security.equal(old[0].getString('payloadHash'), payloadHash)) duplicates++; else conflicts++;
        return;
      }
      const sent = core.bytes(JSON.stringify(item));
      if (item.sessionId && !linked(tx, context, item.sessionId, sessionToken)) item.sessionId = '';
      if (!item.room) item.room = core.label(context.getString('room'), 128);
      let issue;
      let alertKind = '';
      if (kind === 'error') {
        const fingerprint = core.fingerprint(item, function (text) { return $security.sha256(text); });
        const rows = tx.findRecordsByFilter('replay_issues', 'fingerprint = {:fingerprint}', '', 1, 0, { fingerprint: fingerprint });
        if (rows.length) {
          issue = rows[0];
          // An entry from before the fix, delivered late by a device that was offline, is not a regression.
          if (issue.getString('status') === 'resolved' && item.timestamp > issue.getFloat('resolvedAt')) { issue.set('status', 'open'); alertKind = 'regressed'; }
        } else {
          issue = new Record(tx.findCollectionByNameOrId('replay_issues'));
          issue.set('fingerprint', fingerprint);
          issue.set('status', 'open');
          issue.set('firstSeen', item.timestamp);
          alertKind = 'created';
        }
        // The title follows the newest occurrence, so a late older entry leaves it alone.
        if (alertKind === 'created' || item.timestamp >= issue.getFloat('lastSeen')) {
          issue.set('name', item.name);
          issue.set('message', item.message);
          issue.set('title', item.name + ': ' + item.message);
          issue.set('service', item.service);
        }
        issue.set('level', issue.getString('level') === 'fatal' ? 'fatal' : item.level);
        issue.set('firstSeen', Math.min(issue.getFloat('firstSeen'), item.timestamp));
        issue.set('lastSeen', Math.max(issue.getFloat('lastSeen'), item.timestamp));
        issue.set('lastReceivedAt', now);
        issue.set('occurrenceCount', issue.getInt('occurrenceCount') + 1);
      }
      const alerting = alertKind && cfg.alerts_enabled;
      const issueBytes = issue ? core.bytes(JSON.stringify(summary(issue, 'issue'))) + 512 : 0;
      const alertBytes = alerting ? core.bytes(JSON.stringify({ issueId: issue.id, title: issue.getString('title'), kind: alertKind, timestamp: now, acknowledged: false })) + 512 : 0;
      const bytes = core.bytes(JSON.stringify(Object.assign({}, item, { accountId: accountId, deviceId: deviceId }))) + 512 + issueBytes + alertBytes;
      if (daily + bytes > cfg.daily_limit_mb * 1024 * 1024) base.fail(429, 'Observability storage budget reached');
      if (issue) {
        tx.save(issue);
        if (alerting) addAlert(tx, issue, alertKind, now, cfg);
      }
      const row = new Record(tx.findCollectionByNameOrId(table));
      for (const key of ['accountId', 'deviceId', 'platform', 'appVersion']) row.set(key, context.getString(key));
      for (const key of Object.keys(item)) row.set(key, key === 'attributes' ? JSON.stringify(item[key]) : item[key]);
      row.set('payloadHash', payloadHash);
      row.set('receivedAt', now);
      row.set('byteSize', bytes);
      if (issue) row.set('issue', issue.id);
      tx.save(row);
      accepted++;
      uploaded += sent;
      stored += bytes;
      daily += bytes;
    });
    addDailyBytes(tx, budget, stored);
  });
  if (accepted) {
    spend(uploaded);
  }
  return { ok: true, accepted: accepted, duplicates: duplicates, conflicts: conflicts };
}

function errors(e) { return ingestion(e, 'error'); }
function logsUpload(e) { return ingestion(e, 'log'); }

function summary(row, kind, app, availability) {
  const result = { id: row.id };
  if (kind === 'issue') {
    for (const key of ['title', 'name', 'message', 'status', 'level', 'service']) result[key] = row.getString(key);
    for (const key of ['occurrenceCount', 'firstSeen', 'lastSeen', 'resolvedAt']) result[key] = row.getFloat(key);
  } else if (kind === 'alert') {
    for (const key of ['title', 'kind']) result[key] = row.getString(key);
    result.issueId = row.getString('issue');
    result.timestamp = row.getFloat('timestamp');
    result.acknowledged = row.getBool('acknowledged');
    result.delivery = row.getString('delivery') || 'none';
  } else {
    for (const key of ['accountId', 'deviceId', 'platform', 'appVersion', 'room', 'sessionId', 'service', 'message', 'level']) result[key] = row.getString(key);
    result.timestamp = row.getFloat('timestamp');
    result.replayAvailable = false;
    if (result.sessionId && app) {
      const cached = availability || {};
      if (!Object.prototype.hasOwnProperty.call(cached, result.sessionId)) {
        try { cached[result.sessionId] = app.findRecordById('replay_sessions', result.sessionId).getInt('chunkCount') > 0; } catch (_) { cached[result.sessionId] = false; }
      }
      result.replayAvailable = cached[result.sessionId];
    }
    try { result.attributes = JSON.parse(row.getString('attributes')); } catch (_) { result.attributes = {}; }
    if (kind === 'error') {
      result.issueId = row.getString('issue');
      result.name = row.getString('name');
      result.stack = row.getString('stack');
      result.handled = row.getBool('handled');
    }
  }
  return result;
}

function filters(e, kind) {
  const query = e.request.url.query();
  const clauses = ['1 = 1'];
  const params = {};
  const occurrence = [];
  const isIssue = kind === 'issue';
  for (const key of ['accountId', 'deviceId', 'sessionId']) {
    const alias = { accountId: 'account', deviceId: 'device', sessionId: 'session' }[key];
    const value = base.text(query.get(key) || query.get(alias), key, 128, false);
    if (value) { params[key] = value; (isIssue ? occurrence : clauses).push(key + ' = {:' + key + '}'); }
  }
  for (const key of ['from', 'to']) {
    const raw = query.get(key);
    if (!raw) continue;
    const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
    if (!Number.isSafeInteger(value) || value < 0) base.fail(400, 'Invalid date');
    params[key] = value;
    (isIssue ? occurrence : clauses).push('timestamp ' + (key === 'from' ? '>=' : '<=') + ' {:' + key + '}');
  }
  const service = base.text(query.get('service'), 'service', 128, false);
  if (service) { params.service = service; clauses.push('service = {:service}'); }
  const level = base.text(query.get('level'), 'level', 16, false);
  if (level) {
    if (!core.LEVELS.includes(level) || (isIssue && !['error', 'fatal'].includes(level))) base.fail(400, 'Invalid level');
    params.level = level; clauses.push('level = {:level}');
  }
  if (isIssue) {
    const status = base.text(query.get('status'), 'status', 16, false);
    if (status) {
      if (!['open', 'resolved', 'ignored'].includes(status)) base.fail(400, 'Invalid issue status');
      params.status = status; clauses.push('status = {:status}');
    }
    if (occurrence.length) clauses.push('id IN (SELECT issue FROM replay_errors WHERE ' + occurrence.join(' AND ') + ')');
  }
  const search = base.text(query.get('q'), 'search', 512, false);
  if (search) {
    params.search = search;
    clauses.push(isIssue ? '(instr(lower(title), lower({:search})) > 0 OR instr(lower(service), lower({:search})) > 0)' : '(instr(lower(message), lower({:search})) > 0 OR instr(lower(attributes), lower({:search})) > 0)');
  }
  return { page: base.page(query.get('page'), 10000), where: clauses.join(' AND '), params: params };
}

function listing(app, table, kind, filter, order) {
  const total = count(app, table, filter.where, filter.params);
  const rows = arrayOf(new Record());
  app.recordQuery(table).andWhere($dbx.exp(filter.where, filter.params)).orderBy(order + ' DESC', 'id DESC').limit(50).offset((filter.page - 1) * 50).all(rows);
  const items = [];
  const availability = {};
  for (let i = 0; i < rows.length; i++) items.push(summary(rows[i], kind, app, availability));
  return { items: items, page: filter.page, perPage: 50, totalItems: total, totalPages: Math.ceil(total / 50) };
}

function lookup(e, table) {
  const id = base.text(e.request.pathValue('id'), 'id', 15, true);
  try { return e.app.findRecordById(table, id); } catch (_) { base.fail(404, 'Not found'); }
}

function issues(e) { admin(e); return listing(e.app, 'replay_issues', 'issue', filters(e, 'issue'), 'lastSeen'); }
function logs(e) { admin(e); return listing(e.app, 'replay_logs', 'log', filters(e, 'log'), 'timestamp'); }
function log(e) { admin(e); return summary(lookup(e, 'replay_logs'), 'log', e.app); }

// Log counts per level over time, for the same filters as the list. At most about 60 buckets,
// counted from the start of the range so a day filter in any timezone starts on its own midnight.
function volume(e) {
  admin(e);
  const filter = filters(e, 'log');
  const range = new DynamicModel({ first: -0, last: -0, total: 0 });
  e.app.db().newQuery('SELECT COALESCE(MIN(timestamp), 0) AS first, COALESCE(MAX(timestamp), 0) AS last, COUNT(*) AS total FROM replay_logs WHERE ' + filter.where).bind(filter.params).one(range);
  const total = Number(range.total);
  const start = filter.params.from !== undefined ? filter.params.from : Number(range.first);
  const end = Math.max(start, filter.params.to !== undefined ? filter.params.to : Number(range.last));
  let step = 0;
  for (const candidate of VOLUME_STEPS) if (!step && (end - start) / candidate < 60) step = candidate;
  if (!step) step = Math.ceil((end - start) / 60 / 86400000) * 86400000;
  const result = { from: start, to: end, bucketMs: step, total: total, buckets: [] };
  if (!total) return result;
  for (let at = start; at <= end; at += step) result.buckets.push({ start: at, counts: {} });
  const rows = arrayOf(new DynamicModel({ bucket: 0, level: '', total: 0 }));
  e.app.db().newQuery('SELECT CAST((timestamp - {:volumeStart}) / {:volumeStep} AS INTEGER) AS bucket, level, COUNT(*) AS total FROM replay_logs WHERE ' + filter.where + ' GROUP BY bucket, level')
    .bind(Object.assign({ volumeStart: start, volumeStep: step }, filter.params)).all(rows);
  for (let i = 0; i < rows.length; i++) {
    const bucket = result.buckets[Number(rows[i].bucket)];
    if (bucket) bucket.counts[rows[i].level] = Number(rows[i].total);
  }
  return result;
}

function issue(e) {
  admin(e);
  const row = lookup(e, 'replay_issues');
  const filter = filters(e, 'error');
  filter.where += ' AND issue = {:issue}';
  filter.params.issue = row.id;
  const result = listing(e.app, 'replay_errors', 'error', filter, 'timestamp');
  result.issue = summary(row, 'issue');
  return result;
}

function updateIssue(e) {
  admin(e);
  const body = readBody(e);
  if (!['open', 'resolved', 'ignored'].includes(body.status)) base.fail(400, 'Invalid issue status');
  let result;
  e.app.runInTransaction(function (tx) {
    const row = lookup({ app: tx, request: e.request }, 'replay_issues');
    // Only entries that happen after this moment count as the issue coming back.
    if (body.status === 'resolved' && row.getString('status') !== 'resolved') row.set('resolvedAt', Date.now());
    row.set('status', body.status);
    tx.save(row);
    result = summary(row, 'issue');
  });
  return result;
}

function removeIssue(e) { admin(e); e.app.delete(lookup(e, 'replay_issues')); return { ok: true }; }
function removeLog(e) { admin(e); e.app.delete(lookup(e, 'replay_logs')); return { ok: true }; }

function alerts(e) {
  admin(e);
  const query = e.request.url.query();
  const filter = { page: base.page(query.get('page'), 10000), where: '1 = 1', params: {} };
  const acknowledged = query.get('acknowledged');
  if (acknowledged) {
    if (!['true', 'false'].includes(acknowledged)) base.fail(400, 'Invalid acknowledged');
    filter.where = 'acknowledged = {:acknowledged}';
    filter.params.acknowledged = acknowledged === 'true';
  }
  return listing(e.app, 'replay_alerts', 'alert', filter, 'timestamp');
}

function acknowledge(e) {
  admin(e);
  const row = lookup(e, 'replay_alerts');
  row.set('acknowledged', true);
  e.app.save(row);
  return summary(row, 'alert');
}

function removeAlert(e) { admin(e); e.app.delete(lookup(e, 'replay_alerts')); return { ok: true }; }

function webhookHost(url) {
  return ((/^https?:\/\/([^/:?#]+)/i.exec(url) || [])[1] || '').toLowerCase();
}

function dashboardLink(app) {
  let dashboard = '';
  try {
    // PocketBase fills in http://localhost:8090 when no Application URL is set; nobody can follow that link.
    const address = String(app.settings().meta.appURL || '');
    if (/^https?:\/\//i.test(address) && !/^https?:\/\/(?:localhost|127\.|\[::1\])/i.test(address)) dashboard = address.replace(/\/+$/, '') + '/dash/replay';
  } catch (_) { /* No application URL, so no link. */ }
  return dashboard;
}

function alertLine(item) {
  const kind = item.kind === 'regressed' ? 'Resolved issue returned' : item.kind === 'test' ? 'Test alert' : 'New issue';
  // Do not split an emoji's surrogate pair at the title limit.
  return kind + ': ' + item.title.slice(0, 300).replace(/[\uD800-\uDBFF]$/, '');
}

function webhookBatches(app, url, items) {
  const host = webhookHost(url);
  const discord = /(^|\.)discord(app)?\.com$/.test(host);
  let dashboard = dashboardLink(app);
  const lines = items.map(alertLine);
  const batches = [];
  if (discord) {
    const longest = lines.reduce(function (length, line) { return Math.max(length, line.length); }, 0);
    // Omit a link that cannot fit beside one complete alert.
    if (dashboard.length + 1 + longest > 1900) dashboard = '';
    const available = 1900 - (dashboard ? dashboard.length + 1 : 0);
    let current = [];
    let length = 0;
    for (let index = 0; index < items.length; index++) {
      const next = lines[index].length + (current.length ? 1 : 0);
      if (current.length && length + next > available) {
        batches.push(current);
        current = [];
        length = 0;
      }
      length += lines[index].length + (current.length ? 1 : 0);
      current.push(items[index]);
    }
    if (current.length) batches.push(current);
  } else batches.push(items);
  return batches.map(function (batch) {
    const text = batch.map(alertLine).concat(dashboard ? [dashboard] : []).join('\n');
    const body = discord ? { content: text }
      : host === 'hooks.slack.com' || host === 'chat.googleapis.com' ? { text: text }
        : { text: text, dashboard: dashboard, alerts: batch };
    return { items: batch, body: body };
  });
}

// Slack and Google Chat read "text"; Discord reads "content". Other endpoints also get the alert records.
function post(url, body) {
  try {
    const response = $http.send({ url: url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 5 });
    if (response.statusCode >= 200 && response.statusCode < 300) return true;
    console.warn('replay: alert webhook answered ' + response.statusCode);
  } catch (error) { console.warn('replay: alert webhook failed: ' + error); }
  return false;
}

// Each sweep selects up to 20 alerts. Discord batches fit complete alerts and the dashboard link in 1,900 characters.
// A failed message waits for the next sweep and gives up after ten tries; accepted messages stay sent.
function deliver(app, cfg) {
  if (!cfg.alert_webhook_url) {
    app.db().newQuery("UPDATE replay_alerts SET delivery = 'none' WHERE delivery = 'pending'").execute();
    return;
  }
  const rows = app.findRecordsByFilter('replay_alerts', "delivery = 'pending'", 'timestamp,id', 20, 0);
  if (!rows.length) return;
  const batches = webhookBatches(app, cfg.alert_webhook_url, rows.map(function (row) { return summary(row, 'alert'); }));
  const deadline = Date.now() + 50000;
  for (const batch of batches) {
    // Leave later messages queued when delivery runs close to the next cron minute.
    if (Date.now() >= deadline) break;
    const sent = post(cfg.alert_webhook_url, batch.body);
    const ids = {};
    const list = batch.items.map(function (item, index) { ids['alert' + index] = item.id; return '{:alert' + index + '}'; }).join(', ');
    // An alert can disappear with its issue while the request is out.
    app.db().newQuery(sent ? "UPDATE replay_alerts SET delivery = 'sent' WHERE id IN (" + list + ')'
      : "UPDATE replay_alerts SET deliveryAttempts = deliveryAttempts + 1, delivery = CASE WHEN deliveryAttempts + 1 >= 10 THEN 'failed' ELSE delivery END WHERE id IN (" + list + ')').bind(ids).execute();
    if (!sent) break;
  }
}

function testAlert(e) {
  admin(e);
  const body = readBody(e);
  // The dashboard sends the address being edited, so it can be tried before it is saved.
  const url = body.alert_webhook_url === undefined ? config(e.app).alert_webhook_url : core.webhook(body.alert_webhook_url);
  if (!url) base.fail(400, 'Enter a webhook URL first');
  const sample = { id: '', issueId: '', kind: 'test', title: 'PocketBase Replay can reach this webhook', timestamp: Date.now(), acknowledged: false, delivery: 'sent' };
  if (!post(url, webhookBatches(e.app, url, [sample])[0].body)) base.fail(502, 'The webhook did not accept the test alert');
  return { ok: true };
}

function reconcileIssue(tx, id) {
  const result = new DynamicModel({ total: 0, firstSeen: -0, lastSeen: -0, lastReceivedAt: -0 });
  tx.db().newQuery('SELECT COUNT(*) AS total, COALESCE(MIN(timestamp), 0) AS firstSeen, COALESCE(MAX(timestamp), 0) AS lastSeen, COALESCE(MAX(receivedAt), 0) AS lastReceivedAt FROM replay_errors WHERE issue = {:issue}').bind({ issue: id }).one(result);
  let issue;
  try { issue = tx.findRecordById('replay_issues', id); } catch (_) { return; }
  if (!Number(result.total)) { tx.delete(issue); return; }
  const newest = tx.findRecordsByFilter('replay_errors', 'issue = {:issue}', '-timestamp,-id', 1, 0, { issue: id })[0];
  issue.set('occurrenceCount', Number(result.total));
  for (const key of ['firstSeen', 'lastSeen', 'lastReceivedAt']) issue.set(key, Number(result[key]));
  for (const key of ['name', 'message', 'service']) issue.set(key, newest.getString(key));
  issue.set('title', issue.getString('name') + ': ' + issue.getString('message'));
  const fatal = tx.findRecordsByFilter('replay_errors', "issue = {:issue} && level = 'fatal'", '', 1, 0, { issue: id });
  issue.set('level', fatal.length ? 'fatal' : 'error');
  tx.save(issue);
  tx.db().newQuery('UPDATE replay_alerts SET title = {:title} WHERE issue = {:issue}').bind({ title: issue.getString('title'), issue: id }).execute();
}

// Deletes up to `limit` matching entries with SQL, oldest first, then recomputes the issues they belonged to.
function removeEvents(tx, table, filter, params, limit) {
  const rows = arrayOf(new DynamicModel({ id: '', issue: '' }));
  tx.db().newQuery('SELECT id, ' + (table === 'replay_errors' ? 'issue' : "'' AS issue") + ' FROM ' + table + ' WHERE ' + filter + ' ORDER BY receivedAt, id LIMIT ' + limit)
    .bind(params).all(rows);
  if (!rows.length) return 0;
  const ids = {};
  const issues = {};
  const list = [];
  for (let i = 0; i < rows.length; i++) {
    ids['event' + i] = rows[i].id;
    list.push('{:event' + i + '}');
    if (rows[i].issue) issues[rows[i].issue] = true;
  }
  tx.db().newQuery('DELETE FROM ' + table + ' WHERE id IN (' + list.join(', ') + ')').bind(ids).execute();
  Object.keys(issues).forEach(function (id) { reconcileIssue(tx, id); });
  return rows.length;
}

function eraseBatch(tx, field, id, limit) {
  const filter = field + ' = {:id}';
  const params = { id: id };
  const errors = removeEvents(tx, 'replay_errors', filter, params, limit);
  const logs = removeEvents(tx, 'replay_logs', filter, params, limit);
  if (field === 'accountId') tx.db().newQuery('DELETE FROM replay_observability_sessions WHERE accountId = {:id}').bind(params).execute();
  return {
    deletedErrors: errors, deletedLogs: logs,
    remainingErrors: count(tx, 'replay_errors', filter, params), remainingLogs: count(tx, 'replay_logs', filter, params),
  };
}

function eraseAccountAll(tx, accountId) {
  let result;
  do { result = eraseBatch(tx, 'accountId', accountId, 1000); } while (result.remainingErrors || result.remainingLogs);
}

function sweep(app) {
  const cfg = config(app);
  try { deliver(app, cfg); } catch (error) { console.warn('replay: alert delivery failed: ' + error); }
  const now = Date.now();
  const deadline = now + 4000;
  for (const pair of [['replay_errors', cfg.errors_retention_days, 500], ['replay_logs', cfg.logs_retention_days, 2000]]) {
    let removed;
    do {
      removed = 0;
      app.runInTransaction(function (tx) { removed = removeEvents(tx, pair[0], 'receivedAt < {:cutoff}', { cutoff: now - pair[1] * 86400000 }, pair[2]); });
    } while (removed === pair[2] && Date.now() < deadline);
  }
  app.db().newQuery('DELETE FROM replay_observability_sessions WHERE id IN (SELECT id FROM replay_observability_sessions WHERE expiresAt <= {:now} LIMIT 2000)').bind({ now: now }).execute();
  app.db().newQuery('DELETE FROM replay_alerts WHERE id IN (SELECT id FROM replay_alerts WHERE timestamp < {:cutoff} LIMIT 500)').bind({ cutoff: now - cfg.errors_retention_days * 86400000 }).execute();
}

function route(e, name) {
  e.response.header().set('Cache-Control', 'no-store');
  e.response.header().set('X-Content-Type-Options', 'nosniff');
  try { return e.json(200, module.exports[name](e)); } catch (error) {
    if (error && error.status) return e.json(error.status, { message: error.message });
    throw error;
  }
}

module.exports = {
  config: config, publicConfig: publicConfig, getSettings: getSettings, saveSettings: saveSettings, errors: errors, logsUpload: logsUpload,
  issues: issues, issue: issue, updateIssue: updateIssue, removeIssue: removeIssue, logs: logs, log: log, volume: volume, removeLog: removeLog,
  alerts: alerts, acknowledge: acknowledge, removeAlert: removeAlert, testAlert: testAlert, deliver: deliver, eraseBatch: eraseBatch,
  eraseAccountAll: eraseAccountAll, reconcileIssue: reconcileIssue, sweep: sweep, route: route,
};
