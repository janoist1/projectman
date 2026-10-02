import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { isLoopbackAddress, isLoopbackHostHeader, isLoopbackHostname } from '../http/local-guard';

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(',')).map((v) => v.trim());
}

/**
 * True for requests made on this machine: a loopback peer, a loopback Host header (no DNS
 * rebinding) and, if a local proxy (e.g. the Vite dev server) forwarded it, only loopback
 * hops. Requests arriving through `tailscale serve` carry the remote client's address or
 * Tailscale identity headers and are therefore not local. Loopback means what the internal
 * endpoints' guard accepts (src/http/local-guard): 127.0.0.0/8, ::1 and IPv4-mapped loopback.
 */
export function isLocalRequest(request: Pick<FastifyRequest, 'socket' | 'headers'>): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false;
  if (!isLoopbackHostHeader(request.headers.host)) return false;
  if (request.headers['tailscale-user-login'] !== undefined) return false;
  const forwarded = [
    ...headerValues(request.headers['x-forwarded-for']),
    ...headerValues(request.headers['x-real-ip']),
    ...headerValues(request.headers.forwarded)
      .map((part) => /for="?\[?([^\]";]+)/i.exec(part)?.[1])
      .filter((v): v is string => v !== undefined),
  ];
  return forwarded.every(isLoopbackHostname);
}

/**
 * The address the attempt limiters count a request under. By default the connection's, which
 * behind a local proxy is the proxy's (loopback) for everybody. When the installation names the
 * header its entrance sets to the real client (`PROJECTMAN_CLIENT_IP_HEADER`, e.g.
 * `cf-connecting-ip` behind Cloudflare), that header's address is used instead, but only if the
 * peer is loopback (a request that did not come through the local proxy could write any header)
 * and the header holds exactly one valid IP address. Anything else, a missing, empty, repeated
 * or malformed header included, falls back to the connection's address. `X-Forwarded-For` is
 * never read: it is a chain a client can start with any value.
 */
export function clientAddress(
  request: Pick<FastifyRequest, 'ip' | 'socket' | 'headers'>,
  header: string | undefined,
): string {
  if (!header || !isLoopbackAddress(request.socket.remoteAddress)) return request.ip;
  const value = request.headers[header.toLowerCase()];
  if (typeof value !== 'string' || value.includes('%') || isIP(value) === 0) return request.ip;
  // One key per address however it is written (::ffff:1.2.3.4 and 1.2.3.4, ::1 and 0:0:0:0:0:0:0:1).
  const lower = value.toLowerCase();
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  if (isIP(v4) === 4) return v4;
  return new URL(`http://[${lower}]`).hostname.slice(1, -1);
}

/** HTTPS is terminated only by a loopback reverse proxy; never trust forwarded hosts. */
export function requestProtocol(request: FastifyRequest): 'http' | 'https' {
  return (request.socket && request.protocol === 'https') ||
    (isLoopbackAddress(request.socket?.remoteAddress) && request.headers['x-forwarded-proto'] === 'https')
    ? 'https'
    : 'http';
}

/** Exact scheme, host and port. Absent Origin is allowed for non-browser API clients. */
export function sameOrigin(request: FastifyRequest): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const expected = new URL(`${requestProtocol(request)}://${request.headers.host ?? ''}`);
    const actual = new URL(origin);
    return actual.origin === origin && actual.origin === expected.origin;
  } catch {
    return false;
  }
}
