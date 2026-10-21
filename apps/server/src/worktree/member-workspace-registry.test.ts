import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemberWorkspaceKey } from '../contracts';
import { createMemberWorkspaceRegistry } from './member-workspace-registry';

const key = { project: { project: { key: 'AR' } }, repoName: 'app', member: 'dev' } as MemberWorkspaceKey;

let base: string;
let clone: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-registry-')));
  clone = path.join(base, 'workspaces', 'AR', 'dev', 'app', 'repo');
  await mkdir(path.join(clone, 'src'), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('member workspace registry (PM-743)', () => {
  it('knows a clone only after it was registered, and the paths below it', async () => {
    const registry = createMemberWorkspaceRegistry();
    expect(await registry.keyOf(clone)).toBeNull();
    registry.register(key, clone);
    expect(await registry.keyOf(clone)).toBe(key);
    expect(await registry.keyOf(path.join(clone, 'src'))).toBe(key);
  });

  it('gives null for a path outside the clone, a sibling with the same prefix and a missing path', async () => {
    const registry = createMemberWorkspaceRegistry();
    registry.register(key, clone);
    await mkdir(`${clone}-other`);
    expect(await registry.keyOf(base)).toBeNull();
    expect(await registry.keyOf(`${clone}-other`)).toBeNull();
    expect(await registry.keyOf(path.join(clone, 'missing'))).toBeNull();
  });

  it('follows a symlink to its target, so one pointing out of the clone is not the clone', async () => {
    const registry = createMemberWorkspaceRegistry();
    registry.register(key, clone);
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(clone, 'escape'));
    await symlink(clone, path.join(base, 'alias'));
    expect(await registry.keyOf(path.join(clone, 'escape'))).toBeNull();
    expect(await registry.keyOf(path.join(base, 'alias'))).toBe(key);
  });
});
