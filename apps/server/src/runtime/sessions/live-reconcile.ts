import type { EngineId, Session } from '@projectman/shared';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { engineIdOf } from './engines';

export const LIVE_SESSION_SWEEP_GRACE_MS = 2 * 60_000;

interface LiveSessionSweepDeps {
  /** repos.sessions.listInStates(LIVE_SESSION_STATES) */
  listLive(): Session[];
  /** SessionOrchestrator.isRunning: local runner, or the engine mirror in hybrid mode. */
  isRunning(sessionId: string): boolean;
  /** engines.get(engineId) !== null */
  engineConnected(engineId: EngineId): boolean;
  /** markEnded(sessionId, null, null, { kind: 'exited' }) */
  end(sessionId: string): void;
  now(): number;
  logger: Logger;
}

/** Ends ghost sessions only after two consecutive missing rounds on a connected engine. */
export class LiveSessionSweep {
  private readonly deps: LiveSessionSweepDeps;
  private missing = new Set<string>();

  constructor(deps: LiveSessionSweepDeps) {
    this.deps = deps;
  }

  /** One round. A session ends only when it was missing in the previous round too. */
  sweep(): void {
    const now = this.deps.now();
    const missing = new Set<string>();
    for (const session of this.deps.listLive()) {
      const engineId = engineIdOf(session);
      if (
        this.deps.isRunning(session.id) ||
        session.state === 'starting' ||
        !this.deps.engineConnected(engineId) ||
        now - Math.max(Date.parse(session.startedAt), Date.parse(session.lastActivityAt)) <
          LIVE_SESSION_SWEEP_GRACE_MS
      )
        continue;
      if (!this.missing.has(session.id)) {
        missing.add(session.id);
        continue;
      }
      this.deps.end(session.id);
      this.deps.logger.warn(
        { sessionId: session.id, member: session.member, engineId },
        'ending a live session whose process is gone',
      );
    }
    this.missing = missing;
  }
}
