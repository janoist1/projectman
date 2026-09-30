import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
