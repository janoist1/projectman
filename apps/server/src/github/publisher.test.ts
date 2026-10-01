import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublishError } from '../contracts';
import { createGithubPublisher } from './publisher';
import { createFakeGh, createTestLogger, type FakeGh } from './test-fixtures/harness';

const TOKEN = 'ghp_FAKETOKEN0123456789abcdefghijklmnopqr';
const REPO = 'acme/app';
const BRANCH = 'PM-142-publish';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'Dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function gitFails(cwd: string, ...args: string[]): string {
  try {
    execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    return String((err as { stderr?: string }).stderr);
  }
  throw new Error(`git ${args.join(' ')} unexpectedly succeeded`);
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `Change ${file}`);
  return git(cwd, 'rev-parse', 'HEAD');
}

let dir: string;
let remote: string;
let workspace: string;
let fake: FakeGh;
let logs: unknown[][];
let tokenValue: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-publish-'));
  remote = join(dir, 'remote.git');
  workspace = join(dir, 'workspace');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'clone', '-q', remote, workspace);
  git(workspace, 'checkout', '-q', '-b', 'main');
  commit(workspace, 'readme.md', 'base\n');
  git(workspace, 'push', '-q', 'origin', 'main');
  // GitHub's protection of the default branch: the remote refuses to move or delete it.
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "GH006: Protected branch update failed for refs/heads/main" >&2; exit 1; fi\ndone\n',
  );
  chmodSync(hook, 0o755);
  git(workspace, 'checkout', '-q', '-b', BRANCH);
  fake = await createFakeGh({ identities: { [TOKEN]: { login: 'acme-vm-bot', canMerge: false } } });
  logs = [];
  tokenValue = TOKEN;
});

afterEach(async () => {
  await fake.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function publisher(over: { token?: () => Promise<string> } = {}) {
  const logger = createTestLogger();
  for (const level of ['info', 'warn', 'error'] as const)
    logger[level].mockImplementation((...args: unknown[]) => void logs.push(args));
  return createGithubPublisher({
    ghBin: fake.bin,
    stateDir: join(dir, 'state'),
    token: over.token ?? (async () => tokenValue),
    remoteUrl: () => remote,
    pushProtocols: 'file',
    env: fake.env,
    logger,
  });
}

const request = (commitId: string, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  branch: BRANCH,
  baseBranch: 'main',
  commit: commitId,
  sourcePath: workspace,
  title: 'PM-142 publish',
  body: 'Publishes the task branch.',
  taskKey: 'PM-142',
  ...over,
});

const remoteBranches = () => git(remote, 'for-each-ref', '--format=%(refname) %(objectname)');

async function failure(promise: Promise<unknown>): Promise<PublishError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PublishError);
  return err as PublishError;
}

describe('publishing a task branch', () => {
  it('pushes the own branch and opens its pull request, leaving the default branch alone', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const mainBefore = git(remote, 'rev-parse', 'refs/heads/main');
    const result = await publisher().publish(request(tip));
    expect(result).toMatchObject({
      repo: REPO,
      branch: BRANCH,
      commit: tip,
      alreadyPublished: false,
      pullRequestCreated: true,
      pullRequest: {
        number: 100,
        headRef: BRANCH,
        baseRef: 'main',
        state: 'open',
        authorLogin: 'acme-vm-bot',
      },
    });
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(tip);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(mainBefore);
  });

  it("publishes from the worker's bundle of the branch behind the VM boundary, never from a link", async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const bundle = join(dir, 'handed.bundle');
    git(workspace, 'bundle', 'create', '-q', bundle, `refs/heads/${BRANCH}`);
    const result = await publisher().publish(request(tip, { sourcePath: bundle, sourceKind: 'bundle' }));
    expect(result).toMatchObject({ commit: tip, pullRequestCreated: true });
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(tip);

    const link = join(dir, 'link.bundle');
    symlinkSync(bundle, link);
    const refused = await failure(
      publisher().publish(request(tip, { sourcePath: link, sourceKind: 'bundle' })),
    );
    expect(refused.code).toBe('no_task_branch');
    // A bundle whose branch tip is another commit is refused like a moved branch.
    const later = commit(workspace, 'later.ts', 'two\n');
    expect(
      (await failure(publisher().publish(request(later, { sourcePath: bundle, sourceKind: 'bundle' })))).code,
    ).toBe('commit_mismatch');
  });

  it('gives gh the identity through its environment only, never the command line or the log', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    await publisher().publish(request(tip));
    const calls = await fake.calls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.identity.GH_TOKEN).toBe(TOKEN);
      expect(call.argv.join(' ')).not.toContain(TOKEN);
      // The server's own gh login and environment are not the identity: gh gets the publisher's home.
      expect(call.identity.HOME).toBe(join(dir, 'state', 'home'));
      expect(call.identity.GH_CONFIG_DIR).toBe(join(dir, 'state', 'gh'));
      expect(call.identity.GITHUB_TOKEN).toBeNull();
    }
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('is idempotent: the same commit again uploads nothing and reuses the open pull request', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const first = await publisher().publish(request(tip));
    const again = await publisher().publish(request(tip));
    expect(again).toMatchObject({ alreadyPublished: true, pullRequestCreated: false });
    expect(again.pullRequest.number).toBe(first.pullRequest.number);
    expect((await fake.calls()).filter((c) => c.argv.slice(0, 2).join(' ') === 'pr create')).toHaveLength(1);
  });

  it('fast-forwards the branch with a later commit and keeps the same pull request', async () => {
    const first = await publisher().publish(request(commit(workspace, 'a.ts', 'a\n')));
    const second = commit(workspace, 'b.ts', 'b\n');
    const next = await publisher().publish(request(second));
    expect(next).toMatchObject({ alreadyPublished: false, pullRequestCreated: false });
    expect(next.pullRequest.number).toBe(first.pullRequest.number);
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(second);
  });

  it('opens one pull request for two simultaneous calls', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const p = publisher();
    const [a, b] = await Promise.all([p.publish(request(tip)), p.publish(request(tip))]);
    expect(a.pullRequest.number).toBe(b.pullRequest.number);
    expect([a.pullRequestCreated, b.pullRequestCreated].filter(Boolean)).toHaveLength(1);
  });

  it('recovers when the pull request exists but the list did not show it', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    await publisher().publish(request(tip));
    // GitHub says "already exists" to a create that raced a first one; the publisher reads it back.
    await fake.setScenario({
      identities: { [TOKEN]: { login: 'acme-vm-bot' } },
      create: {
        [`${REPO}@${BRANCH}`]: {
          stderr: 'a pull request for branch "PM-142-publish" into branch "main" already exists',
          exitCode: 1,
        },
      },
    });
    const again = await publisher().publish(request(tip));
    expect(again.pullRequest.number).toBe(100);
  });
});

describe('what the publisher never does', () => {
  it.each([
    ['the default branch', { branch: 'main' }, 'protected_branch'],
    ['another task branch', { branch: 'PM-143-other' }, 'foreign_branch'],
    ['a refspec smuggled in the branch', { branch: `${BRANCH}:main` }, 'invalid_branch'],
    ['a forced refspec', { branch: `+${BRANCH}` }, 'invalid_branch'],
    ['a full ref name', { branch: `refs/heads/${BRANCH}` }, 'invalid_branch'],
    ['a short commit', { commit: 'abc1234' }, 'invalid_commit'],
    ['a local-only repository name', { repo: 'not a repo' }, 'local_only'],
  ])('refuses %s before it touches git or gh', async (_name, over, code) => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const before = remoteBranches();
    const err = await failure(publisher().publish(request(tip, over)));
    expect(err.code).toBe(code);
    expect(remoteBranches()).toBe(before);
    expect(await fake.calls()).toHaveLength(0);
  });

  it('refuses a commit that is not the branch tip', async () => {
    const older = commit(workspace, 'a.ts', 'a\n');
    commit(workspace, 'b.ts', 'b\n');
    const before = remoteBranches();
    const err = await failure(publisher().publish(request(older)));
    expect(err.code).toBe('commit_mismatch');
    expect(remoteBranches()).toBe(before);
  });

  it('never forces: a remote branch with other commits stays as it is', async () => {
    const tip = commit(workspace, 'feature.ts', 'mine\n');
    // Somebody else put a different commit on the remote branch.
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', remote, other);
    git(other, 'checkout', '-q', '-b', BRANCH, 'origin/main');
    const theirs = commit(other, 'theirs.ts', 'theirs\n');
    git(other, 'push', '-q', 'origin', BRANCH);
    const err = await failure(publisher().publish(request(tip)));
    expect(err.code).toBe('not_fast_forward');
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(theirs);
    expect((await fake.calls()).filter((c) => c.argv[0] === 'pr' && c.argv[1] === 'create')).toHaveLength(0);
  });

  it('does not run anything of the member workspace: hooks, helpers and push URLs there do not apply', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const marker = join(dir, 'ran');
    writeFileSync(join(dir, 'evil.sh'), `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(join(dir, 'evil.sh'), 0o755);
    git(workspace, 'config', 'core.hooksPath', dir);
    git(workspace, 'config', 'core.fsmonitor', join(dir, 'evil.sh'));
    git(workspace, 'config', 'credential.helper', `!${join(dir, 'evil.sh')}`);
    git(workspace, 'config', 'remote.origin.pushurl', join(dir, 'elsewhere.git'));
    await publisher().publish(request(tip));
    expect(() => execFileSync('test', ['-e', marker])).toThrow();
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(tip);
  });

  it('refuses a workspace that borrows objects or is a linked worktree', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    mkdirSync(join(workspace, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(workspace, '.git', 'objects', 'info', 'alternates'), `${join(dir, 'x')}\n`);
    expect((await failure(publisher().publish(request(tip)))).code).toBe('no_task_branch');
  });

  it('never merges: the identity has no merge right at GitHub, and the publisher does not ask', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const result = await publisher().publish(request(tip));
    const calls = await fake.calls();
    expect(calls.some((c) => c.argv[0] === 'api' || (c.argv[0] === 'pr' && c.argv[1] === 'merge'))).toBe(
      false,
    );
    // The stand-in for GitHub refuses the identity both ways (the real check is manual, docs/GITHUB.md).
    const env = { ...process.env, ...fake.env, GH_TOKEN: TOKEN };
    for (const args of [
      ['pr', 'merge', String(result.pullRequest.number), `--repo=${REPO}`],
      ['api', '--method=PUT', `repos/${REPO}/pulls/${result.pullRequest.number}/merge`],
    ]) {
      expect(() => execFileSync(fake.bin, args, { env, stdio: 'pipe' })).toThrow(/protected branch/);
    }
    // And so does the remote for the default branch, deletion and a forced move.
    expect(gitFails(workspace, 'push', remote, 'HEAD:refs/heads/main')).toMatch(/GH006/);
    expect(gitFails(workspace, 'push', remote, '+HEAD:refs/heads/main')).toMatch(/GH006/);
    expect(gitFails(workspace, 'push', remote, ':refs/heads/main')).toMatch(/GH006/);
  });
});

describe('credentials never show', () => {
  it('redacts the token from failures and the log', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    await fake.setScenario({
      identities: { [TOKEN]: { login: 'acme-vm-bot' } },
      branches: {
        [`${REPO}@${BRANCH}`]: {
          stderr: `HTTP 401: Bad credentials (https://x-access-token:${TOKEN}@github.com/api) Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
          exitCode: 1,
        },
      },
    });
    const err = await failure(publisher().publish(request(tip)));
    expect(err.code).toBe('remote_failed');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    expect(err.message).not.toMatch(/x-access-token:/);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it('refuses without a token and does nothing', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const err = await failure(publisher({ token: async () => '  ' }).publish(request(tip)));
    expect(err.code).toBe('remote_failed');
    expect(remoteBranches()).not.toContain(BRANCH);
  });

  it('reads the token again on every call, so a rotation needs no restart', async () => {
    const tip = commit(workspace, 'feature.ts', 'one\n');
    const p = publisher();
    tokenValue = 'ghp_ROTATEDTOKEN0123456789abcdefghijklmnop';
    await p.publish(request(tip));
    expect((await fake.calls())[0]!.identity.GH_TOKEN).toBe(tokenValue);
  });
});

describe('the remote state', () => {
  it('shows the remote default branch, the task branch, their distance and the pull requests', async () => {
    const empty = await publisher().remoteState(REPO, 'main', BRANCH);
    expect(empty).toMatchObject({ branchCommit: null, ahead: null, behind: null, pullRequests: [] });
    expect(empty.baseCommit).toBe(git(remote, 'rev-parse', 'refs/heads/main'));

    const tip = commit(workspace, 'a.ts', 'a\n');
    commit(workspace, 'b.ts', 'b\n');
    const second = git(workspace, 'rev-parse', 'HEAD');
    await publisher().publish(request(second));
    const state = await publisher().remoteState(REPO, 'main', BRANCH);
    expect(state).toMatchObject({ branchCommit: second, ahead: 2, behind: 0 });
    expect(state.pullRequests.map((pr) => pr.number)).toEqual([100]);
    expect(tip).not.toBe(second);
  });

  it('sees the default branch moving ahead of the task branch', async () => {
    await publisher().publish(request(commit(workspace, 'a.ts', 'a\n')));
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', remote, other);
    // The protection refuses main for the VM identity; the owner's integration is a different identity.
    rmSync(join(remote, 'hooks', 'pre-receive'));
    commit(other, 'main.ts', 'm\n');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const state = await publisher().remoteState(REPO, 'main', BRANCH);
    expect(state).toMatchObject({ ahead: 1, behind: 1 });
  });
});
