import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, restartDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
afterEach(() => h?.cleanup());
const by = { actor: OWNER_ACTOR, author: OWNER };

async function patch(change: object) {
  const loaded = await h.domain.projects.load('AR');
  return h.domain.projects.patch('AR', { baseVersion: loaded.version, ...change }, by);
}

describe('merger setting (PM-470)', () => {
  it('stores the merger and the per-repository merge setting, and reads them back after a restart', async () => {
    h = await createDomainHarness();
    const saved = await patch({
      merger: { kind: 'member', handle: 'owner' },
      repoMerge: [{ repo: 'web', requireMerge: false }],
    });
    expect(saved.config.team.merger).toEqual({ kind: 'member', handle: 'owner' });
    expect(saved.config.project.repos[0]).toMatchObject({ name: 'web', requireMerge: false });

    h = await restartDomainHarness(h);
    const loaded = await h.domain.projects.load('AR');
    expect(loaded.config.team.merger).toEqual({ kind: 'member', handle: 'owner' });
    expect(loaded.config.project.repos[0]).toMatchObject({ name: 'web', requireMerge: false });

    const cleared = await patch({ repoMerge: [{ repo: 'web', requireMerge: null }] });
    expect(cleared.config.project.repos[0]).not.toHaveProperty('requireMerge');
    expect(cleared.config.team.merger).toEqual({ kind: 'member', handle: 'owner' });
  });

  it('refuses a repository the project does not have', async () => {
    h = await createDomainHarness();
    const before = await h.domain.projects.load('AR');
    await expect(patch({ repoMerge: [{ repo: 'ghost', requireMerge: true }] })).rejects.toMatchObject({
      code: 'unknown_repo',
    });
    expect((await h.domain.projects.load('AR')).version).toBe(before.version);
  });

  it('stores the project documents of a repository, clears them with null and refuses an unknown repository (PM-494)', async () => {
    h = await createDomainHarness();
    const saved = await patch({ repoDocs: [{ repo: 'web', docs: { decisions: 'docs/D.md' } }] });
    expect(saved.config.project.repos[0]).toMatchObject({ name: 'web', docs: { decisions: 'docs/D.md' } });

    h = await restartDomainHarness(h);
    expect((await h.domain.projects.load('AR')).config.project.repos[0]).toMatchObject({
      docs: { decisions: 'docs/D.md' },
    });

    const version = (await h.domain.projects.load('AR')).version;
    await expect(patch({ repoDocs: [{ repo: 'ghost', docs: null }] })).rejects.toMatchObject({
      code: 'unknown_repo',
    });
    await expect(patch({ repoDocs: [{ repo: 'web', docs: { decisions: '../x' } }] })).rejects.toBeDefined();
    expect((await h.domain.projects.load('AR')).version).toBe(version);

    const cleared = await patch({ repoDocs: [{ repo: 'web', docs: null }] });
    expect(cleared.config.project.repos[0]).not.toHaveProperty('docs');
  });

  it('refuses a merger that cannot be resolved', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.project.repos[0]!.requireMerge = true;
      },
    });
    await expect(patch({ merger: { kind: 'member', handle: 'ghost' } })).rejects.toMatchObject({
      code: 'config_invalid',
    });
  });
});
