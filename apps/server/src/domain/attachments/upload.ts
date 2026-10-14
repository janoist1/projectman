import { Transform } from 'node:stream';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_ATTACHMENT_BYTES } from '@projectman/shared';
import { DomainError, invalid } from '../../kernel';
import { SNIFF_BYTES } from './media-type';

export const storageFailed = (message: string) =>
  new DomainError('attachment_storage_failed', message, { status: 500 });

/** Counts the bytes that pass, refuses the one that crosses the limit and keeps the first few for the content check. */
export class UploadMeter extends Transform {
  size = 0;
  exceeded = false;
  head = Buffer.alloc(0);

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (err?: Error | null, data?: Buffer) => void,
  ) {
    if (this.size + chunk.length > MAX_ATTACHMENT_BYTES) {
      this.exceeded = true;
      done(new Error('attachment too large'));
      return;
    }
    if (this.head.length < SNIFF_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, SNIFF_BYTES - this.head.length)]);
    }
    this.size += chunk.length;
    done(null, chunk);
  }
}

/**
 * Streams the content into the writer, counting it against the limit. `onSinkError` is told of the
 * storage's own failure (the one to log); the caller gets a `DomainError` for every failure.
 */
export async function receiveUpload(
  content: Readable,
  sink: Writable,
  onSinkError: (err: unknown) => void,
): Promise<{ size: number; head: Buffer }> {
  const meter = new UploadMeter();
  // A failing stream takes the others down with its error: the first one to report is the cause.
  let failed: { from: 'source' | 'sink'; err: unknown } | undefined;
  content.once('error', (err: unknown) => {
    failed ??= { from: 'source', err };
  });
  sink.once('error', (err: unknown) => {
    failed ??= { from: 'sink', err };
  });
  try {
    await pipeline(content, meter, sink);
  } catch (err) {
    if (meter.exceeded) {
      throw new DomainError(
        'attachment_too_large',
        `an attachment is at most ${MAX_ATTACHMENT_BYTES} bytes`,
        {
          status: 413,
          details: { maxBytes: MAX_ATTACHMENT_BYTES },
        },
      );
    }
    if (failed?.from === 'sink') {
      onSinkError(failed.err);
      throw storageFailed('the file could not be stored');
    }
    throw invalid('invalid_request', 'the upload was interrupted');
  }
  return { size: meter.size, head: meter.head };
}
