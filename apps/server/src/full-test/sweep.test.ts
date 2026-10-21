import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STALE_LEFTOVER_MS } from '../contracts';
import { canonicalRoot, sweepStaleRunDirs } from './sandbox';

let root: string;

const makeDir = async (name: string, ageMs: number) => {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, 'sandbox', 'tmp'), { recursive: true });
  await writeFile(path.join(dir, 'settings.json'), '{}');
  const when = new Date(Date.now() - ageMs);
  await utimes(dir, when, when);
  return dir;
};

beforeEach(async () => {
  root = canonicalRoot(await mkdtemp(path.join(os.tmpdir(), 'pm-sweep-runs-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sweepStaleRunDirs', () => {
  it('removes only the old run directories named like a run', async () => {
    const old = await makeDir('pmft-abc12345', STALE_LEFTOVER_MS + 60_000);
    const fresh = await makeDir('pmft-fresh123', 60_000);
    const foreignName = await makeDir('pmft-too-long-name', STALE_LEFTOVER_MS + 60_000);
    const unrelated = await makeDir('other', STALE_LEFTOVER_MS + 60_000);

    expect(await sweepStaleRunDirs([root], STALE_LEFTOVER_MS)).toBe(1);

    expect(existsSync(old)).toBe(false);
    for (const kept of [fresh, foreignName, unrelated]) expect(existsSync(kept)).toBe(true);
  });

  it('never follows or removes a link', async () => {
    const target = await makeDir('target', STALE_LEFTOVER_MS + 60_000);
    const link = path.join(root, 'pmft-link1234');
    await symlink(target, link);

    expect(await sweepStaleRunDirs([root], STALE_LEFTOVER_MS, Date.now() + 2 * STALE_LEFTOVER_MS)).toBe(0);

    expect(existsSync(link)).toBe(true);
    expect(existsSync(path.join(target, 'settings.json'))).toBe(true);
  });

  it('skips a root that does not exist', async () => {
    expect(await sweepStaleRunDirs([path.join(root, 'missing')], STALE_LEFTOVER_MS)).toBe(0);
  });
});
