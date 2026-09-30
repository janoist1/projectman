import { expect } from 'vitest';
import { DomainError } from '../../src/domain';

/** The error a promise rejects with, asserted to be a `type` (default: DomainError). */
export async function rejection<E extends Error = DomainError>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => E = DomainError as unknown as abstract new (...args: never[]) => E,
): Promise<E> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(type);
  return err as E;
}
