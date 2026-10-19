import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORK_ROOT_MARKER } from '../src/engine-host';
import { createAppHarness } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/** PM-846: the single-mode server's `workRoot` (PROJECTMAN_WORK_ROOT). */
describe('work root of the server', () => {
  let h: AppHarness;
  beforeEach(async () => {
    h = await createAppHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('keeps the worktrees below the home when none is set', () => {
    expect(existsSync(join(h.home, 'worktrees'))).toBe(true);
    expect(existsSync(join(h.home, 'work'))).toBe(false);
  });

  it('does not start with a work root without the marker, and makes nothing in it', async () => {
    const root = join(h.home, 'work');
    mkdirSync(root);
    await expect(h.relaunch({ workRoot: root })).rejects.toMatchObject({
      code: 'work_root_invalid',
      reason: 'marker_missing',
    });
    expect(existsSync(join(root, 'worktrees'))).toBe(false);
  });

  it('starts with a marked work root inside the home and makes the directories below it', async () => {
    const root = join(h.home, 'work');
    mkdirSync(root);
    writeFileSync(join(root, WORK_ROOT_MARKER), '');

    await h.relaunch({ workRoot: root });

    for (const dir of ['worktrees', 'workspaces', 'tmp']) expect(existsSync(join(root, dir))).toBe(true);
  });
});
