import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, strToU8 } from 'fflate';
import { dayBound, decodeChunk, recoverEvents } from '../viewer/decode';

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
