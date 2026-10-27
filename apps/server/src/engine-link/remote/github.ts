import type { FastifyBaseLogger } from 'fastify';
import type { EngineDirectory, GithubService, PullRequestInfo } from '../../contracts';
import { GithubError } from '../../contracts';
import { parsePullRequestUrl } from '@projectman/shared';
import type { GithubErrorCode } from '../../contracts';
import { EngineCallError } from '../rpc';
import type { RemoteHub } from './hub';

/**
 * GitHub in cloud mode (PM-315): `gh` and its login are on the engine, so every call goes to the engine of
 * the project it is about (`github.*`, PM-1059). A failure keeps its `GithubError` code; one that comes from
 * the link, not from gh, is `unreachable` (a temporary failure, as when GitHub itself cannot be reached).
 * Watches live on the engine, which polls, and report every change as a `github_changed` event; the cloud
 * keeps what it wants watched and sends it again when that engine connects, because an engine that restarted
 * has none. A watch stays with the engine it was sent to: when that engine is away it is not moved to another.
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
  projectKey: string;
  targets: Array<{ repo: string; number: number }>;
  onChange: (pr: PullRequestInfo) => void;
  /** The engine that was sent this watch; null until one has been. Unsubscribing and events go by it. */
  subscribedEngineId: string | null;
}

export function createRemoteGithub(options: {
  hub: RemoteHub;
  directory: Pick<EngineDirectory, 'projectEngine'>;
  logger: FastifyBaseLogger;
}): GithubService {
  const { hub, directory, logger } = options;
  const watches = new Map<string, Watch>();
  let counter = 0;

  const engine = (projectKey: string): string => {
    const id = directory.projectEngine(projectKey);
    if (id === null || !hub.available(id))
      throw new GithubError('unreachable', 'There is no engine to run gh');
    return id;
  };
  const sendWatch = (watchId: string, watch: Watch) => {
    const id = directory.projectEngine(watch.projectKey);
    if (id === null || !hub.link(id)) return;
    watch.subscribedEngineId = id;
    hub.call(id, 'github.watch', { watchId, targets: watch.targets }).catch((err: unknown) => {
      logger.warn({ err, engineId: id, watchId }, 'the engine did not take a pull request watch');
    });
  };

  const dropWatch = (watchId: string, watch: Watch) => {
    const id = watch.subscribedEngineId;
    watch.subscribedEngineId = null;
    if (id === null || !hub.link(id)) return;
    hub.call(id, 'github.unwatch', { watchId }).catch((err: unknown) => {
      logger.warn({ err, engineId: id, watchId }, 'the engine did not drop a pull request watch');
    });
  };

  hub.onConnect(({ id }) => {
    for (const [watchId, watch] of watches) {
      if (directory.projectEngine(watch.projectKey) === id) sendWatch(watchId, watch);
    }
  });
  // A new choice of the project's engine (PM-1060) moves its watches: off the old engine, onto the new one.
  // Without an online new engine the watch stays here and is sent when one connects.
  hub.onProjectEngineChange((projectKey) => {
    for (const [watchId, watch] of watches) {
      if (watch.projectKey !== projectKey || watch.subscribedEngineId === directory.projectEngine(projectKey))
        continue;
      dropWatch(watchId, watch);
      sendWatch(watchId, watch);
    }
  });
  hub.onEvent((id, event) => {
    if (event.kind !== 'github_changed') return;
    const watch = watches.get(event.watchId);
    // Only the engine that holds the watch, and only while it is still the project's engine, may report on it.
    if (!watch || watch.subscribedEngineId !== id || directory.projectEngine(watch.projectKey) !== id) return;
    try {
      watch.onChange(event.change);
    } catch (err) {
      logger.warn({ err, watchId: event.watchId }, 'a pull request watcher failed');
    }
  });

  async function call<T>(projectKey: string, run: (id: string) => Promise<T>): Promise<T> {
    try {
      return await run(engine(projectKey));
    } catch (error) {
      throw toGithubError(error);
    }
  }

  return {
    async isAvailable(projectKey) {
      const id = directory.projectEngine(projectKey);
      if (id === null || !hub.available(id)) return false;
      try {
        return await hub.call(id, 'github.is_available', {});
      } catch {
        return false;
      }
    },
    getPullRequest: (projectKey, repo, number) =>
      call(projectKey, (id) => hub.call(id, 'github.get_pull_request', { repo, number })),
    findPullRequestsForBranch: (projectKey, repo, branch) =>
      call(projectKey, (id) => hub.call(id, 'github.find_pull_requests_for_branch', { repo, branch })),
    parsePullRequestUrl,
    publishRelease: (projectKey, repo, input) =>
      call(projectKey, async (id) => {
        try {
          return await hub.call(id, 'github.publish_release', { repo, ...input });
        } catch (error) {
          // An engine from before `publish_release` (PM-968) does not know the method.
          if (error instanceof EngineCallError && error.linkCode === 'unknown_method')
            throw new GithubError(
              'failed',
              'the engine does not support release publishing; update the engine',
            );
          throw error;
        }
      }),
    watch(projectKey, targets, onChange) {
      counter += 1;
      const watchId = `w${counter}`;
      const watch: Watch = {
        projectKey,
        targets: targets.map(({ repo, number }) => ({ repo, number })),
        onChange,
        subscribedEngineId: null,
      };
      watches.set(watchId, watch);
      sendWatch(watchId, watch);
      return () => {
        if (watches.delete(watchId)) dropWatch(watchId, watch);
      };
    },
  };
}
