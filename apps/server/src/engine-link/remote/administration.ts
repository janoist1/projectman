import type { EngineId } from '@projectman/shared';
import { administrationRefusal, isErrorCode } from '../../administration';
import type { EngineAdministration } from '../../administration';
import { ADMINISTRATION_LIMITS } from '../../contracts';
import type { AdministrationCapability, AdministrationPort } from '../../contracts';
import { unavailable } from '../../kernel';
import { EngineCallError } from '../rpc';
import type { RemoteHub } from './hub';

/**
 * The hub's way to an engine machine's administration supervisor (PM-763): the four `admin.*` methods over the
 * engine's link. The call is made only when the engine announced the capability in its `hello`; an engine that
 * is older, has no supervisor or is not connected is `administration_unavailable`, never reached some other
 * way. A refusal the engine's supervisor gave comes back with the same code.
 */

const CALL_TIMEOUT_MS = ADMINISTRATION_LIMITS.ioTimeoutMs + 5_000;

export function createRemoteAdministration(options: { hub: RemoteHub }): EngineAdministration {
  const { hub } = options;

  const advertised = (id: EngineId, capability: AdministrationCapability) => {
    if (!hub.link(id) || !hub.available(id))
      throw unavailable('administration_unavailable', 'the engine is not connected');
    const capabilities = hub.mirror(id).hello?.administration;
    if (!capabilities?.includes(capability))
      throw unavailable('administration_unavailable', 'the engine has no administration supervisor for this');
  };

  /** A failed call as the domain error the supervisor's own answer would have been. */
  const refusal = (error: unknown): never => {
    if (error instanceof EngineCallError) {
      if (error.linkCode === 'module_error' && isErrorCode(error.code))
        throw administrationRefusal(error.code, error.message);
      if (
        error.linkCode === 'unknown_method' ||
        error.linkCode === 'link_down' ||
        error.linkCode === 'timeout'
      )
        throw unavailable('administration_unavailable', 'the engine did not take the administration call');
      throw administrationRefusal('administration_failed', 'the engine failed the administration call');
    }
    throw error;
  };

  function port(id: EngineId): AdministrationPort {
    return {
      async status(target) {
        advertised(id, 'status');
        try {
          return await hub.call(id, 'admin.status', { target }, { timeoutMs: CALL_TIMEOUT_MS });
        } catch (error) {
          return refusal(error);
        }
      },
      async logs(target, options) {
        advertised(id, 'logs');
        // The filters are an addition: an engine that predates them would refuse the extra keys, so they go
        // only to an engine that announced `machine` (shipped with them), and the service log only to one that
        // announced `service_logs`.
        const params: Record<string, unknown> = { target, limit: options.limit };
        for (const key of ['source', 'minLevel', 'since', 'contains'] as const)
          if (options[key] !== undefined) params[key] = options[key];
        if (Object.keys(params).length > 2) advertised(id, 'machine');
        if (options.source === 'service') advertised(id, 'service_logs');
        try {
          return await hub.call(id, 'admin.logs', params as never, { timeoutMs: CALL_TIMEOUT_MS });
        } catch (error) {
          return refusal(error);
        }
      },
      async machine(target) {
        advertised(id, 'machine');
        try {
          return await hub.call(id, 'admin.machine', { target }, { timeoutMs: CALL_TIMEOUT_MS });
        } catch (error) {
          return refusal(error);
        }
      },
      async submit(input) {
        // A process cleanup rides on the machine capability; the other commands are their own capability.
        advertised(id, input.command.kind === 'process_cleanup' ? 'machine' : input.command.kind);
        try {
          return await hub.call(id, 'admin.submit', input, { timeoutMs: CALL_TIMEOUT_MS });
        } catch (error) {
          return refusal(error);
        }
      },
      async inspect(operationId) {
        advertised(id, 'status');
        try {
          return await hub.call(id, 'admin.inspect', { operationId }, { timeoutMs: CALL_TIMEOUT_MS });
        } catch (error) {
          return refusal(error);
        }
      },
    };
  }

  return { port, ids: () => hub.ids() };
}
