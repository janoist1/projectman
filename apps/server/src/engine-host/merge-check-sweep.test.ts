import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MERGE_CHECK_DIR, STALE_LEFTOVER_MS } from '../contracts';
import { sweepStaleChecks } from './merge-check';

let worktreesRoot: string;
let checks: string;

const makeDir = async (name: string, ageMs: number) => {
  const dir = path.join(checks, name);
  await mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules', 'file'), 'x');
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
};

beforeEach(async () => {
  worktreesRoot = await mkdtemp(path.join(os.tmpdir(), 'pm-sweep-checks-'));
  checks = path.join(worktreesRoot, MERGE_CHECK_DIR);
  await mkdir(checks);
});

afterEach(async () => {
  await rm(worktreesRoot, { recursive: true, force: true });
});

describe('sweepStaleChecks', () => {
  it('removes only the old checkouts named like a merge id', async () => {
    const old = await makeDir('mrg_oldcheck1', STALE_LEFTOVER_MS + 60_000);
    const fresh = await makeDir('mrg_freshchk1', 60_000);
    const foreign = await makeDir('keep-me', STALE_LEFTOVER_MS + 60_000);

    expect(await sweepStaleChecks(worktreesRoot, STALE_LEFTOVER_MS)).toBe(1);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it('unlinks an old link without following it', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'pm-sweep-outside-'));
    try {
      await writeFile(path.join(outside, 'file'), 'x');
      const link = path.join(checks, 'mrg_linkcheck1');
      await symlink(outside, link);

      await sweepStaleChecks(worktreesRoot, STALE_LEFTOVER_MS, Date.now() + 2 * STALE_LEFTOVER_MS);

      await expect(lstat(link)).rejects.toThrow(/ENOENT/);
      expect(existsSync(path.join(outside, 'file'))).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does nothing when the worktrees root does not exist yet', async () => {
    expect(await sweepStaleChecks(path.join(worktreesRoot, 'missing'), STALE_LEFTOVER_MS)).toBe(0);
  });

  it('does nothing when there is no _merge directory', async () => {
    await rm(checks, { recursive: true });
    expect(await sweepStaleChecks(worktreesRoot, STALE_LEFTOVER_MS)).toBe(0);
  });
});
