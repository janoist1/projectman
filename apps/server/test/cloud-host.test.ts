import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { knownHostsLines, shellQuote } from '../../../scripts/cloud/host';
import { HostWorld, REPO_ROOT, unquoteWords } from './helpers/fake-host';

/** The ssh session of the machine commands (PM-535): what it opens, what it must verify, what it always closes. */

let world: HostWorld;
beforeEach(() => {
  world = HostWorld.ready();
  world.machine.preload('1'.repeat(40), 'v2026.10.1');
});
afterEach(() => world.cleanup());

const run = (...argv: string[]) => runCloud(argv, world.deps());
const keyPath = (): string => world.hostCalls[0]!.sshArgs[world.hostCalls[0]!.sshArgs.indexOf('-i') + 1]!;
const putPorts = () => world.aws.callsTo('put-instance-public-ports');

describe('the ssh session', () => {
  it('opens the SSH port for the own address only, and puts the firewall back', async () => {
    expect(await run('status')).toBe(0);
    expect(world.hostCalls.length).toBeGreaterThan(0);
    for (const call of world.hostCalls) expect(call.sshCidrs).toEqual(['198.51.100.20/32']);
    expect(world.firewallIsClosed()).toBe(true);
    expect(putPorts()).toHaveLength(2);
    expect(world.output).toContain('updated firewall-open: 22/tcp for 198.51.100.20/32');
    expect(world.output).toContain('updated firewall-close: 22/tcp for lightsail-connect only');
  });

  it('writes the temporary key and certificate with mode 600 and deletes them afterwards', async () => {
    expect(await run('status')).toBe(0);
    const call = world.hostCalls[0]!;
    expect(call.keyFile).toMatchObject({ exists: true, mode: 0o600 });
    expect(call.keyFile!.content).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(call.certFile).toMatchObject({ exists: true, mode: 0o600 });
    expect(call.sshArgs).toContain(`CertificateFile=${path.join(path.dirname(keyPath()), 'key-cert.pub')}`);
    expect(existsSync(path.dirname(keyPath()))).toBe(false);
  });

  it('never prints the private key or the certificate', async () => {
    await run('status');
    expect(world.output).not.toContain('FAKEPRIVATEKEYBODY');
    expect(world.output).not.toContain('FAKECERTIFICATE');
  });

  it('verifies the machine against the host keys of Lightsail, never with StrictHostKeyChecking=no', async () => {
    await run('status');
    const args = world.hostCalls[0]!.sshArgs;
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args.join(' ')).not.toMatch(/StrictHostKeyChecking=(no|accept-new|off)/);
    expect(args.join(' ')).not.toContain('UserKnownHostsFile=/dev/null');
    expect(args).toEqual(expect.arrayContaining(['-F', '/dev/null', 'BatchMode=yes', 'IdentitiesOnly=yes']));
    const knownHostsOption = args.find((arg) => arg.startsWith('UserKnownHostsFile='))!;
    const file = knownHostsOption.slice('UserKnownHostsFile='.length);
    expect(file.startsWith(world.secretsDir)).toBe(true);
    expect(world.hostCalls[0]!.knownHosts).toBe(
      '203.0.113.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests0123456789abcdef\n',
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(world.hostCalls[0]!.remote).toMatch(/^'sudo' 'bash' '-c' /);
    expect(args[args.length - 1]).toBe('ubuntu@203.0.113.7');
  });

  it('sends host.sh as the -c argument of bash, quoted, with the subcommand after it', async () => {
    await run('logs', '--lines', '25');
    const call = world.hostCalls[0]!;
    const words = unquoteWords(call.remote);
    expect(words.slice(0, 3)).toEqual(['sudo', 'bash', '-c']);
    expect(words[3]).toBe(readFileSync(path.join(REPO_ROOT, 'deploy/aws/host.sh'), 'utf8'));
    expect(words.slice(4)).toEqual(['host.sh', 'logs', '25']);
  });

  it('refuses a machine that Lightsail reports no host key for, and still closes the firewall', async () => {
    world.aws.accessHostKeys = [];
    expect(await run('status')).toBe(2);
    expect(world.output).toContain('no usable SSH host key');
    expect(world.hostCalls).toHaveLength(0);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('refuses a host key with a strange algorithm or key text', async () => {
    world.aws.accessHostKeys = [{ algorithm: 'ssh-ed25519 evil', publicKey: 'AAAA bbb' }];
    expect(await run('status')).toBe(2);
    expect(world.hostCalls).toHaveLength(0);
  });

  it('uses aws.sshIdentityFile when it is set, and still verifies the host keys', async () => {
    world.writeConfig({
      aws: {
        region: 'eu-west-1',
        databaseBucket: 'acme-projectman-db',
        backupBucket: 'acme-projectman-backup',
        sshIdentityFile: '~/.ssh/lightsail-key',
      },
    });
    expect(await run('status')).toBe(0);
    const args = world.hostCalls[0]!.sshArgs;
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual([
      '-i',
      `${world.home}/.ssh/lightsail-key`,
    ]);
    expect(args.join(' ')).not.toContain('CertificateFile');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(world.hostCalls[0]!.keyFile).toMatchObject({ exists: false });
  });

  it('turns a host key certificate authority entry into an @cert-authority line', () => {
    expect(
      knownHostsLines('203.0.113.7', [
        { algorithm: 'ssh-ed25519-cert-v01@openssh.com', publicKey: 'AAAACA' },
        { algorithm: 'ssh-rsa', publicKey: 'AAAAB3Nza==' },
      ]),
    ).toEqual(['@cert-authority 203.0.113.7 ssh-ed25519 AAAACA', '203.0.113.7 ssh-rsa AAAAB3Nza==']);
  });

  it('quotes a word with a single quote', () => {
    expect(unquoteWords(shellQuote("it's here"))).toEqual(["it's here"]);
  });

  it('asks Lightsail for a new key when the old one is older than 30 seconds', async () => {
    world.machine.unhealthyShas.add('2'.repeat(40));
    world.tags = [{ name: 'v2026.10.2', sha: '2'.repeat(40) }];
    await run('deploy');
    expect(world.aws.accessDetailsIssued).toBeGreaterThan(2);
  });
});

describe('the firewall is put back whatever happens', () => {
  it('after a failure on the machine', async () => {
    world.machine.failures.set('logs', { code: 1, stdout: '', stderr: 'journalctl: broken\n' });
    expect(await run('logs')).toBe(1);
    expect(world.output + world.errors.join('\n')).toContain('logs failed on the machine');
    expect(world.firewallIsClosed()).toBe(true);
    expect(existsSync(path.dirname(keyPath()))).toBe(false);
  });

  it('after a refusal of the machine (exit status 3)', async () => {
    world.machine.failures.set('stop', {
      code: 3,
      stdout: '',
      stderr: 'host.sh: refused: nothing to stop\n',
    });
    expect(await run('stop')).toBe(2);
    expect(world.output + world.errors.join('\n')).toContain('nothing to stop');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('after an exception in ssh itself', async () => {
    const deps = world.deps({
      run: async (command, args, options) => {
        if (command === 'ssh') throw new Error('spawn exploded');
        return world.deps().run(command, args, options);
      },
    });
    expect(await runCloud(['status'], deps)).toBe(1);
    expect(world.output + world.errors.join('\n')).toContain('spawn exploded');
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('after Ctrl-C while the machine is working', async () => {
    world.machine.hangOn = 'status';
    world.interruptDuring = 'status';
    expect(await run('status')).toBe(1);
    expect(world.errors.join('\n') + world.output).toContain('interrupted');
    expect(world.firewallIsClosed()).toBe(true);
    expect(world.interruptHandlers.size).toBe(0);
    expect(existsSync(path.dirname(keyPath()))).toBe(false);
  });

  it('after Ctrl-C of an ssh shell', async () => {
    const deps = world.deps({
      run: async (command, args, options) => {
        if (command === 'ssh') {
          world.interrupt();
          return { code: 130, stdout: '', stderr: '' };
        }
        return world.deps().run(command, args, options);
      },
    });
    expect(await runCloud(['ssh'], deps)).toBe(1);
    expect(world.firewallIsClosed()).toBe(true);
  });

  it('retries a failed restore, and succeeds when the second try works', async () => {
    world.restoreFailures = 1;
    expect(await run('status')).toBe(0);
    expect(world.firewallIsClosed()).toBe(true);
    expect(putPorts()).toHaveLength(3);
  });

  it('says so, prints the manual command and exits 1 when the restore never works', async () => {
    world.restoreFailures = 10;
    expect(await run('status')).toBe(1);
    expect(world.output).toContain('FAIL firewall-close: the SSH port may still be open to your address');
    expect(world.output).toContain(
      "aws --profile i --region eu-west-1 lightsail put-instance-public-ports --instance-name projectman-cloud --port-infos '[{",
    );
    expect(world.output).toContain('lightsail-connect');
    expect(world.firewallIsClosed()).toBe(false);
    expect(existsSync(path.dirname(keyPath()))).toBe(false);
  });

  it('keeps the first failure visible when the restore fails as well', async () => {
    world.restoreFailures = 10;
    world.machine.failures.set('status', { code: 1, stdout: '', stderr: 'broken\n' });
    expect(await run('status')).toBe(1);
    expect(world.output).toContain('FAIL firewall-close');
    expect(world.output).toContain('the command itself failed first');
  });
});

describe('what the session checks before it opens anything', () => {
  it('refuses a machine that does not exist, and changes nothing', async () => {
    world.aws.instance = null;
    expect(await run('status')).toBe(2);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses a machine that is not running, and changes nothing', async () => {
    world.aws.instance!.state = 'stopped';
    expect(await run('logs')).toBe(2);
    expect(world.output + world.errors.join('\n')).toContain('is stopped, not running');
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses when the own address cannot be found out, and changes nothing', async () => {
    world.publicAddress = null;
    expect(await run('logs')).toBe(1);
    expect(world.output + world.errors.join('\n')).toContain('cannot find out your public address');
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses an answer that is not an IPv4 address', async () => {
    world.publicAddress = '2001:db8::1';
    expect(await run('logs')).toBe(2);
    expect(world.aws.mutations()).toEqual([]);
  });
});
