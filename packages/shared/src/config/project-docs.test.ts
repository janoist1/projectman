import { describe, expect, it } from 'vitest';
import { applyConfigPatch, PatchConfigRequest, unknownPatchRepo } from './edit';
import { operatorConfigVerdict } from './operator';
import { isRepoFilePath, projectDocsOf, RepoDocs } from './project-docs';
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

describe('isRepoFilePath', () => {
  it('accepts relative POSIX paths inside the repository', () => {
    for (const ok of [
      'a',
      'docs/decisions.md',
      'a/b/c.txt',
      '.github/x.md',
      'a.b',
      '.gitignore',
      'x'.repeat(200),
    ])
      expect(isRepoFilePath(ok), ok).toBe(true);
  });

  it('refuses everything else', () => {
    const bad = [
      '',
      '/abs',
      '../x',
      'a/../b',
      'a/./b',
      './a',
      '.',
      '..',
      'a//b',
      'a/',
      'a\\b',
      'a\0b',
      '.git',
      '.git/config',
      'x'.repeat(201),
    ];
    for (const path of bad) expect(isRepoFilePath(path), JSON.stringify(path)).toBe(false);
  });
});

describe('RepoDocs', () => {
  it('takes a path for either document, or none', () => {
    expect(RepoDocs.parse({})).toEqual({});
    expect(RepoDocs.parse({ decisions: 'docs/D.md' })).toEqual({ decisions: 'docs/D.md' });
    expect(RepoDocs.parse({ decisions: 'D.md', roadmap: 'docs/R.md' })).toEqual({
      decisions: 'D.md',
      roadmap: 'docs/R.md',
    });
  });

  it('refuses a bad path, an unknown key and one file for both documents', () => {
    expect(RepoDocs.safeParse({ decisions: '../x' }).success).toBe(false);
    expect(RepoDocs.safeParse({ roadmap: '/etc/passwd' }).success).toBe(false);
    expect(RepoDocs.safeParse({ decisions: '' }).success).toBe(false);
    expect(RepoDocs.safeParse({ other: 'a.md' }).success).toBe(false);
    expect(RepoDocs.safeParse({ decisions: 'same.md', roadmap: 'same.md' }).success).toBe(false);
  });

  it('is off in a repository by default', () => {
    expect(config([{ name: 'web', path: '.' }]).project.repos[0]).not.toHaveProperty('docs');
  });
});

describe('projectDocsOf', () => {
  it('is null when no repository has a path', () => {
    expect(projectDocsOf(config([]))).toBeNull();
    expect(projectDocsOf(config([{ name: 'web', path: '.' }]))).toBeNull();
    expect(projectDocsOf(config([{ name: 'web', path: '.', docs: {} }]))).toBeNull();
  });

  it('gives the files of the first repository that has docs, null for a document without a path', () => {
    const c = config([
      { name: 'web', path: '.' },
      { name: 'api', path: 'api', docs: { roadmap: 'ROADMAP.md' } },
      { name: 'ops', path: 'ops', docs: { decisions: 'D.md', roadmap: 'R.md' } },
    ]);
    const found = projectDocsOf(c);
    expect(found?.repo.name).toBe('api');
    expect(found).toMatchObject({ decisions: null, roadmap: 'ROADMAP.md' });
  });
});

describe('repoDocs patch', () => {
  const two = () =>
    config([
      { name: 'web', path: '.', requireMerge: true },
      { name: 'api', path: 'api', docs: { decisions: 'old.md' } },
    ]);

  it('sets docs on a repository and clears them with null, leaving the other fields', () => {
    const patch = PatchConfigRequest.parse({
      baseVersion: 'v1',
      repoDocs: [
        { repo: 'web', docs: { decisions: 'docs/D.md', roadmap: 'docs/R.md' } },
        { repo: 'api', docs: null },
      ],
    });
    const next = applyConfigPatch(two(), patch);
    expect(next.project.repos[0]).toMatchObject({
      name: 'web',
      requireMerge: true,
      docs: { decisions: 'docs/D.md', roadmap: 'docs/R.md' },
    });
    expect('docs' in next.project.repos[1]!).toBe(false);
    expect(projectDocsOf(next)?.repo.name).toBe('web');
  });

  it('applies together with repoMerge and leaves repositories it does not name', () => {
    const patch = PatchConfigRequest.parse({
      baseVersion: 'v1',
      repoMerge: [{ repo: 'web', requireMerge: null }],
      repoDocs: [{ repo: 'web', docs: { roadmap: 'R.md' } }],
    });
    const next = applyConfigPatch(two(), patch);
    expect(next.project.repos[0]).toEqual({
      name: 'web',
      path: '.',
      defaultBranch: 'main',
      docs: { roadmap: 'R.md' },
    });
    expect(next.project.repos[1]).toEqual(two().project.repos[1]);
  });

  it('refuses a bad path, an unknown key and more than 20 repositories', () => {
    const parse = (repoDocs: unknown) =>
      PatchConfigRequest.safeParse({ baseVersion: 'v1', repoDocs }).success;
    expect(parse([{ repo: 'web', docs: { decisions: '../x' } }])).toBe(false);
    expect(parse([{ repo: 'web', docs: { decisions: 'a', roadmap: 'a' } }])).toBe(false);
    expect(parse([{ repo: 'web', docs: null, extra: 1 }])).toBe(false);
    expect(parse(Array.from({ length: 21 }, (_, i) => ({ repo: `r${i}`, docs: null })))).toBe(false);
    expect(parse([{ repo: 'web', docs: {} }])).toBe(true);
  });

  it('names a repository the project does not have, like repoMerge', () => {
    const known = PatchConfigRequest.parse({ baseVersion: 'v1', repoDocs: [{ repo: 'web', docs: null }] });
    const unknown = PatchConfigRequest.parse({
      baseVersion: 'v1',
      repoMerge: [{ repo: 'web', requireMerge: true }],
      repoDocs: [{ repo: 'ghost', docs: { roadmap: 'R.md' } }],
    });
    expect(unknownPatchRepo(two(), known)).toBeNull();
    expect(unknownPatchRepo(two(), unknown)).toBe('ghost');
  });

  it('is a change that needs the approval when the Operator makes it', () => {
    const before = two();
    const next = applyConfigPatch(
      before,
      PatchConfigRequest.parse({ baseVersion: 'v1', repoDocs: [{ repo: 'web', docs: { roadmap: 'R.md' } }] }),
    );
    const verdict = operatorConfigVerdict(before, next, { operator: 'operator' });
    expect(verdict.level).toBe('approval');
    expect(verdict.changes).toEqual([
      expect.objectContaining({
        area: 'repos',
        target: 'web',
        field: 'docs',
        before: null,
        level: 'approval',
      }),
    ]);
  });
});
