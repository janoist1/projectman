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
  let bridgedSeen: Array<string | null>;
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
    bridgedSeen = [];
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
      helloTimeoutMs: 500,
      maxTunnels: 6,
      keyOf: (who) => who.token ?? 'anonymous',
      maxPerIdentity: 3,
      localAddresses: () => ['93.184.216.99'],
      identify: async (_peer, token, bridged) => {
        bridgedSeen.push(bridged);
        return identity ?? { identity: { token } };
      },
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
    decision = { allowed: true, tags: ['egw_1'] };
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

  it('limits the tunnels of one identity, and of the proxy as a whole', async () => {
    const mine = await Promise.all([1, 2, 3].map(() => connectThrough('docs.example.org:443')));
    expect(mine.every((c) => /^HTTP\/1\.1 200/.test(c.head))).toBe(true);
    const fourth = await connectThrough('docs.example.org:443');
    expect(fourth.head).toContain('X-Projectman-Denial: too_many_requests');
    // Another identity still gets its own share, up to the proxy's cap.
    const other = (n: number) => [`Proxy-Authorization: ${basic(`other-token-${n}-0123456789`)}`];
    const theirs = await Promise.all([1, 2, 3].map((n) => connectThrough('docs.example.org:443', other(n))));
    expect(theirs.every((c) => /^HTTP\/1\.1 200/.test(c.head))).toBe(true);
    const over = await connectThrough('docs.example.org:443', other(4));
    expect(over.head).toContain('X-Projectman-Denial: too_many_requests');
    // A closed tunnel frees its slot.
    mine[0]!.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await connectThrough('docs.example.org:443');
    expect(again.head).toMatch(/^HTTP\/1\.1 200/);
    for (const c of [...mine, ...theirs, again, fourth, over]) c.socket.destroy();
  });

  it('closes a tunnel whose ClientHello does not come in time, or is too large', async () => {
    const slow = await connectThrough('docs.example.org:443');
    slow.socket.write(Buffer.from([0x16, 0x03, 0x01, 0x10, 0x00])); // a record header, then nothing
    const started = Date.now();
    await closed(slow.socket);
    expect(Date.now() - started).toBeLessThan(2000);
    const huge = await connectThrough('docs.example.org:443');
    huge.socket.write(Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x40, 0x00]), Buffer.alloc(70 * 1024)]));
    await closed(huge.socket);
    expect(connects).toEqual([]);
  });

  it('wants no server name for an IP literal and the host’s name otherwise', async () => {
    const named = await captureClientHello('docs.example.org');
    const literal = await connectThrough('93.184.216.34:443');
    literal.socket.write(named);
    await closed(literal.socket);
    const bare = await captureClientHello();
    const host = await connectThrough('docs.example.org:443');
    host.socket.write(bare);
    await closed(host.socket);
    expect(connects).toEqual([]);
    const plain = await connectThrough('93.184.216.34:443');
    plain.socket.write(bare);
    await until(() => connects.length === 1);
    expect(connects).toEqual([{ address: '93.184.216.34', port: 443 }]);
    plain.socket.destroy();
  });

  it('refuses a name that resolves to this machine’s own address', async () => {
    addresses = ['93.184.216.99'];
    const { head, socket } = await connectThrough('docs.example.org:443');
    expect(head).toContain('X-Projectman-Denial: private_address');
    await closed(socket);
  });

  it('knows the member of a connection handed over from its bridge socket', async () => {
    const handover = net.createServer((socket) => proxy.acceptFrom(socket, 'dev'));
    await new Promise<void>((resolve) => handover.listen(0, '127.0.0.1', resolve));
    const port = (handover.address() as net.AddressInfo).port;
    try {
      const head = await new Promise<string>((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        let data = '';
        socket.setEncoding('latin1');
        socket.on('data', (chunk: string) => {
          data += chunk;
          if (data.includes('\r\n\r\n')) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.write('CONNECT docs.example.org:443 HTTP/1.1\r\nHost: docs.example.org:443\r\n\r\n');
      });
      expect(head).toMatch(/^HTTP\/1\.1 200/);
      expect(bridgedSeen).toEqual(['dev']);
      // A connection on the proxy's own port names no member.
      const direct = await connectThrough('docs.example.org:443');
      direct.socket.destroy();
      expect(bridgedSeen).toEqual(['dev', null]);
    } finally {
      handover.close();
    }
  });

  it('refuses a permission revoked before its tunnel was registered', async () => {
    proxy.closeTagged('egw_late');
    decision = { allowed: true, tags: ['egw_late'] };
    const { head, socket } = await connectThrough('docs.example.org:443');
    expect(head).toMatch(/^HTTP\/1\.1 403/);
    await closed(socket);
    expect(connects).toEqual([]);
  });

  it('ends a busy tunnel when its permission expires, and refuses an expired one', async () => {
    const hello = await captureClientHello('docs.example.org');
    decision = { allowed: true, tags: ['egw_2'], expiresAt: new Date(Date.now() + 300).toISOString() };
    const { socket } = await connectThrough('docs.example.org:443');
    socket.write(hello);
    await until(() => received.length >= hello.length);
    expect(socket.destroyed).toBe(false);
    await closed(socket);
    decision = { allowed: true, tags: ['egw_3'], expiresAt: new Date(Date.now() - 1000).toISOString() };
    const late = await connectThrough('docs.example.org:443');
    expect(late.head).toMatch(/^HTTP\/1\.1 403/);
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
