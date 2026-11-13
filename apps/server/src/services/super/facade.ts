import type {
  SuperDiagnosticsRequest,
  SuperDiagnosticsResponse,
  SuperOperateRequest,
  SuperOperationDetail,
} from '@projectman/shared';
import type { ProjectAccess } from '../../core/members';
import type { SuperHandoffService } from './handoffs';
import type { SuperDiagnostics } from './diagnostics';

/** Direct operations and filtered project diagnostics for the connected integrator. */
export interface SuperOperations {
  operate(
    projectKey: string,
    input: SuperOperateRequest,
    access: ProjectAccess,
  ): Promise<SuperOperationDetail['operation']>;
  operation(projectKey: string, operationId: string): Promise<SuperOperationDetail>;
  query(projectKey: string, request: SuperDiagnosticsRequest): SuperDiagnosticsResponse;
}

export function createSuperOperations(deps: {
  handoffs: SuperHandoffService;
  diagnostics: SuperDiagnostics;
}): SuperOperations {
  return {
    operate: (projectKey, input, access) => deps.handoffs.operate(projectKey, input, access),
    async operation(projectKey, operationId) {
      const historical = deps.handoffs.operation(projectKey, operationId);
      if (historical.command.kind !== 'administration') await deps.handoffs.settle(projectKey, operationId);
      return { operation: deps.handoffs.operation(projectKey, operationId), result: null };
    },
    query: (projectKey, request) => deps.diagnostics.query(projectKey, request),
  };
}
