import { lookup } from 'node:dns/promises';
import { loadBoundaryConfig, workerLayout } from '../config';
import { createLauncherClient } from '../launcher/client';
import { dnsAnswers, tcpOpens } from './worker-probe';
import type { ProbeInput } from './worker-probe';

/**
 * The boundary measurement of deploy/vm/verify.sh (`dist/boundary-probe.js`), run by root:
 *
 *   node boundary-probe.js --config FILE --worker HANDLE [--peer HANDLE] --service-home DIR
 *     --public-name NAME --dns-server IP --ipv6 IP --base HOST:PORT --denied HOST:PORT
 *
 * First the positive controls, as root outside any unit: the public name resolves, a public
 * address answers on 443, the DNS server answers, the IPv6 address answers. Then it asks the
 * launcher, over its socket, to run the boundary probe as the worker in a real unit, and passes
 * its lines on. Output lines: `CONTROL <id> <ok|skip> <detail>`, `LAUNCHER ping <ok|fail>`,
 * `LAUNCHER run <ok|fail> <detail>` and the worker's `PROBE ...` lines.
 */

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!;
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${key}`);
    out.set(key.slice(2), argv[i + 1]!);
  }
  return out;
}

async function main(): Promise<void> {
  const opts = args(process.argv.slice(2));
  const need = (key: string) => {
    const value = opts.get(key);
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };
  const config = loadBoundaryConfig(need('config'));
  const layout = workerLayout(config);
  const worker = need('worker');
  const peer = opts.get('peer') ?? null;
  const publicName = need('public-name');
  const line = (text: string) => process.stdout.write(`${text.replace(/[\r\n]/g, ' ')}\n`);

  let publicIp: string | null = null;
  try {
    const addresses = (await lookup(publicName, { family: 4, all: true })).map((a) => a.address);
    for (const address of addresses) {
      if ((await tcpOpens(address, 443)).open) {
        publicIp = address;
        break;
      }
    }
  } catch {
    publicIp = null;
  }
  line(
    publicIp
      ? `CONTROL direct-tcp ok root reached ${publicIp}:443`
      : `CONTROL direct-tcp skip root reached no address of ${publicName}`,
  );
  line(
    publicIp
      ? `CONTROL dns ok root resolved ${publicName}`
      : `CONTROL dns skip root could not use ${publicName}`,
  );
  const dnsCandidate = opts.get('dns-server') ?? null;
  const dnsServer =
    dnsCandidate && (await dnsAnswers(dnsCandidate, publicName)).answered ? dnsCandidate : null;
  line(
    dnsServer
      ? `CONTROL direct-udp ok ${dnsServer}:53 answered root`
      : 'CONTROL direct-udp skip no public DNS server answered root',
  );
  const ipv6Candidate = opts.get('ipv6') ?? null;
  const ipv6 = ipv6Candidate && (await tcpOpens(ipv6Candidate, 443)).open ? ipv6Candidate : null;
  line(
    ipv6 ? `CONTROL ipv6 ok root reached ${ipv6}:443` : 'CONTROL ipv6 skip no IPv6 internet from this guest',
  );

  const launcher = createLauncherClient({ socketPath: config.launcher.socket });
  const pinged = await launcher.ping();
  line(`LAUNCHER ping ${pinged ? 'ok' : 'fail'}`);
  if (!pinged) return;
  const input: ProbeInput = {
    publicIp,
    publicName,
    dnsServer,
    ipv6,
    baseDestination: need('base'),
    deniedDestination: need('denied'),
    proxyPort: config.egress.port,
    appPort: config.appPort,
    launcherSocket: config.launcher.socket,
    peerHome: peer ? layout.home(peer) : null,
    serviceHome: need('service-home'),
  };
  try {
    const result = await launcher.run({
      member: worker,
      program: 'boundary-probe',
      args: [JSON.stringify(input)],
      cwd: layout.home(worker),
      timeoutMs: 120_000,
    });
    line(
      `LAUNCHER run ${result.exitCode === 0 ? 'ok' : 'fail'} exit ${result.exitCode ?? 'none'}${result.timedOut ? ' (timed out)' : ''}`,
    );
    for (const probe of result.stdout.split('\n').filter((l) => l.startsWith('PROBE '))) line(probe);
  } catch (err) {
    line(`LAUNCHER run fail ${(err as { code?: string }).code ?? 'error'}`);
  }
}

main().catch((err: unknown) => {
  process.stdout.write(`LAUNCHER run fail ${(err as Error).message.replace(/[\r\n]/g, ' ').slice(0, 200)}\n`);
  process.exit(1);
});
