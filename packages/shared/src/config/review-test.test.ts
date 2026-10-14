import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest, unknownPatchRepo } from './edit';
import { operatorConfigVerdict } from './operator';
import { ownerOnlyChanges } from './owner-only';
import { ProjectConfig } from './schema';

function config(repos: object[]): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos },
    team: {
      limits: {},
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        { kind: 'ai', handle: 'operator', displayName: 'Operator', role: 'ai_operator', sponsor: 'owner' },
      ],
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      labels: [],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
    },
  });
}

const two = () =>
  config([
    { name: 'web', path: '.', requireMerge: true, docs: { roadmap: 'R.md' } },
    {
      name: 'api',
      path: 'api',
      reviewTest: { command: 'npm test', maxWorkers: 3, timeoutMinutes: 20 },
      fullTestAtMerge: true,
    },
  ]);

const parse = (patch: object) => PatchConfigRequest.parse({ baseVersion: 'v1', ...patch });

describe('repoReviewTest and repoFullTestAtMerge patch', () => {
  it('sets, replaces and removes a full test, leaving the other fields', () => {
    const next = applyConfigPatch(
      two(),
      parse({
        repoReviewTest: [
          { repo: 'web', reviewTest: { command: 'npm run merge-test', maxWorkers: 4, timeoutMinutes: 30 } },
          { repo: 'api', reviewTest: null },
        ],
      }),
    );
    expect(next.project.repos[0]).toMatchObject({
      name: 'web',
      requireMerge: true,
      docs: { roadmap: 'R.md' },
      reviewTest: { command: 'npm run merge-test', maxWorkers: 4, timeoutMinutes: 30 },
    });
    expect('reviewTest' in next.project.repos[1]!).toBe(false);
    expect(next.project.repos[1]?.fullTestAtMerge).toBe(true);
  });

  it('replaces the whole object: missing numbers come back as the schema defaults, the command is trimmed', () => {
    const next = applyConfigPatch(
      two(),
      parse({ repoReviewTest: [{ repo: 'api', reviewTest: { command: '  npm test  ' } }] }),
    );
    expect(next.project.repos[1]?.reviewTest).toEqual({
      command: 'npm test',
      maxWorkers: 2,
      timeoutMinutes: 15,
    });
  });

  it('sets fullTestAtMerge, stores an explicit false and removes it with null', () => {
    const next = applyConfigPatch(
      two(),
      parse({
        repoFullTestAtMerge: [
          { repo: 'web', fullTestAtMerge: false },
          { repo: 'api', fullTestAtMerge: null },
        ],
      }),
    );
    expect(next.project.repos[0]?.fullTestAtMerge).toBe(false);
    expect('fullTestAtMerge' in next.project.repos[1]!).toBe(false);
    expect(next.project.repos[1]?.reviewTest).toBeDefined();
  });

  it('lets the last entry for a repository win and leaves the repositories it does not name', () => {
    const next = applyConfigPatch(
      two(),
      parse({
        repoReviewTest: [
          { repo: 'web', reviewTest: { command: 'first' } },
          { repo: 'web', reviewTest: { command: 'second' } },
        ],
      }),
    );
    expect(next.project.repos[0]?.reviewTest?.command).toBe('second');
    expect(next.project.repos[1]).toEqual(two().project.repos[1]);
  });

  it('applies together with repoMerge and repoDocs', () => {
    const next = applyConfigPatch(
      two(),
      parse({
        repoMerge: [{ repo: 'web', requireMerge: null }],
        repoDocs: [{ repo: 'web', docs: null }],
        repoReviewTest: [{ repo: 'web', reviewTest: { command: 'x' } }],
        repoFullTestAtMerge: [{ repo: 'web', fullTestAtMerge: true }],
      }),
    );
    expect(next.project.repos[0]).toEqual({
      name: 'web',
      path: '.',
      defaultBranch: 'main',
      reviewTest: { command: 'x', maxWorkers: 2, timeoutMinutes: 15 },
      fullTestAtMerge: true,
    });
  });

  it('parses strictly', () => {
    const reviewTest = (value: unknown) =>
      PatchConfigRequest.safeParse({
        baseVersion: 'v1',
        repoReviewTest: [{ repo: 'web', reviewTest: value }],
      }).success;
    expect(reviewTest({ command: 'npm test' })).toBe(true);
    expect(reviewTest(null)).toBe(true);
    expect(reviewTest({ command: 'npm test', extra: 1 })).toBe(false);
    expect(reviewTest({ command: '   ' })).toBe(false);
    expect(reviewTest({ command: 'x'.repeat(501) })).toBe(false);
    expect(reviewTest({ command: 'x', maxWorkers: 0 })).toBe(false);
    expect(reviewTest({ command: 'x', maxWorkers: 9 })).toBe(false);
    expect(reviewTest({ command: 'x', maxWorkers: 1.5 })).toBe(false);
    expect(reviewTest({ command: 'x', timeoutMinutes: 0 })).toBe(false);
    expect(reviewTest({ command: 'x', timeoutMinutes: 61 })).toBe(false);
    expect(reviewTest({ command: 'x', maxWorkers: 8, timeoutMinutes: 60 })).toBe(true);
    expect(
      PatchConfigRequest.safeParse({
        baseVersion: 'v1',
        repoReviewTest: [{ repo: 'web', reviewTest: null, extra: 1 }],
      }).success,
    ).toBe(false);
    expect(
      PatchConfigRequest.safeParse({
        baseVersion: 'v1',
        repoFullTestAtMerge: [{ repo: 'web', fullTestAtMerge: 'yes' }],
      }).success,
    ).toBe(false);
    expect(
      PatchConfigRequest.safeParse({
        baseVersion: 'v1',
        repoFullTestAtMerge: Array.from({ length: 21 }, (_, i) => ({ repo: `r${i}`, fullTestAtMerge: null })),
      }).success,
    ).toBe(false);
  });

  it('names the first unknown repository in the order of the fields', () => {
    expect(
      unknownPatchRepo(two(), parse({ repoReviewTest: [{ repo: 'web', reviewTest: null }] })),
    ).toBeNull();
    expect(unknownPatchRepo(two(), parse({ repoReviewTest: [{ repo: 'ghost', reviewTest: null }] }))).toBe(
      'ghost',
    );
    expect(
      unknownPatchRepo(two(), parse({ repoFullTestAtMerge: [{ repo: 'ghost', fullTestAtMerge: true }] })),
    ).toBe('ghost');
    expect(
      unknownPatchRepo(
        two(),
        parse({
          repoFullTestAtMerge: [{ repo: 'ghost-b', fullTestAtMerge: true }],
          repoReviewTest: [{ repo: 'ghost-a', reviewTest: null }],
        }),
      ),
    ).toBe('ghost-a');
  });
});

describe('review_test owner-only change', () => {
  const edited = (edit: (repos: ProjectConfig['project']['repos']) => void) => {
    const next = two();
    edit(next.project.repos);
    return ownerOnlyChanges(two(), next);
  };

  it.each<[string, (repos: ProjectConfig['project']['repos']) => void]>([
    ['the command', (r) => (r[1]!.reviewTest = { command: 'npm run x', maxWorkers: 3, timeoutMinutes: 20 })],
    ['maxWorkers', (r) => (r[1]!.reviewTest = { command: 'npm test', maxWorkers: 4, timeoutMinutes: 20 })],
    [
      'timeoutMinutes',
      (r) => (r[1]!.reviewTest = { command: 'npm test', maxWorkers: 3, timeoutMinutes: 21 }),
    ],
    ['removing the test', (r) => delete r[1]!.reviewTest],
    ['adding a test', (r) => (r[0]!.reviewTest = { command: 'true', maxWorkers: 2, timeoutMinutes: 15 })],
    ['fullTestAtMerge turned off', (r) => (r[1]!.fullTestAtMerge = false)],
    ['fullTestAtMerge turned on', (r) => (r[0]!.fullTestAtMerge = true)],
  ])('is reported for %s', (_name, edit) => {
    expect(edited(edit)).toEqual(['review_test']);
  });

  it('is reported for a new repository that comes with a test', () => {
    const next = two();
    next.project.repos.push({
      name: 'new',
      path: 'new',
      defaultBranch: 'main',
      reviewTest: { command: 'true', maxWorkers: 2, timeoutMinutes: 15 },
    });
    expect(ownerOnlyChanges(two(), next)).toEqual(['locations', 'review_test']);
  });

  it('is not reported for requireMerge, docs, a restated default, a new repository without a test', () => {
    expect(edited((r) => (r[0]!.requireMerge = false))).toEqual([]);
    expect(edited((r) => (r[0]!.docs = { decisions: 'D.md' }))).toEqual([]);
    expect(edited((r) => (r[0]!.fullTestAtMerge = false))).toEqual([]);
    const restated = applyConfigPatch(
      two(),
      parse({
        repoReviewTest: [
          { repo: 'api', reviewTest: { command: 'npm test', maxWorkers: 3, timeoutMinutes: 20 } },
        ],
      }),
    );
    expect(ownerOnlyChanges(two(), restated)).toEqual([]);
    const withDefaults = applyConfigPatch(
      config([{ name: 'web', path: '.', reviewTest: { command: 'x' } }]),
      parse({
        repoReviewTest: [{ repo: 'web', reviewTest: { command: 'x', maxWorkers: 2, timeoutMinutes: 15 } }],
      }),
    );
    expect(
      ownerOnlyChanges(config([{ name: 'web', path: '.', reviewTest: { command: 'x' } }]), withDefaults),
    ).toEqual([]);
    const added = two();
    added.project.repos.push({ name: 'new', path: 'new', defaultBranch: 'main' });
    expect(ownerOnlyChanges(two(), added)).toEqual(['locations']);
  });
});

describe('the Operator changing a full test', () => {
  it('needs the approval and shows before and after', () => {
    const before = two();
    const next = applyConfigPatch(
      before,
      parse({
        repoReviewTest: [{ repo: 'api', reviewTest: { command: 'npm run merge-test', maxWorkers: 4 } }],
      }),
    );
    const verdict = operatorConfigVerdict(before, next, { operator: 'operator' });
    expect(verdict.level).toBe('approval');
    expect(verdict.changes).toEqual([
      expect.objectContaining({
        area: 'repos',
        target: 'api',
        field: 'reviewTest',
        before: '{"command":"npm test","maxWorkers":3,"timeoutMinutes":20}',
        after: '{"command":"npm run merge-test","maxWorkers":4,"timeoutMinutes":15}',
        level: 'approval',
      }),
    ]);
  });

  it('shows the removal and the fullTestAtMerge change', () => {
    const before = two();
    const next = applyConfigPatch(
      before,
      parse({
        repoReviewTest: [{ repo: 'api', reviewTest: null }],
        repoFullTestAtMerge: [{ repo: 'api', fullTestAtMerge: null }],
      }),
    );
    const verdict = operatorConfigVerdict(before, next, { operator: 'operator' });
    expect(verdict.level).toBe('approval');
    expect(verdict.changes.map((c) => [c.area, c.target, c.field]).sort()).toEqual([
      ['repos', 'api', 'fullTestAtMerge'],
      ['repos', 'api', 'reviewTest'],
    ]);
  });
});
