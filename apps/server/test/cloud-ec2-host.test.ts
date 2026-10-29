import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { loadConfig } from '../../../scripts/cloud/config';
import type { CloudContext } from '../../../scripts/cloud/context';
import {
  DIAGNOSTICS_COMMANDS,
  ec2HostBusyReason,
  ec2PublicKey,
  parseEc2Diagnostics,
  readEc2HostDiagnostics,
  withEc2Host,
} from '../../../scripts/cloud/ec2-host';
import { CloudTransportError } from '../../../scripts/cloud/errors';
import { Report } from '../../../scripts/cloud/report';
import {
  AUTH_DENIED,
  EC2_HOST_ID,
  EC2_HOST_KEY,
  Ec2HostWorld,
  HEALTHY_DIAGNOSTICS,
} from './helpers/fake-ec2-host';
import { SHA_NEW, SHA_OLD } from './helpers/fake-host';

let world: Ec2HostWorld;
beforeEach(() => {
  world = Ec2HostWorld.configured();
});
afterEach(() => world.cleanup());
const run = (...args: string[]) => runCloud(args, world.deps());
const calls = (operation: string) =>
  world.transportCalls.filter((call) => call.command === 'aws' && call.args.includes(operation));
const context = (): CloudContext => ({
  deps: world.deps(),
  config: loadConfig(world.configFile, world.home),
  report: new Report((line) => world.lines.push(line)),
  secretsDir: world.secretsDir,
  envFile: world.envFile,
});
const assertClean = () => {
  for (const dir of world.keyDirs) expect(fs.existsSync(dir)).toBe(false);
  for (const call of world.transportCalls.filter((call) => call.command === 'ssh-keygen'))
    expect(fs.existsSync(path.dirname(call.args[call.args.indexOf('-f') + 1]!))).toBe(false);
  expect(world.sessions).toEqual([]);
  expect(world.interruptHandlers.size).toBe(0);
};

describe('EC2 SSH through SSM', () => {
  it('pins the authenticated SSM host key and uses the explicit central target everywhere', async () => {
    const ctx = context();
    world.onOperation = (operation) => {
      if (operation === 'ssh' && world.keyDirs.length) {
        expect(fs.statSync(world.keyDirs[0]!).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(world.keyDirs[0]!, 'known_hosts')).mode & 0o777).toBe(0o600);
      }
    };
    await withEc2Host(ctx, async (host) => {
      expect(host.address).toBe(EC2_HOST_ID);
      await host.call('status');
    });
    for (const call of world.transportCalls.filter(
      (call) => call.command === 'aws' && call.args[0] !== '--version',
    ))
      expect(call.args.slice(0, 6)).toEqual([
        '--profile',
        'aroom',
        '--region',
        'eu-west-1',
        '--output',
        'json',
      ]);
    const send = calls('send-command')[0]!.args;
    expect(send[send.indexOf('--instance-ids') + 1]).toBe(EC2_HOST_ID);
    expect(send[send.indexOf('--document-name') + 1]).toBe('AWS-RunShellScript');
    expect(JSON.parse(send[send.indexOf('--parameters') + 1]!)).toEqual({
      commands: ['cat /etc/ssh/ssh_host_ed25519_key.pub'],
    });
    const eic = calls('send-ssh-public-key')[0]!.args;
    expect(eic).toEqual(
      expect.arrayContaining([
        '--instance-id',
        EC2_HOST_ID,
        '--availability-zone',
        'eu-west-1b',
        '--instance-os-user',
        'ubuntu',
        '--ssh-public-key',
        EC2_HOST_KEY,
      ]),
    );
    const proxy = world.proxies[0]!;
    expect(proxy.slice(0, 7)).toEqual([
      'aws',
      '--profile',
      'aroom',
      '--region',
      'eu-west-1',
      '--output',
      'json',
    ]);
    expect(proxy).toEqual(
      expect.arrayContaining([
        'ssm',
        'start-session',
        '--target',
        EC2_HOST_ID,
        '--document-name',
        'AWS-StartSSHSession',
        '--parameters',
        'portNumber=22',
      ]),
    );
    const host = world.hostCalls[0]!;
    expect(host.sshArgs.at(-1)).toBe(`ubuntu@${EC2_HOST_ID}`);
    expect(host.sshArgs).toEqual(
      expect.arrayContaining([
        '-F',
        '/dev/null',
        'StrictHostKeyChecking=yes',
        'IdentitiesOnly=yes',
        'GlobalKnownHostsFile=/dev/null',
        'PasswordAuthentication=no',
      ]),
    );
    expect(host.knownHosts).toBe(`${EC2_HOST_ID} ${EC2_HOST_KEY}\n`);
    expect(host.keyFile).toMatchObject({ mode: 0o600, exists: true });
    expect(
      world.transportCalls.some((call) =>
        call.args.some((arg) => /authorize-security-group-ingress|import-key-pair/.test(arg)),
      ),
    ).toBe(false);
    assertClean();
  });

  it('keeps cloud.env in SSH stdin and uploads only the public temporary key', async () => {
    expect(await run('deploy', '--ref', SHA_NEW)).toBe(0);
    expect(world.machine.envText).toBe(fs.readFileSync(world.envFile, 'utf8'));
    const payload = world.hostCalls.find((call) => call.subcommand === 'receive-env')!;
    expect(payload.input).toContain('fake-restic-password');
    for (const call of world.transportCalls) {
      expect(call.args.join(' ')).not.toContain('fake-restic-password');
      expect(call.args.join(' ')).not.toContain('FAKE-EC2-PRIVATE-KEY');
      if (call.command === 'aws') expect(call.options.input).toBeUndefined();
    }
    expect(world.output).not.toContain('fake-restic-password');
    expect(world.output).not.toContain('FAKE-EC2-PRIVATE-KEY');
    // Every connection (the load-gate probe included) gets its own freshly published key.
    expect(calls('send-ssh-public-key')).toHaveLength(world.sshAttempts.length);
    expect(world.sshAttempts[0]).toBe('probe');
    assertClean();
  });

  it('refreshes EIC immediately before connections even after a long build', async () => {
    world.onOperation = (operation) => {
      if (operation === 'ssh') world.clock += 90_000;
    };
    expect(await run('deploy', '--ref', SHA_NEW)).toBe(0);
    const connects = world.transportCalls.filter((call) => call.command === 'ssh' && call.args[0] !== '-V');
    for (const connect of connects) {
      const index = world.transportCalls.indexOf(connect);
      expect(world.transportCalls[index - 1]!.args).toContain('send-ssh-public-key');
    }
    assertClean();
  });

  it.each(['logs', 'ssh', 'rehearse', 'status', 'stop', 'start', 'rollback'])(
    'operates %s through SSM',
    async (command) => {
      world.machine.preload(SHA_NEW, 'new', { sha: SHA_OLD, ref: 'old' });
      expect(await run(command)).toBe(0);
      expect(world.proxies.length).toBeGreaterThan(0);
      assertClean();
    },
  );

  it('deploys, stops and pulls data with the existing streams', async () => {
    expect(await run('deploy', '--ref', SHA_NEW)).toBe(0);
    expect(world.hostCalls.slice(0, 3).map((call) => call.subcommand)).toEqual([
      'bootstrap',
      'receive-image',
      'receive-env',
    ]);
    expect(await run('stop')).toBe(0);
    const target = path.join(world.home, 'pulled');
    expect(await run('pull-data', '--to', target)).toBe(0);
    expect(fs.readFileSync(path.join(target, 'db.sqlite'), 'utf8')).toBe('sqlite');
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(world.pipes.at(-1)!.from.command).toBe('ssh');
    assertClean();
  });

  it('refuses pull-data from a running board and removes an interrupted partial download', async () => {
    const target = path.join(world.home, 'pulled');
    world.machine.running = true;
    expect(await run('pull-data', '--to', target)).toBe(2);
    expect(fs.existsSync(target)).toBe(false);
    world.machine.running = false;
    world.machine.hangOn = 'send-data';
    world.interruptDuring = 'send-data';
    expect(await run('pull-data', '--to', target)).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
    assertClean();
  });

  it('keeps the deployment rollback and restore warning', async () => {
    world.machine.preload(SHA_OLD, 'old');
    world.machine.unhealthyShas.add(SHA_NEW);
    expect(await run('deploy', '--ref', SHA_NEW)).toBe(1);
    expect(world.machine.current()!.sha).toBe(SHA_OLD);
    expect(world.output).toContain('point-in-time restore');
    assertClean();
  });
});

describe('refusal and cleanup', () => {
  it.each(['Offline', 'ConnectionLost', ''])('refuses SSM %s without a public fallback', async (status) => {
    world.online = status;
    expect(await run('logs')).toBe(2);
    expect(world.hostCalls).toEqual([]);
    expect(world.proxies).toEqual([]);
    assertClean();
  });
  it.each(['missing', 'ambiguous', 'foreign', 'stopped', 'bad-az', 'bad-id'])(
    'refuses a %s host',
    async (shape) => {
      const host = world.instances[0]!;
      if (shape === 'missing') world.instances = [];
      if (shape === 'ambiguous') world.instances.push({ ...host });
      if (shape === 'foreign') host.Tags[1]!.Value = 'false';
      if (shape === 'stopped') host.State.Name = 'stopped';
      if (shape === 'bad-az') host.Placement.AvailabilityZone = 'eu-west-1b; touch /tmp/evil';
      if (shape === 'bad-id') host.InstanceId = 'i-0123456789abcdef0%h';
      expect(await run('logs')).not.toBe(0);
      expect(world.hostCalls).toEqual([]);
      assertClean();
    },
  );
  it('shows stopped EC2 status without contacting SSH', async () => {
    world.instances[0]!.State.Name = 'stopped';
    expect(await run('status')).toBe(0);
    expect(world.output).toContain('the machine is stopped');
    expect(world.proxies).toEqual([]);
  });
  it.each(['session-manager-plugin', 'ssh', 'ssh-keygen'])('refuses missing %s', async (tool) => {
    world.missingTool = tool;
    expect(await run('logs')).toBe(2);
    assertClean();
  });
  it.each(['evil;touch', 'evil%h', '-aroom', "aroom'", 'aroom\n'])(
    'refuses an unsafe profile %s before calls',
    async (profile) => {
      const ctx = context();
      ctx.config.aws.profile = profile;
      await expect(withEc2Host(ctx, async () => undefined)).rejects.toThrow('safe, explicit');
      expect(world.transportCalls).toEqual([]);
    },
  );
  it.each(['ssh-rsa AAAA', `${EC2_HOST_KEY}\nevil`, 'ssh-ed25519 AAAA', `${EC2_HOST_KEY} bad\nkey`])(
    'refuses malformed public key %s',
    async (key) => {
      world.hostKey = key;
      expect(await run('logs')).toBe(2);
      expect(world.keyDirs).toEqual([]);
      expect(() => ec2PublicKey(key)).toThrow();
      assertClean();
    },
  );
  it.each(['send-command', 'get-command-invocation'])('omits raw %s failure output', async (operation) => {
    world.failOperation = operation;
    expect(await run('logs')).toBe(1);
    expect(world.output).not.toContain('sensitive-raw');
    assertClean();
  });
  it('bounds the public host key poll to 120 seconds', async () => {
    world.pending = 1000;
    const start = world.clock;
    expect(await run('logs')).toBe(2);
    expect(world.clock - start).toBeLessThanOrEqual(120_000);
    expect(world.output).toContain('timed out');
    expect(world.hostCalls).toEqual([]);
    assertClean();
  });
  it.each(['Failed', 'TimedOut', 'Cancelled', 'Success-other-target'])(
    'refuses %s host key invocation without its output',
    async (status) => {
      if (status === 'Success-other-target') world.invocationTarget = 'i-11111111111111111';
      else world.invocationStatus = status;
      world.hostKey = 'sensitive-raw-command-output';
      expect(await run('logs')).toBe(2);
      expect(world.output).not.toContain('sensitive-raw');
      assertClean();
    },
  );
  it('cleans temporary files when EIC rejects the key', async () => {
    world.eicSuccess = false;
    expect(await run('logs')).toBe(2);
    expect(world.hostCalls).toEqual([]);
    assertClean();
  });
  it('cleans on SSH failure, long-command Ctrl-C, and a failed stream', async () => {
    world.machine.failures.set('logs', { code: 255, stdout: '', stderr: 'host key mismatch' });
    expect(await run('logs')).toBe(1);
    assertClean();
    world.machine.hangOn = 'start';
    world.interruptDuring = 'start';
    expect(await run('deploy', '--ref', SHA_NEW)).toBe(1);
    assertClean();
    world.machine.running = false;
    world.pipeCode = 1;
    const target = path.join(world.home, 'partial');
    expect(await run('pull-data', '--to', target)).toBe(1);
    expect(fs.existsSync(target)).toBe(false);
    assertClean();
  });
  it.each(['get-command-invocation', 'send-ssh-public-key'])(
    'aborts a pending %s and removes files',
    async (operation) => {
      world.hangOperation = operation;
      world.onOperation = (current) => {
        if (current === operation) world.interrupt();
      };
      expect(await run('logs')).toBe(1);
      assertClean();
    },
  );
  it('reconciles delayed sessions and leaves other operators and targets alone', async () => {
    const foreign = [
      { SessionId: 'other-owner', Target: EC2_HOST_ID, Reason: 'other' },
      { SessionId: 'other-target', Target: 'i-11111111111111111', Reason: 'other' },
      { SessionId: 'prefix-only', Target: EC2_HOST_ID, Reason: 'other' },
    ];
    world.sessions.push(...foreign);
    world.sessions.push({ SessionId: 'missing-reason', Target: EC2_HOST_ID });
    world.onOperation = (operation) => {
      if (operation === 'describe-sessions') {
        const proxy = world.proxies[0]!;
        const ownReason = proxy[proxy.indexOf('--reason') + 1]!;
        foreign[1]!.Reason = ownReason;
        foreign[2]!.Reason = `${ownReason}-suffix`;
      }
    };
    world.visibilityDelay = 1;
    world.terminateFailures = 1;
    expect(await run('logs')).toBe(0);
    expect(world.sessions).toEqual([...foreign, { SessionId: 'missing-reason', Target: EC2_HOST_ID }]);
    expect(world.terminated).toEqual(['owner-1']);
    expect(world.cleanupReads).toBe(4);
  });
  it('uses unique reasons for concurrent connections and reads every page before termination', async () => {
    const foreign = [
      { SessionId: 'other-first', Target: EC2_HOST_ID, Reason: 'other' },
      { SessionId: 'other-second', Target: EC2_HOST_ID, Reason: 'other' },
    ];
    world.sessions.push(...foreign);
    world.sessionPageSize = 1;
    await withEc2Host(context(), async (host) => {
      await Promise.all([host.call('status'), host.call('logs')]);
    });
    const reasons = world.proxies.map((proxy) => proxy[proxy.indexOf('--reason') + 1]);
    expect(new Set(reasons).size).toBe(2);
    expect(world.terminated).toEqual(['owner-1', 'owner-2']);
    expect(world.sessions).toEqual(foreign);
    expect(calls('describe-sessions').some((call) => call.args.includes('--starting-token'))).toBe(true);
    expect(world.cleanupReads).toBe(8); // Four pages, then two complete two-page verification rounds.
    for (const dir of world.keyDirs) expect(fs.existsSync(dir)).toBe(false);
  });
  it('still finds a session after two empty snapshots and verifies termination with a fresh read', async () => {
    world.visibilityDelay = 2;
    expect(await run('logs')).toBe(0);
    expect(world.cleanupReads).toBe(4);
    expect(world.terminated).toEqual(['owner-1']);
    assertClean();
  });
  it('retries transient DescribeSessions errors and obtains three complete snapshots', async () => {
    world.describeFailures = 1;
    expect(await run('logs')).toBe(0);
    expect(world.cleanupReads).toBe(4);
    expect(world.output).not.toContain('sensitive-raw');
    assertClean();
  });
  it.each(['truncated', 'active', 'describe-failed'])(
    'refuses unverified %s cleanup within 30 seconds',
    async (failure) => {
      if (failure === 'truncated') world.truncatedSessions = true;
      if (failure === 'active') world.keepTerminatedActive = true;
      if (failure === 'describe-failed') world.describeFailures = 100;
      const start = world.clock;
      expect(await run('logs')).toBe(1);
      expect(world.output).toContain('SSM session cleanup failed');
      expect(world.clock - start).toBeLessThanOrEqual(30_000);
      expect(world.output).not.toContain('sensitive-raw');
      for (const dir of world.keyDirs) expect(fs.existsSync(dir)).toBe(false);
      expect(world.interruptHandlers.size).toBe(0);
    },
  );
  it('preserves the original operation error when cleanup also fails', async () => {
    world.machine.failures.set('logs', { code: 255, stdout: '', stderr: 'host key mismatch' });
    world.terminateFailures = 100;
    expect(await run('logs')).toBe(1);
    expect(world.output).toContain('host key mismatch');
    expect(world.output).toContain('SSM session cleanup failed');
  });
  it('reports failed cleanup, removes keys and unregisters interrupt handlers', async () => {
    world.terminateFailures = 99;
    expect(await run('logs')).toBe(1);
    expect(world.output).toContain('SSM session cleanup failed');
    expect(world.output).not.toContain('sensitive-raw');
    for (const dir of world.keyDirs) expect(fs.existsSync(dir)).toBe(false);
    expect(world.interruptHandlers.size).toBe(0);
  });
  it('keeps dry-run free of transport writes and public-port promises', async () => {
    expect(await run('deploy', '--dry-run', '--ref', SHA_NEW)).toBe(0);
    expect(world.output).toContain('connect by SSH through SSM');
    expect(world.output).not.toContain('open the SSH port');
    expect(world.transportCalls).toEqual([]);
  });
});

describe('load and authentication faults (PM-748)', () => {
  const deny = (kind: string, count = 1, extra: { takes?: number; onHit?: () => void } = {}) => {
    for (let index = 0; index < count; index += 1)
      world.sshFaults.push({ kind, result: { ...AUTH_DENIED }, ...extra });
  };
  const loaded = (extra: Record<string, string>) => {
    world.diagnostics = [{ ...HEALTHY_DIAGNOSTICS, ...extra }];
  };
  const failure = async (work: () => Promise<unknown>): Promise<CloudTransportError> => {
    const error = await work().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CloudTransportError);
    return error as CloudTransportError;
  };
  const attempts = (kind: string) => world.sshAttempts.filter((attempt) => attempt === kind).length;
  const statusOnce = () => withEc2Host(context(), (host) => host.call('status'));

  it('recovers a read from two authentication failures with 5 s and 15 s waits and a fresh key each time', async () => {
    const foreign = { SessionId: 'other', Target: EC2_HOST_ID, Reason: 'other' };
    world.sessions.push(foreign);
    deny('status', 2);
    const start = world.clock;
    let waited = 0;
    await withEc2Host(context(), async (host) => {
      await host.call('status');
      waited = world.clock - start; // before the cleanup's own waits
    });
    expect(attempts('status')).toBe(3);
    expect(waited).toBe(20_000);
    expect(calls('send-ssh-public-key')).toHaveLength(3);
    // Each attempt had its own session reason; only ours were closed.
    expect(world.terminated).toEqual(['owner-1', 'owner-2', 'owner-3']);
    expect(world.sessions).toEqual([foreign]);
    expect(world.diagnosticsReads).toBe(0);
  });

  it('proves an EIC timeout only with the host journal, and keeps the diagnosis apart from the suspected cause', async () => {
    deny('status', 3);
    loaded({ load1: '9.00', eic: '4' });
    const start = world.clock;
    const error = await failure(statusOnce);
    expect(error.code).toBe('cloud_ssh_auth_timeout');
    expect(error.commandStarted).toBe('no');
    expect(error.retryable).toBe(true);
    expect(error.exitCode).toBe(1);
    expect(attempts('status')).toBe(3);
    expect(world.clock - start).toBeLessThanOrEqual(120_000);
    expect(error.message).toContain('Connection diagnosis: SSH public-key authentication was rejected and');
    expect(error.message).toContain('4 EIC authorized-keys timeouts (status 124)');
    expect(error.message).toContain('Suspected cause (not proven): 1-minute load 9 is above 2x its 2 CPUs');
    expect(error.message).toContain('oomKillsSinceBoot is cumulative');
    assertClean();
  });

  it.each([
    ['no journal evidence', { eic: '0' }, 'does not prove the cause'],
    ['an unreadable journal', { eic: 'unavailable' }, 'host diagnostics are unavailable'],
  ])('does not claim an EIC timeout with %s', async (_name, extra, text) => {
    deny('status', 3);
    loaded(extra);
    const error = await failure(statusOnce);
    expect(error.code).toBe('cloud_ssh_unavailable');
    expect(error.message).toContain(text);
    expect(error.message).not.toContain('sensitive-raw');
  });

  it('gives up when the time budget is used, children included', async () => {
    deny('status', 3, { takes: 50_000 });
    loaded({ eic: '2' });
    const start = world.clock;
    const error = await failure(statusOnce);
    expect(attempts('status')).toBe(2);
    expect(world.clock - start).toBeLessThanOrEqual(120_000);
    expect(error.message).toContain('2 attempts');
  });

  it('never retries a foreign host key', async () => {
    world.sshFaults.push({
      kind: 'status',
      result: { code: 255, stdout: '', stderr: 'Host key verification failed.\n' },
    });
    const error = await failure(statusOnce);
    expect(error.code).toBe('cloud_host_identity_mismatch');
    expect(error.retryable).toBe(false);
    expect(error.exitCode).toBe(2);
    expect(attempts('status')).toBe(1);
    expect(world.diagnosticsReads).toBe(0);
    assertClean();
  });

  it('does not retry a read that is not on the explicit list', async () => {
    world.sshFaults.push({
      kind: 'logs',
      result: { code: 255, stdout: '', stderr: 'Connection timed out during banner exchange\n' },
    });
    const error = await failure(() => withEc2Host(context(), (host) => host.call('logs', ['5'])));
    expect(error.code).toBe('cloud_ssh_unavailable');
    expect(error.commandStarted).toBe('unknown');
    expect(attempts('logs')).toBe(1);
  });

  it('retries a failed EIC key upload for a read, with no connection', async () => {
    world.failOperation = 'send-ssh-public-key';
    const error = await failure(statusOnce);
    expect(error.code).toBe('cloud_ssh_unavailable');
    expect(calls('send-ssh-public-key')).toHaveLength(3);
    expect(world.hostCalls).toEqual([]);
    expect(error.message).not.toContain('sensitive-raw');
    assertClean();
  });

  it('stops at Ctrl-C without another attempt and still cleans up', async () => {
    deny('status', 3, { onHit: () => world.interrupt() });
    await expect(statusOnce()).rejects.toThrow('interrupted');
    expect(attempts('status')).toBe(1);
    assertClean();
  });

  it('keeps the transport failure and a failed cleanup visible without secrets', async () => {
    deny('status', 3);
    world.terminateFailures = 100;
    expect(await run('status')).toBe(1);
    expect(world.output).toContain('Connection diagnosis');
    expect(world.output).toContain('SSM session cleanup failed');
    expect(world.output).not.toContain('sensitive-raw');
    expect(world.output).not.toContain('FAKE-EC2-PRIVATE-KEY');
  });

  describe('before a state change', () => {
    const stopOnce = () => withEc2Host(context(), (host) => host.call('stop'));

    it('waits for a busy machine and proceeds when the load falls', async () => {
      world.diagnostics = [{ ...HEALTHY_DIAGNOSTICS, load1: '5.00' }, { ...HEALTHY_DIAGNOSTICS }];
      const start = world.clock;
      let waited = 0;
      await withEc2Host(context(), async (host) => {
        await host.call('stop');
        waited = world.clock - start;
      });
      expect(world.diagnosticsReads).toBe(2);
      expect(waited).toBe(5_000);
      expect(world.hostCalls.map((call) => call.subcommand)).toEqual(['stop']);
      assertClean();
    });

    it.each([
      ['load', { load1: '4.01' }, 'load 4.01'],
      ['memory', { mem_kb: '131071' }, '127 MiB'],
    ])('refuses after the bounded wait when %s stays high', async (_name, extra, text) => {
      loaded(extra);
      const start = world.clock;
      const error = await failure(stopOnce);
      expect(error.code).toBe('cloud_host_busy');
      expect(error.commandStarted).toBe('no');
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain(text);
      expect(world.diagnosticsReads).toBe(3);
      expect(world.clock - start).toBe(20_000);
      expect(world.sshAttempts).toEqual([]);
      expect(world.hostCalls).toEqual([]);
      assertClean();
    });

    it('treats the limits as exclusive and reads are never gated', async () => {
      loaded({ load1: '4.00', mem_kb: '131072' });
      await stopOnce();
      expect(world.hostCalls.map((call) => call.subcommand)).toEqual(['stop']);
      loaded({ load1: '99.00' });
      world.hostCalls.length = 0;
      await statusOnce();
      expect(world.hostCalls.map((call) => call.subcommand)).toEqual(['status']);
    });

    it('refuses a blind change when the diagnostics cannot be read', async () => {
      world.diagnosticsStatus = 'Failed';
      const error = await failure(stopOnce);
      expect(error.exitCode).toBe(2);
      expect(error.commandStarted).toBe('no');
      expect(error.message).toContain('refused without a load measurement');
      expect(world.hostCalls).toEqual([]);
      expect(world.sshAttempts).toEqual([]);
      world.hostCalls.length = 0;
      await statusOnce(); // reading stays possible
      expect(world.hostCalls).toHaveLength(1);
    });

    it('refuses a diagnostics answer from another instance without retrying', async () => {
      world.invocationTarget = 'i-11111111111111111';
      const error = await failure(() =>
        readEc2HostDiagnostics(context(), EC2_HOST_ID, new AbortController().signal),
      );
      expect(error.code).toBe('cloud_host_identity_mismatch');
      expect(error.retryable).toBe(false);
    });

    it('checks the load once per session and probes the connection before the first change', async () => {
      await withEc2Host(context(), async (host) => {
        await host.call('stop');
        await host.call('stop');
      });
      expect(world.diagnosticsReads).toBe(1);
      expect(world.sshAttempts).toEqual(['probe', 'stop', 'stop']);
    });

    it('recovers a probe from authentication failures but never runs the change early', async () => {
      deny('probe', 2);
      await stopOnce();
      expect(world.sshAttempts).toEqual(['probe', 'probe', 'probe', 'stop']);
    });

    it('refuses the change when the probe keeps failing, saying the command never started', async () => {
      deny('probe', 3);
      loaded({ eic: '3' });
      const error = await failure(stopOnce);
      expect(error.code).toBe('cloud_ssh_auth_timeout');
      expect(error.commandStarted).toBe('no');
      expect(world.hostCalls).toEqual([]);
      assertClean();
    });

    it.each(['receive-env', 'start', 'bootstrap'] as const)(
      'calls %s exactly once when its answer is lost, and reports an unknown start',
      async (subcommand) => {
        world.sshFaults.push({
          kind: subcommand,
          result: {
            code: 255,
            stdout: '',
            stderr: 'Connection to i-0123456789abcdef0 closed by remote host.\n',
          },
          execute: true,
        });
        const args = subcommand === 'start' ? [SHA_NEW, 'new'] : [];
        const error = await failure(() =>
          withEc2Host(context(), (host) =>
            host.call(subcommand, args, subcommand === 'receive-env' ? { input: 'A=1\n' } : {}),
          ),
        );
        expect(error.commandStarted).toBe('unknown');
        expect(error.retryable).toBe(false);
        expect(error.message).toContain('reconcile');
        expect(attempts(subcommand)).toBe(1);
        expect(world.hostCalls.filter((call) => call.subcommand === subcommand)).toHaveLength(1);
        assertClean();
      },
    );

    it.each([
      [
        'after remote output',
        'removed volume data\nubuntu@i-0123456789abcdef0: Permission denied (publickey).\n',
      ],
      ['inside a remote message', 'git: remote said Permission denied (publickey) for the registry\n'],
    ])(
      'does not read a remote stderr that mentions a key refusal (%s) as a retryable auth failure',
      async (_name, stderr) => {
        world.sshFaults.push({ kind: 'start', result: { code: 255, stdout: '', stderr }, execute: true });
        const error = await failure(() =>
          withEc2Host(context(), (host) => host.call('start', [SHA_NEW, 'new'])),
        );
        expect(error.code).toBe('cloud_ssh_unavailable');
        expect(error.commandStarted).toBe('unknown');
        expect(error.retryable).toBe(false);
        expect(attempts('start')).toBe(1);
        assertClean();
      },
    );

    it('still reads the ssh client refusal of a state change as a command that never started', async () => {
      world.sshFaults.push({
        kind: 'start',
        result: {
          code: 255,
          stdout: '',
          stderr:
            "Warning: Permanently added 'i-0123456789abcdef0' (ED25519) to the list of known hosts.\n" +
            'ubuntu@i-0123456789abcdef0: Permission denied (publickey).\n',
        },
      });
      const error = await failure(() =>
        withEc2Host(context(), (host) => host.call('start', [SHA_NEW, 'new'])),
      );
      expect(error.message).toContain('public-key authentication was rejected');
      expect(error.commandStarted).toBe('no');
      expect(error.retryable).toBe(true);
      assertClean();
    });

    it('calls a lost receive-image stream once and reports an unknown start', async () => {
      const file = path.join(world.home, 'image.tar');
      fs.writeFileSync(file, 'archive');
      world.sshFaults.push({
        kind: 'receive-image',
        result: { code: 255, stdout: '', stderr: 'client_loop: send disconnect: Broken pipe\n' },
        execute: false,
      });
      const ctx = context();
      const error = await failure(() =>
        withEc2Host(ctx, async (host) => {
          const stream = await host.command('receive-image', [
            'a'.repeat(40),
            'linux/amd64',
            '7',
            'b'.repeat(64),
            'sha256:' + 'c'.repeat(64),
          ]);
          const result = await ctx.deps.pipe({ command: 'cat', args: [file] }, stream);
          const lost = host.transportError('receive-image', result);
          if (lost) throw lost;
        }),
      );
      expect(error.commandStarted).toBe('unknown');
      expect(error.retryable).toBe(false);
      expect(attempts('receive-image')).toBe(1);
      assertClean();
    });
  });

  describe('diagnostics contract', () => {
    const answer = (changes: Record<string, string | null> = {}) =>
      `${Object.entries({ ...HEALTHY_DIAGNOSTICS, ...changes })
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`;

    it('sends only the fixed read-only commands', async () => {
      await readEc2HostDiagnostics(context(), EC2_HOST_ID, new AbortController().signal);
      const params = JSON.parse(calls('send-command')[0]!.args.at(-3) ?? 'null') as unknown;
      expect(params).toEqual({ commands: [...DIAGNOSTICS_COMMANDS] });
      const text = DIAGNOSTICS_COMMANDS.join('\n');
      expect(text).not.toMatch(/\b(?:rm|kill|reboot|shutdown|systemctl|tee|mv|chmod|curl|wget)\b/);
    });

    it('parses the answer into the strict contract', () => {
      expect(parseEc2Diagnostics(answer())).toEqual({
        sampledAt: '2026-10-12T12:00:00Z',
        cpuCount: 2,
        load1: 0.5,
        availableMemoryBytes: 2_000_000 * 1024,
        freeDiskBytes: 5_000_000 * 1024,
        oomKills: 0,
        eicTimeouts10m: 0,
      });
    });

    it.each([
      ['a missing line', answer({ eic: null })],
      ['an unreadable journal', answer({ eic: 'unavailable' })],
      ['an empty value', answer({ mem_kb: '' })],
      ['zero CPUs', answer({ cpu: '0' })],
      ['a non-number load', answer({ load1: 'high' })],
      ['a bad time', answer({ at: 'yesterday' })],
      ['an extra line', `${answer()}extra=1\n`],
      ['an oversize answer', `${answer()}${'x'.repeat(600)}`],
      ['a reordered answer', answer().split('\n').reverse().join('\n')],
    ])('refuses %s instead of inventing a value', (_name, text) => {
      expect(() => parseEc2Diagnostics(text)).toThrow(CloudTransportError);
      try {
        parseEc2Diagnostics(text);
      } catch (error) {
        expect((error as CloudTransportError).retryable).toBe(false);
        expect((error as Error).message).not.toContain('xxxx');
      }
    });

    it('calls a machine busy above twice its CPUs or below 128 MiB', () => {
      const base = parseEc2Diagnostics(answer());
      expect(ec2HostBusyReason(base)).toBeNull();
      expect(ec2HostBusyReason({ ...base, load1: 4 })).toBeNull();
      expect(ec2HostBusyReason({ ...base, load1: 4.01 })).toContain('load 4.01');
      expect(ec2HostBusyReason({ ...base, availableMemoryBytes: 128 * 1024 * 1024 })).toBeNull();
      expect(ec2HostBusyReason({ ...base, availableMemoryBytes: 128 * 1024 * 1024 - 1 })).toContain('MiB');
    });
  });
});
