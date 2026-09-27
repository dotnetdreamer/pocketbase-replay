const core = require('./replay-core.js');

function readBody(e) {
  let raw;
  try { raw = readerToString(e.request.body); } catch (_) { core.fail(400, 'Unreadable body'); }
  if (!raw || raw.length > core.LIMITS.envelopeBytes) core.fail(413, 'Body is too large');
  try { return core.object(JSON.parse(raw)); } catch (error) {
    if (error.status) throw error;
    core.fail(400, 'Invalid JSON');
  }
}

function config(app) {
  const rows = app.findRecordsByFilter('replay_settings', "key = 'mode' || key = 'percentage' || key = 'account_ids' || key = 'retention_days' || key = 'daily_limit_mb' || key = 'mask_selector' || key = 'block_selector'", '', 7, 0);
  const result = {};
  let valid = true;
  for (const key of Object.keys(core.DEFAULTS)) result[key] = core.DEFAULTS[key];
  rows.forEach(function (row) {
    const key = row.getString('key');
    if (Object.prototype.hasOwnProperty.call(core.DEFAULTS, key)) {
      try { result[key] = JSON.parse(row.getString('value')); } catch (_) { valid = false; }
    }
  });
  try {
    if (!valid) throw new Error('Invalid replay settings');
    return core.settings(result);
  } catch (_) {
    const fallback = core.settings(core.DEFAULTS);
    if (Number.isInteger(result.retention_days) && result.retention_days >= 1 && result.retention_days <= 365) fallback.retention_days = result.retention_days;
    // Recording is off here; valid rules stay so the next dashboard save does not wipe them.
    for (const key of ['mask_selector', 'block_selector']) {
      try { fallback[key] = core.selector(result[key], key); } catch (_) { /* An unreadable rule stays empty. */ }
    }
    return fallback;
  }
}

function count(app, table, where, params) {
  const result = new DynamicModel({ total: 0 });
  app.db().newQuery('SELECT COUNT(*) AS total FROM ' + table + ' WHERE ' + where).bind(params || {}).one(result);
  return Number(result.total);
}

function rate(e, kind, max) {
  const store = e.app.store();
  const minute = Math.floor(Date.now() / 60000);
  let state;
  try { state = JSON.parse(store.get('replay:request-rate') || '{}'); } catch (_) { state = {}; }
  if (state.minute !== minute) state = { minute: minute, keys: {} };
  const key = kind + ':' + $security.sha256(e.realIP());
  // A full map stops counting new IPs; PocketBase's own per-IP limiter still applies.
  if (!state.keys[key] && Object.keys(state.keys).length >= 4096) return;
  const next = (state.keys[key] || 0) + 1;
  if (next > max) core.fail(429, 'Too many replay requests');
  state.keys[key] = next;
  store.set('replay:request-rate', JSON.stringify(state));
}

function load(store, key) {
  try { return JSON.parse(store.get(key) || '{}') || {}; } catch (_) { return {}; }
}

function ipBudget(e, bytes) {
  const store = e.app.store();
  const key = $security.sha256(e.realIP());
  function read() {
    const hour = Math.floor(Date.now() / 3600000);
    const state = load(store, 'replay:ip-bytes');
    return state.hour === hour && state.keys ? state : { hour: hour, keys: {} };
  }
  const state = read();
  // A full map stops per-IP counting for the hour; the daily budget still caps the disk.
  if (!state.keys[key] && Object.keys(state.keys).length >= 4096) return function () {};
  if ((state.keys[key] || 0) + bytes > core.LIMITS.ipBytesPerHour) core.fail(429, 'Replay upload budget reached');
  return function () {
    const next = read();
    next.keys[key] = (next.keys[key] || 0) + bytes;
    store.set('replay:ip-bytes', JSON.stringify(next));
  };
}

function dailyBytes(e, tx) {
  const store = e.app.store();
  const now = Date.now();
  const cached = load(store, 'replay:daily-bytes');
  if (cached.at > now - 60000 && cached.at <= now && Number.isFinite(cached.bytes)) return cached.bytes;
  const result = new DynamicModel({ total: -0 });
  tx.db().newQuery('SELECT COALESCE(SUM(compressedBytes), 0) AS total FROM replay_sessions WHERE startedAt > {:since}').bind({ since: now - 86400000 }).one(result);
  const bytes = Number(result.total) || 0;
  store.set('replay:daily-bytes', JSON.stringify({ at: now, bytes: bytes }));
  return bytes;
}

function addDailyBytes(e, bytes) {
  const store = e.app.store();
  const cached = load(store, 'replay:daily-bytes');
  if (!Number.isFinite(cached.bytes)) return;
  cached.bytes += bytes;
  store.set('replay:daily-bytes', JSON.stringify(cached));
}

function cachedAccount(store, key) {
  const hit = load(store, 'replay:verified')[key];
  return hit && hit.exp > Date.now() && typeof hit.id === 'string' ? hit.id : '';
}

function cacheAccount(store, key, id) {
  const now = Date.now();
  const cache = load(store, 'replay:verified');
  // Keep the 999 freshest live entries, so a full cache drops the one closest to expiry.
  const live = Object.keys(cache).filter(function (hash) { return hash !== key && cache[hash] && cache[hash].exp > now; })
    .sort(function (a, b) { return cache[b].exp - cache[a].exp; }).slice(0, 999);
  const next = {};
  live.forEach(function (hash) { next[hash] = cache[hash]; });
  next[key] = { id: id, exp: now + 10 * 60 * 1000 };
  store.set('replay:verified', JSON.stringify(next));
}

function account(app, meta) {
  if (!meta.authToken) {
    if (meta.accountId) core.fail(401, 'An account token is required');
    return '';
  }
  let id = '';
  const url = core.authURL($os.getenv('REPLAY_AUTH_URL'));
  if (url) {
    const key = $security.sha256(meta.authToken);
    id = cachedAccount(app.store(), key);
    if (!id) {
      let result;
      try {
        result = $http.send({
          url: url, method: 'POST', headers: { Authorization: meta.authToken, 'Content-Type': 'application/json' },
          body: '{}', timeout: 3,
        });
      } catch (_) { core.fail(503, 'Account service unavailable'); }
      if (result.statusCode === 429 || result.statusCode >= 500) core.fail(503, 'Account service unavailable');
      const record = result.statusCode === 200 && result.json && result.json.record;
      if (record && record.collectionName !== '_superusers' && !record.banned && typeof record.id === 'string' && record.id) {
        id = record.id;
        cacheAccount(app.store(), key, id);
      }
    }
  } else {
    try {
      const record = app.findAuthRecordByToken(meta.authToken, 'auth');
      if (record && !record.isSuperuser() && !record.getBool('banned')) id = record.id;
    } catch (_) { core.fail(401, 'Invalid account token'); }
  }
  if (typeof id !== 'string' || !id || (meta.accountId && id !== meta.accountId)) core.fail(401, 'Invalid account token');
  return id;
}

function selected(cfg, identity) {
  return core.enabled(cfg, identity, function (value) { return $security.sha256(value); });
}

function erasedKey(accountId) { return 'erase:' + $security.sha256(accountId).slice(0, 58); }

function isForgotten(app, accountId) {
  if (!accountId) return false;
  const rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: erasedKey(accountId) });
  return rows.length > 0 && Number(rows[0].getString('value')) > Date.now();
}

function markForgotten(app, accountId) {
  const key = erasedKey(accountId);
  const rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: key });
  const row = rows.length ? rows[0] : new Record(app.findCollectionByNameOrId('replay_settings'));
  row.set('key', key);
  row.set('value', String(Date.now() + 24 * 60 * 60 * 1000));
  app.save(row);
}

function trustProxy(app) {
  const header = $os.getenv('REPLAY_TRUSTED_PROXY');
  if (!header) return false;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) {
    console.warn('replay: ignoring invalid REPLAY_TRUSTED_PROXY');
    return false;
  }
  const settings = app.settings();
  const current = settings.trustedProxy;
  const headers = (current && current.headers) || [];
  if (headers.length === 1 && headers[0] === header && !current.useLeftmostIP) return false;
  unmarshal({ trustedProxy: { headers: [header], useLeftmostIP: false } }, settings);
  try { app.save(settings); } catch (error) {
    console.warn('replay: could not save trustedProxy: ' + error);
    return false;
  }
  return true;
}

function publicConfig(e) {
  rate(e, 'config', 120);
  const meta = core.metadata(readBody(e));
  const cfg = config(e.app);
  // A claim that cannot be selected needs no verification; lying only opts a client out.
  if (!selected(cfg, meta)) return { enabled: false, uploadIntervalMs: core.LIMITS.uploadIntervalMs };
  meta.accountId = account(e.app, meta);
  if (!selected(cfg, meta) || isForgotten(e.app, meta.accountId)) return { enabled: false, uploadIntervalMs: core.LIMITS.uploadIntervalMs };
  return { enabled: true, uploadIntervalMs: core.LIMITS.uploadIntervalMs, maskTextSelector: cfg.mask_selector, blockSelector: cfg.block_selector };
}

function start(e) {
  rate(e, 'start', 30);
  const meta = core.metadata(readBody(e));
  let cfg = config(e.app);
  if (!selected(cfg, meta)) return { enabled: false };
  meta.accountId = account(e.app, meta);
  if (!selected(cfg, meta)) return { enabled: false };
  const now = Date.now();
  const token = $security.randomString(64);
  const ipHash = $security.sha256(e.realIP());
  let session;
  e.app.runInTransaction(function (tx) {
    cfg = config(tx);
    if (!selected(cfg, meta) || isForgotten(tx, meta.accountId)) core.fail(403, 'Replay is disabled');
    const since = now - 60 * 60 * 1000;
    const params = { since: since, device: meta.deviceId, ip: ipHash };
    if (count(tx, 'replay_sessions', 'deviceId = {:device} AND startedAt > {:since}', params) >= 12 ||
        count(tx, 'replay_sessions', 'ipHash = {:ip} AND startedAt > {:since}', params) >= 120 ||
        count(tx, 'replay_sessions', 'startedAt > {:since}', params) >= 3000) core.fail(429, 'Too many replay sessions');
    session = new Record(tx.findCollectionByNameOrId('replay_sessions'));
    for (const key of ['deviceId', 'accountId', 'platform', 'appVersion', 'room']) session.set(key, meta[key]);
    session.set('rooms', meta.room ? '|' + meta.room + '|' : '');
    session.set('tokenHash', $security.sha256(token));
    session.set('ipHash', ipHash);
    session.set('startedAt', now);
    session.set('lastSeenAt', now);
    session.set('expiresAt', now + core.LIMITS.sessionMs);
    tx.save(session);
  });
  return {
    enabled: true, sessionId: session.id, token: token, expiresAt: now + core.LIMITS.sessionMs, expiresIn: core.LIMITS.sessionMs, uploadIntervalMs: core.LIMITS.uploadIntervalMs,
    maskTextSelector: cfg.mask_selector, blockSelector: cfg.block_selector,
  };
}

function upload(e) {
  rate(e, 'upload', 240);
  const value = core.chunk(readBody(e), Date.now());
  const spend = ipBudget(e, value.compressedBytes);
  let added = false;
  e.app.runInTransaction(function (tx) {
    let session;
    try { session = tx.findRecordById('replay_sessions', value.sessionId); } catch (_) { core.fail(401, 'Invalid upload token'); }
    if (!$security.equal(session.getString('tokenHash'), $security.sha256(value.token))) core.fail(401, 'Invalid upload token');
    if (session.getFloat('expiresAt') <= Date.now()) core.fail(410, 'Replay session expired');
    const cfg = config(tx);
    if (!selected(cfg, { accountId: session.getString('accountId'), deviceId: session.getString('deviceId') }) || isForgotten(tx, session.getString('accountId'))) core.fail(403, 'Replay is disabled');
    const duplicates = tx.findRecordsByFilter('replay_chunks', 'session = {:id} && seq = {:seq}', '', 1, 0, { id: session.id, seq: value.seq });
    if (duplicates.length) {
      const old = duplicates[0];
      for (const key of ['data', 'encoding', 'room']) if (old.getString(key) !== value[key]) core.fail(409, 'Chunk sequence already exists');
      for (const key of ['startedAt', 'endedAt', 'rawBytes', 'eventCount']) if (old.getFloat(key) !== value[key]) core.fail(409, 'Chunk sequence already exists');
      if (old.getBool('hasSnapshot') !== value.hasSnapshot) core.fail(409, 'Chunk sequence already exists');
      return;
    }
    if (value.seq >= core.LIMITS.sessionChunks || session.getInt('chunkCount') >= core.LIMITS.sessionChunks ||
        session.getFloat('compressedBytes') + value.compressedBytes > core.LIMITS.sessionBytes ||
        session.getFloat('rawBytes') + value.rawBytes > core.LIMITS.sessionRawBytes ||
        session.getFloat('eventCount') + value.eventCount > core.LIMITS.sessionEvents) core.fail(410, 'Replay session is full');
    if (dailyBytes(e, tx) + value.compressedBytes > cfg.daily_limit_mb * 1024 * 1024) core.fail(429, 'Replay storage budget reached');
    const row = new Record(tx.findCollectionByNameOrId('replay_chunks'));
    row.set('session', session.id);
    for (const key of ['seq', 'startedAt', 'endedAt', 'room', 'encoding', 'data', 'rawBytes', 'compressedBytes', 'eventCount', 'hasSnapshot']) row.set(key, value[key]);
    tx.save(row);
    session.set('endedAt', Math.max(session.getFloat('endedAt'), value.endedAt));
    session.set('lastSeenAt', Date.now());
    session.set('chunkCount', session.getInt('chunkCount') + 1);
    for (const key of ['rawBytes', 'compressedBytes', 'eventCount']) session.set(key, session.getFloat(key) + value[key]);
    if (value.room) {
      const rooms = session.getString('rooms');
      const roomKey = '|' + value.room + '|';
      if (!rooms.includes(roomKey)) {
        if (rooms.length + roomKey.length > 32768) core.fail(413, 'Too many replay rooms');
        session.set('rooms', rooms + roomKey);
      }
      if (value.endedAt >= session.getFloat('endedAt')) session.set('room', value.room);
    }
    tx.save(session);
    added = true;
  });
  if (added) {
    spend();
    addDailyBytes(e, value.compressedBytes);
  }
  return { ok: true };
}

function admin(e) {
  if (!e.hasSuperuserAuth()) core.fail(401, 'Superuser authentication required');
}

function getSettings(e) { admin(e); return config(e.app); }

function saveSettings(e) {
  admin(e);
  const body = readBody(e);
  // An older dashboard leaves these out; they keep their stored values.
  let stored = null;
  for (const key of ['daily_limit_mb', 'mask_selector', 'block_selector']) {
    if (body[key] !== undefined) continue;
    stored = stored || config(e.app);
    body[key] = stored[key];
  }
  const cfg = core.settings(body);
  e.app.runInTransaction(function (tx) {
    for (const key of Object.keys(core.DEFAULTS)) {
      let row;
      try { row = tx.findFirstRecordByData('replay_settings', 'key', key); } catch (_) {
        row = new Record(tx.findCollectionByNameOrId('replay_settings'));
        row.set('key', key);
      }
      row.set('value', JSON.stringify(cfg[key]));
      tx.save(row);
    }
  });
  return cfg;
}

function summary(row) {
  const result = { id: row.id, sessionId: row.id };
  for (const key of ['deviceId', 'accountId', 'platform', 'appVersion', 'room']) result[key] = row.getString(key);
  for (const key of ['startedAt', 'endedAt', 'lastSeenAt', 'expiresAt', 'compressedBytes', 'rawBytes', 'chunkCount', 'eventCount']) result[key] = row.getFloat(key);
  result.rooms = row.getString('rooms').split('|').filter(Boolean);
  return result;
}

function sessions(e) {
  admin(e);
  const query = e.request.url.query();
  const page = core.page(query.get('page'));
  const params = {};
  const sql = ['1 = 1'];
  for (const pair of [['account', 'accountId'], ['device', 'deviceId']]) {
    const value = core.text(query.get(pair[0]), pair[0], 128, false);
    if (value) { params[pair[0]] = value; sql.push(pair[1] + ' = {:' + pair[0] + '}'); }
  }
  for (const key of ['from', 'to']) {
    const raw = query.get(key);
    if (raw) {
      const value = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
      if (!Number.isFinite(value) || value < 0) core.fail(400, 'Invalid date');
      params[key] = value;
      sql.push('startedAt ' + (key === 'from' ? '>=' : '<=') + ' {:' + key + '}');
    }
  }
  const room = core.text(query.get('room'), 'room', 128, false);
  if (room) {
    if (room.includes('|')) core.fail(400, 'Invalid room');
    params.room = '|' + room + '|';
    sql.push('instr(upper(rooms), upper({:room})) > 0');
  }
  const where = sql.join(' AND ');
  const total = count(e.app, 'replay_sessions', where, params);
  const rows = arrayOf(new Record());
  e.app.recordQuery('replay_sessions').andWhere($dbx.exp(where, params)).orderBy('startedAt DESC', 'id DESC').limit(30).offset((page - 1) * 30).all(rows);
  const items = [];
  for (let i = 0; i < rows.length; i++) items.push(summary(rows[i]));
  return { items: items, page: page, perPage: 30, totalItems: total, totalPages: Math.ceil(total / 30) };
}

function chunks(e) {
  admin(e);
  const id = e.request.pathValue('id');
  let session;
  try { session = e.app.findRecordById('replay_sessions', id); } catch (_) { core.fail(404, 'Replay session not found'); }
  const page = core.page(e.request.url.query().get('page'), 205);
  const offset = (page - 1) * 10;
  const rows = e.app.findRecordsByFilter('replay_chunks', 'session = {:id}', 'seq', 10, offset, { id: id });
  let previous = -1;
  if (offset) {
    const before = e.app.findRecordsByFilter('replay_chunks', 'session = {:id}', 'seq', 1, offset - 1, { id: id });
    if (before.length) previous = before[0].getInt('seq');
  }
  const items = rows.map(function (row) {
    const result = {};
    for (const key of ['room', 'encoding', 'data']) result[key] = row.getString(key);
    for (const key of ['seq', 'startedAt', 'endedAt', 'rawBytes', 'compressedBytes', 'eventCount']) result[key] = row.getFloat(key);
    result.hasSnapshot = row.getBool('hasSnapshot');
    return result;
  });
  const total = session.getInt('chunkCount');
  return { items: items, session: summary(session), missingSeq: core.gaps(items, previous), page: page, perPage: 10, totalItems: total, totalPages: Math.ceil(total / 10) };
}

function remove(e) {
  admin(e);
  let session;
  try { session = e.app.findRecordById('replay_sessions', e.request.pathValue('id')); } catch (_) { core.fail(404, 'Replay session not found'); }
  e.app.delete(session);
  return { ok: true };
}

function removeSessions(tx, filter, params, limit) {
  const rows = tx.findRecordsByFilter('replay_sessions', filter, 'startedAt,id', limit, 0, params);
  if (!rows.length) return 0;
  const ids = {};
  const list = rows.map(function (row, index) { ids['id' + index] = row.id; return '{:id' + index + '}'; }).join(', ');
  tx.db().newQuery('DELETE FROM replay_chunks WHERE session IN (' + list + ')').bind(ids).execute();
  tx.db().newQuery('DELETE FROM replay_sessions WHERE id IN (' + list + ')').bind(ids).execute();
  return rows.length;
}

function eraseAccountBatch(app, accountId, mark) {
  let deleted = 0;
  let remaining = 0;
  app.runInTransaction(function (tx) {
    // Close the gap between remote auth and the account's final deletion.
    if (mark) markForgotten(tx, accountId);
    deleted = removeSessions(tx, 'accountId = {:account}', { account: accountId }, 200);
    remaining = count(tx, 'replay_sessions', 'accountId = {:account}', { account: accountId });
  });
  return { ok: true, deletedSessions: deleted, remainingSessions: remaining };
}

function eraseAccount(e) {
  admin(e);
  return eraseAccountBatch(e.app, core.text(e.request.pathValue('id'), 'accountId', 128, true));
}

function forget(e) {
  const expected = $os.getenv('REPLAY_ERASE_KEY');
  if (!expected || expected.length < 32 || expected.length > 512) core.fail(503, 'Replay erasure is not configured');
  const supplied = e.request.header.get('x-replay-erase-key') || '';
  if (!supplied || supplied.length > 512 || !$security.equal($security.sha256(supplied), $security.sha256(expected))) core.fail(401, 'Invalid replay erasure key');
  const body = readBody(e);
  return eraseAccountBatch(e.app, core.text(body.accountId, 'accountId', 128, true), true);
}

function deleteLocalAccount(e) {
  if ($os.getenv('REPLAY_AUTH_URL')) return e.next();
  e.app.runInTransaction(function (tx) {
    markForgotten(tx, e.record.id);
    const params = { account: e.record.id };
    tx.db().newQuery('DELETE FROM replay_chunks WHERE session IN (SELECT id FROM replay_sessions WHERE accountId = {:account})').bind(params).execute();
    tx.db().newQuery('DELETE FROM replay_sessions WHERE accountId = {:account}').bind(params).execute();
  });
  return e.next();
}

function sweep(app) {
  const cutoff = Date.now() - config(app).retention_days * 86400000;
  const deadline = Date.now() + 5000;
  let removed;
  do {
    removed = 0;
    app.runInTransaction(function (tx) { removed = removeSessions(tx, 'startedAt < {:cutoff}', { cutoff: cutoff }, 20); });
  } while (removed === 20 && Date.now() < deadline);
  app.db().newQuery("DELETE FROM replay_settings WHERE id IN (SELECT id FROM replay_settings WHERE key LIKE 'erase:%' AND CAST(value AS INTEGER) <= {:now} LIMIT 100)").bind({ now: Date.now() }).execute();
}

function route(e, name) {
  e.response.header().set('Cache-Control', 'no-store');
  e.response.header().set('X-Content-Type-Options', 'nosniff');
  try { return e.json(200, module.exports[name](e)); } catch (error) {
    if (error && error.status) return e.json(error.status, { message: error.message });
    throw error;
  }
}

function asset(e, name) {
  const type = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' }[name];
  if (!type) return e.json(404, { message: 'Not found' });
  e.response.header().set('Cache-Control', 'no-store');
  e.response.header().set('X-Content-Type-Options', 'nosniff');
  e.response.header().set('Referrer-Policy', 'no-referrer');
  e.response.header().set('Content-Type', type);
  return e.fileFS($os.dirFS(__hooks + '/replay-dash'), name);
}

module.exports = { config: config, publicConfig: publicConfig, start: start, upload: upload, getSettings: getSettings, saveSettings: saveSettings, sessions: sessions, chunks: chunks, remove: remove, eraseAccount: eraseAccount, eraseAccountBatch: eraseAccountBatch, forget: forget, deleteLocalAccount: deleteLocalAccount, isForgotten: isForgotten, sweep: sweep, route: route, asset: asset, account: account, trustProxy: trustProxy };
