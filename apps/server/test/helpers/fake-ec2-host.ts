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
          case 'send-command':
            return ok({ Command: { CommandId: COMMAND_ID } });
          case 'get-command-invocation': {
            const pending = this.pending-- > 0;
            return ok({
              InstanceId: this.invocationTarget,
              CommandId: COMMAND_ID,
              Status: pending ? 'InProgress' : this.invocationStatus,
              ResponseCode: pending ? -1 : 0,
              StandardOutputContent: this.hostKey,
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
      pipe: (from, to) => {
        proxy((from.command === 'ssh' ? from : to).args);
        return base.pipe(from, to);
      },
      ...overrides,
    };
  }
}
