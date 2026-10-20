import net from 'node:net';
import { DomainError, newId, unavailable } from '../kernel';
import { ADMINISTRATION_LIMITS } from '../contracts';
import type {
  AdministrationJob,
  AdministrationMachineSnapshot,
  AdministrationPort,
  AdministrationStatus,
  DiagnosticLogEntry,
} from '../contracts';
import { administrationRefusal } from './errors';
import { SOCKET_RESPONSE_MAX_BYTES, SocketParams, SocketResponse, SocketValues } from './schemas';
import type { SocketRequest } from './schemas';
import { AdministrationSetupError, assertSocketFile } from './secure-fs';

/**
 * The client of the supervisor's socket (PM-763): what the hub (for itself) and an engine (for its own
 * machine) use. It refuses a socket that is a link, is not a socket, belongs to someone else or is open to
 * others, sends exactly one request line, accepts exactly one bounded answer and holds the answer to the
 * schema of its method. It never puts a credential on the wire.
 */

/** What each method answers, as the port's types (the schema has checked the shape). */
interface Values {
  status: AdministrationStatus;
  logs: { entries: DiagnosticLogEntry[] };
  machine: AdministrationMachineSnapshot;
  submit: { accepted: boolean };
  inspect: AdministrationJob;
}

export interface SocketClientOptions {
  socketPath: string;
  ioTimeoutMs?: number;
}

function exchange(socketPath: string, line: string, ioTimeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setTimeout(ioTimeoutMs, () =>
      settle(() =>
        reject(unavailable('administration_unavailable', 'the administration supervisor timed out')),
      ),
    );
    socket.once('error', () =>
      settle(() =>
        reject(unavailable('administration_unavailable', 'the administration supervisor is not reachable')),
      ),
    );
    socket.once('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > SOCKET_RESPONSE_MAX_BYTES) {
        settle(() =>
          reject(
            new DomainError('administration_failed', 'the supervisor answer is too large', { status: 502 }),
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    socket.once('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8').trimEnd())));
  });
}

export function createSocketClient(options: SocketClientOptions): AdministrationPort {
  const ioTimeoutMs = options.ioTimeoutMs ?? ADMINISTRATION_LIMITS.ioTimeoutMs;

  async function call<M extends SocketRequest['method']>(method: M, params: unknown): Promise<Values[M]> {
    const checkedParams = SocketParams[method].parse(params);
    try {
      await assertSocketFile(options.socketPath);
    } catch (err) {
      if (err instanceof AdministrationSetupError)
        throw unavailable(
          'administration_unavailable',
          `the administration socket is not usable (${err.reason})`,
        );
      throw err;
    }
    const request: SocketRequest = { version: 1, method, requestId: newId('adm'), params: checkedParams };
    const text = await exchange(options.socketPath, JSON.stringify(request), ioTimeoutMs);
    let parsedResponse: SocketResponse;
    try {
      parsedResponse = SocketResponse.parse(JSON.parse(text));
    } catch {
      throw new DomainError('administration_failed', 'the supervisor answer is malformed', { status: 502 });
    }
    if (parsedResponse.requestId !== request.requestId)
      throw new DomainError('administration_failed', 'the supervisor answered another request', {
        status: 502,
      });
    if (!parsedResponse.ok) throw administrationRefusal(parsedResponse.error.code);
    const value = SocketValues[method].safeParse(parsedResponse.value);
    if (!value.success)
      throw new DomainError('administration_failed', 'the supervisor answer is malformed', { status: 502 });
    return value.data as Values[M];
  }

  return {
    status: (target) => call('status', { target }),
    logs: (target, options) => call('logs', { target, ...options }),
    machine: (target) => call('machine', { target }),
    submit: (input) => call('submit', input),
    inspect: (operationId) => call('inspect', { operationId }),
  };
}
