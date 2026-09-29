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
