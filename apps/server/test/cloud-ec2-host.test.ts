import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { loadConfig } from '../../../scripts/cloud/config';
import type { CloudContext } from '../../../scripts/cloud/context';
import { ec2PublicKey, withEc2Host } from '../../../scripts/cloud/ec2-host';
import { Report } from '../../../scripts/cloud/report';
import { EC2_HOST_ID, EC2_HOST_KEY, Ec2HostWorld } from './helpers/fake-ec2-host';
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
const source = () => {
  const dir = path.join(world.home, 'package');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'db.sqlite'), 'database');
  return dir;
};
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
        call.args.some((arg) => /lightsail|authorize-security-group-ingress|import-key-pair/.test(arg)),
      ),
    ).toBe(false);
    expect(world.aws.callsTo('put-instance-public-ports')).toEqual([]);
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
    expect(calls('send-ssh-public-key')).toHaveLength(world.hostCalls.length);
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

  it('seeds an empty machine, deploys, stops and pulls data with the existing streams', async () => {
    world.aws.addBucket('acme-projectman-db');
    world.aws.addBucket('acme-projectman-backup');
    expect(await run('seed', '--from', source(), '--ref', SHA_NEW)).toBe(0);
    expect(world.hostCalls.slice(0, 5).map((call) => call.subcommand)).toEqual([
      'bootstrap',
      'seed-check',
      'receive-data',
      'seed-digest',
      'bootstrap',
    ]);
    expect(world.machine.receivedData).toMatch(/^tar /);
    expect(world.pipes[0]!.to.command).toBe('ssh');
    expect(world.pipes[0]!.to.signal).toBeDefined();
    expect(await run('stop')).toBe(0);
    const target = path.join(world.home, 'pulled');
    expect(await run('pull-data', '--to', target)).toBe(0);
    expect(fs.readFileSync(path.join(target, 'db.sqlite'), 'utf8')).toBe('sqlite');
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(world.pipes[1]!.from.command).toBe('ssh');
    assertClean();
  });

  it.each(['running', 'data', 'bucket', 'credentials'])('preserves the %s seed guard', async (guard) => {
    world.aws.addBucket('acme-projectman-db');
    world.aws.addBucket('acme-projectman-backup');
    const dir = source();
    if (guard === 'running') world.machine.running = true;
    if (guard === 'data') world.machine.dataEmpty = false;
    if (guard === 'bucket') world.aws.buckets.get('acme-projectman-db')!.objects = 1;
    if (guard === 'credentials') fs.mkdirSync(path.join(dir, 'providers'));
    expect(await run('seed', '--from', dir, '--ref', SHA_NEW)).toBe(2);
    expect(world.pipes).toHaveLength(0);
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
  it('shows stopped EC2 status without contacting SSH or Lightsail', async () => {
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
    world.machine.hangOn = 'build';
    world.interruptDuring = 'build';
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
