const LIMITS = {
  envelopeBytes: 512 * 1024,
  rawBytes: 2 * 1024 * 1024,
  compressedBytes: 384 * 1024,
  sessionBytes: 40 * 1024 * 1024,
  sessionRawBytes: 96 * 1024 * 1024,
  sessionEvents: 500000,
  sessionChunks: 2048,
  sessionMs: 4 * 60 * 60 * 1000,
  uploadIntervalMs: 25000,
  ipBytesPerHour: 64 * 1024 * 1024,
  clockSkewMs: 24 * 60 * 60 * 1000,
  selectorChars: 20000,
};
const DEFAULTS = { mode: 'off', percentage: 0, account_ids: [], retention_days: 14, daily_limit_mb: 1024, mask_selector: '', block_selector: '', record_images: false };

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected an object');
  return value;
}

function text(value, name, max, required) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(400, 'Invalid ' + name);
  if (required && !value) fail(400, 'Missing ' + name);
  return value;
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, 'Invalid ' + name);
  return value;
}

// Tabs and line breaks are allowed for layout; rules are still separated by commas.
function selector(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > LIMITS.selectorChars || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(400, 'Invalid ' + name);
  return value;
}

// Missing means off: a server or dashboard that predates the setting never records images.
function flag(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(400, 'Invalid ' + name);
  return value;
}

function metadata(value) {
  const body = object(value);
  const room = text(body.room, 'room', 128, false);
  if (room.includes('|')) fail(400, 'Invalid room');
  return {
    deviceId: text(body.deviceId, 'deviceId', 128, true),
    accountId: text(body.accountId, 'accountId', 128, false),
    platform: text(body.platform, 'platform', 32, true),
    appVersion: text(body.appVersion, 'appVersion', 64, false),
    room: room,
    authToken: text(body.authToken, 'authToken', 8192, false),
  };
}

function settings(value) {
  object(value);
  if (!['off', 'percentage', 'accounts'].includes(value.mode)) fail(400, 'Invalid mode');
  if (typeof value.percentage !== 'number' || !Number.isFinite(value.percentage) || value.percentage < 0 || value.percentage > 100) fail(400, 'Invalid percentage');
  if (!Array.isArray(value.account_ids) || value.account_ids.length > 2000) fail(400, 'Invalid account_ids');
  const accounts = value.account_ids.map(function (id) { return text(id, 'account id', 128, true); });
  return {
    mode: value.mode,
    percentage: value.percentage,
    account_ids: Array.from(new Set(accounts)),
    retention_days: integer(value.retention_days, 'retention_days', 1, 365),
    daily_limit_mb: integer(value.daily_limit_mb, 'daily_limit_mb', 1, 1048576),
    mask_selector: selector(value.mask_selector, 'mask_selector'),
    block_selector: selector(value.block_selector, 'block_selector'),
    record_images: flag(value.record_images, 'record_images'),
  };
}

function enabled(config, identity, hash) {
  if (config.mode === 'accounts') return !!identity.accountId && config.account_ids.includes(identity.accountId);
  if (config.mode !== 'percentage') return false;
  const bucket = parseInt(hash(identity.accountId || identity.deviceId).slice(0, 8), 16) / 0x100000000;
  return bucket * 100 < config.percentage;
}

function chunk(value, now) {
  const body = object(value);
  const data = text(body.data, 'data', LIMITS.envelopeBytes, true);
  if (body.encoding !== 'gzip-base64' || !/^H4sI[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) fail(400, 'Invalid gzip-base64 data');
  const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
  if (bytes < 20 || bytes > LIMITS.compressedBytes) fail(413, 'Chunk is too large');
  const startedAt = integer(body.startedAt, 'startedAt', 1, now + LIMITS.clockSkewMs);
  const endedAt = integer(body.endedAt, 'endedAt', startedAt, now + LIMITS.clockSkewMs);
  if (endedAt - startedAt > LIMITS.sessionMs) fail(400, 'Chunk time span is too long');
  const room = text(body.room, 'room', 128, false);
  if (room.includes('|') || typeof body.hasSnapshot !== 'boolean') fail(400, 'Invalid chunk metadata');
  const id = text(body.sessionId, 'sessionId', 15, true);
  if (!/^[a-z0-9]{15}$/.test(id)) fail(400, 'Invalid sessionId');
  const token = text(body.token, 'token', 64, true);
  if (!/^[A-Za-z0-9]{64}$/.test(token)) fail(401, 'Invalid upload token');
  return {
    sessionId: id, token: token,
    seq: integer(body.seq, 'seq', 0, Number.MAX_SAFE_INTEGER),
    startedAt: startedAt, endedAt: endedAt, room: room,
    encoding: 'gzip-base64', data: data, compressedBytes: bytes,
    rawBytes: integer(body.rawBytes, 'rawBytes', 2, LIMITS.rawBytes),
    eventCount: integer(body.eventCount, 'eventCount', 1, 50000),
    hasSnapshot: body.hasSnapshot,
  };
}

function page(value, max) {
  if (value === '' || value === undefined || value === null) return 1;
  return integer(Number(value), 'page', 1, max || 100000);
}

function authURL(value) {
  if (!value) return '';
  if (!/^https?:\/\/[A-Za-z0-9.[\]:-]+\/api\/collections\/[A-Za-z0-9_-]+\/auth-refresh$/.test(value)) fail(503, 'Invalid replay auth service configuration');
  return value;
}

function gaps(items, previous) {
  const missing = [];
  items.forEach(function (item) {
    for (let seq = previous + 1; seq < item.seq; seq++) missing.push(seq);
    previous = item.seq;
  });
  return missing;
}

module.exports = { LIMITS: LIMITS, DEFAULTS: DEFAULTS, fail: fail, object: object, text: text, integer: integer, selector: selector, flag: flag, metadata: metadata, settings: settings, enabled: enabled, chunk: chunk, page: page, authURL: authURL, gaps: gaps };
