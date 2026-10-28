import net from 'node:net';
import { ControlResponse } from '@projectman/shared';
import type { ControlRequest } from '@projectman/shared';

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

type ControlTransportFailure =
  /** Nobody answers on the socket path: the server does not run, or it has no control socket. */
  | 'unreachable'
  | 'timeout'
  /** The answer line is longer than the client takes. */
  | 'too_large'
  /** The server closed the connection before a whole line came, or the line is no control response. */
  | 'invalid_response'
  | 'io';

/** The request could not be delivered, or its answer not read: the write may or may not have happened. */
export class ControlTransportError extends Error {
  readonly failure: ControlTransportFailure;
  constructor(failure: ControlTransportFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

interface SendControlOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * One request, one answer, over a fresh connection to the control socket (PM-749). The answer is one JSON
 * line, at most `maxResponseBytes`, parsed as a `ControlResponse`; a domain refusal (`ok: false`) is a
 * response, not an error. It never repeats the request: a mutating one may have been applied when the
 * answer is lost, so the caller reads the state again (`release_get`).
 */
export function sendControlRequest(
  socketPath: string,
  request: ControlRequest,
  options: SendControlOptions = {},
): Promise<ControlResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return new Promise((resolve, reject) => {
    const connection = net.connect({ path: socketPath });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error: ControlTransportError | null, response?: ControlResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(
      () => finish(new ControlTransportError('timeout', `the server did not answer in ${timeoutMs} ms`)),
      timeoutMs,
    );
    connection.once('connect', () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      const text = Buffer.concat(chunks).toString('utf8');
      const newline = text.indexOf('\n');
      // The first line counts: whatever follows it is not ours to read.
      if (newline < 0) {
        if (size > maxBytes)
          finish(new ControlTransportError('too_large', `the answer is longer than ${maxBytes} bytes`));
        return;
      }
      const line = text.slice(0, newline);
      if (Buffer.byteLength(line) > maxBytes) {
        finish(new ControlTransportError('too_large', `the answer is longer than ${maxBytes} bytes`));
        return;
      }
      try {
        finish(null, ControlResponse.parse(JSON.parse(line)));
      } catch {
        finish(
          new ControlTransportError(
            'invalid_response',
            'the server answered with something that is not a control response',
          ),
        );
      }
    });
    connection.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? new ControlTransportError('unreachable', `nobody answers on the control socket (${err.code})`)
          : new ControlTransportError('io', `the control socket failed (${err.code ?? 'error'})`),
      ),
    );
    connection.on('end', () =>
      finish(
        new ControlTransportError(
          'invalid_response',
          'the server closed the connection without a whole answer',
        ),
      ),
    );
  });
}
