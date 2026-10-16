import { byteLength } from './privacy';
import { canTriggerReplayError } from './engine';
import { describeException, redactLabel, redactText, safeAttributes, safeValue } from './observability-privacy';
import type { ReplayMetadata, ReplaySessionContext } from './types';
import type {
  AutomaticCapture, CapturedException, CapturedLog, ExceptionContext, LogLevel, ObservabilityAttributes,
  ObservabilityController, ObservabilityEvent, ObservabilityMetrics, ObservabilityOptions, ObservabilityRuntime,
} from './observability-types';

export const OBSERVABILITY_LIMITS = {
  eventBytes: 16 * 1024, batchBytes: 60 * 1024, queueBytes: 512 * 1024,
  queueEvents: 200, batchEvents: 20, retries: 5, retryMs: 1000, maxRetryMs: 60000, configIntervalMs: 45000,
  linkWaitMs: 10000,
};
const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
// `identity` is the account and device the entry was captured under; it is only ever sent with that identity's credential.
// `held` keeps an error back while the replay it triggered starts a session it can link to.
interface Entry { event: ObservabilityEvent; json: string; bytes: number; attempts: number; identity: string; held?: boolean }

function statusOf(error: unknown): number {
  try { const status = (error as { status?: unknown })?.status; return typeof status === 'number' ? status : 0; }
  catch { return 0; }
}
function retryable(status: number): boolean { return !status || status === 408 || status === 429 || status >= 500; }
function enabled(value: unknown): boolean { return value === true || !!value && typeof value === 'object'; }
let sequence = 0;
function eventId(now: number): string {
  try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch { /* Use the local fallback. */ }
  return `${now.toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

// Oversized entries keep their grouping key while shedding attributes and shortening stack and message text.
// Text outside Latin script takes two to four bytes a character.
function fit(event: ObservabilityEvent): string | null {
  const { kind: _kind, ...payload } = event;
  let candidate: Record<string, unknown> = payload;
  let json = JSON.stringify(candidate);
  if (byteLength(json) <= OBSERVABILITY_LIMITS.eventBytes) return json;
  if (candidate.attributes) {
    const groupingKey = event.kind === 'error' ? event.attributes?.groupingKey : undefined;
    candidate = { ...candidate, attributes: { truncated: true, ...(typeof groupingKey === 'string' && groupingKey ? { groupingKey } : {}) } };
    json = JSON.stringify(candidate);
  }
  for (const key of ['stack', 'message']) {
    while (byteLength(json) > OBSERVABILITY_LIMITS.eventBytes && typeof candidate[key] === 'string' && (candidate[key] as string).length > 1) {
      const value = candidate[key] as string;
      candidate = { ...candidate, [key]: value.slice(0, Math.floor(value.length * 0.75)) };
      json = JSON.stringify(candidate);
    }
  }
  return byteLength(json) <= OBSERVABILITY_LIMITS.eventBytes ? json : null;
}

export function createObservability(options: ObservabilityOptions, runtime: ObservabilityRuntime): ObservabilityController {
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  const localErrors = enabled(options.errors), localLogs = enabled(options.logs);
  const storageBase = `pocketbase-replay:observability:${endpoint}`;
  let storageKey = apiKey ? '' : storageBase;
  const storageScope = apiKey && runtime.storage ? (async () => {
    try {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
      return `${storageBase}:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    } catch { return ''; }
  })() : null;
  let closed = !endpoint || !options.transport || !(localErrors || localLogs);
  let identity = '', token = '', expiresAt = 0, epoch = 0;
  // Until the server first answers for an identity, entries wait in the queue instead of being refused,
  // so an error thrown while the app starts is kept. The answer drops them if the server is off.
  let answered = false, errorsEnabled = false, logsEnabled = false;
  let queue: Entry[] = [], queuedBytes = 0;
  let interval = 10000, maxBatchEvents = OBSERVABILITY_LIMITS.batchEvents;
  let retryAt = 0, retryDelay = 0;
  let refreshing: Promise<void> | null = null, refreshAgain = false, pumping: Promise<void> | null = null, lastRefreshAt = -Infinity;
  let flushTimer: unknown, configTimer: unknown, retryTimer: unknown;
  const linkTimers = new Set<unknown>();
  let removeLifecycle: (() => void) | undefined, removeCapture: (() => void) | undefined;
  let capturing = false;
  const metrics: ObservabilityMetrics = {
    errorsEnabled: false, logsEnabled: false, capturedErrors: 0, capturedLogs: 0, uploadedEvents: 0,
    droppedEvents: 0, queuedEvents: 0, queuedBytes: 0, networkErrors: 0,
  };

  function metadata(): ReplayMetadata | null {
    try {
      const value = options.metadata();
      if (!value || typeof value.deviceId !== 'string' || !value.deviceId) return null;
      const accountId = String(value.accountId ?? '').slice(0, 128);
      return {
        deviceId: value.deviceId.slice(0, 128), accountId,
        authToken: accountId ? String(value.authToken ?? '') : '', platform: String(value.platform ?? '').slice(0, 32),
        appVersion: String(value.appVersion ?? '').slice(0, 64), room: String(value.room ?? '').slice(0, 64),
      };
    } catch { return null; }
  }
  function identityOf(value: ReplayMetadata): string { return `${value.deviceId}\n${value.accountId ?? ''}`; }
  function wanted(kind: 'error' | 'log'): boolean {
    return !closed && (kind === 'error' ? localErrors && (!answered || errorsEnabled) : localLogs && (!answered || logsEnabled));
  }
  function drop(entries: Entry[]): void {
    const removed = new Set(entries);
    queue = queue.filter((entry) => !removed.has(entry));
    queuedBytes = queue.reduce((sum, entry) => sum + entry.bytes, 0);
  }
  // The upload credential is kept across reloads, so a page that reloads often does not need a new one each time.
  function saved(forIdentity: string): string {
    try {
      const value = JSON.parse(storageKey ? runtime.storage?.get(storageKey) ?? 'null' : 'null') as { identity?: unknown; token?: unknown; expiresAt?: unknown } | null;
      return value && value.identity === forIdentity && typeof value.token === 'string' && /^[A-Za-z0-9]{64}$/.test(value.token) &&
        typeof value.expiresAt === 'number' && value.expiresAt > runtime.now() ? value.token : '';
    } catch { return ''; }
  }
  function remember(forIdentity: string): void {
    try { if (storageKey) runtime.storage?.set(storageKey, JSON.stringify({ identity: forIdentity, token, expiresAt })); } catch { /* Kept in memory only. */ }
  }
  function forget(): void {
    try { if (storageKey) runtime.storage?.remove(storageKey); } catch { /* Kept in memory only. */ }
  }
  // Entries never move to another account or device: a new identity drops the old one's queue and asks again.
  function switchIdentity(next: string): void {
    epoch++;
    const other = queue.filter((entry) => entry.identity !== next);
    drop(other); metrics.droppedEvents += other.length;
    identity = next; token = ''; expiresAt = 0; answered = false; errorsEnabled = false; logsEnabled = false;
    retryAt = 0; retryDelay = 0; runtime.cancel(retryTimer);
  }
  // Entries and uploads ask for a credential at most every 5 seconds, so an unreachable server is not asked once per entry.
  function renew(): void {
    if (runtime.now() - lastRefreshAt >= 5000) void refresh();
  }
  // The server turned both features off, refused this identity, or the controller stopped.
  function disable(): void {
    epoch++; token = ''; expiresAt = 0; answered = true; errorsEnabled = false; logsEnabled = false;
    metrics.droppedEvents += queue.length; queue = []; queuedBytes = 0;
    retryAt = 0; retryDelay = 0; runtime.cancel(retryTimer);
    forget();
  }
  function privateText(): string[] {
    try { const values = options.sensitiveText?.(); return Array.isArray(values) ? values : []; } catch { return []; }
  }
  function session(): ReplaySessionContext | null {
    try {
      const context = options.session?.() ?? options.replay?.getSessionContext();
      return context && typeof context.sessionId === 'string' && /^[a-z0-9]{15}$/.test(context.sessionId) &&
        typeof context.token === 'string' && /^[A-Za-z0-9]{64}$/.test(context.token)
        ? { sessionId: context.sessionId, token: context.token } : null;
    } catch { return null; }
  }
  function captureContext(kind: 'error' | 'log'): { identity: string; id: string; timestamp: number; appVersion?: string; service?: string; room?: string; sessionId?: string; sessionToken?: string } | null {
    if (closed || !(kind === 'error' ? localErrors : localLogs)) return null;
    const value = metadata();
    if (!value) return null;
    const next = identityOf(value);
    if (next !== identity) { switchIdentity(next); void refresh(); }
    if (!wanted(kind)) return null;
    // A missing, expired or refused credential is renewed; the entry waits in the queue meanwhile.
    if (!token || expiresAt <= runtime.now()) renew();
    const context = session(), text = privateText(), timestamp = runtime.now();
    return {
      // Sent even when empty, so the server never gives the entry the version of a credential another build renewed.
      identity: next, id: eventId(timestamp), timestamp, appVersion: value.appVersion ?? '',
      ...(options.service ? { service: redactLabel(options.service, text, 128) } : {}),
      ...(value.room ? { room: redactLabel(value.room, text, 64) } : {}),
      ...(context ? { sessionId: context.sessionId, sessionToken: context.token } : {}),
    };
  }
  function sanitize(event: ObservabilityEvent, text: string[]): ObservabilityEvent {
    const attributes = safeAttributes(event.attributes, text);
    if (event.kind === 'error' && typeof attributes?.groupingKey === 'string') attributes.groupingKey = redactLabel(attributes.groupingKey, text, 128).trim();
    // The build an entry was captured in names its source maps, so it is kept as given rather than redacted.
    const common = {
      id: event.id, timestamp: event.timestamp,
      ...(typeof event.appVersion === 'string' ? { appVersion: event.appVersion.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) } : {}),
      ...(event.service ? { service: redactLabel(event.service, text, 128) } : {}),
      ...(event.room ? { room: redactLabel(event.room, text, 64) } : {}),
      ...(typeof event.sessionId === 'string' && /^[a-z0-9]{15}$/.test(event.sessionId) &&
        typeof event.sessionToken === 'string' && /^[A-Za-z0-9]{64}$/.test(event.sessionToken)
        ? { sessionId: event.sessionId, sessionToken: event.sessionToken } : {}),
      message: redactText(typeof event.message === 'string' ? event.message : '', text),
      attributes,
    };
    return event.kind === 'error' ? {
      ...common, kind: 'error', name: redactLabel(typeof event.name === 'string' ? event.name : 'Error', text, 128),
      ...(typeof event.stack === 'string' ? { stack: redactText(event.stack, text, 8000) } : {}),
      handled: event.handled !== false, level: event.level === 'fatal' ? 'fatal' : 'error',
    } : { ...common, kind: 'log', level: LEVELS.includes(event.level) ? event.level : 'info' };
  }
  // Queues without sending, so a caller can hold the entry for its replay link before a full batch goes.
  function enqueue(event: ObservabilityEvent, entryIdentity: string): Entry | null {
    try {
      const text = privateText();
      let prepared = sanitize(event, text);
      if (options.beforeSend) {
        const changed = options.beforeSend(prepared);
        if (!changed) { metrics.droppedEvents++; return null; }
        // Facts of the capture stay as captured, including the build, which a callback written before the field existed would drop.
        prepared = sanitize({ ...changed, id: event.id, timestamp: event.timestamp, kind: event.kind, appVersion: event.appVersion } as ObservabilityEvent, text);
      }
      if (!prepared.message) { metrics.droppedEvents++; return null; }
      const json = fit(prepared);
      const bytes = json ? byteLength(json) : 0;
      if (!json || queue.length >= OBSERVABILITY_LIMITS.queueEvents || queuedBytes + bytes > OBSERVABILITY_LIMITS.queueBytes) {
        metrics.droppedEvents++; return null;
      }
      const entry: Entry = { event: prepared, json, bytes, attempts: 0, identity: entryIdentity };
      queue.push(entry); queuedBytes += bytes;
      if (event.kind === 'error') metrics.capturedErrors++; else metrics.capturedLogs++;
      return entry;
    } catch { metrics.droppedEvents++; return null; }
  }
  function sendIfFull(): void {
    if (token && queue.length >= maxBatchEvents) void flush();
  }
  // A replay that keeps its recording on the device until something breaks uploads it now.
  function requestTrigger(): Promise<ReplaySessionContext | null> | null {
    const replay = options.replay;
    if (!replay || typeof replay.trigger !== 'function' || !canTriggerReplayError(replay) || session()) return null;
    try { return Promise.resolve(replay.trigger('error')).catch(() => null); } catch { return null; }
  }
  function relink(entry: Entry, context: ReplaySessionContext): void {
    const event = { ...entry.event, sessionId: context.sessionId, sessionToken: context.token } as ObservabilityEvent;
    const json = fit(event);
    if (!json) return;
    const bytes = byteLength(json);
    queuedBytes += bytes - entry.bytes;
    entry.event = event; entry.json = json; entry.bytes = bytes;
  }
  // The entry waits for the session its trigger starts, at most a few seconds, then goes with or without the link.
  function holdForLink(entry: Entry, linking: Promise<ReplaySessionContext | null>): void {
    entry.held = true;
    let timer: unknown;
    const release = () => {
      if (!entry.held) return;
      entry.held = false;
      runtime.cancel(timer); linkTimers.delete(timer);
      const context = session();
      if (context && entry.identity === identity && queue.includes(entry)) relink(entry, context);
      // A pump that already passed over the held entry would end without it, so flush again after it.
      const again = () => { void flush(); };
      if (pumping) pumping.then(again, again); else again();
    };
    timer = runtime.schedule(release, OBSERVABILITY_LIMITS.linkWaitMs);
    linkTimers.add(timer);
    linking.then(release, release);
  }
  function captureException(error: unknown, context: ExceptionContext = {}): string | null {
    if (capturing) return null;
    capturing = true;
    try {
      const common = captureContext('error');
      if (!common) return null;
      const { identity: entryIdentity, ...fields } = common;
      const groupingKey = typeof context.groupingKey === 'string' ? redactLabel(context.groupingKey, privateText(), 128).trim() : '';
      const attributes = groupingKey ? Object.assign({ groupingKey }, safeAttributes(context.attributes, privateText()), { groupingKey }) : context.attributes;
      const entry = enqueue({ ...fields, ...describeException(error, privateText()), kind: 'error',
        handled: context.handled !== false, level: context.level === 'fatal' ? 'fatal' : 'error', attributes } as CapturedException, entryIdentity);
      if (!entry) return null;
      // Only an error the app keeps is a reason to upload the replay; one that beforeSend or a limit dropped is not.
      // It is held before a full batch can go, so the error that fills one still waits for its link.
      const linking = fields.sessionId ? null : requestTrigger();
      if (linking) holdForLink(entry, linking);
      sendIfFull();
      return entry.event.id;
    } catch { metrics.droppedEvents++; return null; }
    finally { capturing = false; }
  }
  function captureLog(level: LogLevel, message: string, attributes?: ObservabilityAttributes): string | null {
    if (capturing || !LEVELS.includes(level)) return null;
    capturing = true;
    try {
      const common = captureContext('log');
      if (!common || typeof message !== 'string') return null;
      const { identity: entryIdentity, ...fields } = common;
      const entry = enqueue({ ...fields, kind: 'log', level, message, attributes } as CapturedLog, entryIdentity);
      if (entry) sendIfFull();
      return entry ? entry.event.id : null;
    } catch { metrics.droppedEvents++; return null; }
    finally { capturing = false; }
  }
  function automatic(capture: AutomaticCapture): void {
    if (!wanted(capture.kind)) return;
    if (capture.kind === 'error') { captureException(capture.error, { ...capture.context, handled: false }); return; }
    const text = privateText();
    const argumentsValue = capture.arguments.slice(0, 20).map((value) => typeof value === 'string' ? redactText(value, text)
      : JSON.stringify(safeValue(value, text))).join(' ');
    captureLog(capture.level, argumentsValue, { arguments: capture.arguments });
  }
  function batch(includeHeld = false): { entries: Entry[]; body: string; url: string } | null {
    if (!queue.length || !token) return null;
    const first = queue.find((entry) => entry.identity === identity && (includeHeld || !entry.held));
    if (!first) return null;
    const kind = first.event.kind, entries: Entry[] = [];
    let bytes = byteLength(JSON.stringify({ token, ...(apiKey ? { apiKey } : {}), events: [] }));
    for (const entry of queue) {
      if (entry.identity !== identity || entry.event.kind !== kind || (entry.held && !includeHeld)) continue;
      if (entries.length >= maxBatchEvents || bytes + entry.bytes + 1 > OBSERVABILITY_LIMITS.batchBytes) break;
      entries.push(entry); bytes += entry.bytes + 1;
    }
    if (!entries.length) return null;
    return { entries, body: `{"token":${JSON.stringify(token)},${apiKey ? `"apiKey":${JSON.stringify(apiKey)},` : ''}"events":[${entries.map((entry) => entry.json).join(',')}]}`,
      url: `${endpoint}/api/replay/${kind === 'error' ? 'errors' : 'logs'}` };
  }
  function scheduleRetry(): void {
    runtime.cancel(retryTimer);
    retryTimer = runtime.schedule(() => { retryAt = 0; void flush(); }, Math.max(0, retryAt - runtime.now()));
  }
  async function pump(): Promise<void> {
    while (!closed && queue.length && runtime.now() >= retryAt) {
      const value = metadata();
      if (!value) return;
      if (identityOf(value) !== identity) { switchIdentity(identityOf(value)); void refresh(); return; }
      // No credential yet, or it ran out: a refresh gets one and flushes again.
      if (!token || expiresAt <= runtime.now()) { renew(); return; }
      const item = batch();
      if (!item) return;
      const expectedEpoch = epoch, sentToken = token;
      try {
        await options.transport!.post(item.url, item.body);
        if (closed || expectedEpoch !== epoch) return;
        drop(item.entries); metrics.uploadedEvents += item.entries.length;
        retryAt = 0; retryDelay = 0;
      } catch (error) {
        if (closed || expectedEpoch !== epoch) return;
        metrics.networkErrors++;
        const status = statusOf(error);
        const credential = status === 401 || status === 403 || status === 410;
        if (!credential && !retryable(status)) {
          const rejected = item.entries.filter((entry) => queue.includes(entry));
          drop(rejected); metrics.droppedEvents += rejected.length;
          continue;
        }
        for (const entry of item.entries) entry.attempts++;
        const exhausted = item.entries.filter((entry) => entry.attempts >= OBSERVABILITY_LIMITS.retries && queue.includes(entry));
        drop(exhausted); metrics.droppedEvents += exhausted.length;
        if (credential) {
          // The credential ended, or the server turned a feature off. The next answer says which, and drops what it must.
          if (token === sentToken) { token = ''; expiresAt = 0; forget(); }
          renew();
          return;
        }
        retryDelay = Math.min(OBSERVABILITY_LIMITS.maxRetryMs, retryDelay ? retryDelay * 2 : OBSERVABILITY_LIMITS.retryMs);
        retryAt = runtime.now() + retryDelay;
        if (queue.length) scheduleRetry();
        return;
      }
    }
  }
  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pumping) return pumping;
    pumping = pump().finally(() => { pumping = null; });
    return pumping;
  }
  async function refreshOnce(): Promise<void> {
    if (closed) return;
    const value = metadata();
    if (!value) return;
    const nextIdentity = identityOf(value);
    if (identity !== nextIdentity) switchIdentity(nextIdentity);
    lastRefreshAt = runtime.now();
    const expectedEpoch = epoch;
    try {
      if (storageScope) storageKey = await storageScope;
      if (closed || expectedEpoch !== epoch) { refreshAgain = !closed; return; }
      const sent = token || saved(nextIdentity);
      const answer = await options.transport!.post(`${endpoint}/api/replay/observability/config`, JSON.stringify({ ...value, ...(sent ? { token: sent } : {}), ...(apiKey ? { apiKey } : {}) })) as Record<string, unknown>;
      if (closed) return;
      const latest = metadata();
      // The account or device changed while the answer was on its way; it belongs to the old one.
      if (expectedEpoch !== epoch || !latest || identityOf(latest) !== nextIdentity) { refreshAgain = true; return; }
      const allowErrors = localErrors && answer?.errorsEnabled === true, allowLogs = localLogs && answer?.logsEnabled === true;
      if (answer?.enabled !== true || !(allowErrors || allowLogs) || typeof answer.token !== 'string' ||
          !/^[A-Za-z0-9]{64}$/.test(answer.token)) { disable(); return; }
      const expiresIn = Number(answer.expiresIn);
      const expiration = Number.isFinite(expiresIn) && expiresIn > 0 ? runtime.now() + expiresIn
        : typeof answer.expiresAt === 'number' ? answer.expiresAt : Date.parse(String(answer.expiresAt));
      if (!Number.isFinite(expiration) || expiration <= runtime.now()) { disable(); return; }
      // A renewed credential for the same identity keeps the queue: those entries are still this identity's.
      token = answer.token; expiresAt = expiration; answered = true; errorsEnabled = allowErrors; logsEnabled = allowLogs;
      interval = Math.max(1000, Math.min(60000, Number(answer.uploadIntervalMs) || 10000));
      maxBatchEvents = Math.max(1, Math.min(OBSERVABILITY_LIMITS.batchEvents, Math.floor(Number(answer.maxBatchEvents) || OBSERVABILITY_LIMITS.batchEvents)));
      remember(nextIdentity);
      const forbidden = queue.filter((entry) => entry.event.kind === 'error' ? !errorsEnabled : !logsEnabled);
      drop(forbidden); metrics.droppedEvents += forbidden.length;
      if (queue.length) void flush();
    } catch (error) {
      if (closed || expectedEpoch !== epoch) return;
      metrics.networkErrors++;
      // An unreachable or busy server keeps the queue for the next attempt. A refusal ends it.
      if (!retryable(statusOf(error))) disable();
    }
  }
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => { do { refreshAgain = false; await refreshOnce(); } while (refreshAgain && !closed); })()
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  function scheduleFlush(): void {
    flushTimer = runtime.schedule(() => { if (!closed) { void flush(); scheduleFlush(); } }, interval);
  }
  function scheduleConfig(): void {
    configTimer = runtime.schedule(() => { if (!closed) { void refresh(); scheduleConfig(); } }, OBSERVABILITY_LIMITS.configIntervalMs);
  }
  function unload(): void {
    if (!options.transport?.beacon || !token || expiresAt <= runtime.now()) return;
    const value = metadata();
    if (!value || identityOf(value) !== identity) return;
    // A held entry leaves with the page too, even without its link.
    const item = batch(true);
    try { if (item) options.transport.beacon(item.url, item.body); } catch { /* Exit upload is best effort. */ }
  }
  if (!closed) {
    try { removeCapture = runtime.subscribeCapture?.(automatic, options); } catch { metrics.networkErrors++; }
    try { removeLifecycle = runtime.subscribe?.((active, unloading) => { if (!active) { if (unloading) unload(); else void flush(); } else void refresh(); }); }
    catch { metrics.networkErrors++; }
    scheduleFlush(); scheduleConfig(); void refresh();
  }
  return {
    captureException, captureLog, flush, refresh,
    stop: () => {
      if (closed) return;
      unload(); closed = true;
      epoch++; token = ''; expiresAt = 0; metrics.droppedEvents += queue.length; queue = []; queuedBytes = 0;
      runtime.cancel(flushTimer); runtime.cancel(configTimer); runtime.cancel(retryTimer);
      for (const timer of linkTimers) runtime.cancel(timer);
      linkTimers.clear();
      try { removeCapture?.(); } catch { /* Cleanup must not reach the app. */ }
      try { removeLifecycle?.(); } catch { /* Cleanup must not reach the app. */ }
    },
    getMetrics: () => ({ ...metrics, errorsEnabled: !closed && answered && errorsEnabled, logsEnabled: !closed && answered && logsEnabled,
      queuedEvents: queue.length, queuedBytes }),
  };
}
