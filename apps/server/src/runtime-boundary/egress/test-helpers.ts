import net from 'node:net';
import tls from 'node:tls';
import { parseClientHello } from './sni';

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
