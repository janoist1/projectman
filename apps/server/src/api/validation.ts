import type { z } from 'zod';
import { DomainError } from '../domain/errors';

/** Validates a request body (or query) with a shared zod schema; 400 invalid_request with the issues otherwise. */
export function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new DomainError('invalid_request', 'the request is invalid', {
      status: 400,
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
