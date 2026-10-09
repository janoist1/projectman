import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { routes } from '@projectman/shared';
import { httpUrl } from './engine-config';
import { ENGINE_UPLOAD_MAX_BYTES } from './protocol';
import type { EngineUploaded, EngineUploadPurpose } from './protocol';
import { EngineRpcError } from './rpc';

/**
 * Large results and attachments do not go through the link (PM-314): the engine POSTs them to
 * `/engine/files/uploads/:token` and GETs attachments from `/engine/files/downloads/:token` over HTTPS,
 * authenticated like the link (`Authorization: Bearer <key>` plus the configured extra headers). The
 * token comes with the cloud's request and is single-use on the cloud; the engine only checks its shape.
 */

export interface EngineTransfers {
  /** Streams `source` to the cloud; the receipt is computed over the bytes actually sent. */
  upload(
    token: string,
    purpose: EngineUploadPurpose,
    source: { size: number; stream: () => Readable },
  ): Promise<EngineUploaded>;
  /** Downloads to `dest` after checking size and sha256; the file appears only when both match. */
  download(token: string, dest: string, expected: { size: number; sha256: string }): Promise<void>;
}

export interface EngineTransferOptions {
  cloudUrl: string;
  /** The headers of every request, `authorization` included; read at each call (the key file may be replaced). */
  headers: () => Record<string, string>;
  fetch?: typeof fetch;
}

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
      done(new Error('The stream is longer than announced'));
      return;
    }
    this.hash.update(chunk);
    done(null, chunk);
  }
}

export function createEngineTransfers(options: EngineTransferOptions): EngineTransfers {
  const doFetch = options.fetch ?? fetch;
  return {
    async upload(token, purpose, source) {
      if (source.size > ENGINE_UPLOAD_MAX_BYTES[purpose])
        throw new EngineRpcError('result_too_large', 'The result is larger than the cloud accepts');
      const meter = new Meter(source.size);
      const stream = source.stream();
      // pipe() forwards no errors: a read error must end the upload, not crash the process.
      stream.on('error', (error) => meter.destroy(error));
      stream.pipe(meter);
      let response: Response;
      try {
        response = await doFetch(httpUrl(options.cloudUrl, routes.engineUpload(token)), {
          method: 'POST',
          headers: {
            ...options.headers(),
            'content-type': 'application/octet-stream',
            'content-length': String(source.size),
          },
          body: Readable.toWeb(meter) as ReadableStream,
          duplex: 'half',
        } as RequestInit);
      } catch {
        throw new EngineRpcError('link_down', 'The upload to the cloud failed');
      }
      if (!response.ok)
        throw new EngineRpcError('internal', `The cloud refused the upload (${response.status})`);
      if (meter.bytes !== source.size)
        throw new EngineRpcError('internal', 'The uploaded content changed while it was sent');
      return { sha256: meter.hash.digest('hex'), size: meter.bytes };
    },
    async download(token, dest, expected) {
      let response: Response;
      try {
        response = await doFetch(httpUrl(options.cloudUrl, routes.engineDownload(token)), {
          method: 'GET',
          headers: options.headers(),
        });
      } catch {
        throw new EngineRpcError('link_down', 'The download from the cloud failed');
      }
      if (!response.ok || !response.body)
        throw new EngineRpcError('internal', `The cloud refused the download (${response.status})`);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      const temp = `${dest}.${randomBytes(6).toString('hex')}.part`;
      const meter = new Meter(expected.size);
      try {
        await pipeline(
          Readable.fromWeb(response.body as never),
          meter,
          createWriteStream(temp, { mode: 0o600, flags: 'wx' }),
        );
        if (meter.bytes !== expected.size || meter.hash.digest('hex') !== expected.sha256)
          throw new EngineRpcError('internal', 'The downloaded file does not match its size and checksum');
        renameSync(temp, dest);
      } catch (error) {
        rmSync(temp, { force: true });
        if (error instanceof EngineRpcError) throw error;
        throw new EngineRpcError('internal', 'The download could not be stored');
      }
    },
  };
}
