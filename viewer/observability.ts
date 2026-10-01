import { dayBound, type ReplayEvent } from './decode';

export type IssueStatus = 'open' | 'resolved' | 'ignored';
export interface Issue {
  id: string; title: string; name: string; message: string; status: IssueStatus;
  occurrenceCount: number; firstSeen: number; lastSeen: number; resolvedAt?: number; level: string; service: string;
}
export interface LogEntry {
  id: string; timestamp: number; level: string; service: string; message: string;
  accountId: string; deviceId: string; sessionId: string; appVersion: string; platform: string; room: string;
  attributes: Record<string, unknown>;
  replayAvailable?: boolean;
}
export interface ErrorOccurrence extends LogEntry { name: string; stack: string; handled: boolean }
export interface IssueAlert {
  id: string; issueId: string; title: string; kind: 'created' | 'regressed'; timestamp: number; acknowledged: boolean;
  delivery?: 'none' | 'pending' | 'sent' | 'failed';
}
export const OBSERVABILITY_RATE_DEFAULTS = {
  sessions_per_device_hour: 30, sessions_per_ip_hour: 120, sessions_per_hour: 20000,
  config_requests_per_ip_minute: 120, upload_requests_per_ip_minute: 120, upload_mb_per_ip_hour: 8,
} as const;
export interface ObservabilitySettings extends Record<keyof typeof OBSERVABILITY_RATE_DEFAULTS, number> {
  errors_enabled: boolean; logs_enabled: boolean; alerts_enabled: boolean;
  errors_retention_days: number; logs_retention_days: number; daily_limit_mb: number; alert_webhook_url?: string;
}
export interface LogVolume {
  from: number; to: number; bucketMs: number; total: number;
  buckets: { start: number; counts: Partial<Record<string, number>> }[];
}
export class LogVolumeRequest {
  value: LogVolume | undefined;
  loading = false;
  failed = false;
  private generation = 0;

  reset(): void {
    this.generation++;
    this.value = undefined;
    this.loading = false;
    this.failed = false;
  }

  async load(query: URLSearchParams, request: (query: URLSearchParams) => Promise<LogVolume>, changed: () => void): Promise<void> {
    this.reset();
    const generation = this.generation;
    this.loading = true;
    changed();
    try {
      const result = await request(new URLSearchParams(query));
      if (generation === this.generation) this.value = result;
    } catch {
      if (generation === this.generation) this.failed = true;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        changed();
      }
    }
  }
}
export interface VolumeColumn { start: number; end: number; total: number; groups: number[]; counts: Partial<Record<string, number>> }

// Stacked from the baseline up. Errors sit on the baseline, the one segment every column measures from the same line.
export const VOLUME_GROUPS = [
  { key: 'errors', label: 'Errors and fatal', levels: ['fatal', 'error'] },
  { key: 'warnings', label: 'Warnings', levels: ['warn'] },
  { key: 'info', label: 'Info', levels: ['info'] },
  { key: 'debug', label: 'Debug and trace', levels: ['debug', 'trace'] },
] as const;

export function volumeColumns(volume: LogVolume): VolumeColumn[] {
  return volume.buckets.map((bucket) => {
    const groups = VOLUME_GROUPS.map((group) => group.levels.reduce((sum, level) => sum + (bucket.counts[level] ?? 0), 0));
    return { start: bucket.start, end: Math.min(volume.to, bucket.start + volume.bucketMs - 1), total: groups.reduce((sum, value) => sum + value, 0), groups, counts: bucket.counts };
  });
}

// The axis top, rounded up to 1, 2 or 5 times a power of ten.
export function volumeScale(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5]) if (step * power >= value) return step * power;
  return 10 * power;
}

export function bucketLabel(ms: number): string {
  if (ms % 86400000 === 0) return ms === 86400000 ? '1-day' : `${ms / 86400000}-day`;
  if (ms % 3600000 === 0) return ms === 3600000 ? '1-hour' : `${ms / 3600000}-hour`;
  return `${ms / 60000}-minute`;
}
export interface PageResult<T> { items: T[]; page: number; totalPages: number; totalItems: number }

export function telemetryQuery(values: Record<string, string>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(values)) {
    const value = raw.trim();
    if (value) query.set(key, key === 'from' || key === 'to' ? String(dayBound(value, key === 'to')) : value);
  }
  if (query.has('from') && query.has('to') && Number(query.get('from')) > Number(query.get('to'))) {
    throw new Error('Choose a Through date on or after the From date');
  }
  return query;
}

// Match the event's clock time to the shortened replay timeline.
export function replayOffset(original: ReplayEvent[], shortened: ReplayEvent[], timestamp: number): number {
  if (!original.length || original.length !== shortened.length || !Number.isFinite(timestamp)) return 0;
  const start = shortened[0].timestamp;
  if (timestamp <= original[0].timestamp) return 0;
  for (let index = 1; index < original.length; index++) {
    const before = original[index - 1].timestamp;
    const after = original[index].timestamp;
    if (after > before && timestamp >= before && timestamp <= after) {
      const position = shortened[index - 1].timestamp +
        (timestamp - before) / (after - before) * (shortened[index].timestamp - shortened[index - 1].timestamp);
      return Math.max(0, position - start);
    }
  }
  return Math.max(0, shortened[shortened.length - 1].timestamp - start);
}

export class PagedRecords<T extends { id: string }> {
  generation = 0;
  page = 0;
  totalPages = 1;
  totalItems = 0;
  query = new URLSearchParams();
  readonly items = new Map<string, T>();
  private loadingGeneration = -1;

  get loading(): boolean { return this.loadingGeneration === this.generation; }
  get more(): boolean { return this.page < this.totalPages; }

  reset(query = this.query): void {
    this.generation++;
    this.query = query;
    this.page = 0;
    this.totalPages = 1;
    this.totalItems = 0;
    this.items.clear();
  }

  begin(refresh = false): number | undefined {
    if (this.loading || (!refresh && !this.more)) return;
    this.loadingGeneration = this.generation;
    return this.generation;
  }

  accept(result: PageResult<T>, generation: number, keepPage = false): boolean {
    if (generation !== this.generation) return false;
    this.page = keepPage ? Math.max(this.page, result.page) : result.page;
    this.totalPages = Math.max(1, result.totalPages);
    this.totalItems = result.totalItems;
    for (const item of result.items) this.items.set(item.id, item);
    return true;
  }

  finish(generation: number): void {
    if (this.loadingGeneration === generation) this.loadingGeneration = -1;
  }
}
