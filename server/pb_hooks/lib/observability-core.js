const replay = require('./replay-core.js');

const LIMITS = {
  envelopeBytes: 64 * 1024,
  eventBytes: 16 * 1024,
  batchEvents: 20,
  attributesBytes: 4096,
  contextMs: 4 * 60 * 60 * 1000,
  // A refresh extends a live credential, but writes the new expiry at most this often.
  contextRenewMs: 10 * 60 * 1000,
  ipBytesPerHour: 8 * 1024 * 1024,
  uploadIntervalMs: 10000,
  webhookChars: 2048,
};
const DEFAULTS = {
  errors_enabled: false, logs_enabled: false, alerts_enabled: true,
  errors_retention_days: 30, logs_retention_days: 14, daily_limit_mb: 64, alert_webhook_url: '',
};
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const PRIVATE_KEY = /password|passwd|secret|token|authorization|cookie|email|phone|credit.?card|api.?key/i;

// A plain http(s) address. The host part cannot carry credentials, and nothing may contain spaces or control characters.
function webhook(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > LIMITS.webhookChars ||
      !/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s\x00-\x1f\x7f]*)?$/i.test(value)) replay.fail(400, 'Invalid alert_webhook_url');
  return value;
}

function settings(value) {
  replay.object(value);
  const result = {};
  for (const key of ['errors_enabled', 'logs_enabled', 'alerts_enabled']) {
    if (typeof value[key] !== 'boolean') replay.fail(400, 'Invalid ' + key);
    result[key] = value[key];
  }
  for (const key of ['errors_retention_days', 'logs_retention_days']) result[key] = replay.integer(value[key], key, 1, 365);
  result.daily_limit_mb = replay.integer(value.daily_limit_mb, 'daily_limit_mb', 1, 1048576);
  result.alert_webhook_url = webhook(value.alert_webhook_url);
  return result;
}

function bytes(value) {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) length++;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

function redact(value) {
  return value
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, function (url) {
      return url.replace(/^(\w+:\/\/)[^/]*@/, '$1').split(/[?#]/)[0];
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:password|passwd|secret|token|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[^\s,;}]+)/gi, function (match) {
      return match.split(/[:=]/)[0] + '=[redacted]';
    })
    // Bounded like real addresses, so a long run of dots without an @ cannot make a backtracking engine crawl.
    .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}/gi, '[redacted]');
}

// A redaction marker can be longer than what it replaces, so the result is cut back to the field's limit.
function label(value, max) { return redact(value).slice(0, max); }

function content(value, key, max, required) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value)) replay.fail(400, 'Invalid ' + key);
  return label(value, max);
}

function attributes(value) {
  if (value === undefined || value === null) return {};
  replay.object(value);
  if (bytes(JSON.stringify(value)) > LIMITS.attributesBytes) replay.fail(413, 'Attributes are too large');
  function clean(input, depth) {
    if (depth > 4) replay.fail(400, 'Attributes are too deeply nested');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string') return content(input, 'attribute', 1024, false);
    if (Array.isArray(input)) {
      if (input.length > 20) replay.fail(400, 'Too many attribute values');
      return input.map(function (item) { return clean(item, depth + 1); });
    }
    replay.object(input);
    const keys = Object.keys(input);
    if (keys.length > 64) replay.fail(400, 'Too many attributes');
    const output = {};
    keys.forEach(function (key) {
      replay.text(key, 'attribute key', 64, true);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      output[label(key, 64)] = PRIVATE_KEY.test(key) ? '[redacted]' : clean(input[key], depth + 1);
    });
    return output;
  }
  const result = clean(value, 0);
  if (bytes(JSON.stringify(result)) > LIMITS.attributesBytes) replay.fail(413, 'Attributes are too large');
  return result;
}

function event(value, kind, now) {
  replay.object(value);
  if (bytes(JSON.stringify(value)) > LIMITS.eventBytes) replay.fail(413, 'Event is too large');
  const id = replay.text(value.id, 'event id', 64, true);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) replay.fail(400, 'Invalid event id');
  const result = {
    eventId: id,
    timestamp: replay.integer(value.timestamp, 'timestamp', Math.max(1, now - 365 * 86400000), now + replay.LIMITS.clockSkewMs),
    service: label(replay.text(value.service, 'service', 128, false), 128),
    room: label(replay.text(value.room, 'room', 128, false), 128),
    message: content(value.message, 'message', 4096, true),
    attributes: attributes(value.attributes),
    sessionId: replay.text(value.sessionId, 'sessionId', 15, false),
    sessionToken: replay.text(value.sessionToken, 'sessionToken', 64, false),
  };
  if (result.sessionId && !/^[a-z0-9]{15}$/.test(result.sessionId)) replay.fail(400, 'Invalid sessionId');
  if (!!result.sessionId !== !!result.sessionToken || (result.sessionToken && !/^[A-Za-z0-9]{64}$/.test(result.sessionToken))) replay.fail(400, 'Invalid replay session credentials');
  const level = value.level === undefined ? (kind === 'error' ? 'error' : 'info') : value.level;
  if (!LEVELS.includes(level) || (kind === 'error' && !['error', 'fatal'].includes(level))) replay.fail(400, 'Invalid level');
  result.level = level;
  if (kind === 'error') {
    result.name = label(replay.text(value.name === undefined ? value.type : value.name, 'error name', 128, false) || 'Error', 128);
    result.stack = content(value.stack, 'stack', 8192, false);
    if (value.handled !== undefined && typeof value.handled !== 'boolean') replay.fail(400, 'Invalid handled');
    result.handled = value.handled === true;
  }
  return result;
}

function batch(value, kind, now) {
  replay.object(value);
  const token = replay.text(value.token, 'token', 64, true);
  if (!/^[A-Za-z0-9]{64}$/.test(token)) replay.fail(401, 'Invalid observability token');
  if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > LIMITS.batchEvents) replay.fail(400, 'Invalid event batch');
  const seen = Object.create(null);
  const events = value.events.map(function (item) {
    const result = event(item, kind, now);
    if (seen[result.eventId]) replay.fail(400, 'Duplicate event id in batch');
    seen[result.eventId] = true;
    return result;
  });
  return { token: token, events: events };
}

// Chrome ("at fn (file:1:2)") and Safari or Firefox ("fn@file:1:2") frames, reduced to function and file.
// The origin differs between Android and iOS WebViews and the build hash changes with every release,
// so neither is kept. Line numbers move with any edit, and engines disagree about native frames.
function frames(stack) {
  const result = [];
  stack.split('\n').forEach(function (raw) {
    const line = raw.trim();
    let match = /^at (?:(.+?) \((.*)\)|(.+))$/.exec(line);
    let fn = '';
    let file = '';
    if (match) { fn = match[1] || ''; file = match[2] || match[3] || ''; }
    // A colon before the @ is Chrome's "Name: message" first line, not a frame.
    else if ((match = /^([^@:]*)@(\S+)$/.exec(line))) { fn = match[1]; file = match[2]; }
    else return;
    if (/^(?:native|<anonymous>|\[native code\])$/.test(file)) return;
    file = file.replace(/:\d+(?::\d+)?$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '')
      .replace(/-[A-Za-z0-9_-]{8}(?=\.m?js$)/, '').replace(/\.[0-9a-f]{8,}(?=(?:\.chunk)?\.m?js$)/i, '');
    fn = fn.replace(/^(?:async |new )+/, '').replace(/^.*\./, '');
    // One- and two-letter names are a minifier's, and they change between builds.
    if (fn.length <= 2 || /^(?:<anonymous>|anonymous|global code|eval code|module code)$/.test(fn)) fn = '?';
    result.push(fn + '@' + file);
  });
  return result.slice(0, 5);
}

function fingerprint(value, hash) {
  const top = frames(value.stack);
  // Minified frames all read "?@index.js" and cannot tell two errors apart, so the message decides instead.
  const named = top.filter(function (frame) { return frame.charAt(0) !== '?'; }).length;
  const message = named >= 2 ? '' : value.message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/\b(?=[a-z]*\d)[a-z0-9]{15}\b/g, '#')
    .replace(/\b(?:0x[0-9a-f]+|(?=[a-f]*\d)[0-9a-f]{8,}|\d+(?:\.\d+)?)\b/gi, '#');
  return hash(JSON.stringify([value.service, value.name, top, message]));
}

module.exports = {
  LIMITS: LIMITS, DEFAULTS: DEFAULTS, LEVELS: LEVELS, settings: settings, webhook: webhook, bytes: bytes, redact: redact,
  label: label, event: event, batch: batch, frames: frames, fingerprint: fingerprint,
};
