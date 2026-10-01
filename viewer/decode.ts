import { gunzipSync, strFromU8 } from 'fflate';

export interface StoredChunk {
  seq: number; rawBytes: number; data: string; encoding: string;
}
export interface ReplayEvent { type: number; timestamp: number; data: unknown }

export function decodeChunk(chunk: StoredChunk): ReplayEvent[] {
  if (chunk.encoding !== 'gzip-base64' || !Number.isInteger(chunk.rawBytes) ||
      chunk.rawBytes < 2 || chunk.rawBytes > 2 * 1024 * 1024 || chunk.data.length > 700_000) {
    throw new Error('Invalid recording chunk');
  }
  const binary = atob(chunk.data);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length < 18) throw new Error('Incomplete recording chunk');
  const size = new DataView(bytes.buffer).getUint32(bytes.length - 4, true);
  if (size !== chunk.rawBytes) throw new Error('Recording size mismatch');
  const decoded = gunzipSync(bytes, { out: new Uint8Array(chunk.rawBytes) });
  const events: unknown = JSON.parse(strFromU8(decoded));
  if (!Array.isArray(events) || events.length > 50_000 || events.some((event) =>
    !event || !Number.isInteger(event.type) || !Number.isFinite(event.timestamp))) {
    throw new Error('Invalid recording events');
  }
  return events;
}

export function recoverEvents(chunks: StoredChunk[]): { events: ReplayEvent[]; gaps: number } {
  const events: ReplayEvent[] = [];
  let previous = -1;
  let needsSnapshot = true;
  let meta: ReplayEvent | undefined;
  let gaps = 0;
  let rawBytes = 0;
  let broken = false;
  for (const chunk of chunks) {
    if (chunk.seq <= previous) continue;
    let decoded: ReplayEvent[] | undefined;
    try { decoded = decodeChunk(chunk); } catch { /* An unreadable chunk is a gap. */ }
    if (!decoded || chunk.seq !== previous + 1) {
      if (!broken) gaps++;
      needsSnapshot = true;
    }
    broken = !decoded;
    previous = chunk.seq;
    if (!decoded) continue;
    rawBytes += chunk.rawBytes;
    if (rawBytes > 96 * 1024 * 1024) throw new Error('Recording exceeds the playback memory limit');
    for (const event of decoded) {
      if (event.type === 4) meta = event;
      if (needsSnapshot) {
        if (event.type !== 2 || !meta) continue;
        events.push({ ...meta, timestamp: event.timestamp });
        needsSnapshot = false;
      }
      events.push(event);
      if (events.length > 500_000) throw new Error('Recording has too many events to play');
    }
  }
  if (!events.some((event) => event.type === 2)) throw new Error('No complete screen snapshot arrived');
  return { events, gaps };
}

// From..to is the recorded time of the quiet stretch, start..end its place on the shortened timeline.
export interface IdlePeriod { start: number; end: number; from: number; to: number; background: boolean }

export const IDLE_LIMIT_MS = 10_000;
export const IDLE_KEPT_MS = 1_000;

// A phone keeps its session while the app sits in the background, so hours can pass with
// nothing recorded; a seek into them showed a still screen that looked like playback had stopped.
export function shortenIdle(events: ReplayEvent[]): { events: ReplayEvent[]; idle: IdlePeriod[] } {
  const result: ReplayEvent[] = [];
  const idle: IdlePeriod[] = [];
  let previous = events.length ? events[0].timestamp : 0;
  let time = previous;
  for (const event of events) {
    const gap = event.timestamp - previous;
    // Events arrive in the order they happened; a device clock set back only shows as a negative gap.
    if (gap > IDLE_LIMIT_MS) {
      idle.push({ start: time, end: time + IDLE_KEPT_MS, from: previous, to: event.timestamp, background: event.type === 4 });
      time += IDLE_KEPT_MS;
    } else if (gap > 0) {
      time += gap;
    }
    previous = event.timestamp;
    result.push(event.timestamp === time ? event : { ...event, timestamp: time });
  }
  return { events: result, idle };
}

// The device clock time shown for a moment of the shortened timeline.
export function recordedAt(idle: IdlePeriod[], timestamp: number): number {
  let last: IdlePeriod | undefined;
  for (const period of idle) {
    if (period.start > timestamp) break;
    last = period;
  }
  if (!last) return timestamp;
  if (timestamp >= last.end) return last.to + timestamp - last.end;
  return last.from + (timestamp - last.start) * (last.to - last.from) / (last.end - last.start);
}

export function dayBound(date: string, end: boolean): number {
  const time = new Date(`${date}T${end ? '23:59:59.999' : '00:00:00'}`).getTime();
  if (!Number.isFinite(time)) throw new Error('Invalid date');
  return Math.max(0, time);
}
