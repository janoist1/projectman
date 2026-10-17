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
      async logs(target, { limit }) {
        advertised(id, 'logs');
        try {
          return await hub.call(id, 'admin.logs', { target, limit }, { timeoutMs: CALL_TIMEOUT_MS });
        } catch (error) {
          return refusal(error);
        }
      },
      async submit(input) {
        advertised(id, input.command.kind);
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
