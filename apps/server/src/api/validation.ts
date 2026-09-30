import type { z } from 'zod';
import { invalid } from '../domain/errors';

/** Validates a request body (or query) with a shared zod schema; 400 invalid_request with the issues otherwise. */
export function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw invalid('invalid_request', 'the request is invalid', { issues: result.error.issues });
  }
  return result.data;
}
