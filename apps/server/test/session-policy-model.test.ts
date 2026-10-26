import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { roleSessionAccess, sessionPermissions } from '@projectman/shared';
import { SANDBOX_HOME_READS } from '../src/contracts';
import type { SessionPolicy, StartSessionSpec } from '../src/contracts';
import { userExcludesFile } from '../src/engine-host';
import { createEngineLimit } from '../src/engine-link';
import { EngineStartSpec } from '../src/engine-link/session-schemas';
import { attachmentToolRules, sensitivePaths, sessionSandbox } from '../src/runtime/sessions';
import { buildSettings, buildClaudeArgs } from '../src/runner/providers/claude/args';
import { buildCodexArgs, NANOGPT_CODEX_PROVIDER, tomlValue } from '../src/runner/providers/codex/args';
import { decideToolCall } from '../src/runner/tool-decision';
import { buildSessionPolicy } from './helpers/session-policy';
import { testConfig } from './helpers/test-template';

const HOOK_CONFIG = '/run/ses_1.0123456789abcdef/hook.curl';
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
  it.each(['clone', 'linked'] as const)(
    'carries the complete typed read boundary for a %s checkout through the strict wire schema',
    (kind) => {
      const userHome = '/fictional/user';
      const appHome = `${userHome}/app`;
      const cwd = `${appHome}/work/own`;
      const p = policy('developer', {
        kind: 'task_worktree',
        path: cwd,
        ...(kind === 'clone'
          ? { workspace: { branch: 'PM-360', baseCommit: null } }
          : { gitDir: sharedGit, worktreeGitDir: `${sharedGit}/worktrees/own` }),
      });
      p.filesystem.readOnlyPaths = [`${appHome}/attachments/PM-360`];
      const sandbox = sessionSandbox(p, {
        userHome,
        appHome,
        memberDir: `${appHome}/member-caches/PM/dev`,
        sessionDir: '/fictional/outputs/own',
        browsersDir: '/fictional/browsers',
        tmpDir: '/fictional/tmp/own',
        sharedTmpRoots: ['/fictional/tmp'],
        heavyLockDir: '/fictional/queue/lock',
      })!;
      const s = { ...spec(p, false), sandbox };
      const { mcpUrl: _url, ...wire } = s;
      const parsed = EngineStartSpec.parse({ ...wire, mcpToken: 'fictional-token' });
      const boundary = parsed.sandbox!.portable!.readBoundary!;
      expect(boundary.deniedRoots).toEqual([userHome, appHome, '/fictional/tmp']);
      expect(boundary.allowedPaths).toEqual(
        expect.arrayContaining([
          { path: cwd, kind: 'directory' },
          { path: '/fictional/tmp/own', kind: 'directory' },
          { path: '/fictional/outputs', kind: 'directory' },
          { path: '/fictional/browsers', kind: 'directory' },
          { path: '/fictional/queue', kind: 'directory' },
          { path: `${appHome}/attachments/PM-360`, kind: 'directory' },
          { path: `${userHome}/.gitconfig`, kind: 'file' },
          { path: `${appHome}/member-caches/PM/dev/gitconfig`, kind: 'file' },
        ]),
      );
      expect(boundary.allowedPaths.map((entry) => entry.path)).toEqual(sandbox.allowRead);
      const profile = codexOverrides(
        buildCodexArgs({ spec: s, realCwd: cwd, hookConfigPath: HOOK_CONFIG, permissionTimeoutMs: 1000 })
          .args,
      ).get('permissions.projectman')!;
      expect(profile).toContain(`"${cwd}"="write"`);
      expect(profile).toContain(`"${cwd}/.codex"="read"`);
      expect(profile).toContain(
        kind === 'clone' ? `"${cwd}/.git"="write"` : `"${sharedGit}/objects"="write"`,
      );
    },
  );

  it('keeps the boundary with no portable writes and gives plan mode no new write grant', () => {
    const p = policy('developer', { kind: 'task_worktree', path: source }, 'plan');
    const sandbox = sessionSandbox(p, { userHome: '/fictional/user', appHome: '/fictional/app' })!;
    expect(sandbox.portable).toMatchObject({
      allowWrite: [],
      readBoundary: { deniedRoots: ['/fictional/user', '/fictional/app'] },
    });
    const profile = codexOverrides(
      buildCodexArgs({
        spec: { ...spec(p, false), sandbox },
        realCwd: source,
        hookConfigPath: HOOK_CONFIG,
        permissionTimeoutMs: 1000,
      }).args,
    ).get('permissions.projectman');
    expect(profile).toContain('"/fictional/user"="deny"');
    expect(profile).not.toContain('"write"');
  });
  it('grants a lead developer writes only to their named merge-fix placement', () => {
    const task = {
      repo: 'web',
      merge: {
        id: 'm',
        repo: 'web',
        base: 'main',
        merger: 'lead',
        toStageId: 'done',
        requestedAt: 'now',
        state: 'fixing' as const,
        landed: 'nowhere' as const,
        fix: { by: 'lead', branch: 'merge-fix/AR-1', base: 'a'.repeat(40), startedAt: 'now' },
      },
    };
    const placement = {
      kind: 'task_worktree' as const,
      path: copy,
      gitDir: sharedGit,
      mergeFix: { branch: task.merge.fix.branch },
    };
    const build = (member: string, currentTask = task, currentPlacement = placement) =>
      buildSessionPolicy({
        config: testConfig(),
        role: 'lead_developer',
        member,
        task: currentTask,
        placement: currentPlacement,
        permissionMode: 'acceptEdits',
      });
    const p = build('lead');
    expect(p.filesystem.writableRoots).toEqual([copy]);
    expect(p.tools.shell).toContainEqual({ command: `git merge ${task.merge.fix.base}`, arguments: 'exact' });
    expect(p.tools.files).toEqual([]);
    expect(() => build('other')).toThrow(/file-changing duty/);
    expect(() => build('lead', task, { ...placement, mergeFix: { branch: 'task/AR-1' } })).toThrow(
      /file-changing duty/,
    );
    expect(() =>
      buildSessionPolicy({
        config: testConfig(),
        role: 'lead_developer',
        member: 'lead',
        task: { ...task, merge: { ...task.merge, state: 'failed' } },
        placement,
      }),
    ).toThrow(/file-changing duty/);
  });
  it.each(['codex', 'nanogpt'] as const)(
    'renders the member cache and development data for %s sandboxed commands',
    (provider) => {
      const p = development();
      const memberDir = '/fictional/app/member-caches/PM/dev';
      const sandbox = sessionSandbox(p, { userHome: '/fictional/user', memberDir })!;
      const s = { ...spec(p, false), sandbox };
      const c = codexOverrides(
        buildCodexArgs({
          spec: s,
          provider: provider === 'nanogpt' ? NANOGPT_CODEX_PROVIDER : undefined,
          realCwd: s.cwd,
          hookConfigPath: HOOK_CONFIG,
          permissionTimeoutMs: 1000,
        }).args,
      );
      expect(c.get('permissions.projectman')).toContain('"/fictional/user"="deny"');
      expect(c.get('permissions.projectman')).toContain(`"${memberDir}/npm-cache"="write"`);
      expect(c.get('permissions.projectman')).not.toContain(':slash_tmp');
      expect(c.get('shell_environment_policy.set.npm_config_cache')).toBe(
        tomlValue(`${memberDir}/npm-cache`),
      );
      expect(c.get('shell_environment_policy.set.PROJECTMAN_HOME')).toBe(
        tomlValue(`${memberDir}/projectman-dev`),
      );
      expect(sandbox.allowWrite).toEqual(sandbox.portable!.allowWrite);
      expect(c.get('permissions.projectman')).not.toContain('/fictional/user/.npm');
      expect(c.has('shell_environment_policy.set.GIT_CONFIG_SYSTEM')).toBe(false);
    },
  );

  it('protects server-managed workspace snapshot refs in both provider sandboxes', () => {
    const p = policy('developer', {
      kind: 'task_worktree',
      path: source,
      gitDir: sharedGit,
      worktreeGitDir: `${sharedGit}/worktrees/fix`,
    });
    const sandbox = sessionSandbox(p, { userHome: '/fictional/user', defaultBranch: 'main' })!;
    const snapshots = `${sharedGit}/refs/projectman`;
    expect(sandbox.denyWrite).toContain(snapshots);
    const settings = buildSettings({
      hookUrl: 'http://fake/hooks',
      hookConfigPath: HOOK_CONFIG,
      permissionTimeoutMs: 1000,
      allowedTools: [],
      policy: p,
      sandbox,
    });
    expect(settings.sandbox?.filesystem.denyWrite).toContain(snapshots);
    expect(settings.permissions.deny).toContain(`Edit(/${snapshots}/**)`);
    const s = { ...spec(p, false), sandbox };
    const args = buildCodexArgs({
      spec: s,
      realCwd: s.cwd,
      hookConfigPath: HOOK_CONFIG,
      permissionTimeoutMs: 1000,
    }).args;
    const profile = codexOverrides(args).get('permissions.projectman');
    expect(profile).toContain(`"${sharedGit}/refs"="write"`);
    expect(profile).toContain(`"${snapshots}"="read"`);
    expect(profile).not.toContain(`"${snapshots}"="write"`);
  });

  it('does not share denied member directories or give readers member-cache writes', () => {
    const memberDir = '/fictional/app/member-caches/PM/dev';
    const p = development();
    p.filesystem.deniedPaths = [`${memberDir}/npm-cache`];
    const sandbox = sessionSandbox(p, { userHome: '/fictional/user', memberDir })!;
    expect(sandbox.portable).toMatchObject({
      allowWrite: [`${memberDir}/projectman-dev`],
      env: { PROJECTMAN_HOME: `${memberDir}/projectman-dev` },
    });
    expect(sessionSandbox(review(), { memberDir })!.portable).toBeUndefined();
    p.filesystem.deniedPaths = [memberDir];
    expect(sessionSandbox(p, { userHome: '/fictional/user', memberDir })!.portable).toMatchObject({
      allowWrite: [],
      readBoundary: { deniedRoots: ['/fictional/user'] },
    });
  });

  it('refuses unsupported strict enforcement instead of rendering a weaker profile', () => {
    const p: SessionPolicy = { ...development(), enforcement: 'strict', outsideSandbox: 'deny' };
    expect(() =>
      buildSettings({
        hookUrl: 'http://fake/hooks',
        hookConfigPath: HOOK_CONFIG,
        permissionTimeoutMs: 1000,
        allowedTools: [],
        policy: p,
      }),
    ).toThrow(/refusing to start/);
    const s = spec(p, false);
    expect(() =>
      buildCodexArgs({ spec: s, realCwd: s.cwd, hookConfigPath: HOOK_CONFIG, permissionTimeoutMs: 1000 }),
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
      expect(sessionSandbox(p, { userHome: '/home/anna' })?.denyWrite).toEqual([source]);
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
      buildSettings({
        hookUrl: 'http://fake/hooks',
        hookConfigPath: HOOK_CONFIG,
        permissionTimeoutMs: 1000,
        allowedTools: [],
        sandbox,
      }).permissions.deny,
    ).toEqual([
      'Edit(//fictional/source)',
      'Edit(//fictional/source/**)',
      'Edit(//fictional/home)',
      'Edit(//fictional/home/**)',
      'Edit(//fictional/live)',
      'Edit(//fictional/live/**)',
    ]);
    // A developer's sandbox is unchanged: its own worktree stays writable.
    expect(
      sessionSandbox(development(), { userHome: '/fictional/user', readerDenyWrite: ['/fictional/home'] })!
        .denyWrite,
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
      buildSettings({
        hookUrl: 'http://fake/hooks',
        hookConfigPath: HOOK_CONFIG,
        permissionTimeoutMs: 1000,
        allowedTools: [],
        sandbox,
      }).sandbox?.excludedCommands,
    ).toEqual(['gh pr view:*', 'gh pr diff:*']);
  });

  it("reads the user's core.excludesfile and runs no automatic gc in a developer's sandbox (PM-216)", () => {
    const home = '/fictional/user';
    const paths = { userHome: home, defaultBranch: 'main' };
    expect(sessionSandbox(development(), paths)!.allowRead).not.toContain(`${home}/.gitignore_global`);
    const sandbox = sessionSandbox(development(), { ...paths, excludesFile: `${home}/.gitignore_global` })!;
    expect(sandbox.allowRead).toContain(`${home}/.gitignore_global`);
    // Only that file: the home stays closed, and the protections of the shared git directory stay.
    expect(sandbox.denyRead).toContain(home);
    expect(sandbox.allowRead).not.toContain(home);
    expect(sandbox.denyWrite).toContain(`${sharedGit}/packed-refs`);
    expect(sandbox.denyWrite).toContain(`${sharedGit}/packed-refs.lock`);
    // A file in a denied path or the app home is not re-opened.
    const denied = sessionSandbox(
      buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: { kind: 'task_worktree', path: source, gitDir: sharedGit },
        permissionMode: 'acceptEdits',
        deniedPaths: [`${home}/.ssh`],
      }),
      { ...paths, appHome: '/fictional/app', excludesFile: `${home}/.ssh/ignore` },
    )!;
    expect(denied.allowRead).not.toContain(`${home}/.ssh/ignore`);
    expect(
      sessionSandbox(development(), {
        ...paths,
        appHome: '/fictional/app',
        excludesFile: '/fictional/app/x',
      })!.allowRead,
    ).not.toContain('/fictional/app/x');
    // Never the home or a directory above it, whatever the config says.
    for (const dir of [home, '/fictional'])
      expect(sessionSandbox(development(), { ...paths, excludesFile: dir })!.allowRead).not.toContain(dir);
    // The git settings are a file, not GIT_CONFIG_COUNT entries that would replace a session's own.
    expect(sandbox.env).not.toHaveProperty('GIT_CONFIG_COUNT');
    expect(sandbox.env).not.toHaveProperty('GIT_CONFIG_SYSTEM');
    const withDir = sessionSandbox(development(), { ...paths, appHome: '/pm', memberDir: '/pm/m/AR/dev' })!;
    expect(withDir.env).toMatchObject({ GIT_CONFIG_SYSTEM: '/pm/m/AR/dev/gitconfig' });
    expect(withDir.allowRead).toContain('/pm/m/AR/dev/gitconfig');
    expect(withDir.allowWrite).not.toContain('/pm/m/AR/dev/gitconfig');
  });

  it('keeps the app home closed and opens only its own worktree when the worktrees lie on a work volume below the home (PM-846)', () => {
    const appHome = '/fictional/user/.projectman';
    const own = `${appHome}/work/worktrees/AR/AR-1-web`;
    const sandbox = sessionSandbox(
      buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: { kind: 'task_worktree', path: own, gitDir: sharedGit },
        permissionMode: 'acceptEdits',
      }),
      { userHome: '/fictional/user', appHome, defaultBranch: 'main' },
    )!;
    // The user's home is denied and contains the app home, so the work volume below it is denied with it.
    expect(sandbox.denyRead).toContain('/fictional/user');
    expect(sandbox.allowRead).toContain(own);
    for (const open of [
      `${appHome}/work`,
      `${appHome}/work/worktrees`,
      `${appHome}/work/workspaces`,
      appHome,
    ])
      expect(sandbox.allowRead).not.toContain(open);
  });

  it("lets the engine's limit pass a worktree sandbox, which reads the user's files and writes none of them (PM-731)", async () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'policy-limit-')));
    try {
      const home = path.join(base, 'home');
      const userHome = path.join(base, 'user');
      const workspace = path.join(base, 'work');
      const repo = path.join(workspace, 'projectman');
      const excludes = path.join(userHome, 'global-ignore');
      for (const dir of [
        home,
        repo,
        path.join(home, 'member-caches'),
        path.join(userHome, '.config', 'git'),
        path.join(userHome, '.claude', 'shell-snapshots'),
      ])
        mkdirSync(dir, { recursive: true });
      writeFileSync(excludes, '*.log\n');
      writeFileSync(path.join(userHome, '.gitconfig'), `[core]\n\texcludesfile = ${excludes}\n`);
      const clone = buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: {
          kind: 'task_worktree',
          path: repo,
          workspace: { branch: 'AR-1-work', baseCommit: null },
        },
        permissionMode: 'acceptEdits',
        deniedPaths: sensitivePaths({ userHome, appHome: home }),
      });
      const sandbox = sessionSandbox(clone, {
        userHome,
        appHome: home,
        defaultBranch: 'main',
        excludesFile: userExcludesFile(userHome),
      })!;
      const reads = [...SANDBOX_HOME_READS.map((name) => path.join(userHome, name)), excludes];
      expect(sandbox.allowRead).toEqual(expect.arrayContaining(reads));
      for (const file of [...reads, userHome, path.join(userHome, '.claude')]) {
        expect(sandbox.allowWrite).not.toContain(file);
        expect(clone.filesystem.writableRoots).not.toContain(file);
      }
      const limit = createEngineLimit({
        config: {
          schemaVersion: 1,
          cloudUrl: 'https://cloud.example.com',
          engineId: 'eng_aaaaaaaaaaaa',
          name: 'mac',
          keyFile: path.join(home, 'engine.key'),
          projects: [{ project: 'AR', workspacePath: workspace }],
          repos: [],
          maxPermissionMode: 'auto',
          allowRemoteTerminalInput: true,
        },
        home,
        userHome,
        paths: {
          userHome,
          home,
          worktreesRoot: path.join(home, 'worktrees'),
          workspacesRoot: null,
          installDir: null,
          sessionFoldersRoot: path.join(home, 'session-folders'),
          sessionTmpRoot: path.join(home, 'tmp'),
          claudeTmpRoots: [],
          browsersDir: path.join(home, 'browsers'),
          heavyLockDir: path.join(home, 'heavy', 'lock'),
          gitExcludesFile: excludes,
        },
        instanceTag: 'a'.repeat(16),
        transcriptRoots: [],
        tmpdir: path.join(base, 'os-tmp'),
        probe: {} as never,
        sessionPids: () => [],
        selfPid: 99,
        selfUid: 501,
      });
      const checked = (await limit.check('session.start', {
        sessionId: 's1',
        provider: 'claude',
        cwd: repo,
        policy: clone,
        sandbox,
      } as never)) as { sandbox: { denyWrite: string[]; allowRead: string[] } };
      expect(checked.sandbox.allowRead).toEqual(expect.arrayContaining(reads));
      expect(checked.sandbox.denyWrite).toEqual(
        expect.arrayContaining(
          ['', '-wal', '-shm', '-journal'].map((end) => path.join(home, `db.sqlite${end}`)),
        ),
      );
      expect(checked.sandbox.denyWrite.filter((entry) => entry.includes('*'))).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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
            hookConfigPath: HOOK_CONFIG,
            permissionTimeoutMs: 1000,
            allowedTools: [],
            policy: p,
          }),
        ).toThrow(/refusing to start/);
        expect(() =>
          buildCodexArgs({
            spec: s,
            realCwd: s.cwd,
            hookConfigPath: HOOK_CONFIG,
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
      buildSettings({
        hookUrl: 'http://fake/hooks',
        hookConfigPath: HOOK_CONFIG,
        permissionTimeoutMs: 1000,
        allowedTools: [],
        policy: p,
      }).permissions.deny,
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
        // The AWS CLI's keys and caches and the Cloudflare tunnel certificate and Access tokens (PM-533).
        '/Users/anna/.aws',
        '/Users/anna/.cloudflared',
        '/Users/anna/.projectman/db.sqlite*',
        '/Users/anna/.projectman/secret',
        '/Users/anna/.projectman/logs',
        '/Users/anna/.projectman/customization',
        '/Users/anna/.projectman/memory',
        '/Users/anna/.projectman/operator-data',
        // Message files follow recipient visibility; sessions get authorized copies (PM-524).
        '/Users/anna/.projectman/message-attachments',
        // The control socket pauses the whole team (PM-219): not for the members.
        '/Users/anna/.projectman/control.sock',
        // The Gemini CLI's login, and the secret store and the providers' CLI homes (PM-324).
        '/Users/anna/.gemini',
        '/Users/anna/.projectman/secrets',
        '/Users/anna/.projectman/providers',
        // The release watcher's journal and database backups (PM-493).
        '/Users/anna/.projectman/release',
      ]),
    );
    // The whole home is not denied: worktrees, workspaces and attachments live there.
    expect(deniedPaths).not.toContain('/Users/anna/.projectman');
    expect(deniedPaths).not.toContain('/Users/anna/.projectman/attachments');
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
        hookConfigPath: HOOK_CONFIG,
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
          'Read(//Users/anna/.gemini/**)',
          'Read(//Users/anna/.aws/**)',
          'Read(//Users/anna/.cloudflared/**)',
          'Edit(//Users/anna/.cloudflared/**)',
          'Read(//Users/anna/.projectman/secrets/**)',
          'Edit(//Users/anna/.projectman/providers/**)',
          'Read(//Users/anna/.projectman/message-attachments)',
          'Read(//Users/anna/.projectman/operator-data)',
          'Read(//Users/anna/.projectman/operator-data/**)',
          'Edit(//Users/anna/.projectman/operator-data/**)',
          'Read(//Users/anna/.projectman/message-attachments/**)',
          'Edit(//Users/anna/.projectman/message-attachments/**)',
          'WebFetch(domain:localhost)',
          'WebFetch(domain:127.0.0.1)',
        ]),
      );
    }
    // The shell's sandbox closes the same paths (PM-324).
    const sandbox = sessionSandbox(
      buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: development().placement,
        deniedPaths,
      }),
      { userHome: '/Users/anna', appHome: '/Users/anna/.projectman' },
    )!;
    expect(sandbox.denyRead).toEqual(
      expect.arrayContaining([
        '/Users/anna/.gemini',
        '/Users/anna/.aws',
        '/Users/anna/.cloudflared',
        '/Users/anna/.projectman/secrets',
        '/Users/anna/.projectman/providers',
        '/Users/anna/.projectman/message-attachments',
      ]),
    );
  });

  it('keeps the AWS and Cloudflare logins unreadable on every provider (PM-533)', () => {
    const home = '/Users/anna';
    const deniedPaths = sensitivePaths({ userHome: home, appHome: `${home}/.projectman` });
    const files = [`${home}/.aws/credentials`, `${home}/.cloudflared/x.json`];
    const p = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      placement: development().placement,
      deniedPaths,
    });
    // Claude: the permission rules for the file tools, and the decision of the hook for every tool.
    const deny = buildSettings({
      hookUrl: 'http://fake/hooks',
      hookConfigPath: HOOK_CONFIG,
      permissionTimeoutMs: 1000,
      allowedTools: [],
      policy: p,
    }).permissions.deny;
    for (const file of files) {
      const dir = path.dirname(file);
      expect(deny).toEqual(expect.arrayContaining([`Read(/${dir}/**)`, `Edit(/${dir}/**)`]));
      // The Gemini hook and the Claude permission hook share the decision.
      expect(decideToolCall(p, { category: 'read', paths: [file] }, { home })).toEqual({
        decision: 'deny',
        reason: 'denied_path',
      });
      expect(decideToolCall(p, { category: 'edit', paths: [file] }, { home })).toEqual({
        decision: 'deny',
        reason: 'denied_path',
      });
    }
    // The shell's sandbox of Claude closes the same directories.
    const sandbox = sessionSandbox(p, { userHome: home, appHome: `${home}/.projectman` })!;
    expect(sandbox.denyRead).toEqual(expect.arrayContaining([`${home}/.aws`, `${home}/.cloudflared`]));
    // Codex: both directories are denied in the permission profile.
    const codex = codexOverrides(
      buildCodexArgs({
        spec: spec(p, false),
        realCwd: source,
        hookConfigPath: HOOK_CONFIG,
        permissionTimeoutMs: 1000,
      }).args,
    ).get('permissions.projectman');
    expect(codex).toContain(`"${home}/.aws"="deny"`);
    expect(codex).toContain(`"${home}/.cloudflared"="deny"`);
  });

  it.each([false, true])('renders semantic grants on both providers with resume=%s', (resume) => {
    const p = review();
    p.tools.team = { all: false, names: ['get_task', 'send_message'] };
    const s = spec(p, resume);
    const settings = buildSettings({
      hookUrl: 'http://fake/hooks',
      hookConfigPath: HOOK_CONFIG,
      permissionTimeoutMs: 1000,
      allowedTools: s.allowedTools,
      policy: p,
    });
    expect(settings.permissions.allow).toContain('mcp__team__get_task');
    expect(settings.permissions.allow).toContain('Bash(git diff:*)');
    expect(settings.permissions.allow).not.toContain('Bash(*)');
    expect(settings.permissions.allow).not.toContain('mcp__team__*');
    const args = buildClaudeArgs(s, {
      settingsPath: '/run/ses_1.0123456789abcdef/claude-settings.json',
      mcpConfigPath: '/run/ses_1.0123456789abcdef/claude-mcp.json',
    });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    // Codex keeps its read-only sandbox in a reading placement.
    const codex = buildCodexArgs({
      spec: s,
      realCwd: s.cwd,
      hookConfigPath: HOOK_CONFIG,
      permissionTimeoutMs: 1000,
    }).args;
    expect(codex).not.toContain('--sandbox');
    expect(codex.slice(codex.indexOf('--ask-for-approval'), codex.indexOf('--ask-for-approval') + 2)).toEqual(
      ['--ask-for-approval', 'on-request'],
    );
    const c = codexOverrides(
      buildCodexArgs({ spec: s, realCwd: s.cwd, hookConfigPath: HOOK_CONFIG, permissionTimeoutMs: 1000 })
        .args,
    );
    expect(c.get('default_permissions')).toBe('"projectman"');
    expect(c.get('permissions.projectman')).toContain('extends=":read-only"');
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
