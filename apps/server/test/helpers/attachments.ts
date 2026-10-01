import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { routes } from '@projectman/shared';

/** A few bytes that the content check takes for a PNG (the signature), padded to `size`. */
export function pngBytes(size = 64): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, Buffer.alloc(Math.max(0, size - signature.length), 7)]);
}

export const pdfBytes = (): Buffer => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
export const htmlBytes = (): Buffer => Buffer.from('<!doctype html><script>alert(1)</script>');
export const svgBytes = (): Buffer =>
  Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

export interface MultipartPart {
  name: string;
  /** Raw, as the browser would write it into the header (UTF-8 bytes). */
  filename?: string;
  contentType?: string;
  content: Buffer | string;
}

export interface MultipartBody {
  payload: Buffer;
  headers: { 'content-type': string };
}

/** A multipart/form-data body, as one buffer, with its content-type header. */
export function multipartBody(
  parts: MultipartPart[],
  boundary = `----pmtest${randomBytes(8).toString('hex')}`,
): MultipartBody {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename !== undefined ? `; filename="${part.filename}"` : '');
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n${disposition}\r\n` +
          (part.contentType ? `Content-Type: ${part.contentType}\r\n` : '') +
          '\r\n',
      ),
      Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** The body of a request that uploads one file. */
export function fileBody(
  content: Buffer | string,
  fileName = 'picture.png',
  declaredType = 'application/octet-stream',
): MultipartBody {
  return multipartBody([{ name: 'file', filename: fileName, contentType: declaredType, content }]);
}

export interface UploadOptions {
  taskKey?: string;
  projectKey?: string;
  fileName?: string;
  declaredType?: string;
  headers?: Record<string, string>;
}

/** One file posted to a task's attachments as the user with this cookie (default: AR-1 of AR). */
export function uploadFile(
  app: FastifyInstance,
  cookie: string,
  content: Buffer | string,
  opts: UploadOptions = {},
): Promise<LightMyRequestResponse> {
  const body = fileBody(content, opts.fileName, opts.declaredType);
  return app.inject({
    method: 'POST',
    url: routes.taskAttachments(opts.projectKey ?? 'AR', opts.taskKey ?? 'AR-1'),
    headers: { cookie, ...body.headers, ...opts.headers },
    payload: body.payload,
  });
}

export interface ChunkedResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * A POST over a real connection with chunked transfer encoding (no content length to trust): the
 * body goes out in two halves, `between` runs after the first (the server is mid-upload), and with
 * `abort` the connection is torn down instead of sending the second half (status 0).
 */
export function chunkedPost(
  url: string,
  cookie: string,
  body: MultipartBody,
  opts: { between?: () => void | Promise<void>; abort?: boolean; splitAt?: number } = {},
): Promise<ChunkedResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: ChunkedResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request(
      url,
      { method: 'POST', headers: { cookie, ...body.headers, 'transfer-encoding': 'chunked' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          finish({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', (err) => {
      if (settled) return;
      if (opts.abort) finish({ status: 0, headers: {}, body: '' });
      else {
        settled = true;
        reject(err);
      }
    });
    const splitAt = opts.splitAt ?? Math.floor(body.payload.length / 2);
    req.write(body.payload.subarray(0, splitAt));
    void Promise.resolve(opts.between?.()).then(() => {
      if (opts.abort) req.destroy();
      else req.end(body.payload.subarray(splitAt));
    }, reject);
  });
}
