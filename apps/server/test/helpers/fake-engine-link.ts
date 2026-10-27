import type { IncomingHttpHeaders } from 'node:http';
import type { Socket as NetSocket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { routes } from '@projectman/shared';
import { decodeFrame, encodeFrame } from '../../src/engine-link';
import type { Hello } from '../../src/engine-link';

interface Socket {
  send(data: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
}

const helloOf = (): Hello => ({
  t: 'hello',
  protocol: 1,
  version: 'test-version',
  hostname: 'fake-engine',
  platform: 'darwin',
  paths: {
    userHome: '/fictional/user',
    home: '/fictional/engine',
    worktreesRoot: '/fictional/engine/worktrees',
    workspacesRoot: null,
    installDir: null,
    sessionFoldersRoot: '/fictional/engine/folders',
    sessionTmpRoot: null,
    claudeTmpRoots: [],
    browsersDir: null,
    heavyLockDir: null,
    gitExcludesFile: null,
  },
  projects: [],
  repos: [],
  providers: [{ provider: 'claude', available: true, version: '1' }],
  running: [],
  nextSeq: 1,
  instanceTag: '0123456789abcdef',
  pid: 42,
  uid: 501,
  bootId: 'aaaaaaaaaaaaaaaa',
});

export interface FakeEngineLink {
  /** The methods the cloud asked, in order. */
  asked: string[];
  close(): void;
}

/**
 * An engine of the cloud composition on the real link endpoint (a fake, in this process): it connects with the
 * machine key, and answers `host.is_directory` with `isDirectory` and every other request with null.
 */
export async function connectFakeEngine(
  app: FastifyInstance,
  machineKey: string,
  isDirectory: (path: string) => boolean = () => true,
): Promise<FakeEngineLink> {
  const asked: string[] = [];
  const frames: string[] = [];
  const headers: IncomingHttpHeaders = { host: 'localhost', authorization: `Bearer ${machineKey}` };
  const ws = (await app.injectWS(
    routes.engineLink(),
    { socket: { remoteAddress: '127.0.0.1' } as NetSocket, headers },
    {
      onInit: (raw) => {
        const socket = raw as unknown as Socket;
        socket.on('message', (data) => {
          const frame = decodeFrame(data);
          frames.push(frame.t);
          if (frame.t !== 'req') return;
          asked.push(frame.method);
          const result =
            frame.method === 'host.is_directory'
              ? isDirectory((frame.params as { path: string }).path)
              : null;
          socket.send(encodeFrame({ t: 'res', id: frame.id, ok: true, result }));
        });
      },
    },
  )) as unknown as Socket;
  ws.send(encodeFrame(helloOf()));
  await vi.waitFor(() => expect(frames).toContain('welcome'));
  return { asked, close: () => ws.terminate() };
}
