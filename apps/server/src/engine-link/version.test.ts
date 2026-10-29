import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execCommand } from '../exec';
import { resolveAppTag, resolveAppVersion } from './version';
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

  describe('in an engine package', () => {
    const manifest = (tag: string | null) =>
      JSON.stringify({
        schemaVersion: 1,
        version: 'b'.repeat(40),
        tag,
        node: '22.12.0',
        arch: 'arm64',
        builtAt: '2026-10-29T12:00:00.000Z',
      });

    function packageDir(text: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'engine-package-'));
      writeFileSync(join(dir, 'engine-package.json'), text);
      return dir;
    }

    it('reads the commit and the tag from the manifest, without asking git', async () => {
      const dir = packageDir(manifest('v2026.10.29'));
      try {
        vi.mocked(execCommand).mockClear();
        expect(await resolveAppVersion(dir)).toBe('b'.repeat(40));
        expect(await resolveAppTag(dir)).toBe('v2026.10.29');
        expect(execCommand).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('has no tag when the manifest names none, and falls back to git for an invalid manifest', async () => {
      const untagged = packageDir(manifest(null));
      const invalid = packageDir('{"version":"nope"}');
      try {
        vi.mocked(execCommand).mockClear();
        expect(await resolveAppTag(untagged)).toBeNull();
        expect(execCommand).not.toHaveBeenCalled();
        vi.mocked(execCommand).mockImplementation(async () => ({
          stdout: 'c'.repeat(40),
          stderr: '',
          exitCode: 0,
        }));
        expect(await resolveAppVersion(invalid)).toBe('c'.repeat(40));
      } finally {
        rmSync(untagged, { recursive: true, force: true });
        rmSync(invalid, { recursive: true, force: true });
      }
    });
  });
});
