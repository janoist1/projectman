import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { z } from 'zod';

/**
 * The boundary probe a worker runs (`dist/boundary-worker-probe.js`, the launcher's
 * `boundary-probe` program): started by the real launcher, as the real worker account, in the
 * real sandboxed unit, it tries what a program in a session must not manage and reports what
 * held. deploy/vm/verify.sh reads its lines for the `launcher` and `domain-gate` checks. It reads
 * no file content and prints only ids, outcomes and error names: nothing secret.
 *
 * Output: one line per probe, `PROBE <id> <ok|fail|skip> <detail>`; ok means the boundary held
 * (or, for a positive control, that the allowed path works).
 */

export const ProbeInput = z.strictObject({
  /** A public IPv4 address root reached a moment ago (null: none, the probe is skipped). */
  publicIp: z.string().nullable(),
  /** A public name to resolve (the worker must not resolve names itself). */
  publicName: z.string().regex(/^[a-z0-9.-]+$/),
  /** A public DNS server root got an answer from (null: none). */
  dnsServer: z.string().nullable(),
  /** A global IPv6 address root reached (null: none). */
  ipv6: z.string().nullable(),
  /** host:port of a base destination (positive control through the proxy). */
  baseDestination: z.string().regex(/^[a-z0-9.-]+:\d+$/),
  /** host:port that is not allowed. */
  deniedDestination: z.string().regex(/^[a-z0-9.-]+:\d+$/),
  proxyPort: z.number().int(),
  appPort: z.number().int(),
  launcherSocket: z.string(),
  peerHome: z.string().nullable(),
  serviceHome: z.string(),
});
export type ProbeInput = z.infer<typeof ProbeInput>;

type Outcome = { ok: boolean | null; detail: string };
const held = (detail: string): Outcome => ({ ok: true, detail });
const broke = (detail: string): Outcome => ({ ok: false, detail });
const skipped = (detail: string): Outcome => ({ ok: null, detail });
const errorName = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? 'error';

/** Resolves true when a TCP connection opens within the timeout. */
export function tcpOpens(
  host: string,
  port: number,
  timeoutMs = 3000,
): Promise<{ open: boolean; why: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open: boolean, why: string) => {
      socket.destroy();
      resolve({ open, why });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true, 'connected'));
    socket.once('error', (err) => done(false, errorName(err)));
  });
}

function unixOpens(path: string): Promise<{ open: boolean; why: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ path });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve({ open: false, why: 'timeout' });
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve({ open: true, why: 'connected' });
    });
    socket.once('error', (err) => resolve({ open: false, why: errorName(err) }));
  });
}

/** A DNS question for `name` to `server`; resolves true when any answer comes back. */
export function dnsAnswers(
  server: string,
  name: string,
  timeoutMs = 2500,
): Promise<{ answered: boolean; why: string }> {
  const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const query = Buffer.concat([
    Buffer.from([0x13, 0x37, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ...labels,
    Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]),
  ]);
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const done = (answered: boolean, why: string) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve({ answered, why });
    };
    socket.on('message', () => done(true, 'answered'));
    socket.on('error', (err) => done(false, errorName(err)));
    setTimeout(() => done(false, 'no answer'), timeoutMs).unref();
    socket.send(query, 53, server, (err) => {
      if (err) done(false, errorName(err));
    });
  });
}

/** The proxy's status line for a CONNECT without credentials. */
function proxyStatus(port: number, authority: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.includes('\r\n')) {
        socket.destroy();
        resolve(data.split('\r\n')[0]!.split(' ')[1] ?? 'malformed');
      }
    });
    socket.once('error', (err) => resolve(errorName(err)));
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

function httpStatus(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve(errorName(err)));
  });
}

function denied(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return errorName(err);
  }
}

export async function runProbes(input: ProbeInput): Promise<Array<[string, Outcome]>> {
  const results: Array<[string, Outcome]> = [];
  const add = (id: string, outcome: Outcome) => results.push([id, outcome]);

  // Who am I: the worker, alone in its group, without privileges.
  const uid = process.getuid?.() ?? -1;
  const gid = process.getgid?.() ?? -1;
  const groups = process.getgroups?.() ?? [];
  const status = readFileSync('/proc/self/status', 'utf8');
  const noNewPrivs = /^NoNewPrivs:\s*1$/m.test(status);
  const capEff = /^CapEff:\s*0+$/m.test(status);
  add(
    'identity',
    uid >= 1000 && groups.every((g) => g === gid) && noNewPrivs && capEff
      ? held(`uid ${uid}, gid ${gid}, no other group, NoNewPrivs, no capabilities`)
      : broke(`uid ${uid}, groups ${groups.join(',')}, NoNewPrivs ${noNewPrivs}, CapEff zero ${capEff}`),
  );
  const env = process.env;
  const leaked = Object.keys(env).filter((k) =>
    /API_KEY|AUTH_TOKEN|SSH_AUTH_SOCK|BASE_URL|^PROJECTMAN_HOME$/.test(k),
  );
  const proxied =
    (env.HTTPS_PROXY ?? '').endsWith(`@127.0.0.1:${input.proxyPort}`) ||
    env.HTTPS_PROXY === `http://127.0.0.1:${input.proxyPort}`;
  add(
    'environment',
    leaked.length === 0 && proxied
      ? held('no key or agent variable; HTTPS_PROXY is the egress proxy')
      : broke(`leaked: ${leaked.join(',') || 'none'}; proxy set: ${proxied}`),
  );

  // Control sockets and files of the machine and of other sessions.
  for (const [id, path] of [
    ['system-bus', '/run/dbus/system_bus_socket'],
    ['resolver-socket', '/run/systemd/resolve/io.systemd.Resolve'],
    ['launcher-socket', input.launcherSocket],
  ] as const) {
    const r = await unixOpens(path);
    add(id, r.open ? broke(`${path} accepted a connection`) : held(`${path}: ${r.why}`));
  }
  const transient = denied(() => readdirSync('/run/systemd/transient'));
  add(
    'transient-units',
    transient
      ? held(`/run/systemd/transient: ${transient}`)
      : broke('/run/systemd/transient is readable (other sessions’ command lines)'),
  );
  const serviceHome = denied(() => readdirSync(input.serviceHome));
  add(
    'service-data',
    serviceHome ? held(`${input.serviceHome}: ${serviceHome}`) : broke(`${input.serviceHome} is readable`),
  );
  if (input.peerHome) {
    const peer = denied(() => readdirSync(input.peerHome!));
    add('peer-home', peer ? held(`${input.peerHome}: ${peer}`) : broke(`${input.peerHome} is readable`));
  } else add('peer-home', skipped('no second worker'));
  const foreign = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((pid) => {
      try {
        return statSync(`/proc/${pid}`).uid !== uid;
      } catch {
        return false;
      }
    });
  add(
    'processes',
    foreign.length === 0
      ? held('only own processes are visible')
      : broke(`${foreign.length} processes of other accounts visible`),
  );
  const writes = [
    '/etc/projectman/probe',
    '/srv/projectman/probe',
    '/opt/projectman/probe',
    '/usr/local/bin/probe',
  ]
    .map((path) => [path, denied(() => writeFileSync(path, ''))] as const)
    .filter(([, why]) => why === null)
    .map(([path]) => path);
  add(
    'write-outside',
    writes.length === 0
      ? held('the app, the CLIs and the configuration are read-only')
      : broke(`writable: ${writes.join(', ')}`),
  );

  // The network: nothing leads out but the egress proxy.
  try {
    const addresses = await lookup(input.publicName, { all: true });
    add('dns', broke(`${input.publicName} resolved to ${addresses.length} address(es)`));
  } catch (err) {
    add('dns', held(`${input.publicName}: ${errorName(err)}`));
  }
  if (input.publicIp) {
    const r = await tcpOpens(input.publicIp, 443);
    add(
      'direct-tcp',
      r.open ? broke(`${input.publicIp}:443 connected directly`) : held(`${input.publicIp}:443: ${r.why}`),
    );
  } else add('direct-tcp', skipped('root reached no public address'));
  if (input.dnsServer) {
    const udp = await dnsAnswers(input.dnsServer, input.publicName);
    add(
      'direct-udp',
      udp.answered
        ? broke(`a DNS question to ${input.dnsServer}:53 was answered`)
        : held(`UDP to ${input.dnsServer}:53: ${udp.why}`),
    );
  } else add('direct-udp', skipped('root got no answer from a public DNS server'));
  if (input.ipv6) {
    const r = await tcpOpens(input.ipv6, 443);
    add('ipv6', r.open ? broke(`${input.ipv6}:443 connected`) : held(`${input.ipv6}:443: ${r.why}`));
  } else add('ipv6', skipped('no IPv6 internet from this guest'));
  const ssh = await tcpOpens('127.0.0.1', 22);
  add(
    'loopback-ssh',
    ssh.open
      ? broke('127.0.0.1:22 connected (an SSH tunnel would get out)')
      : held(`127.0.0.1:22: ${ssh.why}`),
  );
  const stub = await dnsAnswers('127.0.0.53', input.publicName);
  add(
    'loopback-dns',
    stub.answered ? broke('the local resolver answered') : held(`127.0.0.53:53: ${stub.why}`),
  );
  const base = await proxyStatus(input.proxyPort, input.baseDestination);
  add(
    'proxy-base',
    base === '200'
      ? held(`CONNECT ${input.baseDestination}: 200`)
      : broke(`CONNECT ${input.baseDestination}: ${base}`),
  );
  const refused = await proxyStatus(input.proxyPort, input.deniedDestination);
  add(
    'proxy-denied',
    refused === '403'
      ? held(`CONNECT ${input.deniedDestination}: 403`)
      : broke(`CONNECT ${input.deniedDestination}: ${refused}`),
  );
  const metadata = await proxyStatus(input.proxyPort, '169.254.169.254:80');
  add(
    'proxy-private',
    metadata === '403' || metadata === '400'
      ? held(`CONNECT 169.254.169.254:80: ${metadata}`)
      : broke(`CONNECT 169.254.169.254:80: ${metadata}`),
  );
  const api = await httpStatus(input.appPort, '/api/me');
  add('app-api', api === '401' ? held('the app answers 401 without a login') : broke(`GET /api/me: ${api}`));
  return results;
}

async function main(): Promise<void> {
  const input = ProbeInput.parse(JSON.parse(process.argv[2] ?? '{}'));
  for (const [id, outcome] of await runProbes(input)) {
    const word = outcome.ok === null ? 'skip' : outcome.ok ? 'ok' : 'fail';
    process.stdout.write(`PROBE ${id} ${word} ${outcome.detail.replace(/[\r\n]/g, ' ').slice(0, 300)}\n`);
  }
}

if (process.argv[1]?.endsWith('boundary-worker-probe.js')) {
  main().catch((err: unknown) => {
    process.stdout.write(`PROBE error fail ${errorName(err)}\n`);
    process.exit(1);
  });
}
