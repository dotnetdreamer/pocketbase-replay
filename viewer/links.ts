// The dashboard's address names what it shows, so a reload, a bookmark or a link from an AI agent opens it again:
// #session=<id>&at=<ms>, #issue=<id>&occurrence=<id>, #log=<id>, or #issues and #logs for a tab with nothing open.
// The Sessions tab with nothing open has no hash.

export type DashboardTab = 'sessions' | 'issues' | 'logs';

export type DashboardLink =
  | { kind: 'session'; id: string; at?: number }
  | { kind: 'issue'; id: string; occurrence?: string }
  | { kind: 'log'; id: string }
  | { kind: 'tab'; tab: DashboardTab };

export function parseDashboardLink(hash: string): DashboardLink | undefined {
  const values = new URLSearchParams(hash.replace(/^#/, ''));
  const id = (name: string) => { const value = values.get(name) ?? ''; return /^[a-z0-9]{15}$/.test(value) ? value : ''; };
  if (id('session')) {
    const at = Number(values.get('at'));
    return Number.isSafeInteger(at) && at > 0 ? { kind: 'session', id: id('session'), at } : { kind: 'session', id: id('session') };
  }
  if (id('issue')) return id('occurrence') ? { kind: 'issue', id: id('issue'), occurrence: id('occurrence') } : { kind: 'issue', id: id('issue') };
  if (id('log')) return { kind: 'log', id: id('log') };
  for (const tab of ['sessions', 'issues', 'logs'] as const) if (values.has(tab)) return { kind: 'tab', tab };
  return undefined;
}

export function dashboardHash(link: DashboardLink): string {
  if (link.kind === 'session') return `#session=${link.id}${link.at ? `&at=${Math.round(link.at)}` : ''}`;
  if (link.kind === 'issue') return `#issue=${link.id}${link.occurrence ? `&occurrence=${link.occurrence}` : ''}`;
  if (link.kind === 'log') return `#log=${link.id}`;
  return link.tab === 'sessions' ? '' : `#${link.tab}`;
}

// Where a record sorts in its list: the list's sort value, then its ID, which breaks ties as on the server.
export type ListPosition = [value: number, id: string];

export function newerThan(record: ListPosition, other: ListPosition): boolean {
  return record[0] > other[0] || (record[0] === other[0] && record[1] > other[1]);
}

export interface PagedList { has(id: string): boolean; more(): boolean; next(): Promise<void> }

// Loads up to `pages` more pages until the list holds the record: true when it does, false when it does not, and
// undefined once `current` says the answer is no longer wanted.
export async function findInList(list: PagedList, id: string, pages: number, current: () => boolean): Promise<boolean | undefined> {
  for (let loaded = 0; !list.has(id) && list.more() && loaded < pages; loaded++) {
    await list.next();
    if (!current()) return undefined;
  }
  return list.has(id);
}
