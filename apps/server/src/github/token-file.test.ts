import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenFileReader } from './token-file';

const dirs: string[] = [];
function tokenFile(text: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-token-'));
  dirs.push(dir);
  const path = join(dir, 'token');
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createTokenFileReader', () => {
  it('reads the trimmed token, again at every call', async () => {
    const path = tokenFile('ghp_one\n', 0o600);
    const read = createTokenFileReader(path);
    expect(await read()).toBe('ghp_one');
    writeFileSync(path, 'ghp_two\n');
    expect(await read()).toBe('ghp_two');
  });

  it.each([0o640, 0o604, 0o644])(
    'refuses a file others can read (mode %o), without printing it',
    async (mode) => {
      const path = tokenFile('ghp_secret_value', mode);
      const err = await createTokenFileReader(path)().catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/owner alone/);
      expect((err as Error).message).not.toContain('ghp_secret_value');
    },
  );

  it('refuses a missing or empty file', async () => {
    await expect(createTokenFileReader('/nonexistent/projectman-token')()).rejects.toThrow(/cannot be read/);
    await expect(createTokenFileReader(tokenFile('  \n', 0o600))()).rejects.toThrow(/empty/);
  });
});
