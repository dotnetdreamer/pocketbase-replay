const core = require('./replay-core.js');

const SETTINGS_KEY = 'ingestion_security';
const LIMITS = { keys: 32, label: 64, bodyBytes: 16384 };

function defaults() { return { requireApiKey: false, requireAccount: false, keys: [] }; }

function validate(value) {
  core.object(value);
  if (typeof value.requireApiKey !== 'boolean' || typeof value.requireAccount !== 'boolean') core.fail(400, 'Invalid ingestion security settings');
  if (!Array.isArray(value.keys) || value.keys.length > LIMITS.keys) core.fail(400, 'Invalid ingestion keys');
  const ids = {};
  const hashes = {};
  const keys = value.keys.map(function (key) {
    core.object(key);
    if (typeof key.id !== 'string' || !/^[A-Za-z0-9]{24}$/.test(key.id) || ids[key.id] ||
        typeof key.hash !== 'string' || !/^[a-f0-9]{64}$/.test(key.hash) || hashes[key.hash] ||
        typeof key.prefix !== 'string' || !/^pbr_[A-Za-z0-9]{8}$/.test(key.prefix)) core.fail(400, 'Invalid ingestion key');
    ids[key.id] = true;
    hashes[key.hash] = true;
    return {
      id: key.id, label: core.text(key.label, 'key label', LIMITS.label, true), prefix: key.prefix,
      createdAt: core.integer(key.createdAt, 'key creation time', 1, Number.MAX_SAFE_INTEGER), hash: key.hash,
    };
  });
  if (value.requireApiKey && !keys.length) core.fail(400, 'Create an API key before requiring one');
  return { requireApiKey: value.requireApiKey, requireAccount: value.requireAccount, keys: keys };
}

function config(app) {
  let rows;
  try { rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: SETTINGS_KEY }); }
  catch (_) { core.fail(503, 'Ingestion security settings unavailable'); }
  const row = rows.find(function (item) { return item.getString('key') === SETTINGS_KEY; });
  if (!row) return defaults();
  try { return validate(JSON.parse(row.getString('value'))); }
  catch (_) { core.fail(503, 'Invalid ingestion security settings'); }
}

function metadata(key) { return { id: key.id, label: key.label, prefix: key.prefix, createdAt: key.createdAt }; }
function summary(value) { return { requireApiKey: value.requireApiKey, requireAccount: value.requireAccount, keys: value.keys.map(metadata) }; }

function check(app, body, accountId) {
  const cfg = config(app);
  if (cfg.requireApiKey) {
    const supplied = body.apiKey;
    if (typeof supplied !== 'string' || !/^pbr_[A-Za-z0-9]{64}$/.test(supplied)) core.fail(401, 'Invalid ingestion API key');
    const hash = $security.sha256(supplied);
    if (!cfg.keys.some(function (key) { return $security.equal(key.hash, hash); })) core.fail(401, 'Invalid ingestion API key');
  }
  if (accountId !== undefined) requireAccount(cfg, accountId);
  return cfg;
}

function requireAccount(cfg, accountId) {
  if (cfg.requireAccount && !accountId) core.fail(401, 'A verified account is required');
}

function admin(e) {
  if (!e.hasSuperuserAuth()) core.fail(e.auth ? 403 : 401, 'Superuser authentication required');
}

function readBody(e) {
  let raw;
  try { raw = readerToString(e.request.body); } catch (_) { core.fail(400, 'Unreadable body'); }
  if (!raw || raw.length > LIMITS.bodyBytes) core.fail(413, 'Body is too large');
  try { return core.object(JSON.parse(raw)); } catch (error) {
    if (error.status) throw error;
    core.fail(400, 'Invalid JSON');
  }
}

function save(app, value) {
  let row;
  const rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: SETTINGS_KEY });
  if (rows.length) row = rows[0];
  else {
    row = new Record(app.findCollectionByNameOrId('replay_settings'));
    row.set('key', SETTINGS_KEY);
  }
  row.set('value', JSON.stringify(validate(value)));
  app.save(row);
}

function getSettings(e) { admin(e); return summary(config(e.app)); }

function saveSettings(e) {
  admin(e);
  const body = readBody(e);
  if (typeof body.requireApiKey !== 'boolean' || typeof body.requireAccount !== 'boolean' || Object.keys(body).some(function (key) { return key !== 'requireApiKey' && key !== 'requireAccount'; })) core.fail(400, 'Supply only the two security toggles');
  let result;
  e.app.runInTransaction(function (tx) {
    const value = config(tx);
    value.requireApiKey = body.requireApiKey;
    value.requireAccount = body.requireAccount;
    save(tx, value);
    result = summary(value);
  });
  return result;
}

function createKey(e) {
  admin(e);
  const body = readBody(e);
  const label = core.text(body.label, 'key label', LIMITS.label, true).trim();
  if (!label || Object.keys(body).some(function (key) { return key !== 'label'; })) core.fail(400, 'Supply a key label');
  let result;
  e.app.runInTransaction(function (tx) {
    const value = config(tx);
    if (value.keys.length >= LIMITS.keys) core.fail(400, 'Too many ingestion keys');
    const apiKey = 'pbr_' + $security.randomString(64);
    const key = { id: $security.randomString(24), label: label, prefix: apiKey.slice(0, 12), createdAt: Date.now(), hash: $security.sha256(apiKey) };
    value.keys.push(key);
    save(tx, value);
    result = { key: metadata(key), apiKey: apiKey };
  });
  return result;
}

function revokeKey(e) {
  admin(e);
  const id = core.text(e.request.pathValue('id'), 'key id', 24, true);
  let result;
  e.app.runInTransaction(function (tx) {
    const value = config(tx);
    const remaining = value.keys.filter(function (key) { return key.id !== id; });
    if (remaining.length === value.keys.length) core.fail(404, 'Ingestion key not found');
    if (value.requireApiKey && !remaining.length) core.fail(400, 'Disable the API key requirement before revoking the last key');
    value.keys = remaining;
    save(tx, value);
    result = summary(value);
  });
  return result;
}

function route(e, name) {
  e.response.header().set('Cache-Control', 'no-store');
  e.response.header().set('X-Content-Type-Options', 'nosniff');
  try { return e.json(200, module.exports[name](e)); } catch (error) {
    if (error && error.status) return e.json(error.status, { message: error.message });
    throw error;
  }
}

module.exports = { check: check, requireAccount: requireAccount, getSettings: getSettings, saveSettings: saveSettings, createKey: createKey, revokeKey: revokeKey, route: route };
