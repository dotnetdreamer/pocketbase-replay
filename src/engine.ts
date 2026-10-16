import { base64, byteLength, packagedAssetBase, serializeEvent } from './privacy';
import type {
  RecorderAdapter, RecorderOptions, ReplayChunk, ReplayController, ReplayEvent, ReplayMetadata, ReplayMetrics, ReplayOptions,
  ReplayRuntime, ReplaySessionContext,
} from './types';

const automaticErrorTriggers = new WeakMap<object, boolean>();
export function canTriggerReplayError(replay: object): boolean { return automaticErrorTriggers.get(replay) !== false; }

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
  // Trigger mode keeps one to two minutes on the device, each part opening with a full snapshot,
  // and uploads for a minute after the last trigger.
  checkoutMs: 60000,
  keptBytes: 2 * 1024 * 1024,
  keptChunks: 10,
  liveMs: 60000,
  markMs: 5000,
};

// Image snapshots from a platform recorder are pre-masked frames of up to 256 KiB that barely compress, so they use
// the Flutter engine's frame-sized bounds and each part uploads once sealed. The DOM bounds would hold frames until
// the next flush, split them into one chunk each and overflow the queue, which drops them all.
export const IMAGE_REPLAY_LIMITS = {
  ...REPLAY_LIMITS,
  bufferBytes: 256 * 1024,
  rawQueueBytes: 8 * 1024 * 1024,
  queueBytes: 4 * 1024 * 1024,
  queueChunks: 40,
  targetBodyBytes: 400 * 1024,
  keptBytes: 6 * 1024 * 1024,
  keptChunks: 40,
};

interface Entry { json: string; bytes: number; timestamp: number; snapshot: boolean; meta: boolean }
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

// Null marks a rule the client cannot read; recording then waits rather than go unmasked.
function serverSelector(value: unknown): string | null {
  return value === undefined || value === null ? '' : typeof value === 'string' ? value : null;
}

function joinSelectors(host: unknown, server: string): string {
  return [host == null ? '' : String(host), server].map((value) => value.trim()).filter(Boolean).join(',');
}

// Cleaned exactly as the server cleans it, so no label can make it refuse the session: no control characters,
// at most 64 characters, and never half of an emoji.
export function triggerLabel(value: unknown): string {
  const label = (typeof value === 'string' ? value : '').replace(/[\x00-\x1f\x7f]/g, '').trim()
    .slice(0, 64).replace(/[\uD800-\uDBFF]$/, '').trim();
  return label || 'manual';
}

// A trigger opens a part only with its full snapshot, which follows its meta event.
function opensSnapshot(batch: Batch): boolean {
  return batch.entries.slice(0, 2).some((entry) => entry.snapshot);
}

export function createReplay(options: ReplayOptions, runtime: ReplayRuntime): ReplayController {
  const metrics: ReplayMetrics = {
    startedAt: runtime.now(), recording: false, sessionId: null, events: 0, rawBytes: 0,
    compressedBytes: 0, networkBytes: 0, uploadedChunks: 0, droppedChunks: 0, droppedEvents: 0,
    errors: 0, mainThreadMs: 0, compressionWallMs: 0, bufferedBytes: 0, queuedBytes: 0,
  };
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : '';
  let closed = !endpoint || !options.transport;
  let active = options.initialActive !== false;
  let session: Session | null = null;
  let identity = '';
  let epoch = 0;
  let seq = 0;
  let interval = 25000;
  let adapter: RecorderAdapter | null = null;
  let limits = REPLAY_LIMITS;
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
  let checkoutTimer: unknown;
  let snapshotTimer: unknown;
  let removeLifecycle: (() => void) | undefined;
  let removeErrors: (() => void) | undefined;
  let serverMask: string | null = '';
  let serverBlock: string | null = '';
  let serverImages = false;
  let serverNetwork = false;
  let serverConsole = false;
  let serverPocketbase = false;
  let serverTracePocketbase = false;
  let captureRules = '';
  // Trigger mode records on the device and uploads only after a trigger, for a while.
  let mode: 'session' | 'trigger' = 'session';
  let live = false;
  let liveUntil = 0;
  let kept: Batch[] = [];
  let keptBytes = 0;
  let partRequested = false;
  // A promoted backlog may briefly exceed the usual queue bounds while it uploads.
  let burst = { bytes: 0, chunks: 0 };
  let triggered = '';
  let waiting: ((context: ReplaySessionContext | null) => void)[] = [];
  const marks = new Map<string, number>();
  // Trigger marks made while the next part still waits for its full snapshot; they follow that snapshot.
  let heldMarks: ReplayEvent[] = [];

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

  // Between triggers nothing uploads; what is recorded stays on the device.
  function keeping(): boolean { return mode === 'trigger' && !live; }

  function rememberRules(answer: Record<string, unknown>): void {
    serverMask = serverSelector(answer.maskTextSelector);
    serverBlock = serverSelector(answer.blockSelector);
    serverImages = answer.recordImages === true;
    serverNetwork = answer.recordNetwork === true;
    serverConsole = answer.recordConsole === true;
    serverPocketbase = answer.recordPocketbase === true;
    serverTracePocketbase = answer.tracePocketbaseRequests === true;
  }

  function rulesKey(): string { return JSON.stringify([serverMask, serverBlock, serverImages, serverNetwork, serverConsole, serverPocketbase, serverTracePocketbase]); }

  // rrweb skips a selector it cannot parse, which would leave that text unmasked.
  function captureOptions(): RecorderOptions | null {
    if (serverMask === null || serverBlock === null) return null;
    const maskTextSelector = joinSelectors(options.maskTextSelector, serverMask);
    const blockSelector = joinSelectors(options.blockSelector, serverBlock);
    try {
      for (const selector of [maskTextSelector, blockSelector]) {
        if (selector && runtime.validSelector && !runtime.validSelector(selector)) return null;
      }
    } catch { return null; }
    return {
      ...options, maskTextSelector, blockSelector, recordImages: serverImages, recordNetwork: serverNetwork, recordConsole: serverConsole,
      recordPocketbase: serverPocketbase, tracePocketbaseRequests: serverTracePocketbase, replaySession: () => context()?.sessionId ?? null,
    };
  }

  function stopCapture(): void {
    metrics.recording = false;
    runtime.cancel(checkoutTimer);
    checkoutTimer = undefined;
    const stop = captureStop;
    captureStop = undefined;
    try { stop?.(); } catch { metrics.errors++; }
  }

  function clearData(): void {
    metrics.droppedChunks += pending.length + queue.length + kept.length;
    metrics.droppedEvents += buffer.length;
    buffer = []; bufferBytes = 0;
    pending = []; pendingBytes = 0;
    queue = []; queueBytes = 0;
    kept = []; keptBytes = 0; partRequested = false;
    burst = { bytes: 0, chunks: 0 };
    awaitingSnapshot = true;
    epoch++;
  }

  function settle(context: ReplaySessionContext | null): void {
    const callers = waiting;
    waiting = [];
    for (const resolve of callers) resolve(context);
  }

  function disable(): void {
    stopCapture();
    session = null;
    metrics.sessionId = null;
    live = false; liveUntil = 0; triggered = ''; heldMarks = [];
    clearData();
    settle(null);
  }

  // Another account or device: nothing recorded for the last one goes on, and its marks no longer count.
  function adopt(next: string): void {
    disable(); identity = next; seq = 0; localBlocked = false; marks.clear();
  }

  // The session's credential ends between triggers; what the device keeps waits for the next one.
  function endSession(): void {
    metrics.droppedChunks += pending.length + queue.length;
    pending = []; pendingBytes = 0;
    queue = []; queueBytes = 0;
    burst = { bytes: 0, chunks: 0 };
    session = null;
    metrics.sessionId = null;
    seq = 0;
    epoch++;
    for (const batch of kept) batch.epoch = epoch;
  }

  function snapshotNow(): void {
    try { adapter?.snapshot(); } catch { metrics.errors++; disable(); }
  }

  function recover(): void {
    clearData();
    if (recoveryTimer !== undefined || (!session && !keeping()) || !active || closed) return;
    const delay = Math.min(5000, Math.max(0, 5000 - (runtime.now() - lastRecoveryAt)));
    recoveryTimer = runtime.schedule(() => {
      recoveryTimer = undefined;
      if (!closed && active && (session || keeping()) && !localBlocked) {
        lastRecoveryAt = runtime.now();
        snapshotNow();
      }
    }, delay);
  }

  function blockOversize(): void {
    localBlocked = true;
    heldMarks = [];
    stopCapture();
    clearData();
  }

  // Keeps from the newest part at least a checkout old, so a trigger at any moment has a minute or more
  // of history. Each part opens with a full snapshot, so an upload can always be played from its start.
  function keep(batch: Batch): void {
    kept.push(batch);
    keptBytes += batch.bytes;
    const cutoff = runtime.now() - REPLAY_LIMITS.checkoutMs;
    let from = -1;
    for (let index = kept.length - 1; index >= 0; index--) {
      if (!opensSnapshot(kept[index])) continue;
      from = index;
      if (kept[index].entries[0].timestamp <= cutoff) break;
    }
    dropKept(from < 0 ? kept.length : from);
    while (keptBytes > limits.keptBytes || kept.length > limits.keptChunks) {
      const next = kept.findIndex((item, index) => index > 0 && opensSnapshot(item));
      // The newest part alone is too large to keep: start again from a fresh snapshot.
      if (next < 0) { recover(); return; }
      dropKept(next);
    }
    if (opensSnapshot(batch)) partRequested = false;
    // Image frames can fill the allowance well within a checkout, and one image costs no more as a full snapshot,
    // so a part opens at half of it: reaching the allowance then drops the older part instead of everything kept.
    if (limits !== IMAGE_REPLAY_LIMITS || partRequested) return;
    let bytes = 0, chunks = 0;
    for (let index = kept.length - 1; index >= 0; index--) {
      bytes += kept[index].bytes; chunks++;
      if (opensSnapshot(kept[index])) break;
    }
    if (bytes <= limits.keptBytes / 2 && chunks <= limits.keptChunks / 2) return;
    partRequested = true;
    runtime.schedule(() => { if (!closed && active && captureStop && !localBlocked && keeping()) snapshotNow(); }, 0);
  }

  function dropKept(count: number): void {
    for (const batch of kept.slice(0, count)) keptBytes -= batch.bytes;
    kept = kept.slice(count);
  }

  function seal(): void {
    if (!buffer.length) return;
    const batch: Batch = { entries: buffer, room, epoch, bytes: bufferBytes };
    buffer = []; bufferBytes = 0;
    if (keeping()) { keep(batch); return; }
    pending.push(batch);
    pendingBytes += batch.bytes;
    if (pendingBytes > limits.rawQueueBytes + burst.bytes || pending.length > limits.queueChunks + burst.chunks) recover();
    else if (limits === IMAGE_REPLAY_LIMITS) void pump();
  }

  function scheduleCheckout(): void {
    runtime.cancel(checkoutTimer);
    checkoutTimer = runtime.schedule(() => {
      checkoutTimer = undefined;
      if (closed || !active || !captureStop || localBlocked || !keeping()) return;
      snapshotNow();
      scheduleCheckout();
    }, REPLAY_LIMITS.checkoutMs);
  }

  // Whatever comes next, kept or live, must open with a full snapshot. Possibly called from inside rrweb's emit,
  // so the snapshot waits a tick, and it is taken whenever one is still missing by then.
  function snapshotSoon(): void {
    if (snapshotTimer !== undefined) return;
    snapshotTimer = runtime.schedule(() => {
      snapshotTimer = undefined;
      if (!closed && active && captureStop && !localBlocked && awaitingSnapshot) snapshotNow();
    }, 0);
  }

  // The minute after the last trigger has passed: upload what is buffered, then keep on the device again.
  function endLive(): void {
    seal();
    void pump();
    live = false;
    awaitingSnapshot = true;
    snapshotSoon();
    scheduleCheckout();
  }

  function liveEnded(): boolean { return mode === 'trigger' && live && runtime.now() >= liveUntil; }

  // A trigger with a session: what the device kept uploads first, then recording stays live for a minute.
  function promote(): void {
    if (keeping()) seal();
    live = true;
    liveUntil = Math.max(liveUntil, runtime.now() + REPLAY_LIMITS.liveMs);
    triggered = '';
    if (kept.length && opensSnapshot(kept[0])) {
      burst = { bytes: burst.bytes + Math.ceil(keptBytes * 1.4), chunks: burst.chunks + kept.length * 2 };
      for (const batch of kept) { batch.epoch = epoch; pending.push(batch); pendingBytes += batch.bytes; }
    }
    kept = []; keptBytes = 0;
    if (awaitingSnapshot) snapshotSoon();
    void pump();
  }

  function take(event: ReplayEvent): void {
    if (closed || !active || localBlocked) return;
    if (liveEnded()) endLive();
    if (!session && !keeping()) return;
    const value = metadata();
    if (!value || identityOf(value) !== identity) {
      disable();
      void refresh();
      return;
    }
    if (awaitingSnapshot && event.type !== 2 && event.type !== 4) return;
    // A full snapshot opens the next kept part.
    if (keeping() && event.type === 4) seal();
    const nextRoom = value.room ?? '';
    if (nextRoom !== room) { seal(); room = nextRoom; if (!keeping()) void pump(); }
    const assetOrigin = typeof location === 'undefined' ? undefined
      : location.origin === 'null' ? location.href : location.origin;
    const json = serializeEvent(event, options.sensitiveText?.() ?? [], {
      assetBaseUrl: options.assetBaseUrl !== undefined ? options.assetBaseUrl
        : packagedAssetBase(endpoint, assetOrigin, value.appVersion),
      assetOrigin,
      images: serverImages,
      imageSnapshots: adapter?.imageSnapshots === true,
      preserveDataAttributes: options.preserveDataAttributes,
    });
    const bytes = byteLength(json) + 1;
    if (bytes > REPLAY_LIMITS.eventBytes) { metrics.droppedEvents++; blockOversize(); return; }
    // A large full snapshot stays with the meta event just before it: the player needs that meta to place it,
    // and a kept part made of the meta alone would be dropped for not opening with a snapshot.
    const followsMeta = event.type === 2 && buffer.length === 1 && buffer[0].meta;
    if (bufferBytes && bufferBytes + bytes > limits.bufferBytes && !followsMeta) seal();
    if (awaitingSnapshot && event.type !== 2 && event.type !== 4) return;
    buffer.push({ json, bytes, timestamp: event.timestamp, snapshot: event.type === 2, meta: event.type === 4 });
    bufferBytes += bytes;
    metrics.events++;
    metrics.rawBytes += bytes;
    if (event.type === 2) awaitingSnapshot = false;
    if (bufferBytes >= limits.bufferBytes) { seal(); if (!keeping()) void pump(); }
  }

  function receive(event: ReplayEvent): void {
    const started = runtime.performanceNow();
    try {
      take(event);
      // Marks held for this snapshot follow it, placed no earlier than the part they now open.
      if (event.type === 2 && !awaitingSnapshot && heldMarks.length) {
        const held = heldMarks;
        heldMarks = [];
        for (const mark of held) take({ ...mark, timestamp: Math.max(mark.timestamp, event.timestamp) });
      }
    } catch { metrics.errors++; recover(); }
    finally { metrics.mainThreadMs += runtime.performanceNow() - started; }
  }

  async function startCapture(): Promise<void> {
    if (closed || !active || (!session && !keeping()) || captureStop || captureStarting || localBlocked) return;
    captureStarting = true;
    const expected = epoch;
    try {
      adapter = adapter ?? await runtime.loadRecorder();
      limits = adapter.imageSnapshots === true ? IMAGE_REPLAY_LIMITS : REPLAY_LIMITS;
      if (expected !== epoch || closed || !active || (!session && !keeping())) return;
      const settings = captureOptions();
      if (!settings) { metrics.errors++; return; }
      captureRules = rulesKey();
      awaitingSnapshot = true;
      const stop = adapter.start(receive, settings);
      if (expected !== epoch || closed || !active || localBlocked) { stop?.(); return; }
      captureStop = stop;
      metrics.recording = Boolean(stop);
      if (stop && keeping()) scheduleCheckout();
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
      ...(apiKey ? { apiKey } : {}),
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
    if (bytes > limits.targetBodyBytes && batch.entries.length > 1 && !batch.entries.some((entry) => entry.snapshot)) {
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
    if (queueBytes > limits.queueBytes + burst.bytes || queue.length > limits.queueChunks + burst.chunks) recover();
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
        if (!pending.length && !queue.length) burst = { bytes: 0, chunks: 0 };
      } catch { metrics.errors++; }
    })().finally(() => { pumping = null; });
    return pumping;
  }

  async function flush(): Promise<void> {
    try {
      if (closed) return;
      if (liveEnded()) endLive();
      if (!session) return;
      const value = metadata();
      if (!value || identityOf(value) !== identity) { disable(); await refresh(); return; }
      if (!keeping()) seal();
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
      // What the device keeps between triggers never leaves it at exit.
      if (buffer.length && !keeping()) tail.push({ entries: buffer, room, epoch, bytes: bufferBytes });
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
          if (!keeping()) { buffer = []; bufferBytes = 0; }
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

  function context(): ReplaySessionContext | null {
    // Between triggers the session holds nothing current, so an entry captured now asks for a trigger instead.
    // That includes a live minute that has passed on an idle page before anything ended it.
    if (closed || !session || keeping() || liveEnded() || session.expiresAt <= runtime.now()) return null;
    const value = metadata();
    return value && identityOf(value) === identity ? { sessionId: session.sessionId, token: session.token } : null;
  }

  // Marks on the timeline where the app asked; repeats of one reason within a few seconds share a mark.
  // One made while the next part waits for its full snapshot, such as right after a live minute ended, waits with it.
  function mark(reason: string): void {
    const now = runtime.now();
    const last = marks.get(reason);
    if (last !== undefined && now >= last && now - last < REPLAY_LIMITS.markMs) return;
    if (marks.size >= 50) marks.clear();
    marks.set(reason, now);
    const event: ReplayEvent = { type: 5, timestamp: now, data: { tag: 'pbr/trigger', payload: { reason } } };
    if (!awaitingSnapshot) receive(event);
    else if (heldMarks.length < 20) heldMarks.push(event);
  }

  function trigger(reason?: string): Promise<ReplaySessionContext | null> {
    if (closed) return Promise.resolve(null);
    // Nothing is recorded on this device, so nothing waits to upload.
    if (!captureStop && !captureStarting) return Promise.resolve(null);
    const label = triggerLabel(reason);
    if (mode !== 'trigger') { mark(label); return Promise.resolve(context()); }
    // A trigger made after the account or device changed is theirs: what the device kept for the last one is
    // dropped, and the trigger asks for a session for the new one.
    const value = metadata();
    if (value && identityOf(value) !== identity) adopt(identityOf(value));
    // A session close to its end cannot carry another minute, such as after a long sleep: the live minute
    // ends and the trigger asks for a new session. Otherwise the minute is extended before the mark is
    // recorded, so one that has just passed on an idle page is continued, not ended.
    const usable = !!session && session.expiresAt > runtime.now() + 30000;
    if (live && usable) liveUntil = Math.max(liveUntil, runtime.now() + REPLAY_LIMITS.liveMs);
    else if (live) endLive();
    mark(label);
    if (live) return Promise.resolve(context());
    // Recording the mark ends the session if the account or device changed since the check above.
    if (usable && session) { promote(); return Promise.resolve(context()); }
    if (!triggered) triggered = label;
    const result = new Promise<ReplaySessionContext | null>((resolve) => { waiting.push(resolve); });
    void refresh();
    return result;
  }

  // Only trigger mode listens for uncaught errors, and only while the server asks for it.
  function watchErrors(): void {
    const wanted = !closed && mode === 'trigger' && options.triggerOnError !== false && typeof runtime.subscribeErrors === 'function';
    if (wanted && !removeErrors) {
      try { removeErrors = runtime.subscribeErrors!(() => { void trigger('error'); }); } catch { metrics.errors++; }
    } else if (!wanted && removeErrors) {
      const remove = removeErrors;
      removeErrors = undefined;
      try { remove(); } catch { metrics.errors++; }
    }
  }

  async function refreshOnce(): Promise<void> {
    if (closed) return;
    const value = metadata();
    if (!value) { disable(); return; }
    const nextIdentity = identityOf(value);
    if (identity !== nextIdentity) adopt(nextIdentity);
    if (session && session.expiresAt <= runtime.now() + 30000) {
      // Trigger mode goes on recording on the device, live or not; the next trigger asks for a new session.
      if (mode === 'trigger') { if (live) endLive(); endSession(); } else { disable(); seq = 0; }
    }
    const expectedIdentity = identity;
    try {
      const request = { ...value, features: ['trigger'], ...(apiKey ? { apiKey } : {}) };
      const body = JSON.stringify(request);
      metrics.networkBytes += byteLength(body);
      const config = await options.transport!.post(`${endpoint}/api/replay/config`, body) as Record<string, unknown>;
      if (closed || expectedIdentity !== identity || identityOf(metadata() ?? value) !== expectedIdentity) { refreshAgain = !closed; return; }
      if (config?.enabled !== true) { disable(); return; }
      interval = Math.max(20000, Math.min(30000, Number(config.uploadIntervalMs) || 25000));
      // Back online: a network failure need not wait out its back-off. A 429 or 5xx still does.
      if (retryUnreachable) { retryAt = 0; retryDelay = 0; retryUnreachable = false; }
      const nextMode = config.uploadMode === 'trigger' ? 'trigger' : 'session';
      // Switching between whole sessions and triggers starts over in the new mode.
      if (nextMode !== mode) { disable(); seq = 0; mode = nextMode; }
      watchErrors();
      rememberRules(config);
      // A fresh capture takes a full snapshot under the new rules.
      if (captureStop && rulesKey() !== captureRules) stopCapture();
      if (!active || localBlocked) return;
      if (!session && (mode === 'session' || triggered)) {
        if (!captureOptions()) { metrics.errors++; return; }
        const start = triggered ? JSON.stringify({ ...request, trigger: triggered }) : body;
        metrics.networkBytes += byteLength(start);
        const result = await options.transport!.post(`${endpoint}/api/replay/start`, start) as Record<string, unknown>;
        if (closed || identityOf(metadata() ?? value) !== expectedIdentity) { refreshAgain = !closed; return; }
        if (result?.enabled !== true || typeof result.sessionId !== 'string' || typeof result.token !== 'string') { disable(); return; }
        // Measured on this device's clock, which may be hours off; the server's 410 has the final say.
        const expiresIn = Number(result.expiresIn);
        const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? runtime.now() + expiresIn
          : typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(String(result.expiresAt));
        if (!Number.isFinite(expiresAt)) { disable(); return; }
        session = { sessionId: result.sessionId, token: result.token, expiresAt };
        rememberRules(result);
        metrics.sessionId = session.sessionId;
        seq = 0; retryAt = 0; retryDelay = 0; rejected = 0;
        if (mode === 'trigger') promote();
        room = value.room ?? '';
      } else if (session && triggered && keeping()) promote();
      if (mode === 'trigger' && session && live) settle(context());
      await startCapture();
    } catch (error) {
      metrics.errors++;
      // An unreachable or busy server keeps the session and its queue for the next poll; a waiting trigger tries again then.
      settle(null);
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
  const controller: ReplayController = {
    stop: () => {
      if (closed) return;
      unload(); closed = true; disable();
      runtime.cancel(configTimer); runtime.cancel(flushTimer); runtime.cancel(recoveryTimer); runtime.cancel(snapshotTimer);
      watchErrors();
      try { removeLifecycle?.(); } catch { metrics.errors++; }
    },
    flush,
    refresh,
    trigger,
    getMetrics: () => ({ ...metrics, bufferedBytes: bufferBytes + pendingBytes + keptBytes, queuedBytes: queueBytes }),
    getSessionContext: context,
  };
  automaticErrorTriggers.set(controller, options.triggerOnError !== false);
  return controller;
}
