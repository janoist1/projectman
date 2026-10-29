import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudDeps, RunResult } from '../../../../scripts/cloud/deps';
import { EC2_CONFIG, FakeEc2 } from './fake-ec2';

/**
 * A fake of the `aws` CLI v2 that keeps state (PM-534): it answers by service, operation and argv, like the
 * real CLI would for the calls the cloud commands make. Tests ask it which calls changed something.
 */

export const ACCOUNT = '123456789012';
export const FOREIGN_ACCOUNT = '999999999999';

interface Key {
  id: string;
  secret: string;
  status: string;
  created: string;
}

interface UserState {
  inline: Map<string, unknown>;
  attached: string[];
  keys: Key[];
}

interface BucketState {
  owner: string;
  location: string | null;
  publicAccessBlock: Record<string, boolean> | null;
  encryption: unknown;
  lifecycle: { Rules: unknown[] } | null;
  versioning: string | null;
  /** How many objects `list-objects-v2` finds in it. */
  objects: number;
}

interface AwsCall {
  /** The argv after `--profile … --region … --output json`. */
  args: string[];
  /** The whole argv. */
  argv: string[];
}

const READ_PREFIXES = ['get-', 'list-', 'head-', 'describe-'];

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function failure(code: string, operation: string, message: string): RunResult {
  return {
    code: 254,
    stdout: '',
    stderr: `\nAn error occurred (${code}) when calling the ${operation} operation: ${message}\n`,
  };
}

function ok(value: unknown = {}): RunResult {
  return { code: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: '' };
}

class FakeAws {
  readonly ec2 = new FakeEc2();
  readonly accounts = new Map([
    ['aroom', ACCOUNT],
    ['i', ACCOUNT],
  ]);
  version = 'aws-cli/2.17.1 Python/3.11.9 Darwin/23.6.0 exe/arm64';
  /** When set, `sts get-caller-identity` fails with this message. */
  loginError: string | null = null;
  readonly buckets = new Map<string, BucketState>();
  readonly users = new Map<string, UserState>();
  readonly calls: AwsCall[] = [];
  /** Every secret access key this fake handed out. */
  readonly issuedSecrets: string[] = [];
  private keyCounter = 0;

  /** The calls that change something, as `service operation`. */
  mutations(): string[] {
    return this.calls
      .filter((call) => call.args[0] !== '--version')
      .filter((call) => !READ_PREFIXES.some((prefix) => (call.args[1] ?? '').startsWith(prefix)))
      .map((call) => `${call.args[0]} ${call.args[1]}`);
  }

  callsTo(operation: string): AwsCall[] {
    return this.calls.filter((call) => call.args[1] === operation);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  addBucket(name: string, overrides: Partial<BucketState> = {}): BucketState {
    const bucket: BucketState = {
      owner: ACCOUNT,
      location: 'eu-west-1',
      publicAccessBlock: null,
      encryption: null,
      lifecycle: null,
      versioning: null,
      objects: 0,
      ...overrides,
    };
    this.buckets.set(name, bucket);
    return bucket;
  }

  addUser(name: string): UserState {
    const user: UserState = { inline: new Map(), attached: [], keys: [] };
    this.users.set(name, user);
    return user;
  }

  addKey(userName: string, status = 'Active'): Key {
    this.keyCounter += 1;
    const key: Key = {
      id: `AKIAFAKEKEY${String(this.keyCounter).padStart(8, '0')}`,
      secret: `fakeSecret${String(this.keyCounter).padStart(4, '0')}/${'x'.repeat(24)}`,
      status,
      created: `2026-10-0${this.keyCounter}T10:00:00+00:00`,
    };
    this.issuedSecrets.push(key.secret);
    this.users.get(userName)!.keys.push(key);
    return key;
  }

  /** The CLI as `CloudDeps.run` sees it. */
  run = async (command: string, argv: string[]): Promise<RunResult> => {
    if (command !== 'aws') return { code: 127, stdout: '', stderr: `${command}: not found\n` };
    if (argv[0] === '--version') {
      this.calls.push({ args: ['--version'], argv });
      return { code: 0, stdout: `${this.version}\n`, stderr: '' };
    }
    const args = argv.slice(6);
    this.calls.push({ args, argv });
    const account = this.accounts.get(argv[1]!);
    if (
      argv[0] !== '--profile' ||
      !account ||
      argv[2] !== '--region' ||
      argv[3] !== 'eu-west-1' ||
      argv[4] !== '--output' ||
      argv[5] !== 'json'
    )
      return { code: 255, stdout: '', stderr: `unexpected global options: ${argv.slice(0, 6).join(' ')}\n` };
    if (args[0] === 'sts' && !this.loginError)
      return ok({ UserId: 'AIDAFAKE', Account: account, Arn: `arn:aws:iam::${account}:user/${argv[1]}` });
    if (this.ec2.handles(args)) return this.ec2.run(args, account);
    return this.dispatch(args);
  };

  private dispatch(args: string[]): RunResult {
    const key = `${args[0]} ${args[1]}`;
    switch (key) {
      case 'sts get-caller-identity':
        return this.loginError
          ? { code: 255, stdout: '', stderr: `${this.loginError}\n` }
          : ok({ UserId: 'AIDAFAKE', Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/i` });
      default:
        break;
    }
    if (args[0] === 's3api') return this.s3(args);
    if (args[0] === 'iam') return this.iam(args);
    return { code: 252, stdout: '', stderr: `fake aws: unknown command ${key}\n` };
  }

  private s3(args: string[]): RunResult {
    const operation = args[1]!;
    const bucketName = flagValue(args, '--bucket')!;
    const bucket = this.buckets.get(bucketName);
    if (operation === 'create-bucket') {
      if (bucket) return failure('BucketAlreadyOwnedByYou', 'CreateBucket', 'exists');
      const configuration = flagValue(args, '--create-bucket-configuration');
      this.addBucket(bucketName, {
        location: configuration ? configuration.replace('LocationConstraint=', '') : null,
      });
      return ok({ Location: `/${bucketName}` });
    }
    if (operation === 'head-bucket') {
      if (!bucket) return failure('404', 'HeadBucket', 'Not Found');
      const expected = flagValue(args, '--expected-bucket-owner');
      if (bucket.owner !== (expected ?? bucket.owner) || bucket.owner !== ACCOUNT)
        return failure('403', 'HeadBucket', 'Forbidden');
      return ok();
    }
    if (!bucket) return failure('NoSuchBucket', 'S3', 'The specified bucket does not exist');
    switch (operation) {
      case 'list-objects-v2':
        return bucket.objects > 0
          ? ok({ Contents: [{ Key: 'some-object', Size: 1 }], KeyCount: 1 })
          : ok({ KeyCount: 0 });
      case 'get-bucket-versioning':
        return ok(bucket.versioning ? { Status: bucket.versioning } : {});
      case 'get-public-access-block':
        return bucket.publicAccessBlock
          ? ok({ PublicAccessBlockConfiguration: bucket.publicAccessBlock })
          : failure('NoSuchPublicAccessBlockConfiguration', 'GetPublicAccessBlock', 'none');
      case 'put-public-access-block': {
        const pairs = flagValue(args, '--public-access-block-configuration')!.split(',');
        bucket.publicAccessBlock = Object.fromEntries(
          pairs.map((pair) => [pair.split('=')[0]!, pair.split('=')[1] === 'true']),
        );
        return ok();
      }
      case 'get-bucket-encryption':
        return bucket.encryption
          ? ok({ ServerSideEncryptionConfiguration: bucket.encryption })
          : failure('ServerSideEncryptionConfigurationNotFoundError', 'GetBucketEncryption', 'none');
      case 'put-bucket-encryption':
        bucket.encryption = JSON.parse(flagValue(args, '--server-side-encryption-configuration')!);
        return ok();
      case 'get-bucket-lifecycle-configuration':
        return bucket.lifecycle
          ? ok(bucket.lifecycle)
          : failure('NoSuchLifecycleConfiguration', 'GetBucketLifecycleConfiguration', 'none');
      case 'put-bucket-lifecycle-configuration':
        bucket.lifecycle = JSON.parse(flagValue(args, '--lifecycle-configuration')!) as { Rules: unknown[] };
        return ok();
      default:
        return { code: 252, stdout: '', stderr: `fake aws: unknown s3api ${operation}\n` };
    }
  }

  private iam(args: string[]): RunResult {
    const operation = args[1]!;
    const name = flagValue(args, '--user-name')!;
    const user = this.users.get(name);
    if (operation === 'create-user') {
      if (user) return failure('EntityAlreadyExists', 'CreateUser', 'exists');
      this.addUser(name);
      return ok({ User: { UserName: name } });
    }
    if (!user) return failure('NoSuchEntity', 'IAM', `The user with name ${name} cannot be found.`);
    switch (operation) {
      case 'get-user':
        return ok({ User: { UserName: name } });
      case 'list-user-policies':
        return ok({ PolicyNames: [...user.inline.keys()] });
      case 'list-attached-user-policies':
        return ok({ AttachedPolicies: user.attached.map((policy) => ({ PolicyName: policy })) });
      case 'get-user-policy': {
        const policyName = flagValue(args, '--policy-name')!;
        return user.inline.has(policyName)
          ? ok({ UserName: name, PolicyName: policyName, PolicyDocument: user.inline.get(policyName) })
          : failure('NoSuchEntity', 'GetUserPolicy', 'not found');
      }
      case 'put-user-policy':
        user.inline.set(flagValue(args, '--policy-name')!, JSON.parse(flagValue(args, '--policy-document')!));
        return ok();
      case 'list-access-keys':
        return ok({
          AccessKeyMetadata: user.keys.map((key) => ({
            UserName: name,
            AccessKeyId: key.id,
            Status: key.status,
            CreateDate: key.created,
          })),
        });
      case 'create-access-key': {
        if (user.keys.length >= 2) return failure('LimitExceeded', 'CreateAccessKey', 'Cannot exceed quota');
        const key = this.addKey(name);
        return ok({
          AccessKey: { UserName: name, AccessKeyId: key.id, SecretAccessKey: key.secret, Status: 'Active' },
        });
      }
      case 'delete-access-key': {
        const id = flagValue(args, '--access-key-id');
        user.keys = user.keys.filter((key) => key.id !== id);
        return ok();
      }
      default:
        return { code: 252, stdout: '', stderr: `fake aws: unknown iam ${operation}\n` };
    }
  }
}

/** A temporary HOME with the CloudDeps that use it; the lines `out` and `err` collect are in `lines`. */
export class CloudWorld {
  readonly home: string;
  readonly aws = new FakeAws();
  readonly lines: string[] = [];
  readonly errors: string[] = [];

  constructor() {
    this.home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cloud-')));
  }

  get secretsDir(): string {
    return path.join(this.home, '.config', 'projectman', 'cloud');
  }

  get envFile(): string {
    return path.join(this.secretsDir, 'cloud.env');
  }

  get configFile(): string {
    return path.join(this.secretsDir, 'config.json');
  }

  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true });
  }

  /** Everything the commands printed. */
  get output(): string {
    return [...this.lines, ...this.errors].join('\n');
  }

  deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
    return {
      run: (command, args) => this.aws.run(command, args),
      pipe: async () => ({ code: 127, stdout: '', stderr: 'no pipe in this fake' }),
      fetch: async () => {
        throw new Error('the fake has no network');
      },
      resolve: async () => [],
      out: (line) => this.lines.push(line),
      err: (line) => this.errors.push(line),
      now: () => new Date('2026-10-12T12:00:00Z'),
      sleep: async () => undefined,
      onInterrupt: () => () => undefined,
      homeDir: this.home,
      repoRoot: path.resolve(import.meta.dirname, '../../../..'),
      ...overrides,
    };
  }

  /** Writes the configuration (a mode 700 directory is created) and returns its path. */
  writeConfig(overrides: Record<string, unknown> = {}): string {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    const deployment = { imageBundle: this.bundleDir };
    writeFileSync(this.configFile, JSON.stringify({ ...baseConfig(), deployment, ...overrides }, null, 2), {
      mode: 0o600,
    });
    return this.configFile;
  }

  /** Where the image bundle of the default configuration lies (`HostWorld.writeBundle` fills it). */
  get bundleDir(): string {
    return path.join(this.home, 'bundle');
  }
}

export function baseConfig(): Record<string, unknown> {
  return {
    version: 1,
    aws: {
      compute: 'ec2',
      profile: 'aroom',
      region: 'eu-west-1',
      ec2: { ...EC2_CONFIG },
      databaseBucket: 'acme-projectman-db',
      backupBucket: 'acme-projectman-backup',
    },
    cloudflare: { zone: 'example.com', hostname: 'board.example.com' },
    access: { emails: ['Owner@Example.com'] },
    deployment: { imageBundle: 'bundle' },
  };
}
