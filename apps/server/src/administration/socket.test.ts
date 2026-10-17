import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notFound } from '../kernel';
import type { AdministrationJob, AdministrationPort } from '../contracts';
import { createSocketClient } from './socket-client';
import { startSocketServer } from './socket-server';
import type { SocketServer } from './socket-server';
import { ensurePrivateDir } from './secure-fs';
import { unixSocketsWork } from './test-helpers';

const HUB = { kind: 'hub' } as const;
const AT = '2026-10-17T10:00:00.000Z';
const socketsWork = await unixSocketsWork();

describe.skipIf(!socketsWork)('administration socket', () => {
  let root: string;
  let socketPath: string;
  let server: SocketServer | null;
  const seen: unknown[] = [];

  const port: AdministrationPort = {
    async status(target) {
      return {
        target,
        online: true,
        version: '1.0.0',
        bootId: 'boot-1',
        capabilities: ['status', 'logs'],
        activeOperationId: null,
      };
    },
    async logs(_target, { limit }) {
      return {
        entries: Array.from({ length: Math.min(limit, 2) }, () => ({
          at: AT,
          level: 'info' as const,
          code: 'supervisor_started',
          message: 'supervisor_started',
        })),
      };
    },
    async submit(input) {
      seen.push(input);
      return { accepted: true };
    },
    async inspect(operationId): Promise<AdministrationJob> {
      if (operationId === 'missing') throw notFound('Administration operation', operationId);
      return { operationId, state: 'running', result: null, errorCode: null, updatedAt: AT };
    },
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'adm-sock-'));
    const dir = path.join(root, 'run');
    await ensurePrivateDir(dir);
    socketPath = path.join(dir, 's.sock');
    seen.length = 0;
    server = await startSocketServer({ socketPath, port, ioTimeoutMs: 1000 });
  });
  afterEach(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Sends raw bytes (the connection stays open for the answer) and returns what the server sent before it closed. */
  const raw = (payload: string | Buffer) =>
    new Promise<string>((resolve) => {
      const socket = net.createConnection(socketPath);
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      // The server may reset a connection it refuses; what it sent before is the answer.
      socket.once('error', () => undefined);
      socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.once('connect', () => socket.write(payload));
    });

  it('creates the socket closed to others and serves the port through the client', async () => {
    const client = createSocketClient({ socketPath, ioTimeoutMs: 1000 });
    expect(await client.status(HUB)).toMatchObject({ online: true, bootId: 'boot-1' });
    expect((await client.logs(HUB, { limit: 5 })).entries).toHaveLength(2);
    expect(await client.inspect('op1')).toMatchObject({ operationId: 'op1', state: 'running' });
    await expect(client.inspect('missing')).rejects.toMatchObject({ code: 'not_found' });
    const submit = {
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'deploy' as const, releaseId: 'rel1' },
    };
    expect(await client.submit(submit)).toEqual({ accepted: true });
    expect(seen).toEqual([submit]);
  });

  it('answers one line per connection and refuses a request it cannot take', async () => {
    const valid = JSON.stringify({ version: 1, method: 'status', requestId: 'r1', params: { target: HUB } });
    expect(JSON.parse(await raw(`${valid}\n`))).toMatchObject({ ok: true, requestId: 'r1' });

    for (const bad of [
      'not json',
      JSON.stringify({ version: 2, method: 'status', requestId: 'r1', params: { target: HUB } }),
      JSON.stringify({ version: 1, method: 'exec', requestId: 'r1', params: { argv: ['sh'] } }),
      JSON.stringify({
        version: 1,
        method: 'status',
        requestId: 'r1',
        params: { target: HUB, program: '/bin/sh' },
      }),
      JSON.stringify({
        version: 1,
        method: 'status',
        requestId: 'r1',
        params: { target: HUB },
        authorization: 'Bearer x',
      }),
      JSON.stringify({
        version: 1,
        method: 'submit',
        requestId: 'r1',
        params: {
          operationId: 'o',
          requestId: 'r',
          command: { kind: 'restart', target: HUB, expectedBootId: 'b', service: 'sshd' },
        },
      }),
    ]) {
      expect(JSON.parse(await raw(`${bad}\n`)), bad).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    }
    expect(seen).toEqual([]);
  });

  it('refuses a request over 16 KiB without running it', async () => {
    const big = JSON.stringify({
      version: 1,
      method: 'status',
      requestId: 'r1',
      params: { target: HUB },
      pad: 'x'.repeat(20 * 1024),
    });
    expect(JSON.parse(await raw(`${big}\n`))).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('closes a connection that never finishes its line', async () => {
    const started = Date.now();
    const answer = await raw('{"version":1');
    expect(answer).toBe('');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not let the answer carry more than the schema allows', async () => {
    await server?.close();
    const leaking: AdministrationPort = {
      ...port,
      status: async (target) =>
        ({
          target,
          online: true,
          version: null,
          bootId: null,
          capabilities: [],
          activeOperationId: null,
          env: { TOKEN: 'canary' },
        }) as never,
    };
    server = await startSocketServer({ socketPath, port: leaking, ioTimeoutMs: 1000 });
    const text = await raw(
      `${JSON.stringify({ version: 1, method: 'status', requestId: 'r1', params: { target: HUB } })}\n`,
    );
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: 'administration_failed' } });
    expect(text).not.toContain('canary');
  });

  it('is refused by the client when the socket is open to others, a link, or gone', async () => {
    const client = createSocketClient({ socketPath, ioTimeoutMs: 1000 });
    await chmod(socketPath, 0o666);
    await expect(client.status(HUB)).rejects.toMatchObject({ code: 'administration_unavailable' });
    await chmod(socketPath, 0o600);
    const link = path.join(path.dirname(socketPath), 'link.sock');
    await symlink(socketPath, link);
    await expect(createSocketClient({ socketPath: link }).status(HUB)).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    await expect(
      createSocketClient({ socketPath: path.join(root, 'absent.sock') }).status(HUB),
    ).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('refuses to listen in a directory open to others and replaces only a stale socket', async () => {
    await server?.close();
    server = null;
    const open = path.join(root, 'open');
    await ensurePrivateDir(open);
    await chmod(open, 0o755);
    await expect(startSocketServer({ socketPath: path.join(open, 's.sock'), port })).rejects.toMatchObject({
      reason: 'too_open',
    });
    server = await startSocketServer({ socketPath, port });
  });
});

describe('the client', () => {
  it('never sends a parameter the schema does not know', async () => {
    const client = createSocketClient({ socketPath: '/nonexistent/s.sock' });
    await expect(
      client.submit({
        operationId: 'o',
        requestId: 'r',
        command: { kind: 'restart', target: HUB, expectedBootId: 'b', service: 'sshd' } as never,
      }),
    ).rejects.toThrow();
    await expect(client.inspect('../escape')).rejects.toThrow();
  });
});
