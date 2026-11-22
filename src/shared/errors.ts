export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: ReadonlyArray<{ path: string; code: string }>) {
    super(message);
  }
}
