import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppTagReader, resolveAppTag } from './version';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-tag-'));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { stdio: 'ignore' },
  );
}

describe('application release tag reader', () => {
  it('is null without asking git when the version is overridden', async () => {
    const dir = tempDir();
    git(dir, 'init', '-q');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'first');
    git(dir, 'tag', 'v2026.10.11');
    expect(await createAppTagReader(dir, 'cloud-1')()).toBeNull();
    expect(await createAppTagReader(dir)()).toBe('v2026.10.11');
  });

  it('remembers a found tag only: the watcher tags after the switch', async () => {
    const dir = tempDir();
    git(dir, 'init', '-q');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'first');
    const read = createAppTagReader(dir);
    expect(await read()).toBeNull();
    git(dir, 'tag', 'v2026.10.12');
    expect(await read()).toBe('v2026.10.12');
    git(dir, 'tag', '-d', 'v2026.10.12');
    expect(await read()).toBe('v2026.10.12');
  });
});

describe('application release tag', () => {
  it('is null in a directory that is no git checkout', async () => {
    expect(await resolveAppTag(tempDir())).toBeNull();
  });

  it('is null for a missing directory', async () => {
    expect(await resolveAppTag(join(tempDir(), 'missing'))).toBeNull();
  });

  it('is the release tag on the checked-out commit and ignores other tags', async () => {
    const dir = tempDir();
    git(dir, 'init', '-q');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'first');
    expect(await resolveAppTag(dir)).toBeNull();
    git(dir, 'tag', 'latest');
    expect(await resolveAppTag(dir)).toBeNull();
    git(dir, 'tag', 'v2026.10.11');
    expect(await resolveAppTag(dir)).toBe('v2026.10.11');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'second');
    expect(await resolveAppTag(dir)).toBeNull();
  });
});
