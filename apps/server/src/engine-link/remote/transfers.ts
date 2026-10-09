import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { EngineId } from '@projectman/shared';
import { routes } from '@projectman/shared';
import type { EngineLinks } from '../index';
import { ENGINE_UPLOAD_MAX_BYTES } from '../protocol';
import type { EngineUploaded, EngineUploadPurpose } from '../protocol';
import { EngineRpcError } from '../rpc';

/**
 * The HTTP side of the files that do not go through the link (PM-315, the counterpart of the engine's
 * `engine-transfer.ts`): `POST /engine/files/uploads/:token` receives what the engine sends (a
 * transcript, a file of its working directory, a branch bundle), `GET /engine/files/downloads/:token`
 * gives an attachment to the engine. A token is made for one request to one engine, valid for five
 * minutes, usable once. The machine key of the engine is the credential, as for the link; every other
 * case (no key, another engine's token, an expired, used or unknown token, the wrong direction) is a 404.
 */

const TOKEN_TTL_MS = 5 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

class TooLarge extends Error {}

/** Counts and hashes what passes, and ends the stream when it is longer than the purpose allows. */
class Meter extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  private readonly limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      done(new TooLarge('The upload is larger than allowed'));
      return;
    }
    this.hash.update(chunk);
    done(null, chunk);
  }
}

export interface ReceivedFile {
  path: string;
  sha256: string;
  size: number;
}

/** What the cloud expects of one upload; `take` checks it against the engine's own receipt. */
export interface UploadTicket {
  token: string;
  /** The stored file when it matches the receipt (`EngineUploaded` of the call's result); else rejects. */
  take(receipt: EngineUploaded): ReceivedFile;
  /** Removes the stored file and ends the token. */
  dispose(): void;
}

export interface DownloadSource {
  path: string;
  size: number;
  sha256: string;
}

export interface FileTransfers {
  issueUpload(engineId: EngineId, purpose: EngineUploadPurpose): UploadTicket;
  /** A token for one download of `source` by the engine; the engine checks the size and checksum itself. */
  issueDownload(engineId: EngineId, source: DownloadSource): string;
  register(app: FastifyInstance): void;
  close(): void;
}

interface Entry {
  engineId: EngineId;
  expiresAt: number;
  used: boolean;
  kind: 'upload' | 'download';
  purpose?: EngineUploadPurpose;
  source?: DownloadSource;
  received?: ReceivedFile;
}

export function createFileTransfers(options: {
  links: Pick<EngineLinks, 'authenticate'>;
  /** Where uploads are kept until the caller is done with them; emptied at start. */
  spoolDir: string;
  now?: () => number;
}): FileTransfers {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  rmSync(options.spoolDir, { recursive: true, force: true });
  mkdirSync(options.spoolDir, { recursive: true, mode: 0o700 });
  const spoolPath = (token: string) => path.join(options.spoolDir, token);
  const mint = (entry: Omit<Entry, 'expiresAt' | 'used'>): string => {
    for (const [token, item] of entries) if (item.expiresAt <= now() && !item.received) entries.delete(token);
    const token = randomBytes(32).toString('base64url');
    entries.set(token, { ...entry, expiresAt: now() + TOKEN_TTL_MS, used: false });
    return token;
  };
  /** The entry a request may use, and marks it used; null for every case that is a 404. */
  const claim = (request: FastifyRequest, kind: Entry['kind']): { token: string; entry: Entry } | null => {
    const engineId = options.links.authenticate(request);
    const { token } = request.params as { token: string };
    if (!TOKEN_SHAPE.test(token)) return null;
    const entry = entries.get(token);
    if (!entry || entry.kind !== kind || entry.engineId !== engineId) return null;
    if (entry.used || entry.expiresAt <= now()) return null;
    entry.used = true;
    return { token, entry };
  };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { code: 'not_found' } });

  return {
    issueUpload(engineId, purpose) {
      const token = mint({ engineId, kind: 'upload', purpose });
      return {
        token,
        take(receipt) {
          const received = entries.get(token)?.received;
          if (!received) throw new EngineRpcError('internal', 'The engine uploaded nothing');
          if (received.sha256 !== receipt.sha256 || received.size !== receipt.size)
            throw new EngineRpcError('internal', 'The upload does not match the engine receipt');
          return received;
        },
        dispose() {
          entries.delete(token);
          rmSync(spoolPath(token), { force: true });
        },
      };
    },
    issueDownload(engineId, source) {
      return mint({ engineId, kind: 'download', source });
    },
    register(app) {
      void app.register(async (scope) => {
        // Only the raw stream: no body is parsed, and what is sent is counted here, not by Fastify.
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
        // The token is part of the URL: keep the request out of the info log.
        const route = { logLevel: 'warn', bodyLimit: ENGINE_UPLOAD_MAX_BYTES.bundle } as const;
        scope.route({
          ...route,
          method: 'POST',
          url: routes.engineUpload(':token'),
          async handler(request, reply) {
            const claimed = claim(request, 'upload');
            if (!claimed) return notFound(reply);
            const { token, entry } = claimed;
            const limit = ENGINE_UPLOAD_MAX_BYTES[entry.purpose!];
            const declared = Number(request.headers['content-length']);
            if (Number.isFinite(declared) && declared > limit) return reply.code(413).send();
            const meter = new Meter(limit);
            try {
              await pipeline(
                request.body as Readable,
                meter,
                createWriteStream(spoolPath(token), { mode: 0o600, flags: 'wx' }),
              );
            } catch (err) {
              rmSync(spoolPath(token), { force: true });
              return reply.code(err instanceof TooLarge ? 413 : 400).send();
            }
            entry.received = { path: spoolPath(token), sha256: meter.hash.digest('hex'), size: meter.bytes };
            return reply.code(204).send();
          },
        });
        scope.route({
          ...route,
          method: 'GET',
          url: routes.engineDownload(':token'),
          async handler(request, reply) {
            const claimed = claim(request, 'download');
            if (!claimed) return notFound(reply);
            const { source } = claimed.entry;
            let size: number;
            try {
              size = statSync(source!.path).size;
            } catch {
              return notFound(reply);
            }
            // A file that changed since it was announced is not sent: the engine would refuse it anyway.
            if (size !== source!.size) return notFound(reply);
            return reply
              .header('content-length', size)
              .type('application/octet-stream')
              .send(createReadStream(source!.path));
          },
        });
      });
    },
    close() {
      entries.clear();
      rmSync(options.spoolDir, { recursive: true, force: true });
    },
  };
}
