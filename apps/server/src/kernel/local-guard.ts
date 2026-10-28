import type { IncomingHttpHeaders } from 'node:http';
import { isIPv4 } from 'node:net';

/**
 * Guard of the internal endpoints (the runner's `/hooks/:token`, the team tools'
 * `/mcp/:token`): only agent CLI sessions started by the runner on this machine may call
 * them. These checks run before the token is looked at and reject:
 * - connections that do not come from a loopback address;
 * - requests relayed by a reverse proxy on this machine (e.g. `tailscale serve`), which
 *   arrive from 127.0.0.1 but carry forwarding headers or a non-local Host;
 * - browser requests from other sites (DNS rebinding): non-local Host or Origin.
 */

/** Headers added by reverse proxies; their presence means the caller is not local. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'tailscale-user-login',
] as const;

/** True for 127.0.0.0/8, ::1 and IPv4-mapped loopback addresses (::ffff:127.x.x.x). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  const v4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  return isIPv4(v4) && v4.startsWith('127.');
}

/** True for loopback host names: localhost, 127.x.x.x and ::1 (bracketed or not). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || isLoopbackAddress(host);
}

/** Checks a Host header value such as "127.0.0.1:4700", "localhost" or "[::1]:4700". */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host || !/^[a-z0-9.:[\]-]+$/i.test(host)) return false;
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** Checks an Origin header value; only http(s) origins on a loopback host are accepted. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

/** Returns why a request must be rejected, or null when it is a local request. */
export function nonLocalReason(request: {
  remoteAddress: string | undefined;
  headers: IncomingHttpHeaders;
}): string | null {
  if (!isLoopbackAddress(request.remoteAddress)) return 'remote address is not loopback';
  const forwarded = FORWARDING_HEADERS.find((name) => request.headers[name] !== undefined);
  if (forwarded) return `request was forwarded by a proxy (${forwarded})`;
  if (!isLoopbackHostHeader(request.headers.host)) return 'host is not a loopback host';
  const origin = request.headers.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) return 'origin is not a loopback origin';
  return null;
}
