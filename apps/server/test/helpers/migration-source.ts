import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { createAppHarness, OWNER_LOGIN, setupOwner } from './app-harness';
import type { AppHarness } from './app-harness';
import { pngBytes, uploadFile } from './attachments';

/**
 * The owner's Mac as the move sees it (PM-143): a stopped PROJECTMAN_HOME with a project, a task with
 * an attachment, conversations of both providers, a member workspace, a repository with a remote, a
 * branch that exists only here, a task worktree and dirty and untracked work in both checkouts. The
 * paths are all under a scratch directory, so the tests translate them like a real move would.
 */

export interface SourceHome {
  harness: AppHarness;
  /** Scratch directory holding everything below. */
  root: string;
  /** PROJECTMAN_HOME of the old machine. */
  home: string;
  /** The project's workspace and its repository `web` (path "."). */
  workspace: string;
  /** The bare repository that `origin` points at. */
  remote: string;
  /** The task worktree under `<home>/worktrees`, with uncommitted work. */
  worktree: string;
  claudeTranscript: string;
  codexTranscript: string;
  taskKey: string;
  /** Stops the app: the home is then a stopped source. */
  stop(): Promise<void>;
  cleanup(): Promise<void>;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
};

export function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    env: { ...env, ...GIT_ENV },
    encoding: 'utf8',
  });
}

export async function createSourceHome(): Promise<SourceHome> {
  const harness = await createAppHarness();
  const home = harness.home;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pm-move-')));
  const workspace = join(root, 'Dev', 'acme');
  const remote = join(root, 'remote.git');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(remote);

  // The repository: a remote, a branch that exists only here, a task worktree, dirty work.
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(workspace, 'init', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), 'acme\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'Initial commit');
  git(workspace, 'remote', 'add', 'origin', remote);
  git(workspace, 'push', '-q', 'origin', 'main');
  git(workspace, 'checkout', '-q', '-b', 'feature/local-only');
  writeFileSync(join(workspace, 'local.txt'), 'only on this machine\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'Work that was never pushed');
  git(workspace, 'checkout', '-q', 'main');
  const worktree = join(home, 'worktrees', 'AR', 'AR-1');
  mkdirSync(join(home, 'worktrees', 'AR'), { recursive: true });
  git(workspace, 'worktree', 'add', '-q', '-b', 'task/ar-1', worktree, 'main');
  writeFileSync(join(worktree, 'README.md'), 'acme\nhalf-done change\n');
  writeFileSync(join(worktree, 'scratch.txt'), 'untracked work\n');
  writeFileSync(join(workspace, 'notes.txt'), 'a note in the main checkout\n');

  // The server's own data.
  const cookie = await setupOwner(harness.app);
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: {
      key: 'AR',
      name: 'acme',
      workspacePath: workspace,
      templateId: 'test',
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
    },
  });
  if (created.statusCode !== 201) throw new Error(`project creation failed: ${created.body}`);
  const task = await harness.app.inject({
    method: 'POST',
    url: routes.tasks('AR'),
    headers: { cookie },
    payload: { title: 'Acme checkout' },
  });
  const taskKey = task.json<Task>().key;
  const uploaded = await uploadFile(harness.app, cookie, pngBytes(256), { taskKey });
  if (uploaded.statusCode !== 201) throw new Error(`upload failed: ${uploaded.body}`);

  const claudeTranscript = join(root, 'claude-home', 'projects', 'acme', 'abc.jsonl');
  const codexTranscript = join(root, 'codex-home', 'sessions', 'rollout-2026-09-30-xyz.jsonl');
  mkdirSync(join(root, 'claude-home', 'projects', 'acme'), { recursive: true });
  mkdirSync(join(root, 'codex-home', 'sessions'), { recursive: true });
  writeFileSync(claudeTranscript, '{"type":"user","message":{"content":"hello"}}\n');
  writeFileSync(codexTranscript, '{"type":"session_meta"}\n');
  const { repos } = harness.app.projectman;
  const at = '2026-09-30T10:00:00.000Z';
  let uuid = 0;
  const session = (id: string, member: string, provider: 'claude' | 'codex', cwd: string, transcriptPath: string | null) =>
    repos.sessions.insert({
      id,
      projectKey: 'AR',
      member,
      workItem: { type: 'task', taskKey },
      claudeSessionId: `00000000-0000-4000-8000-${String((uuid += 1)).padStart(12, '0')}`,
      provider,
      cwd,
      branch: 'task/ar-1',
      transcriptPath,
      state: 'exited',
      activity: null,
      startedAt: at,
      lastActivityAt: at,
      endedAt: at,
    });
  session('ses_claude', 'dev-1', 'claude', worktree, claudeTranscript);
  session('ses_codex', 'dev-2', 'codex', workspace, codexTranscript);
  // A conversation whose transcript is gone from the old machine too.
  repos.sessions.insert({
    id: 'ses_lost',
    projectKey: 'AR',
    member: 'dev-1',
    workItem: { type: 'general' },
    claudeSessionId: '00000000-0000-4000-8000-000000000099',
    provider: 'claude',
    cwd: workspace,
    branch: null,
    transcriptPath: join(root, 'claude-home', 'projects', 'acme', 'gone.jsonl'),
    state: 'exited',
    activity: null,
    startedAt: at,
    lastActivityAt: at,
    endedAt: at,
  });
  const { db } = repos;
  db.prepare(
    `INSERT INTO member_workspaces (id, project_key, member, repo, path, generation, created_at)
     VALUES ('mw_1', 'AR', 'dev-1', 'web', ?, 1, ?)`,
  ).run(join(home, 'workspaces', 'AR', 'dev-1', 'web'), at);
  db.prepare(
    `INSERT INTO task_workspace_bindings (project_key, task_key, member, workspace_id, kind, branch, source_path,
       generation, created_at, updated_at) VALUES ('AR', ?, 'dev-1', 'mw_1', 'work', 'task/ar-1', ?, 1, ?, ?)`,
  ).run(taskKey, workspace, at, at);

  mkdirSync(join(home, 'memory', 'AR'), { recursive: true });
  writeFileSync(join(home, 'memory', 'AR', 'dev-1.md'), 'Remember: Hungarian notes.\n');
  mkdirSync(join(home, 'github-publish'), { recursive: true });
  writeFileSync(join(home, 'github-publish', 'state'), 'identity state that never moves\n');

  return {
    harness,
    root,
    home,
    workspace,
    remote,
    worktree,
    claudeTranscript,
    codexTranscript,
    taskKey,
    stop: () => harness.app.close(),
    async cleanup() {
      await harness.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export { OWNER_LOGIN };
