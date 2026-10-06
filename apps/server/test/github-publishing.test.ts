import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '@projectman/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubPublisher,
  ManagedVmBoundary,
  MemberWorkspaceManager,
  PublishRequest,
  ToolContext,
} from '../src/contracts';
import { TeamToolError } from '../src/contracts';
import { aiActor } from '../src/domain';
import { createGithubPublisher } from '../src/github';
import { createFakeGh, createTestLogger } from '../src/github/test-fixtures/harness';
import type { FakeGh } from '../src/github/test-fixtures/harness';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { pullRequest } from './helpers/fakes';

/*
 * PM-142: the publishing gate in the domain, over the real publisher, a temp git remote that
 * refuses the default branch like GitHub's protection, and the fake gh. What is asked here: which
 * branch leaves, who the pull request belongs to afterwards, and what the gate refuses.
 */

const exec = promisify(execFile);
const TOKEN = 'ghp_FAKETOKEN0123456789abcdefghijklmnopqr';
const BOT = 'acme-vm-bot';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  const { stdout } = await exec('git', ['-C', cwd, ...args], { env });
  return stdout.trim();
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

const verified: ManagedVmBoundary = {
  verify: async () => ({
    profile: { name: 'managed-vm', version: 1 },
    verifiedAt: '2026-10-01T12:00:00.000Z',
    providerVersions: { claude: ['2.1.284'], codex: ['0.159.1'], nanogpt: [] },
  }),
};

/** Two AI developers and the reviewer share one bot login; a label anyone sets but its author may not. */
const sharedBot = (c: ProjectConfig) => {
  const member = (handle: string) => c.team.members.find((m) => m.handle === handle)!;
  member('cr').githubLogin = BOT;
  c.pipeline.labels.push({ id: 'peer-ok', name: 'Peer ok', setBy: 'anyone', notByAuthor: true });
};

describe('the publishing gate (PM-142)', { timeout: 90_000 }, () => {
  let h: DomainHarness;
  let dir: string;
  let remote: string;
  let fake: FakeGh;
  let initial: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pm-gate-'));
    fake = await createFakeGh({ identities: { [TOKEN]: { login: BOT, canMerge: false } } });
  });
  afterEach(async () => {
    await h?.cleanup();
    await fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function realPublisher(): GithubPublisher {
    return createGithubPublisher({
      ghBin: fake.bin,
      stateDir: path.join(dir, 'publisher'),
      token: async () => TOKEN,
      remoteUrl: () => remote,
      pushProtocols: 'file',
      env: fake.env,
      logger: createTestLogger(),
    });
  }

  async function managed(
    opts: {
      publisher?: GithubPublisher | null;
      adjust?: (c: ProjectConfig) => void;
      legacy?: boolean;
      wrapMemberWorkspaces?: (inner: MemberWorkspaceManager) => MemberWorkspaceManager;
    } = {},
  ) {
    h = await createDomainHarness({
      memberWorkspaces: !opts.legacy,
      ...(opts.wrapMemberWorkspaces ? { wrapMemberWorkspaces: opts.wrapMemberWorkspaces } : {}),
      persistent: true,
      ...(opts.legacy ? {} : { executionProfile: 'managed_vm', managedVm: verified }),
      adjust: (c) => {
        sharedBot(c);
        opts.adjust?.(c);
      },
      githubPublisher: opts.publisher === null ? undefined : (opts.publisher ?? realPublisher()),
    });
    await git(h.workspace, 'init', '--quiet', '-b', 'main');
    await writeFile(path.join(h.workspace, 'README.md'), 'hello\n');
    await git(h.workspace, 'add', 'README.md');
    await git(h.workspace, 'commit', '--quiet', '-m', 'Initial');
    initial = await git(h.workspace, 'rev-parse', 'HEAD');
    remote = path.join(dir, 'remote.git');
    await git(dir, 'init', '--quiet', '--bare', '-b', 'main', remote);
    await git(h.workspace, 'push', '--quiet', remote, 'main');
    // GitHub's protection of the default branch: the remote refuses it.
    const hook = path.join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "GH006: Protected branch" >&2; exit 1; fi\ndone\n',
    );
    chmodSync(hook, 0o755);
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Logout page' }, OWNER_ACTOR);
  }

  const workspaceOf = async (handle: string) =>
    path.join(await realpath(h.workspacesDir), 'AR', handle, 'web', 'repo');

  /** Starts the developer's session on the task and returns the tool context the MCP server would build. */
  async function work(taskKey: string, handle: string): Promise<ToolContext> {
    await h.domain.taskStarts.start('AR', taskKey, {
      assignee: handle,
      actor: OWNER_ACTOR,
      author: { name: 'Owner', email: 'owner@example.com' },
    });
    const spec = h.runner.lastStarted();
    expect(spec.member).toBe(handle);
    return { sessionId: spec.sessionId, projectKey: 'AR', member: handle, taskKey };
  }

  async function commitIn(handle: string, file: string): Promise<string> {
    const dev = await workspaceOf(handle);
    await writeFile(path.join(dev, file), `${file}\n`);
    await git(dev, 'add', file);
    await git(dev, 'commit', '--quiet', '-m', `Add ${file}`);
    return git(dev, 'rev-parse', 'HEAD');
  }

  const remoteHead = (branch: string) => git(remote, 'rev-parse', `refs/heads/${branch}`);

  it('publishes the member own task branch and opens its pull request, never touching the default branch', async () => {
    await managed();
    const ctx = await work('AR-1', 'dev-1');
    const commit = await commitIn('dev-1', 'login.txt');
    const result = await h.domain.teamTools.publishTaskBranch(ctx, { commit });
    expect(result).toMatchObject({
      repo: 'acme/web',
      branch: 'AR-1-login-page',
      commit,
      alreadyPublished: false,
      pullRequestCreated: true,
      pullRequest: { number: 100, state: 'open', baseRef: 'main' },
    });
    expect(await remoteHead('AR-1-login-page')).toBe(commit);
    expect(await remoteHead('main')).toBe(initial);
    const task = h.domain.tasks.get('AR', 'AR-1');
    expect(task.links).toEqual(
      expect.arrayContaining([
        { kind: 'branch', ref: 'AR-1-login-page', repo: 'acme/web' },
        expect.objectContaining({ kind: 'pull_request', ref: '100', repo: 'acme/web', author: 'dev-1' }),
      ]),
    );
    // The branch link already exists from the start of the session; the pull request link is the new fact.
    expect(
      h.domain.tasks
        .detail('AR', 'AR-1')
        .timeline.filter((e) => e.type === 'task_link_added' && e.actor.handle === 'dev-1')
        .map((e) => e.data),
    ).toEqual([{ kind: 'pull_request', ref: '100', repo: 'acme/web' }]);
  });

  it("publishes from the workspace's hand-over, which behind the VM boundary is its worker's bundle", async () => {
    const handovers: string[] = [];
    const done: string[] = [];
    const requests: PublishRequest[] = [];
    const inner = realPublisher();
    await managed({
      publisher: {
        publish: (request) => {
          requests.push(request);
          return inner.publish(request);
        },
        remoteState: (...args) => inner.remoteState(...args),
      },
      // As the VM's worker access hands it over: a bundle of the branch, never the workspace itself.
      wrapMemberWorkspaces: (manager) => ({
        ...manager,
        async exportBranch(key, branch) {
          const local = await manager.exportBranch(key, branch);
          const bundle = path.join(dir, `handed-${handovers.length}.bundle`);
          await git(local.path, 'bundle', 'create', '--quiet', bundle, `refs/heads/${branch}`);
          handovers.push(`${key.member}:${branch}`);
          return {
            path: bundle,
            bundle: true,
            done: async () => {
              done.push(bundle);
              rmSync(bundle, { force: true });
            },
          };
        },
      }),
    });
    const ctx = await work('AR-1', 'dev-1');
    const commit = await commitIn('dev-1', 'login.txt');
    await h.domain.teamTools.publishTaskBranch(ctx, { commit });
    expect(await remoteHead('AR-1-login-page')).toBe(commit);
    expect(handovers).toEqual(['dev-1:AR-1-login-page']);
    expect(requests.map((r) => [r.sourceKind, r.sourcePath])).toEqual([['bundle', done[0]]]);
    // The hand-over is removed after a refusal too.
    await expect(h.domain.teamTools.publishTaskBranch(ctx, { commit: initial })).rejects.toThrow();
    expect(done).toHaveLength(handovers.length);
  });

  it('is idempotent and adds a later commit to the same pull request', async () => {
    await managed();
    const ctx = await work('AR-1', 'dev-1');
    const first = await h.domain.teamTools.publishTaskBranch(ctx, {
      commit: await commitIn('dev-1', 'a.txt'),
    });
    const again = await h.domain.teamTools.publishTaskBranch(ctx, { commit: first.commit });
    expect(again).toMatchObject({ alreadyPublished: true, pullRequestCreated: false });
    const later = await commitIn('dev-1', 'b.txt');
    const next = await h.domain.teamTools.publishTaskBranch(ctx, { commit: later });
    expect(next).toMatchObject({ alreadyPublished: false, pullRequestCreated: false });
    expect(next.pullRequest.number).toBe(first.pullRequest.number);
    expect(h.domain.tasks.get('AR', 'AR-1').links.filter((l) => l.kind === 'pull_request')).toHaveLength(1);
  });

  it('keeps the true author when two AI members and the reviewer share one bot login', async () => {
    await managed();
    const dev1 = await work('AR-1', 'dev-1');
    const dev2 = await work('AR-2', 'dev-2');
    const a = await h.domain.teamTools.publishTaskBranch(dev1, {
      commit: await commitIn('dev-1', 'login.txt'),
    });
    const b = await h.domain.teamTools.publishTaskBranch(dev2, {
      commit: await commitIn('dev-2', 'logout.txt'),
    });
    expect([a.pullRequest.number, b.pullRequest.number]).toEqual([100, 101]);
    const author = (key: string) =>
      h.domain.tasks.get('AR', key).links.find((l) => l.kind === 'pull_request')!.author;
    expect(author('AR-1')).toBe('dev-1');
    expect(author('AR-2')).toBe('dev-2');

    // Polling sees the bot's login, which the configuration maps to the reviewer `cr` (the first match):
    // that must not rewrite who authored the pull request.
    await h.domain.githubSync.handleChange(
      pullRequest({ number: 100, headRef: 'AR-1-login-page', authorLogin: BOT, title: 'polled' }),
    );
    await h.domain.githubSync.handleChange(
      pullRequest({ number: 101, headRef: 'AR-2-logout-page', authorLogin: BOT }),
    );
    expect(author('AR-1')).toBe('dev-1');
    expect(author('AR-2')).toBe('dev-2');
    // Neither does linking the pull request again from another session.
    await h.domain.teamTools.linkPullRequest(
      { sessionId: 'x', projectKey: 'AR', member: 'cr', taskKey: 'AR-1' },
      { taskKey: 'AR-1', repo: 'acme/web', number: 100 },
    );
    expect(author('AR-1')).toBe('dev-1');
  });

  it('keeps no-self-review for the publisher after the task is reassigned', async () => {
    await managed();
    const ctx = await work('AR-1', 'dev-1');
    await h.domain.teamTools.publishTaskBranch(ctx, { commit: await commitIn('dev-1', 'login.txt') });
    h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
    await h.domain.githubSync.handleChange(
      pullRequest({ number: 100, headRef: 'AR-1-login-page', authorLogin: BOT }),
    );
    await expect(
      h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['peer-ok'] }, aiActor('dev-1')),
    ).rejects.toMatchObject({ code: 'self_review_forbidden' });
    // The reviewer who happens to share the bot login is not the author, so the rule lets them review.
    expect(
      (await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['peer-ok'] }, aiActor('cr'))).labels,
    ).toContain('peer-ok');
  });

  it('keeps the login-based attribution of a pull request that was not published here', async () => {
    await managed();
    h.domain.tasks.addLink('AR', 'AR-2', { kind: 'pull_request', repo: 'acme/web', ref: '9' }, OWNER_ACTOR);
    await h.domain.githubSync.handleChange(pullRequest({ number: 9, authorLogin: BOT }));
    expect(h.domain.tasks.get('AR', 'AR-2').links[0]!.author).toBe('cr');
  });

  describe('what the gate refuses', () => {
    const refused = async (promise: Promise<unknown>, code: string, text: RegExp) => {
      const err = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TeamToolError);
      expect((err as TeamToolError).code).toBe(code);
      expect((err as TeamToolError).message).toMatch(text);
    };

    it('another task than the session works on', async () => {
      await managed();
      const ctx = await work('AR-1', 'dev-1');
      const commit = await commitIn('dev-1', 'login.txt');
      await refused(
        h.domain.teamTools.publishTaskBranch(ctx, { taskKey: 'AR-2', commit }),
        'forbidden',
        /only the task your session works on/,
      );
      expect(await git(remote, 'for-each-ref', 'refs/heads/')).not.toContain('AR-');
    });

    it('a member without a work branch of the task, such as the reviewer', async () => {
      await managed();
      await work('AR-1', 'dev-1');
      const commit = await commitIn('dev-1', 'login.txt');
      await refused(
        h.domain.teamTools.publishTaskBranch(
          { sessionId: 'cr-session', projectKey: 'AR', member: 'cr', taskKey: 'AR-1' },
          { commit },
        ),
        'forbidden',
        /managed VM profile/,
      );
    });

    it('a branch the server did not record for the member: the default branch is never reachable', async () => {
      await managed();
      const ctx = await work('AR-1', 'dev-1');
      const commit = await commitIn('dev-1', 'login.txt');
      for (const branch of ['main', 'AR-2-logout-page', 'refs/heads/main']) {
        const [binding] = h.repos.memberWorkspaces.bindingsOfTask('AR', 'AR-1');
        h.repos.memberWorkspaces.saveBinding({ ...binding!, branch });
        await expect(h.domain.teamTools.publishTaskBranch(ctx, { commit })).rejects.toBeInstanceOf(
          TeamToolError,
        );
      }
      expect(await remoteHead('main')).toBe(initial);
      expect(await git(remote, 'for-each-ref', 'refs/heads/')).not.toContain('AR-');
    });

    it('a local-only repository, and a task without a repository', async () => {
      await managed({
        adjust: (c) => {
          delete c.project.repos[0]!.github;
        },
      });
      const ctx = await work('AR-1', 'dev-1');
      const commit = await commitIn('dev-1', 'login.txt');
      await refused(h.domain.teamTools.publishTaskBranch(ctx, { commit }), 'invalid', /no GitHub repository/);
      expect(await git(remote, 'for-each-ref', 'refs/heads/')).not.toContain('AR-');
    });

    it('a commit that is not the branch tip, and one that is not a full id', async () => {
      await managed();
      const ctx = await work('AR-1', 'dev-1');
      const older = await commitIn('dev-1', 'a.txt');
      await commitIn('dev-1', 'b.txt');
      await refused(
        h.domain.teamTools.publishTaskBranch(ctx, { commit: older }),
        'invalid',
        /not [0-9a-f]{12}/,
      );
      await refused(
        h.domain.teamTools.publishTaskBranch(ctx, { commit: older.slice(0, 10) }),
        'invalid',
        /40-character/,
      );
    });

    it('an installation without a publishing identity', async () => {
      await managed({ publisher: null });
      const ctx = await work('AR-1', 'dev-1');
      await refused(
        h.domain.teamTools.publishTaskBranch(ctx, { commit: await commitIn('dev-1', 'login.txt') }),
        'forbidden',
        /no GitHub publishing identity/,
      );
    });

    it('a session of the legacy profile, where agents do not push', async () => {
      await managed({ legacy: true, publisher: realPublisher() });
      await h.domain.taskStarts.start('AR', 'AR-1', {
        assignee: 'dev-1',
        actor: OWNER_ACTOR,
        author: { name: 'Owner', email: 'owner@example.com' },
      });
      const spec = h.runner.lastStarted();
      await refused(
        h.domain.teamTools.publishTaskBranch(
          { sessionId: spec.sessionId, projectKey: 'AR', member: 'dev-1', taskKey: 'AR-1' },
          { commit: initial },
        ),
        'forbidden',
        /managed VM profile/,
      );
    });
  });

  describe('the remote state for the integrator and the review station', () => {
    it('shows heads, distance, pull requests and the publisher, read through the server', async () => {
      await managed();
      const ctx = await work('AR-1', 'dev-1');
      const commit = await commitIn('dev-1', 'login.txt');
      await h.domain.teamTools.publishTaskBranch(ctx, { commit });
      const state = await h.domain.teamTools.getRemoteState(
        { sessionId: 'cr-session', projectKey: 'AR', member: 'cr', taskKey: 'AR-1' },
        { taskKey: 'AR-1' },
      );
      expect(state).toMatchObject({
        taskKey: 'AR-1',
        repo: 'acme/web',
        baseCommit: initial,
        branch: 'AR-1-login-page',
        branchCommit: commit,
        ahead: 1,
        behind: 0,
        publishedBy: 'dev-1',
      });
      expect(state.pullRequests.map((pr) => pr.number)).toEqual([100]);
    });

    it('says plainly when nothing was published yet', async () => {
      await managed();
      await work('AR-1', 'dev-1');
      const state = await h.domain.teamTools.getRemoteState(
        { sessionId: 'cr-session', projectKey: 'AR', member: 'cr', taskKey: 'AR-1' },
        { taskKey: 'AR-1' },
      );
      expect(state).toMatchObject({ branchCommit: null, publishedBy: null, pullRequests: [] });
    });
  });
});
