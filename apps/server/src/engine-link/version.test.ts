import { describe, expect, it, vi } from 'vitest';
import { execCommand } from '../exec';
import { resolveAppVersion } from './version';
vi.mock('../exec', () => ({
  execCommand: vi.fn(async () => ({ stdout: 'a'.repeat(40), stderr: '', exitCode: 0 })),
}));

describe('application version', () => {
  it('prefers a trimmed valid override and falls back for invalid overrides or missing checkouts', async () => {
    expect(await resolveAppVersion('/fictional', ' release-1 ')).toBe('release-1');
    expect(execCommand).not.toHaveBeenCalled();
    expect(await resolveAppVersion('/fictional', 'bad version')).toBe('a'.repeat(40));
    expect(execCommand).toHaveBeenCalledWith(
      'git',
      ['-C', '/fictional', 'rev-parse', '--verify', '-q', 'HEAD'],
      expect.any(Object),
    );
    expect(await resolveAppVersion('/fictional')).toBe('a'.repeat(40));
    expect(await resolveAppVersion(null)).toBe('dev');
    vi.mocked(execCommand).mockImplementation(() => {
      throw new Error('no checkout');
    });
    expect(await resolveAppVersion('/fictional')).toBe('dev');
  });
});
