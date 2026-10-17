import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { parseTags } from '../../../scripts/cloud/machine';
import { HostWorld, SHA_NEW, SHA_NEWEST, SHA_OLD } from './helpers/fake-host';
import { Ec2HostWorld } from './helpers/fake-ec2-host';

/** `npm run cloud -- deploy | rollback | status | logs | ssh | stop | start | rehearse | seed | pull-data` (PM-535). */

const REPO_URL = 'https://github.com/janoist1/projectman.git';

let world: HostWorld;
beforeEach(() => {
  world = HostWorld.ready();
});
afterEach(() => world.cleanup());

const run = (...argv: string[]) => runCloud(argv, world.deps());
const subcommands = () => world.hostCalls.map((call) => call.subcommand);
const starts = () => world.hostCalls.filter((call) => call.subcommand === 'start').map((call) => call.args);
const everything = () => `${world.output}\n${world.errors.join('\n')}`;

describe('deploy', () => {
  it('builds and starts the newest release tag (numerically, the peeled commit) and waits for health', async () => {
    expect(await run('deploy')).toBe(0);
    expect(world.gitCalls[0]).toEqual(['ls-remote', '--tags', REPO_URL]);
    expect(world.machine.built).toEqual([{ sha: SHA_NEWEST, url: REPO_URL }]);
    expect(starts()).toEqual([[SHA_NEWEST, 'v2026.10.12']]);
    expect(subcommands().slice(0, 4)).toEqual(['bootstrap', 'receive-env', 'status', 'build']);
    expect(world.output).toContain(`ok ref: v2026.10.12 (${SHA_NEWEST})`);
    expect(world.output).toContain('ok health: v2026.10.12 is healthy');
    expect(world.machine.current()?.sha).toBe(SHA_NEWEST);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('orders release tags by number, not by text: v2026.10.11.4 is later than v2026.10.9 and v2026.9.30', async () => {
    world.tags = [
      { name: 'v2026.10.9', sha: 'd'.repeat(40) },
      { name: 'v2026.10.11.4', sha: 'e'.repeat(40) },
      { name: 'v2026.10.11', sha: 'a'.repeat(40) },
      { name: 'v2026.9.30', sha: 'f'.repeat(40) },
      { name: 'v1', sha: '1'.repeat(40) },
    ];
    expect(await run('deploy', '--dry-run')).toBe(0);
    expect(world.output).toContain(`ok ref: v2026.10.11.4 (${'e'.repeat(40)})`);
  });

  it('parses annotated and lightweight tags', () => {
    expect(
      parseTags(
        [
          `${'a'.repeat(40)}\trefs/tags/v1`,
          `${'b'.repeat(40)}\trefs/tags/v2`,
          `${'c'.repeat(40)}\trefs/tags/v2^{}`,
          'garbage',
        ].join('\n'),
      ),
    ).toEqual([
      { name: 'v1', sha: 'a'.repeat(40) },
      { name: 'v2', sha: 'c'.repeat(40) },
    ]);
  });

  it('takes --ref as a tag or as a commit id, and the commit id becomes the ref name', async () => {
    expect(await run('deploy', '--ref', 'v2026.9.30')).toBe(0);
    expect(starts()).toEqual([['f'.repeat(40), 'v2026.9.30']]);
    world.hostCalls.length = 0;
    world.machine.built.length = 0;
    expect(await run('deploy', '--ref', SHA_OLD)).toBe(0);
    expect(starts()).toEqual([[SHA_OLD, SHA_OLD]]);
  });

  it('refuses a tag that does not exist, a malformed --ref, and a repository without release tags', async () => {
    expect(await run('deploy', '--ref', 'v9.9.9')).toBe(2);
    expect(world.output).toContain('has no tag v9.9.9');
    expect(await run('deploy', '--ref', 'a b;rm')).toBe(2);
    world.tags = [{ name: 'latest', sha: SHA_OLD }];
    expect(await run('deploy')).toBe(2);
    expect(everything()).toContain('has no release tag');
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('fails (1) when the tags cannot be read', async () => {
    world.lsRemoteFails = true;
    expect(await run('deploy')).toBe(1);
    expect(everything()).toContain('git ls-remote');
    expect(world.hostCalls).toHaveLength(0);
  });

  it('sends cloud.env on the standard input only, never in an argument, and never prints a secret', async () => {
    expect(await run('deploy')).toBe(0);
    const received = world.hostCalls.find((call) => call.subcommand === 'receive-env')!;
    expect(received.input).toContain('LITESTREAM_SECRET_ACCESS_KEY=fakeSecretDb/');
    expect(received.args).toEqual([]);
    for (const call of world.hostCalls) {
      expect(call.remote).not.toContain('fakeSecretDb');
      expect(call.remote).not.toContain('tunnel-token-value');
      expect(call.sshArgs.join(' ')).not.toContain('fakeSecret');
    }
    expect(everything()).not.toContain('fakeSecret');
    expect(everything()).not.toContain('tunnel-token-value');
    expect(everything()).not.toContain('fake-restic-password');
    expect(world.machine.envText).toBe(received.input);
  });

  it('adds the configured release target to the cloud.env it sends, and leaves the local file alone (PM-749)', async () => {
    world.writeConfig({ releaseTarget: { projectKey: 'PM', repo: 'projectman' } });
    world.writeEnv('TUNNEL_TOKEN=tunnel-token-value-0123456789\nPROJECTMAN_RELEASE_TARGET=OLD/stale\n');
    const local = fs.readFileSync(world.envFile, 'utf8');
    expect(await run('deploy')).toBe(0);
    const sent = world.hostCalls.find((call) => call.subcommand === 'receive-env')!.input!;
    expect(sent.match(/^PROJECTMAN_RELEASE_TARGET=.*$/gm)).toEqual([
      'PROJECTMAN_RELEASE_TARGET=PM/projectman',
    ]);
    expect(sent).toContain('LITESTREAM_SECRET_ACCESS_KEY=fakeSecretDb/');
    expect(sent.endsWith('\n')).toBe(true);
    expect(fs.readFileSync(world.envFile, 'utf8')).toBe(local);
  });

  it('adds the hybrid engine and target hash to the cloud.env it sends, replacing stale lines (PM-752)', async () => {
    const hash = 'c'.repeat(64);
    world.writeConfig({
      releaseTarget: { projectKey: 'PM', repo: 'projectman' },
      hybrid: { engineId: 'eng_abcdefghijkl', targetHash: hash },
    });
    world.writeEnv(
      'TUNNEL_TOKEN=tunnel-token-value-0123456789\nPROJECTMAN_RELEASE_ENGINE_ID=eng_stale\nPROJECTMAN_RELEASE_TARGET_HASH=stale\n',
    );
    const local = fs.readFileSync(world.envFile, 'utf8');
    expect(await run('deploy')).toBe(0);
    const sent = world.hostCalls.find((call) => call.subcommand === 'receive-env')!.input!;
    expect(sent.match(/^PROJECTMAN_RELEASE_ENGINE_ID=.*$/gm)).toEqual([
      'PROJECTMAN_RELEASE_ENGINE_ID=eng_abcdefghijkl',
    ]);
    expect(sent.match(/^PROJECTMAN_RELEASE_TARGET_HASH=.*$/gm)).toEqual([
      `PROJECTMAN_RELEASE_TARGET_HASH=${hash}`,
    ]);
    expect(sent.endsWith('\n')).toBe(true);
    expect(fs.readFileSync(world.envFile, 'utf8')).toBe(local);
  });

  it('sends no hybrid lines when no hybrid binding is configured (PM-752)', async () => {
    world.writeConfig({ releaseTarget: { projectKey: 'PM', repo: 'projectman' } });
    expect(await run('deploy')).toBe(0);
    const sent = world.hostCalls.find((call) => call.subcommand === 'receive-env')!.input!;
    expect(sent).not.toContain('PROJECTMAN_RELEASE_ENGINE_ID');
    expect(sent).not.toContain('PROJECTMAN_RELEASE_TARGET_HASH');
  });

  it('sends cloud.env as it is when no release target is configured (PM-749)', async () => {
    const local = fs.readFileSync(world.envFile, 'utf8');
    expect(await run('deploy')).toBe(0);
    expect(world.hostCalls.find((call) => call.subcommand === 'receive-env')!.input).toBe(local);
  });

  it('never lets an invalid release target reach the machine (PM-749)', async () => {
    world.writeConfig({ releaseTarget: { projectKey: 'PM', repo: 'x\nPROJECTMAN_OWNER=evil' } });
    expect(await run('deploy')).toBe(2);
    expect(world.hostCalls).toHaveLength(0);
    expect(world.machine.envText).toBeNull();
  });

  it('sends the e-mail login settings of cloud.env with it and never prints their secrets (PM-669)', async () => {
    world.writeEnv(
      [
        'TUNNEL_TOKEN=tunnel-token-value-0123456789',
        'PROJECTMAN_EMAIL_LOGIN_ENABLED=1',
        'PROJECTMAN_SES_REGION=eu-central-1',
        'PROJECTMAN_SES_FROM=belepes@istvan.io',
        'PROJECTMAN_SES_ACCESS_KEY_ID=AKIASESEXAMPLE000001',
        'PROJECTMAN_SES_SECRET_ACCESS_KEY=ses-secret-example-value',
        'PROJECTMAN_SES_SESSION_TOKEN=ses-session-token-example',
        '',
      ].join('\n'),
    );
    expect(await run('deploy')).toBe(0);
    const received = world.hostCalls.find((call) => call.subcommand === 'receive-env')!;
    for (const line of [
      'PROJECTMAN_EMAIL_LOGIN_ENABLED=1',
      'PROJECTMAN_SES_REGION=eu-central-1',
      'PROJECTMAN_SES_SECRET_ACCESS_KEY=ses-secret-example-value',
      'PROJECTMAN_SES_SESSION_TOKEN=ses-session-token-example',
    ])
      expect(received.input).toContain(line);
    expect(received.args).toEqual([]);
    for (const call of world.hostCalls) {
      expect(call.remote).not.toContain('ses-secret-example-value');
      expect(call.sshArgs.join(' ')).not.toContain('ses-');
    }
    expect(everything()).not.toContain('ses-secret-example-value');
    expect(everything()).not.toContain('ses-session-token-example');
  });

  it('sends the systemd unit to bootstrap on the standard input', async () => {
    expect(await run('deploy')).toBe(0);
    const bootstrap = world.hostCalls.find((call) => call.subcommand === 'bootstrap')!;
    expect(bootstrap.input).toContain('[Service]');
    expect(bootstrap.input).toContain('ExecStart=/usr/bin/docker run');
  });

  it('refuses without cloud.env, before touching anything', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(world.envFile);
    expect(await run('deploy')).toBe(2);
    expect(everything()).toContain('run `npm run cloud -- aws` first');
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses a cloud.env that lacks the bucket keys', async () => {
    writeFileSync(world.envFile, 'TUNNEL_TOKEN=abcdefghijkl\n', { mode: 0o600 });
    expect(await run('deploy')).toBe(2);
    expect(everything()).toContain('has no LITESTREAM_BUCKET');
  });

  it('notes a missing TUNNEL_TOKEN but goes on', async () => {
    world.writeEnv('');
    expect(await run('deploy')).toBe(0);
    expect(world.output).toContain('cloud.env has no TUNNEL_TOKEN yet');
  });

  it('--dry-run reads only: no ssh, no firewall change', async () => {
    expect(await run('deploy', '--dry-run')).toBe(0);
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.output).toContain('skipped deploy: dry-run: would open the SSH port');
  });

  it('goes back to the previous image when the new one never becomes healthy, and warns about the migration', async () => {
    world.machine.preload(SHA_OLD, 'v2026.10.11.4');
    world.machine.unhealthyShas.add(SHA_NEWEST);
    expect(await run('deploy')).toBe(1);
    expect(starts()).toEqual([
      [SHA_NEWEST, 'v2026.10.12'],
      [SHA_OLD, 'v2026.10.11.4'],
    ]);
    expect(world.machine.current()?.sha).toBe(SHA_OLD);
    expect(world.output).toContain('did not become healthy in 180 s');
    expect(world.output).toContain('line two');
    expect(world.output).toContain('going back to v2026.10.11.4');
    expect(world.output).toContain('ok health: v2026.10.11.4 is healthy again');
    // The time the old board stopped before the new one started: the point to restore the database to.
    expect(world.output).toContain('restore the database to 2026-10-12T12:');
    expect(world.output).toContain('Litestream replica');
    expect(world.output).toContain('docs/AWS.md');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('fails without a rollback when there is no earlier image', async () => {
    world.machine.unhealthyShas.add(SHA_NEWEST);
    expect(await run('deploy')).toBe(1);
    expect(starts()).toEqual([[SHA_NEWEST, 'v2026.10.12']]);
    expect(world.output).toContain('there is no earlier image to go back to');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('does not go back to the same image', async () => {
    world.machine.preload(SHA_NEWEST, 'v2026.10.12');
    world.machine.unhealthyShas.add(SHA_NEWEST);
    expect(await run('deploy')).toBe(1);
    expect(starts()).toHaveLength(1);
  });

  it('fails when the build fails, and starts nothing', async () => {
    world.machine.failures.set('build', { code: 1, stdout: '', stderr: 'docker build failed\n' });
    expect(await run('deploy')).toBe(1);
    expect(starts()).toHaveLength(0);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('the build output goes to the terminal (inherit), the long timeouts are set', async () => {
    const stdio: (string | undefined)[] = [];
    const deps = world.deps();
    const base = deps.run;
    deps.run = (command, args, options) => {
      if (command === 'ssh' && args[args.length - 1]!.includes("'build'")) stdio.push(options?.stdio);
      return base(command, args, options);
    };
    expect(await runCloud(['deploy'], deps)).toBe(0);
    expect(stdio).toEqual(['inherit']);
  });
});

describe('rollback', () => {
  it('starts the previous image and prints the migration warning with the stop time', async () => {
    world.machine.preload(SHA_NEW, 'v2026.10.12', { sha: SHA_OLD, ref: 'v2026.10.11.4' });
    world.machine.deploy!.lastStoppedAt = '2026-10-12T09:30:00.000Z';
    expect(await run('rollback')).toBe(0);
    expect(starts()).toEqual([[SHA_OLD, 'v2026.10.11.4']]);
    expect(world.machine.deploy!.previous?.sha).toBe(SHA_NEW);
    expect(world.output).toContain('restore the database to 2026-10-12T09:30:00.000Z');
    expect(world.output).toContain('ok health: v2026.10.11.4 is healthy');
  });

  it('refuses when there is no previous image', async () => {
    world.machine.preload(SHA_NEW, 'v2026.10.12');
    expect(await run('rollback')).toBe(2);
    expect(everything()).toContain('no previous image');
    expect(starts()).toHaveLength(0);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('exits 1 when the previous image is unhealthy as well', async () => {
    world.machine.preload(SHA_NEW, 'v2026.10.12', { sha: SHA_OLD, ref: 'v2026.10.11.4' });
    world.machine.unhealthyShas.add(SHA_OLD);
    expect(await run('rollback')).toBe(1);
    expect(world.output).toContain('did not become healthy');
  });

  it('--dry-run does not connect', async () => {
    expect(await run('rollback', '--dry-run')).toBe(0);
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
  });
});

describe('status, logs, ssh', () => {
  it('prints the machine, the unit, the container, the history, the disk and the memory', async () => {
    world.machine.preload(SHA_NEW, 'v2026.10.12', { sha: SHA_OLD, ref: 'v2026.10.11.4' });
    expect(await run('status')).toBe(0);
    expect(world.output).toContain('ok machine: projectman-cloud: running');
    expect(world.output).toContain('unit: active');
    expect(world.output).toContain(`container: running, healthy, projectman-cloud:${SHA_NEW}`);
    expect(world.output).toContain('current: v2026.10.12 (bbbbbbbbbbbb)');
    expect(world.output).toContain('previous: v2026.10.11.4 (aaaaaaaaaaaa)');
    expect(world.output).toContain('last stopped: never recorded');
    expect(world.output).toContain('data: 1.0 MiB, free disk: 12.0 GiB');
    expect(world.output).toContain('swap 0 B of 2.0 GiB');
  });

  it('says so when the machine is not running, without connecting', async () => {
    world.aws.instance!.state = 'stopped';
    expect(await run('status')).toBe(0);
    expect(world.output).toContain('ok machine: projectman-cloud: stopped');
    expect(world.output).toContain('skipped host: the machine is stopped');
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses when the machine does not exist', async () => {
    world.aws.instance = null;
    expect(await run('status')).toBe(2);
    expect(everything()).toContain('there is no machine projectman-cloud');
  });

  it('logs prints the lines, 200 by default and --lines otherwise', async () => {
    expect(await run('logs')).toBe(0);
    expect(world.hostCalls[0]!.args).toEqual(['200']);
    expect(world.output).toContain('line one');
    world.hostCalls.length = 0;
    expect(await run('logs', '--lines', '15')).toBe(0);
    expect(world.hostCalls[0]!.args).toEqual(['15']);
  });

  it('logs refuses a bad --lines as bad usage', async () => {
    for (const bad of ['0', '-1', 'ten', '10001', '1e3']) {
      expect(await run('logs', '--lines', bad)).toBe(64);
    }
    expect(world.hostCalls).toHaveLength(0);
  });

  it('ssh opens an interactive shell with the same safe options', async () => {
    expect(await run('ssh')).toBe(0);
    expect(world.shells).toHaveLength(1);
    expect(world.shells[0]).toContain('StrictHostKeyChecking=yes');
    expect(world.shells[0]![world.shells[0]!.length - 1]).toBe('ubuntu@203.0.113.7');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('ssh ignores the exit status of the last command typed in the shell', async () => {
    const deps = world.deps({
      run: async (command, args, options) => {
        if (command === 'ssh') return { code: 1, stdout: '', stderr: '' };
        return world.deps().run(command, args, options);
      },
    });
    expect(await runCloud(['ssh'], deps)).toBe(0);
  });

  it('ssh fails when ssh itself cannot connect (status 255)', async () => {
    const deps = world.deps({
      run: async (command, args, options) => {
        if (command === 'ssh') return { code: 255, stdout: '', stderr: 'no route' };
        return world.deps().run(command, args, options);
      },
    });
    expect(await runCloud(['ssh'], deps)).toBe(1);
    expect(world.firewallIsClosed()).toBe(true);
  });
});

describe('stop, start, rehearse', () => {
  it('stop stops the board; start brings the current image back and waits for health', async () => {
    world.machine.preload(SHA_NEW, 'v2026.10.12');
    expect(await run('stop')).toBe(0);
    expect(world.machine.running).toBe(false);
    expect(world.machine.deploy!.lastStoppedAt).not.toBeNull();
    expect(await run('start')).toBe(0);
    expect(world.machine.running).toBe(true);
    expect(starts()).toEqual([[SHA_NEW, 'v2026.10.12']]);
    expect(world.output).toContain('ok health: v2026.10.12 is healthy');
  });

  it('start refuses when nothing was ever deployed', async () => {
    expect(await run('start')).toBe(2);
    expect(everything()).toContain('nothing has been deployed yet');
  });

  it('start prints the log and exits 1 when the board does not become healthy', async () => {
    world.machine.preload(SHA_NEW, 'v2026.10.12');
    world.machine.unhealthyShas.add(SHA_NEW);
    expect(await run('start')).toBe(1);
    expect(world.output).toContain('line two');
  });

  it('stop and start --dry-run do not connect', async () => {
    expect(await run('stop', '--dry-run')).toBe(0);
    expect(await run('start', '--dry-run')).toBe(0);
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('rehearse passes only on REHEARSAL PASSED', async () => {
    expect(await run('rehearse')).toBe(0);
    expect(world.output).toContain('ok rehearse: REHEARSAL PASSED');
    world.machine.rehearsalOutput = 'it went fine, honestly\n';
    expect(await run('rehearse')).toBe(1);
    world.machine.rehearsalOutput = 'REHEARSAL FAILED: restore\n';
    world.machine.rehearsalCode = 1;
    expect(await run('rehearse')).toBe(1);
    expect(world.firewallIsClosed()).toBe(true);
  });
});

describe('seed', () => {
  let source: string;
  beforeEach(() => {
    source = mkdtempSync(path.join(world.home, 'package-'));
    writeFileSync(path.join(source, 'db.sqlite'), 'sqlite');
    mkdirSync(path.join(source, 'secrets'));
    world.aws.addBucket('acme-projectman-db');
    world.aws.addBucket('acme-projectman-backup');
  });

  it('refuses when a bucket does not exist yet', async () => {
    world.aws.buckets.delete('acme-projectman-backup');
    expect(await run('seed', '--from', source)).toBe(2);
    expect(everything()).toContain('acme-projectman-backup does not exist');
    expect(world.hostCalls).toHaveLength(0);
  });

  it('uploads the package into the empty data directory, then deploys', async () => {
    expect(await run('seed', '--from', source)).toBe(0);
    expect(subcommands().slice(0, 5)).toEqual([
      'bootstrap',
      'seed-check',
      'receive-data',
      'seed-digest',
      'bootstrap',
    ]);
    expect(world.pipes).toHaveLength(1);
    expect(world.pipes[0]!.from).toMatchObject({ command: 'tar', args: ['-C', source, '-c', '.'] });
    expect(world.pipes[0]!.from.env).toEqual({ COPYFILE_DISABLE: '1' });
    expect(world.pipes[0]!.to.command).toBe('ssh');
    expect(world.machine.receivedData).toContain('tar -C');
    expect(starts()).toEqual([[SHA_NEWEST, 'v2026.10.12']]);
    expect(world.output).toContain('the instance on the Mac must be stopped');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('accepts the message attachments of a hybrid package and uploads them with it', async () => {
    mkdirSync(path.join(source, 'message-attachments', 'AR'), { recursive: true });
    writeFileSync(path.join(source, 'message-attachments', 'AR', 'msg_1'), 'file of a team message');
    expect(await run('seed', '--from', source)).toBe(0);
    expect(everything()).not.toContain('message-attachments');
    expect(world.pipes).toHaveLength(1);
    expect(world.pipes[0]!.from).toMatchObject({ command: 'tar', args: ['-C', source, '-c', '.'] });
  });

  it('needs --from', async () => {
    expect(await run('seed')).toBe(64);
  });

  it('refuses a source that is missing, is a file, or has no db.sqlite', async () => {
    expect(await run('seed', '--from', path.join(world.home, 'nope'))).toBe(2);
    expect(await run('seed', '--from', path.join(source, 'db.sqlite'))).toBe(2);
    const empty = mkdtempSync(path.join(world.home, 'empty-'));
    expect(await run('seed', '--from', empty)).toBe(2);
    expect(everything()).toContain('has no db.sqlite');
    expect(world.hostCalls).toHaveLength(0);
  });

  it('refuses a source that holds what the cloud must not get (the machine key, the CLI homes)', async () => {
    writeFileSync(path.join(source, 'engine.key'), 'key');
    expect(await run('seed', '--from', source)).toBe(2);
    expect(everything()).toContain('engine.key');
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses when a bucket is not empty, before connecting', async () => {
    world.aws.buckets.get('acme-projectman-db')!.objects = 3;
    expect(await run('seed', '--from', source)).toBe(2);
    expect(everything()).toContain('acme-projectman-db is not empty');
    expect(world.hostCalls).toHaveLength(0);
    world.aws.buckets.get('acme-projectman-db')!.objects = 0;
    world.aws.buckets.get('acme-projectman-backup')!.objects = 1;
    expect(await run('seed', '--from', source)).toBe(2);
    expect(everything()).toContain('acme-projectman-backup is not empty');
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses when the board is running on the machine, and uploads nothing', async () => {
    world.machine.preload(SHA_OLD, 'v2026.10.11.4');
    expect(await run('seed', '--from', source)).toBe(2);
    expect(everything()).toContain('the board is running');
    expect(world.pipes).toHaveLength(0);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('refuses when the data directory on the machine is not empty', async () => {
    world.machine.dataEmpty = false;
    expect(await run('seed', '--from', source)).toBe(2);
    expect(everything()).toContain('is not empty');
    expect(world.pipes).toHaveLength(0);
  });

  it('fails (1) and does not deploy when the upload fails', async () => {
    world.pipeCode = 2;
    expect(await run('seed', '--from', source)).toBe(1);
    expect(everything()).toContain('the upload failed');
    expect(world.machine.built).toHaveLength(0);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('--dry-run checks the files and the buckets and then stops before connecting', async () => {
    expect(await run('seed', '--from', source, '--dry-run')).toBe(0);
    expect(world.hostCalls).toHaveLength(0);
    expect(world.pipes).toHaveLength(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.output).toContain('skipped seed: dry-run');
  });
});

describe.each(['lightsail', 'ec2'])('seed integrity through %s', (compute) => {
  let source: string;
  const database = () => path.join(source, 'db.sqlite');
  const digest = () => ({
    databaseSha256: createHash('sha256').update('closed database').digest('hex'),
    databaseBytes: Buffer.byteLength('closed database'),
  });
  beforeEach(() => {
    if (compute === 'ec2') {
      world.cleanup();
      world = Ec2HostWorld.configured();
    }
    source = mkdtempSync(path.join(world.home, 'package-'));
    writeFileSync(database(), 'closed database');
    world.aws.addBucket('acme-projectman-db');
    world.aws.addBucket('acme-projectman-backup');
  });
  const seed = () => run('seed', '--from', source, '--ref', SHA_NEW);
  const stopped = () => {
    expect(world.machine.built).toEqual([]);
    expect(starts()).toEqual([]);
    expect(world.machine.running).toBe(false);
    expect(world.machine.dataEmpty).toBe(false);
    expect(world.machine.receivedDatabase?.toString()).toBe('closed database');
    expect(world.output).toContain('FAIL seed-integrity:');
  };

  it('proves the copied bytes before any deploy and refuses a second seed', async () => {
    expect(await seed()).toBe(0);
    expect(subcommands().slice(0, 5)).toEqual([
      'bootstrap',
      'seed-check',
      'receive-data',
      'seed-digest',
      'bootstrap',
    ]);
    const call = world.hostCalls.find((item) => item.subcommand === 'seed-digest')!;
    expect(call.args).toEqual([]);
    expect(call.input).toBeUndefined();
    const proof = `ok seed-integrity: database sha256=${digest().databaseSha256} bytes=${digest().databaseBytes} (before first start)`;
    expect(world.output).toContain(proof);
    expect(world.output.indexOf(proof)).toBeLessThan(world.output.indexOf('created build:'));
    world.machine.running = false;
    world.hostCalls.length = 0;
    expect(await seed()).toBe(2);
    expect(subcommands()).not.toContain('receive-data');
  });

  it.each([
    '',
    '{',
    '{}',
    'null',
    '[]',
    JSON.stringify({ databaseSha256: 'a'.repeat(64) }),
    ...[
      { databaseSha256: 'A'.repeat(64) },
      { databaseSha256: 'a'.repeat(63) },
      { databaseSha256: 'g'.repeat(64) },
      { databaseSha256: 7 },
      { databaseBytes: '15' },
      { databaseBytes: 0 },
      { databaseBytes: -1 },
      { databaseBytes: 1.5 },
      { databaseBytes: Number.MAX_SAFE_INTEGER + 1 },
      { extra: true },
      { databaseSha256: '0'.repeat(64) },
      { databaseBytes: 99 },
    ].map((change) =>
      JSON.stringify({
        databaseSha256: createHash('sha256').update('closed database').digest('hex'),
        databaseBytes: 15,
        ...change,
      }),
    ),
  ])('stops without altering uploaded data on invalid or unequal digest %s', async (stdout) => {
    world.machine.failures.set('seed-digest', { code: 0, stdout, stderr: '' });
    expect(await seed()).toBe(1);
    stopped();
  });

  it.each([1, 3, 255])('stops on host/transport exit %s', async (code) => {
    world.machine.failures.set('seed-digest', { code, stdout: '', stderr: 'digest failed' });
    expect(await seed()).toBe(code === 3 ? 2 : 1);
    stopped();
  });

  it('maps a receive-data state refusal to exit 2 without requesting a digest or deploying', async () => {
    world.machine.failures.set('receive-data', { code: 3, stdout: '', stderr: 'board is running' });
    expect(await seed()).toBe(2);
    expect(subcommands()).not.toContain('seed-digest');
    expect(world.machine.built).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it('stops on a source read error after upload', async () => {
    const deps = world.deps();
    const pipe = deps.pipe;
    let restore = () => {};
    deps.pipe = async (from, to) => {
      const result = await pipe(from, to);
      const spy = vi.spyOn(fs, 'readSync').mockImplementation(() => {
        throw new Error('source read failed');
      });
      restore = () => spy.mockRestore();
      return result;
    };
    try {
      expect(await runCloud(['seed', '--from', source, '--ref', SHA_NEW], deps)).toBe(1);
      stopped();
      expect(world.output).toContain('source read failed');
    } finally {
      restore();
    }
  });

  it.each(['missing', 'symlink', 'directory', '-wal', '-shm', '-journal', 'empty'])(
    'refuses a %s source before uploading',
    async (kind) => {
      if (['missing', 'symlink', 'directory'].includes(kind)) rmSync(database());
      if (kind === 'symlink') symlinkSync('absent', database());
      if (kind === 'directory') mkdirSync(database());
      if (kind.startsWith('-')) symlinkSync('absent', `${database()}${kind}`);
      if (kind === 'empty') writeFileSync(database(), '');
      expect(await seed()).toBe(2);
      expect(world.hostCalls).toEqual([]);
      expect(world.output).toContain('FAIL seed-integrity:');
    },
  );

  it.each(['changed', 'removed', 'symlink', 'sidecar', 'board restarted', 'read failure'])(
    'stops after upload when the source is %s',
    async (kind) => {
      const deps = world.deps();
      const pipe = deps.pipe;
      deps.pipe = async (from, to) => {
        const result = await pipe(from, to);
        if (kind === 'changed') writeFileSync(database(), 'changed content');
        if (kind === 'removed' || kind === 'symlink') rmSync(database());
        if (kind === 'symlink') symlinkSync('absent', database());
        if (kind === 'sidecar') writeFileSync(`${database()}-wal`, 'wal');
        if (kind === 'board restarted') world.machine.running = true;
        if (kind === 'read failure') {
          world.machine.failures.set('seed-digest', { code: 1, stdout: '', stderr: 'cannot read database' });
        }
        return result;
      };
      expect(await runCloud(['seed', '--from', source, '--ref', SHA_NEW], deps)).toBe(
        kind === 'board restarted' ? 2 : 1,
      );
      if (kind === 'board restarted') world.machine.running = false;
      stopped();
    },
  );

  it('previews the mandatory gate without claiming proof or connecting', async () => {
    expect(await run('seed', '--from', source, '--ref', SHA_NEW, '--dry-run')).toBe(0);
    expect(world.hostCalls).toEqual([]);
    expect(world.output).toContain('require seed-integrity');
    expect(world.output).not.toContain('ok seed-integrity:');
  });
});

describe('pull-data', () => {
  let target: string;
  beforeEach(() => {
    target = path.join(world.home, 'copy');
    world.machine.preload(SHA_NEW, 'v2026.10.12');
    world.machine.running = false;
  });

  it('copies the stopped board data into a new directory with mode 700', async () => {
    expect(await run('pull-data', '--to', target)).toBe(0);
    expect(existsSync(path.join(target, 'db.sqlite'))).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(world.pipes[0]!.from.command).toBe('ssh');
    expect(world.pipes[0]!.to).toMatchObject({ command: 'tar', args: ['-x', '-p', '-f', '-', '-C', target] });
    expect(world.output).toContain('ok check-entries');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('needs --to', async () => {
    expect(await run('pull-data')).toBe(64);
  });

  it('refuses a directory that exists, a missing parent and a git work tree', async () => {
    mkdirSync(target);
    expect(await run('pull-data', '--to', target)).toBe(2);
    expect(everything()).toContain('already exists');
    expect(await run('pull-data', '--to', path.join(world.home, 'no', 'such', 'copy'))).toBe(2);
    const tree = path.join(world.home, 'work');
    mkdirSync(path.join(tree, '.git'), { recursive: true });
    expect(await run('pull-data', '--to', path.join(tree, 'data'))).toBe(2);
    expect(everything()).toContain('inside the git work tree');
    expect(world.hostCalls).toHaveLength(0);
  });

  it('refuses while the board is running, and creates nothing', async () => {
    world.machine.running = true;
    expect(await run('pull-data', '--to', target)).toBe(2);
    expect(everything()).toContain('stop it first');
    expect(existsSync(target)).toBe(false);
    expect(world.pipes).toHaveLength(0);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('removes the partial copy when the download fails', async () => {
    world.pipeCode = 2;
    expect(await run('pull-data', '--to', target)).toBe(1);
    expect(everything()).toContain('the download failed');
    expect(existsSync(target)).toBe(false);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('names what the way back would refuse in the copy', async () => {
    const deps = world.deps();
    const pipe = deps.pipe;
    deps.pipe = async (from, to) => {
      const result = await pipe(from, to);
      writeFileSync(path.join(target, 'strange-file'), 'x');
      return result;
    };
    expect(await runCloud(['pull-data', '--to', target], deps)).toBe(0);
    expect(world.output).toContain('note: strange-file in the copy');
  });

  it('--dry-run connects nowhere and creates nothing', async () => {
    expect(await run('pull-data', '--to', target, '--dry-run')).toBe(0);
    expect(world.hostCalls).toHaveLength(0);
    expect(existsSync(target)).toBe(false);
    expect(world.aws.mutations()).toEqual([]);
  });
});

describe('the command line', () => {
  it('rejects options a command does not have', async () => {
    expect(await run('status', '--dry-run')).toBe(64);
    expect(await run('deploy', '--lines', '5')).toBe(64);
    expect(await run('logs', '--ref', 'v1')).toBe(64);
    expect(await run('deploy', '--ref')).toBe(64);
    expect(await run('deploy', '--ref', '--dry-run')).toBe(64);
    expect(world.hostCalls).toHaveLength(0);
  });
});
