import { describe, expect, it } from 'vitest';
import { roleSessionAccess, sessionPermissions } from '@projectman/shared';
import type { SessionPolicy, StartSessionSpec } from '../src/contracts';
import {
  attachmentToolRules,
  buildSessionPolicy,
  sensitivePaths,
  sessionSandbox,
} from '../src/domain/session-policy';
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
    expect(p.filesystem.writableRoots).toEqual([]);
    expect(p.filesystem.writableRoots).not.toContain(source);
    expect(p.filesystem.writableRoots).not.toContain(sharedGit);
    expect(p.enforcement).toBe('legacy');
    expect(p.outsideSandbox).toBe('ask');
    expect(p.network.allowedDomains).toEqual([]);
  });

  it.each(['code_review', 'security_review', 'qa'])('grants a review-copy profile to %s', (role) => {
    expect(roleSessionAccess(testConfig(), role).reviewCopy).toBe(true);
    expect(policy(role, review().placement).filesystem.writableRoots).toEqual([]);
  });

  it.each(['architect', 'business_analyst', 'developer'])('refuses review placement for %s', (role) => {
    expect(() => policy(role, review().placement)).toThrow(/review\/testing duty/);
  });

  it.each(['architect', 'code_review', 'qa'])(
    'cannot grant source editing through acceptEdits to %s',
    (role) => {
      const p = policy(role, { kind: 'read_only', path: source });
      expect(p.filesystem.writableRoots).toEqual([]);
      // The member's mode goes to the CLI as it is (PM-167); the sandbox and the deny rules hold.
      expect(p.permissions.claude).toBe('acceptEdits');
      expect(p.permissions.sandbox).toBe('read-only');
      expect(sessionSandbox(p)?.denyWrite).toEqual([source]);
      expect(() => policy(role, { kind: 'task_worktree', path: source })).toThrow(/file-changing duty/);
    },
  );

  it("keeps the installation's checkouts read-only for a reader, each once (PM-188)", () => {
    const p = policy('code_review', { kind: 'read_only', path: source });
    const sandbox = sessionSandbox(p, {
      readerDenyWrite: [
        source,
        '/fictional/home/',
        '/fictional/home/worktrees',
        undefined,
        '/fictional/live',
        '/fictional/home',
      ],
    })!;
    // A member's worktree inside the app home is covered by the app home itself.
    expect(sandbox.denyWrite).toEqual([source, '/fictional/home', '/fictional/live']);
    // The file tools get an `Edit` deny rule for each of them.
    expect(
      buildSettings({ hookUrl: 'http://fake/hooks', permissionTimeoutMs: 1000, allowedTools: [], sandbox })
        .permissions.deny,
    ).toEqual(['Edit(//fictional/source/**)', 'Edit(//fictional/home/**)', 'Edit(//fictional/live/**)']);
    // A developer's sandbox is unchanged: its own worktree stays writable.
    expect(
      sessionSandbox(development(), { readerDenyWrite: ['/fictional/home'] })!.denyWrite,
    ).toBeUndefined();
  });

  it('names an accented attachment directory in its rules, and none with rule syntax (PM-188)', () => {
    const dir = '/Users/anna/.projectman/attachments/ÁR/ÁR-1'.normalize('NFC');
    const nfd = dir.normalize('NFD');
    expect(attachmentToolRules(dir)).toEqual({
      allow: [`Read(/${dir}/**)`, `Read(/${nfd}/**)`],
      deny: [`Edit(/${dir}/**)`, `Edit(/${nfd}/**)`],
    });
    expect(attachmentToolRules('/fictional/attachments(1)')).toEqual({ allow: [], deny: [] });
    expect(attachmentToolRules('/fictional/*')).toEqual({ allow: [], deny: [] });
  });

  it('runs gh outside the sandbox only for a repository on GitHub (PM-188)', () => {
    const p = policy('code_review', { kind: 'read_only', path: source });
    expect(sessionSandbox(p)!.excludedCommands).toBeUndefined();
    expect(sessionSandbox(p, { github: false })!.excludedCommands).toBeUndefined();
    const sandbox = sessionSandbox(p, { github: true })!;
    expect(sandbox.excludedCommands).toEqual(['gh pr view', 'gh pr diff']);
    // Claude Code takes them with any arguments, and only as a command of their own.
    expect(
      buildSettings({ hookUrl: 'http://fake/hooks', permissionTimeoutMs: 1000, allowedTools: [], sandbox })
        .sandbox?.excludedCommands,
    ).toEqual(['gh pr view:*', 'gh pr diff:*']);
  });

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

  it.each([undefined, 'default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'])(
    'requires an independent strict test opt-in for review permissionMode=%s',
    (permissionMode) => {
      for (const mode of [undefined, 'inherit', 'read_only', 'test'] as const) {
        for (const enforcement of ['legacy', 'strict'] as const) {
          const grantsTest = mode === 'test' && enforcement === 'strict' && permissionMode !== 'plan';
          expect(sessionPermissions(permissionMode, 'review_copy', { mode, enforcement })).toEqual({
            claude:
              permissionMode === 'plan' ? 'plan' : grantsTest ? 'acceptEdits' : (permissionMode ?? 'default'),
            sandbox: grantsTest ? 'workspace-write' : 'read-only',
            approval: permissionMode === 'plan' ? 'never' : 'on-request',
          });
          expect(sessionPermissions(permissionMode, 'read_only', { mode, enforcement }).sandbox).toBe(
            'read-only',
          );
        }
      }
    },
  );

  it.each(['code_review', 'security_review', 'qa', 'custom'])(
    'limits strict test intent to the own copy, git and caches for %s',
    (role) => {
      const config = testConfig();
      config.team.roles.push({
        id: 'custom',
        name: 'Custom reviewer',
        duties: ['implementation', 'testing_acceptance'],
        instructions: '',
        summary: '',
        notTheirJob: '',
        holders: 'ai',
      });
      const own = `${copy}/repo`;
      const other = '/fictional/reviews/other-member';
      const p = buildSessionPolicy({
        config,
        role,
        task: { repo: 'web' },
        permissionMode: 'default',
        reviewCopyMode: 'test',
        enforcement: 'strict',
        placement: {
          kind: 'review_copy',
          path: own,
          gitDir: `${own}/.git`,
          cacheDir: `${copy}/cache`,
          tempDir: `${copy}/tmp`,
          sourceCommit: 'a'.repeat(40),
          roundId: 'round-1',
        },
        readableRoots: [source, sharedGit, other],
        protectedPaths: [source, sharedGit, other],
      });
      expect(p.reviewCopyMode).toBe('test');
      expect(p.permissions).toMatchObject({ claude: 'acceptEdits', sandbox: 'workspace-write' });
      expect(p.filesystem.writableRoots).toEqual([own, `${own}/.git`, `${copy}/cache`, `${copy}/tmp`]);
      for (const protectedPath of [source, sharedGit, other]) {
        expect(p.filesystem.readableRoots).toContain(protectedPath);
        expect(p.filesystem.writableRoots).not.toContain(protectedPath);
      }
      expect(p.outsideSandbox).toBe('deny');
      // Strict intent cannot execute through a legacy renderer, on either start path.
      for (const resume of [false, true]) {
        const s = spec(p, resume);
        expect(() =>
          buildSettings({
            hookUrl: 'http://fake/hooks',
            permissionTimeoutMs: 1000,
            allowedTools: [],
            policy: p,
          }),
        ).toThrow(/refusing to start/);
        expect(() =>
          buildCodexArgs({
            spec: s,
            realCwd: s.cwd,
            hookUrl: 'http://fake/hooks',
            permissionTimeoutMs: 1000,
          }),
        ).toThrow(/refusing to start/);
      }
    },
  );

  it('keeps explicit read_only and plan review intent without writable roots', () => {
    for (const [permissionMode, reviewCopyMode] of [
      ['default', 'read_only'],
      ['plan', 'test'],
    ] as const) {
      const p = buildSessionPolicy({
        config: testConfig(),
        role: 'qa',
        task: { repo: 'web' },
        placement: review().placement,
        permissionMode,
        reviewCopyMode,
        enforcement: 'strict',
      });
      expect(p.filesystem.writableRoots).toEqual([]);
      expect(p.permissions.sandbox).toBe('read-only');
    }
  });

  it('cannot opt research duties or a task without a repository into review test writes', () => {
    const config = testConfig();
    const input = {
      config,
      role: 'qa',
      task: { repo: 'web' },
      placement: review().placement,
      permissionMode: 'default',
      reviewCopyMode: 'test' as const,
      enforcement: 'strict' as const,
    };
    for (const role of ['architect', 'business_analyst']) {
      expect(() => buildSessionPolicy({ ...input, role })).toThrow(/review\/testing duty/);
    }
    config.project.repos = [];
    for (const task of [null, { repo: null }]) {
      expect(() => buildSessionPolicy({ ...input, task })).toThrow(/task repository/);
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
    ).toEqual([
      'Bash(git push:*)',
      'Bash(gh pr create:*)',
      'Bash(gh pr merge:*)',
      'WebFetch(domain:localhost)',
      'WebFetch(domain:127.0.0.1)',
    ]);
  });

  it('denies the credentials, the live instance data and local web fetches in every permission mode (PM-165)', () => {
    const deniedPaths = sensitivePaths({ userHome: '/Users/anna', appHome: '/Users/anna/.projectman' });
    expect(deniedPaths).toEqual(
      expect.arrayContaining([
        '/Users/anna/.ssh',
        '/Users/anna/.config/gh',
        '/Users/anna/.claude/.credentials.json',
        '/Users/anna/.claude/settings.json',
        '/Users/anna/.claude.json',
        '/Users/anna/.codex',
        '/Users/anna/.npmrc',
        '/Users/anna/.projectman/db.sqlite*',
        '/Users/anna/.projectman/secret',
        '/Users/anna/.projectman/logs',
        '/Users/anna/.projectman/customization',
        '/Users/anna/.projectman/memory',
      ]),
    );
    // The whole home is not denied: worktrees, workspaces and attachments live there.
    expect(deniedPaths).not.toContain('/Users/anna/.projectman');
    // The member's own saved tool outputs and the plan mode's plan file stay reachable.
    expect(deniedPaths).not.toContain('/Users/anna/.claude');
    for (const permissionMode of ['default', 'acceptEdits', 'auto', 'plan', undefined]) {
      const p = buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: development().placement,
        permissionMode,
        deniedPaths,
      });
      const deny = buildSettings({
        hookUrl: 'http://fake/hooks',
        permissionTimeoutMs: 1000,
        allowedTools: [],
        policy: p,
      }).permissions.deny;
      expect(deny, String(permissionMode)).toEqual(
        expect.arrayContaining([
          'Read(//Users/anna/.ssh)',
          'Read(//Users/anna/.ssh/**)',
          'Edit(//Users/anna/.ssh/**)',
          'Read(//Users/anna/.claude.json)',
          'Edit(//Users/anna/.projectman/db.sqlite*)',
          'Read(//Users/anna/.projectman/secret/**)',
          'WebFetch(domain:localhost)',
          'WebFetch(domain:127.0.0.1)',
        ]),
      );
    }
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
    // Codex keeps its read-only sandbox in a reading placement.
    const codex = buildCodexArgs({
      spec: s,
      realCwd: s.cwd,
      hookUrl: 'http://fake/hooks',
      permissionTimeoutMs: 1000,
    }).args;
    expect(codex.slice(codex.indexOf('--sandbox'), codex.indexOf('--sandbox') + 4)).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
    ]);
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
