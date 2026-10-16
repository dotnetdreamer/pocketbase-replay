const base = require('./replay-core.js');
const core = require('./pocketbase-core.js');

const WINDOW_MS = 15 * 60000;
const MAX_WINDOW_MS = 12 * 3600000;
const BODY_BYTES = 65536;
const MAX_REQUESTS = 200;
const MAX_RECORD_LOOKUPS = 50;

function admin(e) {
  if (!e.hasSuperuserAuth()) base.fail(e.auth ? 403 : 401, 'Superuser authentication required');
}

function readBody(e) {
  let raw;
  try { raw = readerToString(e.request.body); } catch (_) { base.fail(400, 'Unreadable body'); }
  if (!raw || raw.length > BODY_BYTES) base.fail(413, 'Body is too large');
  try { return base.object(JSON.parse(raw)); } catch (error) {
    if (error.status) throw error;
    base.fail(400, 'Invalid JSON');
  }
}

// Puts the call's ID into PocketBase's own request log, beside any meta set before. The request hooks call it,
// and so can an app's own routes. Never throws.
function link(e, value) {
  try {
    const parsed = core.header(value);
    if (!parsed) return;
    const meta = {};
    const current = e.get('pbLogMeta');
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      for (const key of Object.keys(current)) meta[key] = current[key];
    }
    meta.replayRequest = parsed.request;
    if (parsed.session) meta.replaySession = parsed.session;
    e.set('pbLogMeta', meta);
  } catch (_) { /* The request goes on without its ID. */ }
}

function probe() { return { ok: true }; }

function placeholders(prefix, values, params) {
  return values.map(function (value, index) {
    params[prefix + index] = value;
    return '{:' + prefix + index + '}';
  }).join(', ');
}

// PocketBase's request log rows for these calls, found through its hour index on `created`.
function logRows(app, ids, from, to) {
  const params = { from: core.logTime(from), to: core.logTime(to) };
  const rows = arrayOf(new DynamicModel({ data: '', created: '' }));
  const requests = placeholders('request', ids, params);
  const marked = core.tracingEnabled()
    ? " OR (instr(replace(json_extract(data, '$.url'), '?', '&'), '&__replayRequest=') > 0 AND substr(replace(json_extract(data, '$.url'), '?', '&'), instr(replace(json_extract(data, '$.url'), '?', '&'), '&__replayRequest=') + 17, 20) IN (" + requests + '))'
    : '';
  app.auxDB().newQuery("SELECT data, created FROM _logs WHERE strftime('%Y-%m-%d %H:00:00', created) IN (" + placeholders('hour', core.hours(from, to), params) +
    ") AND created >= {:from} AND created <= {:to} AND (json_extract(data, '$.meta.replayRequest') IN (" + requests + ')' + marked + ') LIMIT 400').bind(params).all(rows);
  const found = {};
  for (let i = 0; i < rows.length; i++) {
    let data;
    try { data = JSON.parse(rows[i].data); } catch (_) { continue; }
    const linked = data && core.correlation(data);
    const id = linked && linked.request;
    if (typeof id === 'string' && !found[id]) found[id] = data;
  }
  return found;
}

// Server errors the log scan stored for these calls.
function issueRows(app, ids, from, to) {
  const params = { from: from, to: to };
  const rows = arrayOf(new DynamicModel({ request: '', issue: '', title: '' }));
  app.db().newQuery("SELECT json_extract(e.attributes, '$.requestId') AS request, e.issue AS issue, i.title AS title FROM replay_errors e JOIN replay_issues i ON i.id = e.issue " +
    "WHERE e.deviceId = 'pocketbase' AND e.timestamp >= {:from} AND e.timestamp <= {:to} AND json_extract(e.attributes, '$.requestId') IN (" + placeholders('request', ids, params) +
    ') ORDER BY e.timestamp LIMIT 400').bind(params).all(rows);
  const found = {};
  for (let i = 0; i < rows.length; i++) if (!found[rows[i].request]) found[rows[i].request] = { id: rows[i].issue, title: rows[i].title };
  return found;
}

// Explains failed calls of one recording from what this PocketBase knows: its request log, the collection's
// current API rule, whether a hidden record exists, and any server error stored for the call.
function explain(e) {
  admin(e);
  const body = readBody(e);
  const sessionId = base.text(body.sessionId, 'sessionId', 15, true);
  if (!/^[a-z0-9]{15}$/.test(sessionId)) base.fail(400, 'Invalid sessionId');
  if (!Array.isArray(body.requests) || body.requests.length > MAX_REQUESTS) base.fail(400, 'Invalid requests');
  let session;
  try { session = e.app.findRecordById('replay_sessions', sessionId); } catch (_) { base.fail(404, 'Replay session not found'); }
  const started = session.getFloat('startedAt');
  const from = started - WINDOW_MS;
  const to = Math.min(Math.max(started, session.getFloat('lastSeenAt'), session.getFloat('endedAt')) + WINDOW_MS, from + MAX_WINDOW_MS);
  const items = [];
  const ids = [];
  body.requests.forEach(function (value) {
    const item = core.explainInput(value);
    if (!item) return;
    items.push(item);
    if (ids.indexOf(item.request) < 0) ids.push(item.request);
  });
  const result = { logs: true, items: [] };
  try {
    const logs = e.app.settings().logs;
    if (logs && logs.maxDays === 0) result.logs = false;
  } catch (_) { /* Unknown settings leave the answer to the log read. */ }
  let logs = {};
  let issues = {};
  if (ids.length) {
    try { logs = logRows(e.app, ids, from, to); } catch (_) { result.logs = false; }
    try { issues = issueRows(e.app, ids, from, to); } catch (_) { issues = {}; }
  }
  const collections = {};
  function collectionOf(name) {
    if (!Object.prototype.hasOwnProperty.call(collections, name)) {
      try { collections[name] = e.app.findCachedCollectionByNameOrId(name); } catch (_) { collections[name] = null; }
    }
    return collections[name];
  }
  const records = {};
  let lookups = 0;
  items.forEach(function (item) {
    const answer = { request: item.request };
    const logged = logs[item.request] ? core.logInfo(logs[item.request]) : null;
    if (logged) answer.server = logged.server;
    const collection = item.collection ? collectionOf(item.collection) : null;
    const name = collection ? core.ruleName(item.action, String(collection.type)) : '';
    if (name) {
      const expression = collection[name];
      // An API rule is a *string; JavaScript sees null for a locked rule and a string-like object otherwise.
      answer.rule = { name: name, expression: expression === null || expression === undefined ? null : String(expression) };
    }
    const status = logged ? logged.server.status : item.status;
    if (collection && item.record && status === 404 && ['view', 'update', 'delete'].indexOf(item.action) >= 0) {
      const key = item.collection + '/' + item.record;
      if (!Object.prototype.hasOwnProperty.call(records, key) && lookups < MAX_RECORD_LOOKUPS) {
        lookups++;
        try {
          e.app.findRecordById(item.collection, item.record);
          records[key] = 'exists';
        } catch (error) {
          records[key] = /no rows in result set/.test(String(error && error.message || error)) ? 'missing' : '';
        }
      }
      if (records[key]) answer.record = records[key];
    }
    if (issues[item.request]) answer.issue = issues[item.request];
    const facts = {
      action: item.action, status: item.status, items: item.items, server: answer.server, thrown: !!(logged && logged.thrown),
      rule: answer.rule, record: answer.record, issue: answer.issue, message: item.message, fields: item.fields,
      ruleFailure: !!(logged && logged.ruleFailure),
    };
    const verdict = core.verdict(facts);
    // Only when nothing certain applies; the answer then says it is a guess.
    const guess = verdict ? '' : core.inferred(facts);
    if (verdict || guess) answer.verdict = verdict || guess;
    if (guess) answer.likely = true;
    result.items.push(answer);
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

module.exports = { link: link, probe: probe, explain: explain, route: route };
