import { describe, expect, it } from 'vitest';
import { DomainError } from '../domain/errors';
import { createAttemptLimiter } from './attempt-limiter';

function limiter(max = 3) {
  let now = 0;
  const attempts = createAttemptLimiter({ max, windowMs: 1_000, message: 'slow down', now: () => now });
  return {
    attempts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function refused(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return err as DomainError;
  }
  throw new Error('the attempt was not refused');
}

describe('attempt limiter', () => {
  it('refuses a key once its failed attempts use up the window', () => {
    const { attempts } = limiter();
    for (let i = 0; i < 3; i++) attempts.reserve('10.0.0.1');
    expect(refused(() => attempts.reserve('10.0.0.1'))).toMatchObject({
      code: 'too_many_attempts',
      status: 429,
      message: 'slow down',
    });
    // Other peers keep their own budget.
    expect(() => attempts.reserve('10.0.0.2')).not.toThrow();
  });

  it('gives successful attempts their slot back, once', () => {
    const { attempts } = limiter();
    for (let i = 0; i < 10; i++) attempts.reserve('127.0.0.1')();
    const release = attempts.reserve('127.0.0.1');
    release();
    release();
    attempts.reserve('127.0.0.1');
    attempts.reserve('127.0.0.1');
    attempts.reserve('127.0.0.1');
    expect(refused(() => attempts.reserve('127.0.0.1')).code).toBe('too_many_attempts');
  });

  it('counts concurrent attempts before any of them finishes', () => {
    const { attempts } = limiter();
    const pending = [attempts.reserve('a'), attempts.reserve('a'), attempts.reserve('a')];
    expect(refused(() => attempts.reserve('a')).code).toBe('too_many_attempts');
    pending[0]!();
    expect(() => attempts.reserve('a')).not.toThrow();
  });

  it('starts a new window after the old one expires', () => {
    const { attempts, advance } = limiter();
    for (let i = 0; i < 3; i++) attempts.reserve('a');
    advance(999);
    expect(refused(() => attempts.reserve('a')).code).toBe('too_many_attempts');
    advance(1);
    const release = attempts.reserve('a');
    // A release from an expired window does not credit the new one.
    advance(1_000);
    attempts.reserve('a');
    release();
    attempts.reserve('a');
    attempts.reserve('a');
    expect(refused(() => attempts.reserve('a')).code).toBe('too_many_attempts');
  });
});
