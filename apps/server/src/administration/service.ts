import type { EngineId } from '@projectman/shared';
import { DomainError, conflict, notFound, unavailable } from '../kernel';
import type {
  AdministrationFence,
  AdministrationJob,
  AdministrationPort,
  AdministrationSubmit,
  AdministrationTarget,
} from '../contracts';

/**
 * The hub's administration service (PM-763): the one `AdministrationPort` the rest of the server (PM-764) uses.
 * It routes each call to the supervisor of exactly the target the call names (the hub's own socket, or an
 * engine over its link), keeps a restart out of an open release fence, and holds a restart of an engine to
 * the engine registry's own report. It never builds a program, path or argument and has no fallback: a target
 * without a usable supervisor is `administration_unavailable`.
 */

export interface EngineAdministration {
  /** The supervisor port of one engine's machine, over that engine's link. */
  port(id: EngineId): AdministrationPort;
  /** Engines that may have an operation (every id the registry knows). */
  ids(): EngineId[];
}

interface AdministrationServiceOptions {
  /** The hub's own supervisor over its Unix socket; null where the hub has none installed. */
  hub: AdministrationPort | null;
  engines: EngineAdministration;
  /** The engine registry's report: true once the engine's link is up and reconciled. */
  isEngineOnline(id: EngineId): boolean;
  /** The release deployment fence (PM-752), if one is up. */
  fence: AdministrationFence;
  /** The one engine that runs a full test or builds an image; null: none is set up. */
  builderEngine(): EngineId | null;
}

type AdministrationService = AdministrationPort;

const isNotFound = (error: unknown) => error instanceof DomainError && error.code === 'not_found';

export function createAdministrationService(options: AdministrationServiceOptions): AdministrationService {
  const hubPort = (): AdministrationPort => {
    if (!options.hub)
      throw unavailable('administration_unavailable', 'the hub has no administration supervisor');
    return options.hub;
  };
  const portFor = (target: AdministrationTarget): AdministrationPort =>
    target.kind === 'hub' ? hubPort() : options.engines.port(target.id);

  /** Where a submitted command runs. */
  function targetOf(input: AdministrationSubmit): AdministrationTarget {
    const { command } = input;
    if (command.kind === 'restart' || command.kind === 'process_cleanup' || command.kind === 'owner_command')
      return command.target;
    if (command.kind === 'deploy') return { kind: 'hub' };
    const id = options.builderEngine();
    if (!id) throw unavailable('administration_unavailable', 'no engine is set up to run this operation');
    return { kind: 'engine', id };
  }

  /** A restart job is done only when the registry agrees: an engine that is not back online is still restarting. */
  function withRegistry(job: AdministrationJob, engineId: EngineId | null): AdministrationJob {
    if (
      engineId &&
      job.state === 'succeeded' &&
      job.result?.kind === 'restart' &&
      !options.isEngineOnline(engineId)
    )
      return { ...job, state: 'running', result: null };
    return job;
  }

  return {
    async status(target) {
      return portFor(target).status(target);
    },
    async logs(target, params) {
      return portFor(target).logs(target, params);
    },
    async machine(target) {
      return portFor(target).machine(target);
    },

    async submit(input) {
      const { command } = input;
      const target = targetOf(input);
      if (command.kind === 'restart') {
        const fence = options.fence();
        if (fence)
          throw conflict(
            'release_pause_conflict',
            'a release deployment holds the instance; the restart waits',
            {
              releaseId: fence.releaseId,
            },
          );
      }
      return portFor(target).submit(input);
    },

    async inspect(operationId) {
      // The supervisor that holds an operation is not recorded here (the hub itself may be what restarted):
      // ask the hub's, then each engine's. An unknown id is `not_found`, an unreachable one is not hidden.
      let unreachable: unknown = null;
      const attempts: Array<{ engineId: EngineId | null; port: () => AdministrationPort }> = [
        { engineId: null, port: hubPort },
        ...options.engines.ids().map((id) => ({ engineId: id, port: () => options.engines.port(id) })),
      ];
      for (const attempt of attempts) {
        try {
          return withRegistry(await attempt.port().inspect(operationId), attempt.engineId);
        } catch (error) {
          if (isNotFound(error)) continue;
          if (error instanceof DomainError && error.code === 'administration_unavailable') {
            unreachable ??= error;
            continue;
          }
          throw error;
        }
      }
      if (unreachable) throw unreachable;
      throw notFound('Administration operation', operationId);
    },
  };
}
