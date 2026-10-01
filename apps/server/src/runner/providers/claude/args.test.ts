import { describe, expect, it } from 'vitest';
import type { StartSessionSpec } from '../../../contracts';
import { HTTP_HOOK_EVENTS, buildClaudeArgs, buildMcpConfig, buildSettings } from './args';

const spec: StartSessionSpec = {
  sessionId: 'ses_1',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  model: 'opus',
  permissionMode: 'acceptEdits',
  appendSystemPrompt: '- You are fe-1.\n- Speak Hungarian.',
  initialMessage: 'Brief',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: ['mcp__team', 'mcp__team__*', 'mcp__team'],
};

describe('buildSettings', () => {
  const settings = buildSettings({
    hookUrl: 'http://127.0.0.1:4700/hooks/abc',
    allowedTools: spec.allowedTools,
    permissionTimeoutMs: 15 * 60_000,
  });

  it('pre-allows the given tools, without duplicates and in both accepted forms', () => {
    expect(settings.permissions.allow).toEqual(['mcp__team', 'mcp__team__*']);
  });

  it('passes non-empty deny rules and omits empty ones', () => {
    const input = { hookUrl: 'http://h/hooks/t', allowedTools: [], permissionTimeoutMs: 1000 };
    expect(buildSettings(input).permissions).not.toHaveProperty('deny');
    expect(buildSettings({ ...input, deniedTools: [] }).permissions).not.toHaveProperty('deny');
    expect(
      buildSettings({ ...input, deniedTools: ['Bash(git push:*)', 'Bash(git push:*)'] }).permissions.deny,
    ).toEqual(['Bash(git push:*)']);
  });

  it('registers an HTTP hook for every event except SessionStart, which uses a command', () => {
    for (const event of HTTP_HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: 'http', url: 'http://127.0.0.1:4700/hooks/abc', timeout: expect.any(Number) }] },
      ]);
    }
    const start = settings.hooks.SessionStart![0]!.hooks[0]!;
    expect(start.type).toBe('command');
    expect(start.command).toContain("'http://127.0.0.1:4700/hooks/abc'");
  });

  it("listens to Claude Code's auto mode refusals (PermissionDenied)", () => {
    expect(settings.hooks.PermissionDenied).toEqual([
      { hooks: [{ type: 'http', url: 'http://127.0.0.1:4700/hooks/abc', timeout: expect.any(Number) }] },
    ]);
  });

  it('guides the auto mode classifier with prose and keeps the defaults', () => {
    expect(settings.autoMode?.environment[0]).toBe('$defaults');
    expect(settings.autoMode?.hard_deny[0]).toBe('$defaults');
    expect(settings.autoMode?.hard_deny.join(' ')).toMatch(/git push/);
  });

  it('hands the mode of the member to the CLI as it is, whatever it is', () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'plan'] as const) {
      const args = buildClaudeArgs({ ...spec, permissionMode: mode }, settings);
      expect(args[args.indexOf('--permission-mode') + 1]).toBe(mode);
    }
  });

  it('lets a permission request wait longer than our own timeout', () => {
    const timeout = settings.hooks.PermissionRequest![0]!.hooks[0]!.timeout;
    expect(timeout * 1000).toBeGreaterThan(15 * 60_000);
    expect(settings.hooks.UserPromptSubmit![0]!.hooks[0]!.timeout).toBeLessThanOrEqual(30);
  });

  it('turns on a strict sandbox only when the session asks for one', () => {
    expect(settings).not.toHaveProperty('sandbox');
    const sandboxed = buildSettings({
      hookUrl: 'http://h/hooks/t',
      allowedTools: [],
      permissionTimeoutMs: 1000,
      sandbox: { allowWrite: ['~/.npm'], allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true },
    });
    expect(sandboxed.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // The boolean, not the "deny" string, which makes Claude Code 2.1.284 ask for every command.
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { allowWrite: ['~/.npm'] },
      network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowLocalBinding: true },
    });
  });

  it("renders a reader's sandbox and denies the file tools' edits of its read-only directories (PM-167)", () => {
    const sandboxed = buildSettings({
      hookUrl: 'http://h/hooks/t',
      allowedTools: [],
      deniedTools: ['Bash(git push:*)'],
      permissionTimeoutMs: 1000,
      sandbox: {
        allowWrite: [],
        denyWrite: ['/work', '/worktrees/AR/AR-1-web/', '/work'],
        denyRead: ['/home/a/.ssh', '/pm/db.sqlite*'],
        allowRead: ['/home/a/.ssh/known_hosts'],
        allowedDomains: ['registry.npmjs.org'],
        allowLocalBinding: true,
        excludedCommands: ['gh pr view', 'gh pr diff'],
      },
    });
    expect(sandboxed.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        allowWrite: [],
        denyWrite: ['/work', '/worktrees/AR/AR-1-web/'],
        denyRead: ['/home/a/.ssh', '/pm/db.sqlite*'],
        allowRead: ['/home/a/.ssh/known_hosts'],
      },
      network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowLocalBinding: true },
      excludedCommands: ['gh pr view', 'gh pr diff'],
    });
    // The sandbox binds only the shell: `Edit` (also Write and NotebookEdit) is denied by rules.
    expect(sandboxed.permissions.deny).toEqual([
      'Bash(git push:*)',
      'Edit(//work/**)',
      'Edit(//worktrees/AR/AR-1-web/**)',
    ]);
  });

  it('refuses to start a read-only directory that a rule cannot name as it is', () => {
    expect(() =>
      buildSettings({
        hookUrl: 'http://h/hooks/t',
        allowedTools: [],
        permissionTimeoutMs: 1000,
        sandbox: { allowWrite: [], denyWrite: ['/work(1)'], allowedDomains: [], allowLocalBinding: true },
      }),
    ).toThrow(/refusing to start/);
  });

  it('forwards every hook of a sandboxed session with the forwarder, past the sandbox proxy', () => {
    const sandboxed = buildSettings({
      hookUrl: 'http://127.0.0.1:4700/hooks/abc',
      allowedTools: [],
      permissionTimeoutMs: 15 * 60_000,
      sandbox: { allowWrite: [], allowedDomains: [], allowLocalBinding: true },
    });
    for (const event of HTTP_HOOK_EVENTS) {
      const hook = sandboxed.hooks[event]![0]!.hooks[0]!;
      expect(hook.type).toBe('command');
      expect(hook.url).toBeUndefined();
      expect(hook.command).toContain("--noproxy '*'");
      expect(hook.command).toContain("'http://127.0.0.1:4700/hooks/abc'");
      expect(hook.timeout).toBe(settings.hooks[event]![0]!.hooks[0]!.timeout);
    }
    // Only the permission decision is printed, and curl waits as long as the hook.
    const permission = sandboxed.hooks.PermissionRequest![0]!.hooks[0]!;
    expect(permission.command).not.toContain('-o /dev/null');
    expect(permission.command).toContain(`-m ${permission.timeout} `);
    expect(sandboxed.hooks.Stop![0]!.hooks[0]!.command).toContain('-o /dev/null');
  });
});

describe('buildClaudeArgs', () => {
  const settings = buildSettings({
    hookUrl: 'http://h/hooks/t',
    allowedTools: [],
    permissionTimeoutMs: 1000,
  });

  it.each([false, true])('passes effort on sessions with resume=%s', (resume) => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = buildClaudeArgs({ ...spec, resume, effort }, settings);
      expect(args[args.indexOf('--effort') + 1]).toBe(effort);
    }
  });

  it('starts a new conversation with a fixed session id and every flag', () => {
    const args = buildClaudeArgs(spec, settings);
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--session-id')).toBe(spec.claudeSessionId);
    expect(args).not.toContain('--resume');
    expect(flag('--append-system-prompt')).toBe(spec.appendSystemPrompt);
    expect(JSON.parse(flag('--mcp-config')!)).toEqual({
      mcpServers: { team: { type: 'http', url: 'http://127.0.0.1:4700/mcp/tok' } },
    });
    expect(JSON.parse(flag('--settings')!)).toEqual(settings);
    expect(flag('--model')).toBe('opus');
    expect(args).not.toContain('--effort');
    expect(flag('--permission-mode')).toBe('acceptEdits');
    expect(flag('-n')).toBe('Anna · fe-1');
    // The variadic --mcp-config value must be followed by another option, never by a value.
    expect(args[args.indexOf('--mcp-config') + 2]).toMatch(/^-/);
  });

  it('passes every additional directory on both new and resumed sessions', () => {
    for (const resume of [false, true]) {
      const dirs = ['/worktrees/AR/AR-1-web', '/worktrees/AR/AR-2 with spaces'];
      const args = buildClaudeArgs({ ...spec, resume, additionalDirectories: dirs }, settings);
      expect(args.filter((arg, index) => args[index - 1] === '--add-dir')).toEqual(dirs);
    }
    expect(buildClaudeArgs(spec, settings)).not.toContain('--add-dir');
  });

  it.each([false, true])('defines the subagents with --agents with resume=%s (PM-179)', (resume) => {
    const subagents = [
      {
        name: 'reader-haiku',
        description: 'Reads logs.',
        prompt: 'Return a short result.',
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        model: 'haiku',
      },
    ];
    const args = buildClaudeArgs({ ...spec, resume, subagents }, settings);
    const agents = JSON.parse(args[args.indexOf('--agents') + 1]!);
    expect(agents).toEqual({
      'reader-haiku': {
        description: 'Reads logs.',
        prompt: 'Return a short result.',
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        model: 'haiku',
      },
    });
    // No rights of its own: the session's permissions, sandbox and hooks hold for it (AC4).
    for (const key of ['permissionMode', 'mcpServers', 'hooks', 'disallowedTools'])
      expect(agents['reader-haiku']).not.toHaveProperty(key);
  });

  it('passes no --agents without subagents', () => {
    expect(buildClaudeArgs(spec, settings)).not.toContain('--agents');
    expect(buildClaudeArgs({ ...spec, subagents: [] }, settings)).not.toContain('--agents');
  });

  it('resumes an existing conversation and leaves out unset options', () => {
    const args = buildClaudeArgs(
      { ...spec, resume: true, model: undefined, permissionMode: undefined, appendSystemPrompt: '' },
      settings,
    );
    expect(args.slice(0, 2)).toEqual(['--resume', spec.claudeSessionId]);
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('--effort');
  });
});

describe('the managed VM profile (PM-141)', () => {
  const policy = (
    mode: 'bypassPermissions' | 'plan' = 'bypassPermissions',
    patch: Partial<NonNullable<StartSessionSpec['policy']>> = {},
  ): NonNullable<StartSessionSpec['policy']> => ({
    version: 1,
    enforcement: 'legacy',
    execution: { profile: 'managed_vm', boundary: { name: 'managed-vm', version: 1 } },
    access: 'member_workspace',
    placement: { kind: 'member_workspace', path: '/work', use: 'work' },
    tools: {
      team: { all: true, names: [] },
      files: ['read'],
      shell: [{ command: 'git diff', arguments: 'prefix' }],
    },
    filesystem: { readableRoots: ['/work'], writableRoots: ['/work'], protectedPaths: [] },
    deniedOperations: ['git_push'],
    network: { allowedDomains: [], allowLocalBinding: false },
    outsideSandbox: 'deny',
    permissions: {
      claude: mode,
      sandbox: mode === 'plan' ? 'read-only' : 'danger-full-access',
      approval: 'never',
    },
    ...patch,
  });
  const input = {
    hookUrl: 'http://127.0.0.1:4700/hooks/abc',
    allowedTools: ['Bash(git status:*)'],
    deniedTools: ['Bash(git push:*)'],
    permissionTimeoutMs: 60_000,
    sandbox: { allowWrite: ['~/.npm'], allowedDomains: ['registry.npmjs.org'], allowLocalBinding: true },
  };

  it('asks nothing: no tool rules but the team tools, no denied tools, no sandbox, no first-use dialog', () => {
    const settings = buildSettings({ ...input, policy: policy() });
    expect(settings.permissions).toEqual({ allow: ['mcp__team__*'] });
    expect(settings).not.toHaveProperty('sandbox');
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    // Not the sandbox's command hooks either: an unsandboxed session uses the HTTP hooks.
    expect(settings.hooks.Stop![0]!.hooks[0]!.type).toBe('http');
  });

  it('renders no reader sandbox and no read-only rules either (PM-167)', () => {
    const settings = buildSettings({
      ...input,
      policy: policy(),
      sandbox: { ...input.sandbox, allowWrite: [], denyWrite: ['/work'], denyRead: ['/Users/anna/.ssh'] },
    });
    expect(settings.permissions).toEqual({ allow: ['mcp__team__*'] });
    expect(settings).not.toHaveProperty('sandbox');
  });

  it('keeps every hook, so the state of the session is still followed', () => {
    const settings = buildSettings({ ...input, policy: policy() });
    for (const event of HTTP_HOOK_EVENTS) expect(settings.hooks[event]).toBeDefined();
    expect(settings.hooks.SessionStart![0]!.hooks[0]!.type).toBe('command');
  });

  it('starts in bypassPermissions, or plan for a research-only member, and protects the start', () => {
    const bypass = buildClaudeArgs(
      { ...spec, permissionMode: 'default', policy: policy() },
      buildSettings({ ...input, policy: policy() }),
    );
    expect(bypass[bypass.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    // Only this session's team server, and none of the project's own settings (PM-49).
    expect(bypass).toContain('--strict-mcp-config');
    expect(bypass[bypass.indexOf('--setting-sources') + 1]).toBe('user');
    const plan = buildClaudeArgs(
      { ...spec, policy: policy('plan') },
      buildSettings({ ...input, policy: policy('plan') }),
    );
    expect(plan[plan.indexOf('--permission-mode') + 1]).toBe('plan');
    // Plan mode needs no bypass confirmation to skip.
    expect(buildSettings({ ...input, policy: policy('plan') })).not.toHaveProperty(
      'skipDangerousModePermissionPrompt',
    );
  });

  it('keeps no hard denials and no classifier guidance: its limits are outside the CLI (PM-165)', () => {
    const settings = buildSettings({
      ...input,
      policy: policy('bypassPermissions', {
        filesystem: {
          readableRoots: ['/work'],
          writableRoots: ['/work'],
          protectedPaths: [],
          deniedPaths: ['/Users/anna/.ssh'],
        },
        network: { allowedDomains: [], allowLocalBinding: false, deniedHosts: ['localhost'] },
      }),
    });
    expect(settings.permissions).toEqual({ allow: ['mcp__team__*'] });
    expect(settings).not.toHaveProperty('autoMode');
  });

  it('does not touch a legacy start: no protected flags, the old rules and the sandbox stay', () => {
    const legacy = buildSettings({ ...input, policy: undefined });
    expect(legacy.permissions).toEqual({ allow: ['Bash(git status:*)'], deny: ['Bash(git push:*)'] });
    expect(legacy.sandbox).toBeDefined();
    expect(legacy).not.toHaveProperty('skipDangerousModePermissionPrompt');
    const args = buildClaudeArgs(spec, legacy);
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--setting-sources');
  });

  it('refuses a managed VM policy that asks, or runs in a mode that does', () => {
    const asking = policy('bypassPermissions', {
      permissions: { claude: 'bypassPermissions', sandbox: 'danger-full-access', approval: 'on-request' },
    });
    expect(() => buildSettings({ ...input, policy: asking })).toThrow(/asks nothing locally/);
    const acceptEdits = policy('bypassPermissions', {
      permissions: { claude: 'acceptEdits', sandbox: 'workspace-write', approval: 'never' },
    });
    expect(() => buildSettings({ ...input, policy: acceptEdits })).toThrow(/asks nothing locally/);
  });
});

describe('buildMcpConfig', () => {
  it('points the team server at the session endpoint over HTTP', () => {
    expect(buildMcpConfig('http://x/mcp/1').mcpServers.team.type).toBe('http');
  });
});
