import type { ExceptionContext, LogLevel, ObservabilityAttributes, ObservabilityMetrics, ObservabilityOptions, ReplayMetrics, ReplayOptions } from 'pocketbase-replay';

export type { ReplayMetadata, ReplayMetrics, ReplayOptions, ReplayTransport } from 'pocketbase-replay';
export type {
  CapturedException, CapturedLog, ErrorTrackingOptions, ExceptionContext, LogCaptureOptions, LogLevel,
  ObservabilityAttributes, ObservabilityEvent, ObservabilityMetrics, ObservabilityOptions,
} from 'pocketbase-replay';

export interface PocketBaseReplayPlugin {
  /**
   * Start recording, with the same options as the client's `startReplay`, and error and log capture when
   * `errors` or `logs` is set.
   *
   * Calling it again stops the running recorder first, so there is never more than one. Capture is only
   * replaced by a call that sets `errors` or `logs`.
   */
  start(options: StartOptions): Promise<void>;

  /**
   * Stop recording and error and log capture, and release both.
   *
   * Android and iOS have no beacon at exit, so events not yet uploaded there are dropped; call `flush()` first to send them.
   */
  stop(): Promise<void>;

  /**
   * Upload buffered events now instead of at the next interval.
   */
  flush(): Promise<void>;

  /**
   * Re-read `metadata()` and the server's settings, for example after sign-in, sign-out or a room change.
   */
  refresh(): Promise<void>;

  /**
   * Counters for the running recorder, or `null` when it is not started.
   */
  getMetrics(): Promise<GetMetricsResult>;

  /**
   * Mark this moment, such as a bug report. When the server records only when something breaks, upload what
   * the device kept and keep recording for a minute. Resolves with the recording's ID, or `null` when nothing
   * is recorded or its session could not start yet.
   */
  trigger(options?: TriggerOptions): Promise<TriggerResult>;

  /** Start JavaScript error and log capture independently of recording. A later replay-only `start` leaves it running. */
  startObservability(options: ObservabilityOptions): Promise<void>;
  /** Stop error and log capture and release its listeners. */
  stopObservability(): Promise<void>;
  captureException(options: CaptureExceptionOptions): Promise<CaptureResult>;
  captureLog(options: CaptureLogOptions): Promise<CaptureResult>;
  getObservabilityMetrics(): Promise<GetObservabilityMetricsResult>;
}

export type StartOptions = ReplayOptions & Pick<ObservabilityOptions, 'errors' | 'logs' | 'service' | 'beforeSend'> & {
  /** Record masked screenshots of the native WebView instead of its DOM. Android/iOS only. Default: false. */
  screenshotMode?: boolean;
  /** Screenshot sizing, interval and additional image masking. Used only when screenshotMode is true. */
  screenshotOptions?: ScreenshotOptions;
};

export interface ScreenshotOptions {
  /** Delay between periodic screenshots in milliseconds, clamped to 500–60000. Requested full snapshots may occur sooner. Default: 1000. */
  intervalMs?: number;
  /** Longest PNG edge in pixels, clamped to 256–1280; large frames may be reduced further. Default: 1280. */
  maxDimension?: number;
  /** Mask images as well as private inputs/text. Server image blocking still applies. Default: true. */
  maskAllImages?: boolean;
}
export interface CaptureExceptionOptions extends ExceptionContext { error: unknown }
export interface CaptureLogOptions { level: LogLevel; message: string; attributes?: ObservabilityAttributes }
export interface CaptureResult { id: string | null }
export interface TriggerOptions { reason?: string }
export interface TriggerResult { sessionId: string | null }
export interface GetObservabilityMetricsResult { metrics: ObservabilityMetrics | null }

export interface GetMetricsResult {
  metrics: ReplayMetrics | null;
}
