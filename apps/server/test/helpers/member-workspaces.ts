import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '@projectman/shared';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './domain-harness';
import type { DomainHarness } from './domain-harness';
import { createGitSeed } from './git-seed';

/*
 * PM-138: durable member workspaces with the real git-backed manager and the fake runner. The
 * project's repository is the harness workspace itself (the test template's `web` repo, path `.`).
 * A test runs a few hundred git processes one after the other, so the tests are spread over the
 * `member-workspaces*.test.ts` files: in one file they passed the merge test's file deadline on a
 * loaded machine (PM-1440).
 */

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  const { stdout } = await exec('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
}

export async function commitFile(repo: string, file: string, content: string): Promise<string> {
  await writeFile(path.join(repo, file), content);
  await git(repo, 'add', file);
  await git(repo, 'commit', '--quiet', '-m', `Change ${file}`);
  return git(repo, 'rev-parse', 'HEAD');
}

export const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** dev-1 may carry two tasks: the same repository still serves one at a time. */
export const twoTasks = (c: ProjectConfig) => {
  const dev = c.team.members.find((m) => m.handle === 'dev-1');
  if (dev?.kind === 'ai') dev.capacity = 2;
};

/**
 * Registers the file's git configuration (no system or user configuration) and its seed
 * repository; returns the seed, readable from the tests on.
 */
export function useWorkspaceSeed(): () => ReturnType<typeof createGitSeed> {
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
  return () => seed;
}

export type WorkspaceHarnessOptions = Parameters<typeof createDomainHarness>[0];

/** A persistent harness with member workspaces over a copy of the seed, and the tasks AR-1 and AR-2. */
export async function createWorkspaceHarness(
  seed: ReturnType<typeof createGitSeed>,
  opts: WorkspaceHarnessOptions = {},
): Promise<DomainHarness> {
  const h = await createDomainHarness({
    memberWorkspaces: true,
    persistent: true,
    adjust: twoTasks,
    ...opts,
  });
  seed.copyTo(h.workspace);
  await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Signup page' }, OWNER_ACTOR);
  return h;
}

/** The steps the tests share, over the current harness (a restart replaces it). */
export function workspaceSteps(harness: () => DomainHarness) {
  return {
    workspaceOf: async (handle: string) =>
      path.join(await realpath(harness().workspacesDir), 'AR', handle, 'web', 'repo'),
    startTask: (taskKey: string, assignee: string) =>
      harness().domain.taskStarts.start('AR', taskKey, { assignee, actor: OWNER_ACTOR, author: OWNER }),
    ensure: (handle: string, taskKey: string, message?: string) =>
      harness().domain.sessions.ensureSession(
        'AR',
        handle,
        { type: 'task', taskKey },
        { messages: message ? [message] : undefined },
      ),
    branchOf: (dir: string) => git(dir, 'branch', '--show-current'),
    /** Background starts (hand-overs, message wake-ups) run real git: wait for the n-th start. */
    startedCount: (n: number) =>
      vi.waitFor(() => expect(harness().runner.started).toHaveLength(n), { timeout: 20_000, interval: 50 }),
  };
}

export const scopeCleanup = (scopeId: string, outcome: 'clean' | 'failed' | 'unverified') => ({
  scopeId,
  kind: 'process_group' as const,
  outcome,
  reason: 'stop' as const,
  killed: true,
  survivors: outcome === 'failed' ? 1 : 0,
  durationMs: 7000,
});

/** Every session of the harness starts in the process scope `scp_0123456789abcdef`. */
export function scopeStarts(h: DomainHarness) {
  const original = h.runner.start.bind(h.runner);
  vi.spyOn(h.runner, 'start').mockImplementation(async (spec) => {
    const info = await original(spec);
    info.scopeId = 'scp_0123456789abcdef';
    return info;
  });
}
