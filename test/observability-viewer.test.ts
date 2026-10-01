import test from 'node:test';
import assert from 'node:assert/strict';
import { shortenIdle, type ReplayEvent } from '../viewer/decode';
import { bucketLabel, PagedRecords, replayOffset, telemetryQuery, volumeColumns, volumeScale } from '../viewer/observability';

test('error and log filters preserve literal search text and use local day bounds', () => {
  const query = telemetryQuery({ q: ' a" || level="fatal ', service: ' api ', accountId: ' user ', deviceId: '', sessionId: ' session-1 ', from: '2026-10-01', to: '2026-10-02' });
  assert.equal(query.get('q'), 'a" || level="fatal');
  assert.equal(query.get('service'), 'api');
  assert.equal(query.get('accountId'), 'user');
  assert.equal(query.get('sessionId'), 'session-1');
  assert.equal(query.has('deviceId'), false);
  assert.equal(Number(query.get('from')), new Date(2026, 9, 1).getTime());
  assert.equal(Number(query.get('to')), new Date(2026, 9, 2, 23, 59, 59, 999).getTime());
  assert.throws(() => telemetryQuery({ from: '2026-10-02', to: '2026-10-01' }), /Through date/);
  assert.throws(() => telemetryQuery({ from: 'invalid' }), /Invalid date/);
});

test('late pages from an older search cannot replace current results or loading state', () => {
  const records = new PagedRecords<{ id: string; message: string }>();
  const oldGeneration = records.begin()!;
  assert.equal(records.begin(), undefined);
  records.reset(new URLSearchParams('service=mobile'));
  const generation = records.begin()!;
  assert.equal(records.accept({ page: 1, totalPages: 1, totalItems: 1, items: [{ id: 'old', message: 'Old search' }] }, oldGeneration), false);
  records.finish(oldGeneration);
  assert.equal(records.loading, true);
  assert.equal(records.items.size, 0);
  assert.equal(records.accept({ page: 1, totalPages: 2, totalItems: 2, items: [{ id: 'new', message: 'New search' }] }, generation), true);
  records.finish(generation);
  assert.equal(records.loading, false);
  assert.equal(records.query.get('service'), 'mobile');
  assert.equal(records.more, true);
  assert.deepEqual(Array.from(records.items.keys()), ['new']);
});

test('pagination updates repeated records without rendering duplicate rows', () => {
  const records = new PagedRecords<{ id: string; status: string }>();
  let generation = records.begin()!;
  records.accept({ page: 1, totalPages: 2, totalItems: 2, items: [{ id: 'issue-1', status: 'open' }] }, generation);
  records.finish(generation);
  generation = records.begin()!;
  records.accept({ page: 2, totalPages: 2, totalItems: 2, items: [{ id: 'issue-1', status: 'resolved' }, { id: 'issue-2', status: 'open' }] }, generation);
  records.finish(generation);
  assert.equal(records.items.size, 2);
  assert.equal(records.items.get('issue-1')?.status, 'resolved');
  assert.equal(records.page, 2);
  assert.equal(records.more, false);
  assert.equal(records.begin(), undefined);
});

test('an occurrence opens at its event time after shortened background gaps', () => {
  const at = (timestamp: number): ReplayEvent => ({ timestamp, type: 3, data: {} });
  const original = [at(1_000_000), at(1_004_000), at(3_404_000), at(3_405_000)];
  const shortened = shortenIdle(original).events;
  assert.equal(replayOffset(original, shortened, 1_002_000), 2_000);
  assert.equal(replayOffset(original, shortened, 2_204_000), 4_500);
  assert.equal(replayOffset(original, shortened, 3_404_000), 5_000);
  assert.equal(replayOffset(original, shortened, 3_404_500), 5_500);
  assert.equal(replayOffset(original, shortened, 0), 0);
  assert.equal(replayOffset(original, shortened, 9_000_000), 6_000);
  assert.equal(replayOffset(original, shortened, NaN), 0);
  assert.equal(replayOffset([], [], 1), 0);
});

test('refreshes the newest alerts without losing pagination through older alerts', () => {
  const records = new PagedRecords<{ id: string }>();
  records.accept({ page: 3, totalPages: 3, totalItems: 120, items: [{ id: 'older' }] }, records.generation);
  const generation = records.begin(true)!;
  assert.equal(records.begin(true), undefined);
  records.accept({ page: 1, totalPages: 4, totalItems: 151, items: [{ id: 'newest' }] }, generation, true);
  records.finish(generation);
  assert.equal(records.page, 3);
  assert.equal(records.more, true);
  assert.deepEqual(Array.from(records.items.keys()), ['older', 'newest']);
});

test('log volume folds six levels into four stacked groups with errors on the baseline', () => {
  const columns = volumeColumns({ from: 0, to: 599_999, bucketMs: 300_000, total: 9, buckets: [
    { start: 0, counts: { fatal: 1, error: 2, warn: 1, info: 3, trace: 1 } },
    { start: 300_000, counts: { debug: 1 } },
  ] });
  assert.deepEqual(columns.map((column) => column.groups), [[3, 1, 3, 1], [0, 0, 0, 1]]);
  assert.deepEqual(columns.map((column) => column.total), [8, 1]);
  assert.deepEqual(columns.map((column) => [column.start, column.end]), [[0, 299_999], [300_000, 599_999]]);
  assert.deepEqual([0, 1, 7, 8, 10, 11, 160, 999, 1001].map(volumeScale), [1, 1, 10, 10, 10, 20, 200, 1000, 2000]);
  assert.deepEqual([60_000, 300_000, 3_600_000, 10_800_000, 86_400_000, 604_800_000].map(bucketLabel),
    ['1-minute', '5-minute', '1-hour', '3-hour', '1-day', '7-day']);
});
