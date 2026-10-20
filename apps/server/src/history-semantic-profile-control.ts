import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { HistorySearchResult, HistoryViewer } from '@projectman/shared';

/** The part of the history service the measurement calls: the normal search facade, never the engine. */
export interface ProfileSearchFacade {
  search(projectKey: string, viewer: HistoryViewer, input: { query: string }): Promise<HistorySearchResult>;
}

export const PROFILE_SECRET_HEADER = 'x-profile-secret';
export const PROFILE_SECRET_MIN_LENGTH = 16;
const MAX_BODY_BYTES = 8 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function secretMatches(given: string | string[] | undefined, secret: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The measurement's way to the history search (PM-910). The search is reachable only through the members' MCP tool,
 * which needs a member's CLI session; the release measurement runs none, so this handler calls the same
 * `HistoryService.search` of the running server. It belongs to `history-semantic-profile.ts`, a separate bundle
 * that `index.ts` never loads, and it answers only a loopback peer that sends the one-time secret the measurement
 * started the process with. A reply holds the source ids and how each got on the list, no text.
 */
export function createProfileControl(options: { secret: string; facade: ProfileSearchFacade }): Server {
  if (options.secret.length < PROFILE_SECRET_MIN_LENGTH) throw new Error('the profile secret is too short');
  return createServer((request, response) => {
    const reply = (status: number, body: object): void => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    void (async () => {
      if (!request.socket.remoteAddress || !LOOPBACK.has(request.socket.remoteAddress))
        return reply(403, { error: 'not_loopback' });
      if (!secretMatches(request.headers[PROFILE_SECRET_HEADER], options.secret))
        return reply(401, { error: 'unauthorized' });
      if (request.method !== 'POST' || request.url !== '/search') return reply(404, { error: 'not_found' });
      const text = await readBody(request);
      if (text === null) return reply(413, { error: 'too_large' });
      let input: { projectKey?: unknown; handle?: unknown; query?: unknown };
      try {
        input = JSON.parse(text) as typeof input;
      } catch {
        return reply(400, { error: 'invalid_request' });
      }
      const { projectKey, handle, query } = input;
      if (typeof projectKey !== 'string' || typeof handle !== 'string' || typeof query !== 'string')
        return reply(400, { error: 'invalid_request' });
      try {
        const result = await options.facade.search(projectKey, { handle, access: 'owner' }, { query });
        return reply(200, {
          hits: result.matches.map((hit) => ({ sourceId: hit.sourceId, matchType: hit.matchType })),
          hasMore: result.hasMore,
        });
      } catch {
        // The failure itself is in the server log; a reply never carries history text.
        return reply(500, { error: 'search_failed' });
      }
    })().catch(() => {
      if (!response.headersSent) reply(500, { error: 'search_failed' });
    });
  });
}
