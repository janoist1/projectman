import { describe, expect, it } from 'vitest';
import type { Me } from '@projectman/shared';
import { ApiError } from '../../api/client';
import {
  emailLoginTarget,
  formatCountdown,
  isLoginCode,
  normalizeLoginCode,
  retryAfterOf,
  safeNextOrNull,
} from './emailLogin';

function meWith(...keys: string[]): Me {
  return {
    userId: 'usr_1',
    name: 'Kata',
    email: 'kata@client.test',
    handles: {},
    instanceOwner: false,
    projects: keys.map((key) => ({ key, name: key, access: 'client', roles: [] })),
  };
}

describe('code helpers', () => {
  it('strips spaces and hyphens from a typed code', () => {
    expect(normalizeLoginCode(' 123 456 ')).toBe('123456');
    expect(normalizeLoginCode('123-456')).toBe('123456');
  });

  it('accepts exactly six digits', () => {
    expect(isLoginCode('123456')).toBe(true);
    expect(isLoginCode('12345')).toBe(false);
    expect(isLoginCode('1234567')).toBe(false);
    expect(isLoginCode('12345a')).toBe(false);
  });

  it('formats a wait as m:ss', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(125.2)).toBe('2:06');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('safeNextOrNull', () => {
  it.each(['/', '/p/AC', '/p/AC/tasks?tab=all#task', '/invite/abc'])(
    'keeps the same-app path %j',
    (value) => {
      expect(safeNextOrNull(value)).toBe(value);
    },
  );

  it.each([
    null,
    '',
    '//evil.test',
    'https://evil.test',
    '/\\evil.test',
    '/\\\\evil.test',
    '/\t/evil.test',
    '/\n/evil.test',
    '/\r/evil.test',
    '/p/AC\u0000',
    '/p/AC\u001f',
    '/p/AC\u007f',
  ])('rejects the unsafe next %j', (value) => {
    expect(safeNextOrNull(value)).toBeNull();
  });
});

describe('emailLoginTarget', () => {
  it('goes to the project of a single membership, else to the list', () => {
    expect(emailLoginTarget(meWith('AC'), null)).toBe('/p/AC');
    expect(emailLoginTarget(meWith('AC', 'BD'), null)).toBe('/');
    expect(emailLoginTarget(meWith(), null)).toBe('/');
  });

  it('prefers the invitation project among several', () => {
    expect(emailLoginTarget(meWith('AC', 'BD'), null, 'BD')).toBe('/p/BD');
    expect(emailLoginTarget(meWith('AC', 'BD'), null, 'ZZ')).toBe('/');
  });

  it('honours a safe next, but not an invitation page that was just accepted', () => {
    expect(emailLoginTarget(meWith('AC', 'BD'), '/p/BD/tasks')).toBe('/p/BD/tasks');
    expect(emailLoginTarget(meWith('AC'), '/invite/abc')).toBe('/p/AC');
  });
});

describe('retryAfterOf', () => {
  it('reads the wait of a rate limit', () => {
    const limited = new ApiError(429, 'email_login_rate_limited', 'Too many', { retryAfterSeconds: 42 });
    expect(retryAfterOf(limited)).toBe(42);
  });

  it('ignores other errors and malformed details', () => {
    expect(retryAfterOf(new ApiError(400, 'email_code_invalid', 'Invalid'))).toBeNull();
    expect(retryAfterOf(new ApiError(429, 'email_login_rate_limited', 'Too many', { nope: 1 }))).toBeNull();
    expect(retryAfterOf(new Error('x'))).toBeNull();
  });
});
