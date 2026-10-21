import { chmod } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { ErrorCode } from '@projectman/shared';
import { DomainError } from '../kernel';
import { ADMINISTRATION_LIMITS } from '../contracts';
import type { AdministrationPort } from '../contracts';
import {
  SOCKET_REQUEST_MAX_BYTES,
  SOCKET_RESPONSE_MAX_BYTES,
  SocketParams,
  SocketRequest,
  SocketValues,
} from './schemas';
import type { SocketResponse } from './schemas';
import { assertPrivateDir, assertSocketFile, removeStaleSocket } from './secure-fs';

/**
 * The supervisor's local socket (PM-763). One JSON line in, one JSON line out, then the connection closes:
 * at most 16 KiB in, 256 KiB out, 30 s per connection. There is no bearer, cookie or Access header on this
 * wire: who may connect is decided by the file system alone (a private 0700 directory holding a 0600 socket
 * of the service user, checked before listening and by every client before connecting).
 */

export interface SocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface SocketServerOptions {
  socketPath: string;
  port: AdministrationPort;
  ioTimeoutMs?: number;
}

const REQUEST_ID_FALLBACK = 'unreadable';

function errorCodeOf(err: unknown): ErrorCode {
  if (err instanceof DomainError) return err.code;
  return 'administration_failed';
}

async function answer(port: AdministrationPort, line: string): Promise<SocketResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail(REQUEST_ID_FALLBACK, 'invalid_request');
  }
  const request = SocketRequest.safeParse(raw);
  if (!request.success) {
    const id =
      typeof raw === 'object' && raw !== null ? (raw as { requestId?: unknown }).requestId : undefined;
    return fail(
      typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : REQUEST_ID_FALLBACK,
      'invalid_request',
    );
  }
  const { method, requestId } = request.data;
  const params = SocketParams[method].safeParse(request.data.params);
  if (!params.success) return fail(requestId, 'invalid_request');
  try {
    let value: unknown;
    switch (method) {
      case 'status':
        value = await port.status((params.data as { target: never }).target);
        break;
      case 'logs': {
        const { target, ...options } = params.data as { target: never } & Parameters<typeof port.logs>[1];
        value = await port.logs(target, options);
        break;
      }
      case 'machine':
        value = await port.machine((params.data as { target: never }).target);
        break;
      case 'submit':
        value = await port.submit(params.data as never);
        break;
      case 'inspect':
        value = await port.inspect((params.data as { operationId: string }).operationId);
        break;
    }
    // The answer is held to the same schema as the one the client expects: nothing else leaves the process.
    const checked = SocketValues[method].safeParse(value);
    if (!checked.success) return fail(requestId, 'administration_failed');
    return { version: 1, requestId, ok: true, value: checked.data };
  } catch (err) {
    return fail(requestId, errorCodeOf(err));
  }
}

function fail(requestId: string, code: ErrorCode): SocketResponse {
  return { version: 1, requestId, ok: false, error: { code } };
}

export async function startSocketServer(options: SocketServerOptions): Promise<SocketServer> {
  const { socketPath, port } = options;
  const ioTimeoutMs = options.ioTimeoutMs ?? ADMINISTRATION_LIMITS.ioTimeoutMs;
  await assertPrivateDir(path.dirname(socketPath));
  await removeStaleSocket(socketPath);

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(ioTimeoutMs, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    const chunks: Buffer[] = [];
    let received = 0;
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      received += chunk.length;
      if (received > SOCKET_REQUEST_MAX_BYTES) {
        handled = true;
        reply(socket, fail(REQUEST_ID_FALLBACK, 'invalid_request'));
        return;
      }
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      const end = buffered.indexOf(0x0a);
      if (end < 0) return;
      handled = true;
      void answer(port, buffered.subarray(0, end).toString('utf8')).then((response) =>
        reply(socket, response),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chmod(socketPath, 0o600);
    await assertSocketFile(socketPath);
  } catch (err) {
    server.close();
    throw err;
  }

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function reply(socket: net.Socket, response: SocketResponse): void {
  let text = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(text) > SOCKET_RESPONSE_MAX_BYTES) {
    text = `${JSON.stringify(fail(response.requestId, 'administration_failed'))}\n`;
  }
  socket.end(text);
}
