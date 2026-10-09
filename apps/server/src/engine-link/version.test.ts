import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolveAppVersion } from './version';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('application version', () => {
  it('prefers a validated explicit version, then git HEAD, then dev', () => {
    vi.mocked(execFileSync).mockReturnValue('a'.repeat(40));
    expect(resolveAppVersion('/fictional', 'release-1')).toBe('release-1');
    expect(resolveAppVersion('/fictional')).toBe('a'.repeat(40));
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('no checkout');
    });
    expect(resolveAppVersion('/fictional')).toBe('dev');
    expect(() => resolveAppVersion('/fictional', 'bad version')).toThrow('Invalid PROJECTMAN_VERSION');
  });
});
