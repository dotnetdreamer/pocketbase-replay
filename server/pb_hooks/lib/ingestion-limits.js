const core = require('./replay-core.js');

const REPLAY_DEFAULTS = {
  config_requests_per_ip_minute: 120, start_requests_per_ip_minute: 30,
  upload_requests_per_ip_minute: 240, upload_mb_per_ip_hour: 64,
  sessions_per_device_hour: 12, sessions_per_ip_hour: 120, sessions_per_hour: 3000,
};
const OBSERVABILITY_KEYS = [
  'config_requests_per_ip_minute', 'upload_requests_per_ip_minute', 'upload_mb_per_ip_hour',
  'sessions_per_device_hour', 'sessions_per_ip_hour', 'sessions_per_hour',
];
const SETTINGS_KEY = 'replay_limits';
const CACHE_KEY = 'replay:limits';

function fields(value, keys) {
  core.object(value);
  const result = {};
  Object.keys(value).forEach(function (key) {
    if (!keys.includes(key)) core.fail(400, 'Unknown ingestion limit: ' + key);
    result[key] = core.integer(value[key], key, 1, key === 'upload_mb_per_ip_hour' ? 1048576 : 1000000);
  });
  return result;
}

function readReplay(app) {
  let rows;
  try { rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: SETTINGS_KEY }); }
  catch (_) { core.fail(503, 'Replay rate limits unavailable'); }
  const row = rows.find(function (item) { return item.getString('key') === SETTINGS_KEY; });
  if (!row) return Object.assign({}, REPLAY_DEFAULTS);
  try { return Object.assign({}, REPLAY_DEFAULTS, fields(JSON.parse(row.getString('value')), Object.keys(REPLAY_DEFAULTS))); }
  catch (_) { core.fail(503, 'Invalid replay rate limits'); }
}

function replayConfig(app, fresh) {
  if (fresh) return readReplay(app);
  const store = app.store();
  const now = Date.now();
  try {
    const cached = JSON.parse(store.get(CACHE_KEY) || 'null');
    if (cached && cached.at > now - 5000 && cached.at <= now && cached.value) {
      return Object.assign({}, REPLAY_DEFAULTS, fields(cached.value, Object.keys(REPLAY_DEFAULTS)));
    }
  } catch (_) {}
  const value = readReplay(app);
  store.set(CACHE_KEY, JSON.stringify({ at: now, value: value }));
  return value;
}

function diagnostics(value) {
  const result = {};
  OBSERVABILITY_KEYS.forEach(function (key) { result[key] = value[key]; });
  return result;
}

function admin(e) {
  if (!e.hasSuperuserAuth()) core.fail(e.auth ? 403 : 401, 'Superuser authentication required');
}

function readBody(e) {
  let raw;
  try { raw = readerToString(e.request.body); } catch (_) { core.fail(400, 'Unreadable body'); }
  if (!raw || raw.length > 16384) core.fail(413, 'Body is too large');
  try { return core.object(JSON.parse(raw)); } catch (error) {
    if (error.status) throw error;
    core.fail(400, 'Invalid JSON');
  }
}

function patch(value) {
  const groups = Object.keys(value);
  if (!groups.length || groups.some(function (key) { return key !== 'replay' && key !== 'observability'; })) core.fail(400, 'Supply replay or observability rate limits');
  const result = {};
  groups.forEach(function (group) {
    const changed = fields(value[group], group === 'replay' ? Object.keys(REPLAY_DEFAULTS) : OBSERVABILITY_KEYS);
    if (!Object.keys(changed).length) core.fail(400, 'Supply at least one ' + group + ' rate limit');
    result[group] = changed;
  });
  return result;
}

function saveRow(app, key, value) {
  const rows = app.findRecordsByFilter('replay_settings', 'key = {:key}', '', 1, 0, { key: key });
  let row = rows[0];
  if (!row) {
    row = new Record(app.findCollectionByNameOrId('replay_settings'));
    row.set('key', key);
  }
  row.set('value', JSON.stringify(value));
  app.save(row);
}

function getSettings(e) {
  admin(e);
  const observability = require('./observability.js');
  return { replay: readReplay(e.app), observability: diagnostics(observability.config(e.app)) };
}

function saveSettings(e) {
  admin(e);
  const changed = patch(readBody(e));
  const observability = require('./observability.js');
  let replay;
  let telemetry;
  e.app.runInTransaction(function (tx) {
    replay = Object.assign(readReplay(tx), changed.replay || {});
    telemetry = Object.assign(observability.config(tx), changed.observability || {});
    if (changed.replay) saveRow(tx, SETTINGS_KEY, replay);
    if (changed.observability) saveRow(tx, 'observability', telemetry);
  });
  const now = Date.now();
  e.app.store().set(CACHE_KEY, JSON.stringify({ at: now, value: replay }));
  e.app.store().set('observability:settings', JSON.stringify({ at: now, value: telemetry }));
  return { replay: replay, observability: diagnostics(telemetry) };
}

function route(e, name) {
  e.response.header().set('Cache-Control', 'no-store');
  e.response.header().set('X-Content-Type-Options', 'nosniff');
  try { return e.json(200, module.exports[name](e)); } catch (error) {
    if (error && error.status) return e.json(error.status, { message: error.message });
    throw error;
  }
}

module.exports = { replayConfig: replayConfig, getSettings: getSettings, saveSettings: saveSettings, route: route };
