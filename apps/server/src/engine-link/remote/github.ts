import type { FastifyBaseLogger } from 'fastify';
import type { GithubService, PullRequestInfo } from '../../contracts';
import { GithubError, parsePullRequestUrl } from '../../github';
import type { GithubErrorCode } from '../../github';
import { EngineCallError } from '../rpc';
import type { RemoteHub } from './hub';

/**
 * GitHub in cloud mode (PM-315): `gh` and its login are on the engine, so every call goes to the default
 * engine (`github.*`). A failure keeps its `GithubError` code; one that comes from the link, not from gh,
 * is `unreachable` (a temporary failure, as when GitHub itself cannot be reached). Watches live on the
 * engine, which polls, and report every change as a `github_changed` event; the cloud keeps what it wants
 * watched and sends it again at every connect, because an engine that restarted has none.
 */

const GITHUB_ERROR_CODES: ReadonlySet<string> = new Set<GithubErrorCode>([
  'invalid_argument',
  'not_installed',
  'not_authenticated',
  'rate_limited',
  'not_found',
  'timeout',
  'unreachable',
  'server_error',
  'invalid_response',
  'aborted',
  'failed',
]);

function toGithubError(error: unknown): unknown {
  if (!(error instanceof EngineCallError)) return error;
  if (error.linkCode === 'module_error' && GITHUB_ERROR_CODES.has(error.code))
    return new GithubError(error.code as GithubErrorCode, error.message);
  return new GithubError('unreachable', `The engine could not run gh: ${error.code}`);
}

interface Watch {
  targets: Array<{ repo: string; number: number }>;
  onChange: (pr: PullRequestInfo) => void;
}

export function createRemoteGithub(options: { hub: RemoteHub; logger: FastifyBaseLogger }): GithubService {
  const { hub, logger } = options;
  const watches = new Map<string, Watch>();
  let counter = 0;

  const engine = (): string => {
    const id = hub.defaultId();
    if (id === null || !hub.available(id))
      throw new GithubError('unreachable', 'There is no engine to run gh');
    return id;
  };
  const sendWatch = (watchId: string, watch: Watch) => {
    const id = hub.defaultId();
    if (id === null || !hub.link(id)) return;
    hub.call(id, 'github.watch', { watchId, targets: watch.targets }).catch((err: unknown) => {
      logger.warn({ err, engineId: id, watchId }, 'the engine did not take a pull request watch');
    });
  };

  hub.onConnect(({ id }) => {
    if (id !== hub.defaultId()) return;
    for (const [watchId, watch] of watches) sendWatch(watchId, watch);
  });
  hub.onEvent((id, event) => {
    if (event.kind !== 'github_changed' || id !== hub.defaultId()) return;
    const watch = watches.get(event.watchId);
    if (!watch) return;
    try {
      watch.onChange(event.change);
    } catch (err) {
      logger.warn({ err, watchId: event.watchId }, 'a pull request watcher failed');
    }
  });

  async function call<T>(run: (id: string) => Promise<T>): Promise<T> {
    try {
      return await run(engine());
    } catch (error) {
      throw toGithubError(error);
    }
  }

  return {
    async isAvailable() {
      const id = hub.defaultId();
      if (id === null || !hub.available(id)) return false;
      try {
        return await hub.call(id, 'github.is_available', {});
      } catch {
        return false;
      }
    },
    getPullRequest: (repo, number) => call((id) => hub.call(id, 'github.get_pull_request', { repo, number })),
    findPullRequestsForBranch: (repo, branch) =>
      call((id) => hub.call(id, 'github.find_pull_requests_for_branch', { repo, branch })),
    parsePullRequestUrl,
    watch(targets, onChange) {
      counter += 1;
      const watchId = `w${counter}`;
      const watch: Watch = { targets: targets.map(({ repo, number }) => ({ repo, number })), onChange };
      watches.set(watchId, watch);
      sendWatch(watchId, watch);
      return () => {
        if (!watches.delete(watchId)) return;
        const id = hub.defaultId();
        if (id === null || !hub.link(id)) return;
        hub.call(id, 'github.unwatch', { watchId }).catch((err: unknown) => {
          logger.warn({ err, engineId: id, watchId }, 'the engine did not drop a pull request watch');
        });
      };
    },
  };
}
