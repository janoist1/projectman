import type { FastifyBaseLogger } from 'fastify';
import type { DependencyGate, MemberWorkspaceKey, WorkspaceDependenciesResult } from '../contracts';

/** The refusal of a command while the installer works (PM-743); the agent reads it. */
function pendingMessage(startedAt: unknown): string {
  return `Dependencies are being prepared after a lockfile change (since ${String(startedAt)}). Commands wait until they are ready; file and team tools still work. Run the command again in about a minute.`;
}

/** The one refusal after a failed preparation; later commands run with the dependencies as they are. */
function failedMessage(reason: unknown, key: unknown): string {
  return `Preparing dependencies failed (${String(reason)}${typeof key === 'string' && key ? `, key ${key}` : ''}). Commands now run with the dependencies as they are; this is reported once. Mention it on the card if it blocks your work.`;
}

/** The clone's identifier in logs and in the report of failures: `<project>/<member>/<repo>`. */
function cloneOf(key: MemberWorkspaceKey): string {
  return `${key.project.project.key}/${key.member}/${key.repoName}`;
}

/**
 * Before a command tool runs in a member clone, makes sure the clone's dependencies are ready
 * (PM-743): `undefined` lets the call run, `{ refuse }` holds it back. A pending preparation
 * refuses every call; a failed one only the first, then the commands run with what is there.
 */
export function createDependencyGate(deps: {
  prepare(key: MemberWorkspaceKey, opts: { waitMs: number }): Promise<WorkspaceDependenciesResult>;
  waitMs: number;
  logger: FastifyBaseLogger;
}): (key: MemberWorkspaceKey) => Promise<void | DependencyGate> {
  /** Failures already reported: clone \0 install key \0 reason. */
  const reported = new Set<string>();
  const forget = (clone: string) => {
    for (const entry of reported) if (entry.startsWith(`${clone}\0`)) reported.delete(entry);
  };
  return async (key) => {
    const clone = cloneOf(key);
    try {
      await deps.prepare(key, { waitMs: deps.waitMs });
      forget(clone);
      return undefined;
    } catch (err) {
      const failure = err as { code?: unknown; details?: Record<string, unknown> } | null;
      const details = failure?.details ?? {};
      if (failure?.code === 'workspace_dependencies_pending')
        return { refuse: pendingMessage(details.startedAt) };
      if (failure?.code === 'workspace_dependencies_failed') {
        const note = `${clone}\0${typeof details.key === 'string' ? details.key : '-'}\0${String(details.reason)}`;
        // Check and write without awaiting between them: of parallel calls exactly one is refused.
        if (!reported.has(note)) {
          reported.add(note);
          return { refuse: failedMessage(details.reason, details.key) };
        }
        deps.logger.info({ clone, reason: details.reason }, 'dependencies failed again; the command runs');
        return undefined;
      }
      deps.logger.warn({ err, clone }, 'preparing dependencies for a command failed');
      return undefined;
    }
  };
}
