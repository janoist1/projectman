import fs from 'node:fs';
import { z } from 'zod';
import { AwsCallError, AwsCli } from './aws-cli';
import type { CloudContext } from './context';
import { ec2Preflight, runEc2 } from './ec2';
import { CloudError, refused } from './errors';
import type { StepResult } from './report';
import { checkSecretsDir, inspectSecrets, newResticPassword, readEnvFile, updateEnvFile } from './secrets';

/**
 * The AWS steps of the cloud commands (PM-534, PM-676): `preflight` (the AWS part) and `aws`, which creates the
 * EC2 machine, the two S3 buckets, the two IAM users and their access keys. Resources are found by name, so a second
 * run changes nothing; `--dry-run` runs only reading calls and prints what it would change.
 */

interface AwsOptions {
  dryRun: boolean;
  rotateKeys: boolean;
}

const TAG_KEY = 'projectman';
const TAG_VALUE = 'cloud';
const POLICY_NAME = 'bucket-access';
const LIFECYCLE_RULE_ID = 'abort-incomplete-multipart-uploads';
const ABORT_AFTER_DAYS = 7;
const NONCURRENT_RULE_ID = 'expire-noncurrent-versions';
const NONCURRENT_DAYS = 30;

// ---- the answers of the CLI that the steps read (loose: AWS may add fields) ----

const identitySchema = z.looseObject({ Account: z.string().regex(/^\d{12}$/), Arn: z.string().optional() });
const publicAccessBlockSchema = z.looseObject({
  PublicAccessBlockConfiguration: z.looseObject({
    BlockPublicAcls: z.boolean().optional(),
    IgnorePublicAcls: z.boolean().optional(),
    BlockPublicPolicy: z.boolean().optional(),
    RestrictPublicBuckets: z.boolean().optional(),
  }),
});
const encryptionSchema = z.looseObject({
  ServerSideEncryptionConfiguration: z.looseObject({
    Rules: z.array(
      z.looseObject({
        ApplyServerSideEncryptionByDefault: z.looseObject({ SSEAlgorithm: z.string().optional() }).optional(),
        BucketKeyEnabled: z.boolean().optional(),
      }),
    ),
  }),
});
const lifecycleSchema = z.looseObject({ Rules: z.array(z.looseObject({})) });
const lifecycleRuleSchema = z.looseObject({
  ID: z.string().optional(),
  Status: z.string().optional(),
  Prefix: z.string().optional(),
  Filter: z.looseObject({ Prefix: z.string().optional() }).optional(),
  AbortIncompleteMultipartUpload: z.looseObject({ DaysAfterInitiation: z.number().optional() }).optional(),
  NoncurrentVersionExpiration: z.looseObject({ NoncurrentDays: z.number().optional() }).optional(),
  Expiration: z.looseObject({ ExpiredObjectDeleteMarker: z.boolean().optional() }).optional(),
});
const versioningSchema = z.looseObject({ Status: z.string().optional() });
const userSchema = z.looseObject({ User: z.looseObject({ UserName: z.string() }) });
const userPolicySchema = z.looseObject({ PolicyDocument: z.unknown() });
const userPolicyNamesSchema = z.looseObject({ PolicyNames: z.array(z.string()) });
const attachedPoliciesSchema = z.looseObject({
  AttachedPolicies: z.array(z.looseObject({ PolicyName: z.string().optional() })),
});
const accessKeysSchema = z.looseObject({
  AccessKeyMetadata: z.array(
    z.looseObject({
      AccessKeyId: z.string(),
      Status: z.string().optional(),
      CreateDate: z.string().optional(),
    }),
  ),
});
const newAccessKeySchema = z.looseObject({
  AccessKey: z.looseObject({ AccessKeyId: z.string(), SecretAccessKey: z.string() }),
});

// ---- policies ----

/** The inline policy of a bucket user: list and locate the bucket, read, write and delete its objects, nothing else. */
export function bucketPolicy(bucket: string): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListBucket',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation'],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: 'ObjectAccess',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  };
}

/** Key order and one-element lists do not matter to IAM; compare what it means. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalisePolicy(document: unknown): string {
  let value = document;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(decodeURIComponent(value));
    } catch {
      return String(document);
    }
  }
  const policy = value as { Version?: unknown; Statement?: unknown };
  const statements = (Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement]).map(
    (statement) => {
      const item = { ...(statement as Record<string, unknown>) };
      for (const key of ['Action', 'Resource']) {
        if (item[key] === undefined) continue;
        const list = Array.isArray(item[key]) ? (item[key] as unknown[]) : [item[key]];
        item[key] = [...list].map(String).sort();
      }
      return item;
    },
  );
  return canonical({ Version: policy.Version, Statement: statements });
}

// ---- preflight ----

/** The AWS part of `preflight`: the CLI, the login, the region, the machine type and the image, the secrets store. */
export async function awsPreflight(context: CloudContext): Promise<void> {
  const { config, report, deps } = context;
  const cli = new AwsCli(deps, config.aws);
  let failed = false;
  const check = async (name: string, body: () => Promise<StepResult>): Promise<boolean> => {
    try {
      await report.run(name, body);
      return true;
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      failed = true;
      return false;
    }
  };

  const versionOk = await check('aws-cli', async () => {
    const text = await cli.version();
    const major = /aws-cli\/(\d+)\./.exec(text)?.[1];
    if (major !== '2')
      throw refused(`the aws CLI must be version 2 (found: ${text.split(' ')[0] || 'unknown'})`);
    return { status: 'ok', detail: text.split(' ')[0] };
  });

  if (versionOk) {
    let account = '';
    const identified = await check('aws-login', async () => {
      const identity = await cli.callAs(['sts', 'get-caller-identity'], identitySchema);
      account = identity.Account;
      return {
        status: 'ok',
        detail: `profile ${config.aws.profile}, account ${identity.Account}${identity.Arn ? ` (${identity.Arn})` : ''}, region ${config.aws.region}`,
      };
    });
    if (identified) {
      await check('aws-ec2', async () => {
        await ec2Preflight(context, cli, account);
        return {
          status: 'ok',
          detail: `Ubuntu 24.04 arm64, public subnet, outbound only`,
        };
      });
    } else {
      context.report.step('skipped', 'aws-ec2', 'the login failed');
    }
  } else {
    for (const step of ['aws-login', 'aws-ec2'])
      context.report.step('skipped', step, 'the aws CLI check failed');
  }

  await check('secrets-store', async () => {
    const problems = inspectSecrets(context.secretsDir, [context.envFile, config.cloudflare.tokenFile]);
    if (problems.length > 0) throw refused(problems.join('; '));
    return { status: 'ok', detail: `${context.secretsDir} (directory 700, files 600)` };
  });

  if (failed) {
    const error = new CloudError('the AWS preflight failed', 2);
    error.reported = true;
    throw error;
  }
}

// ---- the `aws` command ----

interface UserSpec {
  suffix: string;
  bucket: (context: CloudContext) => string;
  idName: string;
  secretName: string;
}

const USERS: UserSpec[] = [
  {
    suffix: 'litestream',
    bucket: (context) => context.config.aws.databaseBucket,
    idName: 'LITESTREAM_ACCESS_KEY_ID',
    secretName: 'LITESTREAM_SECRET_ACCESS_KEY',
  },
  {
    suffix: 'restic',
    bucket: (context) => context.config.aws.backupBucket,
    idName: 'RESTIC_ACCESS_KEY_ID',
    secretName: 'RESTIC_SECRET_ACCESS_KEY',
  },
];

export async function runAws(context: CloudContext, options: AwsOptions): Promise<void> {
  const { config, report, deps } = context;
  const cli = new AwsCli(deps, config.aws);
  // The secrets store is checked before anything is created: a new access key is written to it at once.
  checkSecretsDir(context.secretsDir);
  readEnvFile(context.envFile);

  const account = await report.guard('identity', async () => {
    const identity = await cli.callAs(['sts', 'get-caller-identity'], identitySchema);
    report.step(
      'ok',
      'identity',
      `profile ${config.aws.profile}, account ${identity.Account}, region ${config.aws.region}`,
    );
    return identity.Account;
  });

  await report.guard('ec2', () => runEc2(context, cli, account, options.dryRun));
  await ensureBucket(context, cli, options, account, config.aws.databaseBucket, false);
  await ensureBucket(context, cli, options, account, config.aws.backupBucket, true);
  const existing: Record<string, boolean> = {};
  for (const user of USERS) existing[user.suffix] = await ensureUser(context, cli, options, user);
  for (const user of USERS) await ensureKey(context, cli, options, user, existing[user.suffix]!);
  await ensureEnv(context, options);
}

// ---- the S3 buckets ----

const MISSING_BUCKET = ['404', 'NoSuchBucket', 'NotFound'];
const FOREIGN_BUCKET = ['403', 'AccessDenied', 'Forbidden'];

function ownLifecycleRules(versioned: boolean) {
  return [
    {
      ID: LIFECYCLE_RULE_ID,
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_AFTER_DAYS },
    },
    ...(versioned
      ? [
          {
            ID: NONCURRENT_RULE_ID,
            Status: 'Enabled',
            Filter: { Prefix: '' },
            NoncurrentVersionExpiration: { NoncurrentDays: NONCURRENT_DAYS },
            Expiration: { ExpiredObjectDeleteMarker: true },
          },
        ]
      : []),
  ];
}

async function ensureBucket(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
  account: string,
  bucket: string,
  versioned: boolean,
): Promise<void> {
  const { region } = context.config.aws;
  const { report } = context;
  const exists = await report.guard(`bucket ${bucket}`, async () => {
    try {
      await cli.call(['s3api', 'head-bucket', '--bucket', bucket, '--expected-bucket-owner', account]);
      report.step('unchanged', `bucket ${bucket}`);
      return true;
    } catch (error) {
      if (!(error instanceof AwsCallError) || !error.awsCode) throw error;
      if (FOREIGN_BUCKET.includes(error.awsCode))
        throw refused(
          `the bucket name ${bucket} belongs to someone else (or is not accessible to this account); choose another name`,
        );
      if (!MISSING_BUCKET.includes(error.awsCode)) throw error;
    }
    if (options.dryRun) {
      report.step('skipped', `bucket ${bucket}`, 'dry-run: would create it with the settings below');
      return false;
    }
    await cli.call([
      's3api',
      'create-bucket',
      '--bucket',
      bucket,
      ...(region === 'us-east-1' ? [] : ['--create-bucket-configuration', `LocationConstraint=${region}`]),
    ]);
    report.step('created', `bucket ${bucket}`, region);
    return true;
  });
  if (!exists) {
    report.step(
      'skipped',
      `bucket-settings ${bucket}`,
      'dry-run: would block public access, set AES256 encryption and the multipart cleanup rule' +
        (versioned ? `, expire old versions after ${NONCURRENT_DAYS} days and turn versioning on` : ''),
    );
    return;
  }
  // Refuse versioned Litestream buckets before changing their settings.
  if (!versioned)
    await report.run(`versioning ${bucket}`, async (): Promise<StepResult> => {
      const answer = await cli.callAs(
        ['s3api', 'get-bucket-versioning', '--bucket', bucket],
        versioningSchema,
      );
      if (answer.Status === 'Enabled')
        throw refused(
          `versioning is on for ${bucket}; Litestream keeps its own history, so versions only cost money: ` +
            'suspend it or choose another bucket',
        );
      return { status: 'ok', detail: answer.Status === 'Suspended' ? 'suspended' : 'off' };
    });
  await report.run(`public-access-block ${bucket}`, async (): Promise<StepResult> => {
    const answer = await cli.callAsOrNull(
      ['s3api', 'get-public-access-block', '--bucket', bucket],
      ['NoSuchPublicAccessBlockConfiguration'],
      publicAccessBlockSchema,
    );
    const block = answer?.PublicAccessBlockConfiguration;
    if (
      block?.BlockPublicAcls === true &&
      block.IgnorePublicAcls === true &&
      block.BlockPublicPolicy === true &&
      block.RestrictPublicBuckets === true
    )
      return { status: 'unchanged', detail: 'all four blocks on' };
    if (options.dryRun) return { status: 'skipped', detail: 'dry-run: would turn all four blocks on' };
    await cli.call([
      's3api',
      'put-public-access-block',
      '--bucket',
      bucket,
      '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
    ]);
    return { status: 'updated', detail: 'all four blocks on' };
  });
  await report.run(`encryption ${bucket}`, async (): Promise<StepResult> => {
    const answer = await cli.callAsOrNull(
      ['s3api', 'get-bucket-encryption', '--bucket', bucket],
      ['ServerSideEncryptionConfigurationNotFoundError'],
      encryptionSchema,
    );
    const rules = answer?.ServerSideEncryptionConfiguration.Rules ?? [];
    const [rule] = rules;
    if (
      rules.length === 1 &&
      rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'AES256' &&
      rule.BucketKeyEnabled === true
    )
      return { status: 'unchanged', detail: 'AES256 with a bucket key' };
    if (options.dryRun) return { status: 'skipped', detail: 'dry-run: would set AES256 with a bucket key' };
    await cli.call([
      's3api',
      'put-bucket-encryption',
      '--bucket',
      bucket,
      '--server-side-encryption-configuration',
      JSON.stringify({
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }],
      }),
    ]);
    return { status: 'updated', detail: 'AES256 with a bucket key' };
  });
  await report.run(`lifecycle ${bucket}`, async (): Promise<StepResult> => {
    const answer = await cli.callAsOrNull(
      ['s3api', 'get-bucket-lifecycle-configuration', '--bucket', bucket],
      ['NoSuchLifecycleConfiguration'],
      lifecycleSchema,
    );
    const rules = answer?.Rules ?? [];
    const desired = ownLifecycleRules(versioned);
    const parsed = rules.map((rule) => lifecycleRuleSchema.parse(rule));
    const ownIds = new Set(desired.map((rule) => rule.ID));
    const ours = parsed.filter((rule) => rule.ID !== undefined && ownIds.has(rule.ID));
    const detail =
      `abort incomplete multipart uploads after ${ABORT_AFTER_DAYS} days` +
      (versioned
        ? `; expire noncurrent versions after ${NONCURRENT_DAYS} days and remove expired delete markers`
        : '');
    if (
      desired.every((expected) =>
        ours.some(
          (rule) =>
            rule.ID === expected.ID &&
            rule.Status === 'Enabled' &&
            (rule.Filter?.Prefix ?? rule.Prefix ?? '') === '' &&
            (expected.ID === LIFECYCLE_RULE_ID
              ? rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === ABORT_AFTER_DAYS
              : rule.NoncurrentVersionExpiration?.NoncurrentDays === NONCURRENT_DAYS &&
                rule.Expiration?.ExpiredObjectDeleteMarker === true),
        ),
      )
    )
      return { status: 'unchanged', detail };
    if (options.dryRun) return { status: 'skipped', detail: `dry-run: would ${detail}` };
    // The call replaces the whole configuration: keep the owner's other rules.
    const others = rules.filter((rule) => !ownIds.has((rule as { ID: string }).ID));
    await cli.call([
      's3api',
      'put-bucket-lifecycle-configuration',
      '--bucket',
      bucket,
      '--lifecycle-configuration',
      JSON.stringify({
        Rules: [...others, ...desired],
      }),
    ]);
    return { status: ours.length > 0 ? 'updated' : 'created', detail };
  });
  // Install expiration before enabling versioning, including when resuming a suspended bucket.
  if (versioned)
    await report.run(`versioning ${bucket}`, async (): Promise<StepResult> => {
      const answer = await cli.callAs(
        ['s3api', 'get-bucket-versioning', '--bucket', bucket],
        versioningSchema,
      );
      const detail = `on, old versions kept ${NONCURRENT_DAYS} days`;
      if (answer.Status === 'Enabled') return { status: 'unchanged', detail };
      if (options.dryRun) return { status: 'skipped', detail: 'dry-run: would turn versioning on' };
      await cli.call([
        's3api',
        'put-bucket-versioning',
        '--bucket',
        bucket,
        '--versioning-configuration',
        'Status=Enabled',
      ]);
      return { status: 'updated', detail };
    });
}

// ---- the IAM users and their keys ----

function userName(context: CloudContext, user: UserSpec): string {
  return `${context.config.aws.instanceName}-${user.suffix}`;
}

/** Creates the user if it is missing and sets its one inline policy; returns whether the user exists. */
async function ensureUser(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
  user: UserSpec,
): Promise<boolean> {
  const { report } = context;
  const name = userName(context, user);
  const bucket = user.bucket(context);
  const exists = await report.guard(`user ${name}`, async () => {
    const found = await cli.callAsOrNull(
      ['iam', 'get-user', '--user-name', name],
      ['NoSuchEntity'],
      userSchema,
    );
    if (found) {
      report.step('unchanged', `user ${name}`);
      return true;
    }
    if (options.dryRun) {
      report.step('skipped', `user ${name}`, 'dry-run: would create it');
      return false;
    }
    await cli.call([
      'iam',
      'create-user',
      '--user-name',
      name,
      '--tags',
      `Key=${TAG_KEY},Value=${TAG_VALUE}`,
    ]);
    report.step('created', `user ${name}`);
    return true;
  });
  if (!exists) {
    report.step('skipped', `policy ${name}`, `dry-run: would allow ${bucket} only`);
    return false;
  }
  await report.run(`policy ${name}`, async (): Promise<StepResult> => {
    const inline = await cli.callAs(
      ['iam', 'list-user-policies', '--user-name', name],
      userPolicyNamesSchema,
    );
    const attached = await cli.callAs(
      ['iam', 'list-attached-user-policies', '--user-name', name],
      attachedPoliciesSchema,
    );
    const others = [
      ...inline.PolicyNames.filter((policy) => policy !== POLICY_NAME),
      ...attached.AttachedPolicies.map((policy) => policy.PolicyName ?? 'a managed policy'),
    ];
    if (others.length > 0)
      throw refused(
        `${name} has other policies (${others.join(', ')}); it must have only ${POLICY_NAME}. Nothing is changed`,
      );
    const wanted = bucketPolicy(bucket);
    const current = await cli.callAsOrNull(
      ['iam', 'get-user-policy', '--user-name', name, '--policy-name', POLICY_NAME],
      ['NoSuchEntity'],
      userPolicySchema,
    );
    const detail = `${POLICY_NAME}: ${bucket} only`;
    if (current && normalisePolicy(current.PolicyDocument) === normalisePolicy(wanted))
      return { status: 'unchanged', detail };
    if (options.dryRun) return { status: 'skipped', detail: `dry-run: would set ${detail}` };
    await cli.call([
      'iam',
      'put-user-policy',
      '--user-name',
      name,
      '--policy-name',
      POLICY_NAME,
      '--policy-document',
      JSON.stringify(wanted),
    ]);
    return { status: current ? 'updated' : 'created', detail };
  });
  return true;
}

type AccessKeyMetadata = z.output<typeof accessKeysSchema>['AccessKeyMetadata'][number];

/** The key to delete to make room for a new one (an IAM user holds two at most): an inactive one, else the oldest. */
function pickVictim(keys: AccessKeyMetadata[]): AccessKeyMetadata {
  const inactive = keys.find((key) => key.Status !== 'Active');
  if (inactive) return inactive;
  return [...keys].sort((a, b) => (a.CreateDate ?? '').localeCompare(b.CreateDate ?? ''))[0]!;
}

async function deleteKey(cli: AwsCli, name: string, keyId: string): Promise<void> {
  await cli.call(['iam', 'delete-access-key', '--user-name', name, '--access-key-id', keyId]);
}

/** New key, written to cloud.env at once; then the old keys go. The secret only passes through memory. */
async function createKey(
  context: CloudContext,
  cli: AwsCli,
  user: UserSpec,
  name: string,
  old: AccessKeyMetadata[],
): Promise<void> {
  let remaining = [...old];
  if (remaining.length >= 2) {
    const victim = pickVictim(remaining);
    await deleteKey(cli, name, victim.AccessKeyId);
    remaining = remaining.filter((key) => key !== victim);
  }
  const { AccessKey: created } = await cli.callAs(
    ['iam', 'create-access-key', '--user-name', name],
    newAccessKeySchema,
  );
  context.report.protect(created.SecretAccessKey);
  try {
    updateEnvFile(context.envFile, {
      [user.idName]: created.AccessKeyId,
      [user.secretName]: created.SecretAccessKey,
    });
  } catch (error) {
    // The key could not be kept: do not leave an unknown key behind.
    await deleteKey(cli, name, created.AccessKeyId).catch(() => undefined);
    throw error;
  }
  for (const key of remaining) await deleteKey(cli, name, key.AccessKeyId);
}

async function ensureKey(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
  user: UserSpec,
  userExists: boolean,
): Promise<void> {
  const name = userName(context, user);
  await context.report.run(`access-key ${name}`, async (): Promise<StepResult> => {
    if (!userExists)
      return { status: 'skipped', detail: 'dry-run: the user does not exist yet; it would get a key' };
    const listed = (await cli.callAs(['iam', 'list-access-keys', '--user-name', name], accessKeysSchema))
      .AccessKeyMetadata;
    const env = readEnvFile(context.envFile);
    const knownId = env.get(user.idName);
    const known = knownId ? listed.find((key) => key.AccessKeyId === knownId) : undefined;
    const usable = known?.Status === 'Active' && Boolean(env.get(user.secretName));
    if (!options.rotateKeys) {
      // An extra key next to the known one (for example left behind by an interrupted run) is unknown too.
      const strangers = listed.filter((key) => key.AccessKeyId !== knownId);
      if (usable && strangers.length === 0)
        return { status: 'unchanged', detail: 'the key in cloud.env is active' };
      if (listed.length > 0)
        throw refused(
          usable
            ? `${name} has ${strangers.length} access key(s) besides the one in cloud.env. ` +
                'Nothing is changed; run with --rotate-keys to replace its keys (then the machine needs a deploy)'
            : `${name} has ${listed.length} access key(s) that cloud.env does not hold as an active key, ` +
                'and a secret key cannot be read back from AWS. Nothing is changed; run with --rotate-keys to replace ' +
                'its keys (then the machine needs a deploy)',
        );
      if (options.dryRun)
        return { status: 'skipped', detail: 'dry-run: would create a key and write it to cloud.env' };
      await createKey(context, cli, user, name, []);
      return { status: 'created', detail: 'written to cloud.env' };
    }
    if (options.dryRun)
      return {
        status: 'skipped',
        detail: `dry-run: would create a new key, write it to cloud.env and delete the ${listed.length} old one(s)`,
      };
    await createKey(context, cli, user, name, listed);
    if (listed.length === 0) return { status: 'created', detail: 'written to cloud.env' };
    context.report.line(
      `note: the keys of ${name} were replaced; the machine needs a deploy to get the new cloud.env`,
    );
    return { status: 'updated', detail: 'new key written to cloud.env, old keys deleted' };
  });
}

// ---- cloud.env ----

async function ensureEnv(context: CloudContext, options: AwsOptions): Promise<void> {
  const { config, report, envFile } = context;
  const { region, databaseBucket, backupBucket } = config.aws;
  const endpoint = `https://s3.${region}.amazonaws.com`;
  const wanted: Record<string, string> = {
    LITESTREAM_BUCKET: databaseBucket,
    LITESTREAM_ENDPOINT: endpoint,
    LITESTREAM_REGION: region,
    RESTIC_REPOSITORY: `s3:${endpoint}/${backupBucket}/projectman`,
    RESTIC_REGION: region,
  };
  await report.run('cloud-env', async (): Promise<StepResult | void> => {
    const env = readEnvFile(envFile);
    const names = Object.keys(wanted).filter((name) => env.get(name) !== wanted[name]);
    const needsPassword = !env.get('RESTIC_PASSWORD');
    if (names.length === 0 && !needsPassword) return { status: 'unchanged', detail: envFile };
    const listing = [...names, ...(needsPassword ? ['RESTIC_PASSWORD'] : [])].join(', ');
    if (options.dryRun) return { status: 'skipped', detail: `dry-run: would set ${listing}` };
    const updates = { ...wanted };
    if (needsPassword) {
      const password = newResticPassword();
      report.protect(password);
      updates.RESTIC_PASSWORD = password;
    }
    const existed = fs.existsSync(envFile);
    updateEnvFile(envFile, updates);
    report.step(existed ? 'updated' : 'created', 'cloud-env', `${envFile}: ${listing}`);
    if (needsPassword)
      report.line(
        'note: save RESTIC_PASSWORD from cloud.env in a password manager now; without it the restic backups cannot be read',
      );
  });
}
