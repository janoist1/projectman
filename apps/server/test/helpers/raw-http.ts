import { connect } from 'node:net';

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One HTTP/1.1 request written byte for byte to a local port. `app.inject` parses the URL first
 * (`..`, `%2e` and `//` are normalized before the server sees them); this keeps the request
 * target exactly as given, which is what a proxy that passes on a raw path does.
 */
export function rawRequest(
  port: number,
  target: string,
  opts: { host: string; method?: string; headers?: Record<string, string> },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lines = [
      `${opts.method ?? 'GET'} ${target} HTTP/1.1`,
      `Host: ${opts.host}`,
      'Connection: close',
      ...Object.entries(opts.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ];
    const chunks: Buffer[] = [];
    const socket = connect(port, '127.0.0.1', () => socket.write(lines.join('\r\n')));
    // An upgrade request leaves the connection open after a refusal: the answer is complete when the
    // head and the declared body have arrived (a HEAD answer declares a body it does not send).
    const complete = (): boolean => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      if (split === -1) return false;
      if ((opts.method ?? 'GET') === 'HEAD') return true;
      const length = /^content-length:\s*(\d+)/im.exec(text.slice(0, split))?.[1];
      return length !== undefined && Buffer.byteLength(text.slice(split + 4)) >= Number(length);
    };
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (complete()) socket.end();
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = (split === -1 ? text : text.slice(0, split)).split('\r\n');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head[0] ?? '')?.[1]);
      const headers: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status, headers, body: split === -1 ? '' : text.slice(split + 4) });
    });
  });
}
