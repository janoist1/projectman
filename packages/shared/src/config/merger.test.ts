import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest, unknownPatchRepo } from './edit';
import { cardMerger, defaultMerger, mergeRepoOf, mergerOf, mergeTargetOf, requiresMerge } from './merger';
import { ProjectConfig } from './schema';
import type { Merger } from './schema';

const queue = { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' } as const;
const work = { id: 'dev', name: 'Dev', kind: 'work', owners: ['dev', 'dev-2'], columnId: 'all' } as const;
const codeReview = {
  id: 'code_review',
  name: 'Code review',
  kind: 'step',
  owners: ['cr', 'cr-2'],
  columnId: 'all',
} as const;
const release = {
  id: 'release',
  name: 'Release',
  kind: 'release',
  owners: ['owner'],
  columnId: 'all',
  gate: { conditions: [{ type: 'has_label', label: 'release-approved' }] },
} as const;
const done = { id: 'done', name: 'Done', kind: 'done', columnId: 'all' } as const;

function config(
  options: { merger?: Merger; stages?: readonly object[]; repos?: object[]; onLeave?: string[] } = {},
): ProjectConfig {
  const onLeave = (handle: string) => (options.onLeave?.includes(handle) ? { onLeave: true } : {});
  const ai = (handle: string, role: string) => ({
    kind: 'ai',
    handle,
    displayName: handle,
    role,
    sponsor: 'owner',
    ...onLeave(handle),
  });
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: {
      key: 'AR',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: options.repos ?? [{ name: 'web', path: '.' }],
    },
    team: {
      merger: options.merger,
      limits: {},
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer' },
        { kind: 'human', handle: 'vera', displayName: 'Vera', access: 'viewer' },
        ai('dev', 'developer'),
        ai('dev-2', 'developer'),
        ai('cr', 'code_review'),
        ai('cr-2', 'code_review'),
        ai('pm', 'project_manager'),
      ],
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      labels: [],
      stages: options.stages ?? [queue, work, codeReview, release, done],
    },
  });
}

describe('requiresMerge', () => {
  it('follows requireMerge, else fullTestAtMerge', () => {
    expect(requiresMerge({})).toBe(true);
    expect(requiresMerge({ fullTestAtMerge: false })).toBe(true);
    expect(requiresMerge({ fullTestAtMerge: true })).toBe(false);
    expect(requiresMerge({ requireMerge: true, fullTestAtMerge: true })).toBe(true);
    expect(requiresMerge({ requireMerge: false })).toBe(false);
  });
});

describe('mergeTargetOf', () => {
  it('is the first release stage, else the done stage, else none', () => {
    expect(mergeTargetOf(config())?.id).toBe('release');
    expect(mergeTargetOf(config({ stages: [queue, work, codeReview, done] }))?.id).toBe('done');
    expect(mergeTargetOf(config({ stages: [queue, work] }))).toBeNull();
  });
});

describe('defaultMerger and mergerOf', () => {
  it('is the code reviewer when a code review stage comes before the target, else the developer', () => {
    expect(defaultMerger(config())).toEqual({ kind: 'code_reviewer' });
    expect(defaultMerger(config({ stages: [queue, work, done] }))).toEqual({ kind: 'developer' });
    // A code review stage after the target does not count.
    expect(defaultMerger(config({ stages: [queue, work, release, codeReview, done] }))).toEqual({
      kind: 'developer',
    });
  });

  it('prefers the configured merger', () => {
    expect(mergerOf(config())).toEqual({ kind: 'code_reviewer' });
    expect(mergerOf(config({ merger: { kind: 'developer' } }))).toEqual({ kind: 'developer' });
    expect(mergerOf(config({ merger: { kind: 'member', handle: 'ann' } }))).toEqual({
      kind: 'member',
      handle: 'ann',
    });
  });
});

describe('cardMerger', () => {
  const task = { assignee: 'dev' };

  it('code_reviewer: the reviewer when they own the stage, else its first owner who is not on leave', () => {
    const c = config({ merger: { kind: 'code_reviewer' } });
    expect(cardMerger(c, task, 'cr-2')).toBe('cr-2');
    expect(cardMerger(c, task, 'cr')).toBe('cr');
    // Not an owner of the stage: the first owner comes instead.
    expect(cardMerger(c, task, 'ann')).toBe('cr');
    expect(cardMerger(c, task, null)).toBe('cr');
    const onLeave = config({ merger: { kind: 'code_reviewer' }, onLeave: ['cr'] });
    expect(cardMerger(onLeave, task, 'ann')).toBe('cr-2');
    expect(cardMerger(onLeave, task, 'cr')).toBe('cr-2');
  });

  it('code_reviewer: nobody when no code review stage comes before the target', () => {
    const c = config({ merger: { kind: 'code_reviewer' }, stages: [queue, work, done] });
    expect(cardMerger(c, task, 'cr')).toBeNull();
  });

  it('developer: the assignee, even on leave', () => {
    const c = config({ merger: { kind: 'developer' }, onLeave: ['dev'] });
    expect(cardMerger(c, task, 'cr')).toBe('dev');
    expect(cardMerger(c, { assignee: null }, 'cr')).toBeNull();
  });

  it('member: a member of the team, even on leave; a person needs developer access', () => {
    const member = (handle: string, onLeave: string[] = []) =>
      cardMerger(config({ merger: { kind: 'member', handle }, onLeave }), task, 'cr');
    expect(member('cr-2')).toBe('cr-2');
    expect(member('cr-2', ['cr-2'])).toBe('cr-2');
    expect(member('ann')).toBe('ann');
    expect(member('owner')).toBe('owner');
    expect(member('vera')).toBeNull();
    expect(member('ghost')).toBeNull();
  });
});

describe('editing the merger', () => {
  const two = () =>
    config({
      repos: [
        { name: 'web', path: '.', requireMerge: true },
        { name: 'api', path: 'api', fullTestAtMerge: true },
      ],
    });

  it('patches the merger and keeps it on later edits', () => {
    const c = two();
    const patch = PatchConfigRequest.parse({ baseVersion: 'v1', merger: { kind: 'member', handle: 'ann' } });
    const next = applyConfigPatch(c, patch);
    expect(next.team.merger).toEqual({ kind: 'member', handle: 'ann' });
    expect(next.team.members).toEqual(c.team.members);
    expect(next.project.repos).toEqual(c.project.repos);
    expect(c.team.merger).toBeUndefined();
    expect(applyConfigPatch(next, { baseVersion: 'v2' }).team.merger).toEqual({
      kind: 'member',
      handle: 'ann',
    });
  });

  it('sets and clears requireMerge per repository, null removing the explicit value', () => {
    const patch = PatchConfigRequest.parse({
      baseVersion: 'v1',
      repoMerge: [
        { repo: 'web', requireMerge: null },
        { repo: 'api', requireMerge: true },
      ],
    });
    const next = applyConfigPatch(two(), patch);
    expect(next.project.repos.map((r) => [r.name, r.requireMerge, r.fullTestAtMerge])).toEqual([
      ['web', undefined, undefined],
      ['api', true, true],
    ]);
    expect('requireMerge' in next.project.repos[0]!).toBe(false);
  });

  it('names a repository the project does not have', () => {
    const known = PatchConfigRequest.parse({
      baseVersion: 'v1',
      repoMerge: [{ repo: 'web', requireMerge: false }],
    });
    const unknown = PatchConfigRequest.parse({
      baseVersion: 'v1',
      repoMerge: [
        { repo: 'web', requireMerge: false },
        { repo: 'ghost', requireMerge: true },
      ],
    });
    expect(unknownPatchRepo(two(), known)).toBeNull();
    expect(unknownPatchRepo(two(), unknown)).toBe('ghost');
    expect(unknownPatchRepo(two(), { baseVersion: 'v1' })).toBeNull();
  });

  it('refuses a merger of another shape and more than 20 repositories', () => {
    expect(PatchConfigRequest.safeParse({ baseVersion: 'v1', merger: { kind: 'member' } }).success).toBe(
      false,
    );
    expect(PatchConfigRequest.safeParse({ baseVersion: 'v1', merger: { kind: 'robot' } }).success).toBe(
      false,
    );
    const many = Array.from({ length: 21 }, (_, i) => ({ repo: `r${i}`, requireMerge: true }));
    expect(PatchConfigRequest.safeParse({ baseVersion: 'v1', repoMerge: many }).success).toBe(false);
  });
});

describe('mergeRepoOf', () => {
  const task = { repo: 'web' };

  it('is the repository of a forward move to the target or beyond', () => {
    const c = config();
    expect(mergeRepoOf(c, task, 'code_review', 'release')?.name).toBe('web');
    expect(mergeRepoOf(c, task, 'dev', 'done')?.name).toBe('web');
    // The only repository serves a card that names none.
    expect(mergeRepoOf(c, { repo: null }, 'code_review', 'release')?.name).toBe('web');
  });

  it('is null for a move that stays before the target, goes back, or starts at or past it', () => {
    const c = config();
    expect(mergeRepoOf(c, task, 'dev', 'code_review')).toBeNull();
    expect(mergeRepoOf(c, task, 'release', 'code_review')).toBeNull();
    expect(mergeRepoOf(c, task, 'release', 'done')).toBeNull();
    expect(mergeRepoOf(c, task, 'ghost', 'release')).toBeNull();
  });

  it('is null for a card without a repository or with an unknown one', () => {
    const several = config({
      repos: [
        { name: 'web', path: '.' },
        { name: 'api', path: 'api' },
      ],
    });
    expect(mergeRepoOf(several, { repo: null }, 'code_review', 'release')).toBeNull();
    expect(mergeRepoOf(several, { repo: 'ghost' }, 'code_review', 'release')).toBeNull();
    expect(mergeRepoOf(config({ repos: [] }), { repo: null }, 'code_review', 'release')).toBeNull();
  });

  it('is null where the repository does not require a merge', () => {
    const fullTest = config({ repos: [{ name: 'web', path: '.', fullTestAtMerge: true }] });
    expect(mergeRepoOf(fullTest, task, 'code_review', 'release')).toBeNull();
    const forced = config({ repos: [{ name: 'web', path: '.', fullTestAtMerge: true, requireMerge: true }] });
    expect(mergeRepoOf(forced, task, 'code_review', 'release')?.name).toBe('web');
    const off = config({ repos: [{ name: 'web', path: '.', requireMerge: false }] });
    expect(mergeRepoOf(off, task, 'code_review', 'release')).toBeNull();
  });
});
