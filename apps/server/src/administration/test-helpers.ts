import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Test support for the administration module (PM-763). Some sandboxes refuse to bind a Unix socket (the
 * agent sandbox does); the tests that need a real socket skip there and run in the merge test.
 */

export async function unixSocketsWork(): Promise<boolean> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adm-probe-'));
  try {
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(path.join(dir, 's'), () => server.close(() => resolve(true)));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
