import type { ReplayMetrics, ReplayOptions } from 'pocketbase-replay';

export type { ReplayMetadata, ReplayMetrics, ReplayOptions, ReplayTransport } from 'pocketbase-replay';

export interface PocketBaseReplayPlugin {
  /**
   * Start recording, with the same options as the client's `startReplay`.
   *
   * Calling it again stops the running recorder first, so there is never more than one.
   */
  start(options: StartOptions): Promise<void>;

  /**
   * Stop recording and release the recorder.
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
}

export type StartOptions = ReplayOptions;

export interface GetMetricsResult {
  metrics: ReplayMetrics | null;
}
