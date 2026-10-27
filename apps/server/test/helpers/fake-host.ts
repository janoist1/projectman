import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { CloudDeps, PipeEnd, RunOptions, RunResult } from '../../../../scripts/cloud/deps';
import { CloudWorld } from './fake-aws';

/**
 * The machine side of the cloud commands (PM-535): a fake `ssh`, `git ls-remote`, `tar` pipe and the clock, around
 * the AWS fake of `fake-aws.ts`. The fake machine behaves like `deploy/aws/host.sh` (same subcommands, same exit
 * status 3 for a refusal, the same deploy.json rules) and records, at the moment of every call, what a security
 * test needs to know: the key files and the known_hosts file.
 */

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
export const SHA_OLD = 'a'.repeat(40);
export const SHA_NEW = 'b'.repeat(40);
export const SHA_NEWEST = 'c'.repeat(40);

interface DeployEntry {
  sha: string;
  ref: string;
  at: string;
  imageId?: string;
  platform?: 'linux/amd64' | 'linux/arm64';
}

interface DeployState {
  current: DeployEntry | null;
  previous: DeployEntry | null;
  lastStoppedAt: string | null;
}

interface HostCall {
  subcommand: string;
  args: string[];
  input: string | undefined;
  sshArgs: string[];
  /** The whole remote command string (one argument of ssh). */
  remote: string;
  keyFile: { exists: boolean; mode: number; content: string } | null;
  certFile: { exists: boolean; mode: number; content: string } | null;
  knownHosts: string;
}

/** The words of a string made of single-quoted words (the way `shellQuote` writes them). */
export function unquoteWords(text: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === ' ') {
      index += 1;
      continue;
    }
    let word = '';
    while (index < text.length && text[index] !== ' ') {
      if (text[index] === "'") {
        const end = text.indexOf("'", index + 1);
        word += text.slice(index + 1, end);
        index = end + 1;
      } else if (text[index] === '\\') {
        word += text[index + 1];
        index += 2;
      } else {
        word += text[index];
        index += 1;
      }
    }
    words.push(word);
  }
  return words;
}

class FakeMachine {
  // What the machine holds.
  bootstrapped = 0;
  unitText: string | null = null;
  envText: string | null = null;
  built: { sha: string; url: string }[] = [];
  imported = new Map<string, { imageId: string; platform: 'linux/amd64' | 'linux/arm64' }>();
  deploy: DeployState | null = null;
  running = false;
  runningSha: string | null = null;
  dataEmpty = true;
  receivedData: string | null = null;
  receivedDatabase: Buffer | null = null;
  // What a test can set.
  unhealthyShas = new Set<string>();
  /** How many status polls answer `starting` after a start. */
  startingPolls = 1;
  failures = new Map<string, RunResult>();
  rehearsalOutput = 'checking the replica\nREHEARSAL PASSED\n';
  rehearsalCode = 0;
  logText = 'line one\nline two\n';
  hangOn: string | null = null;
  /** What the board answers the feedback hostname with (`guard-check`): the guard works when both are 404. */
  guardCodes = { plain: '404', port: '404' };
  /** What the board says about itself as the public board (`public-check`); the default is the working one. */
  publicCheck: Record<string, unknown> = {
    publicBoard: true,
    emailLoginEnabled: true,
    needsSetup: false,
    apiStatus: 401,
    crossOriginStatus: 403,
  };

  /** What the control socket answers a relayed request (`release-control`, PM-749); one line, or anything a test sets. */
  controlAnswer: RunResult = { code: 0, stdout: '{"ok":true,"pause":null}\n', stderr: '' };
  /** The inputs the relay received, as they arrived. */
  controlInputs: (string | undefined)[] = [];

  private pollsSinceStart = 0;

  private readonly now: () => string;

  constructor(now: () => string) {
    this.now = now;
  }

  current(): DeployEntry | null {
    return this.deploy?.current ?? null;
  }

  /** The machine had `sha` deployed and healthy before the test starts. */
  preload(sha: string, ref: string, previous?: { sha: string; ref: string }): void {
    this.deploy = {
      current: { sha, ref, at: '2026-10-01T10:00:00Z' },
      previous: previous ? { ...previous, at: '2026-09-20T10:00:00Z' } : null,
      lastStoppedAt: null,
    };
    this.running = true;
    this.runningSha = sha;
    this.dataEmpty = false;
    this.pollsSinceStart = 99;
    this.bootstrapped = 1;
  }

  handle(subcommand: string, args: string[], input: string | undefined): RunResult {
    const failure = this.failures.get(subcommand);
    if (failure) return failure;
    const done = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    const refuse = (message: string): RunResult => ({
      code: 3,
      stdout: '',
      stderr: `host.sh: refused: ${message}\n`,
    });
    switch (subcommand) {
      case 'bootstrap':
        this.bootstrapped += 1;
        this.unitText = input ?? null;
        return done();
      case 'receive-env':
        this.envText = input ?? null;
        return done();
      case 'build':
        this.built.push({ sha: args[0]!, url: args[1]! });
        return done('building\n');
      case 'receive-image': {
        const [sha, platform, , , imageId] = args;
        this.imported.set(sha!, { imageId: imageId!, platform: platform as 'linux/amd64' | 'linux/arm64' });
        return done(JSON.stringify({ imageId, platform, revision: sha }) + '\n');
      }
      case 'start': {
        const [sha, ref] = [args[0]!, args[1] ?? args[0]!];
        let stopped = this.deploy?.lastStoppedAt ?? null;
        if (this.running) stopped = this.now();
        const old = this.deploy?.current ?? null;
        this.deploy = {
          current: {
            sha,
            ref,
            at: this.now(),
            ...(args[2]
              ? {
                  imageId: args[2],
                  platform: this.imported.get(sha)?.platform ?? old?.platform ?? 'linux/arm64',
                }
              : {}),
          },
          previous: old && old.sha !== sha ? old : (this.deploy?.previous ?? null),
          lastStoppedAt: stopped,
        };
        this.running = true;
        this.runningSha = sha;
        this.pollsSinceStart = 0;
        return done(`started projectman-cloud:${sha}\n`);
      }
      case 'stop':
        if (this.running && this.deploy) this.deploy = { ...this.deploy, lastStoppedAt: this.now() };
        this.running = false;
        return done('stopped\n');
      case 'status': {
        this.pollsSinceStart += 1;
        const sha = this.runningSha;
        let health = 'none';
        if (this.running && sha) {
          if (this.unhealthyShas.has(sha))
            health = this.pollsSinceStart > this.startingPolls ? 'unhealthy' : 'starting';
          else health = this.pollsSinceStart > this.startingPolls ? 'healthy' : 'starting';
        }
        return done(
          JSON.stringify({
            unit: this.running ? 'active' : 'inactive',
            container: this.running ? 'running' : 'absent',
            health,
            image: this.running && sha ? `projectman-cloud:${sha}` : '',
            imageId: this.deploy?.current?.imageId ?? null,
            deploy: this.deploy,
            disk: { dataBytes: 1_048_576, freeBytes: 12_884_901_888 },
            memory: {
              totalBytes: 2_000_000_000,
              availableBytes: 900_000_000,
              swapTotalBytes: 2_147_483_648,
              swapUsedBytes: 0,
            },
          }),
        );
      }
      case 'logs':
        return done(this.logText);
      case 'rehearse':
        return { code: this.rehearsalCode, stdout: this.rehearsalOutput, stderr: '' };
      case 'seed-check':
        return done(
          JSON.stringify({ container: this.running ? 'running' : 'stopped', dataEmpty: this.dataEmpty }),
        );
      case 'seed-digest':
        if (this.running) return refuse('the board is running');
        if (!this.receivedDatabase) return refuse('no database');
        return done(
          JSON.stringify({
            databaseSha256: createHash('sha256').update(this.receivedDatabase).digest('hex'),
            databaseBytes: this.receivedDatabase.length,
          }) + '\n',
        );
      case 'receive-data':
        if (this.running) return refuse('the board is running');
        if (!this.dataEmpty) return refuse('the data directory is not empty');
        this.receivedData = input ?? 'tar stream';
        this.dataEmpty = false;
        return done();
      case 'send-data':
        if (this.running) return refuse('the board is running');
        return done('tar stream');
      case 'guard-check':
        if (!this.running) return refuse('the board is not running');
        return done(JSON.stringify(this.guardCodes));
      case 'public-check':
        if (!this.running) return refuse('the board is not running');
        return done(JSON.stringify(this.publicCheck));
      case 'release-control':
        if (args.length > 0) return refuse('release-control takes no arguments');
        if (!this.running) return refuse('the board is not running');
        this.controlInputs.push(input);
        return this.controlAnswer;
      default:
        return { code: 2, stdout: '', stderr: `host.sh: unknown subcommand ${subcommand}\n` };
    }
  }
}

interface Tag {
  name: string;
  sha: string;
  peeled?: string;
}

/** A world with a machine behind the fake `ssh`. */
export class HostWorld extends CloudWorld {
  clock = Date.parse('2026-10-12T12:00:00Z');
  readonly machine = new FakeMachine(() => new Date(this.clock).toISOString());
  readonly hostCalls: HostCall[] = [];
  readonly shells: string[][] = [];
  readonly gitCalls: string[][] = [];
  readonly pipes: { from: PipeEnd; to: PipeEnd }[] = [];
  readonly interruptHandlers = new Set<() => void>();
  tags: Tag[] = [
    { name: 'v2026.10.9', sha: 'd'.repeat(40) },
    { name: 'v2026.10.12', sha: SHA_NEW, peeled: SHA_NEWEST },
    { name: 'v2026.10.11.4', sha: 'e'.repeat(40) },
    { name: 'v2026.9.30', sha: 'f'.repeat(40) },
    { name: 'not-a-release', sha: '1'.repeat(40) },
  ];
  lsRemoteFails = false;
  /** The folder of the pulled data: the fake `tar -x` writes a db.sqlite here. */
  pullWritesFiles = true;
  pipeCode = 0;
  interruptDuring: string | null = null;

  /** A world whose AWS side is ready: configuration, the secrets and a running machine. */
  static ready<T extends HostWorld>(this: new () => T): T {
    const world = new this();
    world.writeConfig();
    world.writeEnv();
    return world;
  }

  /** The tail of `cloud.env` that `aws` made (values are made up). */
  writeEnv(extra = 'TUNNEL_TOKEN=tunnel-token-value-0123456789\n'): void {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.envFile,
      [
        'LITESTREAM_BUCKET=acme-projectman-db',
        'LITESTREAM_ENDPOINT=https://s3.eu-west-1.amazonaws.com',
        'LITESTREAM_REGION=eu-west-1',
        'LITESTREAM_ACCESS_KEY_ID=AKIAFAKEKEY00000001',
        'LITESTREAM_SECRET_ACCESS_KEY=fakeSecretDb/xxxxxxxxxxxxxxxxxxxxxxxx',
        'RESTIC_REPOSITORY=s3:https://s3.eu-west-1.amazonaws.com/acme-projectman-backup/projectman',
        'RESTIC_REGION=eu-west-1',
        'RESTIC_PASSWORD=fake-restic-password-0123456789',
        'RESTIC_ACCESS_KEY_ID=AKIAFAKEKEY00000002',
        'RESTIC_SECRET_ACCESS_KEY=fakeSecretBackup/xxxxxxxxxxxxxxxxxxxxxxxx',
        extra,
      ].join('\n'),
      { mode: 0o600 },
    );
  }

  interrupt(): void {
    for (const handler of [...this.interruptHandlers]) handler();
  }

  override deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
    const baseRun = this.aws.run;
    return super.deps({
      repoRoot: REPO_ROOT,
      now: () => new Date(this.clock),
      sleep: async (ms) => {
        this.clock += ms;
      },
      onInterrupt: (handler) => {
        this.interruptHandlers.add(handler);
        return () => this.interruptHandlers.delete(handler);
      },
      run: async (command, args, options = {}) => {
        if (command === 'aws') return baseRun(command, args);
        if (command === 'ssh') return this.ssh(args, options);
        if (command === 'git') return this.git(args);
        return { code: 127, stdout: '', stderr: `${command}: not found\n` };
      },
      pipe: (from, to) => this.pipe(from, to),
      ...overrides,
    });
  }

  private git(args: string[]): RunResult {
    this.gitCalls.push(args);
    if (args[0] !== 'ls-remote') return { code: 1, stdout: '', stderr: `fake git: ${args[0]}\n` };
    if (this.lsRemoteFails)
      return { code: 128, stdout: '', stderr: 'fatal: unable to access the repository\n' };
    const lines = this.tags.flatMap((tag) => [
      `${tag.sha}\trefs/tags/${tag.name}`,
      ...(tag.peeled ? [`${tag.peeled}\trefs/tags/${tag.name}^{}`] : []),
    ]);
    return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }

  private async ssh(args: string[], options: RunOptions): Promise<RunResult> {
    const last = args[args.length - 1]!;
    const interactive = /^[a-z_][a-z0-9_-]*@(?:[0-9.]+|i-[0-9a-f]+)$/.test(last);
    const sshArgs = interactive ? args : args.slice(0, -1);
    if (interactive) {
      this.shells.push(args);
      return { code: 0, stdout: '', stderr: '' };
    }
    const words = unquoteWords(last);
    if (words[0] !== 'sudo' || words[1] !== 'bash' || words[2] !== '-c' || words[4] !== 'host.sh')
      return { code: 127, stdout: '', stderr: `fake ssh: unexpected remote command: ${last.slice(0, 80)}\n` };
    const subcommand = words[5]!;
    const subArgs = words.slice(6);
    const identity = optionValue(sshArgs, '-i');
    const certificate = sshArgs
      .find((arg) => arg.startsWith('CertificateFile='))
      ?.slice('CertificateFile='.length);
    const knownHostsOption = sshArgs
      .find((arg) => arg.startsWith('UserKnownHostsFile='))
      ?.slice('UserKnownHostsFile='.length);
    const knownHostsFile = knownHostsOption?.startsWith('"')
      ? (JSON.parse(knownHostsOption) as string)
      : knownHostsOption;
    const inspect = (file: string | undefined) =>
      file && existsSync(file)
        ? { exists: true, mode: statSync(file).mode & 0o777, content: readFileSync(file, 'utf8') }
        : file
          ? { exists: false, mode: 0, content: '' }
          : null;
    this.hostCalls.push({
      subcommand,
      args: subArgs,
      input: options.input,
      sshArgs,
      remote: last,
      keyFile: inspect(identity),
      certFile: inspect(certificate),
      knownHosts: knownHostsFile && existsSync(knownHostsFile) ? readFileSync(knownHostsFile, 'utf8') : '',
    });
    if (this.interruptDuring === subcommand) {
      this.interruptDuring = null;
      this.interrupt();
    }
    if (this.machine.hangOn === subcommand) {
      return new Promise<RunResult>((resolve) => {
        const finish = () => resolve({ code: 130, stdout: '', stderr: '' });
        if (options.signal?.aborted) finish();
        else options.signal?.addEventListener('abort', finish, { once: true });
      });
    }
    return this.machine.handle(subcommand, subArgs, options.input);
  }

  private async pipe(from: PipeEnd, to: PipeEnd): Promise<RunResult> {
    this.pipes.push({ from, to });
    if (this.pipeCode !== 0) return { code: this.pipeCode, stdout: '', stderr: 'tar: broken\n' };
    if (from.command === 'cat' && to.command === 'ssh') return this.ssh(to.args, {});
    if (from.command === 'tar' && to.command === 'ssh') {
      this.machine.receivedDatabase = readFileSync(path.join(optionValue(from.args, '-C')!, 'db.sqlite'));
      const result = await this.ssh(to.args, {
        input: `tar ${from.args.join(' ')}`,
        ...(to.signal ? { signal: to.signal } : {}),
      });
      return result;
    }
    if (from.command === 'ssh' && to.command === 'tar') {
      const result = await this.ssh(from.args, from.signal ? { signal: from.signal } : {});
      if (result.code !== 0) return result;
      const directory = optionValue(to.args, '-C');
      if (directory && this.pullWritesFiles) writeFileSync(path.join(directory, 'db.sqlite'), 'sqlite');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 127, stdout: '', stderr: 'fake pipe: unexpected command pair\n' };
  }
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
