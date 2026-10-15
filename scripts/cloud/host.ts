import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { FIREWALL_PORTS } from './aws';
import { AwsCli } from './aws-cli';
import type { CloudContext } from './context';
import type { PipeEnd, RunResult } from './deps';
import { CloudError, refused } from './errors';
import { expandHome } from './config';
import { writeSecret } from './secrets';
import { withEc2Host } from './ec2-host';
import { imageIdSchema, platformSchema } from './images';

/**
 * The ssh side of the machine commands (PM-535). A session does, in this order: finds the machine and the
 * owner's public address, opens the SSH port for that address alone, gets a temporary key and certificate from
 * Lightsail (or uses `aws.sshIdentityFile`), lets `ssh` verify the machine against the host keys Lightsail
 * reports (`StrictHostKeyChecking=yes`, never `no`), and runs `deploy/aws/host.sh` on the machine. Afterwards,
 * on success, failure, an exception and Ctrl-C alike, the key directory is deleted and the firewall is put back
 * to the entry `aws` made (22/tcp for the `lightsail-connect` alias only). If that fails the command says so
 * and prints the command that does it by hand.
 */

const CHECK_IP_URL = 'https://checkip.amazonaws.com';
const DEFAULT_USER = 'ubuntu';
/** Lightsail's temporary credentials live for a short time; a new set is fetched when ours are older than this. */
const CREDENTIALS_MAX_AGE_MS = 30_000;
const RESTORE_ATTEMPTS = 3;
const RESTORE_WAIT_MS = 2_000;
const SCRIPT_LIMIT_BYTES = 90_000;

export const HOST_SUBCOMMANDS = [
  'bootstrap',
  'receive-env',
  'receive-image',
  'build',
  'start',
  'stop',
  'status',
  'logs',
  'rehearse',
  'seed-check',
  'seed-digest',
  'receive-data',
  'send-data',
  'guard-check',
  'public-check',
] as const;
export type HostSubcommand = (typeof HOST_SUBCOMMANDS)[number];

// ---- the answers of the CLI ----

const instanceSchema = z.looseObject({
  instance: z.looseObject({
    name: z.string(),
    state: z.looseObject({ name: z.string() }),
    publicIpAddress: z.string().optional(),
  }),
});
const accessDetailsSchema = z.looseObject({
  accessDetails: z.looseObject({
    username: z.string().optional(),
    ipAddress: z.string().optional(),
    privateKey: z.string().optional(),
    certKey: z.string().optional(),
    hostKeys: z
      .array(z.looseObject({ algorithm: z.string().optional(), publicKey: z.string().optional() }))
      .optional(),
  }),
});

const deployEntrySchema = z.looseObject({
  sha: z.string(),
  ref: z.string(),
  at: z.string(),
  imageId: imageIdSchema.optional(),
  platform: platformSchema.optional(),
});
export const hostStatusSchema = z.looseObject({
  unit: z.string(),
  container: z.string(),
  health: z.string(),
  image: z.string(),
  imageId: imageIdSchema.nullable().optional(),
  deploy: z
    .looseObject({
      current: deployEntrySchema.nullable().optional(),
      previous: deployEntrySchema.nullable().optional(),
      lastStoppedAt: z.string().nullable().optional(),
    })
    .nullable(),
  disk: z.looseObject({ dataBytes: z.number(), freeBytes: z.number() }),
  memory: z.looseObject({
    totalBytes: z.number().optional(),
    availableBytes: z.number().optional(),
    swapTotalBytes: z.number().optional(),
    swapUsedBytes: z.number().optional(),
  }),
});
export type HostStatus = z.output<typeof hostStatusSchema>;

// ---- small helpers ----

/** One word for a POSIX shell: single quotes, a quote inside becomes `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hostScriptPath(repoRoot: string): string {
  return path.join(repoRoot, 'deploy', 'aws', 'host.sh');
}

export function unitFilePath(repoRoot: string): string {
  return path.join(repoRoot, 'deploy', 'aws', 'projectman-cloud.service');
}

/** The systemd unit the machine gets (`bootstrap` reads it on the standard input). */
export function readUnitFile(repoRoot: string): string {
  return readRepoFile(unitFilePath(repoRoot));
}

function readRepoFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw refused(`cannot read ${file}: ${(error as Error).message}`);
  }
}

/** The command that puts the firewall back by hand. */
export function firewallRestoreCommand(context: CloudContext): string {
  const { aws } = context.config;
  const ports = JSON.stringify(FIREWALL_PORTS);
  return `aws --profile ${aws.profile} --region ${aws.region} lightsail put-instance-public-ports --instance-name ${aws.instanceName} --port-infos '${ports}'`;
}

function lastLines(text: string, count: number): string {
  return text.trim().split('\n').filter(Boolean).slice(-count).join(' | ');
}

/** The host keys of the Lightsail answer as `known_hosts` lines (a certificate-authority key as `@cert-authority`). */
export function knownHostsLines(
  address: string,
  hostKeys: readonly { algorithm?: string | undefined; publicKey?: string | undefined }[],
): string[] {
  const lines: string[] = [];
  for (const key of hostKeys) {
    const algorithm = key.algorithm ?? '';
    const publicKey = key.publicKey ?? '';
    if (!/^[A-Za-z0-9@.-]+$/.test(algorithm) || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) continue;
    const authority = /-cert-v01@openssh\.com$/.test(algorithm);
    if (authority)
      lines.push(
        `@cert-authority ${address} ${algorithm.replace(/-cert-v01@openssh\.com$/, '')} ${publicKey}`,
      );
    else lines.push(`${address} ${algorithm} ${publicKey}`);
  }
  return lines;
}

export interface HostRunOptions {
  /** Written to the standard input of the script (never put in the arguments). */
  input?: string;
  timeoutMs?: number;
  /** `inherit` shows the script's output on the terminal as it comes (a long build). */
  stdio?: 'pipe' | 'inherit';
}

export interface HostSession {
  /** Lightsail public address, or the EC2 instance id (no public SSH endpoint). */
  readonly address: string;
  /** Aborts when the user interrupts the command. */
  readonly signal: AbortSignal;
  /** Runs a subcommand of host.sh; the result is whatever ssh returns, a failure included. */
  run(subcommand: HostSubcommand, args?: string[], options?: HostRunOptions): Promise<RunResult>;
  /** `run`, but a failure throws (the last lines of the script's error output are the message). */
  call(subcommand: HostSubcommand, args?: string[], options?: HostRunOptions): Promise<string>;
  /** The ssh command of a subcommand, for `deps.pipe` (a tar stream). */
  command(subcommand: HostSubcommand, args?: string[]): Promise<PipeEnd>;
  /** An interactive shell on the machine. */
  shell(): Promise<RunResult>;
}

// ---- the session ----

interface Credentials {
  fetchedAt: number;
  sshArgs: string[];
  user: string;
}

/** Both transports send the same script and payload, and interpret the same host.sh responses. */
export function createHostSession(
  context: CloudContext,
  address: string,
  signal: AbortSignal,
  sshArgs: () => Promise<string[]>,
): HostSession {
  const remoteCommand = (subcommand: HostSubcommand, args: string[]): string => {
    const script = readRepoFile(hostScriptPath(context.deps.repoRoot));
    if (Buffer.byteLength(script) > SCRIPT_LIMIT_BYTES)
      throw new Error('deploy/aws/host.sh is too large to send');
    return ['sudo', 'bash', '-c', script, 'host.sh', subcommand, ...args].map(shellQuote).join(' ');
  };
  const host: HostSession = {
    address,
    signal,
    async run(subcommand, args = [], options = {}) {
      const argv = await sshArgs();
      return context.deps.run('ssh', [...argv, remoteCommand(subcommand, args)], { ...options, signal });
    },
    async call(subcommand, args = [], options = {}) {
      const result = await host.run(subcommand, args, options);
      if (signal.aborted) throw new CloudError('interrupted', 1);
      if (result.code !== 0) {
        const detail = lastLines(result.stderr || result.stdout, 3) || `exit status ${result.code}`;
        if (result.code === 3) throw refused(detail.replace(/^host\.sh: refused: /, ''));
        throw new CloudError(`${subcommand} failed on the machine (status ${result.code}): ${detail}`);
      }
      return result.stdout;
    },
    async command(subcommand, args = []) {
      const argv = await sshArgs();
      return { command: 'ssh', args: [...argv, remoteCommand(subcommand, args)], signal };
    },
    async shell() {
      return context.deps.run('ssh', await sshArgs(), { stdio: 'inherit', signal });
    },
  };
  return host;
}

/** Runs `body` with an ssh session on the machine; see the file comment for what is opened and closed. */
export async function withHost<T>(
  context: CloudContext,
  body: (host: HostSession) => Promise<T>,
): Promise<T> {
  const { deps, config, report } = context;
  if (config.aws.compute === 'ec2') return withEc2Host(context, body);
  const cli = new AwsCli(deps, config.aws);
  const controller = new AbortController();
  let reject: (error: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_, fail) => (reject = fail));
  const unsubscribe = deps.onInterrupt(() => {
    controller.abort();
    reject(new CloudError('interrupted', 1));
  });
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectman-cloud-ssh-'));
  fs.chmodSync(keyDir, 0o700);
  let firewallOpened = false;

  const checkAlive = () => {
    if (controller.signal.aborted) throw new CloudError('interrupted', 1);
  };

  const work = (async (): Promise<T> => {
    const instanceName = config.aws.instanceName;
    const address = await report.guard('machine', async () => {
      const answer = await cli.callAsOrNull(
        ['lightsail', 'get-instance', '--instance-name', instanceName],
        ['NotFoundException'],
        instanceSchema,
      );
      if (!answer) throw refused(`there is no machine ${instanceName}; run \`npm run cloud -- aws\` first`);
      const instance = answer.instance;
      if (instance.state.name !== 'running')
        throw refused(`the machine ${instanceName} is ${instance.state.name}, not running`);
      if (!instance.publicIpAddress || !net.isIPv4(instance.publicIpAddress))
        throw refused(`the machine ${instanceName} has no public IPv4 address`);
      return instance.publicIpAddress;
    });
    checkAlive();

    const cidr = await report.guard('own-address', async () => {
      let text: string;
      try {
        const response = await deps.fetch(CHECK_IP_URL, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`status ${response.status}`);
        text = (await response.text()).trim();
      } catch (error) {
        throw new CloudError(
          `cannot find out your public address (${CHECK_IP_URL}): ${(error as Error).message}`,
        );
      }
      if (!net.isIPv4(text))
        throw refused(`${CHECK_IP_URL} did not answer an IPv4 address (the machine has only IPv4)`);
      return `${text}/32`;
    });
    checkAlive();

    await report.guard('firewall-open', async () => {
      firewallOpened = true;
      await cli.call([
        'lightsail',
        'put-instance-public-ports',
        '--instance-name',
        instanceName,
        '--port-infos',
        JSON.stringify([{ ...FIREWALL_PORTS[0], cidrs: [cidr] }]),
      ]);
      report.step('updated', 'firewall-open', `22/tcp for ${cidr} (and lightsail-connect)`);
    });
    checkAlive();

    let credentials: Credentials | null = null;
    const refresh = async (): Promise<Credentials> => {
      checkAlive();
      if (credentials && deps.now().getTime() - credentials.fetchedAt < CREDENTIALS_MAX_AGE_MS)
        return credentials;
      const fresh = await fetchCredentials(context, cli, keyDir, address);
      credentials = fresh;
      return fresh;
    };

    const host = createHostSession(
      context,
      address,
      controller.signal,
      async () => (await refresh()).sshArgs,
    );
    return body(host);
  })();
  // `work` may fail after the race below is decided; its error is then of no interest.
  work.catch(() => undefined);

  let primary: unknown = null;
  try {
    return await Promise.race([work, interrupted]);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    // Whatever `work` was doing must end before the firewall is touched (an open call could still be in flight).
    await work.then(
      () => undefined,
      () => undefined,
    );
    fs.rmSync(keyDir, { recursive: true, force: true });
    try {
      if (firewallOpened) await restoreFirewall(context, cli, primary);
    } finally {
      unsubscribe();
    }
  }
}

async function restoreFirewall(context: CloudContext, cli: AwsCli, primary: unknown): Promise<void> {
  const { deps, config, report } = context;
  let lastError = '';
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    try {
      await cli.call([
        'lightsail',
        'put-instance-public-ports',
        '--instance-name',
        config.aws.instanceName,
        '--port-infos',
        JSON.stringify(FIREWALL_PORTS),
      ]);
      report.step('updated', 'firewall-close', '22/tcp for lightsail-connect only');
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < RESTORE_ATTEMPTS) await deps.sleep(RESTORE_WAIT_MS);
    }
  }
  report.line(`FAIL firewall-close: the SSH port may still be open to your address: ${lastError}`);
  report.line(`  put it back by hand: ${firewallRestoreCommand(context)}`);
  if (primary instanceof Error && !(primary instanceof CloudError && primary.reported))
    report.line(`  (the command itself failed first: ${primary.message})`);
  const error = new CloudError('the firewall could not be put back', 1);
  error.reported = true;
  throw error;
}

/** Fetches (or, with `aws.sshIdentityFile`, only the host keys) and writes what ssh needs; returns its arguments. */
async function fetchCredentials(
  context: CloudContext,
  cli: AwsCli,
  keyDir: string,
  address: string,
): Promise<Credentials> {
  const { deps, config, report } = context;
  const fallback = config.aws.sshIdentityFile ? expandHome(config.aws.sshIdentityFile, deps.homeDir) : null;
  const details = (
    await cli.callAs(
      [
        'lightsail',
        'get-instance-access-details',
        '--instance-name',
        config.aws.instanceName,
        '--protocol',
        'ssh',
      ],
      accessDetailsSchema,
    )
  ).accessDetails;
  for (const secret of [details.privateKey, details.certKey])
    if (secret) for (const line of secret.split('\n')) report.protect(line.trim());

  const user =
    details.username && /^[a-z_][a-z0-9_-]{0,31}$/.test(details.username) ? details.username : DEFAULT_USER;
  const hostLines = knownHostsLines(address, details.hostKeys ?? []);
  if (hostLines.length === 0)
    throw refused(
      'Lightsail reported no usable SSH host key, so the machine cannot be verified (the connection would not be safe)',
    );
  const knownHosts = writeSecret(context.secretsDir, 'known_hosts', `${hostLines.join('\n')}\n`);

  const options = [
    '-F',
    '/dev/null',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'ConnectTimeout=30',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=20',
  ];
  let identity: string[];
  if (fallback) {
    identity = ['-i', fallback];
    report.step('ok', 'ssh-access', `the identity file ${config.aws.sshIdentityFile}`);
  } else {
    if (!details.privateKey || !details.certKey)
      throw new CloudError(
        'Lightsail returned no temporary key and certificate; set aws.sshIdentityFile (docs/AWS.md, "SSH")',
      );
    const keyFile = path.join(keyDir, 'key');
    const certFile = path.join(keyDir, 'key-cert.pub');
    fs.rmSync(keyFile, { force: true });
    fs.rmSync(certFile, { force: true });
    const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);
    fs.writeFileSync(keyFile, withNewline(details.privateKey), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(certFile, withNewline(details.certKey), { mode: 0o600, flag: 'wx' });
    identity = ['-i', keyFile, '-o', `CertificateFile=${certFile}`];
    report.step('ok', 'ssh-access', 'a temporary key and certificate from Lightsail');
  }
  return {
    fetchedAt: deps.now().getTime(),
    sshArgs: [...identity, ...options, `${user}@${address}`],
    user,
  };
}

// ---- reading the machine ----

export async function readHostStatus(host: HostSession): Promise<HostStatus> {
  const text = await host.call('status', [], { timeoutMs: 120_000 });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CloudError('the machine did not answer the status in JSON');
  }
  const parsed = hostStatusSchema.safeParse(value);
  if (!parsed.success) throw new CloudError('the machine answered the status in an unexpected shape');
  return parsed.data;
}
