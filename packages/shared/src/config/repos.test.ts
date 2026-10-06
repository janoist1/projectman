import { describe, expect, it } from 'vitest';
import { roleUsesWorktree } from './duties';
import { effectiveRepo, needsRepoChoice, repoOf, repoRequired } from './repos';
import { ProjectConfig, RepoConfig } from './schema';

describe('fullTestAtMerge configuration', () => {
  it('leaves older repositories unchanged when the field is absent', () => {
    expect(RepoConfig.parse({ name: 'app', path: '.' })).not.toHaveProperty('fullTestAtMerge');
  });

  it.each([true, false])('preserves the explicit value %s', (fullTestAtMerge) => {
    expect(RepoConfig.parse({ name: 'app', path: '.', fullTestAtMerge }).fullTestAtMerge).toBe(
      fullTestAtMerge,
    );
  });

  it('rejects a non-boolean policy', () => {
    expect(RepoConfig.safeParse({ name: 'app', path: '.', fullTestAtMerge: 'true' }).success).toBe(false);
  });
});

/** A project with the given repositories, a developer, a code reviewer and a custom role. */
function project(repos: string[]): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: {
      key: 'EX',
      name: 'Example',
      workspacePath: '/work/example',
      repos: repos.map((name) => ({ name, path: name })),
    },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
        { kind: 'ai', handle: 'dev', displayName: 'Dev', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'review', displayName: 'Review', role: 'code_review', sponsor: 'owner' },
      ],
      roles: [
        {
          id: 'data_writer',
          name: 'Data writer',
          summary: 'Writes the reference data.',
          duties: ['maintenance'],
        },
        { id: 'note_taker', name: 'Note taker', summary: 'Keeps notes.', duties: ['scheduling'] },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'work', name: 'Work', kind: 'work', duty: 'implementation', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

const none = { repo: null };

describe('effectiveRepo', () => {
  it('is the task’s own repository, whatever the project has', () => {
    for (const repos of [[], ['web'], ['web', 'api']])
      expect(effectiveRepo(project(repos), { repo: 'api' }), repos.join()).toBe('api');
  });

  it('is the only repository of a one-repository project when the task names none', () => {
    expect(effectiveRepo(project(['web']), none)).toBe('web');
  });

  it('is none when the project has several repositories and the task names none', () => {
    expect(effectiveRepo(project(['web', 'api']), none)).toBeNull();
    expect(effectiveRepo(project(['web', 'api', 'infra']), none)).toBeNull();
  });

  it('is none when the project has no repository', () => {
    expect(effectiveRepo(project([]), none)).toBeNull();
  });

  it('is none for work that is not a task', () => {
    for (const repos of [[], ['web'], ['web', 'api']]) {
      expect(effectiveRepo(project(repos), null), repos.join()).toBeNull();
      expect(effectiveRepo(project(repos), undefined), repos.join()).toBeNull();
    }
  });

  it('keeps a repository that the configuration does not know, so that its user can refuse it', () => {
    expect(effectiveRepo(project(['web']), { repo: 'gone' })).toBe('gone');
    expect(repoOf(project(['web']), 'gone')).toBeUndefined();
  });
});

describe('needsRepoChoice', () => {
  it('holds only for a task without a repository in a project with several', () => {
    expect(needsRepoChoice(project(['web', 'api']), none)).toBe(true);
    expect(needsRepoChoice(project(['web', 'api']), { repo: 'web' })).toBe(false);
    expect(needsRepoChoice(project(['web']), none)).toBe(false);
    expect(needsRepoChoice(project([]), none)).toBe(false);
    expect(needsRepoChoice(project(['web', 'api']), null)).toBe(false);
  });
});

describe('repoOf', () => {
  it('finds a configured repository by name', () => {
    const config = project(['web', 'api']);
    expect(repoOf(config, 'api')).toMatchObject({ name: 'api', path: 'api' });
    expect(repoOf(config, 'other')).toBeUndefined();
    expect(repoOf(config, null)).toBeUndefined();
    expect(repoOf(config, undefined)).toBeUndefined();
    expect(repoOf(config, '')).toBeUndefined();
  });
});

describe('repoRequired', () => {
  const several = project(['web', 'api']);

  it('holds for a role that changes files on a task without a repository in a project with several', () => {
    expect(repoRequired(several, 'developer', none)).toBe(true);
    // The roles whose duties change files all work in a worktree.
    for (const role of ['designer', 'maintainer', 'docs', 'translator', 'content', 'data_writer'])
      expect(repoRequired(several, role, none), role).toBe(true);
  });

  it('lets roles that only read run in the workspace root', () => {
    for (const role of ['code_review', 'security_review', 'architect', 'researcher', 'qa', 'note_taker'])
      expect(repoRequired(several, role, none), role).toBe(false);
  });

  it('does not hold when the task has a repository, the project has one or none, or there is no task', () => {
    expect(repoRequired(several, 'developer', { repo: 'web' })).toBe(false);
    expect(repoRequired(project(['web']), 'developer', none)).toBe(false);
    expect(repoRequired(project([]), 'developer', none)).toBe(false);
    expect(repoRequired(several, 'developer', null)).toBe(false);
  });

  it('follows the duties the team gave the role', () => {
    const config = project(['web', 'api']);
    config.team.roleOverrides = {
      developer: { duties: ['code_review'], instructions: '' },
      code_review: { duties: ['implementation'], instructions: '' },
    };
    expect(repoRequired(config, 'developer', none)).toBe(false);
    expect(repoRequired(config, 'code_review', none)).toBe(true);
  });
});

describe('roleUsesWorktree', () => {
  it('is true for the roles whose duties have the task worktree tool policy', () => {
    const config = project([]);
    expect(roleUsesWorktree(config, 'developer')).toBe(true);
    expect(roleUsesWorktree(config, 'data_writer')).toBe(true);
    expect(roleUsesWorktree(config, 'code_review')).toBe(false);
    expect(roleUsesWorktree(config, 'note_taker')).toBe(false);
    expect(roleUsesWorktree(config, 'no_such_role')).toBe(false);
  });
});
