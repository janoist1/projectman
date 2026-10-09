import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { resolveAppVersion } from './version';
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (_file: unknown, _args: unknown, _options: unknown, callback: (error: null, stdout: string) => void) => {
      callback(null, 'a'.repeat(40));
    },
  ),
}));

describe('application version', () => {
  it('prefers a trimmed valid override and falls back for invalid overrides or missing checkouts', async () => {
    expect(await resolveAppVersion('/fictional', ' release-1 ')).toBe('release-1');
    expect(execFile).not.toHaveBeenCalled();
    expect(await resolveAppVersion('/fictional', 'bad version')).toBe('a'.repeat(40));
    expect(execFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/fictional', 'rev-parse', '--verify', '-q', 'HEAD'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(await resolveAppVersion('/fictional')).toBe('a'.repeat(40));
    expect(await resolveAppVersion(null)).toBe('dev');
    vi.mocked(execFile).mockImplementation(() => {
      throw new Error('no checkout');
    });
    expect(await resolveAppVersion('/fictional')).toBe('dev');
  });
});
