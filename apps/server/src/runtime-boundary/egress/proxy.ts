import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { parseEgressAuthority } from '@projectman/shared';
import type { EgressDenial, EgressDestination } from '@projectman/shared';
import { isIpLiteral, isPublicIPv4 } from './addresses';
import { MAX_CLIENT_HELLO_BYTES, parseClientHello } from './sni';

/** The account and session of a connection, or why it has none. */
export type ProxyIdentity<I> = { identity: I } | { denial: EgressDenial };
/**
 * `tags` group tunnels for a later `closeTagged` (the allowance that opened them, the member's
 * scope in a project); `expiresAt` ends them when their permission expires.
 */
export type ProxyDecision =
  | { allowed: true; tags?: string[]; expiresAt?: string }
  | { allowed: false; denial: EgressDenial; operationId: string | null };

export interface PeerAddress {
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
}

export interface EgressProxyOptions<I> {
  host: string;
  port: number;
  /** Who connected: the socket owner (kernel) and the session of the proxy credentials. */
  /**
   * `bridged` is the member whose bridge socket the connection came through (`acceptFrom`), null
   * for a TCP connection on the proxy's loopback port.
   */
  identify(peer: PeerAddress, token: string | null, bridged: string | null): Promise<ProxyIdentity<I>>;
  /** The network gate's decision (EgressService). */
  authorize(identity: I, destination: EgressDestination): Promise<ProxyDecision>;
  /** IPv4 addresses of a name (default: the system resolver, IPv4 only). */
  lookup?(host: string): Promise<string[]>;
  /** Opens the upstream connection (default: net.connect to the pinned address). */
  connect?(address: string, port: number): Duplex;
  logger: FastifyBaseLogger;
  helloTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Concurrent tunnels at most (default 512). */
  maxTunnels?: number;
  /** Who a connection counts against (a member); with `maxPerIdentity` (default 64) at most. */
  keyOf?(identity: I): string;
  maxPerIdentity?: number;
  /** This machine's own IPv4 addresses, never a destination (default: its interfaces). */
  localAddresses?(): string[];
}

const defaultLookup = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { family: 4, all: true })).map((entry) => entry.address);

/** `Proxy-Authorization: Basic base64(user:token)`: the token, or null. */
export function proxyToken(header: string | undefined): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header?.trim() ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const token = colon === -1 ? '' : decoded.slice(colon + 1);
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

/** The refusal shown to the session: what was refused and how to ask for it. No secrets. */
export function denialText(
  destination: EgressDestination | null,
  denial: EgressDenial,
  operationId: string | null,
): string {
  const what = destination ? `${destination.host}:${destination.port}` : 'this destination';
  const lines = [`projectman egress: ${what} is outside the VM boundary (${denial}).`];
  if (operationId)
    lines.push(
      `Ask for it with the team tool submit_boundary_request, operation_id "${operationId}"; list_network_denials lists it again.`,
    );
  else if (denial === 'no_session')
    lines.push(
      'Only a session started by projectman can ask for a destination (its proxy settings carry its credentials).',
    );
  return `${lines.join('\n')}\n`;
}

/**
 * The protected egress proxy of the VM boundary (PM-140), in the service process. Workers reach
 * nothing but loopback (nft and the units' IP filters), so this is their only way out. It speaks
 * HTTP CONNECT only and tunnels TLS only: it identifies the connecting account by its socket and
 * the session by its proxy credentials, asks the network gate, resolves the name itself (IPv4,
 * no private or special address in the answer), pins the address it checked, and refuses a
 * ClientHello whose server name is not the allowed host. A refusal never creates a request.
 */
export function createEgressProxy<I>(opts: EgressProxyOptions<I>) {
  const log = opts.logger;
  const lookup = opts.lookup ?? defaultLookup;
  // Half-open like the client side (the HTTP server's sockets are), so a tunnel's FIN travels on.
  const connect =
    opts.connect ??
    ((address: string, port: number) => net.connect({ host: address, port, allowHalfOpen: true }));
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 10 * 60_000;
  const maxTunnels = opts.maxTunnels ?? 512;
  const maxPerIdentity = opts.maxPerIdentity ?? 64;
  const localAddresses =
    opts.localAddresses ??
    (() =>
      Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry !== undefined && entry.family === 'IPv4')
        .map((entry) => entry!.address));
  /** Connections per identity key, so one member cannot take every tunnel. */
  const perIdentity = new Map<string, number>();
  let tunnels = 0;
  let listening = false;
  /** CONNECT sockets leave the HTTP server's bookkeeping: closing the proxy ends them here. */
  const open = new Set<Duplex>();
  /** Open tunnels by the permission that opened them, so revoking it ends them. */
  const byTag = new Map<string, Set<Duplex>>();
  /** Revoked permissions (ids are never reused), for a decision still on its way. */
  const revokedTags = new Set<string>();
  /** Connections that came through a member's bridge socket. */
  const bridgedMember = new WeakMap<object, string>();

  const server = http.createServer((req, res) => {
    // Plain HTTP proxying is not offered: only TLS tunnels, whose server name is checked.
    req.resume();
    res.writeHead(405, { 'content-type': 'text/plain', connection: 'close' });
    res.end('projectman egress: only CONNECT to a TLS destination is supported.\n');
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  function refuse(
    socket: Duplex,
    status: number,
    destination: EgressDestination | null,
    denial: EgressDenial,
    operationId: string | null,
  ): void {
    const body = denialText(destination, denial, operationId);
    const reason = status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Bad Gateway';
    socket.end(
      [
        `HTTP/1.1 ${status} ${reason}`,
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        `X-Projectman-Denial: ${denial}`,
        ...(operationId ? [`X-Projectman-Operation: ${operationId}`] : []),
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    );
    // A client that never reads the answer does not keep its slot.
    setTimeout(() => socket.destroy(), 2000).unref();
  }

  /** Waits for the client's ClientHello; resolves with its bytes and server name, or a refusal. */
  function readHello(
    socket: Duplex,
    head: Buffer,
  ): Promise<{ bytes: Buffer; serverName: string | null } | null> {
    return new Promise((resolve) => {
      let buffered = head;
      let done = false;
      const finish = (value: { bytes: Buffer; serverName: string | null } | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('end', onEnd);
        // Bytes after the ClientHello (TLS early data) wait until the upstream is connected and
        // piped; a flowing stream without a listener would drop them.
        socket.pause();
        resolve(value);
      };
      const check = () => {
        const hello = parseClientHello(buffered);
        if (hello.status === 'hello') finish({ bytes: buffered, serverName: hello.serverName });
        else if (hello.status === 'not_tls' || buffered.length > MAX_CLIENT_HELLO_BYTES) finish(null);
      };
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        check();
      };
      const onEnd = () => finish(null);
      const timer = setTimeout(() => finish(null), helloTimeoutMs);
      socket.on('data', onData);
      socket.on('end', onEnd);
      if (buffered.length > 0) check();
    });
  }

  async function handleConnect(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => undefined);
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const destination = parseEgressAuthority(req.url ?? '');
    if (!destination) return refuse(socket, 400, null, 'not_allowed', null);
    if (tunnels >= maxTunnels) return refuse(socket, 403, destination, 'too_many_requests', null);
    // Counted from here (not after the awaits below), so concurrent connections cannot pass the cap.
    tunnels += 1;
    let released = false;
    let tags: string[] = [];
    let key: string | null = null;
    let expiry: NodeJS.Timeout | null = null;
    const release = () => {
      if (released) return;
      released = true;
      tunnels -= 1;
      if (expiry) clearTimeout(expiry);
      if (key) {
        const left = (perIdentity.get(key) ?? 1) - 1;
        if (left > 0) perIdentity.set(key, left);
        else perIdentity.delete(key);
      }
      for (const tag of tags) {
        byTag.get(tag)?.delete(socket);
        if (byTag.get(tag)?.size === 0) byTag.delete(tag);
      }
    };
    socket.on('close', release);
    const raw = req.socket;
    const peer: PeerAddress = {
      remoteAddress: raw.remoteAddress ?? '',
      remotePort: raw.remotePort ?? 0,
      localAddress: raw.localAddress ?? '',
      localPort: raw.localPort ?? 0,
    };
    const who = await opts.identify(
      peer,
      proxyToken(req.headers['proxy-authorization']),
      bridgedMember.get(raw) ?? null,
    );
    if ('denial' in who) return refuse(socket, 403, destination, who.denial, null);
    if (opts.keyOf) {
      const counted = opts.keyOf(who.identity);
      if ((perIdentity.get(counted) ?? 0) >= maxPerIdentity)
        return refuse(socket, 403, destination, 'too_many_requests', null);
      key = counted;
      perIdentity.set(key, (perIdentity.get(key) ?? 0) + 1);
    }
    const decision = await opts.authorize(who.identity, destination);
    if (!decision.allowed) return refuse(socket, 403, destination, decision.denial, decision.operationId);
    // Registered in the same tick as the decision: a revocation after it finds this tunnel, and an
    // allowance revoked before is remembered.
    if (decision.tags?.some((tag) => revokedTags.has(tag)))
      return refuse(socket, 403, destination, 'not_allowed', null);
    tags = decision.tags ?? [];
    for (const tag of tags) {
      const tagged = byTag.get(tag) ?? new Set<Duplex>();
      tagged.add(socket);
      byTag.set(tag, tagged);
    }
    if (decision.expiresAt) {
      // The permission ends at its expiry, also for a tunnel that is still busy.
      const remaining = Date.parse(decision.expiresAt) - Date.now();
      if (!(remaining > 0)) return refuse(socket, 403, destination, 'not_allowed', null);
      expiry = setTimeout(() => socket.destroy(), Math.min(remaining, 2_147_000_000));
      expiry.unref();
    }
    let addresses: string[];
    if (isIpLiteral(destination.host)) addresses = [destination.host];
    else {
      try {
        addresses = await lookup(destination.host);
      } catch {
        return refuse(socket, 502, destination, 'unresolved', null);
      }
    }
    if (addresses.length === 0) return refuse(socket, 502, destination, 'unresolved', null);
    // One private or special address in the answer refuses the name (DNS rebinding, split views),
    // and so does one of this machine's own (a rented server's public address).
    const own = new Set(localAddresses());
    if (!addresses.every((address) => isPublicIPv4(address) && !own.has(address))) {
      log.warn({ host: destination.host }, 'egress destination resolves to a private address');
      return refuse(socket, 403, destination, 'private_address', null);
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const hello = await readHello(socket, head);
    const expected = isIpLiteral(destination.host) ? null : destination.host;
    if (!hello || (hello.serverName ?? null) !== expected) {
      log.warn(
        { host: destination.host, serverName: hello?.serverName ?? null },
        'egress tunnel refused: TLS name mismatch',
      );
      socket.destroy();
      return;
    }
    const upstream = connect(addresses[0]!, destination.port);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.write(hello.bytes);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const idle = () => {
      socket.destroy();
      upstream.destroy();
    };
    if ('setTimeout' in socket && typeof socket.setTimeout === 'function')
      socket.setTimeout(idleTimeoutMs, idle);
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  }

  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleConnect(req, socket, head).catch((err: unknown) => {
      log.error({ err }, 'egress proxy failed');
      socket.destroy();
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());

  return {
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          server.removeListener('error', reject);
          listening = true;
          resolve();
        });
      });
    },
    close(): Promise<void> {
      listening = false;
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
        for (const socket of open) socket.destroy();
      });
    },
    listening: () => listening && server.listening,
    address: () => server.address(),
    /** Serves a connection of a member's bridge socket; the member is known from the socket. */
    acceptFrom(socket: Duplex, member: string): void {
      bridgedMember.set(socket, member);
      server.emit('connection', socket);
    },
    /**
     * Ends every open tunnel with the tag. `remember` (a revoked allowance: its id never comes
     * back) also refuses a decision for it that is still on its way.
     */
    closeTagged(tag: string, { remember = true }: { remember?: boolean } = {}): number {
      if (remember) revokedTags.add(tag);
      const tagged = [...(byTag.get(tag) ?? [])];
      for (const socket of tagged) socket.destroy();
      byTag.delete(tag);
      return tagged.length;
    },
  };
}
