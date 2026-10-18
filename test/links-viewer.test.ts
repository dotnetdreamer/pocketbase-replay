import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboardHash, findInList, newerThan, parseDashboardLink, type DashboardLink } from '../viewer/links';
import { PagedRecords } from '../viewer/observability';

test('links from agents open a recording at a moment, an issue or a log, and nothing else', () => {
  assert.deepEqual(parseDashboardLink('#session=abcdefghij01234&at=1760605923000'), { kind: 'session', id: 'abcdefghij01234', at: 1760605923000 });
  assert.deepEqual(parseDashboardLink('#session=abcdefghij01234'), { kind: 'session', id: 'abcdefghij01234' });
  assert.deepEqual(parseDashboardLink('#session=abcdefghij01234&at=soon'), { kind: 'session', id: 'abcdefghij01234' });
  assert.deepEqual(parseDashboardLink('#issue=abcdefghij01234'), { kind: 'issue', id: 'abcdefghij01234' });
  assert.deepEqual(parseDashboardLink('log=abcdefghij01234'), { kind: 'log', id: 'abcdefghij01234' });
  for (const hash of ['', '#', '#session=ABC', '#issue=abcdefghij0123', '#issue=../../x', '#other=abcdefghij01234']) assert.equal(parseDashboardLink(hash), undefined, hash);
});

test('the address the dashboard writes opens the same record, occurrence or tab again', () => {
  const links: [DashboardLink, string][] = [
    [{ kind: 'session', id: 'abcdefghij01234', at: 1760605923000 }, '#session=abcdefghij01234&at=1760605923000'],
    [{ kind: 'session', id: 'abcdefghij01234' }, '#session=abcdefghij01234'],
    [{ kind: 'issue', id: 'abcdefghij01234', occurrence: 'zyxwvutsrq98765' }, '#issue=abcdefghij01234&occurrence=zyxwvutsrq98765'],
    [{ kind: 'issue', id: 'abcdefghij01234' }, '#issue=abcdefghij01234'],
    [{ kind: 'log', id: 'abcdefghij01234' }, '#log=abcdefghij01234'],
    [{ kind: 'tab', tab: 'issues' }, '#issues'],
    [{ kind: 'tab', tab: 'logs' }, '#logs'],
  ];
  for (const [link, hash] of links) {
    assert.equal(dashboardHash(link), hash);
    assert.deepEqual(parseDashboardLink(hash), link, hash);
  }
  // The Sessions tab with nothing open keeps the plain address; a #sessions link reaches it too.
  assert.equal(dashboardHash({ kind: 'tab', tab: 'sessions' }), '');
  assert.deepEqual(parseDashboardLink('#sessions'), { kind: 'tab', tab: 'sessions' });
  // An empty occurrence or moment is left out, and a moment is written in whole milliseconds.
  assert.equal(dashboardHash({ kind: 'issue', id: 'abcdefghij01234', occurrence: '' }), '#issue=abcdefghij01234');
  assert.equal(dashboardHash({ kind: 'session', id: 'abcdefghij01234', at: 1760605923000.4 }), '#session=abcdefghij01234&at=1760605923000');
  // A record outranks a tab, and an unreadable occurrence still opens its issue.
  assert.deepEqual(parseDashboardLink('#issues&log=abcdefghij01234'), { kind: 'log', id: 'abcdefghij01234' });
  assert.deepEqual(parseDashboardLink('#issue=abcdefghij01234&occurrence=../x'), { kind: 'issue', id: 'abcdefghij01234' });
});

test('records sort newest first, with the ID breaking ties as on the server', () => {
  assert.equal(newerThan([2, 'a'], [1, 'z']), true);
  assert.equal(newerThan([1, 'z'], [2, 'a']), false);
  assert.equal(newerThan([1, 'b'], [1, 'a']), true);
  assert.equal(newerThan([1, 'a'], [1, 'a']), false);
});

// A list of `total` records, ids r0, r1, ..., served `size` to a page.
function pagedList(total: number, size: number) {
  const ids: string[] = [];
  let pages = 0;
  return {
    get pages() { return pages; },
    has: (id: string) => ids.includes(id),
    more: () => ids.length < total,
    next: async () => {
      pages++;
      const end = Math.min(total, ids.length + size);
      for (let index = ids.length; index < end; index++) ids.push(`r${index}`);
    },
  };
}

test('a linked record further down a list is loaded into it, within a page limit', async () => {
  const shown = pagedList(100, 10);
  assert.equal(await findInList(shown, 'r34', 5, () => true), true);
  assert.equal(shown.pages, 4);
  const far = pagedList(100, 10);
  assert.equal(await findInList(far, 'r75', 5, () => true), false);
  assert.equal(far.pages, 5);
  assert.equal(far.more(), true);
  // A record the list cannot hold stops at its end.
  const missing = pagedList(25, 10);
  assert.equal(await findInList(missing, 'other', 5, () => true), false);
  assert.equal(missing.pages, 3);
  // A record the list already holds needs no page.
  assert.equal(await findInList(missing, 'r3', 5, () => true), true);
  assert.equal(missing.pages, 3);
  // Opening something else, or a new search, ends the search.
  let current = true;
  const replaced = pagedList(100, 10);
  const searching = findInList({ ...replaced, next: async () => { await replaced.next(); current = false; } }, 'r50', 5, () => current);
  assert.equal(await searching, undefined);
  assert.equal(replaced.pages, 1);
});

test('a page search waits for the page already loading instead of asking for it again', async () => {
  const records = new PagedRecords<{ id: string }>();
  assert.equal(records.loading, false);
  await records.settled();
  const generation = records.begin()!;
  let settled = false;
  const waiting = records.settled().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  records.accept({ page: 1, totalPages: 2, totalItems: 2, items: [{ id: 'first' }] }, generation);
  records.finish(generation);
  await waiting;
  assert.equal(settled, true);
  // A page still loading for an older search releases whoever waits once the new search loads its own.
  const old = records.begin()!;
  const released = records.settled();
  records.reset(new URLSearchParams('q=new'));
  assert.equal(records.loading, false);
  const current = records.begin()!;
  await released;
  records.finish(old);
  assert.equal(records.loading, true);
  records.finish(current);
  assert.equal(records.loading, false);
});
