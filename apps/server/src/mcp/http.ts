import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Tool calls are small; anything bigger is refused before it is parsed. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Request headers that are not copied to the web Request handed to the SDK transport. */
const SKIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'te',
  'trailer',
]);

/**
 * The raw JSON text goes to the SDK transport (which parses and validates JSON-RPC), whatever body parsing the
 * application configures for its other routes. Call it inside the encapsulated scope of the MCP routes.
 */
export function useRawJsonBody(scope: FastifyInstance): void {
  scope.removeAllContentTypeParsers();
  scope.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: MAX_BODY_BYTES },
    (_request, body, done) => done(null, body),
  );
}

/**
 * Converts the Fastify request into the web Request the SDK transport works with. The transport hands the
 * headers on to the tool handlers as request info, so a caller can leave out the ones that carry a credential.
 */
export function toWebRequest(request: FastifyRequest, omit: readonly string[] = []): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || SKIPPED_HEADERS.has(name) || omit.includes(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  // The token is left out of the URL: the transport only passes it on as request info.
  return new Request('http://localhost/mcp', {
    method: request.method,
    headers,
    body: typeof request.body === 'string' ? request.body : null,
  });
}

export function sendJsonRpcError(reply: FastifyReply, status: number, message: string, code = -32000) {
  return reply
    .code(status)
    .type('application/json')
    .send(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/** Copies the status and headers of the transport's response to the Fastify reply, and sends its body. */
export async function sendTransportResponse(reply: FastifyReply, response: Response) {
  reply.code(response.status);
  response.headers.forEach((value, name) => {
    if (name !== 'content-length') reply.header(name, value);
  });
  return reply.send(response.body ? await response.text() : undefined);
}
