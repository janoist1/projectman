import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '@projectman/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { createGitSeed } from './helpers/git-seed';

/*
 * PM-740: every session preparation starts from a fresh default branch (one fetch each), and a
 * reviewer's action message refreshes it before it reaches the developer's running session. Real
 * git repositories and the fake runner; the project's repository is the harness workspace.
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
let seed: ReturnType<typeof createGitSeed>;
beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'pm-gitconfig-'));
  const file = path.join(configDir, 'gitconfig');
  await writeFile(
    file,
    '[user]\n\tname = projectman test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n',
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', file);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  seed = createGitSeed(path.join(configDir, 'seed'), {
    '.gitignore': 'node_modules/\n',
    'README.md': 'hello\n',
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

const twoTasks = (c: ProjectConfig) => {
  const dev = c.team.members.find((m) => m.handle === 'dev-1');
  if (dev?.kind === 'ai') dev.capacity = 2;
};

describe('a fresh base at every session start (PM-740)', { timeout: 60_000 }, () => {
  let h: DomainHarness;
  let initial: string;
  /** The members `fetchBase` ran for, in order. */
  let fetched: string[];

  async function setup() {
    fetched = [];
    h = await createDomainHarness({
      memberWorkspaces: true,
      persistent: true,
      adjust: twoTasks,
      wrapMemberWorkspaces: (inner) => ({
        ...inner,
        fetchBase: (key) => {
          fetched.push(key.member);
          return inner.fetchBase(key);
        },
      }),
    });
    seed.copyTo(h.workspace);
    initial = seed.commit;
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
  const startedCount = (n: number) =>
    vi.waitFor(() => expect(h.runner.started).toHaveLength(n), { timeout: 20_000, interval: 50 });
  const tracking = (dir: string) => git(dir, 'rev-parse', 'refs/remotes/upstream/main');
  const fetchesFor = (member: string) => fetched.filter((m) => m === member).length;
  /** The default branch of the project moves on (what an origin advancing does for the repository). */
  const advanceMain = (file: string) => commitFile(h.workspace, file, `${file}\n`);
  /** A started developer session with a task commit and an uncommitted file, then stopped. */
  async function stoppedDeveloper() {
    await startTask('AR-1', 'dev-1');
    const first = h.runner.lastStarted();
    const dev1 = await workspaceOf('dev-1');
    const work = await commitFile(dev1, 'login.txt', 'login\n');
    await writeFile(path.join(dev1, 'wip.txt'), 'half done\n');
    h.runner.emit({ type: 'transcript_path', sessionId: first.sessionId, path: '/tmp/fictional-dev.jsonl' });
    await h.domain.sessions.stop('AR', first.sessionId);
    return { dev1, work, first };
  }

  it('fetches once for a new task and once for a resume, and keeps the work and the pin of the resumed branch', async () => {
    await setup();
    const { dev1, work } = await stoppedDeveloper();
    expect(fetchesFor('dev-1')).toBe(1);
    expect(await tracking(dev1)).toBe(initial);

    const advanced = await advanceMain('news.txt');
    await ensure('dev-1', 'AR-1', 'Any news?');
    expect(fetchesFor('dev-1')).toBe(2);
    // The tracking ref and the unused own default branch follow; the task is untouched, byte for byte.
    expect(await tracking(dev1)).toBe(advanced);
    expect(await git(dev1, 'rev-parse', 'main')).toBe(advanced);
    expect(await git(dev1, 'rev-parse', 'HEAD')).toBe(work);
    expect(await git(dev1, 'branch', '--show-current')).toBe('AR-1-login-page');
    expect(await readFile(path.join(dev1, 'wip.txt'), 'utf8')).toBe('half done\n');
    expect(await git(dev1, 'status', '--porcelain')).toBe('?? wip.txt');
    // The binding keeps the base the branch started from.
    expect(h.runner.lastStarted()).toMatchObject({ resume: true });
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({
      kind: 'task_worktree',
      workspace: { branch: 'AR-1-login-page', baseCommit: initial },
    });

    // A new task of the same workspace starts from the base fetched for it.
    await git(dev1, 'add', 'wip.txt');
    await git(dev1, 'commit', '--quiet', '-m', 'Keep wip');
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    const later = await advanceMain('later.txt');
    await startTask('AR-2', 'dev-1');
    expect(fetchesFor('dev-1')).toBe(3);
    expect(await git(dev1, 'rev-parse', 'HEAD')).toBe(later);
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ workspace: { baseCommit: later } });
  });

  it('never rewrites a diverged own default branch, but refreshes the tracking ref', async () => {
    await setup();
    const { dev1 } = await stoppedDeveloper();
    const own = await git(dev1, 'commit-tree', '-p', initial, '-m', 'Own main commit', `${initial}^{tree}`);
    await git(dev1, 'update-ref', 'refs/heads/main', own);
    const advanced = await advanceMain('news.txt');
    await ensure('dev-1', 'AR-1');
    expect(await tracking(dev1)).toBe(advanced);
    expect(await git(dev1, 'rev-parse', 'main')).toBe(own);
  });

  it('leaves a checked-out default branch alone while the fetch runs, and still refreshes the tracking ref', async () => {
    await setup();
    const { dev1, work } = await stoppedDeveloper();
    await git(dev1, 'add', 'wip.txt');
    await git(dev1, 'commit', '--quiet', '-m', 'Keep wip');
    await git(dev1, 'switch', '--quiet', 'main');
    const advanced = await advanceMain('news.txt');
    await ensure('dev-1', 'AR-1');
    expect(await tracking(dev1)).toBe(advanced);
    // The own default branch was checked out at the fetch: not moved, its files not touched.
    expect(await git(dev1, 'rev-parse', 'main')).toBe(initial);
    expect(await git(dev1, 'branch', '--show-current')).toBe('AR-1-login-page');
    expect(await git(dev1, 'rev-parse', 'HEAD~1')).toBe(work);
  });

  it('does not start from a stale base when the fetch fails, and frees the workspace', async () => {
    await setup();
    const { dev1, work } = await stoppedDeveloper();
    await git(h.workspace, 'remote', 'add', 'origin', path.join(h.dir, 'missing.git'));
    const startedBefore = h.runner.started.length;
    await expect(ensure('dev-1', 'AR-1')).rejects.toMatchObject({ code: 'workspace_fetch_failed' });
    expect(h.runner.started).toHaveLength(startedBefore);
    expect(await git(dev1, 'rev-parse', 'HEAD')).toBe(work);
    expect(await readFile(path.join(dev1, 'wip.txt'), 'utf8')).toBe('half done\n');

    // The reservation is gone: the next start works once the repository can be fetched again.
    await git(h.workspace, 'remote', 'remove', 'origin');
    await ensure('dev-1', 'AR-1');
    expect(h.runner.started).toHaveLength(startedBefore + 1);
  });

  it('fetches once per start when two starts race for the workspace', async () => {
    await setup();
    const results = await Promise.allSettled([ensure('dev-1', 'AR-1'), ensure('dev-1', 'AR-2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'workspace_busy' },
    });
    expect(fetchesFor('dev-1')).toBe(1);
  });

  it('keeps the pinned round of a review and fetches for it; a new round pins the new base', async () => {
    await setup();
    await startTask('AR-1', 'dev-1');
    const dev1 = await workspaceOf('dev-1');
    const handedOver = await commitFile(dev1, 'login.txt', 'v1\n');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await startedCount(2);
    const review = h.runner.lastStarted();
    const cr = await workspaceOf('cr');
    expect(fetchesFor('cr')).toBe(1);
    h.runner.emit({
      type: 'transcript_path',
      sessionId: review.sessionId,
      path: '/tmp/fictional-review.jsonl',
    });
    await h.domain.sessions.stop('AR', review.sessionId);

    const advanced = await advanceMain('news.txt');
    await commitFile(dev1, 'login.txt', 'v2\n');
    await ensure('cr', 'AR-1');
    expect(fetchesFor('cr')).toBe(2);
    expect(await tracking(cr)).toBe(advanced);
    // The same round: the commit and the base it was pinned to.
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({
      sourceCommit: handedOver,
      baseCommit: initial,
      roundId: '1',
    });

    // A new round pins the commit now and the base fetched for it.
    await h.domain.sessions.stop('AR', h.runner.lastStarted().sessionId);
    h.domain.sessions.requestReviewRound('AR', 'AR-1', 'cr');
    await ensure('cr', 'AR-1');
    expect(fetchesFor('cr')).toBe(3);
    expect(h.runner.lastStarted().policy?.placement).toMatchObject({ baseCommit: advanced, roundId: '2' });
  });

  describe("a reviewer's message to the developer's running session", () => {
    async function runningDeveloper() {
      await startTask('AR-1', 'dev-1');
      const session = h.runner.lastStarted();
      h.runner.setState(session.sessionId, 'idle');
      const dev1 = await workspaceOf('dev-1');
      await writeFile(path.join(dev1, 'wip.txt'), 'half done\n');
      return { session, dev1 };
    }
    const send = (from: string, text: string) =>
      h.domain.messaging.send(
        'AR',
        from,
        { to: ['dev-1'], text, taskKey: 'AR-1' },
        { actor: from === 'owner' ? OWNER_ACTOR : aiActor(from) },
      );

    it('refreshes the base before the message is typed, without touching the work or the session', async () => {
      await setup();
      const { session, dev1 } = await runningDeveloper();
      const head = await git(dev1, 'rev-parse', 'HEAD');
      const advanced = await advanceMain('news.txt');
      expect(fetchesFor('dev-1')).toBe(1);
      await send('cr', 'Please merge main into your branch.');
      await vi.waitFor(() =>
        expect(h.runner.messages.some((m) => m.text.includes('merge main into your branch'))).toBe(true),
      );
      expect(fetchesFor('dev-1')).toBe(2);
      expect(await tracking(dev1)).toBe(advanced);
      expect(await git(dev1, 'rev-parse', 'HEAD')).toBe(head);
      expect(await git(dev1, 'branch', '--show-current')).toBe('AR-1-login-page');
      expect(await readFile(path.join(dev1, 'wip.txt'), 'utf8')).toBe('half done\n');
      expect(h.runner.started).toHaveLength(1);
      expect(h.runner.stopped).not.toContain(session.sessionId);
    });

    it('does not fetch for a message of someone who does not review', async () => {
      await setup();
      await runningDeveloper();
      await send('dev-2', 'FYI: the build is slow today.');
      await vi.waitFor(() =>
        expect(h.runner.messages.some((m) => m.text.includes('the build is slow'))).toBe(true),
      );
      expect(fetchesFor('dev-1')).toBe(1);
    });

    it('keeps the message waiting when the fetch fails', async () => {
      await setup();
      const { dev1 } = await runningDeveloper();
      await git(h.workspace, 'remote', 'add', 'origin', path.join(h.dir, 'missing.git'));
      await send('cr', 'Please merge main into your branch.');
      await flush();
      await vi.waitFor(() => expect(fetchesFor('dev-1')).toBe(2));
      await flush();
      expect(h.runner.messages.some((m) => m.text.includes('merge main into your branch'))).toBe(false);
      expect(await readFile(path.join(dev1, 'wip.txt'), 'utf8')).toBe('half done\n');
    });
  });
});
