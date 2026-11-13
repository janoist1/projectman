import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenLoopback } from './helpers/loopback';

describe('listenLoopback', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  });

  it('rejects at once when the port is taken, instead of waiting for a timeout', async () => {
    const first = createServer();
    servers.push(first);
    const port = await listenLoopback(first);
    expect(port).toBeGreaterThan(0);
    const second = createServer();
    await expect(listenLoopback(second, port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
