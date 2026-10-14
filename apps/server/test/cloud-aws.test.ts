import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucketPolicy } from '../../../scripts/cloud/aws';
import { runCloud } from '../../../scripts/cloud/commands';
import { CloudWorld } from './helpers/fake-aws';

/** `npm run cloud -- aws` (PM-534) against a fake `aws` CLI that keeps state. */

let world: CloudWorld;
beforeEach(() => {
  world = new CloudWorld();
  world.writeConfig();
});
afterEach(() => world.cleanup());

const run = (...args: string[]) => runCloud(['aws', ...args], world.deps());
const envText = () => readFileSync(world.envFile, 'utf8');
const envValues = () =>
  new Map(
    envText()
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );

describe('aws: the first run', () => {
  it('creates the machine, the buckets, the users, the keys and cloud.env', async () => {
    expect(await run()).toBe(0);
    const created = world.aws.callsTo('create-instances');
    expect(created).toHaveLength(1);
    expect(created[0]!.args).toEqual([
      'lightsail',
      'create-instances',
      '--instance-names',
      'projectman-cloud',
      '--availability-zone',
      'eu-west-1a',
      '--blueprint-id',
      'ubuntu_24_04',
      '--bundle-id',
      'small_3_0',
      '--ip-address-type',
      'ipv4',
      '--tags',
      'key=projectman,value=cloud',
    ]);
    expect(world.aws.instance?.state).toBe('running');
    expect(world.aws.instance?.metadata).toEqual({ httpTokens: 'required', httpPutResponseHopLimit: 1 });
    for (const name of ['acme-projectman-db', 'acme-projectman-backup']) {
      const bucket = world.aws.buckets.get(name)!;
      expect(bucket.location).toBe('eu-west-1');
      expect(bucket.publicAccessBlock).toEqual({
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      });
      expect(bucket.encryption).toEqual({
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }],
      });
      expect(bucket.lifecycle).toEqual({
        Rules: [
          {
            ID: 'abort-incomplete-multipart-uploads',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      });
    }
    expect([...world.aws.users.keys()].sort()).toEqual([
      'projectman-cloud-litestream',
      'projectman-cloud-restic',
    ]);
    for (const user of world.aws.users.values()) expect(user.keys).toHaveLength(1);
    const env = envValues();
    expect(env.get('LITESTREAM_BUCKET')).toBe('acme-projectman-db');
    expect(env.get('LITESTREAM_ENDPOINT')).toBe('https://s3.eu-west-1.amazonaws.com');
    expect(env.get('LITESTREAM_REGION')).toBe('eu-west-1');
    expect(env.get('RESTIC_REPOSITORY')).toBe(
      's3:https://s3.eu-west-1.amazonaws.com/acme-projectman-backup/projectman',
    );
    expect(env.get('RESTIC_REGION')).toBe('eu-west-1');
    const litestream = world.aws.users.get('projectman-cloud-litestream')!.keys[0]!;
    const restic = world.aws.users.get('projectman-cloud-restic')!.keys[0]!;
    expect(env.get('LITESTREAM_ACCESS_KEY_ID')).toBe(litestream.id);
    expect(env.get('LITESTREAM_SECRET_ACCESS_KEY')).toBe(litestream.secret);
    expect(env.get('RESTIC_ACCESS_KEY_ID')).toBe(restic.id);
    expect(env.get('RESTIC_SECRET_ACCESS_KEY')).toBe(restic.secret);
    expect(env.get('RESTIC_PASSWORD')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(world.output).toContain('save RESTIC_PASSWORD');
  });

  it('writes the secrets store with the modes 700 and 600', async () => {
    expect(await run()).toBe(0);
    expect(statSync(world.secretsDir).mode & 0o777).toBe(0o700);
    expect(statSync(world.envFile).mode & 0o777).toBe(0o600);
  });

  it('opens one port only: 22/tcp for lightsail-connect', async () => {
    expect(await run()).toBe(0);
    expect(world.aws.instance?.ports).toEqual([
      {
        fromPort: 22,
        toPort: 22,
        protocol: 'tcp',
        cidrs: [],
        ipv6Cidrs: [],
        cidrListAliases: ['lightsail-connect'],
      },
    ]);
    const put = world.aws.callsTo('put-instance-public-ports');
    expect(put).toHaveLength(1);
    expect(JSON.parse(put[0]!.args[put[0]!.args.indexOf('--port-infos') + 1]!)).toEqual([
      { fromPort: 22, toPort: 22, protocol: 'tcp', cidrListAliases: ['lightsail-connect'] },
    ]);
  });

  it('gives each user exactly the policy of its bucket', async () => {
    expect(await run()).toBe(0);
    const policy = world.aws.users.get('projectman-cloud-litestream')!.inline.get('bucket-access');
    expect(policy).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ListBucket',
          Effect: 'Allow',
          Action: ['s3:ListBucket', 's3:GetBucketLocation'],
          Resource: 'arn:aws:s3:::acme-projectman-db',
        },
        {
          Sid: 'ObjectAccess',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          Resource: 'arn:aws:s3:::acme-projectman-db/*',
        },
      ],
    });
    expect(world.aws.users.get('projectman-cloud-restic')!.inline.get('bucket-access')).toEqual(
      bucketPolicy('acme-projectman-backup'),
    );
    expect(world.aws.users.get('projectman-cloud-restic')!.inline.size).toBe(1);
  });

  it('puts the profile, the region and the JSON output on every call', async () => {
    expect(await run()).toBe(0);
    const calls = world.aws.calls.filter((call) => call.args[0] !== '--version');
    expect(calls.length).toBeGreaterThan(20);
    for (const call of calls)
      expect(call.argv.slice(0, 6)).toEqual(['--profile', 'i', '--region', 'eu-west-1', '--output', 'json']);
  });

  it('omits the location constraint in us-east-1', async () => {
    world.writeConfig({
      aws: {
        region: 'us-east-1',
        databaseBucket: 'acme-projectman-db',
        backupBucket: 'acme-projectman-backup',
      },
    });
    // The fake only speaks eu-west-1: ask for the create call by running until the buckets.
    const deps = world.deps();
    const original = deps.run;
    deps.run = (command, args, options) =>
      original(
        command,
        ['--profile', 'i', '--region', 'eu-west-1', '--output', 'json', ...args.slice(6)],
        options,
      );
    expect(await runCloud(['aws'], deps)).toBe(0);
    const create = world.aws.callsTo('create-bucket')[0]!;
    expect(create.args).not.toContain('--create-bucket-configuration');
  });
});

describe('aws: the second run', () => {
  it('changes nothing and calls no operation that changes anything', async () => {
    expect(await run()).toBe(0);
    const before = envText();
    world.aws.clearCalls();
    world.lines.length = 0;
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(envText()).toBe(before);
    const steps = world.lines.filter((line) => /^(ok|created|updated|unchanged|skipped) /.test(line));
    expect(steps.length).toBeGreaterThan(15);
    expect(steps.filter((line) => /^(created|updated) /.test(line))).toEqual([]);
    expect(world.lines.some((line) => line.startsWith('FAIL'))).toBe(false);
  });
});

describe('aws --dry-run', () => {
  it('on an empty account makes no changing call and writes nothing', async () => {
    expect(await run('--dry-run')).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(existsSync(world.envFile)).toBe(false);
    expect(world.output).toContain('dry-run: would create projectman-cloud');
    expect(world.output).toContain('dry-run: would create it with the settings below');
    expect(world.output).toContain('would create it');
  });

  it('on a half-finished account prints each change and makes none', async () => {
    world.aws.addInstance();
    world.aws.addBucket('acme-projectman-db');
    world.aws.addUser('projectman-cloud-litestream');
    expect(await run('--dry-run')).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.output).toContain('dry-run: would require IMDSv2');
    expect(world.output).toContain('dry-run: would replace the open ports');
    expect(world.output).toContain('dry-run: would turn all four blocks on');
    expect(world.output).toContain('dry-run: would create a key and write it to cloud.env');
    expect(existsSync(world.envFile)).toBe(false);
  });
});

describe('aws: the instance', () => {
  it('refuses a machine of another size without changing anything', async () => {
    world.aws.addInstance({ bundleId: 'medium_3_0' });
    expect(await run()).toBe(2);
    expect(world.output).toContain('FAIL instance');
    expect(world.output).toContain('medium_3_0');
    expect(world.aws.mutations()).toEqual([]);
  });

  it('refuses a machine of another image', async () => {
    world.aws.addInstance({ blueprintId: 'debian_12' });
    expect(await run()).toBe(2);
    expect(world.aws.mutations()).toEqual([]);
  });
});

describe('aws: the buckets', () => {
  it('refuses a bucket name that belongs to someone else (403) and creates nothing after it', async () => {
    world.aws.addInstance({ metadata: { httpTokens: 'required', httpPutResponseHopLimit: 1 } });
    world.aws.addBucket('acme-projectman-db', { owner: '999999999999' });
    expect(await run()).toBe(2);
    expect(world.output).toContain('FAIL bucket acme-projectman-db');
    expect(world.output).toContain('belongs to someone else');
    expect(world.aws.mutations()).toEqual(['lightsail put-instance-public-ports']);
    expect(world.aws.callsTo('create-bucket')).toEqual([]);
    expect(world.aws.users.size).toBe(0);
  });

  it('refuses a bucket with versioning on', async () => {
    world.aws.addBucket('acme-projectman-db', { versioning: 'Enabled' });
    expect(await run()).toBe(2);
    expect(world.output).toContain('versioning is on for acme-projectman-db');
    expect(world.aws.callsTo('put-public-access-block')).toEqual([]);
    expect(world.aws.users.size).toBe(0);
  });

  it('accepts a bucket whose versioning is suspended', async () => {
    world.aws.addBucket('acme-projectman-db', { versioning: 'Suspended' });
    expect(await run()).toBe(0);
  });

  it('keeps the other lifecycle rules of a bucket', async () => {
    const mine = {
      ID: 'expire-logs',
      Status: 'Enabled',
      Filter: { Prefix: 'logs/' },
      Expiration: { Days: 30 },
    };
    world.aws.addBucket('acme-projectman-backup', { lifecycle: { Rules: [mine] } });
    expect(await run()).toBe(0);
    const rules = world.aws.buckets.get('acme-projectman-backup')!.lifecycle!.Rules;
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual(mine);
  });
});

describe('aws: the users and their policies', () => {
  it('replaces a policy that differs and keeps one that only reorders', async () => {
    expect(await run()).toBe(0);
    const user = world.aws.users.get('projectman-cloud-restic')!;
    const policy = bucketPolicy('acme-projectman-backup') as { Statement: { Action: string[] }[] };
    policy.Statement.forEach((statement) => statement.Action.reverse());
    user.inline.set('bucket-access', policy);
    world.aws.clearCalls();
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    user.inline.set('bucket-access', {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
    });
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual(['iam put-user-policy']);
    expect(user.inline.get('bucket-access')).toEqual(bucketPolicy('acme-projectman-backup'));
  });

  it('refuses a user that has another policy', async () => {
    expect(await run()).toBe(0);
    world.aws.users.get('projectman-cloud-litestream')!.attached.push('AdministratorAccess');
    world.aws.clearCalls();
    expect(await run()).toBe(2);
    expect(world.output).toContain('AdministratorAccess');
    expect(world.aws.mutations()).toEqual([]);
  });
});

describe('aws: the access keys', () => {
  it('refuses a key that cloud.env does not hold, and changes nothing', async () => {
    world.aws.addUser('projectman-cloud-litestream');
    world.aws.addKey('projectman-cloud-litestream');
    expect(await run()).toBe(2);
    expect(world.output).toContain('--rotate-keys');
    expect(world.aws.callsTo('create-access-key')).toEqual([]);
    expect(world.aws.callsTo('delete-access-key')).toEqual([]);
    expect(world.aws.users.get('projectman-cloud-litestream')!.keys).toHaveLength(1);
  });

  it('refuses a stranger key next to the known one, and rotation removes both', async () => {
    expect(await run()).toBe(0);
    const known = world.aws.users.get('projectman-cloud-litestream')!.keys[0]!;
    world.aws.addKey('projectman-cloud-litestream');
    world.aws.clearCalls();
    expect(await run()).toBe(2);
    expect(world.output).toContain('FAIL access-key projectman-cloud-litestream');
    expect(world.output).toContain('besides the one in cloud.env');
    expect(world.aws.mutations()).toEqual([]);
    expect(await run('--rotate-keys')).toBe(0);
    const keys = world.aws.users.get('projectman-cloud-litestream')!.keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).not.toBe(known.id);
    expect(envValues().get('LITESTREAM_ACCESS_KEY_ID')).toBe(keys[0]!.id);
  });

  it('refuses a key that cloud.env holds but AWS has made inactive', async () => {
    expect(await run()).toBe(0);
    world.aws.users.get('projectman-cloud-restic')!.keys[0]!.status = 'Inactive';
    expect(await run()).toBe(2);
    expect(world.output).toContain('FAIL access-key projectman-cloud-restic');
  });

  it('with --rotate-keys writes the new key first and deletes the old ones', async () => {
    expect(await run()).toBe(0);
    const oldKeys = [...world.aws.users.values()].map((user) => user.keys[0]!);
    const oldIds = oldKeys.map((key) => key.id);
    world.aws.clearCalls();
    world.lines.length = 0;
    expect(await run('--rotate-keys')).toBe(0);
    for (const user of world.aws.users.values()) {
      expect(user.keys).toHaveLength(1);
      expect(oldIds).not.toContain(user.keys[0]!.id);
    }
    const fresh = world.aws.users.get('projectman-cloud-litestream')!.keys[0]!;
    expect(envValues().get('LITESTREAM_ACCESS_KEY_ID')).toBe(fresh.id);
    expect(envValues().get('LITESTREAM_SECRET_ACCESS_KEY')).toBe(fresh.secret);
    const operations = world.aws.mutations();
    expect(operations.indexOf('iam create-access-key')).toBeLessThan(
      operations.indexOf('iam delete-access-key'),
    );
    expect(world.output).toContain('needs a deploy');
  });

  it('with --rotate-keys makes room when the user already holds two keys', async () => {
    world.aws.addUser('projectman-cloud-litestream');
    world.aws.addKey('projectman-cloud-litestream');
    world.aws.addKey('projectman-cloud-litestream');
    expect(await run('--rotate-keys')).toBe(0);
    expect(world.aws.users.get('projectman-cloud-litestream')!.keys).toHaveLength(1);
  });

  it('does not rotate on a dry run', async () => {
    expect(await run()).toBe(0);
    world.aws.clearCalls();
    expect(await run('--rotate-keys', '--dry-run')).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.output).toContain('dry-run: would create a new key');
  });
});

describe('aws: cloud.env', () => {
  it('keeps the RESTIC_PASSWORD and the lines it does not know, and mends a changed bucket name', async () => {
    expect(await run()).toBe(0);
    const password = envValues().get('RESTIC_PASSWORD');
    const text = envText().replace(
      'LITESTREAM_BUCKET=acme-projectman-db',
      'LITESTREAM_BUCKET=old\nTUNNEL_TOKEN=abc',
    );
    writeFileSync(world.envFile, `# mine\n${text}`);
    world.aws.clearCalls();
    world.lines.length = 0;
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(envValues().get('RESTIC_PASSWORD')).toBe(password);
    expect(envValues().get('LITESTREAM_BUCKET')).toBe('acme-projectman-db');
    expect(envValues().get('TUNNEL_TOKEN')).toBe('abc');
    expect(envText().startsWith('# mine\n')).toBe(true);
    expect(world.lines.some((line) => line.startsWith('updated cloud-env'))).toBe(true);
  });

  it('keeps the e-mail login settings the owner added (PM-669) through a repair and a key rotation', async () => {
    expect(await run()).toBe(0);
    const owned = [
      'PROJECTMAN_EMAIL_LOGIN_ENABLED=1',
      'PROJECTMAN_SES_REGION=eu-central-1',
      'PROJECTMAN_SES_FROM=belepes@istvan.io',
      'PROJECTMAN_SES_ACCESS_KEY_ID=AKIASESEXAMPLE000001',
      'PROJECTMAN_SES_SECRET_ACCESS_KEY=ses-secret-example-value',
      'PROJECTMAN_SES_SESSION_TOKEN=ses-session-token-example',
    ];
    writeFileSync(
      world.envFile,
      `${envText().replace('LITESTREAM_BUCKET=acme-projectman-db', 'LITESTREAM_BUCKET=old')}${owned.join('\n')}\n`,
      { mode: 0o600 },
    );
    expect(await run()).toBe(0);
    expect(envValues().get('LITESTREAM_BUCKET')).toBe('acme-projectman-db');
    expect(await run('--rotate-keys')).toBe(0);
    for (const line of owned) expect(envText().split('\n')).toContain(line);
    expect(world.output).not.toContain('ses-secret-example-value');
    expect(world.output).not.toContain('ses-session-token-example');
  });

  it('refuses an env file that others can read, before any call changes anything', async () => {
    expect(await run()).toBe(0);
    chmodSync(world.envFile, 0o644);
    world.aws.clearCalls();
    expect(await run()).toBe(2);
    expect(world.aws.calls).toEqual([]);
    expect(world.output).toContain('mode 644');
  });

  it('refuses a secrets directory that others can enter', async () => {
    chmodSync(world.secretsDir, 0o755);
    expect(await run()).toBe(2);
    expect(world.aws.calls).toEqual([]);
  });
});

describe('aws: no secret leaks', () => {
  it('prints no secret and passes none in an argument', async () => {
    expect(await run()).toBe(0);
    expect(await run('--rotate-keys')).toBe(0);
    const secrets = [...world.aws.issuedSecrets, envValues().get('RESTIC_PASSWORD')!];
    expect(world.aws.issuedSecrets.length).toBe(4);
    const argv = world.aws.calls.map((call) => call.argv.join(' ')).join('\n');
    for (const secret of secrets) {
      expect(world.output).not.toContain(secret);
      expect(argv).not.toContain(secret);
    }
  });

  it('deletes a new key that could not be kept, and prints no secret', async () => {
    expect(await run('--dry-run')).toBe(0);
    mkdirSync(world.secretsDir, { recursive: true });
    chmodSync(world.secretsDir, 0o500);
    try {
      expect(await run()).toBe(1);
    } finally {
      chmodSync(world.secretsDir, 0o700);
    }
    expect(world.output).toContain('FAIL access-key projectman-cloud-litestream');
    expect(world.aws.users.get('projectman-cloud-litestream')!.keys).toEqual([]);
    expect(world.aws.issuedSecrets.length).toBe(1);
    expect(world.output).not.toContain(world.aws.issuedSecrets[0]!);
    expect(existsSync(world.envFile)).toBe(false);
  });
});
