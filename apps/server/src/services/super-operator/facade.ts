import type {
  AdministrationTarget,
  EngineId,
  SuperDiagnosticsRequest,
  SuperDiagnosticsResponse,
  SuperOperateRequest,
  SuperOperationDetail,
} from '@projectman/shared';
import type {
  AdministrationLogsOptions,
  AdministrationMachineSnapshot,
  AdministrationPort,
  AdministrationStatus,
  DiagnosticLogEntry,
  OperatorGrantGate,
} from '../../contracts';
import type { ProjectAccess } from '../../core/members';
import { DomainError, forbidden, integratorExecution, unavailable } from '../../kernel';
import type { SuperHandoffService } from './handoffs';
import type { SuperRights } from './rights';
import type { SuperDiagnostics } from './diagnostics';

/**
 * What the integrator in super mode reads and starts through the protected administration adapter (PM-764):
 * the status and the diagnostic log of the hub or of an engine linked to the project, direct operations, the
 * operation and its recorded result, and the filtered diagnostics. The routes parse and check access; this
 * binds each call to the project and to an engine linked to it, and leaves the work to the services.
 */
export interface SuperAdministration {
  status(projectKey: string, target: AdministrationTarget): Promise<AdministrationStatus>;
  logs(
    projectKey: string,
    target: AdministrationTarget,
    options: AdministrationLogsOptions,
  ): Promise<{ entries: DiagnosticLogEntry[] }>;
  machine(projectKey: string, target: AdministrationTarget): Promise<AdministrationMachineSnapshot>;
  operate(
    projectKey: string,
    input: SuperOperateRequest,
    access: ProjectAccess,
  ): Promise<SuperOperationDetail['operation']>;
  operation(projectKey: string, operationId: string): Promise<SuperOperationDetail>;
  query(projectKey: string, request: SuperDiagnosticsRequest): SuperDiagnosticsResponse;
}

export function createSuperAdministration(deps: {
  handoffs: SuperHandoffService;
  /** Null: this instance has no administration adapter; the reads that need it are `administration_unavailable`. */
  administration: AdministrationPort | null;
  /** The owner's grant for machine operations: the status and log reads need it (PM-881). */
  grants: OperatorGrantGate;
  /** The host-only check of the reads below (PM-1063); the grant is the host's, so no other key passes. */
  rights: Pick<SuperRights, 'assertHost'>;
  diagnostics: SuperDiagnostics;
  engineLinked(projectKey: string, engineId: EngineId): boolean;
}): SuperAdministration {
  // A read outside an integrator scope has no key to prove it is the host's: refused like another owner's.
  const assertHost = (): void => {
    const scope = integratorExecution();
    if (!scope)
      throw forbidden('host_only', 'only the host owner’s key may use the administration of the hub');
    deps.rights.assertHost(scope.principal);
  };
  const adapter = (): AdministrationPort => {
    if (!deps.administration)
      throw unavailable('administration_unavailable', 'this instance has no administration adapter');
    return deps.administration;
  };
  const bind = (projectKey: string, target: AdministrationTarget): AdministrationPort => {
    if (target.kind === 'engine' && !deps.engineLinked(projectKey, target.id))
      throw forbidden('administration_target_mismatch', 'the engine is not linked to this project');
    return adapter();
  };
  return {
    async status(projectKey, target) {
      assertHost();
      const port = bind(projectKey, target);
      deps.grants.assertActive();
      return port.status(target);
    },
    async logs(projectKey, target, options) {
      assertHost();
      const port = bind(projectKey, target);
      deps.grants.assertActive();
      return port.logs(target, options);
    },
    async machine(projectKey, target) {
      assertHost();
      const port = bind(projectKey, target);
      deps.grants.assertActive();
      return port.machine(target);
    },
    operate: (projectKey, input, access) => deps.handoffs.operate(projectKey, input, access),
    async operation(projectKey, operationId) {
      await deps.handoffs.settle(projectKey, operationId);
      const operation = deps.handoffs.operation(projectKey, operationId);
      let result: SuperOperationDetail['result'] = null;
      if (
        deps.administration &&
        operation.command.kind === 'administration' &&
        operation.state !== 'waiting_owner'
      ) {
        // The recorded result is the adapter's; when it cannot be read now, the operation still shows its state.
        const job = await deps.administration.inspect(operation.id).catch((error: unknown) => {
          if (error instanceof DomainError) return null;
          throw error;
        });
        result = job?.result ?? null;
      }
      return { operation, result };
    },
    query: (projectKey, request) => deps.diagnostics.query(projectKey, request),
  };
}
