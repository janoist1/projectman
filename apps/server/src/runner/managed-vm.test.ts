import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MANAGED_VM_ACTIVATION_CHECKS,
  MANAGED_VM_PROVIDER_VERSIONS,
  VM_CHECKS,
  VM_PROFILE_NAME,
  VM_PROFILE_VERSION,
} from '@projectman/shared';
import type { AgentProvider } from '@projectman/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../test/helpers/test-template';
import type { ManagedVmAttestation, ManagedVmBoundary, SessionPolicy, StartSessionSpec } from '../contracts';
import { MANAGED_VM_UNAVAILABLE } from '../contracts';
import { buildSessionPolicy } from '../domain';
import { createRunnerModule } from './index';
import {
  assertManagedVmPolicy,
  createReadinessBoundary,
  inspectAmbientConfig,
  ManagedVmUnavailableError,
  parseCliVersion,
} from './managed-vm';
import { FAKE_CLAUDE, FAKE_CODEX, silentLogger, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

type Status = 'pass' | 'fail' | 'unverified';

function reportJson(status: Record<string, Status> = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
    generatedAt: '2026-10-01T12:00:00Z',
    host: { os: 'Ubuntu 24.04 LTS', kernel: '6.8.0', arch: 'aarch64' },
    checks: VM_CHECKS.map((check) => ({
      id: check.id,
      status: status[check.id] ?? (check.required ? 'pass' : 'unverified'),
      evidence: `measured ${check.id}`,
    })),
    ...extra,
  });
}
const FULL: Record<string, Status> = Object.fromEntries(
  MANAGED_VM_ACTIVATION_CHECKS.map((id) => [id, 'pass' as const]),
);
const NOW = new Date('2026-10-01T13:00:00Z');

async function verifyWith(
  text: string | null,
  opts: { platform?: NodeJS.Platform; maxAgeMs?: number } = {},
): Promise<ManagedVmAttestation> {
  return createReadinessBoundary({
    reportPath: '/var/lib/projectman-boundary/readiness.json',
    platform: opts.platform ?? 'linux',
    maxAgeMs: opts.maxAgeMs,
    now: () => NOW,
    readText: async () => {
      if (text === null) throw new Error('ENOENT');
      return text;
    },
  }).verify();
}

describe('the CLI version', () => {
  it('is read from what each CLI prints', () => {
    expect(parseCliVersion('2.1.284 (Claude Code)\n')).toBe('2.1.284');
    expect(parseCliVersion('codex-cli 0.159.1\n')).toBe('0.159.1');
    expect(parseCliVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion('Fake 12.3 build')).toBeNull();
    // The numbers of a longer dotted string are not a version.
    expect(parseCliVersion('1.2.3.4')).toBeNull();
  });
});

describe('the readiness boundary', () => {
  it('verifies a ready report in which the launcher and the domain gate passed', async () => {
    const attestation = await verifyWith(reportJson(FULL));
    expect(attestation).toEqual({
      profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
      verifiedAt: '2026-10-01T12:00:00Z',
      providerVersions: MANAGED_VM_PROVIDER_VERSIONS,
    });
  });

  it('refuses the baseline report, where the launcher and the domain gate are still unverified', async () => {
    await expect(verifyWith(reportJson())).rejects.toMatchObject({
      code: MANAGED_VM_UNAVAILABLE,
      reason: 'not_ready',
      details: { notPassed: ['launcher', 'domain-gate'] },
    });
  });

  it('refuses a required check that failed, however well the rest looks', async () => {
    await expect(verifyWith(reportJson({ ...FULL, 'worker-denied-read': 'fail' }))).rejects.toMatchObject({
      reason: 'not_ready',
      details: { failed: ['worker-denied-read'] },
    });
  });

  it('refuses an old report', async () => {
    await expect(verifyWith(reportJson(FULL), { maxAgeMs: 30 * 60_000 })).rejects.toMatchObject({
      reason: 'not_ready',
    });
    await expect(verifyWith(reportJson(FULL), { maxAgeMs: 2 * 60 * 60_000 })).resolves.toBeDefined();
  });

  it('refuses when there is no report, or one that is not valid, or one that carries a flag', async () => {
    await expect(verifyWith(null)).rejects.toMatchObject({ reason: 'no_report' });
    await expect(verifyWith('not json')).rejects.toMatchObject({ reason: 'bad_report' });
    // The schema is strict: a `vm: true` style flag is no input.
    await expect(verifyWith(reportJson(FULL, { vm: true }))).rejects.toMatchObject({ reason: 'bad_report' });
  });

  it('refuses outside Linux, even with a ready report: the Mac installation cannot be freed by a file', async () => {
    await expect(verifyWith(reportJson(FULL), { platform: 'darwin' })).rejects.toMatchObject({
      reason: 'platform',
    });
  });
});

describe("the VM's own provider configuration", () => {
  async function files() {
    const dir = await dirs.make('ambient-');
    return {
      dir,
      at: (name: string) => path.join(dir, name),
      write: async (name: string, text: string) => {
        await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await writeFile(path.join(dir, name), text);
        return path.join(dir, name);
      },
    };
  }
  const inspect = (
    provider: AgentProvider,
    cwd: string,
    locations: Parameters<typeof inspectAmbientConfig>[0]['locations'],
  ) => inspectAmbientConfig({ provider, cwd, env: {}, locations });

  it('finds nothing in a clean VM, where no file exists', async () => {
    const f = await files();
    const where = {
      claudeManaged: [f.at('managed.json'), f.at('managed.d')],
      claudeUser: f.at('settings.json'),
      codexManaged: [f.at('requirements.toml')],
      codexUser: f.at('config.toml'),
    };
    expect(await inspect('claude', f.dir, where)).toEqual([]);
    expect(await inspect('codex', f.dir, where)).toEqual([]);
  });

  it('flags the Claude settings that override hooks, MCP, the rules of asking, the sandbox or credentials', async () => {
    const f = await files();
    const user = await f.write(
      'settings.json',
      JSON.stringify({
        hooks: { PreToolUse: [] },
        mcpServers: { owner: { command: 'x' } },
        env: { SOME_TOKEN: 'secret-value' },
        permissions: { allow: ['Bash(ls:*)'], ask: ['Bash'], defaultMode: 'default' },
        model: 'opus',
      }),
    );
    const issues = await inspect('claude', f.dir, { claudeManaged: [], claudeUser: user });
    expect(issues).toEqual([
      { file: user, keys: ['hooks', 'mcpServers', 'env', 'permissions.ask', 'permissions.defaultMode'] },
    ]);
    // Names only: an `env` value may be a secret.
    expect(JSON.stringify(issues)).not.toContain('secret-value');
  });

  it('lets Claude settings that only widen or only choose a model stand', async () => {
    const f = await files();
    const user = await f.write(
      'settings.json',
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'], additionalDirectories: ['/x'] },
      }),
    );
    expect(await inspect('claude', f.dir, { claudeManaged: [], claudeUser: user })).toEqual([]);
  });

  it('reads an administrator directory of managed policy and flags a file that is not valid', async () => {
    const f = await files();
    await f.write('managed.d/10-a.json', JSON.stringify({ allowManagedHooksOnly: true }));
    await f.write('managed.d/20-b.json', '{ broken');
    await f.write('managed.d/notes.txt', 'ignored');
    const issues = await inspect('claude', f.dir, {
      claudeManaged: [f.at('managed.d')],
      claudeUser: f.at('missing.json'),
    });
    expect(issues).toEqual([
      { file: f.at('managed.d/10-a.json'), keys: ['allowManagedHooksOnly'] },
      { file: f.at('managed.d/20-b.json'), keys: ['(not valid JSON)'] },
    ]);
  });

  it('flags any content of a Codex administrator file, and the overriding roots of the user and project files', async () => {
    const f = await files();
    const admin = await f.write(
      'requirements.toml',
      '# set by an administrator\nallowed_approval_policies = ["untrusted"]\n',
    );
    const user = await f.write(
      'config.toml',
      [
        'model = "gpt"',
        'approval_policy = "on-request"',
        '[notice]',
        'hide_x = true',
        '[projects."/some/dir"]',
        'trust_level = "trusted"',
        '[mcp_servers.owner]',
        'command = "x"',
        '[hooks]',
        '',
      ].join('\n'),
    );
    await f.write('repo/.codex/config.toml', 'sandbox_mode = "workspace-write"\n');
    const issues = await inspect('codex', f.at('repo'), { codexManaged: [admin], codexUser: user });
    expect(issues).toEqual([
      { file: admin, keys: ['allowed_approval_policies'] },
      { file: user, keys: ['approval_policy', 'mcp_servers', 'hooks'] },
      { file: f.at('repo/.codex/config.toml'), keys: ['sandbox_mode'] },
    ]);
  });

  it("lets Codex's own bookkeeping stand", async () => {
    const f = await files();
    const user = await f.write(
      'config.toml',
      'model = "gpt"\n[notice]\nhide_rate_limit_model_nudge = true\n[projects."/a.b/c"]\ntrust_level = "trusted"\n',
    );
    expect(await inspect('codex', f.dir, { codexManaged: [], codexUser: user })).toEqual([]);
  });
});

describe('a policy that names the managed VM profile', () => {
  const policy = () =>
    buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      placement: { kind: 'member_workspace', path: '/vm/w', use: 'home' },
      managedVm: { boundary: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION } },
    });

  it('is consistent when the domain built it, and a legacy policy is not looked at', () => {
    expect(() => assertManagedVmPolicy(policy())).not.toThrow();
    const legacy = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      placement: { kind: 'task_worktree', path: '/w' },
    });
    expect(() => assertManagedVmPolicy(legacy)).not.toThrow();
  });

  it.each([
    [
      'an unknown profile',
      (p: SessionPolicy) => ({ ...p, execution: { profile: 'vm' } as never }),
      /unknown execution profile vm/,
    ],
    [
      'a strict claim',
      (p: SessionPolicy) => ({ ...p, enforcement: 'strict' as const }),
      /strict enforcement/,
    ],
    [
      'another placement',
      (p: SessionPolicy) => ({ ...p, placement: { kind: 'read_only' as const, path: '/w' } }),
      /placement read_only/,
    ],
    [
      'permissions that ask',
      (p: SessionPolicy) => ({ ...p, permissions: { ...p.permissions, approval: 'on-request' as const } }),
      /permissions ask/,
    ],
    [
      'a sandboxed CLI',
      (p: SessionPolicy) => ({
        ...p,
        permissions: { ...p.permissions, sandbox: 'workspace-write' as const },
      }),
      /sandbox the CLI/,
    ],
  ])('is a start error with %s, never read as legacy', (_name, change, message) => {
    expect(() => assertManagedVmPolicy(change(policy()))).toThrow(message);
  });
});

describe('a managed VM start through the runner (no pseudo-terminal: it is refused before the spawn)', () => {
  const ATTESTATION: ManagedVmAttestation = {
    profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
    verifiedAt: '2026-10-01T12:00:00.000Z',
    providerVersions: { claude: ['0.0.0'], codex: ['0.0.0'] },
  };
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  async function runnerWith(boundary: ManagedVmBoundary | null) {
    const home = await dirs.make('vm-home-');
    const cwd = await dirs.make('vm-ws-');
    const module = createRunnerModule({
      claudeBin: FAKE_CLAUDE,
      codexBin: FAKE_CODEX,
      codexHome: home,
      publicBaseUrl: 'http://127.0.0.1:1',
      broker: { decide: async () => ({ behavior: 'deny' }) },
      permissionTimeoutMs: 1000,
      logger: silentLogger(),
      trustWorkspaces: false,
      ...(boundary ? { managedVm: boundary } : {}),
      ambientConfig: {
        claudeManaged: [],
        claudeUser: path.join(home, 'settings.json'),
        codexManaged: [],
        codexUser: path.join(home, 'config.toml'),
      },
    });
    const spec = (provider: AgentProvider): StartSessionSpec => ({
      sessionId: `ses_${randomUUID().slice(0, 8)}`,
      claudeSessionId: randomUUID(),
      resume: false,
      cwd,
      displayName: 'Anna · fe-1',
      appendSystemPrompt: '',
      mcpUrl: 'http://127.0.0.1:1/mcp/token',
      allowedTools: [],
      policy: buildSessionPolicy({
        config: testConfig(),
        role: 'developer',
        task: { repo: 'web' },
        placement: { kind: 'member_workspace', path: cwd, use: 'home' },
        managedVm: { boundary: ATTESTATION.profile },
      }),
      provider,
    });
    // A started process reports its state; the version probe (`--version`) is not a session.
    const events: unknown[] = [];
    module.runner.onEvent((event) => events.push(event));
    const spawned = (_provider: AgentProvider) => Promise.resolve(events.length > 0);
    return { module, home, spec, spawned };
  }

  const ok: ManagedVmBoundary = { verify: async () => ATTESTATION };

  it.each(['claude', 'codex'] as const)(
    '%s: refuses without a boundary, and never spawns',
    async (provider) => {
      const { module, spec, spawned } = await runnerWith(null);
      const s = spec(provider);
      await expect(module.runner.start(s)).rejects.toMatchObject({
        code: MANAGED_VM_UNAVAILABLE,
        reason: 'no_boundary',
      });
      expect(module.runner.isRunning(s.sessionId)).toBe(false);
      expect(await spawned(provider)).toBe(false);
    },
  );

  it.each(['claude', 'codex'] as const)('%s: refuses when the boundary does not verify', async (provider) => {
    const { module, spec, spawned } = await runnerWith({
      verify: () => Promise.reject(new ManagedVmUnavailableError('not_ready', 'not ready')),
    });
    await expect(module.runner.start(spec(provider))).rejects.toMatchObject({ reason: 'not_ready' });
    expect(await spawned(provider)).toBe(false);
  });

  it.each(['claude', 'codex'] as const)(
    '%s: refuses a policy made for another boundary profile',
    async (provider) => {
      const { module, spec, spawned } = await runnerWith({
        verify: async () => ({ ...ATTESTATION, profile: { name: VM_PROFILE_NAME, version: 99 } }),
      });
      await expect(module.runner.start(spec(provider))).rejects.toMatchObject({ reason: 'profile_mismatch' });
      expect(await spawned(provider)).toBe(false);
    },
  );

  it.each(['claude', 'codex'] as const)(
    '%s: refuses an installed version the settings are not proven for',
    async (provider) => {
      const { module, spec, spawned } = await runnerWith(ok);
      process.env[provider === 'claude' ? 'FAKE_CLAUDE_VERSION' : 'FAKE_CODEX_VERSION'] = '9.9.9';
      await expect(module.runner.start(spec(provider))).rejects.toMatchObject({
        reason: 'provider_version',
        details: { provider, installed: '9.9.9', allowed: ['0.0.0'] },
      });
      expect(await spawned(provider)).toBe(false);
    },
  );

  it.each(['claude', 'codex'] as const)(
    "%s: refuses when the VM's own configuration would override the protected start",
    async (provider) => {
      const { module, home, spec, spawned } = await runnerWith(ok);
      if (provider === 'claude')
        await writeFile(path.join(home, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
      else await writeFile(path.join(home, 'config.toml'), 'approval_policy = "on-request"\n');
      await expect(module.runner.start(spec(provider))).rejects.toMatchObject({ reason: 'ambient_config' });
      expect(await spawned(provider)).toBe(false);
    },
  );
});
