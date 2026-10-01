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

/** The same endpoint as `/proc/net/tcp6` writes an IPv4-mapped address (::ffff:a.b.c.d). */
function endpointV6(address: string, port: number): string | null {
  const host = hexV4(address.replace(/^::ffff:/, ''));
  return host ? `0000000000000000FFFF0000${host}:${port.toString(16).toUpperCase().padStart(4, '0')}` : null;
}

/** The uid owning the socket whose local end is `client` and remote end is `server`, in table text. */
export function findSocketUid(
  table: string,
  client: { address: string; port: number },
  server: { address: string; port: number },
  family: 4 | 6 = 4,
): number | null {
  const encode = family === 4 ? endpoint : endpointV6;
  const local = encode(client.address, client.port);
  const remote = encode(server.address, server.port);
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

/** Reads `/proc/net/tcp` (then `/proc/net/tcp6`, for an IPv4-mapped client) and finds its uid. */
export async function procPeerUid(
  client: { address: string; port: number },
  server: { address: string; port: number },
  dir = '/proc/net',
): Promise<number | null> {
  for (const [file, family] of [
    ['tcp', 4],
    ['tcp6', 6],
  ] as const) {
    try {
      const uid = findSocketUid(await readFile(`${dir}/${file}`, 'utf8'), client, server, family);
      if (uid !== null) return uid;
    } catch {
      // not there (another system) or not readable: try the next, then refuse
    }
  }
  return null;
}
