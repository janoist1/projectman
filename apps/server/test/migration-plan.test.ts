import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInventory } from '../../../scripts/migrate/inventory';
import { renderCutoverSheet, suggestMappings } from '../../../scripts/migrate/plan';
import { createSourceHome } from './helpers/migration-source';
import type { SourceHome } from './helpers/migration-source';

/** The cutover sheet (PM-143): the concrete move for one real home, as a person reads and approves it. */

// Each test builds a real home and repositories: slow when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let src: SourceHome;
beforeEach(async () => {
  src = await createSourceHome();
});
afterEach(async () => {
  await src.cleanup();
});

const options = {
  vmRepoRoot: '/var/lib/projectman/repos',
  vmHome: '/var/lib/projectman/data',
  packageDirOld: '/Users/owner/pm-move/package',
  packageDirVm: '/var/lib/projectman/incoming/package',
};

describe('the cutover sheet', () => {
  it('proposes one mapping per workspace and writes the exact commands', async () => {
    await src.stop();
    const inventory = await buildInventory({ home: src.home });
    expect(suggestMappings(inventory, options.vmRepoRoot).mappings).toEqual([
      { from: src.workspace, to: '/var/lib/projectman/repos/AR' },
    ]);
    const sheet = renderCutoverSheet(inventory, options);
    expect(sheet).toContain(`| \`${src.workspace}\` | \`/var/lib/projectman/repos/AR\` |`);
    expect(sheet).toContain(
      `npm run migrate -- package --home ${src.home} --out /Users/owner/pm-move/package`,
    );
    expect(sheet).toContain('--map ' + `${src.workspace}=/var/lib/projectman/repos/AR`);
    expect(sheet).toContain('--target-home /var/lib/projectman/data');
    expect(sheet).toContain('Blocking findings');
    expect(sheet).toMatch(/Blocking findings\n\nNone\./);
  });

  it('names every decision only a person can take, and the blockers of a running source', async () => {
    const running = renderCutoverSheet(await buildInventory({ home: src.home }), options);
    expect(running).toContain('[source_running]');
    await src.stop();
    const sheet = renderCutoverSheet(await buildInventory({ home: src.home }), options);
    // The dirty main checkout, the dirty worktree of dev-1 on the task, and the branch that was never pushed.
    expect(sheet).toContain('main checkout');
    expect(sheet).toContain(`dev-1 on ${src.taskKey}`);
    expect(sheet).toContain('feature/local-only: 1');
    expect(sheet).toContain('never discarded, never stashed');
    expect(sheet).toContain('is `docs/MIGRATION.md`');
  });

  it('writes no secret and no file content', async () => {
    await src.stop();
    const sheet = renderCutoverSheet(await buildInventory({ home: src.home }), options);
    expect(sheet).not.toContain('half-done change');
    expect(sheet).not.toContain('Remember: Hungarian notes');
  });
});
