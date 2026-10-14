import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AwsCli } from './aws-cli';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import { createHostSession, shellQuote } from './host';
import type { HostSession } from './host';

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

function checkTarget(context: CloudContext): void {
  const { aws } = context.config;
  // ProxyCommand is interpreted by a shell and by OpenSSH's percent expansion. Refuse either syntax.
  if (
    aws.compute !== 'ec2' ||
    aws.profile === 'i' ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(aws.profile) ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(aws.region) ||
    aws.region.length > 63 ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/.test(aws.instanceName)
  )
    throw refused('EC2 SSH requires a safe, explicit central AWS profile, region and instance name');
}

/** AWS transport errors deliberately omit raw output, including unsuccessful RunCommand responses. */
function awsCall(context: CloudContext, signal?: AbortSignal) {
  const cli = new AwsCli(context.deps, context.config.aws);
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
export async function readEc2HostInstance(context: CloudContext, signal?: AbortSignal) {
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

async function readHostKey(context: CloudContext, instanceId: string, signal: AbortSignal): Promise<string> {
  const call = awsCall(context, signal);
  const deadline = context.deps.now().getTime() + HOST_KEY_TIMEOUT_MS;
  const remaining = () => {
    const ms = deadline - context.deps.now().getTime() - 5000;
    if (ms <= 0) throw refused('SSM SSH host key lookup timed out (120-second limit)');
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
      JSON.stringify({ commands: [HOST_KEY_COMMAND] }),
      '--timeout-seconds',
      '120',
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
        throw refused('SSM returned a host key invocation for another target');
      if (invocation.Status === 'Success' && invocation.ResponseCode === 0)
        return ec2PublicKey(invocation.StandardOutputContent);
      if (!['Pending', 'InProgress', 'Delayed'].includes(invocation.Status))
        throw refused('SSM SSH host key command did not succeed');
    }
    await context.deps.sleep(Math.min(2000, remaining()));
  }
  throw refused('SSM SSH host key lookup timed out (120-second limit)');
}

/** Closes only this invocation's sessions; the random reason never carries a payload or credential. */
async function closeSessions(
  context: CloudContext,
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

/** SSH encryption carries stdin/streams through SSM; RunCommand reads only the public host key. */
export async function withEc2Host<T>(
  context: CloudContext,
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
    const host = createHostSession(context, instanceId, controller.signal, async () => {
      // EIC keys live for 60s: publish immediately before every connection, even after a long build.
      const published = (await call(
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
      if (!published.Success) throw refused('EC2 Instance Connect rejected the temporary public key');
      const reason = `projectman-cloud-${randomUUID()}`;
      reasons.add(reason);
      const proxyArgs = new AwsCli(deps, context.config.aws).argv([
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
    });
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
