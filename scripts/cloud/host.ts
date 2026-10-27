import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CloudContext } from './context';
import type { PipeEnd, RunResult } from './deps';
import { CloudError, refused } from './errors';
import type { CloudTransportError } from './errors';
import { withEc2Host } from './ec2-host';
import { imageIdSchema, platformSchema } from './images';

/**
 * The ssh side of the machine commands (PM-535). The session itself (how ssh reaches the EC2 machine, through
 * SSM) is in `ec2-host.ts`; this file has what every session shares: the `host.sh` subcommands, the session
 * that sends the script and its payload, and the answer of `status`.
 */

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
  /** The board's control socket through the fixed client in the container (PM-749); never read-only, never repeated. */
  'release-control',
  /** The read-only look at one immutable image, the lock and the schema (PM-751); never repeated by the transport. */
  'release-probe',
] as const;
export type HostSubcommand = (typeof HOST_SUBCOMMANDS)[number];

/**
 * Subcommands that change nothing on the machine (PM-748). Explicit on purpose: a subcommand that is not
 * listed is treated as a state change, so it waits for the load check and is never repeated by the transport.
 */
export const READ_ONLY_SUBCOMMANDS: ReadonlySet<HostSubcommand> = new Set([
  'status',
  'logs',
  'seed-check',
  'seed-digest',
  'send-data',
  'guard-check',
  'public-check',
  'release-probe',
]);
/** The only subcommand the transport may repeat after a lost connection; a new subcommand is not retried. */
const RETRYABLE_READS: ReadonlySet<HostSubcommand> = new Set(['status']);

/** What a transport adds to a session (the EC2 one: bounded retries, load check, failure diagnosis). */
export interface HostTransport {
  /** Runs once per session, before its first state-changing subcommand; throws to refuse it. */
  beforeMutation(): Promise<void>;
  /** Repeats a read-only connection within the transport's time budget; `attempt` gets its time limit. */
  readWithRetry(
    subcommand: HostSubcommand,
    attempt: (timeoutMs: number | undefined) => Promise<RunResult>,
    timeoutMs: number | undefined,
  ): Promise<RunResult>;
  /** The transport failure behind an ssh result, or null when the remote script itself failed. */
  classify(subcommand: HostSubcommand, result: RunResult): CloudTransportError | null;
}

// ---- the answers of the machine ----

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

function hostScriptPath(repoRoot: string): string {
  return path.join(repoRoot, 'deploy', 'aws', 'host.sh');
}

function unitFilePath(repoRoot: string): string {
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

function lastLines(text: string, count: number): string {
  return text.trim().split('\n').filter(Boolean).slice(-count).join(' | ');
}

export interface HostRunOptions {
  /** Written to the standard input of the script (never put in the arguments). */
  input?: string;
  timeoutMs?: number;
  /** `inherit` shows the script's output on the terminal as it comes (a long build). */
  stdio?: 'pipe' | 'inherit';
}

export interface HostSession {
  /** The EC2 instance id (no public SSH endpoint). */
  readonly address: string;
  /** Aborts when the user interrupts the command. */
  readonly signal: AbortSignal;
  /** Runs a subcommand of host.sh; the result is whatever ssh returns, a failure included. */
  run(subcommand: HostSubcommand, args?: string[], options?: HostRunOptions): Promise<RunResult>;
  /** `run`, but a failure throws (the last lines of the script's error output are the message). */
  call(subcommand: HostSubcommand, args?: string[], options?: HostRunOptions): Promise<string>;
  /** The ssh command of a subcommand, for `deps.pipe` (a tar stream). */
  command(subcommand: HostSubcommand, args?: string[]): Promise<PipeEnd>;
  /**
   * The transport failure behind the result of a stream (`deps.pipe` with `command`), or null. After a lost
   * answer the write may have happened (`commandStarted: 'unknown'`): the caller reconciles the machine's state.
   */
  transportError(subcommand: HostSubcommand, result: RunResult): CloudTransportError | null;
  /** An interactive shell on the machine. */
  shell(): Promise<RunResult>;
}

// ---- the session ----

/** Both transports send the same script and payload, and interpret the same host.sh responses. */
export function createHostSession(
  context: CloudContext,
  address: string,
  signal: AbortSignal,
  sshArgs: () => Promise<string[]>,
  transport?: HostTransport,
): HostSession {
  const remoteCommand = (subcommand: HostSubcommand, args: string[]): string => {
    const script = readRepoFile(hostScriptPath(context.deps.repoRoot));
    if (Buffer.byteLength(script) > SCRIPT_LIMIT_BYTES)
      throw new Error('deploy/aws/host.sh is too large to send');
    return ['sudo', 'bash', '-c', script, 'host.sh', subcommand, ...args].map(shellQuote).join(' ');
  };
  const gate = async (subcommand: HostSubcommand) => {
    if (transport && !READ_ONLY_SUBCOMMANDS.has(subcommand)) await transport.beforeMutation();
  };
  const host: HostSession = {
    address,
    signal,
    async run(subcommand, args = [], options = {}) {
      await gate(subcommand);
      const attempt = async (timeoutMs: number | undefined) => {
        const argv = await sshArgs();
        const limits = timeoutMs === undefined ? options : { ...options, timeoutMs };
        return context.deps.run('ssh', [...argv, remoteCommand(subcommand, args)], { ...limits, signal });
      };
      if (transport && RETRYABLE_READS.has(subcommand))
        return transport.readWithRetry(subcommand, attempt, options.timeoutMs);
      return attempt(options.timeoutMs);
    },
    async call(subcommand, args = [], options = {}) {
      const result = await host.run(subcommand, args, options);
      if (signal.aborted) throw new CloudError('interrupted', 1);
      if (result.code !== 0) {
        const lost = host.transportError(subcommand, result);
        if (lost) throw lost;
        const detail = lastLines(result.stderr || result.stdout, 3) || `exit status ${result.code}`;
        if (result.code === 3) throw refused(detail.replace(/^host\.sh: refused: /, ''));
        throw new CloudError(`${subcommand} failed on the machine (status ${result.code}): ${detail}`);
      }
      return result.stdout;
    },
    async command(subcommand, args = []) {
      await gate(subcommand);
      const argv = await sshArgs();
      return { command: 'ssh', args: [...argv, remoteCommand(subcommand, args)], signal };
    },
    transportError(subcommand, result) {
      return transport?.classify(subcommand, result) ?? null;
    },
    async shell() {
      return context.deps.run('ssh', await sshArgs(), { stdio: 'inherit', signal });
    },
  };
  return host;
}

/** Runs `body` with an ssh session on the machine (through SSM; see `ec2-host.ts` for what is opened and closed). */
export function withHost<T>(context: CloudContext, body: (host: HostSession) => Promise<T>): Promise<T> {
  return withEc2Host(context, body);
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
