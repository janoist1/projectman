import { describe, expect, it } from 'vitest';
import { PermissionMode } from '@projectman/shared';
import type { StartSessionSpec } from '../../../contracts';
import {
  buildCodexArgs,
  CODEX_HOOK_EVENTS,
  codexModel,
  codexPermissions,
  tomlString,
  tomlValue,
  NANOGPT_CODEX_PROVIDER,
} from './args';

const spec: StartSessionSpec = {
  sessionId: 'ses_1',
  claudeSessionId: '0b8a3c2e-1f5d-4c4e-9a7b-2d6e8f1a3b5c',
  resume: false,
  cwd: '/work',
  displayName: 'Anna · fe-1',
  model: 'opus',
  permissionMode: 'default',
  appendSystemPrompt: '- You are fe-1.\n- Speak Hungarian.',
  initialMessage: 'Brief',
  mcpUrl: 'http://127.0.0.1:4700/mcp/tok',
  allowedTools: ['mcp__team__*', 'Read', 'Bash(git diff:*)'],
  provider: 'codex',
};

const input = {
  spec,
  hookUrl: 'http://127.0.0.1:4700/hooks/secret',
  permissionTimeoutMs: 40_000,
  realCwd: '/Users/anna/.projectman/worktrees/AR/AR-1',
  nodePath: '/usr/local/bin/node',
};

/** The `-c` overrides of an argument list, as key -> raw value. */
function overrides(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  args.forEach((arg, i) => {
    if (args[i - 1] !== '-c') return;
    const eq = arg.indexOf('=');
    map.set(arg.slice(0, eq), arg.slice(eq + 1));
  });
  return map;
}

describe('TOML values', () => {
  it('disables plugins for Codex and NanoGPT starts', () => {
    for (const provider of [undefined, NANOGPT_CODEX_PROVIDER]) {
      const c = overrides(buildCodexArgs({ ...input, provider }).args);
      for (const feature of [
        'plugins',
        'remote_plugin',
        'apps',
        'tool_suggest',
        'skill_mcp_dependency_install',
      ])
        expect(c.get(`features.${feature}`)).toBe('false');
    }
  });
  it('disables named user MCP servers in order before installing the team server', () => {
    const args = buildCodexArgs({ ...input, disabledMcpServers: ['node_repl', 'other-server'] }).args;
    expect([...overrides(args)].filter(([key]) => key.startsWith('mcp_servers'))).toEqual([
      ['mcp_servers.node_repl.enabled', 'false'],
      ['mcp_servers.other-server.enabled', 'false'],
      ['mcp_servers.team', '{url="http://127.0.0.1:4700/mcp/tok"}'],
    ]);
    for (const name of ['team', 'quoted.name', 'bad name'])
      expect(() => buildCodexArgs({ ...input, disabledMcpServers: [name] })).toThrow('Invalid user MCP');
  });
  it('disables ambient notification commands for Codex and NanoGPT launches', () => {
    for (const provider of [undefined, NANOGPT_CODEX_PROVIDER]) {
      const command = buildCodexArgs({ ...input, provider });
      expect(overrides(command.args).get('notify')).toBe('[]');
    }
  });
  it('escapes strings for TOML basic strings', () => {
    expect(tomlString('a"b\\c\nd\te\r')).toBe('"a\\"b\\\\c\\nd\\te\\r"');
    expect(tomlString('bell\u0007 del\u007f')).toBe('"bell\\u0007 del\\u007f"');
    expect(tomlString('naïve café ✓ 🙂')).toBe('"naïve café ✓ 🙂"');
    expect(tomlString('lone \ud800 surrogate')).toBe('"lone � surrogate"');
  });

  it('writes inline tables, arrays and scalars; paths become quoted keys', () => {
    expect(tomlValue({ '/Users/anna/.pm/ws': { trust_level: 'trusted' } })).toBe(
      '{"/Users/anna/.pm/ws"={trust_level="trusted"}}',
    );
    expect(tomlValue([{ hooks: [{ type: 'command', command: "echo 'x'", timeout: 10 }] }])).toBe(
      `[{hooks=[{type="command",command="echo 'x'",timeout=10}]}]`,
    );
    expect(tomlValue({ a: true, b: 1.5, c: undefined, d: ['CLAUDE.md'] })).toBe(
      '{a=true,b=1.5,d=["CLAUDE.md"]}',
    );
    expect(() => tomlValue(Number.NaN)).toThrow(/not representable/);
    expect(() => tomlValue(null)).toThrow(/not representable/);
  });
});

describe('Codex settings from the member', () => {
  it('maps Claude Code permission modes to a sandbox and an approval policy', () => {
    expect(codexPermissions('default')).toEqual({ sandbox: 'read-only', approval: 'on-request' });
    expect(codexPermissions(undefined)).toEqual({ sandbox: 'read-only', approval: 'on-request' });
    expect(codexPermissions('acceptEdits')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
    expect(codexPermissions('auto')).toEqual({ sandbox: 'workspace-write', approval: 'on-request' });
    expect(codexPermissions('plan')).toEqual({ sandbox: 'read-only', approval: 'never' });
  });

  it('reads bypassPermissions as acceptEdits: the sandbox stays on and escalations are still asked', () => {
    expect(codexPermissions('bypassPermissions')).toEqual(codexPermissions('acceptEdits'));
    expect(codexPermissions('bypassPermissions')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    for (const mode of [...PermissionMode.options, undefined, '', 'something-new']) {
      expect(codexPermissions(mode).sandbox, String(mode)).not.toBe('danger-full-access');
    }
  });

  it('never passes Claude model names to Codex', () => {
    for (const model of [
      'opus',
      'Sonnet',
      'haiku',
      'default',
      'best',
      'opus[1m]',
      'claude-opus-4-1',
      'fable',
      '',
      ' ',
    ]) {
      expect(codexModel(model)).toBe('gpt-6.1-sol');
    }
    expect(codexModel(undefined)).toBe('gpt-6.1-sol');
    expect(codexModel('gpt-6.1-codex')).toBe('gpt-6.1-codex');
    expect(codexModel(' o4-mini ')).toBe('o4-mini');
  });
});

describe('buildCodexArgs', () => {
  it.each([false, true])(
    'disables plugins for both providers and ChatGPT services only for NanoGPT with resume=%s',
    (resume) => {
      const settings: Record<string, string> = {
        'features.plugins': 'false',
        'features.remote_plugin': 'false',
        'features.apps': 'false',
        'features.tool_suggest': 'false',
        'features.skill_mcp_dependency_install': 'false',
        cli_auth_credentials_store: '"ephemeral"',
        'analytics.enabled': 'false',
        'feedback.enabled': 'false',
      };
      const ordinary = overrides(buildCodexArgs({ ...input, spec: { ...spec, resume } }).args);
      const nanogpt = overrides(
        buildCodexArgs({
          ...input,
          spec: { ...spec, provider: 'nanogpt', resume },
          provider: NANOGPT_CODEX_PROVIDER,
        }).args,
      );
      for (const [key, value] of Object.entries(settings)) {
        expect(nanogpt.get(key), key).toBe(value);
        if (key.startsWith('features.')) expect(ordinary.get(key), key).toBe('false');
        else expect(ordinary.has(key), key).toBe(false);
      }
    },
  );
  it.each([false, true])('maps max to xhigh with resume=%s', (resume) => {
    const args = buildCodexArgs({ ...input, spec: { ...spec, resume, effort: 'max' } }).args;
    expect(overrides(args).get('model_reasoning_effort')).toBe(JSON.stringify('xhigh'));
  });
  it.each(['low', 'medium', 'high', 'xhigh'] as const)('uses the member reasoning effort %s', (effort) => {
    const args = buildCodexArgs({ ...input, spec: { ...spec, effort } }).args;
    expect(overrides(args).get('model_reasoning_effort')).toBe(JSON.stringify(effort));
  });

  it.each([false, true])(
    'grants shared git writable roots only in workspace-write with resume=%s',
    (resume) => {
      const writableRoots = ['/workspace/.git', '/other repo/.git'];
      for (const permissionMode of ['acceptEdits', 'auto', 'bypassPermissions']) {
        const c = overrides(
          buildCodexArgs({ ...input, spec: { ...spec, resume, permissionMode, writableRoots } }).args,
        );
        expect(c.get('sandbox_workspace_write.writable_roots')).toBe(tomlValue(writableRoots));
        expect(c.has('sandbox_workspace_write.network_access')).toBe(false);
      }
      for (const permissionMode of ['default', 'plan']) {
        const c = overrides(
          buildCodexArgs({ ...input, spec: { ...spec, resume, permissionMode, writableRoots } }).args,
        );
        expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
      }
      for (const roots of [undefined, []]) {
        const c = overrides(
          buildCodexArgs({
            ...input,
            spec: { ...spec, permissionMode: 'acceptEdits', writableRoots: roots },
          }).args,
        );
        expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
      }
    },
  );

  it('runs the TUI inline, without the daemon, with our hooks trusted and the brief as the prompt', () => {
    const args = buildCodexArgs(input).args;
    expect(args.slice(0, 6)).toEqual([
      '--no-alt-screen',
      '--no-daemon',
      '--dangerously-bypass-hook-trust',
      '--enable',
      'hooks',
      '-c',
    ]);
    expect(args.slice(-10)).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort="medium"',
      '--',
      'Brief',
    ]);
    expect(args).not.toContain('resume');
  });

  it('ignores the subagents of the spec: Codex has no cheap subagent yet (PM-179)', () => {
    const subagents = [
      { name: 'reader-haiku', description: 'd', prompt: 'p', tools: ['Read'], model: 'haiku' },
    ];
    expect(buildCodexArgs({ ...input, spec: { ...input.spec, subagents } }).args).toEqual(
      buildCodexArgs(input).args,
    );
  });

  it('sets everything with -c overrides whose keys never contain a path', () => {
    const c = overrides(buildCodexArgs(input).args);
    for (const key of c.keys()) expect(key).toMatch(/^[A-Za-z_]+(?:\.[A-Za-z_]+)*$/);
    expect(c.get('check_for_update_on_startup')).toBe('false');
    expect(c.get('projects')).toBe('{"/Users/anna/.projectman/worktrees/AR/AR-1"={trust_level="trusted"}}');
    expect(c.get('project_doc_fallback_filenames')).toBe('["CLAUDE.md"]');
    expect(c.get('developer_instructions')).toBe('"- You are fe-1.\\n- Speak Hungarian."');
    expect(c.get('mcp_servers.team')).toBe('{url="http://127.0.0.1:4700/mcp/tok"}');
    expect(c.has('notice.hide_full_access_warning')).toBe(false);
    for (const event of CODEX_HOOK_EVENTS) expect(c.has(`hooks.${event}`)).toBe(true);
  });

  it('prints only the PermissionRequest answer, and waits longer than our own permission timeout', () => {
    const c = overrides(buildCodexArgs(input).args);
    const permission = c.get('hooks.PermissionRequest')!;
    expect(permission).toContain('timeout=70}');
    expect(permission).toContain("curl -q --noproxy '*' -sSf -m 70");
    expect(permission).not.toContain('-o /dev/null');
    const stop = c.get('hooks.Stop')!;
    expect(stop).toContain('timeout=10}');
    expect(stop).toContain('-o /dev/null');
    expect(stop).toContain("'http://127.0.0.1:4700/hooks/secret'");
  });

  it('resumes by id, with or without a message, and sanitises the prompt', () => {
    const resumed = buildCodexArgs({ ...input, spec: { ...spec, resume: true, initialMessage: null } }).args;
    expect(resumed[0]).toBe('resume');
    expect(resumed.slice(-2)).toEqual(['--', spec.claudeSessionId]);
    const withMessage = buildCodexArgs({
      ...input,
      spec: { ...spec, resume: true, initialMessage: '!ls\u001b[2J now' },
    }).args;
    expect(withMessage.slice(-3)).toEqual(['--', spec.claudeSessionId, ' !ls[2J now']);
  });

  it('reports whether the brief went on the command line', () => {
    expect(buildCodexArgs(input).initialMessageSent).toBe(true);
    for (const initialMessage of [null, undefined, '', ' \u001b\u0007 \n ']) {
      for (const resume of [false, true]) {
        expect(
          buildCodexArgs({ ...input, spec: { ...spec, resume, initialMessage } }).initialMessageSent,
        ).toBe(false);
      }
    }
  });

  describe('the managed VM profile (PM-141)', () => {
    const managed = (
      sandbox: 'danger-full-access' | 'read-only' | 'workspace-write' = 'danger-full-access',
      approval: 'never' | 'on-request' = 'never',
    ): NonNullable<StartSessionSpec['policy']> => ({
      version: 1,
      enforcement: 'legacy',
      execution: { profile: 'managed_vm', boundary: { name: 'managed-vm', version: 1 } },
      access: 'member_workspace',
      placement: { kind: 'member_workspace', path: '/work', use: 'work' },
      tools: { team: { all: true, names: [] }, files: [], shell: [] },
      filesystem: { readableRoots: ['/work'], writableRoots: ['/work'], protectedPaths: [] },
      deniedOperations: [],
      network: { allowedDomains: [], allowLocalBinding: false },
      outsideSandbox: 'deny',
      permissions: { claude: 'bypassPermissions', sandbox, approval },
    });
    const managedInput = (policy = managed()) => ({
      ...input,
      spec: { ...spec, permissionMode: 'default', policy },
    });

    it('runs without a sandbox and without questions', () => {
      const args = buildCodexArgs(managedInput()).args;
      expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 4)).toEqual([
        '--sandbox',
        'danger-full-access',
        '--ask-for-approval',
        'never',
      ]);
    });

    it('keeps the hooks and the team tools, and passes no approval of the old kind', () => {
      const c = overrides(buildCodexArgs(managedInput()).args);
      for (const event of CODEX_HOOK_EVENTS) expect(c.has(`hooks.${event}`)).toBe(true);
      expect(c.get('mcp_servers.team')).toContain('default_tools_approval_mode="approve"');
      expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
      for (const feature of [
        'plugins',
        'remote_plugin',
        'apps',
        'tool_suggest',
        'skill_mcp_dependency_install',
      ])
        expect(c.get(`features.${feature}`)).toBe('false');
    });

    it('keeps a research-only member read-only, also without questions', () => {
      const args = buildCodexArgs(managedInput(managed('read-only'))).args;
      expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 4)).toEqual([
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
      ]);
    });

    it('refuses a managed policy that asks or sandboxes the legacy way, and the freedom anywhere else', () => {
      expect(() => buildCodexArgs(managedInput(managed('danger-full-access', 'on-request')))).toThrow(
        /asks nothing locally/,
      );
      expect(() => buildCodexArgs(managedInput(managed('workspace-write')))).toThrow(/no inner sandbox/);
      // The same permissions without the managed VM execution profile are never started.
      const free = { ...managed(), execution: undefined };
      expect(() => buildCodexArgs(managedInput(free))).toThrow(/only in the managed VM profile/);
    });
  });

  describe('what our sandbox shares with Codex: the heavy-run queue folder (PM-346)', () => {
    const lockParent = '/fictional/tmp/projectman-501';
    const lockDir = `${lockParent}/heavy`;
    const sandbox = {
      allowWrite: [lockParent],
      allowedDomains: [],
      allowLocalBinding: true,
      portable: {
        allowWrite: [lockParent],
        env: { PROJECTMAN_HEAVY_LOCK_DIR: lockDir, npm_config_prefer_offline: 'true' },
      },
    };
    const withPolicy = (
      sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access',
      execution?: NonNullable<StartSessionSpec['policy']>['execution'],
    ): NonNullable<StartSessionSpec['policy']> => ({
      version: 1,
      enforcement: 'legacy',
      ...(execution ? { execution } : {}),
      access: 'task_worktree',
      placement: { kind: 'member_workspace', path: '/work', use: 'work' },
      tools: { team: { all: true, names: [] }, files: [], shell: [] },
      filesystem: { readableRoots: ['/work'], writableRoots: ['/work'], protectedPaths: [] },
      deniedOperations: [],
      network: { allowedDomains: [], allowLocalBinding: false },
      outsideSandbox: 'deny',
      permissions: { claude: 'acceptEdits', sandbox: sandboxMode, approval: 'on-request' },
    });
    const build = (extra: Partial<StartSessionSpec>) =>
      overrides(buildCodexArgs({ ...input, spec: { ...spec, ...extra } }).args);
    const ENV_KEY = 'shell_environment_policy.set.PROJECTMAN_HEAVY_LOCK_DIR';

    it('makes the queue folder writable and names it, also with a policy', () => {
      const c = build({ policy: withPolicy('workspace-write'), sandbox });
      expect(c.get('sandbox_workspace_write.writable_roots')).toBe(tomlValue([lockParent]));
      expect(c.get(ENV_KEY)).toBe(tomlValue(lockDir));
      expect(c.get('shell_environment_policy.set.npm_config_prefer_offline')).toBe(tomlValue('true'));
    });

    it('passes only the variables in a read-only sandbox, where nothing is writable', () => {
      const c = build({ policy: withPolicy('read-only'), sandbox });
      expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
      expect(c.get(ENV_KEY)).toBe(tomlValue(lockDir));
    });

    it('changes nothing without `portable`', () => {
      const plain = { ...sandbox, portable: undefined };
      const policy = withPolicy('workspace-write');
      expect(buildCodexArgs({ ...input, spec: { ...spec, policy, sandbox: plain } }).args).toEqual(
        buildCodexArgs({ ...input, spec: { ...spec, policy } }).args,
      );
      const c = build({ policy, sandbox: plain });
      expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
      expect([...c.keys()].some((key) => key.startsWith('shell_environment_policy'))).toBe(false);
    });

    it('joins the legacy writable roots without a policy into one list, each once', () => {
      const c = build({
        permissionMode: 'acceptEdits',
        writableRoots: ['/workspace/.git', lockParent],
        sandbox,
      });
      expect(c.get('sandbox_workspace_write.writable_roots')).toBe(
        tomlValue(['/workspace/.git', lockParent]),
      );
    });

    it('gives the managed VM neither the root nor the variables', () => {
      const policy = withPolicy('danger-full-access', {
        profile: 'managed_vm',
        boundary: { name: 'managed-vm', version: 1 },
      });
      const c = build({
        policy: { ...policy, permissions: { ...policy.permissions, approval: 'never' } },
        sandbox,
      });
      expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
      expect([...c.keys()].some((key) => key.startsWith('shell_environment_policy'))).toBe(false);
    });

    describe('the session folder and the own temporary directory (PM-339)', () => {
      const folder = '/fictional/sessions/abc/ses_1.0123456789abcdef';
      const tmpDir = '/fictional/tmp/projectman-501-tmp/0123abcd/ses_1.abcdef';
      const withFolder = {
        ...sandbox,
        allowWrite: [lockParent, folder],
        portable: {
          allowWrite: [lockParent, folder],
          env: {
            PROJECTMAN_HEAVY_LOCK_DIR: lockDir,
            PROJECTMAN_SESSION_DIR: folder,
            PLAYWRIGHT_BROWSERS_PATH: '/fictional/browsers',
          },
          tmpDir,
        },
      };
      const SET = 'shell_environment_policy.set';

      it('writes the folder and the tmp, sets TMPDIR and the folder variables, closes /tmp and the CLI’s TMPDIR, opens view_image', () => {
        const c = build({ policy: withPolicy('workspace-write'), sandbox: withFolder });
        expect(c.get('sandbox_workspace_write.writable_roots')).toBe(tomlValue([lockParent, folder, tmpDir]));
        expect(c.get(`${SET}.TMPDIR`)).toBe(tomlValue(tmpDir));
        expect(c.get(`${SET}.PROJECTMAN_SESSION_DIR`)).toBe(tomlValue(folder));
        expect(c.get(`${SET}.PLAYWRIGHT_BROWSERS_PATH`)).toBe(tomlValue('/fictional/browsers'));
        expect(c.get('sandbox_workspace_write.exclude_slash_tmp')).toBe('true');
        expect(c.get('sandbox_workspace_write.exclude_tmpdir_env_var')).toBe('true');
        expect(c.get('tools.view_image')).toBe('true');
      });

      it('lists a root once when the tmp is already one', () => {
        const same = { ...withFolder, portable: { ...withFolder.portable, allowWrite: [tmpDir, folder] } };
        const c = build({ policy: withPolicy('workspace-write'), sandbox: same });
        expect(c.get('sandbox_workspace_write.writable_roots')).toBe(tomlValue([tmpDir, folder]));
      });

      it('opens the viewer for a folder without a tmp, and closes nothing', () => {
        const noTmp = { ...withFolder, portable: { ...withFolder.portable, tmpDir: undefined } };
        const c = build({ policy: withPolicy('workspace-write'), sandbox: noTmp });
        expect(c.get('tools.view_image')).toBe('true');
        expect(c.has('sandbox_workspace_write.exclude_slash_tmp')).toBe(false);
        expect(c.has(`${SET}.TMPDIR`)).toBe(false);
      });

      it('sets none of it in a read-only sandbox', () => {
        const c = build({ policy: withPolicy('read-only'), sandbox: withFolder });
        for (const key of [
          'sandbox_workspace_write.writable_roots',
          'sandbox_workspace_write.exclude_slash_tmp',
          'sandbox_workspace_write.exclude_tmpdir_env_var',
          `${SET}.TMPDIR`,
          `${SET}.PROJECTMAN_SESSION_DIR`,
          `${SET}.PLAYWRIGHT_BROWSERS_PATH`,
          'tools.view_image',
        ])
          expect(c.has(key), key).toBe(false);
        expect(c.get(ENV_KEY)).toBe(tomlValue(lockDir));
      });

      it('sets none of it in the managed VM', () => {
        const policy = withPolicy('danger-full-access', {
          profile: 'managed_vm',
          boundary: { name: 'managed-vm', version: 1 },
        });
        const c = build({
          policy: { ...policy, permissions: { ...policy.permissions, approval: 'never' } },
          sandbox: withFolder,
        });
        expect([...c.keys()].filter((key) => /exclude_|TMPDIR|SESSION_DIR|view_image/.test(key))).toEqual([]);
      });
    });

    it('leaves out a variable whose name is not a TOML bare key', () => {
      const odd = { ...sandbox, portable: { allowWrite: [], env: { 'A.B': '1', 'C D': '2', GOOD_1: '3' } } };
      const c = build({ policy: withPolicy('workspace-write'), sandbox: odd });
      expect([...c.keys()].filter((key) => key.startsWith('shell_environment_policy'))).toEqual([
        'shell_environment_policy.set.GOOD_1',
      ]);
      expect(c.has('sandbox_workspace_write.writable_roots')).toBe(false);
    });
  });

  it('never turns off the sandbox or the questions, even for bypassPermissions, and passes a Codex model', () => {
    const args = buildCodexArgs({
      ...input,
      spec: { ...spec, permissionMode: 'bypassPermissions', model: 'gpt-6.1-codex', allowedTools: [] },
    }).args;
    const c = overrides(args);
    expect(args).not.toContain('danger-full-access');
    expect(c.has('notice.hide_full_access_warning')).toBe(false);
    expect(c.get('mcp_servers.team')).toBe('{url="http://127.0.0.1:4700/mcp/tok"}');
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 6)).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-6.1-codex',
    ]);
  });
});
