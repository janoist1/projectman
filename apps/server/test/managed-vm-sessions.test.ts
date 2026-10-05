import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BoundaryTarget, ProjectConfig } from '@projectman/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGED_VM_UNAVAILABLE } from '../src/contracts';
import type { BoundaryRequester, ManagedVmAttestation, ManagedVmBoundary } from '../src/contracts';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { FakeBoundaryAdapter, fakeBoundaryTarget } from './helpers/fake-boundary';
import { flush } from './helpers/fakes';

/*
 * PM-141: the managed VM execution profile in the domain, with the fake runner. The adapters and
 * the runner's own checks are tested in src/runner; here: what policy and spec a start builds,
 * that nothing starts without a verified boundary, that legacy installations are untouched, and
 * what does not carry over when a session changes profile.
 */

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  const { stdout } = await exec('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
}

let configDir: string;
beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'pm-gitconfig-'));
  const file = path.join(configDir, 'gitconfig');
  await writeFile(
    file,
    '[user]\n\tname = projectman test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n',
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', file);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

const ATTESTATION: ManagedVmAttestation = {
  profile: { name: 'managed-vm', version: 1 },
  verifiedAt: '2026-10-01T12:00:00.000Z',
  providerVersions: { claude: ['2.1.284'], codex: ['0.159.1'], nanogpt: [] },
};
const verified: ManagedVmBoundary = { verify: async () => ATTESTATION };

/** Members with the permission modes a real installation holds (they are read, never rewritten). */
const modes = (c: ProjectConfig) => {
  for (const [handle, permissionMode] of [
    ['dev-1', 'acceptEdits'],
    ['dev-2', 'plan'],
    ['cr', 'default'],
  ] as const) {
    const member = c.team.members.find((m) => m.handle === handle);
    if (member?.kind === 'ai') member.permissionMode = permissionMode;
  }
};

describe('the managed VM profile in the domain (PM-141)', { timeout: 60_000 }, () => {
  let h: DomainHarness;
  let initial: string;
  afterEach(async () => {
    await h.cleanup();
  });

  async function managed(opts: Parameters<typeof createDomainHarness>[0] = {}) {
    h = await createDomainHarness({
      memberWorkspaces: true,
      persistent: true,
      executionProfile: 'managed_vm',
      managedVm: verified,
      adjust: modes,
      ...opts,
    });
    await git(h.workspace, 'init', '--quiet', '-b', 'main');
    await writeFile(path.join(h.workspace, 'README.md'), 'hello\n');
    await git(h.workspace, 'add', 'README.md');
    await git(h.workspace, 'commit', '--quiet', '-m', 'Initial');
    initial = await git(h.workspace, 'rev-parse', 'HEAD');
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  }
  const workspaceOf = async (handle: string) =>
    path.join(await realpath(h.workspacesDir), 'AR', handle, 'web', 'repo');
  const homeOf = async (handle: string) => path.join(await realpath(h.workspacesDir), 'AR', handle, '.home');
  const startTask = (taskKey: string, assignee: string) =>
    h.domain.taskStarts.start('AR', taskKey, { assignee, actor: OWNER_ACTOR, author: OWNER });

  it('starts a developer question-free in its own workspace, with none of the legacy tool rules or sandbox', async () => {
    await managed();
    await startTask('AR-1', 'dev-1');
    const spec = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    expect(spec).toMatchObject({
      cwd: dev1,
      allowedTools: [],
      deniedTools: [],
      permissionMode: 'acceptEdits',
    });
    // PM-134's sandbox is a legacy setting: it must not put an inner limit back.
    expect(spec).not.toHaveProperty('sandbox');
    expect(spec.policy).toMatchObject({
      enforcement: 'legacy',
      execution: { profile: 'managed_vm', boundary: { name: 'managed-vm', version: 1 } },
      access: 'member_workspace',
      placement: {
        kind: 'member_workspace',
        path: dev1,
        use: 'work',
        workspace: { branch: 'AR-1-login-page', baseCommit: initial },
      },
      permissions: { claude: 'bypassPermissions', sandbox: 'danger-full-access', approval: 'never' },
      deniedOperations: [],
      outsideSandbox: 'deny',
    });
    expect(spec.policy?.filesystem.writableRoots).toEqual([dev1]);
    // The member's own mode is read, not rewritten.
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.find((m) => m.handle === 'dev-1')).toMatchObject({
      permissionMode: 'acceptEdits',
    });
    expect(h.repos.sessions.executionProfile(spec.sessionId)).toBe('managed_vm');
  });

  it('keeps no denied operations for a local-only repository: the gate, not a rule in the CLI, holds them', async () => {
    await managed({
      adjust: (c) => {
        modes(c);
        delete c.project.repos[0]!.github;
      },
    });
    await startTask('AR-1', 'dev-1');
    expect(h.runner.lastStarted().policy?.deniedOperations).toEqual([]);
  });

  it('leaves a member in plan mode research-only', async () => {
    await managed();
    await startTask('AR-1', 'dev-2');
    expect(h.runner.lastStarted().policy).toMatchObject({
      permissions: { claude: 'plan', sandbox: 'read-only', approval: 'never' },
      filesystem: { writableRoots: [] },
    });
  });

  it('puts a reviewer on the handed-over commit in its own workspace, question-free too', async () => {
    await managed();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    await writeFile(path.join(dev1, 'login.txt'), 'v1\n');
    await git(dev1, 'add', 'login.txt');
    await git(dev1, 'commit', '--quiet', '-m', 'Login');
    const handedOver = await git(dev1, 'rev-parse', 'HEAD');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(2), { timeout: 20_000, interval: 50 });
    const review = h.runner.lastStarted();
    expect(review).toMatchObject({ member: 'cr', cwd: await workspaceOf('cr'), allowedTools: [] });
    expect(review.policy).toMatchObject({
      execution: { profile: 'managed_vm' },
      placement: {
        kind: 'member_workspace',
        use: 'review',
        review: { sourceCommit: handedOver, sourceBranch: 'AR-1-login-page', baseCommit: initial },
      },
      permissions: { claude: 'bypassPermissions', approval: 'never' },
    });
  });

  it('gives a general chat and a task without a repository the member own directory, never a shared one', async () => {
    await managed();
    const chat = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const spec = h.runner.lastStarted();
    expect(spec.cwd).toBe(await homeOf('dev-1'));
    expect(spec.cwd).not.toBe(h.workspace);
    expect(spec.policy).toMatchObject({
      access: 'member_workspace',
      placement: { kind: 'member_workspace', path: await homeOf('dev-1'), use: 'home' },
      permissions: { claude: 'bypassPermissions' },
    });
    expect(spec.additionalDirectories).toBeUndefined();
    expect(chat.session.cwd).toBe(await homeOf('dev-1'));
  });

  describe('without a verified boundary', () => {
    it('starts nothing when the installation has no boundary, and prepares no workspace', async () => {
      await managed({ managedVm: undefined });
      await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({
        code: MANAGED_VM_UNAVAILABLE,
        details: { reason: 'no_boundary' },
      });
      await expect(h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).rejects.toMatchObject(
        {
          code: MANAGED_VM_UNAVAILABLE,
        },
      );
      expect(h.runner.started).toEqual([]);
      // Neither the workspace nor the home was made: nothing is prepared before the proof.
      await expect(realpath(path.join(h.workspacesDir, 'AR'))).rejects.toThrow();
    });

    it('starts nothing when the boundary does not verify, with its reason and without file content', async () => {
      await managed({
        managedVm: {
          verify: () =>
            Promise.reject(
              Object.assign(new Error('the VM boundary is not verified'), {
                code: MANAGED_VM_UNAVAILABLE,
                reason: 'not_ready',
                details: { failed: ['gate-control'], notPassed: ['launcher'] },
              }),
            ),
        },
      });
      await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({
        code: MANAGED_VM_UNAVAILABLE,
        status: 409,
        details: { reason: 'not_ready', failed: ['gate-control'], notPassed: ['launcher'] },
      });
      expect(h.runner.started).toEqual([]);
    });

    it('does not fall back to the legacy, freer or stricter, start', async () => {
      await managed({ managedVm: { verify: () => Promise.reject(new Error('disk on fire')) } });
      await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({
        code: MANAGED_VM_UNAVAILABLE,
        details: { reason: 'verification_failed' },
      });
      expect(h.runner.started).toEqual([]);
    });

    it('maps the runner refusal (a CLI version, the VM configuration) to the same error and fails the session', async () => {
      await managed();
      h.runner.failNextStart = Object.assign(
        new Error('claude 9.9.9 is not a version the profile is proven for'),
        {
          code: MANAGED_VM_UNAVAILABLE,
          reason: 'provider_version',
          details: { provider: 'claude', installed: '9.9.9', allowed: ['2.1.284'] },
        },
      );
      await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({
        code: MANAGED_VM_UNAVAILABLE,
        details: expect.objectContaining({ reason: 'provider_version', installed: '9.9.9' }),
      });
      const [session] = h.domain.sessions.list('AR', { member: 'dev-1' });
      expect(session).toMatchObject({ state: 'failed' });
    });
  });

  describe('the legacy installation', () => {
    it('is untouched: the same member keeps its mode, its command rules and its sandbox', async () => {
      h = await createDomainHarness({ adjust: modes });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await startTask('AR-1', 'dev-1');
      const spec = h.runner.lastStarted();
      expect(spec.policy?.execution).toBeUndefined();
      expect(spec.policy).toMatchObject({
        enforcement: 'legacy',
        access: 'task_worktree',
        permissions: { claude: 'acceptEdits', sandbox: 'workspace-write', approval: 'on-request' },
      });
      expect(spec.allowedTools.length).toBeGreaterThan(0);
      expect(spec.sandbox).toBeDefined();
      expect(h.repos.sessions.executionProfile(spec.sessionId)).toBe('legacy');
    });

    it('cannot be made freer by a boundary or a bypass mode: a legacy installation never reads them', async () => {
      // A boundary that always says yes, but no `managed_vm` setting: nothing changes.
      h = await createDomainHarness({
        adjust: (c) => {
          modes(c);
          const dev = c.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') dev.permissionMode = 'default';
        },
        managedVm: verified,
      });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await startTask('AR-1', 'dev-1');
      expect(h.runner.lastStarted().policy).toMatchObject({
        permissions: { claude: 'default', sandbox: 'read-only', approval: 'on-request' },
      });
      expect(h.runner.lastStarted().policy?.execution).toBeUndefined();
    });

    it('still decides permission requests through the inbox and its command rules', async () => {
      h = await createDomainHarness({ adjust: modes });
      await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
      await startTask('AR-1', 'dev-1');
      const spec = h.runner.lastStarted();
      const decision = h.runnerModule
        .broker()
        .decide(
          { sessionId: spec.sessionId, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, raw: {} },
          new AbortController().signal,
        );
      await flush();
      // A command no rule allows waits for a human.
      expect(h.repos.inbox.list('AR').filter((i) => i.kind === 'permission')).toHaveLength(1);
      void decision;
    });
  });

  describe('a managed VM session never reaches a human for permission', () => {
    it('answers a request at once, without an inbox item and without judging the command', async () => {
      await managed();
      await startTask('AR-1', 'dev-1');
      const spec = h.runner.lastStarted();
      const answer = await h.runnerModule.broker().decide(
        // A command the legacy rules would allow (read-only) and one they would hold for a human.
        { sessionId: spec.sessionId, toolName: 'Bash', toolInput: { command: 'rm -rf build' }, raw: {} },
        new AbortController().signal,
      );
      expect(answer).toMatchObject({
        behavior: 'deny',
        message: expect.stringContaining('without local approvals'),
      });
      expect(h.repos.inbox.list('AR').filter((i) => i.kind === 'permission')).toEqual([]);
    });
  });

  describe('changing profile', () => {
    let adapter: FakeBoundaryAdapter;
    const grantedTarget = (): BoundaryTarget => fakeBoundaryTarget({ expiresAt: '2026-10-01T23:00:00.000Z' });
    const now = () => new Date('2026-10-01T11:00:00.000Z');
    const withBoundary = (c: ProjectConfig) => {
      modes(c);
      c.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
    };

    async function startLegacyChat() {
      adapter = new FakeBoundaryAdapter();
      h = await createDomainHarness({
        persistent: true,
        now,
        adjust: withBoundary,
        boundaryAdapter: adapter,
      });
      const legacy = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const spec = h.runner.lastStarted();
      // The conversation exists: a restart in the same profile would resume it.
      h.runner.emit({
        type: 'transcript_path',
        sessionId: spec.sessionId,
        path: '/tmp/fictional-chat.jsonl',
      });
      await flush();
      return { legacy, spec };
    }

    async function restartManaged() {
      const before = adapter;
      h = await restartDomainHarness(h, {
        persistent: true,
        now,
        boundaryAdapter: before,
        memberWorkspaces: true,
        executionProfile: 'managed_vm',
        managedVm: verified,
      });
    }

    it('starts a new conversation in the new place: no old working directory, no resume', async () => {
      const { legacy, spec: first } = await startLegacyChat();
      expect(first.cwd).toBe(h.workspace);
      expect(h.repos.sessions.executionProfile(first.sessionId)).toBe('legacy');
      await restartManaged();
      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const spec = h.runner.lastStarted();
      expect(again.session.id).toBe(legacy.session.id);
      expect(again.resumed).toBe(false);
      expect(spec).toMatchObject({ resume: false, cwd: await homeOf('dev-1') });
      expect(spec.claudeSessionId).not.toBe(first.claudeSessionId);
      expect(h.repos.sessions.get(legacy.session.id)).toMatchObject({
        cwd: await homeOf('dev-1'),
        transcriptPath: null,
      });
      expect(h.repos.sessions.executionProfile(legacy.session.id)).toBe('managed_vm');
    });

    it('resumes in the same profile, in the same place', async () => {
      await managed();
      const first = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const spec = h.runner.lastStarted();
      h.runner.emit({
        type: 'transcript_path',
        sessionId: spec.sessionId,
        path: '/tmp/fictional-chat.jsonl',
      });
      await h.domain.sessions.stop('AR', spec.sessionId);
      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(again).toMatchObject({ resumed: true });
      expect(h.runner.lastStarted()).toMatchObject({
        resume: true,
        claudeSessionId: spec.claudeSessionId,
        cwd: await homeOf('dev-1'),
      });
      expect(again.session.id).toBe(first.session.id);
    });

    it('does not resume a managed VM conversation in a legacy installation either', async () => {
      await managed();
      const first = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const spec = h.runner.lastStarted();
      h.runner.emit({
        type: 'transcript_path',
        sessionId: spec.sessionId,
        path: '/tmp/fictional-chat.jsonl',
      });
      await flush();
      h = await restartDomainHarness(h, {});
      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      expect(again.session.id).toBe(first.session.id);
      expect(again.resumed).toBe(false);
      expect(h.runner.lastStarted()).toMatchObject({ resume: false, cwd: h.workspace });
      expect(h.runner.lastStarted().policy?.execution).toBeUndefined();
      expect(h.repos.sessions.executionProfile(first.session.id)).toBe('legacy');
    });

    it('voids what the session asked or was granted at the boundary under the old profile', async () => {
      const { legacy } = await startLegacyChat();
      const requester: BoundaryRequester = {
        projectKey: 'AR',
        member: 'dev-1',
        sessionId: legacy.session.id,
        taskKey: null,
      };
      adapter.register('op-1', requester, grantedTarget());
      const request = await h.domain.boundary.submit(requester, {
        operationId: 'op-1',
        deduplicationKey: 'op-1',
      });
      expect(request.state).toBe('pending_owner');
      await restartManaged();
      // The registry is rebuilt after the restart, as the protected adapter would.
      adapter.register('op-1', requester, grantedTarget());
      expect((await h.domain.boundary.read('AR', request.id, 'owner')).request.state).toBe('pending_owner');
      await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const after = (await h.domain.boundary.read('AR', request.id, 'owner')).request;
      expect(after).toMatchObject({
        state: 'revoked',
        invalidation: { reason: 'policy_changed', actor: { kind: 'system' } },
      });
    });
  });
});
