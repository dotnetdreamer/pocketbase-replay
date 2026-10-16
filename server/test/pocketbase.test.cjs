const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../pb_hooks/lib/pocketbase-core.js');
const pocketbase = require('../pb_hooks/lib/pocketbase.js');
const observability = require('../pb_hooks/lib/observability.js');
const observabilityCore = require('../pb_hooks/lib/observability-core.js');
const replay = require('../pb_hooks/lib/replay.js');
const replayCore = require('../pb_hooks/lib/replay-core.js');
const { fixture, exception } = require('./helpers/observability-fixture.cjs');

const REQUEST = 'abcdefghij0123456789';
const id = n => 'r' + String(n).padStart(19, '0');
const logTime = ms => new Date(ms).toISOString().replace('T', ' ');
const TYPE_ERROR = "TypeError: Cannot read property 'boom' of undefined or null at /srv/app/pb.js:2:65(13)";

// A request row as PocketBase 0.39.9 logs it, with the meta the request hooks add.
function requestData(patch) {
  return {
    type: 'request', auth: 'users', execTime: 1.26, method: 'POST', url: '/api/collections/orders/records?expand=user', status: 0, error: TYPE_ERROR,
    referer: 'https://app.test/page?private=1', remoteIP: '203.0.113.9', userIP: '198.51.100.7', userAgent: 'Mozilla/5.0', meta: { replayRequest: REQUEST }, ...patch,
  };
}
function requestRow(patch, created) {
  return { id: 'row000000000001', level: 8, message: 'POST /api/collections/orders/records', data: JSON.stringify(requestData(patch)), created: logTime(created || Date.now()) };
}

function session(f, accountId, patch) {
  const row = new Record(f.app.findCollectionByNameOrId('replay_sessions'));
  const at = Date.now();
  for (const [key, value] of Object.entries({ deviceId: 'device', accountId: accountId || '', platform: 'web', tokenHash: 'x'.repeat(64), ipHash: 'y'.repeat(64), startedAt: at, lastSeenAt: at, expiresAt: at + 3600000, chunkCount: 1, ...patch })) row.set(key, value);
  f.app.save(row);
  return row;
}

function collection(f, value) {
  const item = { type: 'base', listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, fields: [{ name: 'total', type: 'number' }], ...value };
  f.app.save(item);
  return item;
}

function record(f, name) {
  const row = new Record(f.app.findCollectionByNameOrId(name));
  f.app.save(row);
  return row;
}

function errorRows(f) {
  return f.records('replay_errors', "deviceId = 'pocketbase'", 'timestamp,id').map(row => ({ ...row.data, attributes: JSON.parse(row.data.attributes) }));
}

function cursor(f) {
  return JSON.parse(f.records('replay_settings', "key = 'observability:log-cursor'")[0].getString('value'));
}

function withClock(start, run) {
  const realNow = Date.now;
  let clock = start;
  Date.now = () => clock;
  try { return run(value => { clock = value; }); } finally { Date.now = realNow; }
}

// Advance beyond the actual enable boundary, then scan real log timestamps past the batch lag.
function scanned(f, rows, options) {
  const start = Date.now() + 60000;
  return withClock(start, set => {
    observability.sweep(f.app);
    const ids = rows.map(row => f.log({ created: start - 5000, ...row }));
    set(start + 30000);
    if (options && options.before) options.before();
    observability.sweep(f.app);
    return ids;
  });
}

test('the correlation header is a 20-character request ID with an optional 15-character session ID, nothing else', () => {
  assert.deepEqual(core.header(REQUEST), { request: REQUEST, session: '' });
  assert.deepEqual(core.header(REQUEST + '.abc123def456ghi'), { request: REQUEST, session: 'abc123def456ghi' });
  for (const value of [REQUEST.slice(1), REQUEST + 'x', REQUEST.toUpperCase(), REQUEST + '.', REQUEST + '.abc123def456gh', REQUEST + '.abc123def456ghij',
    REQUEST + '.ABC123DEF456GHI', ' ' + REQUEST, REQUEST + '\n', REQUEST + ',' + REQUEST, '', null, undefined, 42, { request: REQUEST }]) {
    assert.equal(core.header(value), null, JSON.stringify(value));
  }
});

test('API paths name the same collection, action and record as on the client, without query or hash', () => {
  const cases = [
    ['GET', '/api/collections/orders/records?filter=(total>1)&page=2', { collection: 'orders', action: 'list' }],
    ['POST', '/api/collections/orders/records', { collection: 'orders', action: 'create' }],
    ['GET', '/api/collections/orders/records/abc123#top', { collection: 'orders', action: 'view', record: 'abc123' }],
    ['PATCH', '/api/collections/orders/records/a_b-c', { collection: 'orders', action: 'update', record: 'a_b-c' }],
    ['delete', '/api/collections/orders/records/abc123', { collection: 'orders', action: 'delete', record: 'abc123' }],
    ['POST', '/api/collections/users/auth-with-password', { collection: 'users', action: 'auth-with-password' }],
    ['GET', '/api/collections/users/auth-methods', { collection: 'users', action: 'auth-methods' }],
    ['POST', '/api/collections/users/confirm-email-change', { collection: 'users', action: 'confirm-email-change' }],
    ['POST', '/api/collections/_superusers/impersonate/u1', { collection: '_superusers', action: 'impersonate', record: 'u1' }],
    ['POST', '/api/batch', { action: 'batch' }],
    ['POST', '/api/realtime', { action: 'realtime' }],
    ['POST', '/api/files/token', { action: 'file-token' }],
    ['PUT', '/api/collections/orders/records', {}],
    ['POST', '/api/collections/orders/records/abc123', {}],
    ['GET', '/api/collections/orders/impersonate/u1', {}],
    ['POST', '/api/collections/users/unknown-action', {}],
    ['GET', '/api/batch', {}],
    ['GET', '/api/collections/bad-name/records', {}],
    ['GET', '/api/collections/orders/records/' + 'x'.repeat(129), {}],
    ['GET', '/api/collections/orders/records/', {}],
    ['GET', '/api/health', {}],
    ['POST', '__proto__', {}],
  ];
  for (const [method, input, expected] of cases) {
    const result = core.request(method, input);
    const { method: verb, path: clean, ...named } = result;
    assert.deepEqual(named, expected, method + ' ' + input);
    assert.equal(verb, method.toUpperCase());
    assert.equal(clean.includes('?') || clean.includes('#'), false);
  }
  assert.equal(core.ruleName('list', 'base'), 'listRule');
  assert.equal(core.ruleName('delete', 'auth'), 'deleteRule');
  for (const action of ['auth-with-password', 'auth-with-otp', 'auth-with-oauth2', 'auth-refresh']) assert.equal(core.ruleName(action, 'auth'), 'authRule');
  assert.equal(core.ruleName('auth-with-password', 'base'), '');
  for (const action of ['auth-methods', 'request-otp', 'batch', 'impersonate', 'constructor', '']) assert.equal(core.ruleName(action, 'auth'), '');
});

test('a request row becomes a server error only when PocketBase did not mean its answer', () => {
  for (const status of [400, 401, 403, 404, 413, 429, 499]) assert.equal(core.logError(requestRow({ status, error: 'Expected.' })), null, String(status));
  // PocketBase answers these with 404, wrapped or not, and a client that went away is no server fault.
  for (const error of ['sql: no rows in result set', 'failed to load order: sql: no rows in result set', 'open logo.png: file does not exist',
    'write tcp 10.0.0.5:8090->198.51.100.7:51234: write: broken pipe', 'read: connection reset by peer', 'context canceled']) {
    assert.equal(core.logError(requestRow({ status: 0, error })), null, error);
  }
  assert.equal(core.logError(requestRow({ status: 0, error: '' })), null);
  assert.equal(core.logError(requestRow({ status: 500, error: 'sql: no rows in result set' })), null);
  const hook = core.logError(requestRow({ authId: 'alice', meta: { replayRequest: REQUEST, replaySession: 'abc123def456ghi' } }));
  assert.deepEqual(hook, {
    eventId: 'log-row000000000001', timestamp: hook.timestamp, accountId: 'alice', sessionId: 'abc123def456ghi',
    name: 'TypeError', message: "Cannot read property 'boom' of undefined or null", stack: "TypeError: Cannot read property 'boom' of undefined or null\n    at pb.js:2:65",
    attributes: { source: 'request', method: 'POST', path: '/api/collections/orders/records', status: 400, collection: 'orders', action: 'create', requestId: REQUEST, auth: 'users' },
  });
  // A Go error has no goja position, so its first word is no name.
  assert.deepEqual(core.logError(requestRow({ error: 'json: cannot unmarshal number into Go value' })).name, 'GoError');
  assert.equal(core.logError(requestRow({ error: 'json: cannot unmarshal number into Go value' })).message, 'json: cannot unmarshal number into Go value');
  assert.equal(core.logError(requestRow({ error: 'database is locked' })).stack, '');
  const internal = core.logError(requestRow({ status: 500, error: 'Something went wrong while processing your request.', details: 'database is locked', method: 'GET', url: '/api/collections/orders/records/abc?x=1' }));
  assert.equal(internal.name, 'ApiError');
  assert.equal(internal.message, 'Something went wrong while processing your request: database is locked');
  assert.deepEqual(internal.attributes, { source: 'request', method: 'GET', path: '/api/collections/orders/records/abc', status: 500, collection: 'orders', action: 'view', requestId: REQUEST, auth: 'users' });
  assert.equal(core.logError(requestRow({ status: 503, error: 'Busy.', details: 'Busy.' })).message, 'Busy.');
  // Superusers are no account, and malformed meta links nothing.
  assert.equal(core.logError(requestRow({ auth: '_superusers', authId: 'root' })).accountId, '');
  const odd = core.logError(requestRow({ authId: 'bad id!', auth: 42, method: 7, url: null, meta: { replayRequest: 'short', replaySession: 'ABC123DEF456GHI' } }));
  assert.deepEqual([odd.accountId, odd.sessionId, odd.attributes], ['', '', { source: 'request', method: '', path: '', status: 400, auth: '' }]);
  assert.equal(core.logError(requestRow({ meta: 'text' })).attributes.requestId, undefined);
  const text = JSON.stringify(hook) + JSON.stringify(internal);
  assert.doesNotMatch(text, /private|203\.0\.113|198\.51\.100|Mozilla|expand|\/srv\/app/);
});

test('goja positions lose host directories and program counters, so the same error groups the same everywhere', () => {
  assert.equal(core.thrown('Error: x at /abs/dir/pb.js:2:65(13)').stack, 'Error: x\n    at pb.js:2:65');
  assert.equal(core.thrown('Error: x at handler (/abs/dir/pb_hooks/lib/orders.js:10:5(20))').stack, 'Error: x\n    at handler (orders.js:10:5)');
  assert.equal(core.thrown('Error: x at C:\\pb\\pb_hooks\\pb.js:1:2(3)').stack, 'Error: x\n    at pb.js:1:2');
  assert.equal(core.thrown('Error: x at /My Project/pb.js:4:5(6)').stack, 'Error: x\n    at pb.js:4:5');
  const hash = value => value;
  const of = dir => {
    const parsed = core.thrown('TypeError: Cannot read property id at ' + dir + '/pb.js:2:65(13)', 'GoError');
    return observabilityCore.fingerprint({ service: 'pocketbase', name: parsed.name, message: parsed.message, stack: parsed.stack }, hash);
  };
  assert.equal(of('/srv/one'), of('/home/two/pb_hooks'));
  assert.deepEqual(core.thrown("TypeError: Cannot read property 'crash' of undefined or null at /private/tmp/x/pb.js:1:32(4)"), {
    name: 'TypeError', message: "Cannot read property 'crash' of undefined or null", stack: "TypeError: Cannot read property 'crash' of undefined or null\n    at pb.js:1:32",
  });
  assert.deepEqual(core.thrown('GoError: sql: no rows in result set at github.com/pocketbase/pocketbase/core.(*BaseApp).FindRecordById-fm (native)'), {
    name: 'GoError', message: 'sql: no rows in result set', stack: 'GoError: sql: no rows in result set\n    at github.com/pocketbase/pocketbase/core.(*BaseApp).FindRecordById-fm (native)',
  });
  assert.equal(core.thrown('Error: failed at step 2 at job (/pb/lib/jobs.js:3:4(5))').message, 'failed at step 2');
  assert.equal(core.thrown('Error: failed at step 2 at job (/pb/lib/jobs.js:3:4(5))').stack, 'Error: failed at step 2\n    at job (jobs.js:3:4)');
  assert.deepEqual(core.thrown('something broke'), { name: 'Error', message: 'something broke', stack: '' });
  assert.deepEqual(core.thrown('TypeError: no position', 'GoError'), { name: 'GoError', message: 'TypeError: no position', stack: '' });
  assert.deepEqual(core.thrown(''), { name: 'Error', message: '(no message)', stack: '' });
  assert.equal(core.clip('TypeError: x at /private/tmp/x/pb.js:2:65(13)', 500), 'TypeError: x at pb.js:2:65');
  assert.equal(core.clip('write tcp 10.0.0.5:8090->[::1]:51234: i/o timeout at 12:30:45', 500), 'write tcp [ip]:8090->[ip]:51234: i/o timeout at 12:30:45');
  // Logged text is the app's own; no input may make the patterns backtrack for long.
  const started = Date.now();
  core.clip('/'.repeat(200000), 4096);
  core.clip('[' + ':'.repeat(200000), 4096);
  core.clip('a at /b/c.js:1:2(3) '.repeat(5000), 4096);
  core.thrown(' at '.repeat(5000) + 'x');
  core.thrown('Error: ' + '/'.repeat(9000) + ':1:2');
  assert.ok(Date.now() - started < 2000, 'took ' + (Date.now() - started) + ' ms');
});

test('link puts the request and session IDs into PocketBase log meta beside existing meta, and never throws', () => {
  const event = () => { const store = new Map(); return { get: key => store.get(key), set: (key, value) => store.set(key, value) }; };
  const e = event();
  pocketbase.link(e, REQUEST + '.abc123def456ghi');
  assert.deepEqual(e.get('pbLogMeta'), { replayRequest: REQUEST, replaySession: 'abc123def456ghi' });
  const other = event();
  other.set('pbLogMeta', { tenant: 't1' });
  pocketbase.link(other, REQUEST);
  assert.deepEqual(other.get('pbLogMeta'), { tenant: 't1', replayRequest: REQUEST });
  for (const value of ['', 'bad', REQUEST + '.short', undefined]) {
    const ignored = event();
    pocketbase.link(ignored, value);
    assert.equal(ignored.get('pbLogMeta'), undefined);
  }
  assert.doesNotThrow(() => pocketbase.link({ get: () => { throw new Error('boom'); }, set: () => { throw new Error('boom'); } }, REQUEST));
  assert.doesNotThrow(() => pocketbase.link(undefined, REQUEST));
});

test('a hook error in a traced call becomes one pocketbase issue with the documented fields, linked to its recording', () => {
  const f = fixture();
  try {
    f.enable();
    const recording = session(f, 'alice');
    const [first] = scanned(f, [
      { message: 'POST /api/collections/orders/records', data: requestData({ authId: 'alice', meta: { replayRequest: REQUEST, replaySession: recording.id } }) },
      { message: 'POST /api/collections/orders/records', data: requestData({ meta: { replayRequest: id(2) } }) },
    ]);
    const issues = f.records('replay_issues');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].getString('title'), "TypeError: Cannot read property 'boom' of undefined or null");
    assert.equal(issues[0].getString('service'), 'pocketbase');
    assert.equal(issues[0].getInt('occurrenceCount'), 2);
    const rows = errorRows(f);
    const row = rows[0];
    assert.equal(row.eventId, 'log-' + first);
    for (const [key, value] of Object.entries({ service: 'pocketbase', platform: 'pocketbase', appVersion: '', room: '', accountId: 'alice', sessionId: recording.id, handled: 0, level: 'error', issue: issues[0].id })) assert.equal(row[key], value, key);
    assert.equal(row.stack, "TypeError: Cannot read property 'boom' of undefined or null\n    at pb.js:2:65");
    assert.deepEqual(row.attributes, {
      source: 'request', method: 'POST', path: '/api/collections/orders/records', status: 400, collection: 'orders', action: 'create', requestId: REQUEST, auth: 'users',
    });
    assert.deepEqual([rows[1].accountId, rows[1].sessionId, rows[1].attributes.requestId], ['', '', id(2)]);
    assert.equal(observability.alerts(f.event()).totalItems, 1);
    assert.equal(observability.errorList(f.event({}, { sessionId: recording.id })).totalItems, 1);
  } finally { f.close(); }
});

test('a scanned request links only an existing recording of the same account', () => {
  const f = fixture();
  try {
    f.enable();
    const bobs = session(f, 'bob');
    const anonymous = session(f, '');
    const row = (authId, sessionId, auth) => ({ data: requestData({ authId, auth: auth || 'users', meta: { replayRequest: REQUEST, replaySession: sessionId } }) });
    scanned(f, [row('alice', bobs.id), row('alice', anonymous.id), row('alice', 'zzzzzzzzzzzzzzz'), row(undefined, bobs.id), row('root', anonymous.id, '_superusers')]);
    assert.deepEqual(errorRows(f).map(item => [item.accountId, item.sessionId]), [['alice', ''], ['alice', anonymous.id], ['alice', ''], ['', bobs.id], ['', anonymous.id]]);
  } finally { f.close(); }
});

test('the scan skips forgotten accounts and the daily budget, and stores at most 120 server errors a minute across sources', () => {
  const f = fixture();
  try {
    f.enable();
    replay.eraseAccountBatch(f.app, 'alice', true);
    scanned(f, [{ data: requestData({ authId: 'alice' }) }, { data: requestData({ authId: 'bob' }) }]);
    assert.deepEqual(errorRows(f).map(item => item.accountId), ['bob']);
  } finally { f.close(); }
  const g = fixture();
  try {
    g.enable();
    const start = Math.floor(Date.now() / 60000) * 60000 + 121000;
    withClock(start, set => {
      observability.sweep(g.app);
      const kinds = [
        index => ({ data: requestData({ error: 'TypeError: flood ' + index + ' at /pb.js:1:1(1)' }) }),
        index => ({ message: core.CRON_FAILURE, data: { error: 'Error: job ' + index + ' at /pb.js:1:1(1)', jobId: 'job' } }),
        index => ({ message: 'logged ' + index }),
      ];
      const ids = [];
      for (let i = 0; i < 130; i++) ids.push(g.log({ created: start - 20000 + i, ...kinds[i % 3](i) }));
      set(start + 15000);
      observability.sweep(g.app);
      assert.equal(errorRows(g).length, 120);
      // The excess is passed over, not kept for later.
      assert.equal(cursor(g).id, ids.at(-1));
      g.log({ created: start + 20000, message: 'next minute' });
      set(start + 60000);
      observability.sweep(g.app);
      assert.equal(errorRows(g).length, 121);
      assert.equal(errorRows(g).at(-1).message, 'next minute');
    });
  } finally { g.close(); }
  const h = fixture();
  try {
    h.enable({ daily_limit_mb: 1 });
    const ids = scanned(h, [{ message: 'over budget' }], { before: () => {
      const budget = new Record(h.app.findCollectionByNameOrId('replay_settings'));
      budget.set('key', 'observability:daily-bytes');
      budget.set('value', JSON.stringify({ at: Date.now(), bytes: 1024 * 1024 - 100 }));
      h.app.save(budget);
    } });
    assert.equal(errorRows(h).length, 0);
    assert.equal(cursor(h).id, ids[0]);
  } finally { h.close(); }
});

test('the hook file binds a tiny tracing hook on each short API action only when REPLAY_TRACE_REQUESTS is on', () => {
  const source = fs.readFileSync(path.join(__dirname, '../pb_hooks/720_pocketbase.pb.js'), 'utf8');
  const wanted = [
    'onRecordsListRequest', 'onRecordViewRequest', 'onRecordCreateRequest', 'onRecordUpdateRequest', 'onRecordDeleteRequest',
    'onRecordAuthWithPasswordRequest', 'onRecordAuthWithOAuth2Request', 'onRecordAuthWithOTPRequest', 'onRecordAuthRefreshRequest',
    'onRecordRequestOTPRequest', 'onRecordRequestPasswordResetRequest', 'onRecordConfirmPasswordResetRequest', 'onRecordRequestVerificationRequest',
    'onRecordConfirmVerificationRequest', 'onRecordRequestEmailChangeRequest', 'onRecordConfirmEmailChangeRequest', 'onBatchRequest',
    'onRealtimeSubscribeRequest', 'onFileTokenRequest',
  ];
  function load(value, options) {
    const bound = {}; const routes = []; const required = [];
    const context = {
      routerAdd: (method, route, handler, limit) => routes.push({ method, route, handler, limit }),
      routerUse: () => { throw new Error('no router middleware'); },
      $apis: { bodyLimit: bytes => bytes }, $os: { getenv: name => name === 'REPLAY_TRACE_REQUESTS' ? value : '' },
      __hooks: '/pb/pb_hooks', require: file => { required.push(file); if (options && options.lib instanceof Error) throw options.lib; return options && options.lib; },
    };
    for (const name of wanted.concat(['onRealtimeConnectRequest', 'onFileDownloadRequest', 'onRecordAuthRequest'])) {
      if (!(options && options.missing === name)) context[name] = handler => { bound[name] = (bound[name] || []).concat(handler); };
    }
    vm.runInNewContext(source, context);
    return { bound, routes, required };
  }
  // Off unless set: the hooks cost every record API request a little, whether or not the app traces its calls.
  for (const value of ['', 'off', 'OFF', 'false', '0', 'no', 'maybe', 'enabled', 'onn', '2']) assert.deepEqual(load(value).bound, {}, JSON.stringify(value));
  for (const value of ['on', 'ON', 'true', 'True', '1', 'yes', 'Yes', ' on ']) assert.deepEqual(Object.keys(load(value).bound).sort(), wanted.slice().sort(), value);
  assert.deepEqual(Object.keys(load('on', { missing: 'onRecordAuthWithOTPRequest' }).bound).sort(), wanted.filter(name => name !== 'onRecordAuthWithOTPRequest').sort());
  assert.equal(load('off').routes.length, 2);
  const { routes, bound } = load('on');
  for (const name of wanted) assert.equal(bound[name].length, 1, name);
  assert.deepEqual(routes.map(route => [route.method, route.route, route.limit]), [['GET', '/api/replay/link', undefined], ['POST', '/api/replay/requests', 65536]]);
  for (const route of routes) assert.match(route.handler.toString(), /require\(`\$\{__hooks\}\/lib\/pocketbase\.js`\)/);

  const calls = [];
  const lib = { link: (e, header) => calls.push(['link', header]) };
  const loaded = load('on', { lib });
  const trace = loaded.bound.onRecordsListRequest[0];
  assert.equal(trace, loaded.bound.onBatchRequest[0]);
  // Request hook events hide e.request; the embedded request event carries it.
  const event = (header, next, direct) => {
    const request = { header: { get: name => name === 'X-Replay-Request' ? header : '' } };
    return direct ? { request, next } : { requestEvent: { request }, next };
  };
  assert.equal(trace(event('', () => 'done')), 'done');
  assert.deepEqual(loaded.required, []);
  assert.equal(trace(event(REQUEST, () => { calls.push(['next']); return 'served'; })), 'served');
  assert.equal(trace(event(REQUEST, () => { calls.push(['next']); return 'direct'; }, true)), 'direct');
  assert.deepEqual(calls, [['link', REQUEST], ['next'], ['link', REQUEST], ['next']]);
  // A cached require() still costs microseconds, so each VM loads the library once.
  assert.deepEqual(loaded.required, ['/pb/pb_hooks/lib/pocketbase.js']);
  // The hook never catches what follows it: errors reach PocketBase untouched.
  const failure = new Error('hook failed');
  assert.throws(() => trace(event(REQUEST, () => { throw failure; })), error => error === failure);
  assert.deepEqual(calls.slice(4), [['link', REQUEST]]);
  // A broken library or an odd event never stops the request.
  for (const broken of [load('on', { lib: { link: () => { throw new Error('link bug'); } } }), load('on', { lib: new Error('Cannot find module') })]) {
    assert.equal(broken.bound.onRecordsListRequest[0](event(REQUEST, () => 'served')), 'served');
    assert.equal(broken.bound.onRecordsListRequest[0](event(REQUEST, () => 'served')), 'served');
  }
  // A library that failed to load is tried again rather than kept.
  const missing = load('on', { lib: new Error('Cannot find module') });
  missing.bound.onRecordsListRequest[0](event(REQUEST, () => 'served'));
  missing.bound.onRecordsListRequest[0](event(REQUEST, () => 'served'));
  assert.equal(missing.required.length, 2);
  assert.equal(trace({ next: () => 'served' }), 'served');
});

test('the probe answers ok without auth or storage, and routes answer JSON with no-store headers', () => {
  const headers = {};
  const answers = [];
  const e = extra => ({ response: { header: () => ({ set: (key, value) => { headers[key] = value; } }) }, json: (status, body) => answers.push([status, body]), ...extra });
  pocketbase.route(e(), 'probe');
  assert.deepEqual(answers.pop(), [200, { ok: true }]);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  pocketbase.route(e({ hasSuperuserAuth: () => false }), 'explain');
  assert.deepEqual(answers.pop(), [401, { message: 'Superuser authentication required' }]);
  pocketbase.route(e({ hasSuperuserAuth: () => false, auth: { id: 'user' } }), 'explain');
  assert.deepEqual(answers.pop(), [403, { message: 'Superuser authentication required' }]);
  assert.equal(pocketbase.failed, undefined);
});

test('the log scan imports failed cron jobs and logged errors once, skips answered requests, and stays 30 seconds behind', () => {
  const f = fixture();
  try {
    f.enable();
    const start = Date.now() + 60000;
    withClock(start, set => {
      // Before capture was enabled: never imported.
      f.log({ message: core.CRON_FAILURE, data: { error: 'TypeError: old at /pb/pb.js:1:1(1)', jobId: 'old' }, created: start - 120000 });
      observability.sweep(f.app);
      assert.equal(errorRows(f).length, 0);
      assert.deepEqual(cursor(f), { created: logTime(JSON.parse(f.records('replay_settings', "key = 'observability:log-capture'")[0].getString('value'))[0][0] - 1), id: '' });

      const cron = f.log({ message: core.CRON_FAILURE, data: { error: "TypeError: Cannot read property 'crash' of undefined or null at /srv/a/pb.js:1:32(4)", jobId: 'nightly' }, created: start - 20000 });
      f.log({ message: 'GET /api/collections/orders/records/abc', data: requestData({ status: 404, error: "The requested resource wasn't found.", details: 'sql: no rows in result set' }), created: start - 20000 });
      f.log({ message: 'POST /api/collections/orders/records', data: requestData({ status: 400, error: 'Failed to create record.', details: { total: 'cannot be blank' } }), created: start - 20000 });
      const logged = f.log({ message: 'payment failed for alice@example.com', data: { provider: 'stripe', token: 'private-token', note: 'card of bob@example.com', count: 3, ok: false, missing: null, nested: { a: 1 }, list: [1] }, created: start - 19000 });
      f.log({ level: 4, message: 'only a warning', created: start - 19000 });
      f.log({ level: 0, message: 'GET /api/health', data: { type: 'request', status: 200 }, created: start - 19000 });
      // Not 30 seconds old yet.
      observability.sweep(f.app);
      assert.equal(errorRows(f).length, 0);
      set(start + 15000);
      observability.sweep(f.app);
      const rows = errorRows(f);
      assert.deepEqual(rows.map(row => row.eventId), ['log-' + cron, 'log-' + logged]);
      assert.equal(rows[0].name, 'TypeError');
      assert.equal(rows[0].message, "Cannot read property 'crash' of undefined or null");
      assert.equal(rows[0].stack, "TypeError: Cannot read property 'crash' of undefined or null\n    at pb.js:1:32");
      assert.deepEqual(rows[0].attributes, { source: 'cron', jobId: 'nightly' });
      assert.equal(rows[0].timestamp, start - 20000);
      assert.equal(rows[1].name, 'LoggedError');
      assert.equal(rows[1].message, 'payment failed for [redacted]');
      assert.deepEqual(rows[1].attributes, { source: 'log', count: 3, missing: null, note: 'card of [redacted]', ok: false, provider: 'stripe', token: '[redacted]' });
      for (const row of rows) {
        assert.equal(row.deviceId, 'pocketbase');
        assert.equal(row.service, 'pocketbase');
        assert.equal(row.accountId, '');
        assert.equal(row.sessionId, '');
      }
      assert.equal(f.records('replay_issues').length, 2);
      assert.equal(observability.alerts(f.event()).totalItems, 2);
      observability.sweep(f.app);
      assert.equal(errorRows(f).length, 2);
      // A rescan from an older cursor stores nothing twice.
      const row = f.records('replay_settings', "key = 'observability:log-cursor'")[0];
      row.set('value', JSON.stringify({ created: logTime(start - 50000), id: '' }));
      f.app.save(row);
      observability.sweep(f.app);
      assert.equal(errorRows(f).length, 2);
      assert.equal(f.records('replay_issues').reduce((sum, issue) => sum + issue.getInt('occurrenceCount'), 0), 2);
    });
  } finally { f.close(); }
});

test('capture boundaries survive off/on between sweeps and preserve enabled rows still awaiting log flush', () => {
  for (const off of [{ errors_enabled: false }, { server_errors: false }]) {
    const f = fixture();
    try {
      f.enable();
      const start = Date.now() + 60000;
      withClock(start, set => {
        observability.sweep(f.app);
        const before = f.log({ message: 'enabled before disabling', created: start + 500 });
        set(start + 1000);
        f.enable(off);
        f.log({ message: 'while off', created: start + 1500 });
        set(start + 2000);
        f.enable({ errors_enabled: true, server_errors: true });
        const after = f.log({ message: 'after enabling', created: start + 2500 });
        set(start + 60000);
        observability.sweep(f.app);
        assert.deepEqual(errorRows(f).map(row => row.eventId), ['log-' + before, 'log-' + after], JSON.stringify(off));
      });
    } finally { f.close(); }
  }
});

test('direct settings model saves persist off/on boundaries before a sweep, and raw SQL off observations close stale periods', () => {
  for (const nativeHooks of [true, false]) {
    const f = fixture();
    const start = Date.now();
    try {
      withClock(start, set => {
        f.enable();
        observability.sweep(f.app);
        set(start + 1000);
        const row = f.app.findFirstRecordByData('replay_settings', 'key', 'observability');
        const value = JSON.parse(row.getString('value'));
        row.set('value', JSON.stringify({ ...value, server_errors: false }));
        f.app.save(row);
        if (nativeHooks) observability.settingsChanged(f.app);
        f.log({ message: 'direct off', created: start + 1500 });
        if (!nativeHooks) {
          set(start + 2000);
          observability.sweep(f.app);
        }
        set(start + 3000);
        if (nativeHooks) {
          row.set('value', JSON.stringify(value));
          f.app.save(row);
          observability.settingsChanged(f.app);
        } else f.enable({ server_errors: true });
        const after = f.log({ message: 'after direct off', created: start + 3500 });
        set(start + 60000);
        observability.sweep(f.app);
        assert.deepEqual(errorRows(f).map(row => row.eventId), ['log-' + after], String(nativeHooks));
      });
    } finally { f.close(); }
  }
});

test('the log scan reads in batches of 200, and a row that cannot be stored never holds it back', () => {
  const f = fixture();
  try {
    f.enable();
    const start = Date.now() + 60000;
    withClock(start, set => {
      observability.sweep(f.app);
      // Answered requests are read and passed over; 205 of them take two batches.
      for (let i = 0; i < 205; i++) f.log({ message: 'GET /api/collections/orders/records/x', data: requestData({ status: 404, error: 'Missing.' }), created: start - 25000 + i });
      f.log({ message: 'unreadable data', data: '{not json', created: start - 5000 });
      const failing = f.log({ message: 'poison', created: start - 4000 });
      const last = f.log({ message: 'after poison', created: start - 3000 });
      const save = f.app.save;
      f.app.save = item => {
        if (item.data && item.data.eventId === 'log-' + failing) throw new Error('injected failure');
        return save(item);
      };
      const warn = console.warn;
      const warnings = [];
      console.warn = message => warnings.push(message);
      try {
        set(start + 30000);
        observability.sweep(f.app);
      } finally { console.warn = warn; f.app.save = save; }
      const rows = errorRows(f);
      assert.deepEqual(rows.map(row => row.message), ['unreadable data', 'after poison']);
      assert.deepEqual(rows[0].attributes, { source: 'log' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /injected failure/);
      assert.deepEqual(JSON.parse(f.records('replay_settings', "key = 'observability:log-cursor'")[0].getString('value')).id, last);
    });
  } finally { f.close(); }
});

test('the log scan stops at its time budget and resumes from the last row it read', () => {
  const f = fixture();
  try {
    f.enable();
    const start = Date.now() + 60000;
    withClock(start, set => {
      observability.sweep(f.app);
      for (let i = 0; i < 5; i++) f.log({ message: 'slow ' + i, created: start - 10000 + i });
      set(start + 30000);
      const transaction = f.app.runInTransaction;
      let clock = start + 30000;
      f.app.runInTransaction = callback => { clock += 1500; set(clock); return transaction(callback); };
      try { observability.scanLogs(f.app, observability.config(f.app), start + 33000); } finally { f.app.runInTransaction = transaction; }
      assert.equal(errorRows(f).length, 2);
      observability.scanLogs(f.app, observability.config(f.app), Date.now() + 60000);
      assert.deepEqual(errorRows(f).map(row => row.message), ['slow 0', 'slow 1', 'slow 2', 'slow 3', 'slow 4']);
    });
  } finally { f.close(); }
});

function explainFixture() {
  const f = fixture();
  f.enable();
  collection(f, { name: 'orders', listRule: '@request.auth.id != ""', viewRule: '@request.auth.id != ""', createRule: '@request.auth.id != ""', updateRule: '@request.auth.id != ""', deleteRule: null });
  collection(f, { name: 'users', type: 'auth', authRule: 'verified = true', listRule: 'id = @request.auth.id', viewRule: 'id = @request.auth.id' });
  collection(f, { name: 'notes', listRule: '' });
  const order = record(f, 'orders');
  const recording = session(f, 'alice');
  const at = Date.now();
  const logged = (n, data, created) => f.log({
    level: data.error ? 8 : 0, message: 'request',
    data: { type: 'request', auth: '', execTime: 1.26, method: 'GET', referer: 'https://app.test/page?private=1', remoteIP: '203.0.113.9', userIP: '198.51.100.7', userAgent: 'Mozilla/5.0 secret-agent', meta: { replayRequest: id(n) }, ...data },
    created: created === undefined ? at : created,
  });
  const explain = (requests, extra) => pocketbase.explain(f.event({ sessionId: recording.id, requests, ...extra }));
  return { f, order, recording, logged, explain, at };
}

test('explain answers server, rule, record, issue and verdict for every verdict, and never URLs, addresses or agents', () => {
  const { f, order, recording, logged, explain } = explainFixture();
  try {
    logged(1, { status: 400, auth: '', method: 'POST', url: '/api/collections/orders/records', error: 'Failed to create record.', details: 'create rule failure: sql: no rows in result set', execTime: 1.795084 });
    logged(2, { status: 400, auth: 'users', authId: 'alice', method: 'POST', error: 'Failed to create record.', details: { total: 'cannot be blank', note: { code: 'x', message: 'Too long.' } } });
    logged(3, { status: 0, auth: 'users', method: 'POST', error: "TypeError: Cannot read property 'boom' of undefined or null at /private/tmp/x/pb.js:2:65(13)" });
    logged(4, { status: 404, method: 'GET', url: '/api/collections/orders/records/' + order.id, error: "The requested resource wasn't found.", details: 'sql: no rows in result set' });
    logged(5, { status: 404, method: 'GET', error: "The requested resource wasn't found.", details: 'sql: no rows in result set' });
    logged(6, { status: 403, auth: 'users', method: 'DELETE', error: 'Only superusers can perform this action.', details: null });
    logged(7, { status: 200, method: 'GET', url: '/api/collections/orders/records?filter=note%20%3D%20%22secret%20value%22' });
    logged(8, { status: 500, method: 'GET', error: 'Something went wrong while processing your request.', details: 'write tcp 10.0.0.5:8090->198.51.100.7:51234: i/o timeout' });
    logged(9, { status: 200, auth: '_superusers', method: 'GET' });
    logged(12, { status: 0, method: 'GET', url: '/app/missing', error: 'sql: no rows in result set' });
    // Imported by the scan from a request row that this lookup does not see.
    observability.serverError(f.app, core.logError(requestRow({ error: 'TypeError: stored hook error at /srv/pb.js:1:1(1)', authId: 'alice', meta: { replayRequest: id(10), replaySession: recording.id } })));
    const result = explain([
      { request: id(1), method: 'POST', path: '/api/collections/orders/records', status: 400 },
      { request: id(2), method: 'POST', path: '/api/collections/orders/records', status: 400 },
      { request: id(3), method: 'POST', path: '/api/collections/orders/records', status: 400 },
      { request: id(4), method: 'GET', path: '/api/collections/orders/records/' + order.id + '?expand=user', status: 404 },
      { request: id(5), method: 'GET', path: '/api/collections/orders/records/missingrecord01', status: 404 },
      { request: id(6), method: 'DELETE', path: '/api/collections/orders/records/' + order.id, status: 403 },
      { request: id(7), method: 'GET', path: '/api/collections/orders/records?filter=note%20%3D%20%22secret%20value%22', status: 200, items: 0 },
      { request: id(8), method: 'GET', path: '/api/collections/orders/records', status: 500 },
      { request: id(9), method: 'GET', path: '/api/collections/orders/records', status: 200, items: 0 },
      { request: id(10), method: 'POST', path: '/api/collections/orders/records', status: 400 },
      { request: id(11), method: 'GET', path: '/api/collections/notes/records', status: 200, items: 0 },
      { request: id(12), method: 'GET', path: '/app/missing', status: 404 },
    ]);
    assert.equal(result.logs, true);
    const by = Object.fromEntries(result.items.map(item => [item.request, item]));
    const create = { name: 'createRule', expression: '@request.auth.id != ""' };
    assert.deepEqual(by[id(1)], {
      request: id(1), server: { status: 400, ms: 1.8, auth: '', error: 'Failed to create record.' }, rule: create, verdict: 'rule',
    });
    assert.deepEqual(by[id(2)].server, {
      status: 400, ms: 1.3, auth: 'users', authId: 'alice', error: 'Failed to create record.',
      fields: [{ field: 'total', code: '' }, { field: 'note', code: 'x' }],
    });
    assert.equal(by[id(2)].verdict, 'validation');
    assert.deepEqual(by[id(3)].server, { status: 400, ms: 1.3, auth: 'users' });
    assert.equal(by[id(3)].verdict, 'hook');
    assert.equal(by[id(4)].record, 'exists');
    assert.deepEqual(by[id(4)].rule, { name: 'viewRule', expression: '@request.auth.id != ""' });
    assert.equal(by[id(4)].verdict, 'rule');
    assert.equal(by[id(4)].likely, true);
    assert.equal(by[id(5)].record, 'missing');
    assert.equal(by[id(5)].verdict, 'missing');
    assert.deepEqual(by[id(6)].rule, { name: 'deleteRule', expression: null });
    assert.equal(by[id(6)].verdict, 'locked');
    assert.equal(by[id(6)].record, undefined);
    assert.deepEqual(by[id(7)], { request: id(7), server: { status: 200, ms: 1.3, auth: '' }, rule: { name: 'listRule', expression: '@request.auth.id != ""' }, verdict: 'filtered' });
    assert.equal(by[id(8)].verdict, 'server');
    assert.equal(by[id(8)].server.details, undefined);
    // Superusers skip API rules, so an empty list is no rule's doing.
    assert.equal(by[id(9)].verdict, undefined);
    assert.equal(by[id(9)].server.auth, '_superusers');
    const stored = f.records('replay_issues').find(issue => issue.getString('title') === 'TypeError: stored hook error');
    assert.deepEqual(by[id(10)].issue, { id: stored.id, title: 'TypeError: stored hook error' });
    assert.equal(by[id(10)].verdict, 'hook');
    assert.equal(by[id(10)].server, undefined);
    // An empty rule lets everyone list, so an empty list was not filtered by it.
    assert.deepEqual(by[id(11)], { request: id(11), rule: { name: 'listRule', expression: '' } });
    // A missing row a route did not catch is logged with status 0, but PocketBase answered it with 404.
    assert.deepEqual(by[id(12)], { request: id(12), server: { status: 404, ms: 1.3, auth: '' } });
    assert.doesNotMatch(JSON.stringify(result), /secret|private|203\.0\.113|198\.51\.100|10\.0\.0\.5|Mozilla|referer|userAgent|remoteIP|userIP|url|\/private\/tmp/);
  } finally { f.close(); }
});

test('explain uses the auth rule for auth actions and decides from the client status when no log matched', () => {
  const { f, order, explain } = explainFixture();
  try {
    // PocketBase refuses a locked rule, a hidden or missing record and a missing collection before any request
    // hook runs, so those calls have no log meta; their verdicts come from the rule and the record lookup.
    const result = explain([
      { request: id(1), method: 'POST', path: '/api/collections/users/auth-with-password', status: 400 },
      { request: id(2), method: 'GET', path: '/api/collections/orders/records/' + order.id, status: 404 },
      { request: id(3), method: 'POST', path: '/api/collections/missing/records', status: 404 },
      { request: id(4), method: 'GET', path: '/api/health', status: 500 },
      { request: id(5), method: 'POST', path: '/api/collections/orders/auth-with-password', status: 400 },
      { request: id(6), method: 'DELETE', path: '/api/collections/orders/records/' + order.id, status: 403 },
      { request: id(7), method: 'PATCH', path: '/api/collections/orders/records/missingrecord01', status: 404 },
    ]);
    assert.deepEqual(result.items[0], { request: id(1), rule: { name: 'authRule', expression: 'verified = true' } });
    assert.deepEqual(result.items[1], { request: id(2), rule: { name: 'viewRule', expression: '@request.auth.id != ""' }, record: 'exists', verdict: 'rule', likely: true });
    assert.deepEqual(result.items[2], { request: id(3) });
    assert.deepEqual(result.items[3], { request: id(4), verdict: 'server' });
    assert.deepEqual(result.items[4], { request: id(5) });
    assert.deepEqual(result.items[5], { request: id(6), rule: { name: 'deleteRule', expression: null }, verdict: 'locked' });
    assert.deepEqual(result.items[6], { request: id(7), rule: { name: 'updateRule', expression: '@request.auth.id != ""' }, record: 'missing', verdict: 'missing' });
  } finally { f.close(); }
});

test('without a log row, explain infers likely verdicts from what the app received, and only then', () => {
  const { f, logged, explain } = explainFixture();
  try {
    collection(f, { name: 'open', createRule: '' });
    collection(f, { name: 'closed', createRule: null });
    const generic = 'Something went wrong while processing your request.';
    const create = (n, patch) => ({ request: id(n), method: 'POST', path: '/api/collections/orders/records', status: 400, fields: 0, message: 'Failed to create record.', ...patch });
    const route = (n, patch) => ({ request: id(n), method: 'GET', path: '/app/plain', status: 400, message: generic, ...patch });
    logged(9, { status: 400, method: 'POST', error: 'Failed to create record.' });
    logged(10, { status: 400, method: 'GET', error: generic });
    observability.serverError(f.app, core.logError(requestRow({ error: 'TypeError: x at /srv/pb.js:1:1(1)', meta: { replayRequest: id(11) } })));
    const result = explain([
      create(1), route(2), create(3, { message: generic }),
      create(4, { fields: 2 }), create(5, { fields: -1 }), create(6, { fields: '0' }), create(7, { fields: undefined }), create(8, { fields: 1.5 }),
      create(20, { message: 'Out of stock.' }), create(21, { message: 'Failed to create record. ' }), create(22, { message: 42 }),
      create(23, { message: 'Failed to create record.'.padEnd(600, 'x') }), route(24, { message: generic.toLowerCase() }), route(25, { status: 404 }),
      create(9), route(10), route(11),
      create(12, { path: '/api/collections/open/records' }), create(13, { path: '/api/collections/closed/records' }),
      create(14, { status: 403 }), route(15, { status: 500 }), create(16, { method: 'PATCH', path: '/api/collections/orders/records/abc' }),
    ]);
    const by = Object.fromEntries(result.items.map(item => [item.request, item]));
    const createRule = { name: 'createRule', expression: '@request.auth.id != ""' };
    // A create its rule refused before any request hook ran, and an error that is not an ApiError.
    assert.deepEqual(by[id(1)], { request: id(1), rule: createRule, verdict: 'rule', likely: true });
    assert.deepEqual(by[id(2)], { request: id(2), verdict: 'hook', likely: true });
    assert.deepEqual(by[id(3)], { request: id(3), rule: createRule, verdict: 'hook', likely: true });
    // Refused fields, unknown field counts and other messages suggest nothing.
    for (const n of [4, 5, 6, 7, 8, 20, 21, 22, 23]) assert.deepEqual(by[id(n)], { request: id(n), rule: createRule }, String(n));
    assert.deepEqual(by[id(24)], { request: id(24) });
    assert.deepEqual(by[id(25)], { request: id(25) });
    assert.equal(core.explainInput({ request: id(1), message: 'x'.repeat(600) }).message.length, 500);
    assert.deepEqual([core.explainInput({ request: id(1), fields: 3 }).fields, core.explainInput({ request: id(1), fields: '3' }).fields], [3, -1]);
    // A log row makes guesses unnecessary, and an issue makes the verdict certain.
    assert.deepEqual(by[id(9)], { request: id(9), server: { status: 400, ms: 1.3, auth: '', error: 'Failed to create record.' }, rule: createRule });
    assert.deepEqual(by[id(10)], { request: id(10), server: { status: 400, ms: 1.3, auth: '', error: generic }, verdict: 'hook', likely: true });
    assert.equal(by[id(11)].verdict, 'hook');
    assert.equal(by[id(11)].likely, undefined);
    // An empty rule lets everyone create, and a locked one answers 403, so neither refused this create.
    assert.deepEqual(by[id(12)], { request: id(12), rule: { name: 'createRule', expression: '' } });
    assert.deepEqual(by[id(13)], { request: id(13), rule: { name: 'createRule', expression: null } });
    assert.deepEqual(by[id(14)], { request: id(14), rule: createRule });
    assert.deepEqual(by[id(15)], { request: id(15), verdict: 'server' });
    assert.deepEqual(by[id(16)], { request: id(16), rule: { name: 'updateRule', expression: '@request.auth.id != ""' } });
    assert.deepEqual(result.items.filter(item => item.likely).map(item => item.request), [id(1), id(2), id(3), id(10)]);
    assert.ok(result.items.every(item => item.likely === undefined || item.likely === true));
  } finally { f.close(); }
});

test('explain requires a superuser, a known recording and bounded input, and reports unreadable logs', () => {
  const { f, recording, logged, explain, at } = explainFixture();
  try {
    assert.throws(() => pocketbase.explain(f.event({ sessionId: recording.id, requests: [] }, {}, '', false)), { status: 401 });
    assert.throws(() => pocketbase.explain({ ...f.event({ sessionId: recording.id, requests: [] }, {}, '', false), auth: { id: 'user' } }), { status: 403 });
    assert.throws(() => explain([], { sessionId: 'zzzzzzzzzzzzzzz' }), { status: 404, message: 'Replay session not found' });
    for (const sessionId of ['', 'short', 'ABC123DEF456GHI', 42]) assert.throws(() => explain([], { sessionId }), { status: 400 }, String(sessionId));
    for (const requests of [undefined, {}, 'x', Array(201).fill({ request: id(1) })]) assert.throws(() => explain(requests), { status: 400 });
    assert.equal(explain(Array(200).fill({ request: id(1), method: 'GET', path: '/api/health' })).items.length, 200);
    const event = f.event({});
    event.request.body = 'x'.repeat(65537);
    assert.throws(() => pocketbase.explain(event), { status: 413 });
    // Entries that are not requests are passed over; odd fields are bounded rather than refused.
    const odd = explain([null, 'x', [], { request: 'short' }, { request: id(1).toUpperCase() },
      { request: id(2), method: 'GET; DROP', path: '/api/collections/orders/records', status: 'x', items: -1 },
      { request: id(3), method: 'GET', path: '/api/collections/orders/records' + '/'.repeat(5000), status: 1e9 }]);
    assert.deepEqual(odd.items, [{ request: id(2) }, { request: id(3) }]);
    // At most 50 record lookups per call.
    const lookups = f.app.findRecordById;
    let calls = 0;
    f.app.findRecordById = (name, value) => { if (name === 'orders') calls++; return lookups(name, value); };
    const many = explain(Array.from({ length: 60 }, (_, i) => ({ request: id(100 + i), method: 'GET', path: '/api/collections/orders/records/gone' + i, status: 404 })));
    f.app.findRecordById = lookups;
    assert.equal(calls, 50);
    assert.equal(many.items.filter(item => item.record === 'missing').length, 50);
    // A log row outside the recording's window is not this call's.
    logged(1, { status: 400, error: 'Old.' }, at - 3 * 3600000);
    logged(2, { status: 400, error: 'Current.' });
    assert.deepEqual(explain([{ request: id(1) }, { request: id(2) }]).items.map(item => item.server && item.server.error), [undefined, undefined]);
    f.app.auxDB = () => { throw new Error('auxiliary database unavailable'); };
    const unreadable = explain([{ request: id(2), method: 'GET', path: '/api/collections/orders/records/missing', status: 404 }]);
    assert.equal(unreadable.logs, false);
    assert.deepEqual(unreadable.items, [{ request: id(2), rule: { name: 'viewRule', expression: '@request.auth.id != ""' }, record: 'missing', verdict: 'missing' }]);
    const settings = f.app.settings;
    f.app.settings = () => ({ ...settings(), logs: { maxDays: 0 } });
    assert.equal(explain([]).logs, false);
  } finally { f.close(); }
});

test('the explain window runs from 15 minutes before the recording to 15 after its last activity, at most 12 hours', () => {
  const f = fixture();
  try {
    const start = Date.parse('2026-10-15T08:30:00.000Z');
    const recording = session(f, '', { startedAt: start, lastSeenAt: start + 20 * 3600000, endedAt: start + 3600000 });
    const queries = [];
    f.app.auxDB = () => ({ newQuery: sql => ({ bind: params => ({ all: () => queries.push({ sql, params }) }) }) });
    pocketbase.explain(f.event({ sessionId: recording.id, requests: [{ request: id(1) }, { request: id(1) }, { request: id(2) }] }));
    const hours = Object.keys(queries[0].params).filter(key => key.startsWith('hour')).map(key => queries[0].params[key]);
    assert.equal(hours[0], '2026-10-15 08:00:00');
    assert.equal(hours.at(-1), '2026-10-15 20:00:00');
    assert.equal(hours.length, 13);
    assert.deepEqual(Object.keys(queries[0].params).filter(key => key.startsWith('request')).map(key => queries[0].params[key]), [id(1), id(2)]);
    assert.match(queries[0].sql, /strftime\('%Y-%m-%d %H:00:00', created\) IN \(/);
    assert.match(queries[0].sql, /json_extract\(data, '\$\.meta\.replayRequest'\) IN \(/);
    assert.deepEqual(core.hours(start - 900000, start + 2700000), ['2026-10-15 08:00:00', '2026-10-15 09:00:00']);
  } finally { f.close(); }
});

test('record_pocketbase defaults on, survives older dashboards and fallbacks, and reaches config and start answers', () => {
  assert.equal(replayCore.DEFAULTS.record_pocketbase, true);
  const { record_pocketbase: _flag, ...older } = replayCore.DEFAULTS;
  assert.equal(replayCore.settings(older).record_pocketbase, true);
  assert.equal(replayCore.settings({ ...older, record_pocketbase: null }).record_pocketbase, true);
  assert.equal(replayCore.settings({ ...older, record_pocketbase: false }).record_pocketbase, false);
  for (const value of ['false', 0, 1, 'off', [], {}]) assert.throws(() => replayCore.settings({ ...older, record_pocketbase: value }), { status: 400, message: 'Invalid record_pocketbase' });
  const f = fixture();
  try {
    const form = { mode: 'percentage', percentage: 100, account_ids: [], retention_days: 14 };
    assert.equal(replay.saveSettings(f.event({ ...form, record_pocketbase: false })).record_pocketbase, false);
    // An older dashboard leaves the flag out and keeps the stored value.
    assert.equal(replay.saveSettings(f.event(form)).record_pocketbase, false);
    assert.equal(replay.getSettings(f.event()).record_pocketbase, false);
    assert.equal(replay.publicConfig(f.event({ deviceId: 'device-a', platform: 'web' })).recordPocketbase, false);
    assert.equal(replay.start(f.event({ deviceId: 'device-a', platform: 'web' })).recordPocketbase, false);
    assert.equal(replay.saveSettings(f.event({ ...form, record_pocketbase: true })).record_pocketbase, true);
    assert.equal(replay.publicConfig(f.event({ deviceId: 'device-a', platform: 'web' })).recordPocketbase, true);
    // An unreadable setting turns recording off; a stored false still survives the next save.
    const flag = f.records('replay_settings', "key = 'record_pocketbase'")[0];
    flag.set('value', 'false'); f.app.save(flag);
    const mode = f.records('replay_settings', "key = 'mode'")[0];
    mode.set('value', '"everyone"'); f.app.save(mode);
    assert.equal(replay.config(f.app).mode, 'off');
    assert.equal(replay.config(f.app).record_pocketbase, false);
    flag.set('value', '"maybe"'); f.app.save(flag);
    assert.equal(replay.config(f.app).record_pocketbase, true);
    f.database.prepare("DELETE FROM replay_settings WHERE key = 'record_pocketbase'").run();
    mode.set('value', '"percentage"'); f.app.save(mode);
    assert.equal(replay.config(f.app).record_pocketbase, true);
  } finally { f.close(); }
});

test('server_errors defaults on, refuses non-booleans, and survives older dashboards and fallbacks', () => {
  assert.equal(observabilityCore.DEFAULTS.server_errors, true);
  const { server_errors: _flag, ...older } = observabilityCore.DEFAULTS;
  assert.equal(observabilityCore.settings(older).server_errors, true);
  assert.equal(observabilityCore.settings({ ...older, server_errors: false }).server_errors, false);
  for (const value of ['false', 0, null, 'off', []]) assert.throws(() => observabilityCore.settings({ ...older, server_errors: value }), { status: 400, message: 'Invalid server_errors' });
  const f = fixture();
  try {
    assert.equal(observability.getSettings(f.event()).server_errors, true);
    assert.equal(observability.saveSettings(f.event({ errors_enabled: true, server_errors: false })).server_errors, false);
    assert.equal(observability.serverError(f.app, core.logError({ id: 'off', message: 'logged while off', data: '{}', created: logTime(Date.now()) })), false);
    assert.equal(f.records('replay_errors').length, 0);
    // An older dashboard leaves the flag out and keeps the stored value.
    assert.equal(observability.saveSettings(f.event({ errors_enabled: true, logs_enabled: false })).server_errors, false);
    const row = f.records('replay_settings', "key = 'observability'")[0];
    const stored = JSON.parse(row.getString('value'));
    row.set('value', JSON.stringify({ ...stored, errors_enabled: 'broken' })); f.app.save(row);
    assert.equal(observability.config(f.app).errors_enabled, false);
    assert.equal(observability.config(f.app).server_errors, false);
    const { server_errors: _stored, ...previous } = stored;
    row.set('value', JSON.stringify(previous)); f.app.save(row);
    assert.equal(observability.config(f.app).server_errors, true);
  } finally { f.close(); }
});

test('no client may take the device ID server errors are stored under', () => {
  const f = fixture();
  try {
    f.enable();
    const answer = observability.publicConfig(f.event({ ...f.metadata, deviceId: 'pocketbase' }));
    assert.equal(answer.enabled, false);
    assert.equal(answer.token, undefined);
    assert.equal(f.records('replay_observability_sessions').length, 0);
    const token = f.token();
    assert.equal(observability.errors(f.event({ token, events: [exception('client')] })).accepted, 1);
    assert.equal(f.records('replay_errors', "deviceId = 'pocketbase'").length, 0);
  } finally { f.close(); }
});

test('the first scan imports pending enabled errors and recreating its cursor never loses them or duplicates them', () => {
  const f = fixture();
  const start = Date.now();
  try {
    withClock(start, set => {
      f.enable();
      f.log({ message: 'before enabling', created: start - 1 });
      const pending = f.log({ message: 'before first sweep', created: start + 1000 });
      set(start + 60000);
      observability.sweep(f.app);
      assert.deepEqual(errorRows(f).map(row => row.eventId), ['log-' + pending]);
      f.app.delete(f.records('replay_settings', "key = 'observability:log-cursor'")[0]);
      observability.sweep(f.app);
      assert.deepEqual(errorRows(f).map(row => row.eventId), ['log-' + pending]);
    });
  } finally { f.close(); }
});

test('returned 5xx request responses without an error or error log level become server issues', () => {
  const f = fixture();
  try {
    f.enable();
    const data = requestData({ error: '', status: 500, method: 'GET', url: '/returned500', meta: {} });
    assert.equal(core.logError({ ...requestRow(data), level: 0 }).message, 'HTTP 500 server error');
    scanned(f, [{ level: 0, message: 'GET /returned500', data }]);
    assert.equal(errorRows(f).length, 1);
    assert.equal(errorRows(f)[0].attributes.status, 500);
    assert.equal(errorRows(f)[0].attributes.path, '/returned500');
  } finally { f.close(); }
});

test('the hour-indexed log scan crosses empty old windows and still imports a later returned 500', () => {
  const f = fixture();
  const start = Date.now();
  try {
    withClock(start, set => {
      f.enable();
      const id = f.log({ level: 0, created: start + 25 * 3600000, message: 'returned after a quiet day', data: requestData({ status: 500, error: '' }) });
      set(start + 26 * 3600000);
      observability.sweep(f.app);
      assert.deepEqual(errorRows(f).map(row => row.eventId), ['log-' + id]);
      const plan = f.auxiliary.prepare("EXPLAIN QUERY PLAN SELECT id FROM _logs WHERE strftime('%Y-%m-%d %H:00:00', created) IN (?) AND (level >= 8 OR json_extract(data, '$.status') >= 500)").all(logTime(start).slice(0, 13) + ':00:00');
      assert.ok(plan.some(row => row.detail.includes('idx_logs_created_hour')));
    });
  } finally { f.close(); }
});

test('explanations do not echo custom validation values, and public rules are never blamed for existing-record 404s', () => {
  const { f, order, logged, explain } = explainFixture();
  try {
    f.collections.get('orders').viewRule = '';
    logged(1, { method: 'GET', status: 404, error: 'Hidden private-value', details: 'private-value' });
    logged(2, { status: 400, error: 'Refused private-value', details: {
      total: { code: 'validation_required', message: 'Refused private-value' },
      note: 'private-value',
      'private value key': { code: 'unsafe code private-value', message: 'private-value' },
    } });
    const result = explain([
      { request: id(1), method: 'GET', path: '/api/collections/orders/records/' + order.id, status: 404 },
      { request: id(2), method: 'POST', path: '/api/collections/orders/records', status: 400 },
    ]);
    assert.equal(result.items[0].record, 'exists');
    assert.equal(result.items[0].verdict, undefined);
    assert.deepEqual(result.items[1].server.fields, [{ field: 'total', code: 'validation_required' }, { field: 'note', code: '' }]);
    assert.equal(result.items[1].verdict, 'validation');
    assert.doesNotMatch(JSON.stringify(result), /private-value|private value/);
  } finally { f.close(); }
});

test('URL correlation survives a missing hook meta only under explicit tracing, and is never exported as a URL', () => {
  const { f, recording, at, explain } = explainFixture();
  try {
    replay.saveSettings(f.event({ mode: 'percentage', percentage: 100, account_ids: [], retention_days: 14 }));
    const value = REQUEST + '.' + recording.id;
    const data = requestData({ meta: {}, auth: '', url: '/api/collections/orders/records?filter=private-value&__replayRequest=' + value });
    f.log({ created: at, message: 'POST orders', data });
    const query = [{ request: REQUEST, method: 'POST', path: '/api/collections/orders/records', status: 400 }];
    assert.equal(explain(query).items[0].server, undefined);
    assert.equal(core.logError(requestRow(data)).attributes.requestId, undefined);
    for (const value of ['on', 'true', '1', 'yes', ' ON ']) {
      global.$os.getenv = name => name === 'REPLAY_TRACE_REQUESTS' ? value : '';
      const entry = core.logError(requestRow(data));
      assert.equal(entry.attributes.requestId, REQUEST);
      assert.equal(entry.sessionId, recording.id);
      const result = explain(query);
      assert.equal(result.items[0].verdict, 'hook');
      assert.deepEqual(result.items[0].server, { status: 400, ms: 1.3, auth: '' });
      assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(entry), /private-value|__replayRequest/);
      assert.equal(replay.publicConfig(f.event({ deviceId: 'device', platform: 'web' })).tracePocketbaseRequests, true);
    }
    for (const value of ['', 'off', 'false', '0']) {
      global.$os.getenv = name => name === 'REPLAY_TRACE_REQUESTS' ? value : '';
      assert.equal(core.correlation(data), null);
      assert.equal(replay.publicConfig(f.event({ deviceId: 'device', platform: 'web' })).tracePocketbaseRequests, false);
    }
  } finally { f.close(); }
});

test('explanation log lookups exclude same-hour rows outside the exact recording window', () => {
  const f = fixture();
  try {
    const at = Date.parse('2026-10-15T09:30:00.000Z');
    const recording = session(f, '', { startedAt: at, lastSeenAt: at, endedAt: at });
    for (const [n, created] of [[1, at - 900001], [2, at + 900001], [3, at]]) {
      f.log({ created, data: requestData({ meta: { replayRequest: id(n) }, status: 500, error: '' }) });
    }
    const result = pocketbase.explain(f.event({ sessionId: recording.id, requests: [1, 2, 3].map(n => ({ request: id(n), status: 400 })) }));
    assert.deepEqual(result.items.map(item => item.server && item.server.status), [undefined, undefined, 500]);
  } finally { f.close(); }
});

test('a returned 500 with a linked server issue remains a server verdict rather than a thrown-hook verdict', () => {
  const { f, logged, explain } = explainFixture();
  try {
    const data = requestData({ status: 500, error: '', meta: { replayRequest: id(1) } });
    observability.serverError(f.app, core.logError(requestRow(data)));
    logged(1, data);
    const answer = explain([{ request: id(1), method: 'GET', path: '/api/collections/orders/records', status: 500 }]).items[0];
    assert.ok(answer.issue.id);
    assert.equal(answer.verdict, 'server');
  } finally { f.close(); }
});
