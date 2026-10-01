import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EgressDestination } from '@projectman/shared';
import { createEgressProxy, denialText, proxyToken } from './proxy';
import type { ProxyDecision, ProxyIdentity } from './proxy';
import { captureClientHello } from './test-helpers';

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silent,
} as never;

const TOKEN = 'session-token-0123456789';
const basic = (token: string) => `Basic ${Buffer.from(`projectman:${token}`).toString('base64')}`;

describe('proxy credentials', () => {
  it('reads the token of a Basic proxy authorization', () => {
    expect(proxyToken(basic(TOKEN))).toBe(TOKEN);
    expect(proxyToken(undefined)).toBeNull();
    expect(proxyToken('Bearer x')).toBeNull();
    expect(proxyToken(basic('short'))).toBeNull();
    expect(proxyToken(`Basic ${Buffer.from('no-colon').toString('base64')}`)).toBeNull();
  });

  it('tells a refused session how to ask, without anything secret', () => {
    expect(denialText({ host: 'docs.example.org', port: 443 }, 'not_allowed', 'egr_1')).toContain(
      'submit_boundary_request, operation_id "egr_1"',
    );
    expect(denialText(null, 'no_session', null)).toContain('Only a session started by projectman');
  });
});

describe('the egress proxy', () => {
  let upstream: net.Server;
  let upstreamPort: number;
  let received: Buffer;
  let upstreamConnections: number;
  let connects: Array<{ address: string; port: number }>;
  let addresses: string[];
  let decision: ProxyDecision;
  let identity: ProxyIdentity<{ token: string | null }> | null;
  let asked: Array<{ token: string | null; destination: EgressDestination }>;
  let proxy: ReturnType<typeof createEgressProxy<{ token: string | null }>>;
  let proxyPort: number;

  beforeEach(async () => {
    received = Buffer.alloc(0);
    upstreamConnections = 0;
    connects = [];
    addresses = ['93.184.216.34'];
    decision = { allowed: true };
    identity = null;
    asked = [];
    upstream = net.createServer((socket) => {
      upstreamConnections += 1;
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
    proxy = createEgressProxy<{ token: string | null }>({
      host: '127.0.0.1',
      port: 0,
      logger: silent,
      helloTimeoutMs: 2000,
      identify: async (_peer, token) => identity ?? { identity: { token } },
      authorize: async (who, destination) => {
        asked.push({ token: who.token, destination });
        return decision;
      },
      lookup: async () => addresses,
      connect: (address, port) => {
        connects.push({ address, port });
        return net.connect(upstreamPort, '127.0.0.1');
      },
    });
    await proxy.listen();
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  /** Sends a CONNECT; resolves with the response head and the open socket. */
  function connectThrough(authority: string, headers: string[] = [`Proxy-Authorization: ${basic(TOKEN)}`]) {
    return new Promise<{ head: string; body: string; socket: net.Socket }>((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1');
      let data = '';
      socket.setEncoding('latin1');
      const onData = (chunk: string) => {
        data += chunk;
        const end = data.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = data.slice(0, end);
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? '0');
        if (data.length < end + 4 + length) return;
        socket.removeListener('data', onData);
        resolve({ head, body: data.slice(end + 4, end + 4 + length), socket });
      };
      socket.on('data', onData);
      socket.on('error', reject);
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${headers.map((h) => `${h}\r\n`).join('')}\r\n`,
      );
    });
  }

  const closed = (socket: net.Socket) =>
    new Promise<void>((resolve) => {
      if (socket.destroyed) resolve();
      socket.on('close', () => resolve());
      socket.resume();
    });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('tunnels an allowed TLS connection to the address it checked, server name verified', async () => {
    const hello = await captureClientHello('docs.example.org');
    const { head, socket } = await connectThrough('Docs.Example.org:443');
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    expect(asked).toEqual([{ token: TOKEN, destination: { host: 'docs.example.org', port: 443 } }]);
    socket.write(hello);
    await until(() => received.length >= hello.length);
    expect(received.equals(hello)).toBe(true);
    expect(connects).toEqual([{ address: '93.184.216.34', port: 443 }]);
    socket.destroy();
  });

  it('ends the open tunnels of a revoked permission, and only those', async () => {
    const hello = await captureClientHello('docs.example.org');
    decision = { allowed: true, tag: 'egw_1' };
    const tagged = await connectThrough('docs.example.org:443');
    tagged.socket.write(hello);
    decision = { allowed: true };
    const base = await connectThrough('docs.example.org:443');
    base.socket.write(hello);
    await until(() => received.length >= hello.length * 2);
    expect(proxy.closeTagged('egw_1')).toBe(1);
    await closed(tagged.socket);
    expect(base.socket.destroyed).toBe(false);
    expect(proxy.closeTagged('egw_1')).toBe(0);
    base.socket.destroy();
  });

  it('keeps the bytes a client sends right after its ClientHello (early data)', async () => {
    const hello = await captureClientHello('docs.example.org');
    const { socket } = await connectThrough('docs.example.org:443');
    socket.write(hello);
    socket.write(Buffer.from('EARLY-DATA'));
    const expected = Buffer.concat([hello, Buffer.from('EARLY-DATA')]);
    await until(() => received.length >= expected.length);
    expect(received.equals(expected)).toBe(true);
    socket.destroy();
  });

  it('refuses a destination the gate refuses, with the operation to ask for', async () => {
    decision = { allowed: false, denial: 'not_allowed', operationId: 'egr_abc' };
    const { head, body, socket } = await connectThrough('docs.example.org:443');
    expect(head).toMatch(/^HTTP\/1\.1 403/);
    expect(head).toContain('X-Projectman-Denial: not_allowed');
    expect(head).toContain('X-Projectman-Operation: egr_abc');
    expect(body).toContain('operation_id "egr_abc"');
    await closed(socket);
    expect(connects).toEqual([]);
  });

  it('refuses an account that is not a worker before asking the gate', async () => {
    identity = { denial: 'identity_mismatch' };
    const { head, socket } = await connectThrough('docs.example.org:443');
    expect(head).toContain('X-Projectman-Denial: identity_mismatch');
    expect(asked).toEqual([]);
    await closed(socket);
  });

  it('passes no credentials on when the client sends none', async () => {
    decision = { allowed: false, denial: 'no_session', operationId: null };
    const { head, socket } = await connectThrough('docs.example.org:443', []);
    expect(asked[0]!.token).toBeNull();
    expect(head).toContain('X-Projectman-Denial: no_session');
    await closed(socket);
  });

  it('refuses a name that resolves to a private address (DNS rebinding), even when allowed', async () => {
    addresses = ['93.184.216.34', '169.254.169.254'];
    const { head, socket } = await connectThrough('docs.example.org:443');
    expect(head).toContain('X-Projectman-Denial: private_address');
    await closed(socket);
    expect(connects).toEqual([]);
  });

  it('refuses a private IP literal', async () => {
    const { head, socket } = await connectThrough('192.168.64.1:443');
    expect(head).toContain('X-Projectman-Denial: private_address');
    await closed(socket);
  });

  it('closes a tunnel whose TLS names another server (domain fronting)', async () => {
    const hello = await captureClientHello('attacker.example.net');
    const { head, socket } = await connectThrough('docs.example.org:443');
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    socket.write(hello);
    await closed(socket);
    expect(connects).toEqual([]);
    expect(upstreamConnections).toBe(0);
  });

  it('closes a tunnel that does not start with TLS (an SSH session over 443)', async () => {
    const { socket } = await connectThrough('docs.example.org:443');
    socket.write('SSH-2.0-OpenSSH_9.6\r\n');
    await closed(socket);
    expect(connects).toEqual([]);
  });

  it('refuses IPv6 literals and malformed authorities', async () => {
    const { head, socket } = await connectThrough('[2001:4860:4860::8888]:443');
    expect(head).toMatch(/^HTTP\/1\.1 400/);
    await closed(socket);
    expect(asked).toEqual([]);
  });

  it('offers no plain HTTP proxying', async () => {
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1');
      let data = '';
      socket.setEncoding('latin1');
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('close', () => resolve(data));
      socket.write(
        'GET http://docs.example.org/ HTTP/1.1\r\nHost: docs.example.org\r\nConnection: close\r\n\r\n',
      );
    });
    expect(answer).toMatch(/^HTTP\/1\.1 405/);
    expect(asked).toEqual([]);
  });
});
