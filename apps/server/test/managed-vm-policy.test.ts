import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managedVmPermissions, parseExecutionProfile, sessionPermissions } from '@projectman/shared';
import { buildApp } from '../src/app';
import type { ManagedVmBoundary, SessionPolicy } from '../src/contracts';
import { buildSessionPolicy } from '../src/domain/session-policy';
import { freePort } from '../src/runner/test-helpers';
import { testBoundaryConfig } from '../src/runtime-boundary/test-helpers';
import { testConfig } from './helpers/test-template';

/*
 * PM-141: the managed VM execution profile in the policy model and at start-up. Legacy, default
 * and plan settings of an existing installation stay as they are; the new profile is explicit.
 */

const boundary = { name: 'managed-vm', version: 1 };
const placement = (use: 'work' | 'review' | 'home' = 'home'): SessionPolicy['placement'] => ({
  kind: 'member_workspace',
  path: '/vm/workspaces/AR/dev-1/web/repo',
  use,
});
const managed = (permissionMode?: string, role = 'developer') =>
  buildSessionPolicy({
    config: testConfig(),
    role,
    task: { repo: 'web' },
    placement: placement(),
    permissionMode,
    managedVm: { boundary },
  });

describe('the managed VM session policy', () => {
  it('is a separate profile: legacy enforcement, no strict claim, the member workspace placement', () => {
    const policy = managed('acceptEdits');
    expect(policy).toMatchObject({
      version: 1,
      enforcement: 'legacy',
      access: 'member_workspace',
      execution: { profile: 'managed_vm', boundary },
      deniedOperations: [],
      outsideSandbox: 'deny',
    });
    expect(policy.reviewCopyMode).toBeUndefined();
    expect(policy.filesystem.writableRoots).toEqual(['/vm/workspaces/AR/dev-1/web/repo']);
  });

  it.each([undefined, 'default', 'acceptEdits', 'auto', 'bypassPermissions'])(
    'runs a member in mode %s question-free, whatever the old mapping said',
    (mode) => {
      expect(managed(mode).permissions).toEqual(managedVmPermissions(mode));
      expect(managed(mode).permissions).toEqual({
        claude: 'bypassPermissions',
        sandbox: 'danger-full-access',
        approval: 'never',
      });
    },
  );

  it('keeps a member in plan mode research-only, with nothing to write', () => {
    expect(managed('plan').permissions).toEqual({ claude: 'plan', sandbox: 'read-only', approval: 'never' });
    expect(managed('plan').filesystem.writableRoots).toEqual([]);
  });

  it('lets a reader (reviewer, QA, general) work freely in its own workspace, which the legacy path never did', () => {
    const reviewer = managed('default', 'code_review');
    expect(reviewer.permissions.claude).toBe('bypassPermissions');
    // The legacy mapping of the same member and mode: read-only, asking.
    expect(sessionPermissions('default', 'review_copy')).toMatchObject({
      sandbox: 'read-only',
      approval: 'on-request',
    });
  });

  it('works only in the member workspace placement', () => {
    for (const other of [
      { kind: 'task_worktree', path: '/w' },
      { kind: 'read_only', path: '/w' },
    ] as const) {
      expect(() =>
        buildSessionPolicy({
          config: testConfig(),
          role: 'developer',
          task: { repo: 'web' },
          placement: other,
          managedVm: { boundary },
        }),
      ).toThrow(/member workspace placement/);
    }
  });

  it('leaves the legacy policy as it was: no execution profile, the old mapping of the mode', () => {
    const legacy = buildSessionPolicy({
      config: testConfig(),
      role: 'developer',
      task: { repo: 'web' },
      placement: { kind: 'task_worktree', path: '/w' },
      permissionMode: 'default',
    });
    expect(legacy.execution).toBeUndefined();
    expect(legacy.permissions).toEqual({ claude: 'default', sandbox: 'read-only', approval: 'on-request' });
    // The legacy mapping never produces the new freedom.
    for (const mode of [undefined, 'default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']) {
      expect(sessionPermissions(mode).sandbox).not.toBe('danger-full-access');
      expect(sessionPermissions(mode, 'member_workspace').sandbox).not.toBe('danger-full-access');
      expect(sessionPermissions(mode).approval === 'never').toBe(mode === 'plan');
    }
  });
});

describe('the profile setting at start-up', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-vm-home-'));
    homes.push(dir);
    return dir;
  };
  const verified: ManagedVmBoundary = {
    verify: async () => ({
      profile: boundary,
      verifiedAt: '2026-10-01T12:00:00.000Z',
      providerVersions: { claude: ['2.1.284'], codex: ['0.159.1'], nanogpt: [] },
    }),
  };

  it('refuses an unknown profile name, never a fallback', () => {
    expect(() => parseExecutionProfile('managed-vm')).toThrow(/unknown execution profile/);
    return expect(buildApp({ home: home(), executionProfile: 'vm' as never, logger: false })).rejects.toThrow(
      /unknown execution profile/,
    );
  });

  it('refuses the managed VM without member workspaces: its placement needs them', async () => {
    await expect(
      buildApp({
        home: home(),
        logger: false,
        executionProfile: 'managed_vm',
        modules: { managedVmBoundary: verified },
      }),
    ).rejects.toThrow(/needs member workspaces/);
  });

  it('refuses the managed VM outside the VM boundary (PM-140), even with a readiness report', async () => {
    await expect(
      buildApp({ home: home(), logger: false, executionProfile: 'managed_vm', memberWorkspaces: true }),
    ).rejects.toThrow(/needs the VM boundary configuration/);
    await expect(
      buildApp({
        home: home(),
        logger: false,
        executionProfile: 'managed_vm',
        memberWorkspaces: true,
        vmReadinessReport: '/var/lib/projectman-boundary/readiness.json',
      }),
    ).rejects.toThrow(/needs the VM boundary configuration/);
  });

  it('refuses a readiness report on a legacy installation: the setting that would use it is not there', async () => {
    await expect(
      buildApp({ home: home(), logger: false, vmReadinessReport: '/var/lib/projectman-boundary/r.json' }),
    ).rejects.toThrow(/execution profile is not managed_vm/);
    await expect(
      buildApp({ home: home(), logger: false, modules: { managedVmBoundary: verified } }),
    ).rejects.toThrow(/execution profile is not managed_vm/);
  });

  it('starts the managed VM installation, which then proves its boundary at every session start', async () => {
    const dir = home();
    const app = await buildApp({
      home: dir,
      logger: false,
      executionProfile: 'managed_vm',
      memberWorkspaces: true,
      // On a machine that is not the guest, the boundary never verifies: a start-up check only
      // needs the configuration (and the report path it names), the proof comes at the first session.
      runtimeBoundary: testBoundaryConfig({
        launcher: { socket: join(dir, 'no-launcher.sock'), maxSessions: 4 },
        readiness: { report: join(dir, 'no-report.json'), maxAgeSeconds: 3600 },
        egress: { ...testBoundaryConfig().egress, port: await freePort() },
      }),
    });
    await app.close();
  });
});
