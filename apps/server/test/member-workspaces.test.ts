import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/kernel';
import { OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import {
  commitFile,
  createWorkspaceHarness,
  exists,
  git,
  twoTasks,
  useWorkspaceSeed,
  workspaceSteps,
} from './helpers/member-workspaces';
import type { WorkspaceHarnessOptions } from './helpers/member-workspaces';
import { createMemberMemoryStore } from '../src/context';
import { createMemberWorkspaceManager } from '../src/worktree';

/*
 * PM-138: durable member workspaces: clones, branches, task switches and dependencies. Reviews,
 * restarts and the workspace lifecycle are in the other `member-workspaces-*.test.ts` files; the
 * setup is in `helpers/member-workspaces`.
 */

describe('member workspaces (PM-138)', { timeout: 60_000 }, () => {
  const seed = useWorkspaceSeed();
  let h: DomainHarness;
  let initial: string;

  async function setup(opts: WorkspaceHarnessOptions = {}) {
    h = await createWorkspaceHarness(seed(), opts);
    initial = seed().commit;
  }
  afterEach(async () => {
    await h.cleanup();
  });

  const { workspaceOf, startTask, ensure, branchOf, startedCount } = workspaceSteps(() => h);

  it('gives each member its own clone, and every new task a fresh branch of its own', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    await startTask('AR-2', 'dev-2');
    const [first, second] = h.runner.started;
    const dev1 = await workspaceOf('dev-1');
    const dev2 = await workspaceOf('dev-2');
    expect(first).toMatchObject({ cwd: dev1, sandbox: expect.anything() });
    expect(second).toMatchObject({ cwd: dev2 });
    expect(first!.policy?.placement).toEqual({
      kind: 'task_worktree',
      path: dev1,
      workspace: { branch: 'AR-1-login-page', baseCommit: initial },
    });
    expect(await branchOf(dev1)).toBe('AR-1-login-page');
    expect(await branchOf(dev2)).toBe('AR-2-signup-page');
    // Independent clones: their own git directory, no shared objects, no remote.
    expect(await git(dev1, 'rev-parse', '--absolute-git-dir')).toBe(path.join(dev1, '.git'));
    expect(await git(dev1, 'remote')).toBe('');
    expect(await exists(path.join(dev1, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(h.domain.tasks.get('AR', 'AR-1').links).toContainEqual(
      expect.objectContaining({ kind: 'branch', ref: 'AR-1-login-page' }),
    );
    // The project repository did not change branch, nor get the task branches.
    expect(await branchOf(h.workspace)).toBe('main');
    expect(await git(h.workspace, 'branch', '--list', 'AR-*')).toBe('');
  });

  it('keeps a renamed member`s workspace, home, sandbox and memory under its storage handle (PM-1024)', async () => {
    const appHome = await mkdtemp(path.join(tmpdir(), 'pm-app-home-'));
    try {
      await setup({
        appHome,
        adjust: (c) => {
          const dev = c.team.members.find((m) => m.handle === 'dev-1');
          if (dev?.kind === 'ai') dev.formerHandles = ['old'];
        },
      });
      const memoryRoot = path.join(appHome, 'memory');
      const memory = createMemberMemoryStore({ rootDir: memoryRoot });
      vi.spyOn(h.memory, 'read').mockImplementation(memory.read);
      vi.spyOn(h.memory, 'append').mockImplementation(memory.append);
      await memory.append('AR', 'old', 'The build needs node 22.');
      await startTask('AR-1', 'dev-1');
      const stored = await workspaceOf('old');
      expect(h.runner.lastStarted()).toMatchObject({ cwd: stored });
      expect(await exists(await workspaceOf('dev-1'))).toBe(false);
      expect(await exists(path.join(appHome, 'member-caches', 'AR', 'old'))).toBe(true);
      expect(await exists(path.join(appHome, 'member-caches', 'AR', 'dev-1'))).toBe(false);
      expect(await h.domain.sessions.memory('AR', 'dev-1')).toContain('The build needs node 22.');
      expect(h.contextBuilder.inputs.at(-1)?.memory).toContain('The build needs node 22.');
      await h.domain.teamTools.saveMemory(
        { projectKey: 'AR', member: 'dev-1', sessionId: h.runner.lastStarted().sessionId, taskKey: 'AR-1' },
        { note: 'Keep the existing build cache.' },
      );
      expect(await readFile(path.join(memoryRoot, 'AR', 'old.md'), 'utf8')).toContain(
        'Keep the existing build cache.',
      );
      expect(await exists(path.join(memoryRoot, 'AR', 'dev-1.md'))).toBe(false);
      // The task's binding belongs to the current handle: the assignee finds its work again.
      expect(h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1')).toMatchObject([
        { member: 'dev-1', kind: 'work' },
      ]);
      const record = h.repos.memberWorkspaces.find('AR', 'old', 'web')!;
      expect(record).toMatchObject({ path: stored });
      expect(h.repos.memberWorkspaces.find('AR', 'dev-1', 'web')).toBeNull();
      const manager = createMemberWorkspaceManager({ rootDir: h.workspacesDir, logger: h.log.logger });
      expect(await manager.home({ projectKey: record.projectKey, member: record.member })).toBe(
        path.join(await realpath(h.workspacesDir), 'AR', 'old', '.home'),
      );
      // A second start continues in the same workspace on the same branch.
      await ensure('dev-1', 'AR-1');
      expect(await branchOf(stored)).toBe('AR-1-login-page');
    } finally {
      await rm(appHome, { recursive: true, force: true });
    }
  });

  it('keeps a second task of the same repository waiting while the first one works there', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    h.runner.setState(first.sessionId, 'idle');
    // Automatic start, a person's start and a message wake-up: none may switch the branch.
    await expect(startTask('AR-2', 'dev-1')).rejects.toMatchObject({ code: 'workspace_busy' });
    await expect(ensure('dev-1', 'AR-2')).rejects.toMatchObject({ code: 'workspace_busy' });
    await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], text: 'Start AR-2 too.', taskKey: 'AR-2' });
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.tasks.get('AR', 'AR-2').startWaiting).toMatchObject({ reason: 'workspace_busy' });
    const dev1 = await workspaceOf('dev-1');
    expect(await branchOf(dev1)).toBe('AR-1-login-page');

    // Once AR-1 moved on, its idle session gives way; its branch and commits stay.
    const work = await commitFile(dev1, 'login.txt', 'login\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await flush();
    await h.domain.admission.retryDeferred();
    await flush();
    expect(h.runner.stopped).toContain(first.sessionId);
    const second = h.runner.started.find((s) => s.member === 'dev-1' && s.sessionId !== first.sessionId);
    expect(second).toMatchObject({ cwd: dev1 });
    expect(await branchOf(dev1)).toBe('AR-2-signup-page');
    expect(await git(dev1, 'rev-parse', 'AR-1-login-page')).toBe(work);
    expect(h.domain.tasks.get('AR', 'AR-2').startWaiting).toBeUndefined();
  });

  it.each([false, true])(
    'yields an idle review workspace to its queue after two minutes (dirty: %s)',
    async (dirty) => {
      let clock = new Date('2026-10-21T12:00:00.000Z');
      await setup({
        now: () => clock,
        adjust: (config) => {
          twoTasks(config);
          const reviewer = config.team.members.find((member) => member.handle === 'cr')!;
          if (reviewer.kind === 'ai') reviewer.capacity = 2;
        },
      });
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
      await startedCount(1);
      const first = h.runner.lastStarted();
      h.runner.emit({
        type: 'transcript_path',
        sessionId: first.sessionId,
        path: '/tmp/fictional-review.jsonl',
      });
      h.runner.setState(first.sessionId, 'working');
      h.runner.setState(first.sessionId, 'idle');
      await commitFile(h.workspace, 'next.txt', 'next review base\n');
      await h.domain.tasks.moveToStage('AR', 'AR-2', 'code_review', OWNER_ACTOR);
      await vi.waitFor(() =>
        expect(h.repos.memberQueue.listOpen('AR', 'cr')).toContainEqual(
          expect.objectContaining({
            kind: 'start',
            taskKey: 'AR-2',
            wait: expect.objectContaining({ code: 'workspace_busy' }),
          }),
        ),
      );
      clock = new Date(clock.getTime() + 119_999);
      await h.domain.admission.retryDeferred();
      expect(h.runner.stopped).not.toContain(first.sessionId);
      if (dirty) await writeFile(path.join(await workspaceOf('cr'), 'draft.txt'), 'uncommitted review\n');
      clock = new Date(clock.getTime() + 1);
      await h.domain.admission.retryDeferred();
      if (dirty) {
        expect(h.repos.memberQueue.listOpen('AR', 'cr')).toContainEqual(
          expect.objectContaining({
            taskKey: 'AR-2',
            wait: expect.objectContaining({ code: 'workspace_dirty' }),
          }),
        );
        expect(await readFile(path.join(await workspaceOf('cr'), 'draft.txt'), 'utf8')).toBe(
          'uncommitted review\n',
        );
        expect(h.runner.started).toHaveLength(1);
      } else {
        expect(h.runner.stopped).toContain(first.sessionId);
        expect(h.runner.lastStarted().member).toBe('cr');
        expect(h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: 'AR-2' })).not.toBeNull();
        expect(h.domain.sessions.get('AR', first.sessionId).transcriptPath).toBe(
          '/tmp/fictional-review.jsonl',
        );
        expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
      }
    },
  );

  it('keeps an idle workspace while its member has an open queue item on its card', async () => {
    let clock = new Date('2026-10-21T12:00:00.000Z');
    await setup({ now: () => clock });
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    h.runner.setState(first.sessionId, 'idle');
    h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['dev-1'],
      taskKey: 'AR-1',
      body: 'Pending work',
      kind: 'info',
      actor: OWNER_ACTOR,
    });
    h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['dev-1'],
      taskKey: 'AR-2',
      body: 'Other work',
      kind: 'action',
      actor: OWNER_ACTOR,
    });
    clock = new Date(clock.getTime() + 2 * 60_000);
    await expect(ensure('dev-1', 'AR-2')).rejects.toMatchObject({ code: 'workspace_busy' });
    expect(h.runner.stopped).not.toContain(first.sessionId);
  });

  it('lets another repository of the same member run in parallel', async () => {
    await setup({
      adjust: (c) => {
        twoTasks(c);
        c.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main' });
      },
    });
    const api = path.join(h.workspace, 'api');
    await mkdir(api);
    await git(api, 'init', '--quiet', '-b', 'main');
    await commitFile(api, 'API.md', 'api\n');
    await h.domain.tasks.update('AR', 'AR-1', { repo: 'web' }, OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-2', { repo: 'api' }, OWNER_ACTOR);
    await startTask('AR-1', 'dev-1');
    await startTask('AR-2', 'dev-1');
    expect(h.runner.started.map((s) => s.cwd)).toEqual([
      await workspaceOf('dev-1'),
      path.join(await realpath(h.workspacesDir), 'AR', 'dev-1', 'api', 'repo'),
    ]);
  });

  it('never switches away from uncommitted work: the start fails and nothing is stashed or reset', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    // The developer keeps working on something uncommitted after the hand-over (PM-183 refuses a
    // hand-over with it, but the workspace can get dirty afterwards).
    await writeFile(path.join(dev1, 'draft.txt'), 'not committed\n');
    h.runner.setState(first.sessionId, 'idle');
    await flush();
    await expect(startTask('AR-2', 'dev-1')).rejects.toMatchObject({ code: 'workspace_dirty' });
    expect(await branchOf(dev1)).toBe('AR-1-login-page');
    expect(await readFile(path.join(dev1, 'draft.txt'), 'utf8')).toBe('not committed\n');
    expect(h.runner.started.filter((s) => s.member === 'dev-1')).toHaveLength(1);

    // A person (or the member) commits it: then the switch happens.
    await git(dev1, 'add', 'draft.txt');
    await git(dev1, 'commit', '--quiet', '-m', 'Keep the draft');
    await startTask('AR-2', 'dev-1');
    expect(await branchOf(dev1)).toBe('AR-2-signup-page');
  });

  it('refuses a switch during an interrupted git operation', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    await writeFile(path.join(dev1, '.git', 'index.lock'), '');
    await h.domain.sessions.stop('AR', first.sessionId);
    await expect(startTask('AR-2', 'dev-1')).rejects.toMatchObject({
      code: 'workspace_dirty',
      details: expect.objectContaining({ operation: 'index-lock' }),
    });
    expect(await branchOf(dev1)).toBe('AR-1-login-page');
  });

  it('gives the member back its branch in the middle of a merge, with the conflicts named (PM-1326)', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    const own = await branchOf(dev1);
    await commitFile(dev1, 'clash.txt', 'mine\n');
    await git(dev1, 'switch', '--quiet', '-c', 'side', 'HEAD~1');
    await commitFile(dev1, 'clash.txt', 'theirs\n');
    await git(dev1, 'switch', '--quiet', own);
    await expect(git(dev1, 'merge', '--no-edit', 'side')).rejects.toThrow();
    // A pause or an engine switch ends the session in the middle of the merge.
    await h.domain.sessions.stop('AR', first.sessionId);

    await ensure('dev-1', 'AR-1', 'Settle the merge');
    expect(h.runner.started.filter((s) => s.member === 'dev-1')).toHaveLength(2);
    expect(h.runner.lastStarted()).toMatchObject({ cwd: dev1 });
    expect(h.contextBuilder.inputs.at(-1)).toMatchObject({
      unfinishedGitOperation: { operation: 'merge', conflicts: ['clash.txt'] },
    });
    expect(await readFile(path.join(dev1, 'clash.txt'), 'utf8')).toContain('<<<<<<<');
    // Another task still waits for a settled workspace, and the merge is not touched.
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    await expect(startTask('AR-2', 'dev-1')).rejects.toMatchObject({ code: 'workspace_dirty' });
    expect(await branchOf(dev1)).toBe(own);
  });

  it('starts the member even when the workspace status cannot be read (PM-1326)', async () => {
    await setup({
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        status: async () => {
          throw new Error('fixture: status unreadable');
        },
      }),
    });
    await startTask('AR-1', 'dev-1');
    expect(h.runner.lastStarted()).toMatchObject({ member: 'dev-1' });
    expect(h.contextBuilder.inputs.at(-1)?.unfinishedGitOperation).toBeUndefined();
  });

  it('resumes a task on its own branch with its uncommitted work, in the same conversation', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    await writeFile(path.join(dev1, 'wip.txt'), 'half done\n');
    h.runner.emit({ type: 'transcript_path', sessionId: first.sessionId, path: '/tmp/fictional-dev.jsonl' });
    await h.domain.sessions.stop('AR', first.sessionId);
    const resumed = await ensure('dev-1', 'AR-1', 'Any news?');
    expect(resumed).toMatchObject({ resumed: true, messagesSent: 1 });
    expect(h.runner.lastStarted()).toMatchObject({ cwd: dev1, resume: true });
    expect(await readFile(path.join(dev1, 'wip.txt'), 'utf8')).toBe('half done\n');
  });

  it('does not start a new task from a stale base when the default branch cannot be fetched', async () => {
    await setup();
    await git(h.workspace, 'remote', 'add', 'origin', path.join(h.dir, 'missing.git'));
    await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({ code: 'workspace_fetch_failed' });
    expect(h.runner.started).toHaveLength(0);
  });

  it('waits for dependency readiness after checkout and before recording the binding or launching, including resume', async () => {
    const preparationGate = () => {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { entered, ready, enter, release };
    };
    // Both gates exist before checkout, so even a late preparation can be released on failure.
    const initialPreparation = preparationGate();
    const resumePreparation = preparationGate();
    const gates = [initialPreparation, resumePreparation];
    const prepared: string[] = [];
    await setup({
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        prepareDependencies: async (key) => {
          expect(await branchOf((await inner.location(key)).path)).toBe('AR-1-login-page');
          const gate = gates[prepared.length];
          if (!gate) throw new Error('Unexpected dependency preparation');
          prepared.push(key.member);
          gate.enter();
          await gate.ready;
          return { status: 'ready', key: 'a'.repeat(64), changed: true };
        },
      }),
    });
    const saveBinding = vi.spyOn(h.repos.memberWorkspaces, 'saveBinding');
    const pending: Promise<unknown>[] = [];
    try {
      const starting = startTask('AR-1', 'dev-1');
      pending.push(starting);
      // An early start failure must reject the test instead of leaving the entry wait pending.
      await Promise.race([initialPreparation.entered, starting]);
      expect(prepared).toEqual(['dev-1']);
      expect(h.runner.started).toHaveLength(0);
      expect(saveBinding).not.toHaveBeenCalled();
      expect(h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1')).toHaveLength(0);
      initialPreparation.release();
      await starting;
      expect(h.runner.started).toHaveLength(1);
      expect(saveBinding).toHaveBeenCalledTimes(1);
      const first = h.runner.lastStarted();
      h.runner.emit({
        type: 'transcript_path',
        sessionId: first.sessionId,
        path: '/tmp/fictional-deps.jsonl',
      });
      await h.domain.sessions.stop('AR', first.sessionId);
      const resuming = ensure('dev-1', 'AR-1');
      pending.push(resuming);
      await Promise.race([resumePreparation.entered, resuming]);
      expect(prepared).toEqual(['dev-1', 'dev-1']);
      expect(h.runner.started).toHaveLength(1);
      expect(saveBinding).toHaveBeenCalledTimes(1);
      resumePreparation.release();
      await expect(resuming).resolves.toMatchObject({ resumed: true });
      expect(h.runner.started).toHaveLength(2);
      expect(saveBinding).toHaveBeenCalledTimes(2);
    } finally {
      for (const gate of gates) gate.release();
      // Drain in-flight starts before afterEach stops the domain and removes its repositories.
      await Promise.allSettled(pending);
    }
  });

  it.each(['workspace_dependencies_pending', 'workspace_dependencies_failed'] as const)(
    'releases the reservation after %s and permits a later retry',
    async (code) => {
      let refuse = true;
      const details = code.endsWith('pending')
        ? { startedAt: '2026-10-16T20:00:00.000Z' }
        : { reason: 'install_failed', exitCode: 23, key: 'a'.repeat(64) };
      await setup({
        wrapMemberWorkspaces: (inner) => ({
          ...inner,
          prepareDependencies: async () => {
            if (refuse) throw Object.assign(new Error('fixture dependency refusal'), { code, details });
            return { status: 'ready', key: 'a'.repeat(64), changed: false };
          },
        }),
      });
      await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({
        code,
        details: { member: 'dev-1', ...details },
      });
      expect(h.runner.started).toHaveLength(0);
      expect(h.repos.memberWorkspaces.find('AR', 'dev-1', 'web')?.holder).toBeNull();
      expect(h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1')).toHaveLength(0);
      refuse = false;
      await startTask('AR-1', 'dev-1');
      expect(h.runner.started).toHaveLength(1);
    },
  );

  it('hands the dependency shortfall the engine reported to the session context (PM-1203)', async () => {
    await setup({
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        prepareDependencies: async () => ({
          status: 'skipped',
          reason: 'not_configured',
          dependencies: 'missing',
        }),
      }),
    });
    await startTask('AR-1', 'dev-1');
    expect(h.contextBuilder.inputs.at(-1)).toMatchObject({ workspaceDependencies: 'missing' });
  });

  it('prepares review dependencies after checking out the snapshot commit and before launching', async () => {
    let ready!: () => void;
    // Create the gate before checkout so finally can release even a late preparation.
    const dependenciesReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const reviewHeads: string[] = [];
    await setup({
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        prepareDependencies: async (key) => {
          if (key.member === 'cr') {
            const ws = await inner.location(key);
            const head = await git(ws.path, 'rev-parse', 'HEAD');
            expect(await branchOf(ws.path)).toBe('');
            reviewHeads.push(head);
            await dependenciesReady;
          }
          return { status: 'ready', key: key.member, changed: true };
        },
      }),
    });
    try {
      await startTask('AR-1', 'dev-1');
      const commit = await commitFile(await workspaceOf('dev-1'), 'login.txt', 'review version');
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
      await vi.waitFor(() => expect(reviewHeads).toEqual([commit]), { timeout: 15_000 });
      expect(h.runner.started).toHaveLength(1);
    } finally {
      ready();
    }
    await startedCount(2);
    expect(h.runner.lastStarted()).toMatchObject({ member: 'cr' });
  });

  it('reports a missing task branch instead of starting the task over', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    await git(dev1, 'switch', '--quiet', 'main');
    await git(dev1, 'branch', '--quiet', '-D', 'AR-1-login-page');
    await expect(ensure('dev-1', 'AR-1')).rejects.toMatchObject({ code: 'workspace_branch_missing' });
  });
});
