import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
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

  it('names the wait until the window has a slot again, rounded up to a second', () => {
    const { attempts, advance } = limiter();
    for (let i = 0; i < 3; i++) attempts.reserve('a');
    advance(400);
    expect(refused(() => attempts.reserve('a')).details).toEqual({ retryAfterSeconds: 1 });
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

  describe('shared cap', () => {
    function shared() {
      let now = 0;
      const attempts = createAttemptLimiter({
        max: 3,
        sharedMax: 5,
        windowMs: 1_000,
        message: 'slow down',
        now: () => now,
      });
      return { attempts, advance: (ms: number) => void (now += ms) };
    }

    it('refuses every key once all keys together use it up, even a key with budget left', () => {
      const { attempts } = shared();
      for (let i = 0; i < 3; i++) attempts.reserve('a');
      for (let i = 0; i < 2; i++) attempts.reserve('b');
      expect(refused(() => attempts.reserve('c'))).toMatchObject({ code: 'too_many_attempts', status: 429 });
      expect(refused(() => attempts.reserve('a')).code).toBe('too_many_attempts');
    });

    it('does not charge either budget for an attempt it refuses', () => {
      const { attempts } = shared();
      const first = attempts.reserve('a');
      for (const key of ['b', 'b', 'c', 'c']) attempts.reserve(key);
      // 'a' has 1 of 3 and all keys 5 of 5: refused attempts must not push 'a' to its own limit.
      for (let i = 0; i < 5; i++) expect(refused(() => attempts.reserve('a')).code).toBe('too_many_attempts');
      first();
      expect(() => attempts.reserve('a')).not.toThrow();
      expect(refused(() => attempts.reserve('a')).code).toBe('too_many_attempts');
    });

    it('gives a successful attempt its slot back in both budgets', () => {
      const { attempts } = shared();
      for (let i = 0; i < 4; i++) attempts.reserve(`k${i}`);
      for (let i = 0; i < 6; i++) attempts.reserve('ok')();
      attempts.reserve('k4');
      expect(refused(() => attempts.reserve('ok')).code).toBe('too_many_attempts');
    });

    it('names the wait of the shared window when only the shared budget is used up', () => {
      let now = 0;
      const attempts = createAttemptLimiter({
        max: 3,
        sharedMax: 2,
        windowMs: 10_000,
        message: 'slow down',
        now: () => now,
      });
      attempts.reserve('a');
      now = 4_000;
      // 'b' opens its own window now, but the shared one began at 0 and ends at 10 s.
      attempts.reserve('b');
      expect(refused(() => attempts.reserve('b')).details).toEqual({ retryAfterSeconds: 6 });
    });

    it('starts a new shared window after the old one expires', () => {
      const { attempts, advance } = shared();
      for (let i = 0; i < 5; i++) attempts.reserve(`k${i}`);
      advance(1_000);
      expect(() => attempts.reserve('k0')).not.toThrow();
    });
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
