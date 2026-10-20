import { ApiError } from '@projectman/shared';
import type { z } from 'zod';

export interface ApiFailure {
  status: number;
  body: ApiError;
}

export function apiFailure(status: number, code: string, message = code, details?: unknown): ApiFailure {
  return { status, body: { error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

export function checked<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${where}: ${parsed.error.message}`);
  return parsed.data;
}

const violations: string[] = [];

export function recordViolation(message: string): void {
  violations.push(message);
}

export function takeContractViolations(): string[] {
  return violations.splice(0);
}
