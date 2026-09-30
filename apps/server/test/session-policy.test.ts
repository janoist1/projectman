import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_IDS } from '@projectman/shared';
import { testTemplate } from './helpers/test-template';
import { aiRoleDefaults } from '@projectman/templates';
import {
  allowedToolsFor,
  DEVELOPMENT_TOOLS,
  LOCAL_ONLY_DENIED_TOOLS,
  deniedToolsFor,
  commandVerdict,
  READ_ONLY_REVIEW_TOOLS,
  ROLE_SESSION_POLICIES,
  TEAM_TOOLS_ALLOWED,
  usesWorktree,
  WORKTREE_ROLES,
} from '../src/domain';

describe('role session policy', () => {
  it('pre-approves list_tasks alongside get_task for every AI role', () => {
    for (const role of [...AI_BUILT_IN_ROLE_IDS, 'data_steward']) {
      expect(allowedToolsFor(role)).toContain('mcp__team__*');
    }
  });

  it('covers every built-in role', () => {
    expect(Object.keys(ROLE_SESSION_POLICIES).sort()).toEqual([...BUILT_IN_ROLE_IDS].sort());
  });

  it('pre-approves the read-only tools for review and research roles', () => {
    const readers = BUILT_IN_ROLE_IDS.filter((role) => ROLE_SESSION_POLICIES[role].readOnlyTools);
    expect(readers).toContain('code_review');
    expect(readers).toContain('devops');
    expect(allowedToolsFor('architect')).toEqual([...TEAM_TOOLS_ALLOWED, ...READ_ONLY_REVIEW_TOOLS]);
    expect(allowedToolsFor('developer')).toEqual([...TEAM_TOOLS_ALLOWED, ...DEVELOPMENT_TOOLS]);
  });

  it('runs the roles that change files in the task worktree, with edits accepted', () => {
    expect([...WORKTREE_ROLES].sort()).toEqual(
      ['content', 'designer', 'developer', 'docs', 'maintainer', 'translator'].sort(),
    );
    for (const role of AI_BUILT_IN_ROLE_IDS) {
      expect(aiRoleDefaults(role).permissionMode === 'acceptEdits', role).toBe(WORKTREE_ROLES.has(role));
      // Nobody both changes files and gets the review tools pre-approved.
      expect(ROLE_SESSION_POLICIES[role].readOnlyTools && usesWorktree(role), role).toBe(false);
    }
  });

  it('gives custom roles the team tools only, in the workspace', () => {
    expect(allowedToolsFor('data_steward')).toEqual(TEAM_TOOLS_ALLOWED);
    expect(usesWorktree('data_steward')).toBe(false);
  });
});

const config = testTemplate.build({
  key: 'AR',
  name: 'Fictional project',
  workspacePath: '/workspace',
  language: 'en',
  owner: { handle: 'owner', displayName: 'Example Owner', email: 'owner@example.com' },
});
config.project.repos.push({ name: 'local', path: 'local', defaultBranch: 'main' });
const cwd = '/worktrees/AR/AR-1-local';
const input = {
  config,
  session: { cwd, role: 'developer' },
  task: { repo: 'local' },
  toolName: 'Bash',
  worktreesRootDir: '/worktrees',
};
const verdict = (command: string) => commandVerdict({ ...input, toolInput: { command } });

describe('automatic command policy', () => {
  it('only refuses publishing rules for a configured local-only task repository', () => {
    expect(deniedToolsFor(config, { repo: 'local' })).toEqual(LOCAL_ONLY_DENIED_TOOLS);
    for (const task of [null, { repo: null }, { repo: 'web' }, { repo: 'missing' }])
      expect(deniedToolsFor(config, task)).toEqual([]);
    expect(DEVELOPMENT_TOOLS).toContain('Bash(npm install)');
    expect(DEVELOPMENT_TOOLS).toContain('Bash(npm ci)');
    expect(DEVELOPMENT_TOOLS).not.toContain('Bash(npm install:*)');
  });

  it.each([
    'git push',
    'git push origin HEAD',
    'cd /workspace && git push origin main',
    'gh pr create --title "Example"',
    'gh pr merge 12',
    'npm test && git push',
    'git\tpush',
    'git commit -m "Example" && gh pr create',
  ])('denies local-only publishing: %s', (command) => {
    expect(verdict(command)).toEqual({
      behavior: 'deny',
      message: 'The owner has not allowed publishing from this repository.',
    });
  });

  it.each([
    'git commit -m "Document git push"',
    "git commit -m 'Document gh pr create and gh pr merge'",
    String.raw`git commit -m "Mention \"git push\" in docs"`,
    'echo "git push"',
    'git pushy',
    'gh pr view 12',
    'git status',
  ])('does not treat quoted prose or other commands as publishing: %s', (command) => {
    expect(verdict(command)).toBeNull();
  });

  it('leaves publishing from GitHub repositories for a human, regardless of cwd', () => {
    expect(
      commandVerdict({ ...input, task: { repo: 'web' }, toolInput: { command: 'git push' } }),
    ).toBeNull();
    expect(
      commandVerdict({
        ...input,
        session: { cwd: '/workspace', role: 'code_review' },
        toolInput: { command: 'git push' },
      })?.behavior,
    ).toBe('deny');
  });

  it.each([
    'npm ci',
    'npm install',
    ' npm ci ',
    'npm\tci',
    'npm ci --prefer-offline --no-audit --no-fund',
    'npm install --no-fund --no-audit',
    `cd ${cwd} && npm ci`,
    `cd '${cwd}' && npm install`,
    `cd "${cwd}" && npm ci --no-audit`,
    'cd . && npm ci',
  ])('allows lockfile installs in the worktree: %s', (command) => {
    expect(verdict(command)).toEqual({ behavior: 'allow' });
  });

  it.each([
    'npm install left-pad',
    'npm ci --ignore-scripts',
    'npm install --save left-pad',
    'cd /elsewhere && npm ci',
    'cd .. && npm ci',
    'cd "$PWD" && npm ci',
    'npm ci; echo done',
    'npm ci | cat',
    'npm ci > /elsewhere/log',
    'npm ci\necho done',
    'npm\nci',
    'npm ci &',
    'env npm ci',
    `cd ${cwd} && cd ${cwd} && npm ci`,
    'npm ci --no-audit=true',
  ])('leaves wider installs and shell commands for a human: %s', (command) => {
    expect(verdict(command)).toBeNull();
  });

  it('does not allow installs outside the root, without a task or for a review role', () => {
    for (const cwd of ['/workspace', '/worktrees', '/worktrees-other/AR/AR-1', '/worktrees/../outside'])
      expect(
        commandVerdict({ ...input, session: { cwd, role: 'developer' }, toolInput: { command: 'npm ci' } }),
      ).toBeNull();
    expect(commandVerdict({ ...input, task: null, toolInput: { command: 'npm ci' } })).toBeNull();
    expect(
      commandVerdict({ ...input, worktreesRootDir: undefined, toolInput: { command: 'npm ci' } }),
    ).toBeNull();
    expect(
      commandVerdict({ ...input, session: { cwd, role: 'code_review' }, toolInput: { command: 'npm ci' } }),
    ).toBeNull();
  });

  it('ignores non-Bash tools and malformed command inputs', () => {
    expect(commandVerdict({ ...input, toolName: 'Read', toolInput: { command: 'git push' } })).toBeNull();
    for (const toolInput of [null, 'git push', {}, { command: 42 }])
      expect(commandVerdict({ ...input, toolInput })).toBeNull();
  });
});
