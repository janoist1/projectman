import { describe, expect, it } from 'vitest';
import { parseFullTestArgs } from '../../../scripts/full-test/args';

describe('full test arguments', () => {
  it('uses defaults and preserves command arguments', () => {
    expect(parseFullTestArgs(['--', 'npm', 'run', 'merge-test', '--', '--all'])).toEqual({
      workers: 4,
      timeoutMinutes: 60,
      command: ['npm', 'run', 'merge-test', '--', '--all'],
    });
  });
  it('accepts the minimum and maximum limits', () => {
    expect(parseFullTestArgs(['--workers', '1', '--timeout', '1', '--', 'true']).workers).toBe(1);
    expect(parseFullTestArgs(['--timeout', '60', '--workers', '8', '--', 'true'])).toEqual({
      workers: 8,
      timeoutMinutes: 60,
      command: ['true'],
    });
  });
  it.each([
    [],
    ['--'],
    ['npm', 'test'],
    ['--workers'],
    ['--workers', '0', '--', 'true'],
    ['--workers', '9', '--', 'true'],
    ['--workers', '1.5', '--', 'true'],
    ['--timeout', '0', '--', 'true'],
    ['--timeout', '61', '--', 'true'],
    ['--timeout', 'NaN', '--', 'true'],
    ['--unknown', '1', '--', 'true'],
  ])('rejects invalid arguments %j', (...argv) => {
    expect(() => parseFullTestArgs(argv)).toThrow();
  });
});
