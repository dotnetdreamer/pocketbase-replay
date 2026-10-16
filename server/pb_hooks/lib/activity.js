// Reads recordings into replay_activity, chunk by chunk and in order, so agents get a recording as text without
// downloading it. Decoding runs in PocketBase's JavaScript engine at roughly 3 MB of recorded events a second,
// so each run has a time budget, resumes where the last one stopped, and saves its work in one short transaction.
const core = require('./activity-core.js');
const gzip = require('./gzip.js');

const LIMITS = {
  // Activity stored for one chunk; a chunk holding more keeps its first items and a note.
  rowItems: 4000, rowChars: 1900000,
  // A larger page state is dropped: clicks are then unnamed until the next full snapshot.
  checkpointChars: 15000000,
  // A run holding the lock longer than this is treated as gone.
  lockMs: 120000,
  // Decoding time all runs may spend each minute together, so agents cannot keep the server busy.
  minuteMs: 45000,
  summaryPages: 25, summaryChars: 19000,
  // A recording whose reading failed is retried by the minute job after this long; an agent can retry at once.
  failedRetryMs: 6 * 3600000,
};

function installed(app) {
  try { app.findCachedCollectionByNameOrId('replay_activity_state'); return true; } catch (_) { return false; }
}

function unreadable(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

// One recorded chunk as its events, checked as the dashboard player checks it. Failures carry a fixed reason:
// a parser's own message can quote the recording, which a device wrote.
function decode(row) {
  if (row.getString('encoding') !== 'gzip-base64') throw unreadable('it uses an unknown encoding');
  const size = row.getInt('rawBytes');
  if (!(size >= 2 && size <= 2 * 1024 * 1024)) throw unreadable('its size is invalid');
  let bytes;
  try { bytes = gzip.gunzip(gzip.base64(row.getString('data')), size); } catch (_) { throw unreadable('its compressed data is damaged'); }
  let events;
  try { events = JSON.parse(toString(bytes)); } catch (_) { throw unreadable('its events are not valid JSON'); }
  if (!Array.isArray(events) || events.length > 50000) throw unreadable('it holds no list of events');
  return events;
}

function lock(app, key) {
  const now = Date.now();
  const token = $security.randomString(16);
  let mine = false;
  app.store().setFunc(key, function (old) {
    const until = typeof old === 'string' ? Number(old.split(':')[0]) : 0;
    if (until > now) return old;
    mine = true;
    return (now + LIMITS.lockMs) + ':' + token;
  });
  return mine ? token : '';
}

function unlock(app, key, token) {
  const store = app.store();
  store.setFunc(key, function (old) { return typeof old === 'string' && old.endsWith(':' + token) ? '' : old; });
  // Removed once released, so the store does not keep one entry for every recording ever read.
  if (store.get(key) === '') store.remove(key);
}

function budgetState(old, minute) {
  let state;
  try { state = JSON.parse(old || '{}') || {}; } catch (_) { state = {}; }
  return state.minute === minute ? state : { minute: minute, ms: 0 };
}

// What is left of this minute's decoding time, shared by all runs. A quick check before taking the lock.
function budget(app) {
  const state = budgetState(app.store().get('activity:budget'), Math.floor(Date.now() / 60000));
  return Math.max(0, LIMITS.minuteMs - (Number(state.ms) || 0));
}

// Takes up to `wanted` milliseconds of this minute's decoding time at once, so runs started together cannot each
// spend the whole minute. settle() then charges what the run really used, refunding the rest.
function reserve(app, wanted) {
  const minute = Math.floor(Date.now() / 60000);
  let granted = 0;
  app.store().setFunc('activity:budget', function (old) {
    const state = budgetState(old, minute);
    granted = Math.max(0, Math.min(wanted, LIMITS.minuteMs - (Number(state.ms) || 0)));
    state.ms = (Number(state.ms) || 0) + granted;
    return JSON.stringify(state);
  });
  return { minute: minute, ms: granted };
}

function settle(app, grant, used) {
  app.store().setFunc('activity:budget', function (old) {
    const state = budgetState(old, Math.floor(Date.now() / 60000));
    if (state.minute === grant.minute) state.ms = Math.max(0, (Number(state.ms) || 0) + used - grant.ms);
    return JSON.stringify(state);
  });
}

// The reading progress of a recording without its page state, which can be megabytes.
function progressOf(app, sessionId) {
  const rows = arrayOf(new DynamicModel({ status: '', chunks: 0, seq: 0, error: '', summary: '', updatedAt: -0 }));
  app.db().newQuery('SELECT status, chunks, seq, error, summary, updatedAt FROM replay_activity_state WHERE session = {:id} LIMIT 1').bind({ id: sessionId }).all(rows);
  return rows.length ? rows[0] : null;
}

function stateRow(app, sessionId) {
  const rows = app.findRecordsByFilter('replay_activity_state', 'session = {:id}', '', 1, 0, { id: sessionId });
  return rows.length ? rows[0] : null;
}

function emptySummary() {
  return { items: 0, errors: 0, clicks: 0, inputs: 0, pages: [], pocketbaseFailures: 0, networkFailures: 0, consoleErrors: 0, triggers: [] };
}

function readSummary(text) {
  try { return Object.assign(emptySummary(), JSON.parse(text || '{}')); } catch (_) { return emptySummary(); }
}

// Page and trigger text as plain characters, so a device's control characters cannot swell the stored summary.
function plain(value, max) {
  return core.clip(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' '), max);
}

function summarize(summary, items) {
  for (const item of items) {
    summary.items++;
    if (item.severity === 'error') summary.errors++;
    if (item.kind === 'click') summary.clicks++;
    else if (item.kind === 'input') summary.inputs++;
    else if (item.kind === 'navigation') {
      const page = plain(item.title, 200);
      if (summary.pages.indexOf(page) < 0 && summary.pages.length < LIMITS.summaryPages) summary.pages.push(page);
    } else if (item.kind === 'pocketbase' && item.severity === 'error') summary.pocketbaseFailures++;
    else if (item.kind === 'network' && item.severity === 'error') summary.networkFailures++;
    else if (item.kind === 'console' && item.severity === 'error') summary.consoleErrors++;
    else if (item.kind === 'trigger' && summary.triggers.length < 10) summary.triggers.push(plain(item.title, 140));
  }
  return summary;
}

// The summary as stored, within its field: the last pages and triggers give way first.
function summaryText(summary) {
  let text = JSON.stringify(summary);
  while (text.length > LIMITS.summaryChars && (summary.pages.length || summary.triggers.length)) {
    if (summary.triggers.length) summary.triggers.pop(); else summary.pages.pop();
    text = JSON.stringify(summary);
  }
  return text;
}

// The activity row of one chunk, kept within its field's size.
function rowItems(items) {
  let kept = items.length > LIMITS.rowItems ? items.slice(0, LIMITS.rowItems) : items;
  let json = JSON.stringify(kept);
  while (json.length > LIMITS.rowChars && kept.length > 1) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    json = JSON.stringify(kept);
  }
  if (kept.length < items.length) {
    kept = kept.concat([{ kind: 'console', timestamp: items[kept.length].timestamp, title: (items.length - kept.length) + ' more activity entries in this part were not kept', severity: 'warn', level: 'warn', skipped: true }]);
    json = JSON.stringify(kept);
  }
  return { json: json, items: kept };
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
// Rows per INSERT statement, and the text one statement carries before the next one starts.
const BATCH_ROWS = 50;
const BATCH_CHARS = 4000000;

// Plain multi-row INSERTs, as for source maps: a record save per chunk would cost seconds on a long recording.
function insert(tx, sessionId, rows) {
  let at = 0;
  while (at < rows.length) {
    const params = { session: sessionId };
    const groups = [];
    let chars = 0;
    while (at < rows.length && groups.length < BATCH_ROWS && (!groups.length || chars < BATCH_CHARS)) {
      const row = rows[at];
      const n = groups.length;
      params['id' + n] = $security.randomStringWithAlphabet(15, ID_ALPHABET);
      params['seq' + n] = row.seq;
      params['startedAt' + n] = row.startedAt;
      params['endedAt' + n] = row.endedAt;
      params['items' + n] = row.json;
      params['count' + n] = row.count;
      params['errors' + n] = row.errors;
      groups.push('({:id' + n + '}, {:session}, {:seq' + n + '}, {:startedAt' + n + '}, {:endedAt' + n + '}, {:items' + n + '}, {:count' + n + '}, {:errors' + n + '})');
      chars += row.json.length;
      at++;
    }
    tx.db().newQuery('INSERT INTO replay_activity (id, session, seq, startedAt, endedAt, items, count, errors) VALUES ' + groups.join(', ')).bind(params).execute();
  }
}

function clear(tx, sessionId) {
  tx.db().newQuery('DELETE FROM replay_activity WHERE session = {:id}').bind({ id: sessionId }).execute();
  tx.db().newQuery('DELETE FROM replay_activity_state WHERE session = {:id}').bind({ id: sessionId }).execute();
}

// Reads a recording on from where its last run stopped, until it is done or `deadline` passes. Answers its
// progress: { status: 'complete' | 'partial' | 'busy' | 'missing', chunks, total }.
function index(app, sessionId, deadline) {
  if (!installed(app)) return { status: 'missing', chunks: 0, total: 0 };
  let session;
  try { session = app.findRecordById('replay_sessions', sessionId); } catch (_) { return { status: 'missing', chunks: 0, total: 0 }; }
  const total = session.getInt('chunkCount');
  const known = progressOf(app, sessionId);
  // An upload can still add chunks until its credential expires; until then the page state is kept.
  const open = session.getFloat('expiresAt') > Date.now();
  // Nothing new to read. A finished recording read while it was open is still closed off below, dropping its page state.
  if (known && Number(known.chunks) >= total && (known.status === 'complete' || open)) return { status: 'complete', chunks: total, total: total };
  const read = known ? Number(known.chunks) : 0;
  if (budget(app) < 250) return { status: 'busy', chunks: read, total: total };
  const key = 'activity:lock:' + sessionId;
  const token = lock(app, key);
  if (!token) return { status: 'busy', chunks: read, total: total };
  const started = Date.now();
  const grant = reserve(app, Math.max(0, deadline - started));
  try {
    if (grant.ms < 250) return { status: 'busy', chunks: read, total: total };
    let state = stateRow(app, sessionId);
    let next = state ? state.getInt('seq') : 0;
    let done = state ? state.getInt('chunks') : 0;
    let saved = null;
    if (state && state.getString('checkpoint')) {
      try { saved = JSON.parse(state.getString('checkpoint')); } catch (_) { saved = null; }
    }
    // A chunk that arrived late, behind chunks already read, means reading again from the start.
    if (state && next > 0) {
      const counted = new DynamicModel({ total: 0 });
      app.db().newQuery('SELECT COUNT(*) AS total FROM replay_chunks WHERE session = {:id} AND seq < {:seq}').bind({ id: sessionId, seq: next }).one(counted);
      // Without its page state, a half-read recording is read again too, so its clicks keep their names.
      if (Number(counted.total) !== done || (done && !saved)) {
        app.runInTransaction(function (tx) { clear(tx, sessionId); });
        state = null; next = 0; done = 0; saved = null;
      }
    }
    const collector = core.createCollector(saved);
    const summary = state ? readSummary(state.getString('summary')) : emptySummary();
    const rows = [];
    let previous = next - 1;
    const end = Math.min(deadline, started + grant.ms);
    let error = state ? state.getString('error') : '';
    while (Date.now() < end) {
      const chunks = app.findRecordsByFilter('replay_chunks', 'session = {:id} && seq >= {:seq}', 'seq', 1, 0, { id: sessionId, seq: next });
      if (!chunks.length) break;
      const chunk = chunks[0];
      const seq = chunk.getInt('seq');
      if (seq !== previous + 1) collector.gap();
      let events = null;
      try { events = decode(chunk); } catch (problem) {
        error = 'Part ' + seq + ' could not be read: ' + (problem && problem.reason ? problem.reason : 'it could not be decoded');
        collector.gap();
      }
      if (events) for (let i = 0; i < events.length; i++) collector.add(events[i]);
      const items = collector.take();
      const stored = rowItems(items);
      summarize(summary, stored.items);
      rows.push({ seq: seq, startedAt: chunk.getFloat('startedAt'), endedAt: chunk.getFloat('endedAt'), json: stored.json, count: stored.items.length,
        errors: stored.items.filter(function (item) { return item.severity === 'error'; }).length });
      previous = seq;
      next = seq + 1;
      done++;
    }
    const complete = done >= total && !open;
    let checkpoint = '';
    if (!complete) {
      checkpoint = JSON.stringify(collector.save());
      // A page too large to carry over is left out; clicks are named again after the next full snapshot.
      if (checkpoint.length > LIMITS.checkpointChars) {
        const light = collector.save();
        light.dom = { nodes: [], stale: true };
        checkpoint = JSON.stringify(light);
      }
    }
    let gone = false;
    function save(tx, values) {
      let current = stateRow(tx, sessionId);
      if (!current) {
        current = new Record(tx.findCollectionByNameOrId('replay_activity_state'));
        current.set('session', sessionId);
      }
      for (const field of Object.keys(values)) current.set(field, values[field]);
      current.set('updatedAt', Date.now());
      tx.save(current);
    }
    try {
      app.runInTransaction(function (tx) {
        // A recording deleted while it was being read keeps nothing of it.
        try { tx.findRecordById('replay_sessions', sessionId); } catch (_) { gone = true; return; }
        // Rows left over from a reading whose state was lost are replaced, never duplicated.
        if (rows.length) tx.db().newQuery('DELETE FROM replay_activity WHERE session = {:id} AND seq >= {:seq}').bind({ id: sessionId, seq: rows[0].seq }).execute();
        insert(tx, sessionId, rows);
        save(tx, { seq: next, chunks: done, status: complete ? 'complete' : 'partial', checkpoint: checkpoint, summary: summaryText(summary), error: error.slice(0, 500) });
      });
    } catch (problem) {
      // A reading that cannot be saved is marked, so the minute job does not try it again and again.
      console.warn('replay: reading recording ' + sessionId + ' for agents failed: ' + problem);
      try {
        app.runInTransaction(function (tx) {
          try { tx.findRecordById('replay_sessions', sessionId); } catch (_) { return; }
          clear(tx, sessionId);
          save(tx, { seq: 0, chunks: 0, status: 'failed', checkpoint: '', summary: '', error: 'Its activity could not be saved' });
        });
      } catch (_) { /* Tried again on a later request. */ }
      return { status: 'failed', chunks: 0, total: total };
    }
    if (gone) return { status: 'missing', chunks: 0, total: 0 };
    return { status: done >= total ? 'complete' : 'partial', chunks: done, total: total };
  } finally {
    settle(app, grant, Date.now() - started);
    unlock(app, key, token);
  }
}

// The stored activity of a recording in recorded order, from `from` to `to` (device clock times; either may be
// left out), and at most `limit` entries. `more` tells whether entries in that range were left out.
function items(app, sessionId, from, to, limit) {
  const max = Number.isInteger(limit) && limit > 0 ? limit : Infinity;
  const result = [];
  let more = false;
  let seq = -1;
  // Rows are read a few at a time, so a long recording's first entries cost little.
  for (;;) {
    const params = { id: sessionId, seq: seq };
    let where = 'session = {:id} AND seq > {:seq}';
    if (Number.isFinite(from)) { params.from = from; where += ' AND endedAt >= {:from}'; }
    if (Number.isFinite(to)) { params.to = to; where += ' AND startedAt <= {:to}'; }
    const rows = arrayOf(new DynamicModel({ seq: 0, items: '' }));
    app.db().newQuery('SELECT seq, items FROM replay_activity WHERE ' + where + ' ORDER BY seq LIMIT 8').bind(params).all(rows);
    for (let i = 0; i < rows.length; i++) {
      seq = Number(rows[i].seq);
      let list;
      try { list = JSON.parse(rows[i].items); } catch (_) { continue; }
      for (const item of Array.isArray(list) ? list : []) {
        if ((Number.isFinite(from) && item.timestamp < from) || (Number.isFinite(to) && item.timestamp > to)) continue;
        if (result.length >= max) { more = true; break; }
        result.push(item);
      }
      if (more) break;
    }
    if (more || rows.length < 8) break;
  }
  return { items: result, more: more };
}

// Progress and summary of a recording's reading, or null when it was never read.
function status(app, sessionId) {
  if (!installed(app)) return null;
  const row = progressOf(app, sessionId);
  if (!row) return null;
  return { status: row.status, chunks: Number(row.chunks), error: row.error, summary: readSummary(row.summary), updatedAt: Number(row.updatedAt) };
}

// Raw SQL deletes skip PocketBase's cascade, so whoever deletes recordings that way removes their activity too.
function removeFor(tx, where, params) {
  if (!installed(tx)) return;
  tx.db().newQuery('DELETE FROM replay_activity WHERE session IN (SELECT id FROM replay_sessions WHERE ' + where + ')').bind(params).execute();
  tx.db().newQuery('DELETE FROM replay_activity_state WHERE session IN (SELECT id FROM replay_sessions WHERE ' + where + ')').bind(params).execute();
}

// Reads recordings agents are most likely to ask about, while agent access is set up: those linked to an error
// in the last week, newest first, then ones still half read. Runs from the minute cron within its own budget.
function sweep(app, deadline) {
  if (!installed(app)) return 0;
  const keys = new DynamicModel({ total: 0 });
  app.db().newQuery('SELECT COUNT(*) AS total FROM replay_mcp_keys WHERE expiresAt = 0 OR expiresAt > {:now}').bind({ now: Date.now() }).one(keys);
  if (!Number(keys.total)) return 0;
  const mode = ($os.getenv('REPLAY_MCP_INDEX') || 'errors').trim().toLowerCase();
  if (mode === 'off') return 0;
  const now = Date.now();
  // Recordings read in full while uploads were still open are closed off once they can no longer grow.
  app.db().newQuery("UPDATE replay_activity_state SET status = 'complete', checkpoint = '' WHERE status = 'partial' AND EXISTS (SELECT 1 FROM replay_sessions s " +
    'WHERE s.id = replay_activity_state.session AND s.expiresAt <= {:now} AND s.chunkCount <= replay_activity_state.chunks)').bind({ now: now }).execute();
  const since = now - 7 * 86400000;
  const candidates = arrayOf(new DynamicModel({ id: '' }));
  // Read in full so far, or failed recently: either way not a candidate, so newer recordings cannot crowd out older ones.
  const unread = "s.chunkCount > 0 AND NOT EXISTS (SELECT 1 FROM replay_activity_state a WHERE a.session = s.id AND (a.chunks >= s.chunkCount OR (a.status = 'failed' AND a.updatedAt > {:retry})))";
  // Errors arrive within seconds of their recording, so only recordings that already had a minute to finish are read.
  const settled = 's.lastSeenAt < {:settled}';
  const linked = mode === 'all' ? 's.startedAt >= {:since}'
    : "s.startedAt >= {:since} AND (s.trigger != '' OR EXISTS (SELECT 1 FROM replay_errors e WHERE e.sessionId = s.id AND e.timestamp >= {:since}))";
  let errorsInstalled = true;
  try { app.findCachedCollectionByNameOrId('replay_errors'); } catch (_) { errorsInstalled = false; }
  const filter = errorsInstalled || mode === 'all' ? linked : "s.startedAt >= {:since} AND s.trigger != ''";
  app.db().newQuery('SELECT s.id AS id FROM replay_sessions s WHERE ' + unread + ' AND ' + settled + ' AND ' + filter + ' ORDER BY s.startedAt DESC LIMIT 20')
    .bind({ since: since, settled: now - 60000, retry: now - LIMITS.failedRetryMs }).all(candidates);
  let read = 0;
  for (let i = 0; i < candidates.length && Date.now() < deadline; i++) {
    try {
      const result = index(app, candidates[i].id, deadline);
      if (result.status === 'complete' || result.status === 'partial') read++;
    } catch (error) { console.warn('replay: recording ' + candidates[i].id + ' could not be read for agents: ' + error); }
  }
  return read;
}

module.exports = { LIMITS: LIMITS, installed: installed, decode: decode, index: index, items: items, status: status, removeFor: removeFor, sweep: sweep, budget: budget };
