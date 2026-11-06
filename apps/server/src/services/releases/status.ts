import type { EngineView } from '@projectman/shared';
import type { ReleaseStatus } from '../../contracts';

/**
 * `get_release_status` (PM-1201): the version the hub runs and each engine's view of it. `versionMismatch` is the
 * value the engine registry computes against the same hub version, so the tool and the settings view agree. A
 * revoked engine is no engine of the release.
 */
export function releaseStatusOf(hubVersion: string, engines: readonly EngineView[]): ReleaseStatus {
  return {
    hub: { version: hubVersion },
    engines: engines
      .filter((engine) => !engine.revokedAt)
      .map((engine) => ({
        id: engine.id,
        name: engine.name,
        connected: engine.online,
        version: engine.version,
        versionMismatch: engine.versionMismatch,
        lastSeenAt: engine.lastSeenAt,
      })),
  };
}
