import { canBindEngine } from '@projectman/shared';
import type { EngineId } from '@projectman/shared';
import type { EngineDirectory } from '../../contracts';
import type { NewProjectEngines } from '../../core/projects';
import { conflict, DomainError, forbidden, invalid } from '../../kernel';
import type { EngineRegistry } from './engine-registry';

/**
 * The engines a new project is created on (PM-1062). The host owner's way without an engine choice is the
 * old one: the folder is checked on the host's engine and nothing is bound. A chosen engine (the host owner's
 * or an owner account's) must be the creator's own, not revoked and online; the folder is checked on it and
 * it becomes the project's default engine.
 */
export function createNewProjectEngines(deps: {
  engines: () => EngineDirectory;
  /** Absent on a single-machine installation: there is only the local engine, bound to nothing. */
  registry?: EngineRegistry;
}): NewProjectEngines {
  const { registry } = deps;
  return {
    chooseForNewProject: (input) => {
      const engineId: EngineId | undefined = input.engineId;
      if (engineId === undefined) {
        if (input.isHostOwner) return null;
        throw invalid('invalid_request', 'choose the engine the project is created on');
      }
      if (!registry) {
        if (input.isHostOwner && engineId === 'local') return null;
        throw new DomainError('engine_not_found', 'Engine not found', { status: 404 });
      }
      const owner = registry.ownerOf(engineId);
      if (owner === null) throw new DomainError('engine_not_found', 'Engine not found', { status: 404 });
      if (!canBindEngine({ actorUserId: input.userId, engineOwnerUserId: owner, actorIsProjectOwner: true }))
        throw forbidden('engine_not_owned', 'Only the engine owner may create a project on it');
      if (!registry.ids().includes(engineId)) throw conflict('engine_revoked', 'Engine revoked');
      if (!registry.isOnline(engineId))
        throw conflict('engine_offline', 'The engine the project would run on is not connected');
      return engineId;
    },
    workspaceState: async (engineId, path) => {
      const directory = deps.engines();
      const id = engineId ?? directory.hostEngine();
      const engine = id ? directory.get(id) : null;
      // The folder can only be checked where it is: no engine to ask is a refusal, not "not a folder" (PM-315).
      if (!engine) throw conflict('engine_offline', 'The engine the project would run on is not connected');
      return engine.workspaceState(path);
    },
    bind: (projectKey, engineId, userId) => {
      registry?.bind(projectKey, engineId, userId, { default: true });
    },
  };
}
