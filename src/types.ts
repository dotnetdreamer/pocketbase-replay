export interface ReplayMetadata {
  deviceId: string;
  accountId?: string;
  platform: string;
  appVersion: string;
  room?: string;
  authToken?: string;
}

export interface ReplayTransport {
  post: (url: string, body: string) => Promise<unknown>;
  beacon?: (url: string, body: string) => boolean;
}

export interface ReplayOptions {
  endpoint: string;
  metadata: () => ReplayMetadata;
  transport?: ReplayTransport;
  blockSelector?: string;
  maskTextSelector?: string;
  sensitiveText?: () => string[];
  assetBaseUrl?: string;
  initialActive?: boolean;
  subscribeActive?: (listener: (active: boolean) => void) => (() => void);
}

export interface ReplayMetrics {
  startedAt: number;
  recording: boolean;
  sessionId: string | null;
  events: number;
  rawBytes: number;
  compressedBytes: number;
  networkBytes: number;
  uploadedChunks: number;
  droppedChunks: number;
  droppedEvents: number;
  errors: number;
  mainThreadMs: number;
  compressionWallMs: number;
  bufferedBytes: number;
  queuedBytes: number;
}

export interface ReplayController {
  stop: () => void;
  flush: () => Promise<void>;
  refresh: () => Promise<void>;
  getMetrics: () => ReplayMetrics;
}

export interface ReplayEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface ReplayChunk {
  sessionId: string;
  token: string;
  seq: number;
  startedAt: number;
  endedAt: number;
  room: string;
  encoding: 'gzip-base64';
  data: string;
  rawBytes: number;
  eventCount: number;
  hasSnapshot: boolean;
}

export interface RecorderAdapter {
  start: (emit: (event: ReplayEvent) => void, options: ReplayOptions) => (() => void) | undefined;
  snapshot: () => void;
}

export interface ReplayRuntime {
  now: () => number;
  performanceNow: () => number;
  schedule: (callback: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
  loadRecorder: () => Promise<RecorderAdapter>;
  compress: (raw: string) => Promise<Uint8Array>;
  compressSync: (raw: string) => Uint8Array;
  subscribe?: (active: (active: boolean, unloading?: boolean) => void) => (() => void);
  validSelector?: (selector: string) => boolean;
}
