import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import {
  createEngineRpc,
  createRpcState,
  decodeFrame,
  encodeFrame,
  ENGINE_PROTOCOL_VERSION,
} from '../../src/engine-link';
import type {
  EngineEvent,
  EngineMethod,
  EngineRpc,
  HandlerContext,
  Hello,
  MethodParams,
  MethodResult,
} from '../../src/engine-link';

/**
 * The cloud's side of the engine link for the engine's tests (PM-314): a WebSocket server at
 * `/engine/link` that answers `hello` with `welcome`, keeps the event state across connections of the
 * same boot (as the real registry does), and records what the engine sent. It also serves the upload and
 * download endpoints. It does not authenticate: the tests read `authorizations` themselves.
 */

export interface FakeCloudOptions {
  /** Do not acknowledge events by themselves (tests acknowledge with `ackUpTo`). */
  holdAcks?: boolean;
  /** Close the socket right after the hello with this code instead of a welcome. */
  refuseWith?: number;
}

export interface FakeCloud {
  /** `http://127.0.0.1:<port>` (the engine turns it into `ws://` for the link). */
  url: string;
  hellos: Hello[];
  authorizations: string[];
  requestHeaders: Array<Record<string, string | string[] | undefined>>;
  /** The events in the order they arrived (duplicates of a replay included). */
  received: Array<{ seq: number; event: EngineEvent }>;
  terminals: Array<{ sessionId: string; data: string }>;
  uploads: Map<
    string,
    { body: Buffer; contentLength: number | undefined; authorization: string | undefined }
  >;
  downloads: Map<string, Buffer>;
  closeCodes: number[];
  connections: () => number;
  /** Handlers for the cloud-side methods (`permission.decide`, `mcp.relay`, `secret.nanogpt_key`, ...). */
  handle<M extends EngineMethod>(
    method: M,
    handler: (params: MethodParams<M>, context: HandlerContext) => MethodResult<M> | Promise<MethodResult<M>>,
  ): void;
  /** Waits until an engine is connected (a welcome was sent) and returns a handle to call it. */
  connected(afterConnections?: number): Promise<{
    call: EngineRpc['call'];
  }>;
  ackUpTo(seq: number): void;
  /** Sends a request frame as it is, without the caller-side validation `call` does. */
  sendRequest(id: string, method: string, params: unknown): void;
  /** Closes the current socket from the cloud's side. */
  drop(code?: number): void;
  close(): Promise<void>;
}

export async function startFakeCloud(options: FakeCloudOptions = {}): Promise<FakeCloud> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 * 1024 } });
  const hellos: Hello[] = [];
  const authorizations: string[] = [];
  const requestHeaders: FakeCloud['requestHeaders'] = [];
  const received: FakeCloud['received'] = [];
  const terminals: FakeCloud['terminals'] = [];
  const closeCodes: number[] = [];
  const uploads: FakeCloud['uploads'] = new Map();
  const downloads: FakeCloud['downloads'] = new Map();
  const handlers: Array<[EngineMethod, (params: never) => unknown]> = [];
  let state = createRpcState();
  let boot: string | null = null;
  let connections = 0;
  let current: { rpc: EngineRpc; socket: { send(data: string): void; close(code?: number): void } } | null =
    null;
  const waiters = new Set<() => void>();

  app.get('/engine/link', { websocket: true }, (socket, request) => {
    authorizations.push(String(request.headers.authorization ?? ''));
    requestHeaders.push({ ...request.headers });
    let rpc: EngineRpc | null = null;
    socket.on('message', (data: Buffer) => {
      const frame = decodeFrame(data);
      if (!rpc) {
        if (frame.t !== 'hello') return socket.close(4400);
        hellos.push(frame);
        if (options.refuseWith) return socket.close(options.refuseWith);
        if (frame.protocol !== ENGINE_PROTOCOL_VERSION) return socket.close(4409);
        if (boot !== frame.bootId) state = createRpcState();
        boot = frame.bootId;
        rpc = createEngineRpc({ side: 'cloud', state, send: (text) => socket.send(text) });
        for (const [method, handler] of handlers) rpc.handle(method, handler as never);
        rpc.onTerminal((sessionId, text) => terminals.push({ sessionId, data: text }));
        rpc.onEvent(() => undefined);
        socket.send(
          encodeFrame({
            t: 'welcome',
            engineId: 'eng_aaaaaaaaaaaa',
            ackedSeq: state.ackedSeq,
            serverTime: new Date().toISOString(),
          }),
        );
        state.ackedSeq = Math.max(state.ackedSeq, frame.nextSeq - 1);
        connections += 1;
        current = { rpc, socket };
        for (const wake of [...waiters]) wake();
        return;
      }
      if (frame.t === 'evt') {
        received.push({ seq: frame.seq, event: frame.event });
        if (options.holdAcks) return;
      }
      void rpc.receive(frame).catch(() => socket.close(4400));
    });
    socket.on('close', (code: number) => {
      closeCodes.push(code);
      rpc?.close();
      if (current?.rpc === rpc) current = null;
    });
  });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.post('/engine/files/uploads/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = request.body as Buffer;
    uploads.set(token, {
      body,
      contentLength: request.headers['content-length']
        ? Number(request.headers['content-length'])
        : undefined,
      authorization: request.headers.authorization,
    });
    return reply.code(204).send();
  });
  app.get('/engine/files/downloads/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const body = downloads.get(token);
    if (!body) return reply.code(404).send();
    return reply.type('application/octet-stream').send(body);
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    hellos,
    authorizations,
    requestHeaders,
    received,
    terminals,
    uploads,
    downloads,
    closeCodes,
    connections: () => connections,
    handle(method, handler) {
      handlers.push([method, handler as unknown as (params: never) => unknown]);
      current?.rpc.handle(method, handler as never);
    },
    async connected(afterConnections = 0) {
      if (connections <= afterConnections || !current)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the engine did not connect')), 15_000);
          const check = () => {
            if (connections > afterConnections && current) {
              clearTimeout(timer);
              waiters.delete(check);
              resolve();
            }
          };
          waiters.add(check);
        });
      const link = current!;
      return { call: link.rpc.call };
    },
    ackUpTo(seq) {
      state.ackedSeq = Math.max(state.ackedSeq, seq);
      current?.socket.send(encodeFrame({ t: 'ack', seq: state.ackedSeq }));
    },
    sendRequest(id, method, params) {
      current?.socket.send(JSON.stringify({ t: 'req', id, method, params }));
    },
    drop(code = 1012) {
      current?.socket.close(code);
    },
    async close() {
      await app.close();
    },
  };
}

export const sha256 = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');
