import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_ENGINE_ID } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiActor, newId } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/*
 * PM-138: durable member workspaces with the real git-backed manager and the fake runner. The
 * project's repository is the harness workspace itself (the test template's `web` repo, path `.`).
 */

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  const { stdout } = await exec('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
}

async function commitFile(repo: string, file: string, content: string): Promise<string> {
  await writeFile(path.join(repo, file), content);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', `Change ${file}`);
  return git(repo, 'rev-parse', 'HEAD');
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

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

/** dev-1 may carry two tasks: the same repository still serves one at a time. */
const twoTasks = (c: ProjectConfig) => {
  const dev = c.team.members.find((m) => m.handle === 'dev-1');
  if (dev?.kind === 'ai') dev.capacity = 2;
};

describe('member workspaces (PM-138)', { timeout: 60_000 }, () => {
  let h: DomainHarness;
  let initial: string;

  async function setup(opts: Parameters<typeof createDomainHarness>[0] = {}) {
    h = await createDomainHarness({ memberWorkspaces: true, persistent: true, adjust: twoTasks, ...opts });
    await git(h.workspace, 'init', '--quiet', '-b', 'main');
    await writeFile(path.join(h.workspace, '.gitignore'), 'node_modules/\n');
    await git(h.workspace, 'add', '.gitignore');
    initial = await commitFile(h.workspace, 'README.md', 'hello\n');
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Signup page' }, OWNER_ACTOR);
  }
  afterEach(async () => {
    await h.cleanup();
  });

  const workspaceOf = async (handle: string) =>
    path.join(await realpath(h.workspacesDir), 'AR', handle, 'web', 'repo');
  const startTask = (taskKey: string, assignee: string) =>
    h.domain.taskStarts.start('AR', taskKey, { assignee, actor: OWNER_ACTOR, author: OWNER });
  const ensure = (handle: string, taskKey: string, message?: string) =>
    h.domain.sessions.ensureSession(
      'AR',
      handle,
      { type: 'task', taskKey },
      { messages: message ? [message] : undefined },
    );
  const branchOf = (dir: string) => git(dir, 'branch', '--show-current');
  /** Background starts (hand-overs, message wake-ups) run real git: wait for the n-th start. */
  const startedCount = (n: number) =>
    vi.waitFor(() => expect(h.runner.started).toHaveLength(n), { timeout: 20_000, interval: 50 });

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

  it("reviews the handed-over commit in the reviewer's own workspace; a new round on a stage entry or the developer's message", async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    const cr = await workspaceOf('cr');
    expect(review).toMatchObject({ member: 'cr', cwd: cr });
    expect(review.policy?.placement).toMatchObject({
      kind: 'review_copy',
      path: cr,
      sourceCommit: handedOver,
      sourceBranch: 'AR-1-login-page',
      baseCommit: initial,
      roundId: '1',
    });
    expect(h.contextBuilder.inputs.at(-1)?.sessionPolicy).toBe(review.policy);
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(handedOver);
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    h.runner.setState(review.sessionId, 'idle');

    // Later and uncommitted work of the developer does not reach the running round.
    const fixed = await commitFile(dev1, 'login.txt', 'v2\n');
    await writeFile(path.join(dev1, 'scratch.txt'), 'scratch\n');
    await h.domain.messaging.send('AR', 'owner', { to: ['cr'], text: 'How is it going?', taskKey: 'AR-1' });
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(handedOver);

    // The developer asks for a re-review: the idle reviewer restarts on the new commit and
    // continues its conversation with the request.
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['cr'], text: 'Fixed, please look again.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    await startedCount(3);
    expect(h.runner.stopped).toContain(review.sessionId);
    const round2 = h.runner.lastStarted();
    expect(round2).toMatchObject({
      sessionId: review.sessionId,
      resume: true,
      initialMessage: expect.stringContaining('Fixed, please look again.'),
    });
    expect(round2.policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(fixed);
    expect(await exists(path.join(cr, 'scratch.txt'))).toBe(false);
    // The reviewer joining the card was told to the developer once; its restart for the new round was not a joining (PM-249).
    const joinedTold = h.runner.messages.filter(
      (m) => m.sessionId === h.runner.started[0]!.sessionId && m.text.includes('Coordinate by send_message'),
    );
    expect(joinedTold.map((m) => m.text)).toEqual([
      expect.stringContaining('`cr` (code reviewer) started working on AR-1 too'),
    ]);

    // Continuing the round (a restart, a person's resume) keeps its commit.
    await commitFile(dev1, 'login.txt', 'v3\n');
    await h.domain.sessions.stop('AR', review.sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
  });

  it('reads the fetched default branch for a reader on a card with no branch yet, pinned for the round (PM-805)', async () => {
    await setup();
    const head = await commitFile(h.workspace, 'docs.txt', 'current\n');
    await ensure('cr', 'AR-2');
    const first = h.runner.lastStarted();
    const cr = await workspaceOf('cr');
    expect(first).toMatchObject({ member: 'cr', cwd: cr });
    expect(first.policy?.placement).toMatchObject({
      kind: 'review_copy',
      path: cr,
      sourceCommit: head,
      sourceBranch: 'main',
      baseCommit: head,
      roundId: '1',
    });
    expect(await git(cr, 'rev-parse', 'HEAD')).toBe(head);
    expect(await branchOf(cr)).toBe('');

    // Continuing the round keeps its pin even when the default branch moves on.
    await commitFile(h.workspace, 'docs.txt', 'newer\n');
    await h.domain.sessions.stop('AR', first.sessionId);
    await ensure('cr', 'AR-2');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: head, roundId: '1' });
  });

  it('pins a review round to a snapshot in the project repository and imports the approved commit for the merge (PM-739)', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    const known = (commit: string) =>
      git(h.workspace, 'cat-file', '-e', `${commit}^{commit}`).then(
        () => true,
        () => false,
      );
    expect(await known(handedOver)).toBe(false);

    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const snapshot = `refs/projectman/workspaces/dev-1/AR-1/${handedOver}`;
    const pin = () => h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review')!;
    expect(pin()).toMatchObject({
      sourcePath: await realpath(h.workspace),
      sourceRef: snapshot,
      sourceCommit: handedOver,
      round: 1,
    });
    expect(await git(h.workspace, 'rev-parse', snapshot)).toBe(handedOver);
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceBranch: 'AR-1-login-page' });
    // The developer's branch name is not made in the project repository.
    expect(await git(h.workspace, 'branch', '--list', 'AR-1-login-page')).toBe('');

    // Later work of the developer does not change the pin; the same round continues on it.
    await commitFile(dev1, 'login.txt', 'v2\n');
    const review = h.runner.lastStarted();
    await h.domain.sessions.stop('AR', review.sessionId);
    await ensure('cr', 'AR-1');
    expect(pin()).toMatchObject({ sourceRef: snapshot, sourceCommit: handedOver, round: 1 });

    // The merge reads the approved commit from the project repository: it is imported once.
    const approved = await commitFile(dev1, 'login.txt', 'v3\n');
    expect(await known(approved)).toBe(false);
    const config = await h.domain.projects.config('AR');
    const task = h.domain.tasks.get('AR', 'AR-1');
    await h.domain.sessions.prepareMergeSource(config, task, approved);
    await h.domain.sessions.prepareMergeSource(config, task, approved);
    expect(await known(approved)).toBe(true);
    expect(await git(h.workspace, 'rev-parse', `refs/projectman/workspaces/dev-1/AR-1/${approved}`)).toBe(
      approved,
    );
    // A commit the developer's branch does not hold is refused, never taken from anywhere else.
    await expect(h.domain.sessions.prepareMergeSource(config, task, 'f'.repeat(40))).rejects.toMatchObject({
      code: 'workspace_source_missing',
    });
  });

  it('restarts a hybrid merger in its fix checkout, releases the old scope and ignores clone reservations and review refreshes', async () => {
    const liveProcesses = new Set([1002]);
    await setup({
      liveProcesses,
      adjust(config) {
        twoTasks(config);
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'cr' };
        config.pipeline.stages = config.pipeline.stages.filter(
          (stage) => stage.id !== 'merge' && stage.id !== 'release',
        );
        config.pipeline.stages.find((stage) => stage.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
        const reviewer = config.team.members.find((m) => m.handle === 'cr')!;
        if (reviewer.kind === 'ai') {
          reviewer.role = 'lead_developer';
          reviewer.permissionMode = 'auto';
        }
      },
    });
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    scopeStarts();
    vi.spyOn(h.runner, 'stop').mockImplementation(async (sessionId) => {
      h.runner.stopped.push(sessionId);
      h.runner.emit({
        type: 'exit',
        sessionId,
        exitCode: 0,
        signal: null,
        cleanup: scopeCleanup('scp_0123456789abcdef', 'clean'),
      });
    });
    await startTask('AR-1', 'dev-1');
    const approved = await commitFile(await workspaceOf('dev-1'), 'login.txt', 'approved\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    const pin = h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review')!;
    expect(review.member).toBe('cr');
    expect(h.repos.memberWorkspaces.heldBy(review.sessionId)[0]?.holder).toMatchObject({
      pid: 1002,
      scopeId: 'scp_0123456789abcdef',
    });
    h.runner.setState(review.sessionId, 'working');
    const now = new Date().toISOString();
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { labels: ['code-review-ok'] });
    h.repos.taskMerges.save({
      id: newId('merge'),
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      base: 'main',
      commit: approved,
      branch: 'AR-1-login-page',
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'cr',
      requestedAt: now,
      state: 'fixing',
      landed: 'nowhere',
      createdAt: now,
      updatedAt: now,
      fix: { by: 'cr', base: initial, branch: 'merge-fix/AR-1', startedAt: now },
    });
    h.runner.setState(review.sessionId, 'idle');
    await startedCount(3);
    const fixer = h.runner.lastStarted();
    expect(fixer).toMatchObject({
      sessionId: review.sessionId,
      policy: { placement: { kind: 'task_worktree', mergeFix: { branch: 'merge-fix/AR-1' } } },
    });
    expect(fixer.cwd).toContain('_merge-fix');
    expect(fixer.policy?.filesystem.writableRoots).toContain(fixer.cwd);
    expect(h.repos.memberWorkspaces.heldBy(fixer.sessionId)).toHaveLength(0);
    expect(h.repos.memberWorkspaces.get(pin.workspaceId)?.holder).toBeNull();

    // The merger can review another task in its clone while the fix session uses the worktree.
    await ensure('cr', 'AR-2');
    const other = h.runner.lastStarted();
    h.runner.setState(other.sessionId, 'working');
    const config = await h.domain.projects.config('AR');
    const member = config.team.members.find((m) => m.handle === 'cr') as AiMemberConfig;
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(() =>
      h.domain.sessions.assertWorkspaceFree(config, member, { ...task, merge: undefined }),
    ).toThrow(expect.objectContaining({ code: 'workspace_busy' }));
    expect(() => h.domain.sessions.assertWorkspaceFree(config, member, task)).not.toThrow();
    await h.domain.sessions.stop('AR', fixer.sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted()).toMatchObject({ sessionId: fixer.sessionId, cwd: fixer.cwd });
    expect(h.repos.memberWorkspaces.heldBy(fixer.sessionId)).toHaveLength(0);
    expect(h.repos.memberWorkspaces.heldBy(other.sessionId)).toHaveLength(1);

    h.domain.sessions.requestReviewRound('AR', 'AR-1', 'cr');
    const current = h.domain.sessions.get('AR', fixer.sessionId);
    expect(h.domain.sessions.reviewRoundDue({ ...current, cwd: review.cwd })).toBe(true);
    expect(h.domain.sessions.reviewRoundDue(current)).toBe(false);
    const starts = h.runner.started.length;
    h.runner.setState(fixer.sessionId, 'idle');
    await flush();
    expect(h.runner.started).toHaveLength(starts);
    expect(
      h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review'),
    ).toMatchObject({ ...pin, refresh: true });
  });

  it('still reads a round pinned before PM-739 directly on the developer workspace', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const pin = () => h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1').find((b) => b.kind === 'review')!;
    // The old shape: the pin names the developer's workspace and branch directly.
    h.repos.memberWorkspaces.saveBinding({
      ...pin(),
      sourcePath: dev1,
      sourceRef: 'refs/heads/AR-1-login-page',
    });
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({
      sourceCommit: handedOver,
      sourceBranch: 'AR-1-login-page',
      roundId: '1',
    });
    expect(pin()).toMatchObject({ sourcePath: dev1, sourceRef: 'refs/heads/AR-1-login-page' });
  });

  it('preserves a lost engine link while handing a merge source over', async () => {
    const lost = Object.assign(new Error('the link dropped'), { linkCode: 'link_down' });
    let disconnected = false;
    await setup({
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        publishTaskBranch: (...args) =>
          disconnected ? Promise.reject(lost) : inner.publishTaskBranch(...args),
      }),
    });
    await startTask('AR-1', 'dev-1');
    const config = await h.domain.projects.config('AR');
    const task = h.domain.tasks.get('AR', 'AR-1');
    disconnected = true;
    await expect(h.domain.sessions.prepareMergeSource(config, task, initial)).rejects.toBe(lost);
    disconnected = false;
    await h.domain.sessions.prepareMergeSource(config, task, initial);
  });

  it('keeps a reservation over a restart until the old processes are proven gone', async () => {
    const liveProcesses = new Set<number>();
    await setup({ liveProcesses });
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    // Its processes outlive the server (a background job the session left running).
    liveProcesses.add(1001);
    h = await restartDomainHarness(h, { memberWorkspaces: true, liveProcesses });
    expect(h.domain.sessions.get('AR', first.sessionId).state).toBe('exited');
    await expect(ensure('dev-1', 'AR-2')).rejects.toMatchObject({ code: 'workspace_busy' });
    liveProcesses.delete(1001);
    await ensure('dev-1', 'AR-2');
    expect(await branchOf(await workspaceOf('dev-1'))).toBe('AR-2-signup-page');
  });

  const scopeCleanup = (scopeId: string, outcome: 'clean' | 'failed' | 'unverified') => ({
    scopeId,
    kind: 'process_group' as const,
    outcome,
    reason: 'stop' as const,
    killed: true,
    survivors: outcome === 'failed' ? 1 : 0,
    durationMs: 7000,
  });
  function scopeStarts() {
    const original = h.runner.start.bind(h.runner);
    vi.spyOn(h.runner, 'start').mockImplementation(async (spec) => {
      const info = await original(spec);
      info.scopeId = 'scp_0123456789abcdef';
      return info;
    });
  }
  it('waits for exit cleanup and releases a clean scope even when the pid probe is alive', async () => {
    const liveProcesses = new Set([1001]);
    await setup({ liveProcesses });
    scopeStarts();
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    h.runner.setState(sessionId, 'exited');
    expect(h.domain.sessions.get('AR', sessionId).state).toBe('starting');
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(1);
    h.runner.emit({
      type: 'exit',
      sessionId,
      exitCode: 0,
      signal: null,
      cleanup: scopeCleanup('scp_0123456789abcdef', 'clean'),
    });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(0);
    await ensure('dev-1', 'AR-2');
  });
  it('persists failed cleanup across restart and blocks resume until the matching scope recovers', async () => {
    await setup();
    scopeStarts();
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    const scopeId = 'scp_0123456789abcdef';
    h.runner.emit({
      type: 'exit',
      sessionId,
      exitCode: 0,
      signal: null,
      cleanup: scopeCleanup(scopeId, 'failed'),
    });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)[0]?.holder).toMatchObject({
      scopeId,
      cleanupFailed: true,
    });
    await expect(ensure('dev-1', 'AR-1')).rejects.toMatchObject({ code: 'workspace_busy' });
    h = await restartDomainHarness(h, { memberWorkspaces: true });
    await expect(ensure('dev-1', 'AR-2')).rejects.toMatchObject({ code: 'workspace_busy' });
    h.runner.emit({
      type: 'scope_recovered',
      sessionId,
      cleanup: scopeCleanup('scp_1111111111111111', 'clean'),
    });
    h.runner.emit({ type: 'scope_recovered', sessionId, cleanup: scopeCleanup(scopeId, 'unverified') });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)[0]?.holder?.cleanupFailed).toBe(true);
    h.runner.emit({ type: 'scope_recovered', sessionId, cleanup: scopeCleanup(scopeId, 'clean') });
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(0);
    await ensure('dev-1', 'AR-2');
  });
  it('retries persisted cleanup on the owning runner at startup', async () => {
    await setup();
    scopeStarts();
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    const scopeId = 'scp_0123456789abcdef';
    h.runner.emit({
      type: 'exit',
      sessionId,
      exitCode: 0,
      signal: null,
      cleanup: scopeCleanup(scopeId, 'failed'),
    });
    h = await restartDomainHarness(h, { memberWorkspaces: true });
    const closeScopes = vi.fn(async () => [{ sessionId, cleanup: scopeCleanup(scopeId, 'clean') }]);
    Object.assign(h.runner, { closeScopes });
    await h.domain.sessions.reconcileAfterRestart();
    expect(closeScopes).toHaveBeenCalledWith([{ sessionId, scopeId, sinceAgeMs: expect.any(Number) }]);
    expect(h.repos.memberWorkspaces.heldBy(sessionId)).toHaveLength(0);
    expect(
      h.repos.operatorSignals.list('AR').find((signal) => signal.kind === 'process_cleanup_failed')
        ?.resolvedAt,
    ).not.toBeNull();
  });

  it('does not keep the workspace for a session ended by a restart that an engine report would revive (PM-792)', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const sessionId = h.runner.lastStarted().sessionId;
    // The row is closed while the process goes on, then the late report arrives.
    await h.domain.sessions.reconcileEngine(LOCAL_ENGINE_ID, new Set(), () => false);
    h.runner.setState(sessionId, 'idle');
    expect(h.repos.sessions.get(sessionId)?.state).toBe('exited');

    await h.domain.sessions.reconcileEngine(LOCAL_ENGINE_ID, new Set([sessionId]), () => false);
    expect(h.runner.stopped).toContain(sessionId);
    await ensure('dev-1', 'AR-2');
  });

  it('starts a new conversation when the workspace had to be made again', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    await commitFile(await workspaceOf('dev-1'), 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    expect(review.member).toBe('cr');
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    await h.domain.sessions.stop('AR', review.sessionId);
    await rm(path.dirname(await workspaceOf('cr')), { recursive: true, force: true });
    const again = await ensure('cr', 'AR-1');
    expect(again.resumed).toBe(false);
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      initialMessage: 'Brief for AR-1: Login page',
    });
    expect(h.runner.lastStarted().claudeSessionId).not.toBe(review.claudeSessionId);
  });

  it('keeps the workspace, its branches, dependencies and the member memory after the task is done', async () => {
    await setup();
    await h.memory.append('AR', 'dev-1', 'The build needs node 22.');
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const work = await commitFile(dev1, 'login.txt', 'done\n');
    await mkdir(path.join(dev1, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(dev1, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status: 'done' });
    await h.domain.sessions.cleanupDoneTask('AR', 'AR-1');
    expect(h.runner.isRunning(h.runner.lastStarted().sessionId)).toBe(false);
    expect(h.worktrees.removed).toEqual([]);
    expect(await git(dev1, 'rev-parse', 'AR-1-login-page')).toBe(work);
    expect(await exists(path.join(dev1, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(await h.domain.sessions.memory('AR', 'dev-1')).toContain('The build needs node 22.');

    // The next task starts in the same workspace, with its dependencies, on a fresh branch.
    await startTask('AR-2', 'dev-1');
    expect(h.runner.lastStarted().cwd).toBe(dev1);
    expect(await branchOf(dev1)).toBe('AR-2-signup-page');
    expect(await exists(path.join(dev1, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it("reviews the assignee's latest commit, not the copy of a developer who opened the task later", async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    await commitFile(dev1, 'login.txt', 'v1\n');
    // Another developer is woken on the task: it takes over dev-1's branch as it is now.
    await ensure('dev-2', 'AR-1');
    const dev2 = await workspaceOf('dev-2');
    expect(await branchOf(dev2)).toBe('AR-1-login-page');
    // dev-1, the assignee, goes on; dev-2's copy is now behind (and its binding the newest).
    const latest = await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(3);
    const review = h.runner.lastStarted();
    expect(review.member).toBe('cr');
    expect(review.policy?.placement).toMatchObject({ sourceCommit: latest });
    expect(await git(await workspaceOf('cr'), 'rev-parse', 'HEAD')).toBe(latest);
  });

  it('holds a re-review request for a reviewer in a turn, then restarts it on the new commit with it', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    h.runner.setState(review.sessionId, 'working');
    const fixed = await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['cr'], text: 'Fixed, please look again.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    await flush();
    // Not typed into the turn of the old round, and the turn is not cut short.
    expect(h.runner.messages.filter((m) => m.text.includes('Fixed, please look again.'))).toEqual([]);
    expect(h.runner.stopped).not.toContain(review.sessionId);
    h.runner.setState(review.sessionId, 'idle');
    await startedCount(3);
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: review.sessionId,
      resume: true,
      initialMessage: expect.stringContaining('Fixed, please look again.'),
    });
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
  });

  it('finds the task branch elsewhere when the workspace was made again, and reports it missing otherwise', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    const work = await commitFile(dev1, 'login.txt', 'v1\n');
    // The branch also reached the project repository (as a published branch would).
    await git(h.workspace, 'fetch', '--quiet', dev1, 'AR-1-login-page:AR-1-login-page');
    h.runner.emit({ type: 'transcript_path', sessionId: first.sessionId, path: '/tmp/fictional-dev.jsonl' });
    await h.domain.sessions.stop('AR', first.sessionId);
    await rm(path.dirname(dev1), { recursive: true, force: true });
    await ensure('dev-1', 'AR-1');
    expect(h.runner.lastStarted()).toMatchObject({ cwd: dev1, resume: false });
    expect(await git(dev1, 'rev-parse', 'HEAD')).toBe(work);

    // Gone everywhere: not started over from the default branch.
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    await rm(path.dirname(dev1), { recursive: true, force: true });
    await git(h.workspace, 'branch', '--quiet', '-D', 'AR-1-login-page');
    await expect(ensure('dev-1', 'AR-1')).rejects.toMatchObject({ code: 'workspace_branch_missing' });
  });
});
