import type { ErrorCode, IntegratorRefusal } from '@projectman/shared';

/**
 * Errors raised by domain services. `code` is a stable machine code from the shared
 * ERROR_CODES (the web app maps it to a translated message); `message` is an English developer
 * message; `status` is the HTTP status the REST layer answers with.
 */
const DEFAULT_STATUS: Partial<Record<ErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  invalid_config: 422,
};

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, opts: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code] ?? 400;
    this.details = opts.details;
  }
}

export const notFound = (what: string, id: string) =>
  new DomainError('not_found', `${what} not found: ${id}`, { status: 404, details: { what, id } });

export const forbidden = (code: ErrorCode, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 403, details });

const OWNER_LOGIN_MESSAGES: Record<IntegratorRefusal, string> = {
  engines: 'Only the host owner may manage engines and machine keys, using their own login',
  approval_rules: 'Only the owner may change approval labels or gates, using their own login',
  owner_settings: 'Only the owner may change owner-only settings, using their own login',
  members:
    'Only the owner may manage members, using their own login; the integrator key may only send members on leave and call them back',
  invitations: 'Only the owner may create invitations, using their own login',
};

/** The integrator key tried something only the owner may do with their own login (PM-418). */
export const ownerLoginRequired = (category: IntegratorRefusal) =>
  forbidden('owner_login_required', OWNER_LOGIN_MESSAGES[category], { category });

export const invalid = (code: ErrorCode, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 400, details });

export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 409, details });

/**
 * A pipeline action on a theme (PM-192): a theme does not move, start, have an assignee or a repository,
 * nor take part in subtasks or prerequisites. `what` is the action, in words.
 */
export const themeRefused = (taskKey: string, what: string) =>
  new DomainError('task_is_theme', `${taskKey} is a theme: a theme cannot ${what}`, {
    status: 409,
    details: { taskKey, action: what },
  });

/** The server cannot take the request now (e.g. it is stopping); the client may retry later. */
export const unavailable = (code: ErrorCode, message: string, details?: unknown) =>
  new DomainError(code, message, { status: 503, details });
