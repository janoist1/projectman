import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, RepoConfig } from '@projectman/shared';
import { getTemplate } from '@projectman/templates';
import { createWorktreeManager } from './index';

/*
 * Every test builds its own repositories in a temp directory: a bare "remote" and a clone
 * of it as the workspace repo. The user's git configuration is replaced by a test one.
 */

const exec = promisify(execFile);

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return env;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { env: gitEnv() });
  return stdout.trim();
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function commitFile(repo: string, file: string, content: string, message: string): Promise<string> {
  await writeFile(path.join(repo, file), content);
  await git('-C', repo, 'add', file);
  await git('-C', repo, 'commit', '--quiet', '-m', message);
  return git('-C', repo, 'rev-parse', 'HEAD');
}

function testLogger() {
  const warnings: string[] = [];
  const noop = () => undefined;
  const logger = {
    level: 'silent',
    fatal: noop,
    error: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    warn: (obj: unknown, msg?: string) => {
      warnings.push(msg ?? String(obj));
    },
    child: () => logger,
  };
  return { logger: logger as unknown as FastifyBaseLogger, warnings };
}

function buildProject(workspacePath: string, repos: RepoConfig[]): ProjectConfig {
  const template = getTemplate('small-team');
  if (!template) throw new Error('missing template');
  const config = template.build({
    key: 'AR',
    name: 'Acme',
    workspacePath,
    language: 'en',
    owner: { handle: 'owner', displayName: 'Anna Example', email: 'anna@example.com' },
  });
  config.project.repos = repos;
  return config;
}

let configDir: string;
let base: string;
let remote: string;
let workspace: string;
let clone: string;
let rootDir: string;
let project: ProjectConfig;

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'pm-gitconfig-'));
  const configFile = path.join(configDir, 'gitconfig');
  await writeFile(
    configFile,
    [
      '[user]',
      '\tname = projectman test',
      '\temail = test@example.com',
      '[commit]',
      '\tgpgsign = false',
      '[init]',
      '\tdefaultBranch = main',
      '',
    ].join('\n'),
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', configFile);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-worktree-')));
  remote = path.join(base, 'remote.git');
  workspace = path.join(base, 'workspace');
  clone = path.join(workspace, 'app');
  rootDir = path.join(base, 'worktrees');
  await git('init', '--quiet', '--bare', '-b', 'main', remote);
  await mkdir(workspace);
  await git('clone', '--quiet', remote, clone);
  await commitFile(clone, 'README.md', 'hello\n', 'Initial commit');
  await git('-C', clone, 'push', '--quiet', 'origin', 'main');
  project = buildProject(workspace, [{ name: 'app', path: 'app', defaultBranch: 'main' }]);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function task(taskKey: string, title: string, repoName = 'app') {
  return { project, repoName, taskKey, title };
}

describe('worktree manager', { timeout: 30_000 }, () => {
  it('resolves a real conflict in a separate pinned fix worktree and removes only that checkout and branch', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const work = await manager.ensureForTask(task('AR-1', 'Change greeting'));
    const approved = await commitFile(work.path, 'README.md', 'approved\n', 'Change greeting');
    const onto = await commitFile(clone, 'README.md', 'base changed\n', 'Change base greeting');
    const key = { project, repoName: 'app', taskKey: 'AR-1' };
    const fix = await manager.ensureMergeFix({ ...key, commit: approved });
    expect(fix.path).toBe(path.join(rootDir, 'AR', '_merge-fix', 'AR-1-app'));
    expect(fix.branch).toBe('merge-fix/AR-1');
    expect((await manager.head(fix.path))?.commit).toBe(approved);
    await expect(git('-C', fix.path, 'merge', onto)).rejects.toThrow();
    expect((await manager.head(fix.path))?.dirty).toBe(true);
    await writeFile(path.join(fix.path, 'README.md'), 'approved and base changed\n');
    await git('-C', fix.path, 'add', 'README.md');
    await git('-C', fix.path, 'commit', '-m', 'Resolve adjacent greeting edits');
    const head = (await manager.head(fix.path))!;
    expect(head.dirty).toBe(false);
    await git('-C', clone, 'merge-base', '--is-ancestor', approved, head.commit);
    await git('-C', clone, 'merge-base', '--is-ancestor', onto, head.commit);
    expect((await manager.ensureMergeFix({ ...key, commit: approved })).path).toBe(fix.path);
    expect((await manager.head(fix.path))?.commit).toBe(head.commit);
    expect(await manager.listMergeFixes({ project, repoName: 'app' })).toEqual([
      { taskKey: 'AR-1', path: fix.path },
    ]);
    await manager.removeMergeFix(key);
    expect(await manager.findMergeFix(key)).toBeNull();
    expect(await manager.listMergeFixes({ project, repoName: 'app' })).toEqual([]);
    expect((await manager.head(work.path))?.commit).toBe(approved);
    expect(await git('-C', clone, 'rev-parse', 'HEAD')).toBe(onto);
  });
  it('force-removes dirty fix worktrees and recreates them at the approved commit', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const key = { project, repoName: 'app', taskKey: 'AR-1' };
    const commit = await git('-C', clone, 'rev-parse', 'HEAD');
    const fix = await manager.ensureMergeFix({ ...key, commit });
    await writeFile(path.join(fix.path, 'README.md'), 'uncommitted resolution');
    await manager.removeMergeFix(key);
    expect(await exists(fix.path)).toBe(false);
    expect(await manager.listMergeFixes({ project, repoName: 'app' })).toEqual([]);
    expect((await manager.ensureMergeFix({ ...key, commit })).path).toBe(fix.path);
    expect((await manager.head(fix.path))?.commit).toBe(commit);
  });
  it.each(['detached', 'other branch'] as const)(
    'finds and removes a registered fix checkout on %s with no fix branch',
    async (checkout) => {
      const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
      const key = { project, repoName: 'app', taskKey: 'AR-1' };
      const commit = await git('-C', clone, 'rev-parse', 'HEAD');
      const fix = await manager.ensureMergeFix({ ...key, commit });
      if (checkout === 'detached') await git('-C', fix.path, 'checkout', '--detach', commit);
      else await git('-C', fix.path, 'checkout', '-b', 'another-branch', commit);
      await git('-C', clone, 'branch', '-D', fix.branch);
      expect(await manager.listMergeFixes({ project, repoName: 'app' })).toEqual([
        { taskKey: key.taskKey, path: fix.path },
      ]);
      await manager.removeMergeFix(key);
      expect(await exists(fix.path)).toBe(false);
      expect(await manager.listMergeFixes({ project, repoName: 'app' })).toEqual([]);
      await manager.ensureMergeFix({ ...key, commit });
      if (checkout === 'other branch')
        expect(await git('-C', clone, 'rev-parse', 'another-branch')).toBe(commit);
    },
  );
  it('leaves unregistered directories and refuses symlinks during fix cleanup', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const key = { project, repoName: 'app', taskKey: 'AR-1' };
    const dir = path.join(rootDir, 'AR', '_merge-fix', 'AR-1-app');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'keep.txt'), 'keep');
    expect(await manager.listMergeFixes({ project, repoName: 'app' })).toEqual([
      { taskKey: key.taskKey, path: dir },
    ]);
    await manager.removeMergeFix(key);
    expect(await readFile(path.join(dir, 'keep.txt'), 'utf8')).toBe('keep');
    await rm(dir, { recursive: true });
    await symlink(clone, dir);
    await expect(manager.removeMergeFix(key)).rejects.toMatchObject({ code: 'outside_root' });
    expect(await exists(clone)).toBe(true);
  });
  it('refuses merge-fix path redirection and non-commit start points', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const key = { project, repoName: 'app', taskKey: 'AR-1' };
    await expect(manager.ensureMergeFix({ ...key, commit: '--help' })).rejects.toMatchObject({
      code: 'no_start_point',
    });
    await mkdir(path.join(rootDir, 'AR'), { recursive: true });
    await symlink(clone, path.join(rootDir, 'AR', '_merge-fix'));
    await expect(
      manager.ensureMergeFix({ ...key, commit: await git('-C', clone, 'rev-parse', 'HEAD') }),
    ).rejects.toMatchObject({ code: 'outside_root' });
  });
  it('never refreshes an unregistered checkout or an unknown path', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger, cloneDependencies: true });
    expect(await manager.refreshDependencies(clone)).toEqual({ status: 'skipped', reason: 'not_worktree' });
    expect(await manager.refreshDependencies(path.join(base, 'unknown'))).toEqual({
      status: 'skipped',
      reason: 'not_worktree',
    });
    expect(await exists(path.join(clone, 'node_modules'))).toBe(false);
    expect(await exists(path.join(base, 'unknown'))).toBe(false);
  });

  it('reports when dependency cloning is disabled', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    expect(await manager.refreshDependencies(clone)).toEqual({ status: 'skipped', reason: 'disabled' });
  });
  it('creates a task worktree from the freshly fetched default branch', async () => {
    const other = path.join(base, 'other');
    await git('clone', '--quiet', remote, other);
    const remoteHead = await commitFile(other, 'CHANGELOG.md', 'v2\n', 'Add changelog');
    await git('-C', other, 'push', '--quiet', 'origin', 'main');

    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-21', 'Fix the booking confirmation email'));

    expect(info).toEqual({
      path: path.join(rootDir, 'AR', 'AR-21-app'),
      branch: 'AR-21-fix-the-booking-confirmation-email',
      repo: 'app',
      gitDir: path.join(clone, '.git'),
      worktreeGitDir: path.join(clone, '.git', 'worktrees', 'AR-21-app'),
    });
    expect(await git('-C', info.path, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(await git('-C', info.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(info.branch);
    await expect(git('-C', info.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).rejects.toThrow();
    expect(await git('-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(await git('-C', clone, 'status', '--porcelain')).toBe('');
  });

  it('starts from an unpushed commit on the local default branch', async () => {
    const head = await commitFile(clone, 'local.md', 'local work\n', 'Add local work');
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-22', 'Example change'));
    expect(await git('-C', info.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git('-C', clone, 'rev-parse', 'origin/main')).not.toBe(head);
  });

  it('uses origin when the local default has diverged', async () => {
    await commitFile(clone, 'local.md', 'local\n', 'Add local work');
    const other = path.join(base, 'other');
    await git('clone', '--quiet', remote, other);
    const remoteHead = await commitFile(other, 'remote.md', 'remote\n', 'Add remote work');
    await git('-C', other, 'push', '--quiet', 'origin', 'main');
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-22', 'Example change'));
    expect(await git('-C', info.path, 'rev-parse', 'HEAD')).toBe(remoteHead);
  });

  it('finds only the existing deterministic worktree, without creating directories or branches', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    expect(await manager.find(task('AR-22', 'Example change'))).toBeNull();
    expect(await exists(rootDir)).toBe(false);
    expect(await git('-C', clone, 'branch', '--list', 'AR-22-*')).toBe('');
    const info = await manager.ensureForTask(task('AR-22', 'Example change'));
    expect(info.gitDir).toBe(path.join(clone, '.git'));
    expect(await git('-C', info.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(
      info.gitDir,
    );
    expect(await manager.find(task('AR-22', 'Changed title'))).toEqual(info);
    await manager.remove({ path: info.path });
    expect(await manager.find(task('AR-22', 'Example change'))).toBeNull();
  });

  it('applies task path validation to find, including symlink escapes', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    await expect(manager.find(task('../AR-1', 'Example'))).rejects.toMatchObject({
      code: 'invalid_task_key',
    });
    await expect(manager.find(task('AR-1', 'Example', 'missing'))).rejects.toMatchObject({
      code: 'unknown_repo',
    });
    await mkdir(rootDir);
    await symlink(workspace, path.join(rootDir, 'AR'));
    await expect(manager.find(task('AR-1', 'Example'))).rejects.toMatchObject({ code: 'outside_root' });
  });

  it('rejects traversal, symlink escapes and branch options before creating a worktree', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    project.project.repos[0]!.path = '../outside';
    await expect(manager.ensureForTask(task('AR-21', 'Escape'))).rejects.toMatchObject({
      code: 'outside_root',
    });
    project.project.repos[0]!.path = 'app';
    project.project.repos[0]!.defaultBranch = '--upload-pack=malicious';
    await expect(manager.ensureForTask(task('AR-21', 'Escape'))).rejects.toMatchObject({
      code: 'no_start_point',
    });
    project.project.repos[0]!.defaultBranch = 'main';
    await mkdir(rootDir);
    await symlink(workspace, path.join(rootDir, 'AR'));
    await expect(manager.ensureForTask(task('AR-21', 'Escape'))).rejects.toMatchObject({
      code: 'outside_root',
    });
    expect(await exists(path.join(workspace, 'AR-21-app'))).toBe(false);
  });

  it('reuses the worktree, also after the title changed', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const first = await manager.ensureForTask(task('AR-21', 'Fix the booking email'));
    await writeFile(path.join(first.path, 'work.txt'), 'in progress\n');

    const second = await manager.ensureForTask(task('AR-21', 'A completely different title'));
    expect(second).toEqual(first);
    expect(await readFile(path.join(first.path, 'work.txt'), 'utf8')).toBe('in progress\n');
  });

  it('serialises concurrent calls for the same task', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const [a, b, c] = await Promise.all([
      manager.ensureForTask(task('AR-21', 'Fix it')),
      manager.ensureForTask(task('AR-21', 'Fix it')),
      manager.ensureForTask(task('AR-22', 'Something else')),
    ]);
    expect(b).toEqual(a);
    expect(c.path).toBe(path.join(rootDir, 'AR', 'AR-22-app'));
  });

  it('reports dirty state and unpushed commits', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-21', 'Fix it'));
    expect(await manager.status(info.path)).toEqual({ dirty: false, unpushedCommits: 0 });

    await writeFile(path.join(info.path, 'feature.txt'), 'x\n');
    expect(await manager.status(info.path)).toEqual({ dirty: true, unpushedCommits: 0 });

    await git('-C', info.path, 'add', 'feature.txt');
    await git('-C', info.path, 'commit', '--quiet', '-m', 'Add feature');
    expect(await manager.status(info.path)).toEqual({ dirty: false, unpushedCommits: 1 });

    await git('-C', info.path, 'push', '--quiet', '-u', 'origin', info.branch);
    expect(await manager.status(info.path)).toEqual({ dirty: false, unpushedCommits: 0 });

    await git('-C', info.path, 'commit', '--quiet', '--allow-empty', '-m', 'Follow-up');
    expect(await manager.status(info.path)).toEqual({ dirty: false, unpushedCommits: 1 });
  });

  it('refuses to remove a dirty worktree unless forced, and keeps the branch', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-21', 'Fix it'));
    const commit = await commitFile(info.path, 'feature.txt', 'x\n', 'Add feature');
    await writeFile(path.join(info.path, 'scratch.txt'), 'not committed\n');

    await expect(manager.remove({ path: info.path })).rejects.toMatchObject({ code: 'dirty' });
    expect(await exists(info.path)).toBe(true);

    await manager.remove({ path: info.path, force: true });
    expect(await exists(info.path)).toBe(false);
    expect(await git('-C', clone, 'rev-parse', `refs/heads/${info.branch}`)).toBe(commit);
    await expect(manager.remove({ path: info.path })).resolves.toBeUndefined();
  });

  it('reads the head and the uncommitted changes of a task worktree, nothing of a detached one (PM-183)', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-21', 'Fix it'));
    const commit = await commitFile(info.path, 'feature.txt', 'x\n', 'Add feature');
    const head = await manager.head(info.path);
    expect(head).toEqual({
      commit,
      branch: info.branch,
      dirty: false,
      changes: 0,
      path: info.path,
      committedAt: expect.any(String),
    });
    // The commit's own time (PM-261).
    expect(Number.isNaN(Date.parse(head!.committedAt!))).toBe(false);

    await writeFile(path.join(info.path, 'feature.txt'), 'changed\n');
    await writeFile(path.join(info.path, 'scratch.txt'), 'untracked\n');
    expect(await manager.head(info.path)).toMatchObject({ commit, dirty: true, changes: 2 });

    await git('-C', info.path, 'checkout', '--quiet', '--detach');
    expect(await manager.head(info.path)).toBeNull();
  });

  it('recreates a removed worktree on the kept branch', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-21', 'Fix it'));
    const commit = await commitFile(info.path, 'feature.txt', 'x\n', 'Add feature');
    await manager.remove({ path: info.path });
    expect(await exists(info.path)).toBe(false);

    const again = await manager.ensureForTask(task('AR-21', 'Renamed in the meantime'));
    expect(again).toEqual(info);
    expect(await git('-C', again.path, 'rev-parse', 'HEAD')).toBe(commit);
  });

  it('starts from the task branch on origin when only the remote has it', async () => {
    const other = path.join(base, 'other');
    await git('clone', '--quiet', remote, other);
    await git('-C', other, 'checkout', '--quiet', '-b', 'AR-40-remote-work');
    const remoteCommit = await commitFile(other, 'remote.txt', 'r\n', 'Work from elsewhere');
    await git('-C', other, 'push', '--quiet', '-u', 'origin', 'AR-40-remote-work');
    await git('-C', clone, 'fetch', '--quiet', 'origin');

    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-40', 'Another title'));
    expect(info.branch).toBe('AR-40-remote-work');
    expect(await git('-C', info.path, 'rev-parse', 'HEAD')).toBe(remoteCommit);
    expect(await git('-C', info.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe(
      'origin/AR-40-remote-work',
    );
  });

  it('works offline from the last fetched state', async () => {
    await git('-C', clone, 'remote', 'set-url', 'origin', path.join(base, 'missing.git'));
    const { logger, warnings } = testLogger();
    const manager = createWorktreeManager({ rootDir, logger });

    const info = await manager.ensureForTask(task('AR-21', 'Fix it'));
    expect(await git('-C', info.path, 'rev-parse', 'HEAD')).toBe(
      await git('-C', clone, 'rev-parse', 'refs/remotes/origin/main'),
    );
    expect(warnings).toEqual([expect.stringContaining('git fetch failed')]);
  });

  it('uses the local default branch of a repository without a remote', async () => {
    const solo = path.join(base, 'solo');
    await git('init', '--quiet', '-b', 'main', solo);
    await commitFile(solo, 'README.md', 'solo\n', 'Initial commit');
    project = buildProject(solo, [{ name: 'solo', path: '.', defaultBranch: 'main' }]);

    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    const info = await manager.ensureForTask(task('AR-5', 'Local only', 'solo'));
    expect(info).toEqual({
      path: path.join(rootDir, 'AR', 'AR-5-solo'),
      branch: 'AR-5-local-only',
      repo: 'solo',
      gitDir: path.join(solo, '.git'),
      worktreeGitDir: path.join(solo, '.git', 'worktrees', 'AR-5-solo'),
    });
    expect(await manager.status(info.path)).toEqual({ dirty: false, unpushedCommits: 0 });

    await commitFile(info.path, 'work.txt', 'w\n', 'Local work');
    expect(await manager.status(info.path)).toEqual({ dirty: false, unpushedCommits: 1 });
  });

  it('refuses a task worktree outside the project folder', async () => {
    const manual = path.join(base, 'manual');
    await git('-C', clone, 'worktree', 'add', '--quiet', '-b', 'AR-30-by-hand', manual, 'main');

    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    await expect(manager.ensureForTask(task('AR-30', 'Different title'))).rejects.toMatchObject({
      code: 'outside_root',
    });
    await expect(manager.remove({ path: manual })).rejects.toMatchObject({ code: 'outside_root' });
    expect(await exists(manual)).toBe(true);
  });

  it('refuses a task branch that is checked out in the main checkout', async () => {
    await git('-C', clone, 'checkout', '--quiet', '-b', 'AR-31-main-work');
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    await expect(manager.ensureForTask(task('AR-31', 'Main work'))).rejects.toMatchObject({
      code: 'branch_in_main_checkout',
    });
  });

  it('rejects unknown repos, invalid task keys, non-repositories and occupied paths', async () => {
    const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });
    await expect(manager.ensureForTask(task('AR-21', 'x', 'nope'))).rejects.toMatchObject({
      code: 'unknown_repo',
    });
    await expect(manager.ensureForTask(task('../AR-21', 'x'))).rejects.toMatchObject({
      code: 'invalid_task_key',
    });

    await mkdir(path.join(workspace, 'plain'));
    project = buildProject(workspace, [
      { name: 'app', path: 'app', defaultBranch: 'main' },
      { name: 'plain', path: 'plain', defaultBranch: 'main' },
    ]);
    await expect(manager.ensureForTask(task('AR-21', 'x', 'plain'))).rejects.toMatchObject({
      code: 'not_a_repository',
    });

    const occupied = path.join(rootDir, 'AR', 'AR-22-app');
    await mkdir(occupied, { recursive: true });
    await writeFile(path.join(occupied, 'leftover.txt'), 'x\n');
    await expect(manager.ensureForTask(task('AR-22', 'x'))).rejects.toMatchObject({ code: 'path_taken' });
  });
});

/* PM-332: node_modules cloned into the worktree from an installed checkout (APFS, macOS). */
describe.skipIf(process.platform !== 'darwin')(
  'worktree manager: dependency clone',
  { timeout: 30_000 },
  () => {
    const LOCK = '{"name":"app","lockfileVersion":3}\n';

    function capturingLogger() {
      const records: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
      const logger: Record<string, unknown> = { level: 'silent', child: () => logger };
      for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']) {
        logger[level] = (obj: Record<string, unknown>, msg?: string) => {
          records.push({ level, obj, msg: msg ?? '' });
        };
      }
      return { logger: logger as unknown as FastifyBaseLogger, records };
    }

    /** Commits the lockfile and the ignore rule; what the repository needs for a clone. */
    async function commitPackage(packageJson = '{"name":"app"}\n'): Promise<void> {
      await writeFile(path.join(clone, '.gitignore'), 'node_modules/\n');
      await writeFile(path.join(clone, 'package.json'), packageJson);
      await writeFile(path.join(clone, 'package-lock.json'), LOCK);
      await git('-C', clone, 'add', '.');
      await git('-C', clone, 'commit', '--quiet', '-m', 'Add the package');
    }

    /** An installed checkout: node_modules with the hidden lockfile stamped after the lockfile. */
    async function install(checkout: string): Promise<void> {
      await mkdir(path.join(checkout, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(path.join(checkout, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
      await writeFile(path.join(checkout, 'node_modules', '.package-lock.json'), LOCK);
      const lockTime = new Date('2026-01-01T10:00:00Z');
      const installTime = new Date('2026-01-01T10:05:00Z');
      await utimes(path.join(checkout, 'package-lock.json'), lockTime, lockTime);
      await utimes(path.join(checkout, 'node_modules', '.package-lock.json'), installTime, installTime);
    }

    it('clones node_modules into a new worktree from the installed repository checkout', async () => {
      await commitPackage();
      await install(clone);
      const { logger, records } = capturingLogger();
      const manager = createWorktreeManager({ rootDir, logger, cloneDependencies: true });

      const info = await manager.ensureForTask(task('AR-41', 'Install fast'));

      expect(await exists(path.join(info.path, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
      expect(await git('-C', info.path, 'status', '--porcelain')).toBe('');
      const cloned = records.find((r) => r.msg === 'dependencies cloned into the worktree');
      expect(cloned).toMatchObject({
        level: 'info',
        obj: { path: info.path, reference: clone, dirs: ['.'] },
      });
      expect(typeof cloned?.obj.ms).toBe('number');
    });

    it('clones into an existing worktree that has no node_modules, and leaves an installed one alone', async () => {
      await commitPackage();
      const manager = createWorktreeManager({
        rootDir,
        logger: testLogger().logger,
        cloneDependencies: true,
      });
      const info = await manager.ensureForTask(task('AR-42', 'Later install'));
      expect(await exists(path.join(info.path, 'node_modules'))).toBe(false);

      await install(clone);
      const changed = new Date('2026-01-01T11:00:00Z');
      await utimes(path.join(info.path, 'package-lock.json'), changed, changed);
      await manager.ensureForTask(task('AR-42', 'Later install'));
      expect(await exists(path.join(info.path, 'node_modules', 'left-pad'))).toBe(true);

      await writeFile(path.join(info.path, 'node_modules', 'mine'), 'x');
      await manager.ensureForTask(task('AR-42', 'Later install'));
      expect(await exists(path.join(info.path, 'node_modules', 'mine'))).toBe(true);
    });

    it('does not clone unless it is turned on', async () => {
      await commitPackage();
      await install(clone);
      const manager = createWorktreeManager({ rootDir, logger: testLogger().logger });

      const info = await manager.ensureForTask(task('AR-43', 'No clone'));

      expect(await exists(path.join(info.path, 'node_modules'))).toBe(false);
    });

    it('takes another worktree of the repository as the reference when the checkout is not installed', async () => {
      await commitPackage();
      const manager = createWorktreeManager({
        rootDir,
        logger: testLogger().logger,
        cloneDependencies: true,
      });
      const first = await manager.ensureForTask(task('AR-44', 'First'));
      await install(first.path);
      const { logger, records } = capturingLogger();

      const second = await createWorktreeManager({ rootDir, logger, cloneDependencies: true }).ensureForTask(
        task('AR-45', 'Second'),
      );

      expect(await exists(path.join(second.path, 'node_modules', 'left-pad'))).toBe(true);
      expect(records.find((r) => r.msg === 'dependencies cloned into the worktree')?.obj.reference).toBe(
        first.path,
      );
    });

    it('refreshes existing dependencies after merging a changed lockfile from main', async () => {
      await commitPackage();
      await install(clone);
      const { logger } = capturingLogger();
      const manager = createWorktreeManager({ rootDir, logger, cloneDependencies: true });
      const args = task('AR-48', 'Refresh dependencies');
      const info = await manager.ensureForTask(args);
      await writeFile(path.join(info.path, 'node_modules', 'obsolete'), 'old');

      await writeFile(path.join(clone, 'package-lock.json'), `${LOCK.trim()}\n\n`);
      await git('-C', clone, 'add', 'package-lock.json');
      await git('-C', clone, 'commit', '--quiet', '-m', 'Update dependencies');
      await install(clone);
      await writeFile(path.join(clone, 'node_modules', 'new-package'), 'new');
      await git('-C', info.path, 'merge', '--ff-only', 'main');

      await manager.ensureForTask(args);

      expect(await exists(path.join(info.path, 'node_modules', 'obsolete'))).toBe(false);
      expect(await readFile(path.join(info.path, 'node_modules', 'new-package'), 'utf8')).toBe('new');
      expect(await git('-C', info.path, 'status', '--porcelain')).toBe('');
    });

    it('retries a missing reference after one minute and clears the cache on success', async () => {
      await commitPackage();
      const { logger, records } = capturingLogger();
      const manager = createWorktreeManager({ rootDir, logger, cloneDependencies: true });
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const initial = Date.now();
        vi.setSystemTime(initial);
        const info = await manager.ensureForTask(task('AR-49', 'Retry dependencies'));
        await install(clone);
        expect(await manager.refreshDependencies(info.path)).toEqual({
          status: 'skipped',
          reason: 'no_reference',
        });
        expect(records.filter((r) => r.msg === 'worktree dependencies left unchanged')).toHaveLength(1);
        vi.setSystemTime(initial + 60_000);
        expect(await manager.refreshDependencies(info.path)).toMatchObject({ status: 'cloned' });
        expect(await manager.refreshDependencies(info.path)).toEqual({
          status: 'skipped',
          reason: 'present',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries immediately when the target lock mtime changes and serializes concurrent calls', async () => {
      await commitPackage();
      const { logger, records } = capturingLogger();
      const manager = createWorktreeManager({ rootDir, logger, cloneDependencies: true });
      const info = await manager.ensureForTask(task('AR-50', 'Concurrent dependencies'));
      await install(clone);
      const changed = new Date(Date.now() + 1000);
      await utimes(path.join(info.path, 'package-lock.json'), changed, changed);

      const results = await Promise.all([
        manager.refreshDependencies(info.path),
        manager.refreshDependencies(info.path),
      ]);

      expect(results.map((r) => (r.status === 'skipped' ? r.reason : r.status)).sort()).toEqual([
        'cloned',
        'present',
      ]);
      expect(records.filter((r) => r.msg === 'dependencies cloned into the worktree')).toHaveLength(1);
    });

    it('forgets a removed worktree', async () => {
      const manager = createWorktreeManager({
        rootDir,
        logger: capturingLogger().logger,
        cloneDependencies: true,
      });
      const info = await manager.ensureForTask(task('AR-51', 'Remove dependencies'));
      await manager.remove({ path: info.path });
      expect(await manager.refreshDependencies(info.path)).toEqual({
        status: 'skipped',
        reason: 'not_worktree',
      });
    });

    it('records why nothing was cloned and still creates the worktree', async () => {
      await commitPackage();
      const { logger, records } = capturingLogger();
      const manager = createWorktreeManager({ rootDir, logger, cloneDependencies: true });

      const info = await manager.ensureForTask(task('AR-46', 'Nothing to clone from'));

      expect(await exists(path.join(info.path, 'README.md'))).toBe(true);
      expect(records.find((r) => r.msg === 'dependencies not cloned into the worktree')).toMatchObject({
        level: 'debug',
        obj: { path: info.path, reason: 'no_reference' },
      });
    });

    it('creates the worktree even when the clone fails, with a warning and no leftovers', async () => {
      await commitPackage('{ not json');
      await install(clone);
      const { logger, records } = capturingLogger();
      const manager = createWorktreeManager({ rootDir, logger, cloneDependencies: true });

      const info = await manager.ensureForTask(task('AR-47', 'Broken package'));

      expect(await exists(path.join(info.path, 'README.md'))).toBe(true);
      expect(await exists(path.join(info.path, 'node_modules'))).toBe(false);
      expect(records.filter((r) => r.level === 'warn')).toHaveLength(1);
      expect(await git('-C', info.path, 'status', '--porcelain', '--ignored')).toBe('');
    });
  },
);
