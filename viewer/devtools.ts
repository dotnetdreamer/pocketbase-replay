import './devtools.css';
import { standardErrorMessage } from '../src/pocketbase';
import type { ReplayEvent } from './decode';
import type { ErrorOccurrence, LogEntry } from './observability';

export type ActivityKind = 'network' | 'console' | 'navigation' | 'click' | 'error' | 'log' | 'trigger' | 'pocketbase';
export type ActivitySeverity = 'info' | 'warn' | 'error';
export interface Activity {
  kind: ActivityKind;
  // The device clock time, as in the events recoverEvents returns.
  timestamp: number;
  title: string;
  detail?: string;
  severity: ActivitySeverity;
  status?: number;
  duration?: number;
  failed?: 'error' | 'abort' | 'timeout';
  level?: string;
  uncaught?: true;
  pocketbase?: PocketBaseCall;
  // What the replay server says about a PocketBase call, once asked.
  explanation?: ExplanationState;
}
// A call through the app's PocketBase client, as the recorder noted it: no values, only how it was routed and ended.
export interface PocketBaseCall {
  request: string; method: string; path: string; collection?: string; action?: string; record?: string;
  status: number; duration?: number; failed?: 'abort' | 'error'; linked: boolean; server: boolean;
  items?: number; total?: number; query?: { filter?: true; sort?: string; expand?: string; fields?: string; skipTotal?: true; unreadable?: true };
  message?: string; invalid?: { field: string; code: string }[];
  batch?: { method: string; path: string; collection?: string; action?: string; record?: string; status: number }[];
  topics?: string[];
}
// The answer of POST /api/replay/requests for one call.
export interface RequestExplanation {
  request: string;
  server?: { status: number; ms?: number; auth?: string; authId?: string; error?: string; details?: string; fields?: { field: string; code?: string }[] };
  rule?: { name: string; expression: string | null };
  verdict?: 'hook' | 'locked' | 'rule' | 'missing' | 'validation' | 'server' | 'filtered';
  // Worked out from what the app was told, as PocketBase answers that refusal, without a matching log entry.
  likely?: true;
  record?: 'exists' | 'missing';
  issue?: { id: string; title: string };
}
export type ExplanationState = { state: 'pending' } | { state: 'found'; value: RequestExplanation } | { state: 'none'; logs: boolean } | { state: 'failed' };
export interface TimelineMark { timestamp: number; tag: string; color: string }
export interface DevtoolsPanel {
  // `notice` says what the list leaves out, such as stored entries beyond what was loaded.
  show(activities: Activity[], startTimestamp: number, offset?: (timestamp: number) => number, notice?: string): void;
  setTime(timestamp: number): void;
  clear(): void;
}

export const ACTIVITY_LIMITS = {
  marks: 100, rows: 2000, labelText: 40, labelNodes: 200, titleChars: 1000, urlChars: 2048, followPauseMs: 4000,
};
// Bright enough to read on the dashboard's dark progress bar, apart from the cyan idle marks.
export const MARK_COLORS = { error: '#ff5e7b', request: '#ffb64d', trigger: '#b197fc' };

const CONSOLE_LEVELS = new Map([['debug', 'Debug'], ['info', 'Info'], ['log', 'Log'], ['warn', 'Warning'], ['error', 'Error']]);
const LOG_LEVELS = new Map([['trace', 'Trace'], ['debug', 'Debug'], ['info', 'Info'], ['warn', 'Warning'], ['error', 'Error'], ['fatal', 'Fatal']]);
const FAILURES = new Map([['error', 'Failed'], ['abort', 'Cancelled'], ['timeout', 'Timed out']]);
const INTERACTIVE_TAGS = new Set(['a', 'button', 'label', 'summary', 'select', 'option', 'input', 'textarea']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option']);
const TEXTLESS_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head']);
// A diagnostics entry this close to the same recorded console line is that line stored twice.
const DUPLICATE_MS = 2000;
// Seeking to a row lands within float rounding of its time; the row still counts as reached.
const TIME_SLACK_MS = 2;

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function text(value: unknown, limit = ACTIVITY_LIMITS.titleChars): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function oneLine(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
function clip(value: string, limit: number): string {
  const line = oneLine(value);
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function byTime(left: Activity, right: Activity): number { return left.timestamp - right.timestamp; }
function severityOf(level: string): ActivitySeverity { return level === 'error' || level === 'fatal' ? 'error' : level === 'warn' ? 'warn' : 'info'; }

export function clockText(ms: number): string {
  let seconds = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  seconds %= 60;
  return `${ms < 0 ? '-' : ''}${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds).padStart(2, '0')}`;
}

function durationText(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`;
}

function originOf(url: string): string { return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0] ?? ''; }

// Same-origin requests and pages show their path; others keep their host.
function shortUrl(url: string, origin: string): string {
  if (origin && url.startsWith(origin) && (url.length === origin.length || url[origin.length] === '/')) return url.slice(origin.length) || '/';
  return url.replace(/^https?:\/\//i, '');
}

interface DomNode {
  id: number; type: number; tag: string; idName: string; className: string; role: string; text: string;
  parent?: DomNode; first?: DomNode; last?: DomNode; previous?: DomNode; next?: DomNode;
}

// The recorded page as linked nodes, kept current through mutations so a click is named by its element at
// that moment. Only what a label needs is kept, and each change costs constant time.
function createDom() {
  let nodes = new Map<number, DomNode>();

  function setAttributes(node: DomNode, value: unknown, partial: boolean): void {
    const attributes = record(value);
    if (!attributes) return;
    const read = (key: string, current: string) => !(key in attributes) ? (partial ? current : '')
      : typeof attributes[key] === 'string' ? (attributes[key] as string).trim() : '';
    node.idName = read('id', node.idName).slice(0, 64);
    node.className = read('class', node.className).split(/\s+/, 1)[0].slice(0, 64);
    node.role = read('role', node.role).toLowerCase().slice(0, 32);
  }

  function unlink(node: DomNode): void {
    const parent = node.parent;
    if (!parent) return;
    if (node.previous) node.previous.next = node.next; else parent.first = node.next;
    if (node.next) node.next.previous = node.previous; else parent.last = node.previous;
    node.parent = node.previous = node.next = undefined;
  }

  function link(node: DomNode, parent: DomNode, before?: DomNode): void {
    node.parent = parent;
    if (before && before.parent === parent) {
      node.previous = before.previous;
      node.next = before;
      if (before.previous) before.previous.next = node; else parent.first = node;
      before.previous = node;
    } else {
      node.previous = parent.last;
      node.next = undefined;
      if (parent.last) parent.last.next = node; else parent.first = node;
      parent.last = node;
    }
  }

  // A removed node takes its descendants out of the page, as the replayer's mirror does.
  function forget(root: DomNode): void {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (nodes.get(node.id) === node) nodes.delete(node.id);
      for (let child = node.first; child; child = child.next) stack.push(child);
    }
  }

  function add(serialized: unknown, parent?: DomNode, before?: DomNode): void {
    const stack: [unknown, DomNode | undefined][] = [[serialized, parent]];
    let root = true;
    while (stack.length) {
      const [item, owner] = stack.pop()!;
      const value = record(item);
      if (!value || !Number.isInteger(value.id)) { root = false; continue; }
      const existing = nodes.get(value.id as number);
      if (existing) { unlink(existing); forget(existing); }
      const node: DomNode = {
        id: value.id as number, type: Number(value.type), tag: text(value.tagName, 32).toLowerCase(), idName: '', className: '', role: '',
        text: text(value.textContent, 400), parent: undefined, first: undefined, last: undefined, previous: undefined, next: undefined,
      };
      if (node.type === 2) setAttributes(node, value.attributes, false);
      nodes.set(node.id, node);
      if (owner) link(node, owner, root ? before : undefined);
      root = false;
      const children = value.childNodes;
      if (Array.isArray(children)) for (let index = children.length - 1; index >= 0; index--) stack.push([children[index], node]);
    }
  }

  function list(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!record(item)) : [];
  }

  // Applied in the order rrweb's replayer applies them.
  function mutate(data: Record<string, unknown>): void {
    for (const item of list(data.removes)) {
      const node = nodes.get(Number(item.id));
      if (node) { unlink(node); forget(node); }
    }
    for (const item of list(data.adds)) {
      const before = item.nextId === null || item.nextId === undefined ? undefined : nodes.get(Number(item.nextId));
      add(item.node, nodes.get(Number(item.parentId)), before);
    }
    for (const item of list(data.texts)) {
      const node = nodes.get(Number(item.id));
      if (node) node.text = text(item.value, 400);
    }
    for (const item of list(data.attributes)) {
      const node = nodes.get(Number(item.id));
      if (node?.type === 2) setAttributes(node, item.attributes, true);
    }
  }

  function interactive(node: DomNode): boolean {
    return node.type === 2 && (INTERACTIVE_TAGS.has(node.tag) || INTERACTIVE_ROLES.has(node.role));
  }

  // Descendant text in page order, within a node and a length budget. Recorded text is already masked.
  function textOf(root: DomNode): string {
    let value = '', visited = 0;
    let node = root.first;
    while (node && visited++ < ACTIVITY_LIMITS.labelNodes && value.length <= ACTIVITY_LIMITS.labelText) {
      if (node.type === 3) {
        const piece = oneLine(node.text.slice(0, 200));
        if (piece) value = value ? `${value} ${piece}` : piece;
      }
      if (node.type === 2 && node.first && !TEXTLESS_TAGS.has(node.tag)) { node = node.first; continue; }
      while (node && node !== root && !node.next) node = node.parent;
      node = node && node !== root ? node.next : undefined;
    }
    return value.length > ACTIVITY_LIMITS.labelText ? `${value.slice(0, ACTIVITY_LIMITS.labelText).trimEnd()}…` : value;
  }

  function label(id: unknown): string {
    let node = nodes.get(Number(id));
    if (node && node.type !== 2) node = node.parent;
    if (!node || node.type !== 2) return '';
    // A tap on an icon or a span inside a control names the control.
    if (!interactive(node)) {
      for (let ancestor = node.parent, depth = 0; ancestor && depth < 4; ancestor = ancestor.parent, depth++) {
        if (interactive(ancestor)) { node = ancestor; break; }
      }
    }
    const name = `${node.tag || 'element'}${node.idName ? `#${node.idName}` : node.className ? `.${node.className}` : ''}`;
    const content = textOf(node);
    return content ? `${name} "${content}"` : name;
  }

  return { reset: (tree: unknown) => { nodes = new Map(); add(tree); }, mutate, label };
}

function networkActivity(payload: Record<string, unknown>, timestamp: number, origin: string): Activity {
  const method = text(payload.method, 16).toUpperCase() || 'GET';
  const url = text(payload.url, ACTIVITY_LIMITS.urlChars);
  const status = finite(payload.status) && payload.status > 0 ? Math.round(payload.status) : 0;
  const duration = finite(payload.duration) && payload.duration >= 0 ? Math.round(payload.duration) : undefined;
  const failed = typeof payload.failed === 'string' && FAILURES.has(payload.failed) ? payload.failed as Activity['failed'] : undefined;
  const outcome = status ? String(status) : failed ? FAILURES.get(failed)! : 'No response';
  return {
    kind: 'network', timestamp, title: `${method} ${shortUrl(url, origin) || '(no URL)'}`,
    detail: duration === undefined ? outcome : `${outcome} · ${durationText(duration)}`,
    severity: !status || status >= 400 ? 'error' : 'info', status, ...(duration === undefined ? {} : { duration }), ...(failed ? { failed } : {}),
  };
}

const POCKETBASE_TEXT = /^[A-Za-z0-9_.,:@()+\- ]{1,200}$/;
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const CALL_ACTIONS = new Set(['list', 'view', 'create', 'update', 'delete', 'batch', 'realtime', 'file-token', 'impersonate', 'auth-methods',
  'auth-refresh', 'auth-with-password', 'auth-with-oauth2', 'auth-with-otp', 'request-otp', 'request-password-reset', 'confirm-password-reset',
  'request-verification', 'confirm-verification', 'request-email-change', 'confirm-email-change']);

function count(value: unknown): number | undefined {
  return finite(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function callName(call: { method: string; path: string; collection?: string; action?: string; record?: string }): string {
  if (call.collection && call.action) return `${call.collection}.${call.action}${call.record ? ` ${call.record}` : ''}`;
  if (call.action === 'batch') return 'Batch';
  if (call.action === 'realtime') return 'Realtime subscription';
  if (call.action === 'file-token') return 'File token';
  return `${call.method} ${call.path}`;
}

function callShape(value: unknown): { method: string; path: string; collection?: string; action?: string; record?: string } {
  const item = record(value) ?? {};
  const collection = text(item.collection, 100), action = text(item.action, 40), name = text(item.record, 128);
  return {
    method: text(item.method, 10).toUpperCase().replace(/[^A-Z]/g, '') || 'GET', path: text(item.path, 300) || '/',
    ...(NAME.test(collection) ? { collection } : {}), ...(CALL_ACTIONS.has(action) ? { action } : {}), ...(NAME.test(name) ? { record: name } : {}),
  };
}

function itemsText(call: PocketBaseCall): string {
  if (call.items === undefined) return '';
  const noun = call.items === 1 && (call.total === undefined || call.total === 1) ? 'item' : 'items';
  return call.total === undefined ? `${call.items} ${noun}` : `${call.items} of ${call.total} ${noun}`;
}

function pocketbaseActivity(payload: Record<string, unknown>, timestamp: number): Activity {
  const shape = callShape(payload);
  const status = count(payload.status) ?? 0;
  const duration = count(payload.duration);
  const failed = payload.failed === 'abort' || payload.failed === 'error' ? payload.failed : undefined;
  const query = record(payload.query);
  const invalid = (Array.isArray(payload.invalid) ? payload.invalid : []).slice(0, 20).map(record)
    .filter((item): item is Record<string, unknown> => !!item && typeof item.field === 'string' && typeof item.code === 'string')
    .map((item) => ({ field: text(item.field, 64), code: text(item.code, 64) }));
  const call: PocketBaseCall = {
    ...shape, request: /^[a-z0-9]{20}$/.test(text(payload.request, 20)) ? text(payload.request, 20) : '', status,
    ...(duration === undefined ? {} : { duration }), ...(failed ? { failed } : {}), linked: payload.linked === true, server: payload.server === true,
    ...(count(payload.items) === undefined ? {} : { items: count(payload.items) }), ...(count(payload.total) === undefined ? {} : { total: count(payload.total) }),
    ...(query ? { query: {
      ...(query.filter === true ? { filter: true as const } : {}), ...(query.skipTotal === true ? { skipTotal: true as const } : {}),
      ...(query.unreadable === true ? { unreadable: true as const } : {}),
      ...Object.fromEntries((['sort', 'expand', 'fields'] as const).filter((key) => typeof query[key] === 'string' && POCKETBASE_TEXT.test(query[key] as string))
        .map((key) => [key, query[key] as string])),
    } } : {}),
    ...(standardErrorMessage(payload.message) ? { message: standardErrorMessage(payload.message) } : {}),
    ...(invalid.length ? { invalid } : {}),
    ...(Array.isArray(payload.batch) ? { batch: payload.batch.slice(0, 50).map((item) => ({ ...callShape(item), status: count(record(item)?.status) ?? 0 })) } : {}),
    ...(Array.isArray(payload.topics) ? { topics: payload.topics.filter((topic): topic is string => typeof topic === 'string' && NAME.test(topic)).slice(0, 20) } : {}),
  };
  const outcome = status ? String(status) : failed === 'abort' ? 'Cancelled' : failed ? 'Failed' : 'No response';
  const parts = [outcome];
  if (call.batch?.length) parts.push(`${call.batch.length} request${call.batch.length === 1 ? '' : 's'}`);
  if (call.topics?.length) parts.push(call.topics.join(', '));
  if (itemsText(call)) parts.push(itemsText(call));
  if (call.invalid) parts.push(`Invalid: ${call.invalid.map((item) => item.field).join(', ')}`);
  if (duration !== undefined) parts.push(durationText(duration));
  return {
    kind: 'pocketbase', timestamp, title: callName(call), detail: parts.join(' · '),
    severity: status >= 400 || failed === 'error' || (!status && !failed) ? 'error' : failed === 'abort' ? 'warn' : 'info',
    status, ...(duration === undefined ? {} : { duration }), ...(failed ? { failed } : {}), pocketbase: call,
  };
}

export interface ExplainRequest { request: string; method: string; path: string; status: number; items?: number; message?: string; fields?: number }

// Calls the replay server may explain: those that failed, came back empty or were slow, sent to that same server.
// A failure also says what the app was told, from which the server can tell some refusals apart without its log.
export function explainable(activities: Activity[], limit = 200): ExplainRequest[] {
  const asked: ExplainRequest[] = [];
  for (const item of activities) {
    const call = item.pocketbase;
    if (!call?.server || !call.request) continue;
    const empty = call.action === 'list' && call.items === 0;
    if (!(call.status >= 400 || (call.linked && !call.status && call.failed !== 'abort') || empty || (call.duration ?? 0) >= 1000)) continue;
    asked.push({
      request: call.request, method: call.method, path: call.path, status: call.status, ...(call.items === undefined ? {} : { items: call.items }),
      ...(call.status >= 400 ? { ...(call.message ? { message: call.message } : {}), fields: call.invalid?.length ?? 0 } : {}),
    });
    if (asked.length >= limit) break;
  }
  return asked;
}

// Asks the replay server about the calls and gives each asked activity what was found. Any failure, such as a
// server without the explain route, leaves the calls marked as unexplained.
export async function loadExplanations(request: (path: string, body?: unknown) => Promise<unknown>, sessionId: string,
  activities: Activity[], current: () => boolean = () => true): Promise<void> {
  const requests = explainable(activities, Infinity);
  const asked = new Set(requests.map((item) => item.request));
  if (!asked.size) return;
  const mine = activities.filter((item) => item.pocketbase && asked.has(item.pocketbase.request));
  for (const item of mine) item.explanation = { state: 'pending' };
  // The endpoint accepts 200 calls and 64 KiB per request. A session may have many more calls.
  const encoder = new TextEncoder();
  const batches: ExplainRequest[][] = [];
  let batch: ExplainRequest[] = [];
  for (const item of requests) {
    if (batch.length && (batch.length >= 200 || encoder.encode(JSON.stringify({ sessionId, requests: [...batch, item] })).byteLength > 60_000)) {
      batches.push(batch); batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  for (const requests of batches) {
    let answer: Record<string, unknown> | undefined;
    try { answer = record(await request('/api/replay/requests', { sessionId, requests })); } catch { answer = undefined; }
    if (!current()) return;
    const found = new Map<string, RequestExplanation>();
    for (const value of Array.isArray(answer?.items) ? answer!.items : []) {
      const item = explanationOf(value);
      if (item) found.set(item.request, item);
    }
    const batchIds = new Set(requests.map((item) => item.request));
    for (const item of mine) {
      if (!batchIds.has(item.pocketbase!.request)) continue;
      const known = found.get(item.pocketbase!.request);
      const value = known && (known.server || known.rule || known.verdict || known.record || known.issue) ? known : undefined;
      item.explanation = !answer ? { state: 'failed' } : value ? { state: 'found', value } : { state: 'none', logs: answer.logs !== false };
      if (value) {
        const verdict = verdictLabel(value, item.pocketbase);
        if (verdict) item.detail = item.detail ? `${item.detail} · ${verdict}` : verdict;
      }
    }
  }
}

function explanationOf(value: unknown): RequestExplanation | undefined {
  const item = record(value);
  if (!item || typeof item.request !== 'string') return undefined;
  const server = record(item.server), rule = record(item.rule), issue = record(item.issue);
  const fields = Array.isArray(server?.fields) ? server!.fields.map(record).filter((field): field is Record<string, unknown> => !!field && typeof field.field === 'string')
    .slice(0, 20).map((field) => ({ field: text(field.field, 64), ...(typeof field.code === 'string' ? { code: text(field.code, 64) } : {}) })) : [];
  const verdicts = ['hook', 'locked', 'rule', 'missing', 'validation', 'server', 'filtered'] as const;
  return {
    request: item.request,
    ...(server ? { server: {
      status: count(server.status) ?? 0, ...(finite(server.ms) && server.ms >= 0 ? { ms: server.ms } : {}),
      ...(typeof server.auth === 'string' ? { auth: text(server.auth, 100) } : {}), ...(typeof server.authId === 'string' && server.authId ? { authId: text(server.authId, 128) } : {}),
      ...(standardErrorMessage(server.error) ? { error: standardErrorMessage(server.error) } : {}),
      ...(server.details === 'create rule failure: sql: no rows in result set' ? { details: server.details } : {}), ...(fields.length ? { fields } : {}),
    } } : {}),
    ...(rule && typeof rule.name === 'string' ? { rule: { name: text(rule.name, 40), expression: typeof rule.expression === 'string' ? text(rule.expression, 2000) : null } } : {}),
    ...(verdicts.includes(item.verdict as typeof verdicts[number]) ? { verdict: item.verdict as RequestExplanation['verdict'],
      ...(item.likely === true ? { likely: true as const } : {}) } : {}),
    ...(item.record === 'exists' || item.record === 'missing' ? { record: item.record } : {}),
    ...(issue && typeof issue.id === 'string' && issue.id ? { issue: { id: text(issue.id, 32), title: text(issue.title, 300) } } : {}),
  };
}

// PocketBase gives the same answer to a hook's error and to a filter, sort, expand or fields value it cannot read,
// so a likely hook error on a call that sent any of those may be either.
function unreadableQuery(call: PocketBaseCall | undefined, value: RequestExplanation): boolean {
  const query = call?.query;
  return !!value.likely && value.verdict === 'hook' && !!query && !!(query.filter || query.sort || query.expand || query.fields || query.unreadable);
}

function verdictLabel(value: RequestExplanation, call?: PocketBaseCall): string {
  const rule = value.rule?.name ?? 'rule';
  if (value.likely && value.verdict === 'rule') return `Likely blocked by ${rule}`;
  if (unreadableQuery(call, value)) return 'Likely an unreadable query or a hook error';
  if (value.likely && value.verdict === 'hook') return 'Likely a hook error';
  switch (value.verdict) {
    case 'hook': return 'Hook error';
    case 'locked': return 'Superusers only';
    case 'rule': return `Blocked by ${rule}`;
    case 'missing': return 'Record not found';
    case 'validation': return 'Invalid fields';
    case 'server': return 'Server error';
    case 'filtered': return `${rule} may hide rows`;
    default: return '';
  }
}

function consoleActivity(payload: Record<string, unknown>, timestamp: number): Activity {
  const level = typeof payload.level === 'string' && CONSOLE_LEVELS.has(payload.level) ? payload.level : 'log';
  const uncaught = payload.uncaught === true;
  return {
    kind: 'console', timestamp, title: text(payload.text) || '(empty message)',
    detail: uncaught ? 'Uncaught error' : CONSOLE_LEVELS.get(level), severity: uncaught ? 'error' : severityOf(level),
    level: uncaught ? 'error' : level, ...(uncaught ? { uncaught: true as const } : {}),
  };
}

export function collectActivity(events: ReplayEvent[]): Activity[] {
  const items: Activity[] = [];
  const dom = createDom();
  let origin = '', page = '';
  const visit = (url: string, timestamp: number) => {
    if (!url || url === page) return;
    page = url;
    items.push({ kind: 'navigation', timestamp, title: shortUrl(url, origin), severity: 'info' });
  };
  for (const event of events) {
    try {
      const data = record(event?.data);
      if (!data || !finite(event.timestamp)) continue;
      if (event.type === 2) dom.reset(data.node);
      else if (event.type === 3 && data.source === 0) dom.mutate(data);
      else if (event.type === 3 && data.source === 2 && (data.type === 2 || data.type === 4)) {
        items.push({ kind: 'click', timestamp: event.timestamp, title: dom.label(data.id) || 'Unknown element',
          ...(data.type === 4 ? { detail: 'Double click' } : {}), severity: 'info' });
      } else if (event.type === 4) {
        // Each meta event names the page a full snapshot was taken on, which also gives the first page.
        const href = text(data.href, ACTIVITY_LIMITS.urlChars);
        if (href) { origin = originOf(href); visit(href, event.timestamp); }
      } else if (event.type === 5 && typeof data.tag === 'string') {
        const payload = record(data.payload) ?? {};
        if (data.tag === 'pbr/network') items.push(networkActivity(payload, event.timestamp, origin));
        else if (data.tag === 'pbr/pocketbase') items.push(pocketbaseActivity(payload, event.timestamp));
        else if (data.tag === 'pbr/console') items.push(consoleActivity(payload, event.timestamp));
        else if (data.tag === 'pbr/navigation') visit(text(payload.url, ACTIVITY_LIMITS.urlChars), event.timestamp);
        else if (data.tag === 'pbr/trigger') {
          const reason = clip(text(payload.reason, 200), 120);
          items.push({ kind: 'trigger', timestamp: event.timestamp, title: reason ? `Recording triggered (${reason})` : 'Recording triggered', severity: 'info' });
        }
      }
    } catch { /* A malformed event is left out. */ }
  }
  return items;
}

export function diagnosticActivity(errors: ErrorOccurrence[], logs: LogEntry[]): Activity[] {
  const items: Activity[] = [];
  for (const entry of Array.isArray(errors) ? errors : []) {
    if (!record(entry) || !finite(entry.timestamp)) continue;
    const name = clip(text(entry.name, 128), 128) || 'Error', message = text(entry.message);
    const level = text(entry.level, 16).toLowerCase() || 'error';
    const uncaught = entry.handled === false;
    items.push({
      kind: 'error', timestamp: entry.timestamp, title: message ? `${name}: ${message}` : name,
      detail: [`${uncaught ? 'Unhandled' : 'Handled'}${level === 'fatal' ? ' fatal' : ''} error`, clip(text(entry.service, 128), 64)].filter(Boolean).join(' · '),
      // An error is never shown as plain information, whatever its stored level.
      severity: severityOf(level) === 'info' ? 'error' : severityOf(level), level, ...(uncaught ? { uncaught: true as const } : {}),
    });
  }
  for (const entry of Array.isArray(logs) ? logs : []) {
    if (!record(entry) || !finite(entry.timestamp)) continue;
    const level = text(entry.level, 16).toLowerCase() || 'info';
    items.push({
      kind: 'log', timestamp: entry.timestamp, title: text(entry.message) || '(empty log)',
      detail: [`${LOG_LEVELS.get(level) ?? level} log`, clip(text(entry.service, 128), 64)].filter(Boolean).join(' · '),
      severity: severityOf(level), level,
    });
  }
  return items.sort(byTime);
}

export interface LoadedDiagnostics<T> { items: T[]; total: number }
// Stored entries come 50 a page, newest first, so this keeps up to the newest 1,000 of each kind.
export const DIAGNOSTIC_PAGES = 20;

// A session's stored errors or logs, with how many exist. Any failure, such as a server without the errors
// list, ends the loading and keeps what arrived; so does `current` turning false when another recording opens.
export async function loadDiagnostics<T>(request: (path: string) => Promise<unknown>, path: string, sessionId: string,
  current: () => boolean = () => true): Promise<LoadedDiagnostics<T>> {
  const items: T[] = [];
  let total = 0;
  for (let part = 1; part <= DIAGNOSTIC_PAGES; part++) {
    let data: { items?: unknown; totalPages?: unknown; totalItems?: unknown } | undefined;
    try { data = await request(`${path}?sessionId=${encodeURIComponent(sessionId)}&page=${part}`) as typeof data; } catch { break; }
    if (!current() || !data || !Array.isArray(data.items)) break;
    items.push(...data.items as T[]);
    total = Math.max(total, Number(data.totalItems) || 0, items.length);
    if (!data.items.length || part >= Number(data.totalPages)) break;
  }
  return { items, total };
}

// Names what the activity list leaves out, so a busy session's older entries never vanish without a word.
export function diagnosticsNotice(errors: LoadedDiagnostics<unknown>, logs: LoadedDiagnostics<unknown>): string {
  const parts: string[] = [];
  for (const [loaded, noun] of [[errors, 'stored errors'], [logs, 'stored logs']] as const) {
    if (loaded.total > loaded.items.length) parts.push(`${loaded.items.length.toLocaleString()} of ${loaded.total.toLocaleString()} ${noun}`);
  }
  return parts.length ? `Showing the newest ${parts.join(' and ')}. Use Issues or Logs for this session to see them all` : '';
}

function duplicateKeys(item: Activity): string[] {
  const line = (value: string) => oneLine(value).slice(0, 200);
  if (item.kind === 'console' && item.uncaught) {
    const message = line(item.title.replace(/^Uncaught (?:\(in promise\) )?/, ''));
    return [`uncaught\n${message}`, `uncaught\nError: ${message}`];
  }
  if (item.kind === 'console' || item.kind === 'log') return [`log\n${item.severity}\n${line(item.title)}`];
  // Only an unhandled error can be the copy of an uncaught one the recorder saw.
  if (item.kind === 'error' && item.uncaught) return [`uncaught\n${line(item.title)}`];
  return [];
}

// The diagnostics client can capture the same console output and uncaught errors the recorder did; each recorded
// line hides at most one stored copy of itself, and the recorded row is the one kept.
export function mergeActivity(recorded: Activity[], diagnostics: Activity[]): Activity[] {
  const lines = new Map<string, number[]>();
  for (const item of recorded) {
    if (item.kind !== 'console') continue;
    for (const key of duplicateKeys(item)) {
      const times = lines.get(key);
      if (times) times.push(item.timestamp); else lines.set(key, [item.timestamp]);
    }
  }
  const kept = diagnostics.filter((item) => {
    const times = lines.get(duplicateKeys(item)[0] ?? '');
    const index = times ? times.findIndex((time) => Math.abs(time - item.timestamp) <= DUPLICATE_MS) : -1;
    if (index < 0) return true;
    times!.splice(index, 1);
    return false;
  });
  return [...recorded, ...kept].sort(byTime);
}

function markOf(item: Activity): { tag: string; color: string; rank: number } | undefined {
  if (item.kind === 'trigger') return { tag: clip(item.title, 120), color: MARK_COLORS.trigger, rank: 1 };
  if (item.kind === 'network') {
    if (item.status === undefined || (item.status > 0 && item.status < 400)) return undefined;
    const outcome = item.status ? String(item.status) : (FAILURES.get(item.failed ?? '') ?? 'No response').toLowerCase();
    return { tag: clip(`Request failed: ${item.title} (${outcome})`, 120), color: MARK_COLORS.request, rank: 2 };
  }
  if (item.kind === 'pocketbase') {
    if (item.severity !== 'error') return undefined;
    const outcome = item.status ? String(item.status) : (FAILURES.get(item.failed ?? '') ?? 'No response').toLowerCase();
    return { tag: clip(`PocketBase call failed: ${item.title} (${outcome})`, 120), color: MARK_COLORS.request, rank: 2 };
  }
  if (item.kind !== 'error' && item.severity !== 'error') return undefined;
  const tag = item.kind === 'error' || item.uncaught ? item.title : item.kind === 'log' ? `Error log: ${item.title}` : `Console error: ${item.title}`;
  return { tag: clip(tag, 120), color: MARK_COLORS.error, rank: 0 };
}

// Marks for errors, failed requests and triggers. Marks closer than a hundredth of the timeline share one spot,
// named after the most important of them; marks already drawn hold their spots, and the total stays within the limit.
export function timelineMarks(activities: Activity[], options: {
  position?: (timestamp: number) => number; duration?: number; existing?: TimelineMark[];
} = {}): TimelineMark[] {
  const position = options.position ?? ((timestamp: number) => timestamp);
  const existing = options.existing ?? [];
  const room = ACTIVITY_LIMITS.marks - existing.length;
  if (room <= 0) return [];
  const candidates: { at: number; rank: number; mark: TimelineMark }[] = [];
  let first = Infinity, last = -Infinity;
  for (const item of activities) {
    if (!finite(item.timestamp)) continue;
    first = Math.min(first, item.timestamp);
    last = Math.max(last, item.timestamp);
    const mark = markOf(item);
    if (mark) candidates.push({ at: position(item.timestamp), rank: mark.rank, mark: { timestamp: item.timestamp, tag: mark.tag, color: mark.color } });
  }
  if (!candidates.length) return [];
  const span = finite(options.duration) && options.duration > 0 ? options.duration : position(last) - position(first);
  const gap = Math.max(span, 1) / ACTIVITY_LIMITS.marks;
  const taken = existing.map((mark) => position(mark.timestamp));
  candidates.sort((left, right) => left.at - right.at);
  const groups: { start: number; best: (typeof candidates)[number]; count: number }[] = [];
  for (const candidate of candidates) {
    if (taken.some((at) => Math.abs(at - candidate.at) < gap)) continue;
    const group = groups[groups.length - 1];
    if (group && candidate.at - group.start < gap) {
      group.count++;
      if (candidate.rank < group.best.rank) group.best = candidate;
    } else groups.push({ start: candidate.at, best: candidate, count: 1 });
  }
  const kept = groups.length <= room ? groups : groups.slice()
    .sort((left, right) => left.best.rank - right.best.rank || right.count - left.count).slice(0, room)
    .sort((left, right) => left.start - right.start);
  return kept.map(({ best, count }) => ({ ...best.mark, tag: count > 1 ? `${best.mark.tag} (+${count - 1} more)` : best.mark.tag }));
}

// The same answer as replayOffset in observability.ts, in logarithmic time. That finds the first pair of events,
// in recording order, whose clock times rise across the timestamp; with the latest clock time reached so far
// never decreasing, the first event to reach the timestamp ends that pair, even after the device clock was set back.
export function createReplayOffset(original: ReplayEvent[], shortened: ReplayEvent[]): (timestamp: number) => number {
  const count = original.length;
  if (!count || count !== shortened.length) return () => 0;
  const start = shortened[0].timestamp;
  const reached = new Float64Array(count);
  let latest = -Infinity;
  for (let index = 0; index < count; index++) reached[index] = latest = Math.max(latest, original[index].timestamp);
  return (timestamp) => {
    if (!Number.isFinite(timestamp) || timestamp <= original[0].timestamp) return 0;
    let low = 1, high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (reached[middle] >= timestamp) high = middle; else low = middle + 1;
    }
    if (low >= count) return Math.max(0, shortened[count - 1].timestamp - start);
    const before = original[low - 1].timestamp, after = original[low].timestamp;
    const position = shortened[low - 1].timestamp +
      (timestamp - before) / (after - before) * (shortened[low].timestamp - shortened[low - 1].timestamp);
    return Math.max(0, position - start);
  };
}

// rrweb-player draws a mark for every custom event, so the recorded activity events stay out of the player and
// timelineMarks picks the few that get one.
export function withoutActivity<T extends ReplayEvent>(events: T[]): T[] {
  return events.filter((event) => {
    const tag = event.type === 5 ? record(event.data)?.tag : undefined;
    return !(typeof tag === 'string' && tag.startsWith('pbr/'));
  });
}

type Filter = 'all' | 'pocketbase' | 'network' | 'console' | 'click' | 'navigation' | 'errors';
const FILTERS: { key: Filter; label: string; matches: (item: Activity) => boolean; empty: string }[] = [
  { key: 'all', label: 'All', matches: () => true, empty: 'No activity in this recording' },
  { key: 'pocketbase', label: 'PocketBase', matches: (item) => item.kind === 'pocketbase',
    empty: 'No PocketBase calls recorded. Pass your PocketBase client to startReplay as pocketbase, with Record PocketBase calls on in Recording settings' },
  { key: 'network', label: 'Network', matches: (item) => item.kind === 'network',
    empty: 'No network requests recorded. Turn on Record network requests in Recording settings to record them' },
  { key: 'console', label: 'Console', matches: (item) => item.kind === 'console' || item.kind === 'log',
    empty: 'No console output or logs recorded. Turn on Record console messages in Recording settings to record console output' },
  { key: 'click', label: 'Clicks', matches: (item) => item.kind === 'click', empty: 'No clicks recorded' },
  { key: 'navigation', label: 'Pages', matches: (item) => item.kind === 'navigation', empty: 'No pages recorded' },
  { key: 'errors', label: 'Errors', matches: (item) => item.kind === 'error' || item.severity === 'error',
    empty: 'No errors or failed requests recorded' },
];
const KIND_LABELS: Record<ActivityKind, string> = {
  network: 'Network', console: 'Console', navigation: 'Page', click: 'Click', error: 'Error', log: 'Log', trigger: 'Trigger', pocketbase: 'PB',
};

const VERDICTS: Record<NonNullable<RequestExplanation['verdict']>, (rule: string, exists: boolean) => string> = {
  hook: () => 'An error was thrown in a hook or route while PocketBase handled this call',
  locked: (rule) => `Only superusers can do this: the collection's ${rule} is locked`,
  rule: (rule, exists) => exists ? `The record exists, so the ${rule} hid it from this account` : `The ${rule} refused this call`,
  missing: () => 'No record with this ID exists',
  validation: () => 'PocketBase refused the values of these fields',
  server: () => 'The server failed while handling this call',
  filtered: (rule) => `The ${rule} decides which rows this account can see, so the list may only look empty`,
};

export function createDevtoolsPanel(container: HTMLElement, handlers: { seek: (timestamp: number) => void; openIssue?: (id: string) => void }): DevtoolsPanel {
  const doc = container.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };
  container.classList.add('devtools');
  if (!container.hasAttribute('aria-label') && !container.hasAttribute('aria-labelledby')) container.setAttribute('aria-label', 'Session activity');
  if (container.tagName !== 'SECTION') container.setAttribute('role', 'region');
  const bar = element('div', 'devtools-bar');
  const heading = element('h3', 'devtools-heading');
  heading.textContent = 'Activity';
  const filterGroup = element('div', 'devtools-filters');
  filterGroup.setAttribute('role', 'group');
  filterGroup.setAttribute('aria-label', 'Show activity');
  bar.append(heading, filterGroup);
  const note = element('p', 'devtools-note');
  const list = element('ol', 'devtools-list');
  list.setAttribute('aria-label', 'Activity rows');
  const empty = element('p', 'devtools-empty');
  container.replaceChildren(bar, note, list, empty);

  let all: Activity[] = [];
  let visible: Activity[] = [];
  let filter: Filter = 'all';
  let start = 0;
  let offset: ((timestamp: number) => number) | undefined;
  // Large sessions render a window of rows around the current moment; it moves with playback.
  let first = 0;
  let rows: HTMLButtonElement[] = [];
  let current = -1;
  let focused = 0;
  let time = NaN;
  let touched = -Infinity;
  let notice = '';
  // The PocketBase call whose details are open, by its request ID, so they stay open while the list is redrawn.
  let expanded = '';

  const filters = FILTERS.map((item) => {
    const button = element('button', 'devtools-filter');
    button.type = 'button';
    const name = doc.createElement('span');
    name.textContent = item.label;
    const count = element('span', 'devtools-count');
    button.append(name, count);
    button.addEventListener('click', () => {
      if (filter === item.key) return;
      filter = item.key;
      choose();
    });
    filterGroup.append(button);
    return { item, button, count };
  });

  const following = () => performance.now() - touched > ACTIVITY_LIMITS.followPauseMs;
  const touch = () => { touched = performance.now(); };
  const rowAt = (index: number) => index >= first && index < first + rows.length ? rows[index - first] : undefined;
  const windowAround = (index: number) => Math.max(0, Math.min(visible.length - ACTIVITY_LIMITS.rows, index - Math.floor(ACTIVITY_LIMITS.rows / 4)));

  function lastReached(timestamp: number): number {
    let low = 0, high = visible.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (visible[middle].timestamp <= timestamp + TIME_SLACK_MS) low = middle + 1; else high = middle;
    }
    return low - 1;
  }

  function createRow(item: Activity, index: number): HTMLLIElement {
    const row = element('button', 'devtools-row');
    row.type = 'button';
    row.tabIndex = -1;
    row.dataset.index = String(index);
    row.dataset.kind = item.kind;
    row.dataset.severity = item.severity;
    const at = element('span', 'devtools-time');
    at.textContent = clockText(offset ? offset(item.timestamp) : item.timestamp - start);
    const kind = element('span', 'devtools-kind');
    kind.textContent = KIND_LABELS[item.kind];
    const title = element('span', 'devtools-title');
    title.textContent = item.title;
    row.append(at, kind, title);
    if (item.detail) {
      const detail = element('span', 'devtools-detail');
      detail.textContent = item.detail;
      row.append(detail);
    }
    // Long titles are cut to one line; the full text is in the tooltip.
    if (item.title.length > 40) row.title = item.title;
    rows.push(row);
    const entry = doc.createElement('li');
    entry.append(row);
    const call = item.pocketbase;
    if (call?.request) {
      row.setAttribute('aria-expanded', String(expanded === call.request));
      row.setAttribute('aria-controls', `devtools-call-${call.request}`);
      if (expanded === call.request) entry.append(inspect(item));
    }
    return entry;
  }

  // What the app saw of a PocketBase call and, once asked, what the server says about it.
  function inspect(item: Activity): HTMLElement {
    const call = item.pocketbase!;
    const box = element('div', 'devtools-inspect');
    box.id = `devtools-call-${call.request}`;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Details of ${item.title}`);
    const line = (className: string, ...parts: (string | Node)[]) => {
      const paragraph = element('p', className);
      paragraph.append(...parts);
      box.append(paragraph);
    };
    const code = (value: string) => {
      const node = element('code', '');
      node.textContent = value;
      return node;
    };
    const list = (values: string[]) => {
      const items = element('ul', 'devtools-inspect-list');
      for (const value of values) {
        const entry = doc.createElement('li');
        entry.textContent = value;
        items.append(entry);
      }
      box.append(items);
    };
    const explanation = item.explanation;
    const found = explanation?.state === 'found' ? explanation.value : undefined;
    const server = found?.server;
    line('devtools-inspect-request', code(`${call.method} ${call.path}`));
    const facts = [call.status ? `Status ${call.status}` : FAILURES.get(call.failed ?? '') ?? 'No response'];
    if (call.duration !== undefined) facts.push(server?.ms !== undefined ? `${durationText(call.duration)} (server ${server.ms} ms)` : durationText(call.duration));
    if (server?.auth !== undefined) facts.push(server.auth === '_superusers' ? 'Signed in as a superuser' : server.auth ? `Signed in to ${server.auth}` : 'Not signed in');
    if (itemsText(call)) facts.push(itemsText(call));
    if (call.query?.filter) facts.push('Filtered');
    if (call.query?.sort) facts.push(`Sorted by ${call.query.sort}`);
    if (call.query?.expand) facts.push(`Expanded ${call.query.expand}`);
    if (call.query?.fields) facts.push(`Fields ${call.query.fields}`);
    if (call.query?.unreadable) facts.push('Query details omitted');
    line('devtools-inspect-facts', facts.join(' · '));
    const message = call.message ?? server?.error;
    if (message) line('devtools-inspect-message', message);
    const fields = call.invalid?.length
      ? call.invalid.map((field) => `${field.field} (${field.code})`)
      : (server?.fields ?? []).map((field) => field.code ? `${field.field} (${field.code})` : field.field);
    if (fields.length) list(fields);
    if (call.batch?.length) list(call.batch.map((part) => `${callName(part)} · ${part.status || 'no answer'}`));
    if (call.topics?.length) line('', `Subscribed to ${call.topics.join(', ')}`);
    if (found?.verdict) {
      const rule = found.rule?.name ?? 'rule';
      line('devtools-inspect-verdict', found.likely && found.verdict === 'rule'
        ? `The current ${rule} may have refused this call; the rule or a hook may have changed since it was recorded`
        : unreadableQuery(call, found)
          ? 'PocketBase most likely could not read this call\'s filter, sort, expand or fields, or a hook threw an error: it gives both the same answer'
        : found.likely && found.verdict === 'hook'
          ? 'Most likely an error thrown in a hook or route: PocketBase gave its answer for errors it did not expect'
          : VERDICTS[found.verdict](rule, found.record === 'exists'));
    }
    const rule = found?.rule;
    if (rule && (found!.verdict === 'rule' || found!.verdict === 'locked' || found!.verdict === 'filtered' || (!found!.verdict && call.status >= 400))) {
      line('devtools-inspect-rule', `${rule.name}: `, rule.expression === null ? 'superusers only' : rule.expression ? code(rule.expression) : 'empty, so anyone may');
    }
    if (server?.details && found!.verdict !== 'validation') line('devtools-inspect-server', 'PocketBase logged ', code(server.details));
    if (found?.issue && handlers.openIssue) {
      const open = element('button', 'devtools-inspect-issue');
      open.type = 'button';
      open.textContent = `Open issue: ${found.issue.title || 'server error'}`;
      const id = found.issue.id;
      open.addEventListener('click', () => { try { handlers.openIssue!(id); } catch { /* The dashboard reports its own failures. */ } });
      box.append(open);
    }
    const note = !call.server ? 'Sent to a server other than the replay server, so only what the app saw is shown'
      : explanation?.state === 'pending' ? 'Asking the server about this call...'
      : explanation?.state === 'failed' ? 'Could not ask the server about this call'
      : explanation?.state === 'none' ? (explanation.logs ? 'The server has nothing on this call. PocketBase may not have logged it, or its logs were cleared'
        : 'The server could not read PocketBase\'s request log')
      : found && !server && call.status >= 400 ? (call.linked ? 'PocketBase\'s request log has no linked entry for this call, so its rule and record were checked instead'
        : 'Sent before the link to the server was ready, so its rule and record were checked instead')
      : '';
    if (note) line('devtools-inspect-note', note);
    return box;
  }

  // Opens a PocketBase call's details, closing any other, without redrawing the list.
  function toggle(index: number): void {
    const item = visible[index];
    const request = item?.pocketbase?.request;
    if (!request) return;
    const previous = expanded;
    expanded = previous === request ? '' : request;
    for (const row of rows) {
      const call = visible[Number(row.dataset.index)]?.pocketbase;
      if (!call?.request || (call.request !== previous && call.request !== expanded)) continue;
      const open = call.request === expanded;
      row.setAttribute('aria-expanded', String(open));
      const entry = row.parentElement;
      entry?.querySelector('.devtools-inspect')?.remove();
      if (open) entry?.append(inspect(visible[Number(row.dataset.index)]));
    }
  }

  function reveal(row: HTMLElement, lead: boolean): void {
    const top = row.offsetTop, bottom = top + row.offsetHeight, view = list.clientHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + view) return;
    // While following playback the row sits a third of the way down, so what comes next stays in view.
    list.scrollTop = lead ? Math.max(0, top - view / 3) : top < list.scrollTop ? top : bottom - view;
  }

  function renderRows(): void {
    rows = [];
    current = -1;
    const fragment = doc.createDocumentFragment();
    const end = Math.min(visible.length, first + ACTIVITY_LIMITS.rows);
    for (let index = first; index < end; index++) fragment.append(createRow(visible[index], index));
    list.replaceChildren(fragment);
    focused = Math.max(first, Math.min(end - 1, focused));
    const focusable = rowAt(focused);
    if (focusable) focusable.tabIndex = 0;
    const windowed = visible.length > ACTIVITY_LIMITS.rows
      ? `Showing ${(end - first).toLocaleString()} of ${visible.length.toLocaleString()} rows around the current moment. The list moves with playback` : '';
    note.textContent = [notice, windowed].filter(Boolean).join('. ');
    note.hidden = !note.textContent;
  }

  function mark(index: number, follow: boolean): void {
    if (index === current) return;
    rowAt(current)?.removeAttribute('aria-current');
    current = index;
    const row = rowAt(index);
    if (!row) return;
    row.setAttribute('aria-current', 'true');
    if (follow) reveal(row, true);
  }

  function choose(): void {
    const selected = FILTERS.find((item) => item.key === filter)!;
    visible = all.filter(selected.matches);
    for (const { item, button } of filters) button.setAttribute('aria-pressed', String(item.key === filter));
    const index = Number.isFinite(time) ? lastReached(time) : -1;
    first = visible.length > ACTIVITY_LIMITS.rows ? windowAround(Math.max(0, index)) : 0;
    focused = Math.max(0, index);
    renderRows();
    list.hidden = !visible.length;
    empty.hidden = !!visible.length;
    empty.textContent = visible.length ? '' : selected.empty;
    if (following()) list.scrollTop = 0;
    mark(index, following());
  }

  // One row at a time is in the tab order, so the list is a single stop on the way through the page.
  function setFocused(index: number): HTMLButtonElement | undefined {
    const previous = rowAt(focused);
    if (previous) previous.tabIndex = -1;
    focused = index;
    const row = rowAt(index);
    if (row) row.tabIndex = 0;
    return row;
  }

  // A row moved to with the keyboard is focused without scrolling the page, then brought into the list's view.
  function focusRow(index: number): void {
    if (!visible.length) return;
    index = Math.max(0, Math.min(visible.length - 1, index));
    if (!rowAt(index)) {
      first = windowAround(index);
      renderRows();
      mark(lastReached(time), false);
    }
    const row = setFocused(index);
    if (!row) return;
    row.focus({ preventScroll: true });
    reveal(row, false);
  }

  list.addEventListener('click', (event) => {
    const row = (event.target as Element | null)?.closest?.('.devtools-row') as HTMLButtonElement | null;
    const index = Number(row?.dataset.index);
    const item = visible[index];
    if (!row || !item) return;
    touch();
    setFocused(index);
    mark(index, false);
    toggle(index);
    try { handlers.seek(item.timestamp); } catch { /* The player reports its own failures. */ }
  });
  // Only what a person does counts, so the list's own scrolling while it follows playback never pauses it.
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) list.addEventListener(type, touch, { passive: true });
  list.addEventListener('keydown', (event: KeyboardEvent) => {
    const index = Number((event.target as HTMLElement | null)?.dataset?.index);
    if (!Number.isInteger(index)) return;
    const moves: Record<string, number> = {
      ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + 10, PageUp: index - 10, Home: 0, End: visible.length - 1,
    };
    if (!Object.prototype.hasOwnProperty.call(moves, event.key)) return;
    event.preventDefault();
    focusRow(moves[event.key]);
  });

  function clear(): void {
    all = []; visible = []; rows = [];
    filter = 'all'; start = 0; offset = undefined; first = 0; current = -1; focused = 0; time = NaN; touched = -Infinity; notice = ''; expanded = '';
    for (const { item, button, count } of filters) {
      button.setAttribute('aria-pressed', String(item.key === 'all'));
      count.textContent = '';
    }
    list.replaceChildren();
    list.scrollTop = 0;
    note.hidden = true;
    empty.hidden = true;
    container.hidden = true;
  }

  clear();
  return {
    show(activities, startTimestamp, position, message) {
      all = activities.filter((item) => finite(item?.timestamp)).sort(byTime);
      start = finite(startTimestamp) ? startTimestamp : all[0]?.timestamp ?? 0;
      offset = position;
      notice = typeof message === 'string' ? message : '';
      for (const { item, count } of filters) count.textContent = all.reduce((sum, entry) => sum + (item.matches(entry) ? 1 : 0), 0).toLocaleString();
      container.hidden = false;
      choose();
    },
    setTime(timestamp) {
      if (!Number.isFinite(timestamp)) return;
      time = timestamp;
      if (!visible.length) return;
      const index = lastReached(timestamp);
      const follow = following();
      if (index >= 0 && !rowAt(index) && follow) {
        first = windowAround(index);
        renderRows();
      }
      mark(index, follow);
    },
    clear,
  };
}
