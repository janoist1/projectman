import type { FastifyInstance } from 'fastify';
import { apiError } from './errors';
import { isLoopbackHostname } from '../kernel';

/**
 * The public entrance of the feedback widget (PM-506, PM-513): a second hostname on the same tunnel,
 * with no Access application in front of it. The tunnel passes only `^/feedback/` on that hostname;
 * this guard is the second lock, for the day that rule is wrong. On the public hostname it answers
 * the unknown-route 404 to everything but the widget's own paths, so `/api`, `/ws`, `/hooks`, `/mcp`
 * and the web app cannot be reached there.
 */

interface FeedbackPublicAddress {
  /** `https://jelolo.example.com`, without a trailing slash. */
  origin: string;
  /** The lowercase host name of requests to it, without any port (the guard ignores the port in `Host`). */
  host: string;
  /** A loopback address (development): there is no public entrance to guard. */
  loopback: boolean;
}

/**
 * Parses and checks `PROJECTMAN_FEEDBACK_PUBLIC_URL`. `https`, or `http` on a loopback host only;
 * no credentials, path (a single `/` is fine), query or fragment. Throws an Error that says what is
 * wrong, so the server stops at startup with a clear message.
 */
export function parseFeedbackPublicUrl(raw: string): FeedbackPublicAddress {
  const value = raw.trim();
  const invalid = (why: string): Error =>
    new Error(`invalid PROJECTMAN_FEEDBACK_PUBLIC_URL: ${value} (${why})`);
  // URL parsing drops an empty query or fragment, so the characters are looked for in the text.
  if (value.includes('?') || value.includes('#')) throw invalid('no query or # allowed');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('not a URL; expected https://jelolo.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('https is required');
  if (url.username || url.password) throw invalid('no user name or password allowed');
  if (url.pathname !== '/') throw invalid('no path allowed, only the host name');
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw invalid('http is allowed only on a loopback host');
  return { origin: url.origin, host: hostnameOf(url.host), loopback };
}

/** What the widget needs: the script and its API segments. A strict list, matched on the raw URL. */
const WIDGET_PATH = /^\/feedback\/(?:widget\.js|api\/v1\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/;

/**
 * Whether a request target may be served on the public hostname. Judged on the raw text before the
 * `?`, with no decoding and no normalization: Cloudflare's `^/feedback/` rule passes
 * `/feedback/../api/setup` on, and the guard must not depend on how a router would read it later.
 * `..`, `.`, `%`, `\`, `//`, other letter case and a trailing `/` are all outside the list.
 */
export function isPublicFeedbackPath(rawUrl: string): boolean {
  const queryAt = rawUrl.indexOf('?');
  return WIDGET_PATH.test(queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt));
}

/**
 * The `Host` header as the guard compares it: the host name only, lowercase, without the port and
 * without the root label's dot. The port is left out on purpose: `Host: name:443` still reaches the
 * public name (Cloudflare's hostname rule does not look at it), so it must not slip past the guard.
 * An IPv6 literal keeps its brackets.
 */
export function hostnameOf(header: string | undefined): string {
  const value = (header ?? '').trim().toLowerCase();
  const name = value.startsWith('[')
    ? value.slice(0, value.indexOf(']') + 1 || undefined)
    : value.split(':')[0]!;
  return name.replace(/\.+$/, '');
}

/**
 * Registers the guard before the auth hook. Does nothing for a loopback address (development).
 * Call it once, on the root instance.
 */
export function registerFeedbackHostGuard(app: FastifyInstance, address: FeedbackPublicAddress): void {
  if (address.loopback) return;
  app.addHook('onRequest', async (request, reply) => {
    if (hostnameOf(request.headers.host) !== address.host) return;
    if (isPublicFeedbackPath(request.raw.url ?? '')) return;
    // The same answer the not-found handler gives an unknown server route (http/errors).
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    // An upgrade request (a websocket) leaves its socket open after any answer; the websocket plugin
    // closes it in a hook that runs after this one, so close it here.
    if (request.headers.upgrade !== undefined) reply.raw.once('finish', () => request.raw.socket.end());
    return reply.code(404).send(apiError('not_found', 'route not found'));
  });
}
