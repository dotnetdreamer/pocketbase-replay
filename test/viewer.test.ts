import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, strToU8 } from 'fflate';
import { dayBound, decodeChunk, recordedAt, recoverEvents, shortenIdle } from '../viewer/decode';
import { keepPlaying } from '../viewer/player';

const meta = { type: 4, timestamp: 100, data: { width: 390, height: 844, href: 'https://example.test' } };
const snapshot = { type: 2, timestamp: 101, data: { node: { type: 0, id: 1, childNodes: [] } } };
const delta = { type: 3, timestamp: 102, data: { source: 2, type: 2, id: 1, x: 5, y: 6 } };
function chunk(seq: number, events: unknown[]) {
  const raw = strToU8(JSON.stringify(events));
  return { seq, encoding: 'gzip-base64', rawBytes: raw.length, data: Buffer.from(gzipSync(raw)).toString('base64') };
}
function bad(seq: number) {
  const item = chunk(seq, [delta]);
  return { ...item, rawBytes: item.rawBytes + 1 };
}

test('plays intact snapshots and taps', () => {
  const result = recoverEvents([chunk(0, [meta, snapshot]), chunk(1, [delta])]);
  assert.equal(result.gaps, 0);
  assert.deepEqual(result.events.map((event) => event.type), [4, 2, 3]);
});

test('skips dependent events after a missing chunk until a new snapshot', () => {
  const result = recoverEvents([chunk(0, [meta, snapshot]), chunk(2, [delta]), chunk(3, [meta, snapshot, delta])]);
  assert.equal(result.gaps, 1);
  assert.deepEqual(result.events.map((event) => event.type), [4, 2, 4, 2, 3]);
});

test('keeps the first copy of a repeated seq without counting a gap', () => {
  const first = chunk(1, [delta]);
  const result = recoverEvents([chunk(0, [meta, snapshot]), first, { ...first, data: bad(1).data }, chunk(2, [delta])]);
  assert.equal(result.gaps, 0);
  assert.deepEqual(result.events.map((event) => event.type), [4, 2, 3, 3]);
});

test('treats an unreadable chunk as a gap and resumes at the next snapshot', () => {
  const result = recoverEvents([chunk(0, [meta, snapshot]), bad(1), chunk(2, [delta]), chunk(3, [meta, snapshot, delta])]);
  assert.equal(result.gaps, 1);
  assert.deepEqual(result.events.map((event) => event.type), [4, 2, 4, 2, 3]);
  const invalid = recoverEvents([chunk(0, [meta, snapshot]), chunk(1, [{ type: 'x' }]), chunk(2, [meta, snapshot])]);
  assert.equal(invalid.gaps, 1);
  assert.deepEqual(invalid.events.map((event) => event.type), [4, 2, 4, 2]);
});

test('counts adjacent unreadable and missing chunks as one gap', () => {
  const joined = recoverEvents([chunk(0, [meta, snapshot]), bad(1), bad(2), chunk(4, [meta, snapshot])]);
  assert.equal(joined.gaps, 1);
  const apart = recoverEvents([chunk(0, [meta, snapshot]), bad(1), chunk(2, [meta, snapshot]), bad(3)]);
  assert.equal(apart.gaps, 2);
  assert.deepEqual(apart.events.map((event) => event.type), [4, 2, 4, 2]);
});

test('refuses oversized declarations and gzip size mismatch before allocation', () => {
  const item = chunk(0, [meta, snapshot]);
  assert.throws(() => decodeChunk({ ...item, rawBytes: 3 * 1024 * 1024 }));
  assert.throws(() => decodeChunk({ ...item, rawBytes: item.rawBytes + 1 }));
  assert.throws(() => recoverEvents([chunk(0, [delta])]));
  assert.throws(() => recoverEvents([bad(0)]));
});

test('turns filter dates into local day bounds', () => {
  assert.equal(dayBound('2026-09-27', false), new Date(2026, 8, 27).getTime());
  assert.equal(dayBound('2026-09-27', true), new Date(2026, 8, 27, 23, 59, 59, 999).getTime());
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Karachi';
    assert.equal(new Date(dayBound('2026-09-27', false)).toISOString(), '2026-09-26T19:00:00.000Z');
    assert.equal(new Date(dayBound('2026-09-27', true)).toISOString(), '2026-09-27T18:59:59.999Z');
    process.env.TZ = 'America/New_York';
    assert.equal(new Date(dayBound('2026-09-27', false)).toISOString(), '2026-09-27T04:00:00.000Z');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
  assert.equal(dayBound('1969-12-31', false), 0);
  assert.throws(() => dayBound('not a date', false));
});

const at = (type: number, timestamp: number) => ({ type, timestamp, data: {} });

test('shortens stretches with nothing recorded and keeps the rest of the timing', () => {
  const minute = 60_000;
  const { events, idle } = shortenIdle([at(4, 0), at(2, 0), at(3, 4000), at(3, 9000), at(4, 9000 + 40 * minute), at(2, 9000 + 40 * minute), at(3, 9500 + 40 * minute), at(3, 25_000 + 40 * minute)]);
  assert.deepEqual(events.map((event) => event.timestamp), [0, 0, 4000, 9000, 10_000, 10_000, 10_500, 11_500]);
  assert.deepEqual(idle, [
    { start: 9000, end: 10_000, from: 9000, to: 9000 + 40 * minute, background: true },
    { start: 10_500, end: 11_500, from: 9500 + 40 * minute, to: 25_000 + 40 * minute, background: false },
  ]);
  assert.equal(recordedAt(idle, 4000), 4000);
  assert.equal(recordedAt(idle, 10_200), 9000 + 40 * minute + 200);
  assert.equal(recordedAt(idle, 11_500), 25_000 + 40 * minute);
  assert.equal(recordedAt(idle, 9500), 9000 + 20 * minute);
});

test('keeps event order when the device clock is set back', () => {
  const { events, idle } = shortenIdle([at(4, 50_000), at(2, 50_000), at(3, 51_000), at(3, 20_000), at(3, 21_000)]);
  assert.deepEqual(events.map((event) => event.timestamp), [50_000, 50_000, 51_000, 51_000, 52_000]);
  assert.equal(idle.length, 0);
  assert.deepEqual(shortenIdle([]), { events: [], idle: [] });
});

test('keeps playing after an event throws in the frame loop', () => {
  const played: number[] = [];
  const timer = {
    actions: [
      { delay: 0, doAction: () => played.push(1) },
      { delay: 0, doAction: () => { throw new TypeError('querySelectorAll is not a function'); } },
      { delay: 0, doAction: () => played.push(3) },
    ],
    raf: 1 as number | true | null, timeOffset: 0, lastTimestamp: performance.now(), speed: 1,
    rafCheck: () => { throw new Error('unguarded'); },
  };
  const errors: unknown[] = [];
  keepPlaying({ timer }, (error) => errors.push(error));
  timer.rafCheck();
  assert.deepEqual(played, [1, 3]);
  assert.equal(errors.length, 1);
  assert.equal(timer.raf, true);
});

test('finishes a seek when an earlier event or the flush throws', () => {
  const errors: unknown[] = [];
  const flushed: string[] = [];
  const replayer = {
    getCastFn: (event: { bad?: boolean }) => () => { if (event.bad) throw new Error('bad mutation'); flushed.push('cast'); },
    emitter: { all: new Map([['flush', [() => { throw new Error('bad style rule'); }, () => flushed.push('flush')]]]) },
    applyIncremental() { throw new Error('dead node'); },
  };
  keepPlaying(replayer, (error) => errors.push(error));
  replayer.getCastFn({ bad: true })();
  replayer.getCastFn({})();
  for (const handler of replayer.emitter.all.get('flush')!) handler(undefined);
  assert.equal(replayer.applyIncremental(), undefined);
  assert.deepEqual(flushed, ['cast', 'flush']);
  assert.equal(errors.length, 3);
});

test('never keeps a text node as the hover root', () => {
  const removed: string[] = [];
  const document = { nodeType: 9, querySelectorAll: () => [{ classList: { remove: (name: string) => removed.push(name) } }] };
  const replayer: Record<string, any> = { iframe: { contentDocument: document }, hoverElements() { throw new Error('unpatched'); } };
  keepPlaying(replayer, () => assert.fail('no error expected'));
  const detached: any = { nodeType: 3, parentElement: null };
  detached.getRootNode = () => detached;
  replayer.hoverElements(detached);
  assert.equal(replayer.lastHoveredRootNode, undefined);
  const added: string[] = [];
  const parent = { nodeType: 1, parentElement: null, classList: { add: (name: string) => added.push(name) }, getRootNode: () => document };
  replayer.hoverElements({ nodeType: 3, parentElement: parent, getRootNode: () => document });
  assert.equal(replayer.lastHoveredRootNode, document);
  assert.deepEqual(added, [':hover']);
  assert.deepEqual(removed, [':hover', ':hover']);
});
