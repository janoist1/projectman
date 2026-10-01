import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, pullRequest } from './helpers/fakes';

/*
 * PM-183: a task handed over for review is reviewed at the commit that was handed over. Entering a
 * review stage with uncommitted work is refused, the commit is pinned on the card, and a branch that
 * moves in review sends the task back. Member workspaces run on real git (the project's repository
 * is the harness workspace itself); the old worktree mode runs on the fake worktree manager.
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

describe('review at a pinned commit, in member workspaces', { timeout: 60_000 }, () => {
  let h: DomainHarness;
  let dev1: string;

  async function setup() {
    h = await createDomainHarness({ memberWorkspaces: true, persistent: true });
    await git(h.workspace, 'init', '--quiet', '-b', 'main');
    await writeFile(path.join(h.workspace, '.gitignore'), 'node_modules/\n');
    await git(h.workspace, 'add', '.gitignore');
    await commitFile(h.workspace, 'README.md', 'hello\n');
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    dev1 = path.join(await realpath(h.workspacesDir), 'AR', 'dev-1', 'web', 'repo');
  }
  afterEach(async () => {
    await h.cleanup();
  });

  const toReview = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
  const startedCount = (n: number) =>
    vi.waitFor(() => expect(h.runner.started).toHaveLength(n), { timeout: 20_000, interval: 50 });
  const reviewerSession = () => h.runner.started.find((s) => s.member === 'cr')!;
  const stageChanges = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'task_stage_changed');

  it('refuses the hand-over while the working directory has uncommitted work, whoever moves the task', async () => {
    await setup();
    await commitFile(dev1, 'login.txt', 'v1\n');
    await writeFile(path.join(dev1, 'draft.txt'), 'not committed\n');
    await writeFile(path.join(dev1, 'login.txt'), 'v2 not committed\n');

    await expect(toReview()).rejects.toMatchObject({
      code: 'handover_uncommitted',
      details: expect.objectContaining({ branch: 'AR-1-login-page', changes: 2, path: dev1 }),
      message: expect.stringContaining('2 uncommitted changes'),
    });
    await expect(
      h.domain.tasks.update('AR', 'AR-1', { stageId: 'code_review' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'handover_uncommitted' });
    await expect(h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'handover_uncommitted',
    });
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(task.stageId).toBe('development');
    expect(task.reviewPin).toBeUndefined();
    expect(h.runner.started.filter((s) => s.member === 'cr')).toHaveLength(0);

    // Committed, the hand-over goes through.
    await git(dev1, 'add', '-A');
    await git(dev1, 'commit', '--quiet', '-m', 'Keep the draft');
    await toReview();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
  });

  it("pins the handed-over commit on the card, in the timeline and in the reviewer's prompt", async () => {
    await setup();
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await toReview();
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(task.reviewPin).toEqual({
      commit: handedOver,
      branch: 'AR-1-login-page',
      pinnedAt: expect.any(String),
    });
    expect(stageChanges().at(-1)?.data).toMatchObject({
      from: 'development',
      to: 'code_review',
      reviewPin: { commit: handedOver, branch: 'AR-1-login-page' },
    });
    // The reviewer's context pack is built from the card with its pin.
    await startedCount(2);
    expect(h.contextBuilder.inputs.at(-1)?.task?.reviewPin).toMatchObject({ commit: handedOver });
    expect(reviewerSession().policy?.placement).toMatchObject({
      kind: 'review_copy',
      sourceCommit: handedOver,
    });
    expect(h.domain.tasks.detail('AR', 'AR-1').task.reviewPin?.commit).toBe(handedOver);
    expect(h.domain.tasks.list('AR').find((t) => t.key === 'AR-1')?.reviewPin?.commit).toBe(handedOver);
  });

  it('stops the reviewer and sends the task back with a note when the branch moves in review', async () => {
    await setup();
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await toReview();
    await startedCount(2);
    const review = reviewerSession();
    h.runner.setState(review.sessionId, 'idle');
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['code-review-ok'] }, aiActor('cr'));

    // Nothing moved: nothing happens.
    await h.domain.reviewWatch.check();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');

    const moved = await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.reviewWatch.check();

    expect(h.runner.stopped).toContain(review.sessionId);
    expect(h.domain.sessions.get('AR', review.sessionId).state).toBe('exited');
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(task.stageId).toBe('development');
    expect(task.reviewPin).toBeUndefined();
    // The review's result is void with the move back (the label's own rule).
    expect(task.labels).not.toContain('code-review-ok');
    const back = stageChanges().at(-1)!;
    expect(back).toMatchObject({
      actor: { kind: 'system' },
      data: {
        from: 'code_review',
        to: 'development',
        branchMoved: { branch: 'AR-1-login-page', pinned: handedOver, head: moved },
      },
    });
    // The developer is told why, with both commits.
    const told = h.domain.messages.list('AR', { taskKey: 'AR-1' }).at(-1);
    expect(told).toMatchObject({ from: 'system', to: ['dev-1'] });
    expect(told?.body).toContain(handedOver);
    expect(told?.body).toContain(moved);
    // The conversation of the reviewer stays.
    expect(h.domain.sessions.get('AR', review.sessionId).claudeSessionId).toBeTruthy();

    // Handed over again, the new head is pinned.
    await toReview();
    expect(h.domain.tasks.get('AR', 'AR-1').reviewPin?.commit).toBe(moved);
  });

  it('pins the new head, with no send-back, when the developer asks the reviewer for a new round (PM-138)', async () => {
    await setup();
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await toReview();
    await startedCount(2);
    h.runner.setState(reviewerSession().sessionId, 'idle');

    const fixed = await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['cr'], text: 'Fixed, please look again.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    expect(h.domain.tasks.get('AR', 'AR-1').reviewPin?.commit).toBe(fixed);
    await h.domain.reviewWatch.check();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
    expect(h.domain.timeline.list('AR', { taskKey: 'AR-1' }).some((e) => e.type === 'task_updated')).toBe(
      true,
    );
    await startedCount(3);
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ sourceCommit: fixed, roundId: '2' });
    expect(handedOver).not.toBe(fixed);

    // A message to somebody who is not the stage's reviewer is no new round: the branch moving
    // after it is still sent back.
    const later = await commitFile(dev1, 'login.txt', 'v3\n');
    await h.domain.messaging.send(
      'AR',
      'dev-1',
      { to: ['dev-2'], text: 'FYI.', taskKey: 'AR-1' },
      { actor: aiActor('dev-1') },
    );
    expect(h.domain.tasks.get('AR', 'AR-1').reviewPin?.commit).toBe(fixed);
    await h.domain.reviewWatch.check();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');
    expect(later).not.toBe(fixed);
  });

  it('checks at once when the pull request gets new commits, without waiting for the watcher', async () => {
    await setup();
    h.domain.tasks.addLink('AR', 'AR-1', { kind: 'pull_request', repo: 'acme/web', ref: '7' }, OWNER_ACTOR);
    await commitFile(dev1, 'login.txt', 'v1\n');
    await toReview();
    await flush();
    await h.domain.githubSync.handleChange(pullRequest({ headSha: 'a'.repeat(40) }));
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');

    await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.githubSync.handleChange(pullRequest({ headSha: 'b'.repeat(40) }));
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');
  });

  it('ignores the pin of a stage the task left, and a task without a pin', async () => {
    await setup();
    await commitFile(dev1, 'login.txt', 'v1\n');
    await toReview();
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    expect(h.domain.tasks.get('AR', 'AR-1').reviewPin).toBeUndefined();
    await commitFile(dev1, 'login.txt', 'v2\n');
    await h.domain.reviewWatch.check();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');
    expect(await h.domain.reviewWatch.checkTask('AR', 'AR-1')).toBe(false);
  });
});

describe('review at a pinned commit, in task worktrees (old mode)', () => {
  let h: DomainHarness;
  const head = (commit: string, dirty = false, changes = dirty ? 3 : 0) => ({
    commit,
    branch: 'task/AR-1',
    dirty,
    changes,
    path: '/fake/worktree',
  });

  async function setup() {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    const worktree = h.worktrees.existing.get('AR/AR-1/web')!;
    return worktree.path;
  }
  afterEach(async () => {
    await h.cleanup();
  });

  it('refuses a dirty hand-over, pins the head and sends the task back when it moves', async () => {
    const worktree = await setup();
    h.worktrees.heads.set(worktree, head('c1', true));
    await expect(
      h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1')),
    ).rejects.toMatchObject({
      code: 'handover_uncommitted',
      message: expect.stringContaining('3 uncommitted changes'),
    });
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');

    h.worktrees.heads.set(worktree, head('c1'));
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    expect(h.domain.tasks.get('AR', 'AR-1').reviewPin).toMatchObject({ commit: 'c1', branch: 'task/AR-1' });
    await h.domain.reviewWatch.check();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');

    h.worktrees.heads.set(worktree, head('c2', true));
    await h.domain.reviewWatch.check();
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('development');
    expect(
      h.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .filter((e) => e.type === 'task_stage_changed')
        .at(-1)?.data,
    ).toMatchObject({ branchMoved: { branch: 'task/AR-1', pinned: 'c1', head: 'c2' } });
  });

  it('puts no check and no pin on a task without a branch or repository', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Docs' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    expect(h.domain.tasks.get('AR', task.key)).toMatchObject({ stageId: 'code_review' });
    expect(h.domain.tasks.get('AR', task.key).reviewPin).toBeUndefined();
  });
});
