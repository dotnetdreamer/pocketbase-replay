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

// The app's PocketBase JS SDK client, such as `new PocketBase(url)`.
export interface PocketBaseClient {
  send(path: string, options?: any): Promise<any>;
  baseURL?: string;
  baseUrl?: string;
}

export interface ReplayOptions {
  endpoint: string;
  apiKey?: string;
  metadata: () => ReplayMetadata;
  transport?: ReplayTransport;
  blockSelector?: string;
  maskTextSelector?: string;
  sensitiveText?: () => string[];
  preserveDataAttributes?: Record<string, readonly string[]>;
  assetBaseUrl?: string;
  initialActive?: boolean;
  subscribeActive?: (listener: (active: boolean) => void) => (() => void);
  // Automatically upload a trigger-mode recording for captured errors. Explicit trigger() still works.
  triggerOnError?: boolean;
  // While recording, and while the server records PocketBase calls, each call this client sends is noted with its
  // collection, action, status and counts, never the values sent or returned.
  pocketbase?: PocketBaseClient;
  // Platform plugins can supply a recorder for their rendered surface instead of the browser DOM.
  recorder?: RecorderAdapter;
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
  getSessionContext: () => ReplaySessionContext | null;
  trigger: (reason?: string) => Promise<ReplaySessionContext | null>;
}

export interface ReplaySessionContext { sessionId: string; token: string }

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
  apiKey?: string;
}

// Server-controlled extras for the recorder; never set by the host app.
export interface RecorderOptions extends ReplayOptions {
  recordImages?: boolean;
  recordNetwork?: boolean;
  recordConsole?: boolean;
  recordPocketbase?: boolean;
  tracePocketbaseRequests?: boolean;
  // The live recording's session ID, which a PocketBase call carries to the replay server, or null between triggers.
  replaySession?: () => string | null;
}

export interface RecorderAdapter {
  // Image snapshots contain already-masked, bounded PNGs supplied by a platform recorder.
  imageSnapshots?: boolean;
  start: (emit: (event: ReplayEvent) => void, options: RecorderOptions) => (() => void) | undefined;
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
  subscribeErrors?: (listener: () => void) => (() => void);
}
