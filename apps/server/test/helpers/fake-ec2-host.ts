import fs from 'node:fs';
import type { CloudDeps, RunOptions } from '../../../../scripts/cloud/deps';
import { ACCOUNT, baseConfig } from './fake-aws';
import { EC2_CONFIG } from './fake-ec2';
import { HostWorld, unquoteWords } from './fake-host';

export const EC2_HOST_ID = 'i-0123456789abcdef0';
export const EC2_HOST_KEY = `ssh-ed25519 ${Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from('ssh-ed25519'),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 1),
]).toString('base64')}`;
const COMMAND_ID = '12345678-1234-4234-8234-123456789012';
const flag = (args: string[], key: string) => args[args.indexOf(key) + 1]!;
export const HEALTHY_DIAGNOSTICS: Record<string, string> = {
  at: '2026-10-12T12:00:00Z',
  cpu: '2',
  load1: '0.50',
  mem_kb: '2000000',
  disk_kb: '5000000',
  oom: '0',
  eic: '0',
};
export const AUTH_DENIED = {
  code: 255,
  stdout: '',
  stderr: 'ubuntu@i-0123456789abcdef0: Permission denied (publickey).\n',
};

/** A scripted failure of one SSH connection. `execute` lets the machine run the command first (a lost answer). */
interface SshFault {
  kind: string;
  result: { code: number; stdout: string; stderr: string };
  execute?: boolean;
  /** Fake wall-clock time the failing attempt takes. */
  takes?: number;
  onHit?: () => void;
}

/** Stateful AWS/SSM/EIC/SSH/plugin world. All payload handling reuses the host.sh fake. */
export class Ec2HostWorld extends HostWorld {
  readonly transportCalls: { command: string; args: string[]; options: RunOptions }[] = [];
  readonly proxies: string[][] = [];
  readonly keyDirs: string[] = [];
  readonly terminated: string[] = [];
  instances = [
    {
      InstanceId: EC2_HOST_ID,
      State: { Name: 'running' },
      Placement: { AvailabilityZone: 'eu-west-1b' },
      Tags: [
        { Key: 'Name', Value: 'projectman-cloud' },
        { Key: 'ProjectmanManaged', Value: 'true' },
      ],
    },
  ];
  online = 'Online';
  hostKey = `${EC2_HOST_KEY} root@host\n`;
  invocationTarget = EC2_HOST_ID;
  pending = 0;
  invocationStatus = 'Success';
  eicSuccess = true;
  missingTool: string | null = null;
  failOperation: string | null = null;
  sessions: { SessionId: string; Target: string; Reason?: string }[] = [];
  visibilityDelay = 0;
  cleanupReads = 0;
  describeFailures = 0;
  sessionPageSize = 0;
  truncatedSessions = false;
  keepTerminatedActive = false;
  terminateFailures = 0;
  hangOperation: string | null = null;
  onOperation: ((operation: string) => void) | undefined;
  /** What the machine's load looks like; each entry answers one diagnostics read, the last one repeats. */
  diagnostics: Record<string, string>[] = [{ ...HEALTHY_DIAGNOSTICS }];
  /** Replaces the whole diagnostics answer (a malformed one). */
  diagnosticsOutput: string | null = null;
  diagnosticsStatus = 'Success';
  diagnosticsReads = 0;
  /** The answer of the latest SSM command, chosen when it was sent. */
  private commandOutput = '';
  private commandIsDiagnostics = false;
  /** Connection attempts by kind: a subcommand, `probe` or `shell`. */
  readonly sshAttempts: string[] = [];
  /** Scripted connection failures, consumed in order by the first attempt of a matching kind. */
  sshFaults: SshFault[] = [];

  static configured(): Ec2HostWorld {
    const world = Ec2HostWorld.ready();
    world.aws.accounts.set('aroom', ACCOUNT);
    world.writeConfig({
      aws: { ...(baseConfig().aws as object), compute: 'ec2', profile: 'aroom', ec2: EC2_CONFIG },
      route53: { profile: 'i' },
    });
    return world;
  }

  override deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
    const base = super.deps();
    const ok = (value: unknown = {}) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    const proxy = (args: string[]) => {
      const words = unquoteWords(
        args.find((arg) => arg.startsWith('ProxyCommand='))!.slice('ProxyCommand=exec '.length),
      );
      this.proxies.push(words);
      this.sessions.push({
        SessionId: `owner-${this.proxies.length}`,
        Target: flag(words, '--target'),
        Reason: flag(words, '--reason'),
      });
    };
    return {
      ...base,
      run: async (command, args, options = {}) => {
        this.transportCalls.push({ command, args, options });
        const operation = command === 'aws' ? args[args.indexOf('--no-cli-auto-prompt') + 2] : command;
        this.onOperation?.(operation!);
        if (this.hangOperation === operation)
          return new Promise((resolve) => {
            const finish = () => resolve({ code: 130, stdout: '', stderr: '' });
            if (options.signal?.aborted) finish();
            else options.signal?.addEventListener('abort', finish, { once: true });
          });
        if (this.missingTool === command) return { code: 127, stdout: '', stderr: 'not found' };
        if (this.failOperation === operation)
          return { code: 254, stdout: 'sensitive-raw-output', stderr: 'sensitive-raw-error' };
        if (command === 'aws' && args[0] === '--version')
          return { code: 0, stdout: 'aws-cli/2.37.9', stderr: '' };
        if (command === 'session-manager-plugin' || (command === 'ssh' && args[0] === '-V')) return ok();
        if (command === 'ssh-keygen') {
          const key = flag(args, '-f');
          fs.writeFileSync(key, 'FAKE-EC2-PRIVATE-KEY', { mode: 0o600 });
          fs.writeFileSync(`${key}.pub`, `${EC2_HOST_KEY} projectman-cloud\n`);
          this.keyDirs.push(key.slice(0, key.lastIndexOf('/')));
          return ok();
        }
        if (command === 'ssh') {
          proxy(args);
          const fault = this.fault(args);
          if (fault) {
            if (fault.execute) await base.run(command, args, options);
            this.clock += fault.takes ?? 0;
            fault.onHit?.();
            return fault.result;
          }
          if (args.at(-1) === 'true') return { code: 0, stdout: '', stderr: '' };
          return base.run(command, args, options);
        }
        if (command !== 'aws') return base.run(command, args, options);
        switch (operation) {
          case 'describe-instances':
            return ok({ Reservations: [{ Instances: this.instances }] });
          case 'describe-instance-information':
            return ok({
              InstanceInformationList: this.online
                ? [{ InstanceId: EC2_HOST_ID, PingStatus: this.online }]
                : [],
            });
          case 'send-command': {
            const commands = (JSON.parse(flag(args, '--parameters')) as { commands: string[] }).commands;
            this.commandIsDiagnostics = commands.some((line) => line.includes('nproc'));
            if (this.commandIsDiagnostics) {
              this.diagnosticsReads += 1;
              const entry =
                this.diagnostics.length > 1 ? this.diagnostics.shift()! : (this.diagnostics[0] ?? {});
              this.commandOutput =
                this.diagnosticsOutput ??
                `${['at', 'cpu', 'load1', 'mem_kb', 'disk_kb', 'oom', 'eic'].map((key) => `${key}=${entry[key]}`).join('\n')}\n`;
            } else this.commandOutput = this.hostKey;
            return ok({ Command: { CommandId: COMMAND_ID } });
          }
          case 'get-command-invocation': {
            const pending = this.pending-- > 0;
            return ok({
              InstanceId: this.invocationTarget,
              CommandId: COMMAND_ID,
              Status: pending
                ? 'InProgress'
                : this.commandIsDiagnostics
                  ? this.diagnosticsStatus
                  : this.invocationStatus,
              ResponseCode: pending ? -1 : 0,
              StandardOutputContent: this.commandOutput,
            });
          }
          case 'send-ssh-public-key':
            return ok({ Success: this.eicSuccess });
          case 'describe-sessions': {
            this.cleanupReads += 1;
            if (this.describeFailures-- > 0)
              return { code: 254, stdout: '', stderr: 'sensitive-raw-describe-error' };
            if (this.visibilityDelay-- > 0) return ok({ Sessions: [] });
            if (this.truncatedSessions) return ok({ Sessions: [], NextToken: 'unending-token' });
            const start = args.includes('--starting-token') ? Number(flag(args, '--starting-token')) : 0;
            const end = this.sessionPageSize ? start + this.sessionPageSize : this.sessions.length;
            return ok({
              Sessions: this.sessions.slice(start, end),
              ...(end < this.sessions.length ? { NextToken: String(end) } : {}),
            });
          }
          case 'terminate-session': {
            if (this.terminateFailures-- > 0)
              return { code: 254, stdout: '', stderr: 'sensitive-raw-cleanup-error' };
            const id = flag(args, '--session-id');
            this.terminated.push(id);
            if (!this.keepTerminatedActive)
              this.sessions = this.sessions.filter((session) => session.SessionId !== id);
            return ok();
          }
          default:
            return base.run(command, args, options);
        }
      },
      pipe: async (from, to) => {
        const ssh = from.command === 'ssh' ? from : to;
        proxy(ssh.args);
        const fault = this.fault(ssh.args);
        if (fault) {
          if (fault.execute) await base.pipe(from, to);
          this.clock += fault.takes ?? 0;
          fault.onHit?.();
          return fault.result;
        }
        return base.pipe(from, to);
      },
      ...overrides,
    };
  }

  /** Records a connection attempt and returns its scripted failure, if one is waiting for its kind. */
  private fault(sshArgs: string[]): SshFault | undefined {
    const last = sshArgs.at(-1)!;
    const kind = last === 'true' ? 'probe' : last.includes('host.sh') ? unquoteWords(last)[5]! : 'shell';
    this.sshAttempts.push(kind);
    const index = this.sshFaults.findIndex((fault) => fault.kind === kind || fault.kind === '*');
    return index === -1 ? undefined : this.sshFaults.splice(index, 1)[0];
  }
}
