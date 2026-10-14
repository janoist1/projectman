import { LOCAL_ENGINE_ID } from '@projectman/shared';
import type { EngineId, MemberHandle, Session } from '@projectman/shared';
import type { EngineDirectory, EngineHost } from '../contracts';

/** The engine a session runs on; a session from before engines ran on the local one. */
export function engineIdOf(session: Pick<Session, 'engineId'>): EngineId {
  return session.engineId ?? LOCAL_ENGINE_ID;
}

/**
 * The optional `engineId` of a runner call: absent for the local engine, as a call has always been
 * (the runner reads a missing id as `local`), so the local runner and its tests see no change.
 */
export function engineOption(engineId: EngineId): { engineId?: EngineId } {
  return engineId === LOCAL_ENGINE_ID ? {} : { engineId };
}

/** The directory of a single-machine installation: one engine, `local`, always connected. */
export class LocalEngineDirectory implements EngineDirectory {
  private readonly engine: EngineHost;

  constructor(engine: EngineHost) {
    this.engine = engine;
  }

  get(id: EngineId): EngineHost | null {
    return id === this.engine.id ? this.engine : null;
  }

  ids(): EngineId[] {
    return [this.engine.id];
  }

  engineFor(_projectKey: string, _member: MemberHandle): EngineId | null {
    return this.engine.id;
  }

  /** The one engine never connects or disconnects, so a listener is never called. */
  onChange(_listener: (id: EngineId, online: boolean) => void): () => void {
    return () => {};
  }
}
