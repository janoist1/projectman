import { readFile } from 'node:fs/promises';

/**
 * Which local account opened a loopback TCP connection to the proxy, from the kernel's socket
 * table (`/proc/net/tcp`): the client socket's line has the client's address as its local end,
 * the proxy's as its remote end, and its owner's uid. Linux only; elsewhere it finds nothing,
 * so the proxy refuses (fail closed).
 */

function hexV4(address: string): string | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  // Little-endian: 127.0.0.1 -> 0100007F.
  return parts
    .reverse()
    .map((p) => Number(p).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function endpoint(address: string, port: number): string | null {
  const host = hexV4(address.replace(/^::ffff:/, ''));
  return host ? `${host}:${port.toString(16).toUpperCase().padStart(4, '0')}` : null;
}

/** The uid owning the socket whose local end is `client` and remote end is `server`, in table text. */
export function findSocketUid(
  table: string,
  client: { address: string; port: number },
  server: { address: string; port: number },
): number | null {
  const local = endpoint(client.address, client.port);
  const remote = endpoint(server.address, server.port);
  if (!local || !remote) return null;
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    if (fields[1] === local && fields[2] === remote) {
      const uid = Number(fields[7]);
      return Number.isInteger(uid) ? uid : null;
    }
  }
  return null;
}

/** Reads `/proc/net/tcp` and finds the client's uid. */
export async function procPeerUid(
  client: { address: string; port: number },
  server: { address: string; port: number },
  file = '/proc/net/tcp',
): Promise<number | null> {
  try {
    return findSocketUid(await readFile(file, 'utf8'), client, server);
  } catch {
    return null;
  }
}
