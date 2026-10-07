import { describe, expect, it } from 'vitest';
import type { SessionPolicy } from '../src/contracts';
import {
  HARD_DENIED_HOSTS,
  SANDBOX_ALLOWED_DOMAINS,
  SANDBOX_DENIED_ENV_VARS,
  sensitivePaths,
  sessionSandbox,
} from '../src/domain/session-policy';
import { describeSandbox } from '../src/domain/unattended-commands';
import { buildSettings } from '../src/runner/providers/claude/args';
import { buildSessionPolicy } from './helpers/session-policy';
import { testConfig } from './helpers/test-template';

/** The member's outbound network setting in the sandbox rules the CLI gets (PM-355). */
const source = '/fictional/source';
const sharedGit = '/fictional/repo/.git';
const userHome = '/fictional/user';
const appHome = '/fictional/app';
const paths = { userHome, appHome, defaultBranch: 'main' };
const boundary = { name: 'managed-vm', version: 1 };

const placements = {
  developer: { role: 'developer', placement: { kind: 'task_worktree', path: source, gitDir: sharedGit } },
  reader: { role: 'qa', placement: { kind: 'read_only', path: source } },
} as const;

function policy(kind: keyof typeof placements, outboundNetwork: boolean, localOnly = false): SessionPolicy {
  const config = testConfig();
  if (localOnly) delete config.project.repos[0]!.github;
  return buildSessionPolicy({
    config,
    role: placements[kind].role,
    task: { repo: 'web' },
    placement: placements[kind].placement,
    permissionMode: 'acceptEdits',
    deniedPaths: sensitivePaths({ userHome, appHome }),
    outboundNetwork,
  });
}

const kinds = Object.keys(placements) as Array<keyof typeof placements>;

describe.each(kinds)('the sandbox of a %s', (kind) => {
  it('reaches any host but the denied ones with the outbound network on', () => {
    const p = policy(kind, true);
    expect(p.network.outbound).toBe('open');
    const sandbox = sessionSandbox(p, paths)!;
    expect(sandbox.allowedDomains).toEqual(['*']);
    expect(sandbox.deniedDomains).toEqual(HARD_DENIED_HOSTS);
    expect(sandbox.allowLocalBinding).toBe(true);
  });

  it('keeps today’s npm-only sandbox, with no denied hosts, with the outbound network off', () => {
    const p = policy(kind, false);
    expect(p.network.outbound).toBe('allowlist');
    const sandbox = sessionSandbox(p, paths)!;
    expect(sandbox.allowedDomains).toEqual(SANDBOX_ALLOWED_DOMAINS);
    expect(sandbox).not.toHaveProperty('deniedDomains');
    expect(sandbox.allowLocalBinding).toBe(true);
  });

  it.each([true, false])(
    'hands the CLI a strict allowlist, and the protections stay (network %s)',
    (network) => {
      const p = policy(kind, network, true);
      const sandbox = sessionSandbox(p, paths)!;
      const settings = buildSettings({
        hookUrl: 'http://fake/hooks',
        permissionTimeoutMs: 1000,
        allowedTools: [],
        policy: p,
        sandbox,
      });
      expect(settings.sandbox?.network).toMatchObject({
        strictAllowlist: true,
        allowedDomains: network ? ['*'] : SANDBOX_ALLOWED_DOMAINS,
      });
      // The publishing commands stay refused and the credentials stay unreadable.
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining(['Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)']),
      );
      expect(settings.sandbox?.filesystem.denyRead).toEqual(
        expect.arrayContaining([
          `${userHome}/.ssh`,
          `${userHome}/.config/gh`,
          `${userHome}/.claude/.credentials.json`,
        ]),
      );
      // A developer's commands also lose the publishing tokens from their environment (a reader runs none).
      if (kind === 'developer') expect(sandbox.deniedEnvVars).toEqual(SANDBOX_DENIED_ENV_VARS);
    },
  );

  it('tells the member the network it really has', () => {
    const text = (network: boolean) =>
      describeSandbox({
        sandbox: sessionSandbox(policy(kind, network), paths)!,
        cwd: source,
        localOnly: false,
      }).join('\n');
    expect(text(true)).toContain(
      `- Network: any outbound host except ${HARD_DENIED_HOSTS.map((host) => `\`${host}\``).join(', ')}; tests may listen on local ports.`,
    );
    expect(text(false)).toContain('- Network: only `registry.npmjs.org`; tests may listen on local ports.');
    expect(text(false)).not.toMatch(/ask for permission/);
  });
});

describe('the managed VM profile', () => {
  it.each([true, false])('is the same whatever the outbound network setting is (%s)', (outboundNetwork) => {
    const vm = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      placement: { kind: 'member_workspace', path: '/vm/workspaces/AR/dev-1/web/repo', use: 'home' },
      permissionMode: 'acceptEdits',
      managedVm: { boundary },
      outboundNetwork,
    });
    expect(vm.network).toEqual({ allowedDomains: [], allowLocalBinding: false });
    expect(sessionSandbox(vm, paths)).toBeUndefined();
  });
});
