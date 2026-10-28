/**
 * Error with an HTTP status. `expose` marks the message as safe to send to the
 * client; errors without it are returned as a generic 500 (database messages
 * leak table and column names). `code` is a stable machine-readable value so
 * the frontend never has to match on message text.
 */
export class HttpError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.expose = true;
    if (code) this.code = code;
  }
}

export function createHttpError(statusCode, message, code) {
  return new HttpError(statusCode, message, code);
}
