const core = require('./observability-core.js');

const HEADER = /^([a-z0-9]{20})(?:\.([a-z0-9]{15}))?$/;
const RECORDS = /^\/api\/collections\/([A-Za-z0-9_]{1,100})\/records$/;
const RECORD = /^\/api\/collections\/([A-Za-z0-9_]{1,100})\/records\/([A-Za-z0-9_-]{1,128})$/;
const IMPERSONATE = /^\/api\/collections\/([A-Za-z0-9_]{1,100})\/impersonate\/([A-Za-z0-9_-]{1,128})$/;
const COLLECTION_ACTION = /^\/api\/collections\/([A-Za-z0-9_]{1,100})\/([a-z0-9-]{1,32})$/;
const AUTH_ACTIONS = [
  'auth-methods', 'auth-refresh', 'auth-with-password', 'auth-with-oauth2', 'auth-with-otp', 'request-otp', 'request-password-reset',
  'confirm-password-reset', 'request-verification', 'confirm-verification', 'request-email-change', 'confirm-email-change',
];
const RULES = { list: 'listRule', view: 'viewRule', create: 'createRule', update: 'updateRule', delete: 'deleteRule' };
const AUTH_RULE_ACTIONS = ['auth-with-password', 'auth-with-otp', 'auth-with-oauth2', 'auth-refresh'];
const CRON_FAILURE = '[cronAdd] failed to execute cron job';
// PocketBase answers a missing row or file with 404, even wrapped in another error.
const NOT_FOUND = /(?:^|: )(?:sql: no rows in result set|file does not exist)$/;
// A client that went away is no fault of the server.
const GONE = /\b(?:broken pipe|connection reset by peer|context canceled)\b/i;
// Bounded like real addresses, so no input makes the engine backtrack for long.
const IP = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b|\[[0-9A-Fa-f.]{0,39}:[0-9A-Fa-f:.]{1,45}\]/g;
const LIMITS = { name: 128, message: 4096, stack: 8192, path: 300, error: 500, details: 1000, fields: 20, field: 64, fieldMessage: 200, logValues: 10 };
const STANDARD_ERRORS = [
  'Failed to create record.', 'Failed to update record.', 'Failed to delete record.',
  "The requested resource wasn't found.", 'Only superusers can perform this action.',
  'Something went wrong while processing your request.', 'Failed to authenticate.', 'Missing or invalid authentication.',
];
const IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;

function header(value) {
  const match = typeof value === 'string' ? HEADER.exec(value) : null;
  return match ? { request: match[1], session: match[2] || '' } : null;
}

function tracingEnabled() {
  try { return /^(?:on|true|1|yes)$/i.test(($os.getenv('REPLAY_TRACE_REQUESTS') || '').trim()); } catch (_) { return false; }
}

// A URL marker survives user hooks that run before our correlation hook. Only read our bounded IDs, and only
// under the same explicit tracing opt-in; query values never become explanation or issue attributes.
function correlation(data) {
  const meta = data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta) ? data.meta : {};
  if (typeof meta.replayRequest === 'string' && /^[a-z0-9]{20}$/.test(meta.replayRequest)) {
    return { request: meta.replayRequest, session: typeof meta.replaySession === 'string' && /^[a-z0-9]{15}$/.test(meta.replaySession) ? meta.replaySession : '' };
  }
  if (!tracingEnabled() || typeof data.url !== 'string') return null;
  const match = /[?&]__replayRequest=([a-z0-9]{20}(?:\.[a-z0-9]{15})?)(?:&|$)/.exec(data.url);
  return match ? header(match[1]) : null;
}

// Which collection, action and record a PocketBase API call names, by the same rules as the client.
function request(method, path) {
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  const clean = typeof path === 'string' ? path.split(/[?#]/)[0] : '';
  const result = { method: verb, path: clean };
  let match;
  let action = '';
  if ((match = RECORDS.exec(clean))) action = verb === 'GET' ? 'list' : verb === 'POST' ? 'create' : '';
  else if ((match = RECORD.exec(clean))) action = verb === 'GET' ? 'view' : verb === 'PATCH' ? 'update' : verb === 'DELETE' ? 'delete' : '';
  else if ((match = IMPERSONATE.exec(clean))) action = verb === 'POST' ? 'impersonate' : '';
  else if ((match = COLLECTION_ACTION.exec(clean))) action = (verb === 'GET' || verb === 'POST') && AUTH_ACTIONS.indexOf(match[2]) >= 0 ? match[2] : '';
  else if (verb === 'POST') action = clean === '/api/batch' ? 'batch' : clean === '/api/realtime' ? 'realtime' : clean === '/api/files/token' ? 'file-token' : '';
  if (!action) return result;
  result.action = action;
  if (match) {
    result.collection = match[1];
    if (['view', 'update', 'delete', 'impersonate'].indexOf(action) >= 0) result.record = match[2];
  }
  return result;
}

function ruleName(action, type) {
  if (Object.prototype.hasOwnProperty.call(RULES, action)) return RULES[action];
  return type === 'auth' && AUTH_RULE_ACTIONS.indexOf(action) >= 0 ? 'authRule' : '';
}

// A goja position, "/any/dir/pb.js:2:65(13)", as "pb.js:2:65", so a stack groups the same on every host.
function place(text) {
  const match = /^(.*?)(:\d+:\d+)(?:\(\d+\))?$/.exec(text);
  return match ? match[1].split(/[\\/]/).pop() + match[2] : text;
}

function frame(text) {
  const match = /^(\S+) \((.+)\)$/.exec(text);
  if (match) return match[2] === 'native' ? text : match[1] + ' (' + place(match[2]) + ')';
  return place(text);
}

// PocketBase's own texts: hook paths reduced to their file, addresses and secrets redacted, then cut to the limit.
function clip(value, max) {
  const text = String(value === undefined || value === null ? '' : value).slice(0, max + 4096)
    .replace(/[^\s()]+/g, function (token) { return /:\d+:\d+$/.test(token) ? place(token) : token; })
    .replace(/(:\d+:\d+)\(\d+\)/g, '$1')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(IP, '[ip]');
  return core.label(text, max);
}

// "TypeError: message at /any/dir/pb.js:1:32(4)", as PocketBase logs a thrown JavaScript error. Only such a text
// ends in a goja position, so only then is its first word a name; a Go error's text is all message.
function thrown(value, fallback) {
  let message = String(value || '').slice(0, LIMITS.stack);
  const split = /^([\s\S]*) at ((?:\S{1,512} \()?(?:(?:[A-Za-z]:)?[\\/][^\n]{0,1024}?|[\w.-]{1,256}):\d+:\d+(?:\(\d+\))?\)?|\S{1,512} \(native\))$/.exec(message);
  if (!split) return { name: fallback || 'Error', message: clip(message, LIMITS.message) || '(no message)', stack: '' };
  message = split[1];
  let name = 'Error';
  const named = /^([A-Za-z_$][\w$]{0,127}): ([\s\S]*)$/.exec(message);
  if (named) { name = named[1]; message = named[2]; }
  message = clip(message, LIMITS.message) || '(no message)';
  return { name: name, message: message, stack: clip(name + ': ' + message + '\n    at ' + frame(split[2]), LIMITS.stack) };
}

// The status PocketBase answered with. It logs 0 for an error that is not an ApiError, such as a thrown
// JavaScript error, and answers that with 400, or with 404 for a missing row or file.
function answered(data) {
  const logged = Number.isSafeInteger(data.status) ? data.status : 0;
  return logged === 0 && typeof data.error === 'string' && data.error ? (NOT_FOUND.test(data.error) ? 404 : 400) : logged;
}

// A request PocketBase failed in a way nobody meant: a 5xx, or an error it logged with status 0, such as a hook's
// TypeError. Other statuses are its answers, and so are a missing row or file and a client that went away.
// The call's ID and recording come from the meta the request hooks put in the log.
function requestLogError(data, entry) {
  const logged = Number.isSafeInteger(data.status) ? data.status : 0;
  const error = typeof data.error === 'string' ? data.error : '';
  if ((logged < 500 && (!error || logged !== 0)) || NOT_FOUND.test(error) || GONE.test(error)) return null;
  let parsed;
  if (logged >= 500) {
    const details = typeof data.details === 'string' && data.details !== error ? data.details : '';
    parsed = { name: 'ApiError', message: clip(details ? error.replace(/\.$/, '') + ': ' + details : error, LIMITS.message) || 'HTTP ' + logged + ' server error', stack: '' };
  } else parsed = thrown(error, 'GoError');
  const linked = correlation(data);
  const call = request(typeof data.method === 'string' ? data.method : '', typeof data.url === 'string' ? data.url : '');
  const attributes = { source: 'request', method: call.method.slice(0, 16), path: clip(call.path, LIMITS.path), status: answered(data) };
  if (call.collection) attributes.collection = call.collection;
  if (call.action) attributes.action = call.action;
  if (linked) attributes.requestId = linked.request;
  attributes.auth = typeof data.auth === 'string' ? clip(data.auth, 100) : '';
  entry.name = parsed.name;
  entry.message = parsed.message;
  entry.stack = parsed.stack;
  entry.attributes = attributes;
  // PocketBase logs authId only when its logs.logAuthId setting is on.
  entry.accountId = data.auth !== '_superusers' && typeof data.authId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.authId) ? data.authId : '';
  entry.sessionId = linked ? linked.session : '';
  return entry;
}

// Up to ten plain values of a logged error's data, redacted like client attributes, within their size limit.
function logAttributes(data) {
  const result = { source: 'log' };
  let count = 0;
  for (const key of Object.keys(data)) {
    if (count >= LIMITS.logValues) break;
    const value = data[key];
    const name = clip(key, 64);
    if (!name || name === 'source' || name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    if (!(value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) continue;
    result[name] = core.PRIVATE_KEY.test(key) ? '[redacted]' : typeof value === 'string' ? clip(value, 1024) : value;
    if (core.bytes(JSON.stringify(result)) > core.LIMITS.attributesBytes) { delete result[name]; continue; }
    count++;
  }
  return result;
}

function logData(row) {
  let data;
  try { data = JSON.parse(String(row.data || '{}')); } catch (_) { data = null; }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

// An error-level PocketBase log row as a server error, or null for a request PocketBase answered as meant.
// The row's own ID is the event ID, so scanning the same row again stores nothing.
function logError(row) {
  const data = logData(row);
  const timestamp = Date.parse(String(row.created).replace(' ', 'T'));
  const entry = { eventId: 'log-' + String(row.id).slice(0, 60), timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now(), accountId: '', sessionId: '' };
  if (data.type === 'request') return requestLogError(data, entry);
  if (row.message === CRON_FAILURE) {
    const parsed = thrown(typeof data.error === 'string' ? data.error : '', 'Error');
    entry.name = parsed.name;
    entry.message = parsed.message;
    entry.stack = parsed.stack;
    entry.attributes = { source: 'cron', jobId: clip(data.jobId, 128) };
  } else {
    entry.name = 'LoggedError';
    entry.message = clip(row.message, LIMITS.message) || '(no message)';
    entry.stack = '';
    entry.attributes = logAttributes(data);
  }
  return entry;
}

function logTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ');
}

// The hour buckets PocketBase indexes its logs by, from the hour holding `from` through `to`.
function hours(from, to) {
  const result = [];
  for (let at = Math.floor(from / 3600000) * 3600000; at <= to && result.length < 14; at += 3600000) result.push(logTime(at).slice(0, 13) + ':00:00');
  return result;
}

// One request the dashboard asks about, bounded and parsed by the same path rules as the client, with what the app
// itself received: PocketBase's message and how many fields it refused (-1 when unknown).
// Anything that is not an object with a well-formed request ID is passed over.
function explainInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.request !== 'string' || !/^[a-z0-9]{20}$/.test(value.request)) return null;
  const method = typeof value.method === 'string' && /^[A-Za-z]{1,16}$/.test(value.method) ? value.method : '';
  const call = request(method, typeof value.path === 'string' ? value.path.slice(0, 2048) : '');
  return {
    request: value.request, collection: call.collection || '', action: call.action || '', record: call.record || '',
    status: Number.isSafeInteger(value.status) && value.status >= 0 && value.status <= 999 ? value.status : 0,
    items: Number.isSafeInteger(value.items) && value.items >= 0 ? value.items : -1,
    message: typeof value.message === 'string' ? value.message.slice(0, 500) : '',
    fields: Number.isSafeInteger(value.fields) && value.fields >= 0 ? value.fields : -1,
  };
}

function fieldList(details) {
  const result = [];
  for (const key of Object.keys(details)) {
    if (result.length >= LIMITS.fields) break;
    const value = details[key];
    if (!IDENTIFIER.test(key) || !(typeof value === 'string' || (value && typeof value === 'object'))) continue;
    const code = value && typeof value === 'object' && typeof value.code === 'string' && IDENTIFIER.test(value.code) ? value.code : '';
    result.push({ field: key, code: code });
  }
  return result;
}

// What PocketBase logged for one request, without its URL, addresses, user agent or referer.
function logInfo(data) {
  const logged = Number.isSafeInteger(data.status) ? data.status : 0;
  const error = typeof data.error === 'string' ? data.error : '';
  const server = { status: answered(data) };
  if (typeof data.execTime === 'number' && Number.isFinite(data.execTime)) server.ms = Math.round(data.execTime * 10) / 10;
  server.auth = typeof data.auth === 'string' ? clip(data.auth, 100) : '';
  if (typeof data.authId === 'string' && data.authId) server.authId = clip(data.authId, 128);
  // A custom hook can echo submitted values in either error or details. Preserve only fixed PocketBase answers;
  // raw log text remains available in the separate server issue diagnostics.
  if (STANDARD_ERRORS.indexOf(error.trim()) >= 0) server.error = error.trim();
  if (data.details && typeof data.details === 'object' && !Array.isArray(data.details)) {
    const fields = fieldList(data.details);
    if (fields.length) server.fields = fields;
  }
  return {
    server: server, thrown: logged === 0 && /^[A-Za-z]*Error: /.test(error),
    ruleFailure: typeof data.details === 'string' && /^create rule failure(?::|$)/.test(data.details),
  };
}

// The first explanation that applies. Superusers skip API rules, so rule-based verdicts never apply to them.
function verdict(item) {
  const server = item.server;
  const status = server ? server.status : item.status;
  const superuser = !!server && server.auth === '_superusers';
  const lookup = item.action === 'view' || item.action === 'update' || item.action === 'delete';
  if (status >= 500) return 'server';
  if (item.issue || item.thrown) return 'hook';
  if (!superuser && status === 403 && item.rule && item.rule.expression === null) return 'locked';
  if (!superuser && item.ruleFailure) return 'rule';
  if (status === 404 && lookup && item.record === 'missing') return 'missing';
  if (status === 400 && server && server.fields && server.fields.length) return 'validation';
  if (!superuser && item.action === 'list' && item.items === 0 && item.rule && item.rule.expression) return 'filtered';
  return '';
}

// Current rules and fixed generic answers support qualified guesses, with or without a matched log. A log can
// identify superusers and thrown errors, but its generic 400 still cannot distinguish a query from a hook error.
function inferred(item) {
  const status = item.server ? item.server.status : item.status;
  const lookup = item.action === 'view' || item.action === 'update' || item.action === 'delete';
  if ((!item.server || item.server.auth !== '_superusers') && status === 404 && lookup && item.record === 'exists' &&
      item.rule && typeof item.rule.expression === 'string' && item.rule.expression) return 'rule';
  if (status === 400 && (item.server ? item.server.error : item.message) === 'Something went wrong while processing your request.') return 'hook';
  if (item.server) return '';
  if (item.action === 'create' && item.status === 400 && item.fields === 0 && item.message === 'Failed to create record.' &&
      item.rule && typeof item.rule.expression === 'string' && item.rule.expression) return 'rule';
  return '';
}

module.exports = {
  LIMITS: LIMITS, CRON_FAILURE: CRON_FAILURE, header: header, tracingEnabled: tracingEnabled, correlation: correlation,
  request: request, ruleName: ruleName, clip: clip, thrown: thrown, logError: logError,
  logTime: logTime, hours: hours, explainInput: explainInput, logInfo: logInfo, verdict: verdict, inferred: inferred,
};
