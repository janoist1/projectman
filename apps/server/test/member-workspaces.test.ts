import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '@projectman/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/domain';
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
    h.domain.sessions.ensureSession('AR', handle, { type: 'task', taskKey }, { message });
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
    await writeFile(path.join(dev1, 'draft.txt'), 'not committed\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
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
    expect(resumed).toMatchObject({ resumed: true, messageSent: true });
    expect(h.runner.lastStarted()).toMatchObject({ cwd: dev1, resume: true });
    expect(await readFile(path.join(dev1, 'wip.txt'), 'utf8')).toBe('half done\n');
  });

  it('does not start a new task from a stale base when the default branch cannot be fetched', async () => {
    await setup();
    await git(h.workspace, 'remote', 'add', 'origin', path.join(h.dir, 'missing.git'));
    await expect(startTask('AR-1', 'dev-1')).rejects.toMatchObject({ code: 'workspace_fetch_failed' });
    expect(h.runner.started).toHaveLength(0);
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

    // Continuing the round (a restart, a person's resume) keeps its commit.
    await commitFile(dev1, 'login.txt', 'v3\n');
    await h.domain.sessions.stop('AR', review.sessionId);
    await ensure('cr', 'AR-1');
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
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
});
