import type { FastifyRequest } from 'fastify';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function headerValues(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(',')).map((v) => v.trim());
}

/**
 * True for requests made on this machine: a loopback peer, a loopback Host header (no DNS
 * rebinding) and, if a local proxy (e.g. the Vite dev server) forwarded it, only loopback
 * hops. Requests arriving through `tailscale serve` carry the remote client's address or
 * Tailscale identity headers and are therefore not local.
 */
export function isLocalRequest(request: FastifyRequest): boolean {
  if (!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')) return false;
  if (!LOOPBACK_HOST_RE.test(request.headers.host ?? '')) return false;
  if (request.headers['tailscale-user-login'] !== undefined) return false;
  const forwarded = [
    ...headerValues(request.headers['x-forwarded-for']),
    ...headerValues(request.headers['x-real-ip']),
    ...headerValues(request.headers.forwarded)
      .map((part) => /for="?\[?([^\]";]+)/i.exec(part)?.[1])
      .filter((v): v is string => v !== undefined),
  ];
  return forwarded.every((address) => LOOPBACK_ADDRESSES.has(address) || address === 'localhost');
}

/** HTTPS is terminated only by a loopback reverse proxy; never trust forwarded hosts. */
export function requestProtocol(request: FastifyRequest): 'http' | 'https' {
  return (request.socket && request.protocol === 'https') ||
    (LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress ?? '') &&
      request.headers['x-forwarded-proto'] === 'https')
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
