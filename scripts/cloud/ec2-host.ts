import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AwsCli, profileTarget } from './aws-cli';
import type { HostAws, HostContext } from './context';
import type { RunResult } from './deps';
import { CloudError, CloudTransportError, refused } from './errors';
import { createHostSession, READ_ONLY_SUBCOMMANDS, shellQuote } from './host';
import type { HostSession, HostTransport } from './host';

const INSTANCE_ID = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;
const HOST_KEY_COMMAND = 'cat /etc/ssh/ssh_host_ed25519_key.pub';
const HOST_KEY_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 30_000;
const instancesSchema = z.looseObject({
  Reservations: z.array(
    z.looseObject({
      Instances: z.array(
        z.looseObject({
          InstanceId: z.string().regex(INSTANCE_ID),
          State: z.looseObject({ Name: z.string() }),
          Placement: z.looseObject({ AvailabilityZone: z.string() }),
          Tags: z.array(z.looseObject({ Key: z.string(), Value: z.string() })),
        }),
      ),
    }),
  ),
});
const onlineSchema = z.looseObject({
  InstanceInformationList: z.array(
    z.looseObject({
      InstanceId: z.string(),
      PingStatus: z.string(),
    }),
  ),
});
const commandSchema = z.looseObject({ Command: z.looseObject({ CommandId: z.string().uuid() }) });
const invocationSchema = z.looseObject({
  InstanceId: z.string(),
  CommandId: z.string(),
  Status: z.string(),
  ResponseCode: z.number(),
  StandardOutputContent: z.string(),
});
const sessionsSchema = z.looseObject({
  Sessions: z.array(
    z.looseObject({
      SessionId: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
      Target: z.string(),
      Reason: z.string().optional(),
    }),
  ),
  NextToken: z.string().min(1).max(8192).optional(),
});

/** Strict single-line OpenSSH ed25519 public key, including its binary algorithm and key length. */
export function ec2PublicKey(text: string): string {
  if (text.length > 4096) throw refused('SSM returned an invalid SSH public key');
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [\x21-\x7e]+)?\r?\n?$/.exec(text);
  if (!match) throw refused('SSM returned an invalid SSH public key');
  const encoded = match[1]!;
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length !== 51 ||
    bytes.toString('base64') !== encoded ||
    bytes.readUInt32BE(0) !== 11 ||
    bytes.subarray(4, 15).toString() !== 'ssh-ed25519' ||
    bytes.readUInt32BE(15) !== 32
  )
    throw refused('SSM returned an invalid SSH public key');
  return `ssh-ed25519 ${encoded}`;
}

/** How the machine's AWS calls authenticate: the named profile, or (only `runner-deploy`) the ambient credentials. */
function awsTarget(aws: HostAws) {
  return aws.ambient ? { auth: { kind: 'ambient' } as const, region: aws.region } : profileTarget(aws);
}

function checkTarget(context: HostContext): void {
  const { aws } = context.config;
  // ProxyCommand is interpreted by a shell and by OpenSSH's percent expansion. Refuse either syntax.
  // The ambient mode has no profile: the runner's OIDC role is the only identity there is.
  if (
    (!aws.ambient && (aws.profile === 'i' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(aws.profile))) ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(aws.region) ||
    aws.region.length > 63 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(aws.instanceName)
  )
    throw refused('EC2 SSH requires a safe, explicit central AWS profile, region and instance name');
}

/** AWS transport errors deliberately omit raw output, including unsuccessful RunCommand responses. */
function awsCall(context: HostContext, signal?: AbortSignal) {
  const cli = new AwsCli(context.deps, awsTarget(context.config.aws));
  return async <S extends z.ZodType>(
    args: string[],
    schema: S,
    timeoutMs = CALL_TIMEOUT_MS,
    missingInvocation = false,
  ): Promise<z.output<S> | null> => {
    if (signal?.aborted) throw new CloudError('interrupted');
    const result = await context.deps.run(
      'aws',
      cli.argv(['--no-cli-pager', '--no-cli-auto-prompt', ...args]),
      {
        timeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
    if (signal?.aborted) throw new CloudError('interrupted');
    if (
      missingInvocation &&
      result.code !== 0 &&
      /An error occurred \(InvocationDoesNotExist\)/.test(result.stderr)
    )
      return null;
    if (result.code !== 0) throw new CloudError(`aws ${args[0]} ${args[1]} failed (status ${result.code})`);
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new CloudError(`aws ${args[0]} ${args[1]} printed no JSON`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CloudError(`aws ${args[0]} ${args[1]} answered in an unexpected shape`);
    return parsed.data;
  };
}

/** Name lookup also sees foreign and stopped namesakes; it must never silently choose one instance. */
export async function readEc2HostInstance(context: HostContext, signal?: AbortSignal) {
  checkTarget(context);
  const answer = (await awsCall(context, signal)(
    ['ec2', 'describe-instances', '--filters', `Name=tag:Name,Values=${context.config.aws.instanceName}`],
    instancesSchema,
  ))!;
  const instances = answer.Reservations.flatMap((reservation) => reservation.Instances).filter(
    (instance) => !['terminated', 'shutting-down'].includes(instance.State.Name),
  );
  if (instances.length !== 1) throw refused('EC2 host lookup requires exactly one managed instance');
  const instance = instances[0]!;
  for (const [key, value] of [
    ['Name', context.config.aws.instanceName],
    ['ProjectmanManaged', 'true'],
  ]) {
    const tags = instance.Tags.filter((tag) => tag.Key === key);
    if (tags.length !== 1 || tags[0]!.Value !== value) throw refused('EC2 host has foreign ownership tags');
  }
  if (!new RegExp(`^${context.config.aws.region}[a-z]$`).test(instance.Placement.AvailabilityZone))
    throw refused('EC2 host has an invalid availability zone');
  return instance;
}

/** A fixed, read-only command run through SSM RunCommand; its output is parsed strictly, never echoed. */
interface SsmRead<T> {
  commands: readonly string[];
  /** SSM's own limit for the command (at least 30). */
  timeoutSeconds: number;
  /** Wall-clock budget of the whole lookup. */
  budgetMs: number;
  parse(output: string): T;
  timedOut(): Error;
  failed(): Error;
  foreignTarget(): Error;
}

async function runSsmRead<T>(
  context: HostContext,
  instanceId: string,
  signal: AbortSignal,
  read: SsmRead<T>,
): Promise<T> {
  const call = awsCall(context, signal);
  const deadline = context.deps.now().getTime() + read.budgetMs;
  const remaining = () => {
    const ms = deadline - context.deps.now().getTime() - 5000;
    if (ms <= 0) throw read.timedOut();
    return Math.min(CALL_TIMEOUT_MS, ms);
  };
  const sent = (await call(
    [
      'ssm',
      'send-command',
      '--instance-ids',
      instanceId,
      '--document-name',
      'AWS-RunShellScript',
      '--parameters',
      JSON.stringify({ commands: read.commands }),
      '--timeout-seconds',
      String(read.timeoutSeconds),
    ],
    commandSchema,
    remaining(),
  ))!;
  // The attempt bound also covers a fake/nonadvancing clock.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const invocation = await call(
      ['ssm', 'get-command-invocation', '--command-id', sent.Command.CommandId, '--instance-id', instanceId],
      invocationSchema,
      remaining(),
      true,
    );
    if (invocation) {
      if (invocation.InstanceId !== instanceId || invocation.CommandId !== sent.Command.CommandId)
        throw read.foreignTarget();
      if (invocation.Status === 'Success' && invocation.ResponseCode === 0)
        return read.parse(invocation.StandardOutputContent);
      if (!['Pending', 'InProgress', 'Delayed'].includes(invocation.Status)) throw read.failed();
    }
    await context.deps.sleep(Math.min(2000, remaining()));
  }
  throw read.timedOut();
}

async function readHostKey(context: HostContext, instanceId: string, signal: AbortSignal): Promise<string> {
  return runSsmRead(context, instanceId, signal, {
    commands: [HOST_KEY_COMMAND],
    timeoutSeconds: 120,
    budgetMs: HOST_KEY_TIMEOUT_MS,
    parse: ec2PublicKey,
    timedOut: () => refused('SSM SSH host key lookup timed out (120-second limit)'),
    failed: () => refused('SSM SSH host key command did not succeed'),
    foreignTarget: () => refused('SSM returned a host key invocation for another target'),
  });
}

// ---- load diagnostics (PM-748) ----

/**
 * The machine's load, read through SSM RunCommand so it works while SSH authentication fails. Fixed
 * commands only: no caller-chosen command, credential, environment or raw journal text leaves the machine.
 * `oomKills` is the kernel's counter since boot: it shows that the kernel killed something, not when or why.
 */
const ec2HostDiagnosticsSchema = z.strictObject({
  sampledAt: z.iso.datetime(),
  cpuCount: z.number().int().positive(),
  load1: z.number().nonnegative(),
  availableMemoryBytes: z.number().int().nonnegative(),
  freeDiskBytes: z.number().int().nonnegative(),
  oomKills: z.number().int().nonnegative(),
  /** Journal lines of the last 10 minutes that report an `eic_run_authorized_keys` failure with status 124. */
  eicTimeouts10m: z.number().int().nonnegative(),
});
type Ec2HostDiagnostics = z.output<typeof ec2HostDiagnosticsSchema>;

export const DIAGNOSTICS_COMMANDS = [
  'echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  'echo "cpu=$(nproc)"',
  `echo "load1=$(cut -d' ' -f1 /proc/loadavg)"`,
  `echo "mem_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"`,
  `echo "disk_kb=$(df -Pk /var/lib | awk 'NR==2{print $4}')"`,
  `echo "oom=$(awk '/^oom_kill /{print $2}' /proc/vmstat)"`,
  // The count is printed only when the journal is readable: an unreadable journal is no "zero".
  `if journalctl -q -n 0 --no-pager >/dev/null 2>&1; then echo "eic=$(journalctl -q --no-pager -o cat --since '10 minutes ago' 2>/dev/null | grep -c 'eic_run_authorized_keys.*status 124')"; else echo "eic=unavailable"; fi`,
] as const;
const DIAGNOSTICS_KEYS = ['at', 'cpu', 'load1', 'mem_kb', 'disk_kb', 'oom', 'eic'] as const;
const DIAGNOSTICS_OUTPUT_LIMIT = 512;
const DIAGNOSTICS_BUDGET_MS = 25_000;
const BUSY_LOAD_PER_CPU = 2;
const BUSY_MIN_AVAILABLE_MEMORY_BYTES = 128 * 1024 * 1024;
const MIB = 1024 * 1024;

/** Parses the fixed seven-line answer; a missing or unreadable measurement is an error, never a guessed zero. */
export function parseEc2Diagnostics(output: string): Ec2HostDiagnostics {
  const invalid = (detail: string) =>
    new CloudTransportError('cloud_ssh_unavailable', `SSM host diagnostics: ${detail}`, {
      commandStarted: 'no',
      retryable: false,
    });
  if (output.length > DIAGNOSTICS_OUTPUT_LIMIT) throw invalid('the answer is larger than the limit');
  const lines = output.replace(/\r?\n$/, '').split('\n');
  if (lines.length !== DIAGNOSTICS_KEYS.length) throw invalid('the answer has an unexpected shape');
  const values: Record<string, string> = {};
  DIAGNOSTICS_KEYS.forEach((key, index) => {
    const match = /^([a-z0-9_]+)=([0-9A-Za-z.:-]{1,40})$/.exec(lines[index]!);
    if (!match || match[1] !== key) throw invalid(`the measurement ${key} is missing`);
    if (match[2] === 'unavailable') throw invalid(`the measurement ${key} could not be read on the machine`);
    values[key] = match[2]!;
  });
  const integer = (key: string, factor = 1) => {
    if (!/^\d{1,15}$/.test(values[key]!)) throw invalid(`the measurement ${key} is not a number`);
    return Number(values[key]) * factor;
  };
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(values.load1!)) throw invalid('the measurement load1 is not a number');
  const parsed = ec2HostDiagnosticsSchema.safeParse({
    sampledAt: values.at,
    cpuCount: integer('cpu'),
    load1: Number(values.load1),
    availableMemoryBytes: integer('mem_kb', 1024),
    freeDiskBytes: integer('disk_kb', 1024),
    oomKills: integer('oom'),
    eicTimeouts10m: integer('eic'),
  });
  if (!parsed.success) throw invalid('the answer is outside the expected ranges');
  return parsed.data;
}

/** Why the machine counts as busy (a transient reason to wait), or null. */
export function ec2HostBusyReason(diagnostics: Ec2HostDiagnostics): string | null {
  const reasons: string[] = [];
  if (diagnostics.load1 > BUSY_LOAD_PER_CPU * diagnostics.cpuCount)
    reasons.push(
      `1-minute load ${diagnostics.load1} is above ${BUSY_LOAD_PER_CPU}x its ${diagnostics.cpuCount} CPUs`,
    );
  if (diagnostics.availableMemoryBytes < BUSY_MIN_AVAILABLE_MEMORY_BYTES)
    reasons.push(`only ${Math.floor(diagnostics.availableMemoryBytes / MIB)} MiB memory is available`);
  return reasons.length > 0 ? reasons.join(' and ') : null;
}

function describeMeasurements(diagnostics: Ec2HostDiagnostics): string {
  return (
    `load1=${diagnostics.load1} cpus=${diagnostics.cpuCount} ` +
    `availableMemoryMiB=${Math.floor(diagnostics.availableMemoryBytes / MIB)} ` +
    `freeDiskMiB=${Math.floor(diagnostics.freeDiskBytes / MIB)} ` +
    `oomKillsSinceBoot=${diagnostics.oomKills} eicTimeouts10m=${diagnostics.eicTimeouts10m}`
  );
}

/** One read of the diagnostics. Failures are transport errors; only a foreign target is final (no retry). */
export async function readEc2HostDiagnostics(
  context: HostContext,
  instanceId: string,
  signal: AbortSignal,
  budgetMs = DIAGNOSTICS_BUDGET_MS,
): Promise<Ec2HostDiagnostics> {
  const unavailable = (detail: string) =>
    new CloudTransportError('cloud_ssh_unavailable', `SSM host diagnostics are unavailable: ${detail}`, {
      commandStarted: 'no',
      retryable: true,
    });
  try {
    return await runSsmRead(context, instanceId, signal, {
      commands: DIAGNOSTICS_COMMANDS,
      timeoutSeconds: 30,
      budgetMs,
      parse: parseEc2Diagnostics,
      timedOut: () => unavailable('the lookup timed out'),
      failed: () => unavailable('the command did not succeed'),
      foreignTarget: () =>
        new CloudTransportError(
          'cloud_host_identity_mismatch',
          'SSM returned a diagnostics invocation for another target',
          { commandStarted: 'no', retryable: false, exitCode: 2 },
        ),
    });
  } catch (error) {
    if (error instanceof CloudTransportError || signal.aborted) throw error;
    // aws CLI errors carry no raw output (awsCall); treat them as a transient failure of the lookup.
    if (error instanceof CloudError && error.exitCode === 1) throw unavailable(error.message);
    throw error;
  }
}

/** Closes only this invocation's sessions; the random reason never carries a payload or credential. */
async function closeSessions(
  context: HostContext,
  instanceId: string,
  reasons: ReadonlySet<string>,
): Promise<void> {
  const call = awsCall(context); // Cleanup must remain usable after the work signal aborts.
  const deadline = context.deps.now().getTime() + 30_000;
  const remaining = () => {
    // Reserve the process runner's 5s SIGTERM grace inside the phase's total deadline.
    const ms = deadline - context.deps.now().getTime() - 5000;
    if (ms <= 0) throw new CloudError('SSM session cleanup timed out');
    return Math.min(5000, ms);
  };
  let completeReads = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      let token: string | undefined;
      const matching: string[] = [];
      for (let page = 0; page < 20; page += 1) {
        const answer = (await call(
          [
            'ssm',
            'describe-sessions',
            '--state',
            'Active',
            '--filters',
            JSON.stringify([{ key: 'Target', value: instanceId }]),
            '--max-items',
            '200',
            ...(token ? ['--starting-token', token] : []),
          ],
          sessionsSchema,
          remaining(),
        ))!;
        for (const session of answer.Sessions) {
          if (session.Target !== instanceId || !session.Reason || !reasons.has(session.Reason)) continue;
          matching.push(session.SessionId);
        }
        token = answer.NextToken;
        if (!token) break;
      }
      if (token) throw new CloudError('SSM session cleanup exceeded its page limit');
      completeReads += 1;
      // Always observe three complete snapshots, and a fresh empty snapshot after termination.
      if (matching.length === 0 && completeReads >= 3) return;
      // Finish pagination before mutating the list; termination must not shift later pages.
      for (const id of new Set(matching))
        await call(['ssm', 'terminate-session', '--session-id', id], z.looseObject({}), remaining());
    } catch {
      // Never infer success from a failed/truncated read or a failed TerminateSession.
    }
    if (deadline - context.deps.now().getTime() <= 7000) break;
    await context.deps.sleep(2000);
  }
  throw new CloudError(
    `SSM session cleanup failed for ${instanceId}; inspect sessions with exact reasons ${[...reasons].join(', ')} (docs/AWS.md)`,
  );
}

// ---- bounded retries and failure diagnosis (PM-748) ----

const TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_WAITS_MS = [5_000, 15_000] as const;
const TRANSPORT_BUDGET_MS = 120_000;
/** The process runner's SIGTERM grace: stopping the child counts inside the budget. */
const KILL_GRACE_MS = 5_000;
const MIN_ATTEMPT_MS = 10_000;

/** An SSH-side failure (connection, authentication or the EIC key upload) that a read-only call may repeat. */
class SshFailure extends CloudTransportError {
  readonly authRejected: boolean;

  constructor(message: string, options: { commandStarted: 'no' | 'unknown'; authRejected: boolean }) {
    super('cloud_ssh_unavailable', message, { commandStarted: options.commandStarted, retryable: true });
    this.authRejected = options.authRejected;
  }
}

function sshSummary(result: RunResult): string {
  return (
    result.stderr
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-3)
      .map((line) => line.slice(0, 200))
      .join(' | ') || `exit status ${result.code}`
  );
}

/** The ssh client's own refusal line, `user@host: Permission denied (publickey,...).`, with nothing around it. */
const SSH_AUTH_REFUSAL = /^[^\s@:]+@[^\s:]+: Permission denied \([a-z,-]*publickey[a-z,-]*\)\.?$/i;
/** Client-side lines that precede the refusal without any remote command having run. */
const SSH_CLIENT_NOISE = /^(?:Warning: |Starting session with SessionId|Exiting session with sessionId)/;

/**
 * Whether stderr is the ssh client's refusal of the key. stderr merges the client's lines with the remote
 * command's, so for a state-changing command only a stderr made of the refusal line (plus client noise)
 * counts: a refusal happens before the command starts, so no remote output can precede it, and remote text
 * that merely resembles it must never read as "the command did not start". A read may be repeated, so it
 * keeps the looser match.
 */
function rejectedByClient(stderr: string, mutating: boolean): boolean {
  if (!mutating) return /Permission denied \([a-z,-]*publickey/i.test(stderr);
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !SSH_CLIENT_NOISE.test(line));
  return lines.length === 1 && SSH_AUTH_REFUSAL.test(lines[0]!);
}

/**
 * Reads what a client-side ssh result proves. 255 and 124 alone never prove EIC as the cause: they only
 * say the connection or the answer was lost, so the command may or may not have run.
 */
function classifySsh(result: RunResult, label: string, mutating: boolean): CloudTransportError | null {
  if (result.code !== 255 && result.code !== 124) return null;
  const detail = sshSummary(result);
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Offending \w+ key/i.test(
      result.stderr,
    )
  )
    return new CloudTransportError(
      'cloud_host_identity_mismatch',
      `the machine's SSH host key does not match the key pinned through SSM (${label}): ${detail}`,
      { commandStarted: 'no', retryable: false, exitCode: 2 },
    );
  if (rejectedByClient(result.stderr, mutating)) {
    const failure = new SshFailure(
      `SSH public-key authentication was rejected (${label}, status ${result.code}): ${detail}`,
      { commandStarted: 'no', authRejected: true },
    );
    return mutating
      ? new CloudTransportError(failure.code, failure.message, { commandStarted: 'no', retryable: true })
      : failure;
  }
  const lost = `the SSH connection failed or timed out (${label}, status ${result.code}): ${detail}`;
  return mutating
    ? new CloudTransportError(
        'cloud_ssh_unavailable',
        `${lost}; the command may have run: reconcile the machine's state before repeating it`,
        { commandStarted: 'unknown', retryable: false },
      )
    : new SshFailure(lost, { commandStarted: 'unknown', authRejected: false });
}

/**
 * At most three attempts with 5 s, then 15 s between them, inside one 120 s wall-clock budget (the stop of a
 * child process included). Aborts and every non-retryable error end it at once. Repeats only what the caller
 * passes in: never a state-changing command, never a stream.
 */
async function boundedRetry<T>(
  context: HostContext,
  signal: AbortSignal,
  attempt: (timeoutMs: number) => Promise<T>,
  explain: (
    last: CloudTransportError,
    attempts: number,
    elapsedMs: number,
    deadline: number,
  ) => Promise<Error>,
): Promise<T> {
  const { deps } = context;
  const started = deps.now().getTime();
  const deadline = started + TRANSPORT_BUDGET_MS;
  const reserve = KILL_GRACE_MS + DIAGNOSTICS_BUDGET_MS;
  let last: CloudTransportError | undefined;
  let attempts = 0;
  while (attempts < TRANSPORT_ATTEMPTS) {
    if (signal.aborted) throw new CloudError('interrupted');
    attempts += 1;
    try {
      return await attempt(Math.max(MIN_ATTEMPT_MS, deadline - deps.now().getTime() - reserve));
    } catch (error) {
      if (signal.aborted) throw new CloudError('interrupted');
      if (!(error instanceof CloudTransportError) || !error.retryable) throw error;
      last = error;
    }
    const wait = TRANSPORT_WAITS_MS[attempts - 1];
    if (wait === undefined || deadline - deps.now().getTime() < wait + MIN_ATTEMPT_MS + reserve) break;
    await deps.sleep(wait);
  }
  throw await explain(last!, attempts, deps.now().getTime() - started, deadline);
}

function elapsedText(attempts: number, elapsedMs: number): string {
  return `${attempts} attempt${attempts === 1 ? '' : 's'} in ${Math.round(elapsedMs / 1000)}s`;
}

/**
 * Keeps the connection diagnosis (what the logs prove) apart from the suspected cause (what the measurements
 * hint at). `auth_timeout` is claimed only when SSH rejected the key and the host's own journal shows EIC timeouts.
 */
async function explainSshFailure(
  context: HostContext,
  instanceId: string,
  signal: AbortSignal,
  last: CloudTransportError,
  attempts: number,
  elapsedMs: number,
  deadline: number,
  override: 'no' | undefined,
): Promise<Error> {
  const commandStarted = override ?? last.commandStarted;
  if (!(last instanceof SshFailure))
    return new CloudTransportError(last.code, `${last.message} (${elapsedText(attempts, elapsedMs)})`, {
      commandStarted,
      retryable: last.retryable,
      exitCode: last.exitCode === 2 ? 2 : 1,
    });
  const left = deadline - context.deps.now().getTime() - KILL_GRACE_MS;
  let diagnostics: Ec2HostDiagnostics | undefined;
  let missing = 'no time was left in the budget';
  if (left >= MIN_ATTEMPT_MS / 2) {
    try {
      diagnostics = await readEc2HostDiagnostics(
        context,
        instanceId,
        signal,
        Math.min(DIAGNOSTICS_BUDGET_MS, left),
      );
    } catch (error) {
      if (signal.aborted) return new CloudError('interrupted');
      missing = error instanceof Error ? error.message : 'unknown error';
    }
  }
  const proven = last.authRejected && diagnostics !== undefined && diagnostics.eicTimeouts10m > 0;
  const rejected = last.authRejected
    ? 'SSH public-key authentication was rejected'
    : 'the SSH connection failed';
  const connection = diagnostics
    ? proven
      ? `${rejected} and the host journal shows ${diagnostics.eicTimeouts10m} EIC authorized-keys timeouts (status 124) in the last 10 minutes`
      : `${rejected}; the host journal shows ${diagnostics.eicTimeouts10m} EIC status 124 events in the last 10 minutes, which does not prove the cause`
    : `${rejected}; host diagnostics are unavailable (${missing})`;
  const suspected = diagnostics
    ? `${ec2HostBusyReason(diagnostics) ?? 'none indicated by the measurements'} (measurements: ${describeMeasurements(diagnostics)}; oomKillsSinceBoot is cumulative and gives no time evidence)`
    : 'unknown without host measurements';
  return new CloudTransportError(
    proven ? 'cloud_ssh_auth_timeout' : 'cloud_ssh_unavailable',
    `SSH to the machine failed after ${elapsedText(attempts, elapsedMs)}. Connection diagnosis: ${connection}. ` +
      `Suspected cause (not proven): ${suspected}. Last error: ${last.message}`,
    { commandStarted, retryable: true },
  );
}

/** The EC2 transport of a session: classification, the bounded read retry and the pre-mutation load check. */
function createEc2Transport(
  context: HostContext,
  instanceId: string,
  signal: AbortSignal,
  sshArgs: () => Promise<string[]>,
): HostTransport {
  const { deps } = context;
  const interrupted = () => new CloudError('interrupted');
  /** A side-effect-free `true` over a fresh connection: proves reachability and authentication. */
  const probe = async (timeoutMs: number): Promise<void> => {
    const argv = await sshArgs();
    const result = await deps.run('ssh', [...argv, 'true'], { timeoutMs, signal });
    if (signal.aborted) throw interrupted();
    if (result.code === 0) return;
    throw (
      classifySsh(result, 'connection probe', false) ??
      new SshFailure(`the connection probe failed: ${sshSummary(result)}`, {
        commandStarted: 'no',
        authRejected: false,
      })
    );
  };
  const busy = async (budgetMs: number): Promise<void> => {
    let diagnostics: Ec2HostDiagnostics;
    try {
      diagnostics = await readEc2HostDiagnostics(context, instanceId, signal, budgetMs);
    } catch (error) {
      if (error instanceof CloudTransportError && !(error instanceof SshFailure) && error.retryable)
        throw new CloudTransportError(
          error.code,
          `${error.message}; a state-changing command is refused without a load measurement`,
          { commandStarted: 'no', retryable: true, exitCode: 2 },
        );
      throw error;
    }
    const reason = ec2HostBusyReason(diagnostics);
    if (reason)
      throw new CloudTransportError(
        'cloud_host_busy',
        `the machine is busy: ${reason} (measurements: ${describeMeasurements(diagnostics)})`,
        { commandStarted: 'no', retryable: true, exitCode: 2 },
      );
  };
  let gate: Promise<void> | undefined;
  return {
    // One check per session: a build this session started would otherwise block its own `start`.
    beforeMutation() {
      gate ??= boundedRetry(
        context,
        signal,
        async (timeoutMs) => {
          const began = deps.now().getTime();
          await busy(Math.min(DIAGNOSTICS_BUDGET_MS, timeoutMs));
          await probe(Math.max(KILL_GRACE_MS, timeoutMs - (deps.now().getTime() - began)));
        },
        (last, attempts, elapsedMs, deadline) =>
          explainSshFailure(context, instanceId, signal, last, attempts, elapsedMs, deadline, 'no'),
      );
      return gate;
    },
    async readWithRetry(subcommand, attempt, timeoutMs) {
      return boundedRetry(
        context,
        signal,
        async (budgetMs) => {
          const result = await attempt(timeoutMs === undefined ? budgetMs : Math.min(timeoutMs, budgetMs));
          if (signal.aborted) throw interrupted();
          const failure = classifySsh(result, subcommand, false);
          if (failure) throw failure;
          return result;
        },
        (last, attempts, elapsedMs, deadline) =>
          explainSshFailure(context, instanceId, signal, last, attempts, elapsedMs, deadline, undefined),
      );
    },
    classify(subcommand, result) {
      return classifySsh(result, subcommand, !READ_ONLY_SUBCOMMANDS.has(subcommand));
    },
  };
}

/** SSH encryption carries stdin/streams through SSM; RunCommand reads only the public host key. */
export async function withEc2Host<T>(
  context: HostContext,
  fn: (session: HostSession) => Promise<T>,
): Promise<T> {
  checkTarget(context);
  const { deps } = context;
  const controller = new AbortController();
  const checkAlive = () => {
    if (controller.signal.aborted) throw new CloudError('interrupted');
  };
  const unsubscribe = deps.onInterrupt(() => controller.abort());
  const reasons = new Set<string>();
  let keyDir: string | undefined;
  let instanceId: string | undefined;
  let primary: unknown;
  try {
    const version = await deps.run('aws', ['--version'], {
      timeoutMs: CALL_TIMEOUT_MS,
      signal: controller.signal,
    });
    checkAlive();
    if (version.code !== 0 || !/^aws-cli\/2\./.test(version.stdout || version.stderr))
      throw refused('EC2 SSH requires AWS CLI v2');
    for (const [command, args] of [
      ['session-manager-plugin', ['--version']],
      ['ssh', ['-V']],
    ] as const) {
      const result = await deps.run(command, [...args], {
        timeoutMs: CALL_TIMEOUT_MS,
        signal: controller.signal,
      });
      checkAlive();
      if (result.code !== 0) throw refused(`EC2 SSH requires ${command}`);
    }
    const call = awsCall(context, controller.signal);
    const instance = await readEc2HostInstance(context, controller.signal);
    instanceId = instance.InstanceId;
    if (instance.State.Name !== 'running')
      throw refused(`the EC2 machine is ${instance.State.Name}, not running`);
    const online = (await call(
      [
        'ssm',
        'describe-instance-information',
        '--filters',
        JSON.stringify([{ Key: 'InstanceIds', Values: [instanceId] }]),
      ],
      onlineSchema,
    ))!;
    if (
      online.InstanceInformationList.length !== 1 ||
      online.InstanceInformationList[0]!.InstanceId !== instanceId ||
      online.InstanceInformationList[0]!.PingStatus !== 'Online'
    )
      throw refused('EC2 host is not Online in SSM');
    const hostKey = await readHostKey(context, instanceId, controller.signal);
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projectman-ec2-ssh-'));
    fs.chmodSync(keyDir, 0o700);
    // These files become OpenSSH configuration values; disallow its expansion/control syntax too.
    if (!/^[A-Za-z0-9/._ -]+$/.test(keyDir))
      throw refused('EC2 SSH temporary path has unsupported characters');
    const keyFile = path.join(keyDir, 'key');
    const knownHosts = path.join(keyDir, 'known_hosts');
    fs.writeFileSync(knownHosts, `${instanceId} ${hostKey}\n`, { mode: 0o600, flag: 'wx' });
    const generated = await deps.run(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', 'projectman-cloud', '-f', keyFile],
      { timeoutMs: CALL_TIMEOUT_MS, signal: controller.signal },
    );
    checkAlive();
    if (generated.code !== 0) throw refused('EC2 SSH requires working ssh-keygen (ed25519)');
    fs.chmodSync(keyFile, 0o600);
    const publicKey = ec2PublicKey(fs.readFileSync(`${keyFile}.pub`, 'utf8'));
    const sshOptions = [
      '-F',
      '/dev/null',
      '-i',
      keyFile,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      `UserKnownHostsFile=${JSON.stringify(knownHosts)}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'HostKeyAlgorithms=ssh-ed25519',
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
    const sshArgs = async () => {
      // EIC keys live for 60s: publish immediately before every connection, even after a long build.
      let published: { Success: boolean };
      try {
        published = (await call(
          [
            'ec2-instance-connect',
            'send-ssh-public-key',
            '--instance-id',
            instance.InstanceId,
            '--availability-zone',
            instance.Placement.AvailabilityZone,
            '--instance-os-user',
            'ubuntu',
            '--ssh-public-key',
            publicKey,
          ],
          z.looseObject({ Success: z.boolean() }),
        ))!;
      } catch (error) {
        // A failed upload (throttling, a timeout) happens before any connection: a read may try again.
        if (error instanceof CloudError && error.exitCode === 1 && !controller.signal.aborted)
          throw new SshFailure(error.message, { commandStarted: 'no', authRejected: false });
        throw error;
      }
      if (!published.Success) throw refused('EC2 Instance Connect rejected the temporary public key');
      const reason = `projectman-cloud-${randomUUID()}`;
      reasons.add(reason);
      const proxyArgs = new AwsCli(deps, awsTarget(context.config.aws)).argv([
        '--no-cli-pager',
        '--no-cli-auto-prompt',
        'ssm',
        'start-session',
        '--target',
        instance.InstanceId,
        '--document-name',
        'AWS-StartSSHSession',
        '--parameters',
        'portNumber=22',
        '--reason',
        reason,
      ]);
      context.report.step('ok', 'ssh-access', `${instance.InstanceId} through SSM; reason ${reason}`);
      return [
        ...sshOptions,
        '-o',
        `ProxyCommand=exec ${['aws', ...proxyArgs].map(shellQuote).join(' ')}`,
        `ubuntu@${instance.InstanceId}`,
      ];
    };
    const host = createHostSession(
      context,
      instanceId,
      controller.signal,
      sshArgs,
      createEc2Transport(context, instanceId, controller.signal, sshArgs),
    );
    const result = await fn(host);
    if (controller.signal.aborted) throw new CloudError('interrupted');
    return result;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    controller.abort();
    try {
      if (reasons.size > 0 && instanceId) await closeSessions(context, instanceId, reasons);
    } catch (error) {
      if (primary instanceof Error) {
        if (!(primary instanceof CloudError && primary.reported))
          context.report.line(`FAIL operation before SSM cleanup: ${primary.message}`);
        if (error instanceof Error) error.cause = primary;
      }
      throw error;
    } finally {
      try {
        if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
      } finally {
        unsubscribe();
      }
    }
  }
}
