export class ReplayHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Replay HTTP ${status}`);
  }
}
