import { ERROR_CODES } from '@projectman/shared';
import type { ErrorCode } from '@projectman/shared';
import { DomainError } from '../kernel';

/**
 * How a refusal of the supervisor (or of an engine's administration handler) comes back as a domain error
 * (PM-763): the same code, with the HTTP status the code deserves. Only a code from the shared list is
 * believed; anything else is an `administration_failed`.
 */

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  invalid_request: 400,
  not_found: 404,
  administration_unavailable: 503,
  administration_failed: 502,
};

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);

export function administrationRefusal(code: ErrorCode, message?: string): DomainError {
  return new DomainError(code, message ?? `the administration supervisor answered ${code}`, {
    status: STATUS_BY_CODE[code] ?? 409,
  });
}
