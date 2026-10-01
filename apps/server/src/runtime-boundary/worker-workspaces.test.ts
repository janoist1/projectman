import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { getTemplate } from '@projectman/templates';
import type {
  MemberWorkspaceKey,
  MemberWorkspaceManager,
  SessionLauncher,
  WorkerRunRequest,
} from '../contracts';
import { createMemberWorkspaceManager, MemberWorkspaceError } from '../worktree';
import { memberOfPath, workerLayout } from './config';
import { testBoundaryConfig } from './test-helpers';
import { copyFromWorker, workerWorkspaceAccess } from './worker-workspaces';

/*
 * Member workspaces as the managed VM runs them: in worker homes, every command in them through
 * the launcher (here a fake that runs the program in place and records which member it ran as),
 * commits handed between accounts as bundles in the spool. Real git, temp directories.
 */

const exec = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args);
  return stdout.trim();
}

async function commitFile(repo: string, file: string, message: string): Promise<string> {
  await writeFile(path.join(repo, file), `${file}\n`);
  await git('-C', repo, 'add', file);
  await git('-C', repo, 'commit', '--quiet', '-m', message);
  return git('-C', repo, 'rev-parse', 'HEAD');
}

const silent = (() => {
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
})();

let configDir: string;
let base: string;
let projectRepo: string;
let project: ProjectConfig;
let manager: MemberWorkspaceManager;
let calls: WorkerRunRequest[];
let homeRoot: string;
let spoolRoot: string;

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

/** Runs the program here, as if as `member`: checks the directory the launcher would check. */
function fakeLauncher(layout: ReturnType<typeof workerLayout>): SessionLauncher {
  return {
    ping: async () => true,
    start: async () => {
      throw new Error('not used');
    },
    async run(request) {
      calls.push(request);
      const home = layout.home(request.member);
      if (request.cwd !== home && !request.cwd.startsWith(`${home}/`))
        throw new Error('cwd outside the home');
      if (request.program === 'mv') {
        const [, , from, to] = request.args; // -T -- from to
        await rename(from!, to!);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }
      try {
        const { stdout, stderr } = await exec(request.program, request.args, { cwd: request.cwd });
        return { exitCode: 0, stdout, stderr, timedOut: false };
      } catch (err) {
        const failure = err as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: failure.code ?? 1,
          stdout: failure.stdout ?? '',
          stderr: failure.stderr ?? '',
          timedOut: false,
        };
      }
    },
  };
}

beforeEach(async () => {
  calls = [];
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-worker-ws-')));
  homeRoot = path.join(base, 'work');
  spoolRoot = path.join(base, 'spool');
  for (const member of ['dev', 'qa']) {
    await mkdir(path.join(homeRoot, `pmw-${member}`), { recursive: true });
    await mkdir(path.join(spoolRoot, member, 'in'), { recursive: true });
    await mkdir(path.join(spoolRoot, member, 'out'), { recursive: true });
  }
  const workspace = path.join(base, 'workspace');
  projectRepo = path.join(workspace, 'app');
  await mkdir(projectRepo, { recursive: true });
  await git('init', '--quiet', '-b', 'main', projectRepo);
  await commitFile(projectRepo, 'README.md', 'Initial commit');
  project = getTemplate('small-team')!.build({
    key: 'AR',
    name: 'Acme',
    workspacePath: workspace,
    language: 'en',
    owner: { handle: 'owner', displayName: 'Anna Example', email: 'anna@example.com' },
  });
  project.project.repos = [{ name: 'app', path: 'app', defaultBranch: 'main' }];
  const config = testBoundaryConfig({
    workers: { ...testBoundaryConfig().workers, homeRoot, spoolRoot },
  });
  const layout = workerLayout(config);
  manager = createMemberWorkspaceManager({
    rootDir: path.join(base, 'unused'),
    logger: silent,
    access: workerWorkspaceAccess({
      layout,
      ownerOf: (target) => memberOfPath(config, target),
      launcher: fakeLauncher(layout),
      serverSpool: path.join(base, 'server-spool'),
    }),
    rootFor: (member) => layout.workspaces(member),
  });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const key = (member: string): MemberWorkspaceKey => ({ project, repoName: 'app', member });
const spoolFiles = async () =>
  (
    await Promise.all(
      ['dev', 'qa'].flatMap((m) => ['in', 'out'].map((d) => readdir(path.join(spoolRoot, m, d)))),
    )
  ).flat();

describe('member workspaces in worker homes', { timeout: 30_000 }, () => {
  it('clones the project repository into the member home as that member, through a bundle', async () => {
    const ws = await manager.ensure(key('dev'));
    expect(ws.path).toBe(path.join(homeRoot, 'pmw-dev', 'workspaces', 'AR', 'dev', 'app', 'repo'));
    expect(await git('-C', ws.path, 'log', '--format=%s', '-1')).toBe('Initial commit');
    expect(await git('-C', ws.path, 'remote')).toBe('');
    // Every command ran as dev; none in the project repository went through the launcher.
    expect(new Set(calls.map((c) => c.member))).toEqual(new Set(['dev']));
    expect(calls.some((c) => c.args.includes(projectRepo))).toBe(false);
    const clone = calls.find((c) => c.program === 'git' && c.args.includes('clone'))!;
    expect(clone.args.at(-2)).toMatch(
      new RegExp(`^${path.join(spoolRoot, 'dev', 'in')}/[0-9a-f]{16}\\.bundle$`),
    );
    // The hand-over is gone, and the workspace description is not written by the server.
    expect(await spoolFiles()).toEqual([]);
    await expect(
      stat(path.join(homeRoot, 'pmw-dev', 'workspaces', 'AR', 'dev', 'app', 'workspace.json')),
    ).rejects.toThrow();
  });

  it('starts a task branch from the fresh default branch, fetched as a bundle', async () => {
    await manager.ensure(key('dev'));
    const update = await commitFile(projectRepo, 'next.md', 'Next');
    const base = await manager.fetchBase(key('dev'));
    expect(base).toEqual({ branch: 'main', commit: update });
    const checkout = await manager.checkoutTaskBranch(key('dev'), {
      mode: 'create',
      branch: 'AR-1-work',
      startPoint: base.commit,
    });
    expect(checkout).toEqual({ branch: 'AR-1-work', head: update });
    expect(await spoolFiles()).toEqual([]);
  });

  it("hands a teammate's committed branch to a reviewer: bundled by its owner, fetched by the reviewer", async () => {
    const devWs = await manager.ensure(key('dev'));
    const { commit } = await manager.fetchBase(key('dev'));
    await manager.checkoutTaskBranch(key('dev'), { mode: 'create', branch: 'AR-1-work', startPoint: commit });
    const work = await commitFile(devWs.path, 'feature.md', 'Feature');
    await manager.ensure(key('qa'));
    calls = [];

    const source = { path: devWs.path, ref: 'refs/heads/AR-1-work' };
    expect(await manager.resolveSource(source)).toBe(work);
    const review = await manager.checkoutReview(key('qa'), source, work);
    expect(review).toEqual({ branch: null, head: work });

    const bundled = calls.find((c) => c.program === 'git' && c.args.includes('bundle'))!;
    expect(bundled.member).toBe('dev');
    expect(bundled.args).toContain(path.join(spoolRoot, 'dev', 'out', path.basename(bundled.args.at(-2)!)));
    const fetched = calls.find((c) => c.program === 'git' && c.args.includes('fetch'))!;
    expect(fetched.member).toBe('qa');
    expect(fetched.args.join(' ')).toContain(path.join(spoolRoot, 'qa', 'in'));
    expect(await spoolFiles()).toEqual([]);
  });

  it('fetches a branch of the project repository into a workspace for a continued task', async () => {
    await git('-C', projectRepo, 'branch', 'AR-2-old');
    await manager.ensure(key('dev'));
    const found = await manager.findTaskBranch(key('dev'), 'AR-2');
    expect(found).toEqual({ branch: 'AR-2-old', source: { path: projectRepo, ref: 'refs/heads/AR-2-old' } });
    const checkout = await manager.checkoutTaskBranch(key('dev'), {
      mode: 'fetch',
      branch: 'AR-2-old',
      source: found!.source!,
    });
    expect(checkout.branch).toBe('AR-2-old');
  });

  it('hands a branch to the server (publishing) only as a bundle its worker made, into the server spool', async () => {
    const devWs = await manager.ensure(key('dev'));
    const { commit } = await manager.fetchBase(key('dev'));
    await manager.checkoutTaskBranch(key('dev'), { mode: 'create', branch: 'AR-1-work', startPoint: commit });
    const work = await commitFile(devWs.path, 'feature.md', 'Feature');
    calls = [];

    const handed = await manager.exportBranch(key('dev'), 'AR-1-work');
    expect(handed.bundle).toBe(true);
    expect(path.dirname(handed.path)).toBe(path.join(base, 'server-spool'));
    expect((await stat(handed.path)).mode & 0o777).toBe(0o600);
    // The worker bundled its own branch; the server's copy holds exactly that tip.
    const bundled = calls.find((c) => c.program === 'git' && c.args.includes('bundle'))!;
    expect(bundled.member).toBe('dev');
    expect(bundled.args.slice(-1)).toEqual(['refs/heads/AR-1-work']);
    expect(await git('bundle', 'list-heads', handed.path)).toBe(`${work} refs/heads/AR-1-work`);
    expect(await spoolFiles()).toEqual([]);
    await handed.done();
    expect(await readdir(path.join(base, 'server-spool'))).toEqual([]);

    await expect(manager.exportBranch(key('dev'), '--upload-pack=x')).rejects.toMatchObject({
      code: 'workspace_invalid',
    });
  });

  it('gives the server nothing from a worker without its own spool', async () => {
    const config = testBoundaryConfig({ workers: { ...testBoundaryConfig().workers, homeRoot, spoolRoot } });
    const layout = workerLayout(config);
    const access = workerWorkspaceAccess({
      layout,
      ownerOf: (target) => memberOfPath(config, target),
      launcher: fakeLauncher(layout),
    });
    await expect(
      access.transfer(null, {
        path: path.join(layout.workspaces('dev'), 'x'),
        refs: ['--all'],
        owner: 'dev',
      }),
    ).rejects.toThrow(/no hand-over/);
    expect(calls).toEqual([]);
  });

  it('reports a failed command of a worker as the usual refusal', async () => {
    await manager.ensure(key('dev'));
    const err = await manager
      .checkoutTaskBranch(key('dev'), { mode: 'continue', branch: 'AR-9-missing' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(MemberWorkspaceError);
    expect(err.code).toBe('workspace_branch_missing');
  });
});

describe('copying a bundle out of a worker spool', () => {
  const uid = process.getuid?.() ?? 0;

  it('copies a regular file of the worker into a new file', async () => {
    const from = path.join(spoolRoot, 'dev', 'out', 'a.bundle');
    const to = path.join(spoolRoot, 'qa', 'in', 'a.bundle');
    await writeFile(from, 'bundle bytes');
    await copyFromWorker(from, to, uid);
    expect(await readFile(to, 'utf8')).toBe('bundle bytes');
    // Never over an existing file.
    await expect(copyFromWorker(from, to, uid)).rejects.toThrow();
  });

  it('refuses a symlink, a named pipe, a hard link and a file of another account', async () => {
    const out = path.join(spoolRoot, 'dev', 'out');
    const to = (name: string) => path.join(spoolRoot, 'qa', 'in', name);
    const secret = path.join(base, 'secret');
    await writeFile(secret, 'SECRET');
    await symlink(secret, path.join(out, 'link.bundle'));
    await expect(copyFromWorker(path.join(out, 'link.bundle'), to('1'), uid)).rejects.toThrow();
    await exec('mkfifo', [path.join(out, 'pipe.bundle')]);
    const started = Date.now();
    await expect(copyFromWorker(path.join(out, 'pipe.bundle'), to('2'), uid)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
    await link(secret, path.join(out, 'hard.bundle'));
    await expect(copyFromWorker(path.join(out, 'hard.bundle'), to('3'), uid)).rejects.toThrow();
    await writeFile(path.join(out, 'mine.bundle'), 'x');
    await expect(copyFromWorker(path.join(out, 'mine.bundle'), to('4'), uid + 1)).rejects.toThrow();
    expect(await readdir(path.join(spoolRoot, 'qa', 'in'))).toEqual([]);
  });
});
