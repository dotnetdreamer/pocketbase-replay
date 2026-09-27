import { base64, byteLength, serializeEvent } from './privacy';
import type { RecorderAdapter, ReplayChunk, ReplayController, ReplayEvent, ReplayMetadata, ReplayMetrics, ReplayOptions, ReplayRuntime } from './types';

export const REPLAY_LIMITS = {
  bufferBytes: 128 * 1024,
  rawQueueBytes: 2 * 1024 * 1024,
  eventBytes: 1024 * 1024,
  queueBytes: 512 * 1024,
  queueChunks: 12,
  targetBodyBytes: 60 * 1024,
  maxBodyBytes: 500 * 1024,
  unloadRawBytes: 256 * 1024,
  sessionChunks: 2048,
  rejectedChunks: 3,
  retryMs: 5000,
  maxRetryMs: 5 * 60 * 1000,
  configIntervalMs: 45000,
};

interface Entry { json: string; bytes: number; timestamp: number; snapshot: boolean }
interface Batch { entries: Entry[]; room: string; epoch: number; bytes: number; taken?: boolean }
interface Prepared { body: string; bytes: number; epoch: number }
interface Session { sessionId: string; token: string; expiresAt: number }

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function retryable(status: number): boolean {
  return !(status > 0) || status === 408 || status === 429 || status >= 500;
}

export function createReplay(options: ReplayOptions, runtime: ReplayRuntime): ReplayController {
  const metrics: ReplayMetrics = {
    startedAt: runtime.now(), recording: false, sessionId: null, events: 0, rawBytes: 0,
    compressedBytes: 0, networkBytes: 0, uploadedChunks: 0, droppedChunks: 0, droppedEvents: 0,
    errors: 0, mainThreadMs: 0, compressionWallMs: 0, bufferedBytes: 0, queuedBytes: 0,
  };
  const endpoint = options.endpoint.replace(/\/+$/, '');
  let closed = !endpoint || !options.transport;
  let active = options.initialActive !== false;
  let session: Session | null = null;
  let identity = '';
  let epoch = 0;
  let seq = 0;
  let interval = 25000;
  let adapter: RecorderAdapter | null = null;
  let captureStop: (() => void) | undefined;
  let captureStarting = false;
  let awaitingSnapshot = true;
  let localBlocked = false;
  let buffer: Entry[] = [];
  let bufferBytes = 0;
  let room = '';
  let pending: Batch[] = [];
  let pendingBytes = 0;
  let queue: Prepared[] = [];
  let queueBytes = 0;
  let pumping: Promise<void> | null = null;
  let inflight: Batch | null = null;
  let posting: Prepared | null = null;
  let postingKeepalive = false;
  let retryUnreachable = false;
  let retryAt = 0;
  let retryDelay = 0;
  let rejected = 0;
  let refreshing: Promise<void> | null = null;
  let refreshAgain = false;
  let recoveryTimer: unknown;
  let lastRecoveryAt = 0;
  let configTimer: unknown;
  let flushTimer: unknown;
  let removeLifecycle: (() => void) | undefined;

  function metadata(): ReplayMetadata | null {
    try {
      const value = options.metadata();
      if (!value || !value.deviceId) return null;
      const accountId = String(value.accountId ?? '').slice(0, 128);
      return {
        deviceId: String(value.deviceId).slice(0, 128), accountId,
        platform: String(value.platform ?? '').slice(0, 32), appVersion: String(value.appVersion ?? '').slice(0, 64),
        room: String(value.room ?? '').slice(0, 64), authToken: accountId ? String(value.authToken ?? '') : '',
      };
    } catch { return null; }
  }

  function identityOf(value: ReplayMetadata): string { return `${value.deviceId}\n${value.accountId ?? ''}`; }

  function stopCapture(): void {
    metrics.recording = false;
    const stop = captureStop;
    captureStop = undefined;
    try { stop?.(); } catch { metrics.errors++; }
  }

  function clearData(): void {
    metrics.droppedChunks += pending.length + queue.length;
    metrics.droppedEvents += buffer.length;
    buffer = []; bufferBytes = 0;
    pending = []; pendingBytes = 0;
    queue = []; queueBytes = 0;
    awaitingSnapshot = true;
    epoch++;
  }

  function disable(): void {
    stopCapture();
    session = null;
    metrics.sessionId = null;
    clearData();
  }

  function recover(): void {
    clearData();
    if (recoveryTimer !== undefined || !session || !active || closed) return;
    const delay = Math.min(5000, Math.max(0, 5000 - (runtime.now() - lastRecoveryAt)));
    recoveryTimer = runtime.schedule(() => {
      recoveryTimer = undefined;
      if (!closed && active && session && !localBlocked) {
        lastRecoveryAt = runtime.now();
        try { adapter?.snapshot(); } catch { metrics.errors++; disable(); }
      }
    }, delay);
  }

  function blockOversize(): void {
    localBlocked = true;
    stopCapture();
    clearData();
  }

  function seal(): void {
    if (!buffer.length) return;
    pending.push({ entries: buffer, room, epoch, bytes: bufferBytes });
    pendingBytes += bufferBytes;
    buffer = []; bufferBytes = 0;
    if (pendingBytes > REPLAY_LIMITS.rawQueueBytes || pending.length > REPLAY_LIMITS.queueChunks) recover();
  }

  function receive(event: ReplayEvent): void {
    const started = runtime.performanceNow();
    try {
      if (closed || !active || !session || localBlocked) return;
      const value = metadata();
      if (!value || identityOf(value) !== identity) {
        disable();
        void refresh();
        return;
      }
      if (awaitingSnapshot && event.type !== 2 && event.type !== 4) return;
      const nextRoom = value.room ?? '';
      if (nextRoom !== room) { seal(); room = nextRoom; void pump(); }
      const json = serializeEvent(event, options.sensitiveText?.() ?? [], {
        assetBaseUrl: options.assetBaseUrl,
        assetOrigin: typeof location === 'undefined' ? undefined
          : location.origin === 'null' ? location.href : location.origin,
      });
      const bytes = byteLength(json) + 1;
      if (bytes > REPLAY_LIMITS.eventBytes) { metrics.droppedEvents++; blockOversize(); return; }
      if (bufferBytes && bufferBytes + bytes > REPLAY_LIMITS.bufferBytes) seal();
      if (awaitingSnapshot && event.type !== 2 && event.type !== 4) return;
      buffer.push({ json, bytes, timestamp: event.timestamp, snapshot: event.type === 2 });
      bufferBytes += bytes;
      metrics.events++;
      metrics.rawBytes += bytes;
      if (event.type === 2) awaitingSnapshot = false;
      if (bufferBytes >= REPLAY_LIMITS.bufferBytes) { seal(); void pump(); }
    } catch { metrics.errors++; recover(); }
    finally { metrics.mainThreadMs += runtime.performanceNow() - started; }
  }

  async function startCapture(): Promise<void> {
    if (closed || !active || !session || captureStop || captureStarting || localBlocked) return;
    captureStarting = true;
    const expected = epoch;
    try {
      adapter = adapter ?? await runtime.loadRecorder();
      if (expected !== epoch || closed || !active || !session) return;
      awaitingSnapshot = true;
      const stop = adapter.start(receive, options);
      if (expected !== epoch || closed || !active || localBlocked) { stop?.(); return; }
      captureStop = stop;
      metrics.recording = Boolean(stop);
    } catch { metrics.errors++; disable(); }
    finally { captureStarting = false; }
  }

  function makeChunk(batch: Batch, compressed: Uint8Array, number: number): ReplayChunk {
    const startedAt = batch.entries[0].timestamp;
    return {
      sessionId: session!.sessionId, token: session!.token, seq: number,
      startedAt, endedAt: Math.max(startedAt, batch.entries[batch.entries.length - 1].timestamp),
      room: batch.room, encoding: 'gzip-base64', data: base64(compressed),
      rawBytes: batch.bytes + 1, eventCount: batch.entries.length,
      hasSnapshot: batch.entries.some((entry) => entry.snapshot),
    };
  }

  function rawBatch(batch: Batch): string { return `[${batch.entries.map((entry) => entry.json).join(',')}]`; }

  async function prepare(batch: Batch): Promise<void> {
    if (batch.epoch !== epoch || !session) return;
    if (seq >= REPLAY_LIMITS.sessionChunks) { disable(); void refresh(); return; }
    const compressionStart = runtime.performanceNow();
    let compressed: Uint8Array;
    inflight = batch;
    try {
      const started = runtime.performanceNow();
      let work: Promise<Uint8Array>;
      try { work = runtime.compress(rawBatch(batch)); }
      finally { metrics.mainThreadMs += runtime.performanceNow() - started; }
      compressed = await work;
    }
    catch { metrics.errors++; if (batch.epoch === epoch && !batch.taken) recover(); return; }
    finally { inflight = null; metrics.compressionWallMs += runtime.performanceNow() - compressionStart; }
    if (batch.taken || batch.epoch !== epoch || !session) return;
    const started = runtime.performanceNow();
    const body = JSON.stringify(makeChunk(batch, compressed, seq));
    const bytes = byteLength(body);
    metrics.mainThreadMs += runtime.performanceNow() - started;
    if (bytes > REPLAY_LIMITS.targetBodyBytes && batch.entries.length > 1 && !batch.entries.some((entry) => entry.snapshot)) {
      const middle = Math.floor(batch.entries.length / 2);
      pending.unshift(...[batch.entries.slice(0, middle), batch.entries.slice(middle)].map((entries) => (
        { entries, room: batch.room, epoch: batch.epoch, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) })));
      pendingBytes += batch.bytes;
      return;
    }
    if (bytes > REPLAY_LIMITS.maxBodyBytes) { blockOversize(); return; }
    seq++;
    queue.push({ body, bytes, epoch });
    queueBytes += bytes;
    metrics.compressedBytes += compressed.byteLength;
    if (queueBytes > REPLAY_LIMITS.queueBytes || queue.length > REPLAY_LIMITS.queueChunks) recover();
  }

  function pump(): Promise<void> {
    if (pumping) return pumping;
    if (closed || !session) return Promise.resolve();
    pumping = (async () => {
      try {
        while (pending.length && !closed && session) {
          const batch = pending.shift()!;
          pendingBytes -= batch.bytes;
          await prepare(batch);
        }
        // A retryAt further out than the delay means the clock stepped back.
        while (queue.length && !closed && session && (runtime.now() >= retryAt || retryAt - runtime.now() > retryDelay)) {
          const item = queue[0];
          try {
            metrics.networkBytes += item.bytes;
            posting = item;
            postingKeepalive = pageHidden();
            await options.transport!.post(`${endpoint}/api/replay/chunks`, item.body);
          } catch (error) {
            metrics.errors++;
            if (item.epoch !== epoch) break;
            const status = statusOf(error);
            if (status === 401 || status === 403 || status === 404) disable();
            else if (status === 410) { disable(); void refresh(); }
            else if (status === 413) recover();
            else if (retryable(status)) {
              retryUnreachable = status === 0;
              retryDelay = Math.min(retryDelay * 2 || REPLAY_LIMITS.retryMs, REPLAY_LIMITS.maxRetryMs);
              retryAt = runtime.now() + retryDelay;
            } else if (++rejected >= REPLAY_LIMITS.rejectedChunks) { localBlocked = true; disable(); }
            else recover();
            break;
          } finally { posting = null; }
          retryAt = 0; retryDelay = 0; rejected = 0;
          if (item.epoch !== epoch) break;
          if (queue[0] === item) { queue.shift(); queueBytes -= item.bytes; }
          metrics.uploadedChunks++;
        }
      } catch { metrics.errors++; }
    })().finally(() => { pumping = null; });
    return pumping;
  }

  async function flush(): Promise<void> {
    try {
      if (closed || !session) return;
      const value = metadata();
      if (!value || identityOf(value) !== identity) { disable(); await refresh(); return; }
      seal();
      await pump();
      if (pending.length) await pump();
    } catch { metrics.errors++; }
  }

  function unload(): void {
    stopCapture();
    if (!session || !options.transport?.beacon) return;
    const value = metadata();
    if (!value || identityOf(value) !== identity) { disable(); return; }
    const started = runtime.performanceNow();
    try {
      const tail = (inflight && !inflight.taken ? [inflight] : []).concat(pending);
      if (buffer.length) tail.push({ entries: buffer, room, epoch, bytes: bufferBytes });
      const groups: Batch[] = [];
      let rawBytes = 0;
      for (const batch of tail) {
        if (batch.epoch !== epoch) continue;
        rawBytes += batch.bytes;
        const last = groups[groups.length - 1];
        if (last && last.room === batch.room) { last.entries = last.entries.concat(batch.entries); last.bytes += batch.bytes; }
        else groups.push({ entries: batch.entries, room: batch.room, epoch, bytes: batch.bytes });
      }
      if (groups.length && rawBytes <= REPLAY_LIMITS.unloadRawBytes && seq + groups.length <= REPLAY_LIMITS.sessionChunks) {
        const chunks = groups.map((batch, index) => {
          const compressed = runtime.compressSync(rawBatch(batch));
          const body = JSON.stringify(makeChunk(batch, compressed, seq + index));
          return { body, bytes: byteLength(body), compressedBytes: compressed.byteLength };
        });
        if (chunks.every((chunk) => chunk.bytes <= REPLAY_LIMITS.targetBodyBytes)) {
          for (const chunk of chunks) {
            queue.push({ body: chunk.body, bytes: chunk.bytes, epoch }); queueBytes += chunk.bytes;
            metrics.compressedBytes += chunk.compressedBytes;
          }
          seq += chunks.length;
          if (inflight) inflight.taken = true;
          pending = []; pendingBytes = 0;
          buffer = []; bufferBytes = 0;
        }
      }
      let budget = REPLAY_LIMITS.targetBodyBytes;
      // A refused beacon ends the run, unless its chunk is the upload already on the wire holding the keepalive quota.
      for (const item of queue) {
        if (item.epoch !== epoch || item.bytes > budget) break;
        // Its keepalive upload outlives the page; a beacon would only spend the shared quota.
        if (item === posting && postingKeepalive) continue;
        if (options.transport.beacon(`${endpoint}/api/replay/chunks`, item.body)) {
          // Retain until acknowledged; beacon delivery itself has no acknowledgement.
          metrics.networkBytes += item.bytes;
          budget -= item.bytes;
        } else if (item !== posting) break;
      }
    } catch { metrics.errors++; }
    finally { metrics.mainThreadMs += runtime.performanceNow() - started; }
  }

  function setActive(value: boolean, unloading = false): void {
    if (closed) return;
    if (!value) {
      active = false;
      if (unloading) unload(); else { stopCapture(); void flush(); }
    } else if (!active) {
      active = true;
      awaitingSnapshot = true;
      void refresh();
    }
  }

  async function refreshOnce(): Promise<void> {
    if (closed) return;
    const value = metadata();
    if (!value) { disable(); return; }
    const nextIdentity = identityOf(value);
    if (identity !== nextIdentity) {
      disable(); identity = nextIdentity; seq = 0; localBlocked = false;
    }
    if (session && session.expiresAt <= runtime.now() + 30000) { disable(); seq = 0; }
    const expectedIdentity = identity;
    try {
      const body = JSON.stringify(value);
      metrics.networkBytes += byteLength(body);
      const config = await options.transport!.post(`${endpoint}/api/replay/config`, body) as Record<string, unknown>;
      if (closed || expectedIdentity !== identity || identityOf(metadata() ?? value) !== expectedIdentity) { refreshAgain = !closed; return; }
      if (config?.enabled !== true) { disable(); return; }
      interval = Math.max(20000, Math.min(30000, Number(config.uploadIntervalMs) || 25000));
      // Back online: a network failure need not wait out its back-off. A 429 or 5xx still does.
      if (retryUnreachable) { retryAt = 0; retryDelay = 0; retryUnreachable = false; }
      if (!active || localBlocked) return;
      if (!session) {
        metrics.networkBytes += byteLength(body);
        const result = await options.transport!.post(`${endpoint}/api/replay/start`, body) as Record<string, unknown>;
        if (closed || identityOf(metadata() ?? value) !== expectedIdentity) { refreshAgain = !closed; return; }
        if (result?.enabled !== true || typeof result.sessionId !== 'string' || typeof result.token !== 'string') { disable(); return; }
        // Measured on this device's clock, which may be hours off; the server's 410 has the final say.
        const expiresIn = Number(result.expiresIn);
        const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? runtime.now() + expiresIn
          : typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(String(result.expiresAt));
        if (!Number.isFinite(expiresAt)) { disable(); return; }
        session = { sessionId: result.sessionId, token: result.token, expiresAt };
        metrics.sessionId = session.sessionId;
        seq = 0; retryAt = 0; retryDelay = 0; rejected = 0;
        room = value.room ?? '';
      }
      await startCapture();
    } catch (error) {
      metrics.errors++;
      // An unreachable or busy server keeps the session and its queue for the next poll.
      if (!retryable(statusOf(error))) disable();
      else if (closed || identityOf(metadata() ?? value) !== expectedIdentity) refreshAgain = !closed;
      else await startCapture();
    }
  }

  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do { refreshAgain = false; await refreshOnce(); } while (refreshAgain && !closed);
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function scheduleConfig(): void {
    configTimer = runtime.schedule(() => {
      if (closed) return;
      void refresh(); scheduleConfig();
    }, REPLAY_LIMITS.configIntervalMs);
  }

  function scheduleFlush(): void {
    flushTimer = runtime.schedule(() => {
      if (closed) return;
      void flush(); scheduleFlush();
    }, interval);
  }

  if (!closed) {
    try { removeLifecycle = runtime.subscribe?.(setActive); } catch { metrics.errors++; }
    scheduleConfig(); scheduleFlush(); void refresh();
  }
  return {
    stop: () => {
      if (closed) return;
      unload(); closed = true; disable();
      runtime.cancel(configTimer); runtime.cancel(flushTimer); runtime.cancel(recoveryTimer);
      try { removeLifecycle?.(); } catch { metrics.errors++; }
    },
    flush,
    refresh,
    getMetrics: () => ({ ...metrics, bufferedBytes: bufferBytes + pendingBytes, queuedBytes: queueBytes }),
  };
}
