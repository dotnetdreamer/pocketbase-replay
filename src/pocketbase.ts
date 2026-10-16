// What a call to the app's PocketBase client is recorded as: how PocketBase routes it and how it ended, never the
// values sent or returned. The server reads the same path rules in server/pb_hooks/lib/pocketbase-core.js.
export const POCKETBASE_LIMITS = { pathChars: 300, messageChars: 500, fieldMessageChars: 200, fields: 20, batch: 50, topics: 20, queryChars: 200 };
// The header that lets the replay server find the call in PocketBase's request log.
export const LINK_HEADER = 'X-Replay-Request';

const AUTH_ACTIONS = new Set([
  'auth-methods', 'auth-refresh', 'auth-with-password', 'auth-with-oauth2', 'auth-with-otp', 'request-otp', 'request-password-reset',
  'confirm-password-reset', 'request-verification', 'confirm-verification', 'request-email-change', 'confirm-email-change',
]);
const COLLECTION = /^[A-Za-z0-9_]{1,100}$/;
const RECORD = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
// Field names, sort keys and modifiers such as excerpt(200,true); anything else may hold a value and is left out.
const IDENTIFIERS = /^[A-Za-z0-9_.,:@()+\- ]+$/;

export interface PocketBaseCall { method: string; path: string; collection?: string; action?: string; record?: string }
export interface FieldError { field: string; code: string }
export interface CallQuery { filter?: true; sort?: string; expand?: string; fields?: string; skipTotal?: true; unreadable?: true }
export interface CallOutcome { status: number; failed?: 'abort' | 'error'; message?: string; invalid?: FieldError[] }

// Custom validation messages can echo any submitted value. Only PocketBase's fixed answers are safe to retain;
// field failures carry their names and codes instead of their free-form messages.
const STANDARD_ERRORS = new Set([
  'Failed to create record.', 'Failed to update record.', 'Failed to delete record.',
  "The requested resource wasn't found.", 'Only superusers can perform this action.',
  'Something went wrong while processing your request.', 'Failed to authenticate.', 'Missing or invalid authentication.',
]);

export function standardErrorMessage(value: unknown): string | undefined {
  return typeof value === 'string' && STANDARD_ERRORS.has(value.trim()) ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Getters on app objects may throw; a value that cannot be read counts as absent.
function read(owner: unknown, key: string): unknown {
  try { return owner && typeof owner === 'object' ? (owner as Record<string, unknown>)[key] : undefined; } catch { return undefined; }
}

function decode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function methodOf(value: unknown): string {
  return (typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10) : '') || 'GET';
}

// The path PocketBase routes, without query or fragment, and the collection, action and record it names.
export function describeCall(method: unknown, path: unknown): PocketBaseCall {
  const verb = methodOf(method);
  let clean = typeof path === 'string' ? path.split(/[?#]/, 1)[0].replace(/[\x00-\x1f\x7f]/g, '') : '';
  if (!clean.startsWith('/')) clean = `/${clean}`;
  clean = clean.slice(0, POCKETBASE_LIMITS.pathChars);
  const call: PocketBaseCall = { method: verb, path: clean };
  const parts = clean.split('/').slice(1).map(decode);
  if (parts[0] !== 'api') return call;
  if (parts.length === 2 && parts[1] === 'batch' && verb === 'POST') return { ...call, action: 'batch' };
  if (parts.length === 2 && parts[1] === 'realtime' && verb === 'POST') return { ...call, action: 'realtime' };
  if (parts.length === 3 && parts[1] === 'files' && parts[2] === 'token' && verb === 'POST') return { ...call, action: 'file-token' };
  if (parts[1] !== 'collections' || !COLLECTION.test(parts[2] ?? '')) return call;
  const collection = parts[2];
  const rest = parts.slice(3);
  if (rest.length === 1 && rest[0] === 'records') {
    const action = verb === 'GET' ? 'list' : verb === 'POST' ? 'create' : '';
    return action ? { ...call, collection, action } : { ...call, collection };
  }
  if (rest.length === 2 && rest[0] === 'records' && RECORD.test(rest[1])) {
    const action = verb === 'GET' ? 'view' : verb === 'PATCH' ? 'update' : verb === 'DELETE' ? 'delete' : '';
    return action ? { ...call, collection, action, record: rest[1] } : { ...call, collection, record: rest[1] };
  }
  if (rest.length === 1 && AUTH_ACTIONS.has(rest[0])) return { ...call, collection, action: rest[0] };
  if (rest.length === 2 && rest[0] === 'impersonate' && RECORD.test(rest[1]) && verb === 'POST') return { ...call, collection, action: 'impersonate', record: rest[1] };
  return { ...call, collection };
}

// The query a call sends. The SDK's list methods pass filter, sort and the like as top-level options, which it
// moves into the query itself; those win over `query`, which wins over the older `params`.
export function queryOf(options: unknown): Record<string, unknown> | undefined {
  if (!record(options)) return undefined;
  const merged: Record<string, unknown> = { ...record(read(options, 'params')), ...record(read(options, 'query')) };
  for (const key of ['filter', 'sort', 'expand', 'fields', 'skipTotal']) {
    const value = read(options, key);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

// Whether a filter was used, and the field names a list sorted, expanded or picked. A filter's text holds values.
export function describeQuery(value: unknown): CallQuery | undefined {
  const query = record(value);
  if (!query) return undefined;
  const result: CallQuery = {};
  const filter = read(query, 'filter');
  if (typeof filter === 'string' && filter.trim()) result.filter = true;
  for (const key of ['sort', 'expand', 'fields'] as const) {
    const item = read(query, key);
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (text && text.length <= POCKETBASE_LIMITS.queryChars && IDENTIFIERS.test(text)) result[key] = text;
    else if (text) result.unreadable = true;
  }
  const skip = read(query, 'skipTotal');
  if (skip === true || skip === 1 || skip === '1' || skip === 'true') result.skipTotal = true;
  return Object.keys(result).length ? result : undefined;
}

// Counts from a successful answer: a list's items and total, or the id a record call returned.
export function describeResult(call: PocketBaseCall, data: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (call.action === 'list') {
    const items = read(data, 'items');
    if (Array.isArray(items)) result.items = items.length;
    const total = count(read(data, 'totalItems'));
    if (total !== undefined) result.total = total;
    const page = count(read(data, 'page')), perPage = count(read(data, 'perPage'));
    if (page) result.page = page;
    if (perPage) result.perPage = perPage;
  } else if (call.action === 'create' || call.action === 'view' || call.action === 'update') {
    const id = read(data, 'id');
    if (typeof id === 'string' && RECORD.test(id)) result.record = id;
  } else if (call.collection && call.action && /^auth-(?:with|refresh)/.test(call.action)) {
    // Only who signed in; the token in the same answer is never read.
    const id = read(read(data, 'record'), 'id');
    if (typeof id === 'string' && RECORD.test(id)) result.record = id;
  }
  return result;
}

// How a call failed: PocketBase's status and message, and the names and codes of the fields it refused.
export function describeFailure(error: unknown, _sensitiveText: string[] = []): CallOutcome {
  const status = count(read(error, 'status')) ?? 0;
  const name = read(error, 'name');
  const abort = read(error, 'isAbort') === true || name === 'AbortError';
  if (!status) return { status: 0, failed: abort ? 'abort' : 'error' };
  const outcome: CallOutcome = { status };
  const answer = record(read(error, 'response')) ?? record(read(error, 'data')) ?? {};
  const message = standardErrorMessage(read(answer, 'message'));
  if (message) outcome.message = message;
  const fields = record(read(answer, 'data'));
  const invalid: FieldError[] = [];
  for (const field of Object.keys(fields ?? {})) {
    if (invalid.length >= POCKETBASE_LIMITS.fields) break;
    const detail = record(read(fields, field));
    const code = read(detail, 'code');
    if (!FIELD.test(field) || typeof code !== 'string' || !CODE.test(code)) continue;
    invalid.push({ field, code });
  }
  if (invalid.length) outcome.invalid = invalid;
  return outcome;
}

// The calls inside a batch, by method and path only, with the status each got; their bodies stay unread.
export function describeBatch(body: unknown, answers?: unknown): (PocketBaseCall & { status: number })[] {
  let source = body;
  try {
    // A batch with files travels as form data around the same JSON.
    const form = source as { get?: (key: string) => unknown } | null;
    if (form && typeof form.get === 'function' && !Array.isArray(read(form, 'requests'))) {
      const json = form.get('@jsonPayload');
      source = typeof json === 'string' ? JSON.parse(json) : undefined;
    }
  } catch { source = undefined; }
  const requests = read(source, 'requests');
  if (!Array.isArray(requests)) return [];
  const statuses = Array.isArray(answers) ? answers : [];
  return requests.slice(0, POCKETBASE_LIMITS.batch).map((item, index) => ({
    ...describeCall(read(item, 'method'), read(item, 'url')), status: count(read(statuses[index], 'status')) ?? 0,
  }));
}

// The collections a realtime subscription listens to; record ids and options after them are left out.
export function describeTopics(body: unknown): string[] {
  const subscriptions = read(body, 'subscriptions');
  if (!Array.isArray(subscriptions)) return [];
  const topics = new Set<string>();
  for (const topic of subscriptions) {
    const collection = typeof topic === 'string' ? topic.split(/[/?]/, 1)[0] : '';
    if (COLLECTION.test(collection)) topics.add(collection);
    if (topics.size >= POCKETBASE_LIMITS.topics) break;
  }
  return Array.from(topics);
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function requestId(): string {
  const bytes = new Uint8Array(20);
  try { globalThis.crypto.getRandomValues(bytes); } catch { for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256); }
  let id = '';
  for (const byte of bytes) id += ID_CHARS[byte % ID_CHARS.length];
  return id;
}

export function linkValue(id: string, session: unknown): string {
  return typeof session === 'string' && /^[a-z0-9]{15}$/.test(session) ? `${id}.${session}` : id;
}

export function originOf(url: unknown, base?: string): string {
  try {
    const origin = new URL(String(url ?? ''), base).origin;
    return origin && origin !== 'null' ? origin : '';
  } catch { return ''; }
}
