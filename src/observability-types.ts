import type { ReplayController, ReplayMetadata, ReplaySessionContext, ReplayTransport } from './types';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type ObservabilityAttributes = Record<string, unknown>;

export interface ErrorTrackingOptions { captureUnhandled?: boolean }
export interface LogCaptureOptions { captureConsole?: boolean | LogLevel[] }
export interface ExceptionContext {
  attributes?: ObservabilityAttributes;
  groupingKey?: string;
  handled?: boolean;
  level?: 'error' | 'fatal';
}

interface EventContext {
  id: string;
  timestamp: number;
  service?: string;
  room?: string;
  sessionId?: string;
  sessionToken?: string;
  message: string;
  attributes?: ObservabilityAttributes;
}

export interface CapturedException extends EventContext {
  kind: 'error';
  name: string;
  stack?: string;
  handled: boolean;
  level: 'error' | 'fatal';
}
export interface CapturedLog extends EventContext { kind: 'log'; level: LogLevel }
export type ObservabilityEvent = CapturedException | CapturedLog;

export interface ObservabilityOptions {
  endpoint: string;
  metadata: () => ReplayMetadata;
  errors?: boolean | ErrorTrackingOptions;
  logs?: boolean | LogCaptureOptions;
  service?: string;
  replay?: Pick<ReplayController, 'getSessionContext'>;
  session?: () => ReplaySessionContext | null;
  sensitiveText?: () => string[];
  beforeSend?: (event: ObservabilityEvent) => ObservabilityEvent | null;
  transport?: ReplayTransport;
  subscribeActive?: (listener: (active: boolean) => void) => (() => void);
}

export interface ObservabilityMetrics {
  errorsEnabled: boolean;
  logsEnabled: boolean;
  capturedErrors: number;
  capturedLogs: number;
  uploadedEvents: number;
  droppedEvents: number;
  queuedEvents: number;
  queuedBytes: number;
  networkErrors: number;
}

export interface ObservabilityController {
  captureException: (error: unknown, context?: ExceptionContext) => string | null;
  captureLog: (level: LogLevel, message: string, attributes?: ObservabilityAttributes) => string | null;
  flush: () => Promise<void>;
  refresh: () => Promise<void>;
  stop: () => void;
  getMetrics: () => ObservabilityMetrics;
}

export type AutomaticCapture = { kind: 'error'; error: unknown; context?: ExceptionContext }
  | { kind: 'log'; level: LogLevel; arguments: unknown[] };

export interface ObservabilityStorage {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

export interface ObservabilityRuntime {
  now: () => number;
  schedule: (callback: () => void, ms: number) => unknown;
  cancel: (timer: unknown) => void;
  storage?: ObservabilityStorage;
  subscribe?: (listener: (active: boolean, unloading?: boolean) => void) => (() => void);
  subscribeCapture?: (listener: (capture: AutomaticCapture) => void, options: ObservabilityOptions) => (() => void);
}
