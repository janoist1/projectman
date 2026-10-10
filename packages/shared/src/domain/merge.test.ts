import { describe, expect, it } from 'vitest';
import { applyConfigPatch, configPatchIssues, PatchConfigRequest } from '../config/edit';
import { ownerOnlyChanges } from '../config/owner-only';
import { ProjectConfig } from '../config/schema';
import { mergeRepoOf, mergesOnDone, TaskMergeState, TaskMerged } from './merge';

const config = () =>
  ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos: [{ name: 'web', path: '.' }] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
        { id: 'work', name: 'Work', kind: 'work', columnId: 'all' },
      ],
      labels: [],
    },
  });
describe('merge contracts and configuration', () => {
  it.each([
    [{}, true],
    [{ fullTestAtMerge: true }, false],
    [{ fullTestAtMerge: false }, true],
    [{ fullTestAtMerge: true, mergeOnDone: true }, true],
    [{ mergeOnDone: false }, false],
  ] as const)('resolves merge policy %j', (repo, expected) => expect(mergesOnDone(repo)).toBe(expected));
  it('resolves the effective repo only for Done', () => {
    const project = config();
    const done = project.pipeline.stages[0]!;
    expect(mergeRepoOf(project, { repo: null }, done)?.name).toBe('web');
    expect(mergeRepoOf(project, { repo: null }, { ...done, kind: 'work' })).toBeNull();
    project.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main' });
    expect(mergeRepoOf(project, { repo: null }, done)).toBeNull();
    expect(mergeRepoOf(project, { repo: 'web' }, done)?.name).toBe('web');
  });
  it('sets and removes explicit merge policy and keeps edits owner-only', () => {
    const original = config();
    const edit = { baseVersion: 'v', repoMerge: [{ repo: 'web', mergeOnDone: false }] };
    const updated = applyConfigPatch(original, edit);
    expect(updated.project.repos[0]!.mergeOnDone).toBe(false);
    expect(ownerOnlyChanges(original, updated)).toContain('approval_policy');
    const restored = applyConfigPatch(updated, {
      baseVersion: 'v',
      repoMerge: [{ repo: 'web', mergeOnDone: null }],
    });
    expect(restored.project.repos[0]).not.toHaveProperty('mergeOnDone');
    expect(original.project.repos[0]).not.toHaveProperty('mergeOnDone');
    expect(
      configPatchIssues(original, { baseVersion: 'v', repoMerge: [{ repo: 'missing', mergeOnDone: true }] }),
    ).toEqual([{ code: 'unknown_repo', path: 'repoMerge.0.repo', detail: 'missing' }]);
    expect(
      PatchConfigRequest.safeParse({
        ...edit,
        repoMerge: Array.from({ length: 21 }, () => edit.repoMerge[0]),
      }).success,
    ).toBe(false);
  });
  it('accepts persisted merge states and rejects oversized diagnostics', () => {
    const row = {
      id: 'm',
      repo: 'web',
      base: 'main',
      commit: 'c',
      branch: 'b',
      toStageId: 'done',
      requestedBy: 'owner',
      state: 'blocked',
      step: 'checking',
      startedAt: 'now',
      landed: 'remote',
      block: { reason: 'check_error', message: 'failed', at: 'now' },
    };
    expect(TaskMergeState.safeParse(row).success).toBe(true);
    expect(
      TaskMergeState.safeParse({ ...row, block: { ...row.block, detail: 'x'.repeat(8001) } }).success,
    ).toBe(false);
    expect(
      TaskMerged.safeParse({
        mergeCommit: 'm',
        commit: 'c',
        repo: 'web',
        base: 'main',
        at: 'now',
        by: 'owner',
      }).success,
    ).toBe(true);
  });
});
