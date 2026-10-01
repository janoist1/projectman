import net from 'node:net';
import tls from 'node:tls';
import { parseClientHello } from './sni';

/** A minimal ClientHello record with the given server name bytes and extra extensions. */
export function syntheticHello(opts: {
  serverName?: Buffer | string;
  extensions?: Array<{ type: number; data?: Buffer }>;
}): Buffer {
  const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  const extension = (type: number, data: Buffer) => Buffer.concat([u16(type), u16(data.length), data]);
  const extensions: Buffer[] = [];
  if (opts.serverName !== undefined) {
    const name = Buffer.isBuffer(opts.serverName) ? opts.serverName : Buffer.from(opts.serverName, 'ascii');
    const entry = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
    extensions.push(extension(0, Buffer.concat([u16(entry.length), entry])));
  }
  for (const extra of opts.extensions ?? [])
    extensions.push(extension(extra.type, extra.data ?? Buffer.alloc(4)));
  const allExtensions = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(allExtensions.length),
    allExtensions,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([1, (body.length >> 16) & 0xff]),
    u16(body.length & 0xffff),
    body,
  ]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(handshake.length), handshake]);
}

/** The first bytes a real TLS client sends to `servername` (captured at a local listener). */
export async function captureClientHello(servername?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const hello = Buffer.concat(chunks);
        if (parseClientHello(hello).status !== 'incomplete') {
          socket.destroy();
          server.close();
          resolve(hello);
        }
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      const client = tls.connect({
        host: '127.0.0.1',
        port,
        ...(servername ? { servername } : {}),
        rejectUnauthorized: false,
      });
      client.on('error', () => undefined);
    });
  });
}
