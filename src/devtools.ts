import { redactLabel, redactText, safeValue } from './observability-privacy';
import {
  LINK_HEADER, describeBatch, describeCall, describeFailure, describeQuery, describeResult, describeTopics, linkValue, originOf, queryOf, requestId,
} from './pocketbase';
import { cleanUrl } from './privacy';
import type { RecorderOptions, ReplayEvent } from './types';

// Each kind has its own allowance per window, so a chatty console cannot crowd out network requests.
export const DEVTOOLS_LIMITS = {
  windowMs: 60000, network: 100, console: 100, navigation: 50, pocketbase: 150,
  textChars: 1000, urlChars: 2048, consoleArguments: 20, linkRetryMs: 5 * 60 * 1000,
};

// The replay and diagnostics clients post under this path. Recording those requests would feed the upload back
// into itself; the rest of the server is often the app's own PocketBase API, which is worth seeing.
const REPLAY_API = '/api/replay';
const LEVELS = ['debug', 'info', 'log', 'warn', 'error'] as const;
const SKIPPED = { network: 'network requests', console: 'console messages', navigation: 'page changes', pocketbase: 'PocketBase calls' };
// Whether a replay server on another origin lets the link header through CORS and any proxy, learned once per page.
const linkChecks = new Map<string, { state: 'pending' | 'ok' | 'failed'; at: number }>();

type Kind = keyof typeof SKIPPED;
type Failure = 'error' | 'abort' | 'timeout';
type Method = (this: unknown, ...args: unknown[]) => unknown;
interface Request { method: string; url: string; started: number; sent: boolean; failed?: Failure }

function clock(): number {
  try { return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now(); }
  catch { return Date.now(); }
}

function methodName(value: unknown): string {
  return (typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 16) : '') || 'GET';
}

function failure(error: unknown): Failure {
  try {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'AbortError' ? 'abort' : name === 'TimeoutError' ? 'timeout' : 'error';
  } catch { return 'error'; }
}

function isError(value: unknown): value is Error {
  try { return value instanceof Error; } catch { return false; }
}

// Name and message only: reading the stack would format it, which a console line does not need.
function errorText(error: Error, sensitiveText: string[]): string {
  let name: unknown, message: unknown;
  try { name = error.name; } catch { /* Read as a plain error. */ }
  try { message = error.message; } catch { /* Read as no message. */ }
  const label = redactLabel(typeof name === 'string' && name ? name : 'Error', sensitiveText, 128);
  const text = typeof message === 'string' ? redactText(message, sensitiveText, DEVTOOLS_LIMITS.textChars) : '';
  return text ? `${label}: ${text}` : label;
}

// Formatted as automatic() in observability.ts formats console arguments, with errors and bare words kept readable.
function describe(value: unknown, sensitiveText: string[]): string {
  if (typeof value === 'string') return redactText(value, sensitiveText, DEVTOOLS_LIMITS.textChars);
  if (value === undefined) return 'undefined';
  if (isError(value)) return errorText(value, sensitiveText);
  const safe = safeValue(value, sensitiveText);
  return typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '';
}

export function startDevtools(emit: (event: ReplayEvent) => void, options: RecorderOptions): () => void {
  if (typeof window === 'undefined' || !window) return () => {};
  const page = window;
  const restores: (() => void)[] = [];
  const budgets: Record<Kind, { start: number; count: number; noticed: boolean }> = {
    network: { start: 0, count: 0, noticed: false },
    console: { start: 0, count: 0, noticed: false },
    navigation: { start: 0, count: 0, noticed: false },
    pocketbase: { start: 0, count: 0, noticed: false },
  };
  // Requests the PocketBase client sends, which that client's own events describe better than network rows would.
  const pocketbaseRequests = new WeakSet<object>();
  let active = true;
  // Set while an event is built and handed over, so a console call made by a host callback or the engine is not captured again.
  let busy = false;

  function privateText(): string[] {
    try { const values = options.sensitiveText?.(); return Array.isArray(values) ? values : []; } catch { return []; }
  }

  function pageUrl(value: unknown): string {
    let url = String(value).trim().slice(0, 8192);
    try { if (page.location?.href) url = new URL(url, page.location.href).href; } catch { /* Kept as given. */ }
    // Data and blob URLs carry their content, so only the scheme is kept.
    return (cleanUrl(url) || (/^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? '')).slice(0, DEVTOOLS_LIMITS.urlChars);
  }

  const replayApi = (() => {
    try {
      const endpoint = typeof options.endpoint === 'string' ? options.endpoint.trim() : '';
      return endpoint ? `${pageUrl(endpoint).replace(/\/+$/, '')}${REPLAY_API}` : '';
    } catch { return ''; }
  })();
  const ownRequest = (url: string) => !!replayApi && (url === replayApi || url.startsWith(`${replayApi}/`));

  function send(tag: string, payload: Record<string, unknown>, timestamp: number): void {
    try { emit({ type: 5, timestamp, data: { tag, payload } }); } catch { /* The engine counts its own failures. */ }
  }

  // One notice when a kind starts dropping, then nothing more of that kind until its window ends.
  function allowed(kind: Kind, now: number): boolean {
    const budget = budgets[kind];
    if (now - budget.start >= DEVTOOLS_LIMITS.windowMs || now < budget.start) {
      budget.start = now; budget.count = 0; budget.noticed = false;
    }
    if (budget.count < DEVTOOLS_LIMITS[kind]) { budget.count++; return true; }
    if (!budget.noticed) {
      budget.noticed = true;
      send('pbr/console', { level: 'warn', text: `Replay skipped ${SKIPPED[kind]}: more than ${DEVTOOLS_LIMITS[kind]} in a minute` }, now);
    }
    return false;
  }

  // The allowance is checked before the payload is built, so dropped console calls are never formatted.
  function capture(kind: Kind, tag: string, build: () => Record<string, unknown>): void {
    if (!active || busy) return;
    busy = true;
    try {
      const now = Date.now();
      if (allowed(kind, now)) send(tag, build(), now);
    } catch { /* Capture must never reach the app. */ }
    finally { busy = false; }
  }

  function patch(target: object, key: string, wrap: (original: Method) => Method): void {
    const owner = target as Record<string, unknown>;
    try {
      const original = owner[key];
      if (typeof original !== 'function') return;
      const own = Object.prototype.hasOwnProperty.call(owner, key);
      const wrapper = wrap(original as Method);
      owner[key] = wrapper;
      restores.push(() => {
        // A wrapper installed after ours keeps calling it, so ours stays in that chain, inactive.
        try { if (owner[key] === wrapper) { if (own) owner[key] = original; else delete owner[key]; } } catch { /* A frozen object is left alone. */ }
      });
    } catch { /* A frozen object is left alone. */ }
  }

  function finished(kind: 'fetch' | 'xhr', request: Request, status: number): void {
    capture('network', 'pbr/network', () => ({
      kind, method: request.method, url: request.url, status: status > 0 ? Math.round(status) : 0,
      duration: Math.max(0, Math.round(clock() - request.started)),
      ...(request.failed ? { failed: request.failed } : {}),
    }));
  }

  function watchFetch(): void {
    patch(page, 'fetch', (original) => function (this: unknown, ...args: unknown[]) {
      const started = clock();
      const result = original.apply(this, args);
      if (!active) return result;
      try {
        const input = args[0] as { url?: unknown; method?: unknown } | null | undefined;
        const init = args[1] as { method?: unknown } | null | undefined;
        const fromRequest = !!input && typeof input === 'object' && typeof input.url === 'string';
        if (init && typeof init === 'object' && pocketbaseRequests.has(init)) return result;
        const request: Request = {
          method: methodName(init && typeof init === 'object' && init.method !== undefined ? init.method : fromRequest ? input.method : 'GET'),
          url: pageUrl(fromRequest ? input.url : input), started, sent: true,
        };
        if (ownRequest(request.url) || !result || typeof (result as Promise<unknown>).then !== 'function') return result;
        // A promise chained to the original settles with its exact response or error, and an unhandled
        // rejection is still reported as one.
        return (result as Promise<unknown>).then((response) => {
          let status = 0;
          try { status = Number((response as { status?: unknown } | null)?.status) || 0; } catch { /* Read as no response. */ }
          finished('fetch', request, status);
          return response;
        }, (error: unknown) => {
          request.failed = failure(error);
          finished('fetch', request, 0);
          throw error;
        });
      } catch { return result; }
    });
  }

  function watchXhr(): void {
    const prototype = typeof page.XMLHttpRequest === 'function' ? page.XMLHttpRequest.prototype : undefined;
    if (!prototype) return;
    const requests = new WeakMap<object, Request>();
    const listening = new WeakSet<object>();
    const end = (xhr: XMLHttpRequest) => {
      const request = requests.get(xhr);
      if (!request?.sent) return;
      requests.delete(xhr);
      let status = 0;
      try { status = Number(xhr.status) || 0; } catch { /* Read as no response. */ }
      if (!status && !request.failed) request.failed = 'error';
      finished('xhr', request, status);
    };
    // Added once per object; a reused object reports each request it sends.
    const track = (xhr: XMLHttpRequest) => {
      if (listening.has(xhr)) return;
      listening.add(xhr);
      const fail = (failed: Failure) => () => { const request = requests.get(xhr); if (request?.sent) request.failed = failed; };
      xhr.addEventListener('error', fail('error'));
      xhr.addEventListener('abort', fail('abort'));
      xhr.addEventListener('timeout', fail('timeout'));
      xhr.addEventListener('loadend', () => { try { end(xhr); } catch { /* Capture must never reach the app. */ } });
    };
    patch(prototype, 'open', (original) => function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (active && this && typeof this === 'object') {
        try {
          const url = pageUrl(args[1]);
          if (ownRequest(url)) requests.delete(this);
          else requests.set(this, { method: methodName(args[0]), url, started: 0, sent: false });
        } catch { requests.delete(this); }
      }
      return result;
    });
    patch(prototype, 'send', (original) => function (this: unknown, ...args: unknown[]) {
      const started = clock();
      const result = original.apply(this, args);
      if (active && this && typeof this === 'object') {
        try {
          const xhr = this as XMLHttpRequest;
          const request = requests.get(xhr);
          if (request && !request.sent) {
            request.sent = true;
            request.started = started;
            // A synchronous request has already finished by now.
            if (xhr.readyState === 4) end(xhr); else track(xhr);
          }
        } catch { /* Capture must never reach the app. */ }
      }
      return result;
    });
  }

  function watchConsole(): void {
    if (typeof console === 'undefined' || !console) return;
    for (const level of LEVELS) {
      patch(console, level, (original) => function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        capture('console', 'pbr/console', () => {
          const sensitiveText = privateText();
          let text = '';
          for (let index = 0; index < Math.min(args.length, DEVTOOLS_LIMITS.consoleArguments) && text.length < DEVTOOLS_LIMITS.textChars; index++) {
            text += (index ? ' ' : '') + describe(args[index], sensitiveText);
          }
          return { level, text: text.slice(0, DEVTOOLS_LIMITS.textChars) };
        });
        return result;
      });
    }
  }

  // Removal is registered first, so a listener that was added is always removed again.
  function listen(type: string, listener: (event: Event) => void): void {
    restores.push(() => {
      try { page.removeEventListener(type, listener); } catch { /* Cleanup must not reach the app. */ }
    });
    page.addEventListener(type, listener);
  }

  function watchErrors(): void {
    const uncaught = (text: string) => ({ level: 'error', text: text.slice(0, DEVTOOLS_LIMITS.textChars), uncaught: true });
    listen('error', (event) => capture('console', 'pbr/console', () => {
      const { error: thrown, message } = event as ErrorEvent;
      const sensitiveText = privateText();
      // Without the thrown value, as for a cross-origin script, the browser's message may already begin with Uncaught.
      return uncaught(`Uncaught ${thrown !== undefined && thrown !== null ? describe(thrown, sensitiveText)
        : redactText(typeof message === 'string' && message ? message : 'Error', sensitiveText, DEVTOOLS_LIMITS.textChars).replace(/^Uncaught\s+/, '')}`);
    }));
    listen('unhandledrejection', (event) => capture('console', 'pbr/console', () =>
      uncaught(`Uncaught (in promise) ${describe((event as PromiseRejectionEvent).reason, privateText())}`)));
  }

  function watchNavigation(): void {
    // The page a recording starts on is in rrweb's meta event; only later changes are reported.
    let last = '';
    try { last = pageUrl(page.location.href); } catch { /* The first change is reported. */ }
    const changed = () => {
      try {
        if (!active || busy) return;
        const url = pageUrl(page.location.href);
        if (url === last) return;
        last = url;
        capture('navigation', 'pbr/navigation', () => ({ url }));
      } catch { /* Capture must never reach the app. */ }
    };
    const history = page.history;
    if (history) {
      for (const method of ['pushState', 'replaceState']) {
        patch(history, method, (original) => function (this: unknown, ...args: unknown[]) {
          const result = original.apply(this, args);
          changed();
          return result;
        });
      }
    }
    listen('popstate', changed);
    listen('hashchange', changed);
  }

  // Each call through the app's PocketBase client becomes one event, read from its path and the counts in its answer.
  function watchPocketBase(): void {
    const client = options.pocketbase as unknown;
    if (!client || typeof client !== 'object' || typeof (client as { send?: unknown }).send !== 'function') return;
    const here = (() => { try { return String(page.location.href); } catch { return ''; } })();
    const replayOrigin = originOf(options.endpoint, here);
    const pageOrigin = originOf(here);
    interface Call { args: unknown[]; call: ReturnType<typeof describeCall>; id: string; server: boolean; linked: boolean;
      started: number; status: number; query: ReturnType<typeof describeQuery>; body: unknown }

    // A call to the replay endpoint's own server can be explained by it later.
    function sameServer(): boolean {
      let base: unknown;
      try { base = (client as { baseURL?: unknown }).baseURL ?? (client as { baseUrl?: unknown }).baseUrl; } catch { return false; }
      return !!replayOrigin && originOf(base ?? '', here) === replayOrigin;
    }

    // A same-origin server needs no permission for the header. Another origin gets one test request first, so a
    // proxy that refuses unknown headers can never make the app's own calls fail.
    function linkReady(): boolean {
      if (replayOrigin === pageOrigin) return true;
      const check = linkChecks.get(replayOrigin);
      const now = Date.now();
      if (check?.state === 'ok') return true;
      if (check && (check.state === 'pending' || now - check.at < DEVTOOLS_LIMITS.linkRetryMs)) return false;
      linkChecks.set(replayOrigin, { state: 'pending', at: now });
      const settle = (state: 'ok' | 'failed') => () => { linkChecks.set(replayOrigin, { state, at: Date.now() }); };
      try {
        Promise.resolve(page.fetch(`${replayApi}/link`, { headers: { [LINK_HEADER]: 'check' }, credentials: 'omit', cache: 'no-store' }))
          .then(settle('ok'), settle('failed'));
      } catch { settle('failed')(); }
      return false;
    }

    function prepare(args: unknown[]): Call | undefined {
      const given = args[1] && typeof args[1] === 'object' ? args[1] as Record<string, unknown> : undefined;
      const call = describeCall(given?.method, args[0]);
      if (call.path === REPLAY_API || call.path.startsWith(`${REPLAY_API}/`)) return undefined;
      const server = sameServer();
      const headers = given?.headers;
      // The SDK takes headers as a plain object; any other kind is passed on untouched.
      const plain = headers === undefined || (!!headers && typeof headers === 'object' && Object.getPrototypeOf(headers) === Object.prototype);
      const prepared: Call = { args, call, id: requestId(), server, linked: false, started: clock(), status: 0,
        query: describeQuery(queryOf(given)), body: given?.body };
      const next: Record<string, unknown> = { ...given };
      if (server && plain && linkReady()) {
        const link = linkValue(prepared.id, options.replaySession?.());
        next.headers = { ...(headers as Record<string, unknown> | undefined), [LINK_HEADER]: link };
        // PocketBase logs the URL even if an app hook throws before our tracing hook runs.
        // The server advertises this only when request tracing is explicitly enabled.
        if (options.tracePocketbaseRequests) next.query = { ...queryOf(given), __replayRequest: link };
        prepared.linked = true;
      }
      const appFetch = given?.fetch;
      if (typeof appFetch === 'function' || typeof page.fetch === 'function') {
        // The SDK sends through this, so the network rows leave the request to this call, which also learns its status.
        next.fetch = (url: unknown, init: unknown) => {
          if (init && typeof init === 'object') pocketbaseRequests.add(init);
          const sent = typeof appFetch === 'function' ? appFetch(url, init) : page.fetch(url as RequestInfo, init as RequestInit);
          return Promise.resolve(sent).then((response) => {
            try { prepared.status = Number((response as { status?: unknown } | null)?.status) || 0; } catch { /* Read as no status. */ }
            return response;
          });
        };
      }
      prepared.args = [args[0], next, ...args.slice(2)];
      return prepared;
    }

    function finish(prepared: Call, data: unknown, error: unknown, failed: boolean): void {
      capture('pocketbase', 'pbr/pocketbase', () => {
        const { call } = prepared;
        const outcome = failed ? describeFailure(error, privateText()) : undefined;
        const status = outcome ? outcome.status : prepared.status || (call.method === 'DELETE' ? 204 : 200);
        const result = outcome ? {} : describeResult(call, data);
        const payload: Record<string, unknown> = {
          request: prepared.id, method: call.method, path: call.path,
          ...(call.collection ? { collection: call.collection } : {}), ...(call.action ? { action: call.action } : {}),
          ...(call.record || result.record ? { record: call.record ?? result.record } : {}),
          status, duration: Math.max(0, Math.round(clock() - prepared.started)),
          ...(outcome?.failed ? { failed: outcome.failed } : {}),
          ...(prepared.linked ? { linked: true } : {}), ...(prepared.server ? { server: true } : {}),
        };
        for (const key of ['items', 'total', 'page', 'perPage'] as const) if (result[key] !== undefined) payload[key] = result[key];
        if (prepared.query) payload.query = prepared.query;
        if (outcome?.message) payload.message = outcome.message;
        if (outcome?.invalid) payload.invalid = outcome.invalid;
        if (call.action === 'batch') {
          const batch = describeBatch(prepared.body, failed ? undefined : data);
          if (batch.length) payload.batch = batch;
        }
        if (call.action === 'realtime') {
          const topics = describeTopics(prepared.body);
          if (topics.length) payload.topics = topics;
        }
        return payload;
      });
    }

    patch(client, 'send', (original) => function (this: unknown, ...args: unknown[]) {
      if (!active) return original.apply(this, args);
      let prepared: Call | undefined;
      try { prepared = prepare(args); } catch { prepared = undefined; }
      if (!prepared) return original.apply(this, args);
      const result = original.apply(this, prepared.args);
      if (!result || typeof (result as Promise<unknown>).then !== 'function') return result;
      const done = prepared;
      // Chained to the original, so the app gets its exact answer or error, and an unhandled rejection stays one.
      return (result as Promise<unknown>).then((data) => { finish(done, data, undefined, false); return data; },
        (error: unknown) => { finish(done, undefined, error, true); throw error; });
    });
  }

  const parts = [watchNavigation];
  if (options.recordNetwork === true) parts.push(watchFetch, watchXhr);
  if (options.recordConsole === true) parts.push(watchConsole, watchErrors);
  if (options.recordPocketbase === true && options.pocketbase) parts.push(watchPocketBase);
  for (const part of parts) {
    try { part(); } catch { /* Each hook is optional. */ }
  }
  return () => {
    if (!active) return;
    active = false;
    for (const restore of restores.splice(0).reverse()) {
      try { restore(); } catch { /* Cleanup must not reach the app. */ }
    }
  };
}
