/**
 * Errors raised by domain services. `code` is a stable machine code (the web app maps it
 * to a translated message); `message` is an English developer message; `status` is the
 * HTTP status the REST layer answers with.
 */
const DEFAULT_STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_config: 422,
};

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  constructor(code: string, message: string, opts: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code] ?? 400;
    this.details = opts.details;
  }
}

export const notFound = (what: string, id: string) =>
  new DomainError('not_found', `${what} not found: ${id}`, { status: 404, details: { what, id } });

export const forbidden = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 403, details });

export const invalid = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 400, details });

export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 409, details });
