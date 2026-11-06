import { describe, expect, it } from 'vitest';
import { ComputeJobDefinition, isComputeJobWorkflow } from '../domain/compute-job';
import { applyConfigPatch, PatchConfigRequest, unknownPatchRepo } from './edit';
import { operatorConfigVerdict } from './operator';
import { ownerOnlyChanges } from './owner-only';
import { ProjectConfig } from './schema';

const JOB = {
  id: 'cloud-image',
  command: 'npm run build',
  runsOn: 'ubuntu-24.04-arm' as const,
  outputs: ['image.tar'],
};

function config(): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: {
      key: 'AR',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: [
        { name: 'web', path: '.', github: 'acme/web', computeJobs: [JOB] },
        { name: 'api', path: 'api', github: 'acme/api' },
      ],
    },
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

const parse = (patch: object) => PatchConfigRequest.parse({ baseVersion: 'v1', ...patch });

describe('repoComputeJobs patch (PM-1148)', () => {
  it('sets, replaces and removes the jobs of a repository, leaving the others', () => {
    const next = applyConfigPatch(
      config(),
      parse({
        repoComputeJobs: [
          { repo: 'web', computeJobs: [{ ...JOB, id: 'other', timeoutMinutes: 10 }] },
          { repo: 'api', computeJobs: [JOB] },
        ],
      }),
    );
    expect(next.project.repos[0]?.computeJobs).toEqual([{ ...JOB, id: 'other', timeoutMinutes: 10 }]);
    expect(next.project.repos[1]?.computeJobs).toEqual([{ ...JOB, timeoutMinutes: 60 }]);

    const removed = applyConfigPatch(next, parse({ repoComputeJobs: [{ repo: 'web', computeJobs: null }] }));
    expect('computeJobs' in removed.project.repos[0]!).toBe(false);
    expect(removed.project.repos[1]?.computeJobs).toHaveLength(1);
  });

  it('refuses duplicate job ids and unknown keys', () => {
    const safe = (entry: object) =>
      PatchConfigRequest.safeParse({ baseVersion: 'v1', repoComputeJobs: [entry] });
    expect(safe({ repo: 'web', computeJobs: [JOB, JOB] }).success).toBe(false);
    expect(safe({ repo: 'web', computeJobs: null, extra: 1 }).success).toBe(false);
  });

  it('takes a dedicated workflow only from the fixed list, and an old job without one unchanged (PM-1196)', () => {
    expect(ComputeJobDefinition.parse(JOB)).not.toHaveProperty('workflow');
    expect(ComputeJobDefinition.parse({ ...JOB, workflow: 'projectman-deploy.yml' }).workflow).toBe(
      'projectman-deploy.yml',
    );
    for (const workflow of ['projectman-job.yml', 'other.yml', ''])
      expect(ComputeJobDefinition.safeParse({ ...JOB, workflow }).success).toBe(false);
    expect(isComputeJobWorkflow('projectman-job.yml')).toBe(true);
    expect(isComputeJobWorkflow('projectman-engine-release.yml')).toBe(true);
    expect(isComputeJobWorkflow('merge-check.yml')).toBe(false);
  });

  it('names an unknown repository', () => {
    expect(
      unknownPatchRepo(config(), parse({ repoComputeJobs: [{ repo: 'web', computeJobs: null }] })),
    ).toBeNull();
    expect(
      unknownPatchRepo(config(), parse({ repoComputeJobs: [{ repo: 'ghost', computeJobs: null }] })),
    ).toBe('ghost');
  });
});

describe('compute_jobs owner-only change (PM-1148)', () => {
  const edited = (edit: (repos: ProjectConfig['project']['repos']) => void) => {
    const next = config();
    edit(next.project.repos);
    return ownerOnlyChanges(config(), next);
  };

  it.each<[string, (repos: ProjectConfig['project']['repos']) => void]>([
    ['the command', (r) => (r[0]!.computeJobs![0]!.command = 'npm run other')],
    ['the runner', (r) => (r[0]!.computeJobs![0]!.runsOn = 'macos-15')],
    ['the outputs', (r) => (r[0]!.computeJobs![0]!.outputs = ['other.tar'])],
    ['removing the jobs', (r) => delete r[0]!.computeJobs],
    ['adding a job', (r) => (r[1]!.computeJobs = [{ ...JOB, timeoutMinutes: 60 }])],
  ])('is reported for %s', (_name, edit) => {
    expect(edited(edit)).toEqual(['compute_jobs']);
  });

  it('is not reported for a restated value or another repository setting', () => {
    expect(edited((r) => (r[0]!.requireMerge = false))).toEqual([]);
    const restated = applyConfigPatch(
      config(),
      parse({ repoComputeJobs: [{ repo: 'web', computeJobs: [JOB] }] }),
    );
    expect(ownerOnlyChanges(config(), restated)).toEqual([]);
  });
});

describe('the Operator changing compute jobs (PM-1148)', () => {
  it('needs the approval and names the repository', () => {
    const before = config();
    const next = applyConfigPatch(before, parse({ repoComputeJobs: [{ repo: 'web', computeJobs: null }] }));
    const verdict = operatorConfigVerdict(before, next, { operator: 'operator' });
    expect(verdict.level).toBe('approval');
    expect(verdict.changes.map((c) => [c.area, c.target, c.field])).toEqual([
      ['repos', 'web', 'computeJobs'],
    ]);
  });
});
