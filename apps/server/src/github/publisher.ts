import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkPublishTarget, isPlainBranchName } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import { PublishError } from '../contracts';
import type {
  GithubPublisher,
  PublishRequest,
  PublishResult,
  PullRequestInfo,
  RemoteState,
} from '../contracts';
import { PULL_REQUEST_JSON_FIELDS, parsePullRequestJson, parsePullRequestListJson } from './pull-request';
import { isValidRepo, parsePullRequestUrl } from './refs';

export interface GithubPublisherOptions {
  /** The GitHub CLI used for pull requests (tests pass the fake). */
  ghBin: string;
  gitBin?: string;
  /** The publisher's own directory: bare staging repositories, and the home of its git and gh. */
  stateDir: string;
  /**
   * The publishing identity's token. Read at every call, so a rotation needs no restart; it never
   * leaves this module except in the environment of the git and gh processes started here.
   */
  token: () => Promise<string>;
  host?: string;
  /** Where a repository's git remote lives; default `https://<host>/<repo>.git` (tests: a temp repository). */
  remoteUrl?: (repo: string) => string;
  /** git transports a push may use (default `https`; tests add `file`). */
  pushProtocols?: string;
  commandTimeoutMs?: number;
  /** Extra environment for the processes (tests configure the fake gh with it). */
  env?: Record<string, string>;
  logger: FastifyBaseLogger;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 10_000;
const EXCERPT_CHARS = 400;
const STAGING_REF_PREFIX = 'refs/pm/';
const JSON_FIELDS = `--json=${PULL_REQUEST_JSON_FIELDS.join(',')}`;

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The process could not start or was killed. */
  failed: 'missing' | 'timeout' | null;
}

/**
 * Publishes a task branch under the VM's GitHub identity (PM-142).
 *
 * - The member's workspace is only read (behind the VM boundary not even that: its worker hands the
 *   branch over as a bundle). Its commit is fetched into a bare repository the server
 *   owns, and the push runs from there with a fixed command line and no repository configuration of
 *   the member (no hooks, no config includes, no `pushurl`, no helpers). The push refspec is one
 *   commit to one fully named branch, never forced; the default branch and other protected names
 *   are refused before anything runs.
 * - The token reaches git as one `http.<host>.extraheader` in the process environment and gh as
 *   `GH_TOKEN`; the processes get no other variable of the server (the owner's `GH_TOKEN`,
 *   `GITHUB_TOKEN` and `gh` login never apply). Everything printed or thrown passes through
 *   `redact`.
 * - A pull request is opened once: an open one for the branch is reused.
 */
export function createGithubPublisher(opts: GithubPublisherOptions): GithubPublisher {
  const gitBin = opts.gitBin ?? 'git';
  const host = opts.host ?? 'github.com';
  const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remoteUrl = opts.remoteUrl ?? ((repo: string) => `https://${host}/${repo}.git`);
  const pushProtocols = opts.pushProtocols ?? 'https';
  const home = join(opts.stateDir, 'home');
  const stagingRoot = join(opts.stateDir, 'staging');
  const ghConfigDir = join(opts.stateDir, 'gh');
  const locks = new Map<string, Promise<unknown>>();

  /** Hides the token (also in its encoded form) and anything shaped like a GitHub credential. */
  function redactWith(secrets: readonly string[], text: string): string {
    let out = text;
    for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[redacted]');
    return out
      .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted]')
      .replace(/github_pat_[A-Za-z0-9_]{16,}/g, '[redacted]')
      .replace(/(authorization:\s*(?:basic|bearer|token)\s+)\S+/gi, '$1[redacted]')
      .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@');
  }

  async function secrets(): Promise<{ token: string; list: string[] }> {
    const token = (await opts.token()).trim();
    if (!token) throw new PublishError('remote_failed', 'The publishing identity has no token configured.');
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return { token, list: [token, basic] };
  }

  function baseEnv(): Record<string, string> {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_CONFIG_DIR: ghConfigDir,
      NO_COLOR: '1',
      ...opts.env,
    };
    return env;
  }

  /** Environment of a git process that talks to the remote: the token as an extra header, scoped to the host. */
  function gitRemoteEnv(token: string, url: string, protocols: string): Record<string, string> {
    const env = { ...baseEnv(), GIT_ALLOW_PROTOCOL: protocols };
    if (!url.startsWith('https://')) return env;
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return {
      ...env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
    };
  }

  function run(bin: string, args: readonly string[], env: Record<string, string>): Promise<Outcome> {
    return new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ code: 0, stdout, stderr, failed: null });
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'EACCES')
            return resolve({ code: null, stdout, stderr, failed: 'missing' });
          if (error.killed) return resolve({ code: null, stdout, stderr, failed: 'timeout' });
          resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr, failed: null });
        },
      );
    });
  }

  function excerpt(list: readonly string[], text: string): string {
    return redactWith(list, text.trim()).slice(0, EXCERPT_CHARS);
  }

  /** A failed command as a refusal; `what` names the step, never an argument that could hold a secret. */
  function remoteFailure(what: string, outcome: Outcome, list: readonly string[]): PublishError {
    if (outcome.failed === 'missing')
      return new PublishError('remote_failed', `${what}: the program could not be started.`);
    if (outcome.failed === 'timeout')
      return new PublishError('remote_failed', `${what}: it did not finish within ${timeoutMs} ms.`);
    // `git push --porcelain` reports a rejected ref on stdout.
    const stderr = `${outcome.stderr}\n${outcome.stdout}`;
    if (/non-fast-forward|fetch first|stale info/i.test(stderr))
      return new PublishError(
        'not_fast_forward',
        `${what}: the remote branch has commits yours lacks, and the publisher never forces. ` +
          `Bring them in (fetch, then merge or rebase carefully) and publish the new commit. ${excerpt(list, stderr)}`,
      );
    return new PublishError(
      'remote_failed',
      `${what} failed: ${excerpt(list, stderr) || `exit code ${outcome.code}`}`,
    );
  }

  async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    locks.set(key, tail);
    try {
      return await next;
    } finally {
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  function staging(repo: string): string {
    return join(stagingRoot, `${repo.replace('/', '__')}.git`);
  }

  function ensureStaging(repo: string): Promise<string> {
    return serialized(`staging:${repo}`, async () => {
      const dir = staging(repo);
      if (existsSync(join(dir, 'HEAD'))) return dir;
      mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
      const made = await run(gitBin, ['init', '--bare', '--quiet', dir], baseEnv());
      if (made.code !== 0) throw remoteFailure('creating the staging repository', made, []);
      return dir;
    });
  }

  /**
   * The source must be an ordinary repository: not a linked worktree, and without borrowed objects;
   * or a bundle: a regular file, not a link.
   */
  function assertPlainSource(sourcePath: string, kind: 'repository' | 'bundle'): void {
    if (kind === 'bundle') {
      let file = false;
      try {
        file = lstatSync(sourcePath).isFile();
      } catch {
        file = false;
      }
      if (!file) throw new PublishError('no_task_branch', 'The hand-over of the task branch is not a file.');
      return;
    }
    const dotGit = join(sourcePath, '.git');
    let plain = false;
    try {
      plain = lstatSync(dotGit).isDirectory() && !existsSync(join(dotGit, 'objects', 'info', 'alternates'));
    } catch {
      plain = false;
    }
    if (!plain)
      throw new PublishError(
        'no_task_branch',
        'The workspace is not an independent git repository (a .git directory without alternates).',
      );
  }

  function requireRepo(repo: string): void {
    if (!isValidRepo(repo))
      throw new PublishError('local_only', `"${repo}" is not a GitHub repository name.`);
  }

  async function ghJson(args: readonly string[], list: readonly string[], token: string): Promise<string> {
    const outcome = await run(opts.ghBin, args, { ...baseEnv(), GH_TOKEN: token });
    if (outcome.code !== 0 || outcome.failed)
      throw remoteFailure(`gh ${args.slice(0, 2).join(' ')}`, outcome, list);
    return outcome.stdout;
  }

  async function openPullRequests(
    repo: string,
    branch: string,
    state: 'open' | 'all',
    list: readonly string[],
    token: string,
  ): Promise<PullRequestInfo[]> {
    const stdout = await ghJson(
      ['pr', 'list', `--repo=${repo}`, `--head=${branch}`, `--state=${state}`, '--limit=30', JSON_FIELDS],
      list,
      token,
    );
    try {
      return parsePullRequestListJson(repo, stdout).filter((pr) => pr.headRef === branch);
    } catch (err) {
      throw new PublishError(
        'remote_failed',
        `gh pr list printed something unexpected (${(err as Error).message}).`,
      );
    }
  }

  async function remoteHeads(
    repo: string,
    refs: readonly string[],
    token: string,
    list: readonly string[],
  ): Promise<Map<string, string>> {
    const url = remoteUrl(repo);
    const outcome = await run(
      gitBin,
      ['ls-remote', '--refs', url, ...refs.map((ref) => `refs/heads/${ref}`)],
      gitRemoteEnv(token, url, pushProtocols),
    );
    if (outcome.code !== 0 || outcome.failed)
      throw remoteFailure('reading the remote branches', outcome, list);
    const heads = new Map<string, string>();
    for (const line of outcome.stdout.split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
    }
    return heads;
  }

  async function publish(request: PublishRequest): Promise<PublishResult> {
    requireRepo(request.repo);
    const decision = checkPublishTarget({
      taskKey: request.taskKey,
      github: request.repo,
      defaultBranch: request.baseBranch,
      branch: request.branch,
      commit: request.commit,
    });
    if (!decision.ok) throw new PublishError(decision.code, decision.message);
    if (!isPlainBranchName(request.baseBranch))
      throw new PublishError('invalid_branch', `"${request.baseBranch}" is not a plain branch name.`);
    const sourceKind = request.sourceKind ?? 'repository';
    assertPlainSource(request.sourcePath, sourceKind);
    const { token, list } = await secrets();

    return serialized(`${request.repo}#${request.branch}`, async () => {
      const git = await ensureStaging(request.repo);
      const incoming = `${STAGING_REF_PREFIX}in/${request.commit}`;
      // 1. Take the branch from the member's workspace (or from its worker's bundle of it) into the
      //    server's own repository and check that its tip is exactly the commit the member named.
      const fetched = await run(
        gitBin,
        [
          ...(sourceKind === 'repository'
            ? [
                '-c',
                `safe.directory=${request.sourcePath}`,
                '-c',
                `safe.directory=${join(request.sourcePath, '.git')}`,
              ]
            : []),
          `--git-dir=${git}`,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          request.sourcePath,
          `+refs/heads/${request.branch}:${incoming}`,
        ],
        { ...baseEnv(), GIT_ALLOW_PROTOCOL: 'file' },
      );
      if (fetched.code !== 0 || fetched.failed)
        throw remoteFailure('reading the branch from the workspace', fetched, list);
      try {
        const tip = await run(
          gitBin,
          [`--git-dir=${git}`, 'rev-parse', '--verify', '--quiet', incoming],
          baseEnv(),
        );
        if (tip.code !== 0 || tip.stdout.trim() !== request.commit)
          throw new PublishError(
            'commit_mismatch',
            `The tip of ${request.branch} is ${tip.stdout.trim().slice(0, 12) || 'unknown'}, not ${request.commit.slice(0, 12)}; ` +
              'commit your work and name the commit you mean (git rev-parse HEAD).',
          );

        // 2. Upload it, unless the remote branch already is there.
        const url = remoteUrl(request.repo);
        const heads = await remoteHeads(request.repo, [request.branch], token, list);
        const alreadyPublished = heads.get(request.branch) === request.commit;
        if (!alreadyPublished) {
          const pushed = await run(
            gitBin,
            [
              `--git-dir=${git}`,
              'push',
              '--porcelain',
              '--no-follow-tags',
              '--no-recurse-submodules',
              url,
              decision.refspec,
            ],
            gitRemoteEnv(token, url, pushProtocols),
          );
          if (pushed.code !== 0 || pushed.failed)
            throw remoteFailure('pushing the task branch', pushed, list);
        }

        // 3. The pull request, once: an open one for this branch is reused.
        const title = redactWith(list, request.title.trim()).slice(0, MAX_TITLE_CHARS) || request.taskKey;
        const body = redactWith(list, request.body).slice(0, MAX_BODY_CHARS);
        let pullRequest = (await openPullRequests(request.repo, request.branch, 'open', list, token)).find(
          (pr) => pr.baseRef === request.baseBranch,
        );
        let created = false;
        if (!pullRequest) {
          const made = await run(
            opts.ghBin,
            [
              'pr',
              'create',
              `--repo=${request.repo}`,
              `--head=${request.branch}`,
              `--base=${request.baseBranch}`,
              `--title=${title}`,
              `--body=${body}`,
            ],
            { ...baseEnv(), GH_TOKEN: token },
          );
          if (made.code === 0 && !made.failed) {
            const link = made.stdout.trim().split('\n').pop() ?? '';
            const parsed = parsePullRequestUrl(link);
            if (!parsed || parsed.repo !== request.repo)
              throw new PublishError('remote_failed', 'gh pr create did not print the pull request address.');
            const viewed = await ghJson(
              ['pr', 'view', String(parsed.number), `--repo=${request.repo}`, JSON_FIELDS],
              list,
              token,
            );
            pullRequest = parsePullRequestJson(request.repo, viewed);
            created = true;
          } else {
            // A retry or a second caller may have opened it meanwhile; anything else is a failure.
            pullRequest = (await openPullRequests(request.repo, request.branch, 'open', list, token)).find(
              (pr) => pr.baseRef === request.baseBranch,
            );
            if (!pullRequest) throw remoteFailure('opening the pull request', made, list);
          }
        }
        opts.logger.info(
          {
            taskKey: request.taskKey,
            repo: request.repo,
            branch: request.branch,
            commit: request.commit,
            alreadyPublished,
            pullRequest: pullRequest.number,
            created,
          },
          'github: task branch published',
        );
        return {
          repo: request.repo,
          branch: request.branch,
          commit: request.commit,
          alreadyPublished,
          pullRequest,
          pullRequestCreated: created,
        };
      } finally {
        await run(gitBin, [`--git-dir=${git}`, 'update-ref', '-d', incoming], baseEnv());
      }
    });
  }

  async function remoteState(repo: string, baseBranch: string, branch: string): Promise<RemoteState> {
    requireRepo(repo);
    if (!isPlainBranchName(baseBranch))
      throw new PublishError('invalid_branch', `"${baseBranch}" is not a plain branch name.`);
    if (!isPlainBranchName(branch))
      throw new PublishError('invalid_branch', `"${branch}" is not a plain branch name.`);
    const { token, list } = await secrets();
    const heads = await remoteHeads(repo, [baseBranch, branch], token, list);
    const baseCommit = heads.get(baseBranch) ?? null;
    const branchCommit = heads.get(branch) ?? null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (baseCommit && branchCommit) {
      const git = await ensureStaging(repo);
      const url = remoteUrl(repo);
      const base = `${STAGING_REF_PREFIX}remote/base`;
      const tip = `${STAGING_REF_PREFIX}remote/branch`;
      const fetched = await run(
        gitBin,
        [
          `--git-dir=${git}`,
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          url,
          `+refs/heads/${baseBranch}:${base}`,
          `+refs/heads/${branch}:${tip}`,
        ],
        gitRemoteEnv(token, url, pushProtocols),
      );
      if (fetched.code === 0 && !fetched.failed) {
        const counted = await run(
          gitBin,
          [`--git-dir=${git}`, 'rev-list', '--left-right', '--count', `${base}...${tip}`],
          baseEnv(),
        );
        const [left, right] = counted.stdout.trim().split(/\s+/).map(Number);
        if (counted.code === 0 && Number.isInteger(left) && Number.isInteger(right)) {
          behind = left!;
          ahead = right!;
        }
      }
    }
    const pullRequests = await openPullRequests(repo, branch, 'all', list, token);
    return { repo, baseBranch, baseCommit, branch, branchCommit, ahead, behind, pullRequests };
  }

  return { publish, remoteState };
}
