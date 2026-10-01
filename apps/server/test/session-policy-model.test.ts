import { describe, expect, it } from 'vitest';
import { roleSessionAccess } from '@projectman/shared';
import type { SessionPolicy, StartSessionSpec } from '../src/contracts';
import { buildSessionPolicy } from '../src/domain/session-policy';
import { buildSettings, buildClaudeArgs } from '../src/runner/providers/claude/args';
import { buildCodexArgs, tomlValue } from '../src/runner/providers/codex/args';
import { testConfig } from './helpers/test-template';

const source = '/fictional/source';
const copy = '/fictional/reviews/round-1';
const sharedGit = '/fictional/repo/.git';

function policy(role: string, placement: SessionPolicy['placement'], permissionMode = 'acceptEdits') {
  return buildSessionPolicy({
    config: testConfig(),
    role,
    task: { repo: 'web' },
    placement,
    permissionMode,
    protectedPaths: ['/fictional/live', '/fictional/other-task', sharedGit],
  });
}
const development = () => policy('developer', { kind: 'task_worktree', path: source, gitDir: sharedGit });
const review = () =>
  policy('code_review', {
    kind: 'review_copy',
    path: copy,
    gitDir: `${copy}/.git`,
    sourceCommit: 'a'.repeat(40),
    roundId: 'round-1',
  });

function spec(policy: SessionPolicy, resume: boolean): StartSessionSpec {
  return {
    sessionId: 'ses_test',
    claudeSessionId: 'conversation',
    resume,
    cwd: policy.placement.path,
    displayName: 'Fictional member',
    appendSystemPrompt: '',
    mcpUrl: 'http://127.0.0.1/mcp/fake',
    // Obsolete inputs must not widen a policy, even on resume.
    permissionMode: 'bypassPermissions',
    writableRoots: ['/fictional/other-task', sharedGit],
    allowedTools: ['Bash(*)', 'mcp__team__*'],
    deniedTools: [],
    policy,
  };
}
function codexOverrides(args: string[]) {
  return new Map(
    args.flatMap((arg, index) => {
      if (args[index - 1] !== '-c') return [];
      const equal = arg.indexOf('=');
      return [[arg.slice(0, equal), arg.slice(equal + 1)]];
    }),
  );
}

describe('provider-neutral session policy', () => {
  it('refuses unsupported strict enforcement instead of rendering a weaker profile', () => {
    const p: SessionPolicy = { ...development(), enforcement: 'strict', outsideSandbox: 'deny' };
    expect(() =>
      buildSettings({ hookUrl: 'http://fake/hooks', permissionTimeoutMs: 1000, allowedTools: [], policy: p }),
    ).toThrow(/refusing to start/);
    const s = spec(p, false);
    expect(() =>
      buildCodexArgs({ spec: s, realCwd: s.cwd, hookUrl: 'http://fake/hooks', permissionTimeoutMs: 1000 }),
    ).toThrow(/refusing to start/);
  });
  it('isolates placement intent and records independent review metadata', () => {
    expect(development().filesystem).toEqual({
      readableRoots: [source],
      writableRoots: [source],
      protectedPaths: ['/fictional/live', '/fictional/other-task', sharedGit],
    });
    const p = review();
    expect(p.placement).toMatchObject({ sourceCommit: 'a'.repeat(40), roundId: 'round-1' });
    expect(p.filesystem.writableRoots).toEqual([copy]);
    expect(p.filesystem.writableRoots).not.toContain(source);
    expect(p.filesystem.writableRoots).not.toContain(sharedGit);
    expect(p.enforcement).toBe('legacy');
    expect(p.outsideSandbox).toBe('ask');
    expect(p.network.allowedDomains).toEqual([]);
  });

  it.each(['code_review', 'security_review', 'qa'])('grants a review-copy profile to %s', (role) => {
    expect(roleSessionAccess(testConfig(), role).reviewCopy).toBe(true);
    expect(policy(role, review().placement).filesystem.writableRoots).toEqual([copy]);
  });

  it.each(['architect', 'business_analyst', 'developer'])('refuses review placement for %s', (role) => {
    expect(() => policy(role, review().placement)).toThrow(/review\/testing duty/);
  });

  it.each(['architect', 'code_review', 'qa'])(
    'cannot grant source editing through acceptEdits to %s',
    (role) => {
      const p = policy(role, { kind: 'read_only', path: source });
      expect(p.filesystem.writableRoots).toEqual([]);
      expect(p.permissions.claude).toBe('default');
      expect(p.permissions.sandbox).toBe('read-only');
      expect(() => policy(role, { kind: 'task_worktree', path: source })).toThrow(/file-changing duty/);
    },
  );

  it('resolves mixed/custom duty bundles instead of role names', () => {
    const config = testConfig();
    config.team.roles.push({
      id: 'custom',
      name: 'Example',
      duties: ['implementation', 'code_review'],
      instructions: '',
      summary: '',
      notTheirJob: '',
      holders: 'ai',
    });
    expect(roleSessionAccess(config, 'custom')).toEqual({
      worktree: true,
      readOnlyTools: true,
      reviewCopy: true,
    });
    config.team.roleOverrides = { developer: { duties: ['research'], instructions: '' } };
    expect(roleSessionAccess(config, 'developer')).toEqual({
      worktree: false,
      readOnlyTools: true,
      reviewCopy: false,
    });
  });

  it.each(['default', 'plan'])('preserves explicit stricter %s in both writable placements', (mode) => {
    for (const placement of [development().placement, review().placement]) {
      const p = policy(placement.kind === 'review_copy' ? 'qa' : 'developer', placement, mode);
      expect(p.filesystem.writableRoots).toEqual([]);
      expect(p.permissions.claude).toBe(mode);
      expect(p.permissions.sandbox).toBe('read-only');
    }
  });

  it('requires a task repository before granting a development placement', () => {
    for (const task of [null, { repo: null }]) {
      const config = testConfig();
      config.project.repos = [];
      expect(() =>
        buildSessionPolicy({ config, role: 'developer', task, placement: development().placement }),
      ).toThrow(/task repository/);
    }
    const p = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: null,
      permissionMode: 'acceptEdits',
      placement: { kind: 'read_only', path: source },
    });
    expect(p.filesystem.writableRoots).toEqual([]);
  });

  it('records local-only publishing operations independently of provider syntax', () => {
    const config = testConfig();
    delete config.project.repos[0]!.github;
    const p = buildSessionPolicy({
      config,
      role: 'developer',
      task: { repo: 'web' },
      placement: development().placement,
    });
    expect(p.deniedOperations).toEqual(['git_push', 'pull_request_create', 'pull_request_merge']);
    expect(
      buildSettings({ hookUrl: 'http://fake/hooks', permissionTimeoutMs: 1000, allowedTools: [], policy: p })
        .permissions.deny,
    ).toEqual(['Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)']);
  });

  it.each([false, true])('renders semantic grants on both providers with resume=%s', (resume) => {
    const p = review();
    p.tools.team = { all: false, names: ['get_task', 'send_message'] };
    const s = spec(p, resume);
    const settings = buildSettings({
      hookUrl: 'http://fake/hooks',
      permissionTimeoutMs: 1000,
      allowedTools: s.allowedTools,
      policy: p,
    });
    expect(settings.permissions.allow).toContain('mcp__team__get_task');
    expect(settings.permissions.allow).toContain('Bash(git diff:*)');
    expect(settings.permissions.allow).not.toContain('Bash(*)');
    expect(settings.permissions.allow).not.toContain('mcp__team__*');
    const args = buildClaudeArgs(s, settings);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const c = codexOverrides(
      buildCodexArgs({ spec: s, realCwd: s.cwd, hookUrl: 'http://fake/hooks', permissionTimeoutMs: 1000 })
        .args,
    );
    expect(c.get('mcp_servers.team')).toBe(
      tomlValue({
        url: s.mcpUrl,
        tools: {
          get_task: { approval_mode: 'approve' },
          send_message: { approval_mode: 'approve' },
        },
      }),
    );
    expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
    expect(c.has('sandbox_workspace_write.network_access')).toBe(false);
  });
});
