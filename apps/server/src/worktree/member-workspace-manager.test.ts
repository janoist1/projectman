import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { getTemplate } from '@projectman/templates';
import type { MemberWorkspaceKey, MemberWorkspaceManager } from '../contracts';
import { createMemberWorkspaceManager, MemberWorkspaceError } from './index';

/*
 * Every test builds its own repositories in a temp directory: a bare "remote", the project
 * repository cloned from it, and the member workspaces under their own root. The user's git
 * configuration is replaced by a test one.
 */

const exec = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  const { stdout } = await exec('git', args, { env });
  return stdout.trim();
}

async function commitFile(repo: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(repo, file), content);
  await git('-C', repo, 'add', file);
  await git('-C', repo, 'commit', '--quiet', '-m', message);
  return git('-C', repo, 'rev-parse', 'HEAD');
}

function silentLogger(): FastifyBaseLogger {
  const noop = () => undefined;
  const logger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
  };
  return { ...logger, silent: noop, child: () => logger } as unknown as FastifyBaseLogger;
}

async function refusal(promise: Promise<unknown>): Promise<MemberWorkspaceError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MemberWorkspaceError);
  return err as MemberWorkspaceError;
}

let configDir: string;
let base: string;
let remote: string;
let projectRepo: string;
let project: ProjectConfig;
let manager: MemberWorkspaceManager;

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'pm-gitconfig-'));
  const configFile = path.join(configDir, 'gitconfig');
  await writeFile(
    configFile,
    '[user]\n\tname = projectman test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n',
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', configFile);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-workspace-')));
  remote = path.join(base, 'remote.git');
  const workspace = path.join(base, 'workspace');
  projectRepo = path.join(workspace, 'app');
  await git('init', '--quiet', '--bare', '-b', 'main', remote);
  await mkdir(workspace);
  await git('clone', '--quiet', remote, projectRepo);
  await commitFile(projectRepo, 'README.md', 'hello\n', 'Initial commit');
  await git('-C', projectRepo, 'push', '--quiet', 'origin', 'main');
  const template = getTemplate('small-team')!;
  project = template.build({
    key: 'AR',
    name: 'Acme',
    workspacePath: workspace,
    language: 'en',
    owner: { handle: 'owner', displayName: 'Anna Example', email: 'anna@example.com' },
  });
  project.project.repos = [{ name: 'app', path: 'app', defaultBranch: 'main' }];
  manager = createMemberWorkspaceManager({ rootDir: path.join(base, 'workspaces'), logger: silentLogger() });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const key = (member: string): MemberWorkspaceKey => ({ project, repoName: 'app', member });

/** Pushes a commit to the remote from another clone, as a teammate would. */
async function pushFromElsewhere(file: string): Promise<string> {
  const other = path.join(base, `other-${file}`);
  await git('clone', '--quiet', remote, other);
  const commit = await commitFile(other, file, `${file}\n`, `Add ${file}`);
  await git('-C', other, 'push', '--quiet', 'origin', 'main');
  return commit;
}

/** A fresh task branch from the default branch, as a new task gets it. */
async function startTask(member: string, branch: string): Promise<string> {
  const { commit } = await manager.fetchBase(key(member));
  await manager.checkoutTaskBranch(key(member), { mode: 'create', branch, startPoint: commit });
  return commit;
}

// Real git in temp repositories: slower than the default timeout when the whole suite runs.
describe('member workspaces', { timeout: 30_000 }, () => {
  it('are independent clones with their own git directory, cache and temp, under project/member/repo', async () => {
    const ws = await manager.ensure(key('dev'));
    expect(ws.created).toBe(true);
    expect(ws.path).toBe(path.join(base, 'workspaces', 'AR', 'dev', 'app', 'repo'));
    expect((await stat(ws.gitDir)).isDirectory()).toBe(true);
    expect((await stat(ws.cacheDir)).isDirectory()).toBe(true);
    expect((await stat(ws.tempDir)).isDirectory()).toBe(true);
    await expect(stat(path.join(ws.gitDir, 'objects', 'info', 'alternates'))).rejects.toThrow();
    expect(await git('-C', ws.path, 'remote')).toBe('');
    // Objects were copied, never hardlinked to the project repository's.
    const packs = await readdir(path.join(ws.gitDir, 'objects', 'pack'));
    for (const file of packs)
      expect((await stat(path.join(ws.gitDir, 'objects', 'pack', file))).nlink).toBe(1);

    // A commit in the workspace stays there.
    const local = await commitFile(ws.path, 'mine.txt', 'x\n', 'Local work');
    await expect(git('-C', projectRepo, 'cat-file', '-e', `${local}^{commit}`)).rejects.toThrow();

    const again = await manager.ensure(key('dev'));
    expect(again.created).toBe(false);
    expect(await git('-C', again.path, 'rev-parse', 'HEAD')).toBe(local);
    // Another member gets another clone.
    const other = await manager.ensure(key('qa'));
    expect(other.path).not.toBe(ws.path);
  });

  it('starts a new task branch from the freshly fetched default branch', async () => {
    await manager.ensure(key('dev'));
    const upstream = await pushFromElsewhere('news.txt');
    const startedFrom = await startTask('dev', 'AR-1-first');
    expect(startedFrom).toBe(upstream);
    const status = await manager.status(key('dev'));
    expect(status.checkout).toEqual({ branch: 'AR-1-first', head: upstream });
    expect(status.dirty).toBe(false);
  });

  it('refuses a new task when the default branch cannot be fetched, rather than start from a stale base', async () => {
    await manager.ensure(key('dev'));
    await git('-C', projectRepo, 'remote', 'set-url', 'origin', path.join(base, 'missing.git'));
    const err = await refusal(manager.fetchBase(key('dev')));
    expect(err.code).toBe('workspace_fetch_failed');
  });

  it('refuses to switch away from uncommitted work or an untracked file, and never resets it', async () => {
    const ws = await manager.ensure(key('dev'));
    const baseCommit = await startTask('dev', 'AR-1-first');
    await writeFile(path.join(ws.path, 'README.md'), 'changed\n');
    const dirty = await refusal(
      manager.checkoutTaskBranch(key('dev'), {
        mode: 'create',
        branch: 'AR-2-second',
        startPoint: baseCommit,
      }),
    );
    expect(dirty.code).toBe('workspace_dirty');
    expect((await manager.status(key('dev'))).checkout?.branch).toBe('AR-1-first');
    expect(await git('-C', ws.path, 'diff', '--name-only')).toBe('README.md');

    await git('-C', ws.path, 'checkout', '--', 'README.md');
    await writeFile(path.join(ws.path, 'notes.txt'), 'untracked\n');
    expect(
      (
        await refusal(
          manager.checkoutTaskBranch(key('dev'), {
            mode: 'create',
            branch: 'AR-2-second',
            startPoint: baseCommit,
          }),
        )
      ).code,
    ).toBe('workspace_dirty');
    expect(await git('-C', ws.path, 'status', '--porcelain')).toBe('?? notes.txt');
  });

  it('refuses to switch during an unfinished git operation', async () => {
    const ws = await manager.ensure(key('dev'));
    const baseCommit = await startTask('dev', 'AR-1-first');
    await writeFile(path.join(ws.gitDir, 'index.lock'), '');
    const err = await refusal(
      manager.checkoutTaskBranch(key('dev'), {
        mode: 'create',
        branch: 'AR-2-second',
        startPoint: baseCommit,
      }),
    );
    expect(err.code).toBe('workspace_dirty');
    expect(err.details.operation).toBe('index-lock');
    await rm(path.join(ws.gitDir, 'index.lock'));
    await writeFile(path.join(ws.gitDir, 'MERGE_HEAD'), `${baseCommit}\n`);
    expect(
      (await refusal(manager.checkoutTaskBranch(key('dev'), { mode: 'continue', branch: 'AR-1-first' })))
        .details.operation,
    ).toBe('merge');
  });

  it('keeps every task branch and its commits; continuing a task returns to its branch without a reset', async () => {
    const ws = await manager.ensure(key('dev'));
    await startTask('dev', 'AR-1-first');
    const first = await commitFile(ws.path, 'one.txt', '1\n', 'Work on AR-1');
    await pushFromElsewhere('later.txt');
    await startTask('dev', 'AR-2-second');
    const second = await commitFile(ws.path, 'two.txt', '2\n', 'Work on AR-2');

    const back = await manager.checkoutTaskBranch(key('dev'), { mode: 'continue', branch: 'AR-1-first' });
    expect(back).toEqual({ branch: 'AR-1-first', head: first });
    // Not rebased on the newer default branch, and the other task's commit is kept.
    await expect(stat(path.join(ws.path, 'later.txt'))).rejects.toThrow();
    expect(await git('-C', ws.path, 'rev-parse', 'AR-2-second')).toBe(second);
    // `create` of an existing branch never moves it.
    const kept = await manager.checkoutTaskBranch(key('dev'), {
      mode: 'create',
      branch: 'AR-2-second',
      startPoint: first,
    });
    expect(kept.head).toBe(second);
  });

  it('reports a missing task branch instead of creating one', async () => {
    await manager.ensure(key('dev'));
    const err = await refusal(
      manager.checkoutTaskBranch(key('dev'), { mode: 'continue', branch: 'AR-9-gone' }),
    );
    expect(err.code).toBe('workspace_branch_missing');
  });

  it("continues a task branch found in the project repository or in a teammate's workspace", async () => {
    await git('-C', projectRepo, 'switch', '--quiet', '-c', 'AR-3-legacy');
    const legacy = await commitFile(projectRepo, 'legacy.txt', 'l\n', 'Legacy worktree work');
    await git('-C', projectRepo, 'switch', '--quiet', 'main');

    await manager.ensure(key('dev'));
    const found = await manager.findTaskBranch(key('dev'), 'AR-3');
    expect(found).toEqual({
      branch: 'AR-3-legacy',
      source: { path: projectRepo, ref: 'refs/heads/AR-3-legacy' },
    });
    const checkout = await manager.checkoutTaskBranch(key('dev'), {
      mode: 'fetch',
      branch: found!.branch,
      source: found!.source!,
    });
    expect(checkout).toEqual({ branch: 'AR-3-legacy', head: legacy });
    expect(await manager.findTaskBranch(key('dev'), 'AR-3')).toEqual({ branch: 'AR-3-legacy', source: null });

    // Another developer takes the task over from dev's workspace: committed work only.
    const devWs = await manager.location(key('dev'));
    const more = await commitFile(devWs.path, 'more.txt', 'm\n', 'More work');
    await writeFile(path.join(devWs.path, 'uncommitted.txt'), 'u\n');
    await manager.ensure(key('dev2'));
    const taken = await manager.checkoutTaskBranch(key('dev2'), {
      mode: 'fetch',
      branch: 'AR-3-legacy',
      source: { path: devWs.path, ref: 'refs/heads/AR-3-legacy' },
    });
    expect(taken.head).toBe(more);
    await expect(
      stat(path.join((await manager.location(key('dev2'))).path, 'uncommitted.txt')),
    ).rejects.toThrow();
  });

  it("checks out the pinned commit for a review, not the developer's later or uncommitted work", async () => {
    const devWs = await manager.ensure(key('dev'));
    await startTask('dev', 'AR-4-change');
    const handedOver = await commitFile(devWs.path, 'feature.txt', 'v1\n', 'Feature');
    const source = { path: devWs.path, ref: 'refs/heads/AR-4-change' };
    expect(await manager.resolveSource(source)).toBe(handedOver);
    await commitFile(devWs.path, 'feature.txt', 'v2\n', 'Later work');
    await writeFile(path.join(devWs.path, 'draft.txt'), 'draft\n');

    const qaWs = await manager.ensure(key('qa'));
    const review = await manager.checkoutReview(key('qa'), source, handedOver);
    expect(review).toEqual({ branch: null, head: handedOver });
    expect(await git('-C', qaWs.path, 'show', 'HEAD:feature.txt')).toBe('v1');
    await expect(stat(path.join(qaWs.path, 'draft.txt'))).rejects.toThrow();

    // The same round again keeps what the reviewer did in the checkout.
    await writeFile(path.join(qaWs.path, 'test-output.txt'), 'local\n');
    expect(await manager.checkoutReview(key('qa'), source, handedOver)).toEqual(review);

    // A rewritten branch no longer holds the pinned commit: another reviewer cannot take it.
    await git('-C', devWs.path, 'reset', '--quiet', '--hard', 'HEAD~2');
    await commitFile(devWs.path, 'other.txt', 'o\n', 'Rewritten');
    await manager.ensure(key('security'));
    expect((await refusal(manager.checkoutReview(key('security'), source, handedOver))).code).toBe(
      'workspace_source_missing',
    );
  });

  it('refuses a directory that is not an independent clone', async () => {
    const ws = await manager.location(key('dev'));
    await mkdir(path.dirname(ws.path), { recursive: true });
    await git('-C', projectRepo, 'worktree', 'add', '--quiet', '-b', 'linked', ws.path);
    expect((await refusal(manager.ensure(key('dev')))).code).toBe('workspace_invalid');
  });
});
