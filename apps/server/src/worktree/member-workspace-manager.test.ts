import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { getTemplate } from '@projectman/templates';
import type { MemberWorkspaceKey, MemberWorkspaceManager, WorkspaceDependencyInstaller } from '../contracts';
import { createMemberWorkspaceManager } from './index';
import { MemberWorkspaceError } from './member-workspace-manager';
import { localWorkspaceAccess } from './workspace-access';
import { createGitSeed } from '../../test/helpers/git-seed';

/*
 * Every test copies independent repositories into a temp directory: a bare "remote", the project
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
let seed: ReturnType<typeof createGitSeed>;
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
  seed = createGitSeed(path.join(configDir, 'seed'), { 'README.md': 'hello\n' });
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
  seed.copyTo(projectRepo, remote);
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
  // A git process of the test may still write into the tree: ENOTEMPTY then goes away on a retry.
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
  it('does not install in worker-owned clones or accept an invalid member key', async () => {
    const prepare = vi.fn<WorkspaceDependencyInstaller['prepare']>();
    manager = createMemberWorkspaceManager({
      rootDir: path.join(base, 'workspaces'),
      logger: silentLogger(),
      access: { ...localWorkspaceAccess(), ownerOf: () => 'worker' },
      dependencies: {
        prepare,
        busy: () => false,
        refreshCheckout: () => undefined,
        close: async () => undefined,
      },
    });
    await manager.ensure(key('dev'));
    expect(await manager.prepareDependencies(key('dev'))).toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
    await expect(manager.prepareDependencies(key('../owner'))).rejects.toMatchObject({
      code: 'workspace_invalid',
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('skips dependency setup when unconfigured and refuses invalid clones before calling an installer', async () => {
    const ws = await manager.ensure(key('dev'));
    expect(await manager.prepareDependencies(key('dev'))).toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
    await rm(ws.gitDir, { recursive: true });
    await expect(manager.prepareDependencies(key('dev'))).rejects.toMatchObject({
      code: 'workspace_invalid',
    });
  });

  it('releases the git lock while installing and blocks work and review checkouts, including resumes', async () => {
    let finish!: () => void;
    let busy = true;
    const dependencies = {
      prepare: vi.fn<WorkspaceDependencyInstaller['prepare']>(async (_request, options) => {
        if (options.waitMs === 0)
          throw Object.assign(new Error('still running'), {
            code: 'workspace_dependencies_pending',
            details: { startedAt: '2026-10-16T20:00:00.000Z' },
          });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        busy = false;
        return { status: 'ready' as const, key: 'a'.repeat(64), changed: true };
      }),
      busy: () => busy,
      refreshCheckout: () => undefined,
      close: async () => undefined,
    };
    manager = createMemberWorkspaceManager({
      rootDir: path.join(base, 'workspaces'),
      logger: silentLogger(),
      dependencies,
    });
    const ws = await manager.ensure(key('dev'));
    const preparing = manager.prepareDependencies(key('dev'), { waitMs: 12 });
    await vi.waitFor(() => expect(dependencies.prepare).toHaveBeenCalled());
    expect(dependencies.prepare).toHaveBeenCalledWith(
      { project: 'AR', member: 'dev', repo: 'app', repoPath: ws.path },
      { waitMs: 12 },
    );
    const { commit } = await manager.fetchBase(key('dev'));
    await expect(
      manager.checkoutTaskBranch(key('dev'), { mode: 'continue', branch: 'main' }),
    ).rejects.toMatchObject({
      code: 'workspace_dependencies_pending',
      details: { startedAt: '2026-10-16T20:00:00.000Z' },
    });
    await expect(
      manager.checkoutReview(key('dev'), { path: projectRepo, ref: 'refs/heads/main' }, commit),
    ).rejects.toMatchObject({ code: 'workspace_dependencies_pending' });
    finish();
    await preparing;
    expect(await manager.checkoutTaskBranch(key('dev'), { mode: 'continue', branch: 'main' })).toMatchObject({
      branch: 'main',
    });
  });

  it.each(['workspace_dependencies_pending', 'workspace_dependencies_failed'] as const)(
    'preserves installer %s details in a manager error',
    async (code) => {
      const details = code.endsWith('pending')
        ? { startedAt: '2026-10-16T20:00:00.000Z' }
        : { reason: 'install_failed', exitCode: 1, key: 'a'.repeat(64) };
      manager = createMemberWorkspaceManager({
        rootDir: path.join(base, 'workspaces'),
        logger: silentLogger(),
        dependencies: {
          prepare: async () => {
            throw Object.assign(new Error('fixture failure'), { code, details });
          },
          busy: () => false,
          refreshCheckout: () => undefined,
          close: async () => undefined,
        },
      });
      await manager.ensure(key('dev'));
      const err = await refusal(manager.prepareDependencies(key('dev')));
      expect(err).toMatchObject({ code, details });
    },
  );

  it('reports a clone to onEnsured after a successful ensure, new or existing, and not after a failed one (PM-743)', async () => {
    const onEnsured = vi.fn<(key: MemberWorkspaceKey, repoPath: string) => void>();
    manager = createMemberWorkspaceManager({
      rootDir: path.join(base, 'workspaces'),
      logger: silentLogger(),
      onEnsured,
    });
    const ws = await manager.ensure(key('dev'));
    expect(onEnsured).toHaveBeenCalledTimes(1);
    expect(onEnsured).toHaveBeenLastCalledWith(key('dev'), await realpath(ws.path));
    await manager.ensure(key('dev'));
    expect(onEnsured).toHaveBeenCalledTimes(2);
    await rm(ws.gitDir, { recursive: true });
    await expect(manager.ensure(key('dev'))).rejects.toMatchObject({ code: 'workspace_invalid' });
    expect(onEnsured).toHaveBeenCalledTimes(2);
  });

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

  it('reads the head of a task branch and the uncommitted work on it, not work on another branch (PM-183)', async () => {
    const ws = await manager.ensure(key('dev'));
    const baseCommit = await startTask('dev', 'AR-1-first');
    const first = await commitFile(ws.path, 'one.txt', '1\n', 'One');
    expect(await manager.sourceHead(key('dev'), 'AR-1-first')).toEqual({
      commit: first,
      branch: 'AR-1-first',
      dirty: false,
      changes: 0,
      path: ws.path,
      committedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    await writeFile(path.join(ws.path, 'one.txt'), 'changed\n');
    await writeFile(path.join(ws.path, 'notes.txt'), 'untracked\n');
    expect(await manager.sourceHead(key('dev'), 'AR-1-first')).toMatchObject({
      commit: first,
      dirty: true,
      changes: 2,
    });

    // Another branch checked out: the untracked file that came along belongs to it, and the task's
    // branch is as committed.
    await git('-C', ws.path, 'checkout', '--quiet', '--', 'one.txt');
    await git('-C', ws.path, 'checkout', '--quiet', '-b', 'AR-2-second', baseCommit);
    expect(await manager.sourceHead(key('dev'), 'AR-1-first')).toMatchObject({ commit: first, dirty: false });
    expect(await manager.sourceHead(key('dev'), 'AR-2-second')).toMatchObject({
      commit: baseCommit,
      dirty: true,
      changes: 1,
    });
    expect(await manager.sourceHead(key('dev'), 'AR-3-missing')).toBeNull();
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

describe('handing a task commit over (PM-739)', { timeout: 30_000 }, () => {
  const SNAPSHOTS = 'refs/projectman/workspaces';

  /** A developer who made one commit on a task branch that the project repository does not know. */
  async function developed(member = 'dev', branch = 'AR-4-change', file = 'feature.txt') {
    const ws = await manager.ensure(key(member));
    await startTask(member, branch);
    const commit = await commitFile(ws.path, file, `${member}\n`, `Work of ${member}`);
    return { ws, commit, branch };
  }

  const known = (repo: string, commit: string) =>
    git('-C', repo, 'cat-file', '-e', `${commit}^{commit}`).then(
      () => true,
      () => false,
    );

  it('gives both reviewers and the merger the same commit although the source never had it', async () => {
    const { commit, branch } = await developed();
    expect(await known(projectRepo, commit)).toBe(false);

    const source = await manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit);
    expect(source).toEqual({ path: projectRepo, ref: `${SNAPSHOTS}/dev/AR-4/${commit}` });
    expect(await manager.resolveSource(source)).toBe(commit);
    // Nothing else changed in the source: no branch of the task, no leftover receiving ref.
    expect(await git('-C', projectRepo, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).toBe(
      'refs/heads/main',
    );
    expect(await git('-C', projectRepo, 'for-each-ref', 'refs/projectman/incoming/')).toBe('');

    for (const reviewer of ['qa', 'security']) {
      const ws = await manager.ensure(key(reviewer));
      expect(await manager.checkoutReview(key(reviewer), source, commit)).toEqual({
        branch: null,
        head: commit,
      });
      expect(await git('-C', ws.path, 'rev-parse', 'HEAD')).toBe(commit);
    }
    // The merger reads the commit from the source repository itself.
    expect(await known(projectRepo, commit)).toBe(true);
  });

  it('is repeatable and safe in parallel, also after a restart', async () => {
    const { commit, branch } = await developed();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit)),
    );
    expect(new Set(results.map((r) => r.ref)).size).toBe(1);
    expect(await git('-C', projectRepo, 'for-each-ref', 'refs/projectman/incoming/')).toBe('');

    const restarted = createMemberWorkspaceManager({
      rootDir: path.join(base, 'workspaces'),
      logger: silentLogger(),
    });
    expect(await restarted.publishTaskBranch(key('dev'), 'AR-4', branch, commit)).toEqual(results[0]);
  });

  it('keeps an earlier round pinned when the developer commits again', async () => {
    const { ws, commit: first, branch } = await developed();
    const earlier = await manager.publishTaskBranch(key('dev'), 'AR-4', branch, first);
    const second = await commitFile(ws.path, 'feature.txt', 'v2\n', 'Later work');
    const later = await manager.publishTaskBranch(key('dev'), 'AR-4', branch, second);

    expect(later.ref).not.toBe(earlier.ref);
    expect(await manager.resolveSource(earlier)).toBe(first);
    expect(await manager.resolveSource(later)).toBe(second);
  });

  it('keeps the pinned commit when the developer rewrites the branch afterwards', async () => {
    const { ws, commit, branch } = await developed();
    const source = await manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit);
    await git('-C', ws.path, 'reset', '--quiet', '--hard', 'HEAD~1');
    await commitFile(ws.path, 'other.txt', 'o\n', 'Rewritten');
    expect(await manager.resolveSource(source)).toBe(commit);
    await manager.ensure(key('qa'));
    expect(await manager.checkoutReview(key('qa'), source, commit)).toEqual({ branch: null, head: commit });
    // A commit no longer on the branch cannot be handed over any more.
    expect(
      (await refusal(manager.publishTaskBranch(key('dev'), 'AR-4', branch, `${'a'.repeat(40)}`))).code,
    ).toBe('workspace_source_missing');
  });

  it('is not misled by an old worktree that has the same branch name', async () => {
    const { commit, branch } = await developed();
    const old = path.join(base, 'old-worktree');
    await git('-C', projectRepo, 'worktree', 'add', '--quiet', '-b', branch, old);
    const stale = await commitFile(old, 'stale.txt', 's\n', 'Stale work');

    const source = await manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit);
    expect(await manager.resolveSource(source)).toBe(commit);
    expect(await git('-C', projectRepo, 'rev-parse', `refs/heads/${branch}`)).toBe(stale);
  });

  it('keeps two developers of the same task apart and refuses to guess between them', async () => {
    const a = await developed('dev', 'AR-4-change', 'a.txt');
    const b = await developed('dev2', 'AR-4-change', 'b.txt');
    const sa = await manager.publishTaskBranch(key('dev'), 'AR-4', a.branch, a.commit);
    const sb = await manager.publishTaskBranch(key('dev2'), 'AR-4', b.branch, b.commit);
    expect(sa.ref).not.toBe(sb.ref);

    await manager.ensure(key('qa'));
    expect((await refusal(manager.findTaskBranch(key('qa'), 'AR-4'))).code).toBe('workspace_source_missing');
    const named = await manager.findTaskBranch(key('qa'), 'AR-4', b.commit);
    expect(named?.source).toEqual(sb);
  });

  it('lets a reviewer find the one handed-over commit of a task', async () => {
    const { commit, branch } = await developed();
    const source = await manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit);
    await manager.ensure(key('qa'));
    expect(await manager.findTaskBranch(key('qa'), 'AR-4')).toEqual({ branch: 'AR-4', source });
    expect(await manager.findTaskBranch(key('qa'), 'AR-5')).toBeNull();
  });

  it('refuses a commit that is not on the task branch or not in the workspace', async () => {
    const { ws, branch } = await developed();
    await git('-C', ws.path, 'checkout', '--quiet', '-b', 'AR-4-side', 'main');
    const side = await commitFile(ws.path, 'side.txt', 's\n', 'Side');
    await git('-C', ws.path, 'checkout', '--quiet', branch);

    expect((await refusal(manager.publishTaskBranch(key('dev'), 'AR-4', branch, side))).code).toBe(
      'workspace_source_missing',
    );
    expect((await refusal(manager.publishTaskBranch(key('dev'), 'AR-4', branch, 'b'.repeat(40)))).code).toBe(
      'workspace_source_missing',
    );
    expect(await git('-C', projectRepo, 'for-each-ref', 'refs/projectman/')).toBe('');
  });

  it('refuses a bad request: object id, task, branch, other project, ref injection', async () => {
    const { commit, branch } = await developed();
    const bad = (taskKey: string, br: string, c: string) =>
      refusal(manager.publishTaskBranch(key('dev'), taskKey, br, c));
    expect((await bad('AR-4', branch, commit.slice(0, 12))).code).toBe('workspace_invalid');
    expect((await bad('AR-4', branch, 'refs/heads/main')).code).toBe('workspace_invalid');
    expect((await bad('AR-4', 'main', commit)).code).toBe('workspace_invalid');
    expect((await bad('AR-5', branch, commit)).code).toBe('workspace_invalid');
    expect((await bad('OT-4', 'OT-4-change', commit)).code).toBe('workspace_invalid');
    expect((await bad('AR-4/../x', branch, commit)).code).toBe('workspace_invalid');
    expect((await bad('AR-4', 'AR-4-x..y', commit)).code).toBe('workspace_invalid');
    expect((await bad('AR-4', 'AR-4-x y', commit)).code).toBe('workspace_invalid');
    expect((await refusal(manager.publishTaskBranch(key('../dev'), 'AR-4', branch, commit))).code).toBe(
      'workspace_invalid',
    );
    expect(await git('-C', projectRepo, 'for-each-ref', 'refs/projectman/')).toBe('');
  });

  it('refuses a name that already holds another commit and leaves it as it was', async () => {
    const { commit, branch } = await developed();
    const ref = `${SNAPSHOTS}/dev/AR-4/${commit}`;
    const main = await git('-C', projectRepo, 'rev-parse', 'main');
    await git('-C', projectRepo, 'update-ref', ref, main);
    expect((await refusal(manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit))).code).toBe(
      'workspace_source_missing',
    );
    expect(await git('-C', projectRepo, 'rev-parse', ref)).toBe(main);
  });

  it('refuses a workspace that is a symbolic link', async () => {
    const { ws, commit, branch } = await developed();
    const real = path.join(base, 'real-clone');
    await rename(ws.path, real);
    await symlink(real, ws.path);
    expect((await refusal(manager.publishTaskBranch(key('dev'), 'AR-4', branch, commit))).code).toBe(
      'workspace_invalid',
    );
    expect(await git('-C', projectRepo, 'for-each-ref', 'refs/projectman/')).toBe('');
  });
});
