import { MAX_CONTROL_REQUEST_BYTES, parseControlRequestInput } from '@projectman/shared';
import { ControlTransportError, sendControlRequest } from './client';

/** Exit status of the relay: done, the transport failed, the input was refused, bad usage. */
export const RELAY_EXIT = { done: 0, transport: 1, refused: 2, usage: 64 } as const;

export interface RelayIo {
  /** The standard input, in chunks, until EOF. */
  stdin: AsyncIterable<Uint8Array>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Reads the whole input, but never more than one byte over the limit: that byte is enough to refuse it. */
async function readInput(stdin: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_CONTROL_REQUEST_BYTES) break;
  }
  return Buffer.concat(chunks);
}

/**
 * The fixed side of the admin channel (PM-749): one request line on the standard input, one `ControlResponse`
 * line on the standard output, relayed to the control socket of the argument. The input is data only: it is
 * parsed as a `ControlRequest` and never reaches a shell, a path or a process. The request is sent once.
 */
export async function runControlRelay(argv: readonly string[], io: RelayIo): Promise<number> {
  const socketPath = argv[0];
  if (argv.length !== 1 || !socketPath) {
    io.stderr('usage: control/cli.js <socket path>\n');
    return RELAY_EXIT.usage;
  }
  const input = parseControlRequestInput(await readInput(io.stdin));
  if (!input.ok) {
    io.stderr(`refused: ${input.reason}\n`);
    return RELAY_EXIT.refused;
  }
  try {
    io.stdout(`${JSON.stringify(await sendControlRequest(socketPath, input.request))}\n`);
    return RELAY_EXIT.done;
  } catch (error) {
    if (!(error instanceof ControlTransportError)) throw error;
    io.stderr(`control transport failed (${error.failure}): ${error.message}\n`);
    return RELAY_EXIT.transport;
  }
}
