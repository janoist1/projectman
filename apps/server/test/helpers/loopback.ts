import type { AddressInfo, Server } from 'node:net';

/**
 * Starts a server on the loopback and resolves with the bound port. A listen failure (a taken port, or
 * a sandbox that refuses binding) rejects at once, instead of surfacing as an uncaught error that
 * leaves the awaiting hook to run into its timeout.
 */
export function listenLoopback(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
