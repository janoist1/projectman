import fs from 'node:fs';
import { z } from 'zod';
import { AwsCallError, AwsCli } from './aws-cli';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { StepResult } from './report';
import { checkSecretsDir, inspectSecrets, newResticPassword, readEnvFile, updateEnvFile } from './secrets';

/**
 * The AWS steps of the cloud commands (PM-534): `preflight` (the AWS part) and `aws`, which creates the Lightsail
 * machine, the two S3 buckets, the two IAM users and their access keys. Everything is found by name, so a second
 * run changes nothing; `--dry-run` runs only reading calls and prints what it would change.
 */

export interface AwsOptions {
  dryRun: boolean;
  rotateKeys: boolean;
}

const POLICY_NAME = 'bucket-access';
const TAG_KEY = 'projectman';
const TAG_VALUE = 'cloud';
const FIREWALL_ALIAS = 'lightsail-connect';
const LIFECYCLE_RULE_ID = 'abort-incomplete-multipart-uploads';
const ABORT_AFTER_DAYS = 7;
const WAIT_ATTEMPTS = 90;
const WAIT_INTERVAL_MS = 5_000;

// ---- the answers of the CLI that the steps read (loose: AWS may add fields) ----

const identitySchema = z.looseObject({ Account: z.string().regex(/^\d{12}$/), Arn: z.string().optional() });
const regionsSchema = z.looseObject({
  regions: z.array(
    z.looseObject({
      name: z.string(),
      availabilityZones: z.array(z.looseObject({ zoneName: z.string() })).optional(),
    }),
  ),
});
const bundlesSchema = z.looseObject({
  bundles: z.array(z.looseObject({ bundleId: z.string(), isActive: z.boolean().optional() })),
  nextPageToken: z.string().optional(),
});
const blueprintsSchema = z.looseObject({
  blueprints: z.array(z.looseObject({ blueprintId: z.string(), isActive: z.boolean().optional() })),
  nextPageToken: z.string().optional(),
});
const instanceSchema = z.looseObject({
  instance: z.looseObject({
    name: z.string(),
    bundleId: z.string(),
    blueprintId: z.string(),
    state: z.looseObject({ name: z.string() }),
    metadataOptions: z
      .looseObject({
        httpTokens: z.string().optional(),
        httpPutResponseHopLimit: z.number().optional(),
      })
      .optional(),
  }),
});
const portStatesSchema = z.looseObject({
  portStates: z.array(
    z.looseObject({
      fromPort: z.number(),
      toPort: z.number(),
      protocol: z.string(),
      cidrs: z.array(z.string()).optional(),
      ipv6Cidrs: z.array(z.string()).optional(),
      cidrListAliases: z.array(z.string()).optional(),
    }),
  ),
});
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
    const identified = await check('aws-login', async () => {
      const identity = await cli.callAs(['sts', 'get-caller-identity'], identitySchema);
      return {
        status: 'ok',
        detail: `profile ${config.aws.profile}, account ${identity.Account}${identity.Arn ? ` (${identity.Arn})` : ''}`,
      };
    });
    if (identified) {
      await check('aws-region', async () => {
        const answer = await cli.callAs(
          ['lightsail', 'get-regions', '--include-availability-zones'],
          regionsSchema,
        );
        const region = answer.regions.find((item) => item.name === config.aws.region);
        if (!region) throw refused(`Lightsail has no region ${config.aws.region}`);
        const zones = region.availabilityZones?.map((zone) => zone.zoneName) ?? [];
        if (zones.length > 0 && !zones.includes(config.aws.availabilityZone))
          throw refused(`${config.aws.availabilityZone} is not an availability zone of ${config.aws.region}`);
        return { status: 'ok', detail: `${config.aws.region}, ${config.aws.availabilityZone}` };
      });
      await check('aws-bundle', async () => {
        const bundles = await pages(cli, ['lightsail', 'get-bundles'], bundlesSchema, (page) => page.bundles);
        const bundle = bundles.find((item) => item.bundleId === config.aws.bundleId);
        if (!bundle || bundle.isActive === false)
          throw refused(`the Lightsail bundle ${config.aws.bundleId} does not exist or is not active`);
        return { status: 'ok', detail: config.aws.bundleId };
      });
      await check('aws-blueprint', async () => {
        const blueprints = await pages(
          cli,
          ['lightsail', 'get-blueprints'],
          blueprintsSchema,
          (page) => page.blueprints,
        );
        const blueprint = blueprints.find((item) => item.blueprintId === config.aws.blueprintId);
        if (!blueprint || blueprint.isActive === false)
          throw refused(`the Lightsail blueprint ${config.aws.blueprintId} does not exist or is not active`);
        return { status: 'ok', detail: config.aws.blueprintId };
      });
    }
    if (!identified)
      for (const step of ['aws-region', 'aws-bundle', 'aws-blueprint'])
        context.report.step('skipped', step, 'the login failed');
  } else {
    for (const step of ['aws-login', 'aws-region', 'aws-bundle', 'aws-blueprint'])
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

async function pages<S extends z.ZodType<{ nextPageToken?: string | undefined }>, T>(
  cli: AwsCli,
  command: string[],
  schema: S,
  items: (page: z.output<S>) => T[],
): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await cli.callAs(token ? [...command, '--page-token', token] : command, schema);
    all.push(...items(page));
    token = page.nextPageToken;
    if (!token) break;
  }
  return all;
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
    report.step('ok', 'identity', `profile ${config.aws.profile}, account ${identity.Account}`);
    return identity.Account;
  });

  const instanceFound = await ensureInstance(context, cli, options);
  await ensureMetadataOptions(context, cli, options, instanceFound);
  await ensureFirewall(context, cli, options, instanceFound);
  for (const bucket of [config.aws.databaseBucket, config.aws.backupBucket])
    await ensureBucket(context, cli, options, account, bucket);
  const existing: Record<string, boolean> = {};
  for (const user of USERS) existing[user.suffix] = await ensureUser(context, cli, options, user);
  for (const user of USERS) await ensureKey(context, cli, options, user, existing[user.suffix]!);
  await ensureEnv(context, options);
}

// ---- the Lightsail machine ----

type InstanceState = z.output<typeof instanceSchema>['instance'];

async function readInstance(context: CloudContext, cli: AwsCli): Promise<InstanceState | null> {
  const answer = await cli.callAsOrNull(
    ['lightsail', 'get-instance', '--instance-name', context.config.aws.instanceName],
    ['NotFoundException'],
    instanceSchema,
  );
  return answer?.instance ?? null;
}

async function waitRunning(context: CloudContext, cli: AwsCli): Promise<InstanceState> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const instance = await readInstance(context, cli);
    if (!instance) throw new CloudError(`the instance ${context.config.aws.instanceName} disappeared`);
    const state = instance.state.name;
    if (state === 'running') return instance;
    if (state !== 'pending') throw new CloudError(`the instance is ${state}, not running`);
    await context.deps.sleep(WAIT_INTERVAL_MS);
  }
  throw new CloudError('the instance did not reach the running state in time');
}

async function ensureInstance(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
): Promise<InstanceState | null> {
  const { aws } = context.config;
  return context.report.guard('instance', async () => {
    let instance = await readInstance(context, cli);
    const describe = (state: string) => `${aws.instanceName} (${aws.bundleId}, ${aws.blueprintId}, ${state})`;
    if (!instance) {
      if (options.dryRun) {
        context.report.step(
          'skipped',
          'instance',
          `dry-run: would create ${describe('new')} in ${aws.availabilityZone}`,
        );
        return null;
      }
      await cli.call([
        'lightsail',
        'create-instances',
        '--instance-names',
        aws.instanceName,
        '--availability-zone',
        aws.availabilityZone,
        '--blueprint-id',
        aws.blueprintId,
        '--bundle-id',
        aws.bundleId,
        '--ip-address-type',
        'ipv4',
        '--tags',
        `key=${TAG_KEY},value=${TAG_VALUE}`,
      ]);
      instance = await waitRunning(context, cli);
      context.report.step('created', 'instance', describe(instance.state.name));
      return instance;
    }
    if (instance.bundleId !== aws.bundleId || instance.blueprintId !== aws.blueprintId)
      throw refused(
        `${aws.instanceName} exists with bundle ${instance.bundleId} and blueprint ${instance.blueprintId}, ` +
          `not ${aws.bundleId} and ${aws.blueprintId}; nothing is changed (a different size or image means a new machine)`,
      );
    if (instance.state.name === 'pending' && !options.dryRun) instance = await waitRunning(context, cli);
    context.report.step('unchanged', 'instance', describe(instance.state.name));
    return instance;
  });
}

async function ensureMetadataOptions(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
  instance: InstanceState | null,
): Promise<void> {
  await context.report.run('imds', async (): Promise<StepResult> => {
    if (!instance)
      return {
        status: 'skipped',
        detail: 'dry-run: the instance does not exist yet; it would get IMDSv2 only',
      };
    const current = instance.metadataOptions;
    if (current?.httpTokens === 'required' && current.httpPutResponseHopLimit === 1)
      return { status: 'unchanged', detail: 'IMDSv2 required, hop limit 1' };
    if (options.dryRun)
      return { status: 'skipped', detail: 'dry-run: would require IMDSv2 and set the hop limit to 1' };
    await cli.call([
      'lightsail',
      'update-instance-metadata-options',
      '--instance-name',
      context.config.aws.instanceName,
      '--http-tokens',
      'required',
      '--http-put-response-hop-limit',
      '1',
    ]);
    return { status: 'updated', detail: 'IMDSv2 required, hop limit 1' };
  });
}

/** The only open port: SSH, for Lightsail's own browser client. Nothing else; the tunnel connects outwards. */
export const FIREWALL_PORTS = [
  { fromPort: 22, toPort: 22, protocol: 'tcp', cidrListAliases: [FIREWALL_ALIAS] },
] as const;

async function ensureFirewall(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
  instance: InstanceState | null,
): Promise<void> {
  await context.report.run('firewall', async (): Promise<StepResult> => {
    if (!instance)
      return {
        status: 'skipped',
        detail: `dry-run: the instance does not exist yet; it would open 22/tcp to ${FIREWALL_ALIAS} only`,
      };
    const name = context.config.aws.instanceName;
    const answer = await cli.callAs(
      ['lightsail', 'get-instance-port-states', '--instance-name', name],
      portStatesSchema,
    );
    const states = answer.portStates;
    const [only] = states;
    const matches =
      states.length === 1 &&
      only !== undefined &&
      only.fromPort === 22 &&
      only.toPort === 22 &&
      only.protocol === 'tcp' &&
      (only.cidrs ?? []).length === 0 &&
      (only.ipv6Cidrs ?? []).length === 0 &&
      canonical(only.cidrListAliases ?? []) === canonical([FIREWALL_ALIAS]);
    const detail = `22/tcp for ${FIREWALL_ALIAS} only`;
    if (matches) return { status: 'unchanged', detail };
    if (options.dryRun)
      return { status: 'skipped', detail: `dry-run: would replace the open ports with ${detail}` };
    await cli.call([
      'lightsail',
      'put-instance-public-ports',
      '--instance-name',
      name,
      '--port-infos',
      JSON.stringify(FIREWALL_PORTS),
    ]);
    return { status: 'updated', detail };
  });
}

// ---- the S3 buckets ----

const MISSING_BUCKET = ['404', 'NoSuchBucket', 'NotFound'];
const FOREIGN_BUCKET = ['403', 'AccessDenied', 'Forbidden'];

async function ensureBucket(
  context: CloudContext,
  cli: AwsCli,
  options: AwsOptions,
  account: string,
  bucket: string,
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
      'dry-run: would block public access, set AES256 encryption and the multipart cleanup rule',
    );
    return;
  }
  // Versioning first: it is a refusal, and nothing is changed on a bucket that must be looked at.
  await report.run(`versioning ${bucket}`, async (): Promise<StepResult> => {
    const answer = await cli.callAs(['s3api', 'get-bucket-versioning', '--bucket', bucket], versioningSchema);
    if (answer.Status === 'Enabled')
      throw refused(
        `versioning is on for ${bucket}; Litestream and restic keep their own history, so versions only cost money: ` +
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
    const ours = rules
      .map((rule) => lifecycleRuleSchema.parse(rule))
      .find((rule) => rule.ID === LIFECYCLE_RULE_ID);
    const detail = `abort incomplete multipart uploads after ${ABORT_AFTER_DAYS} days`;
    if (
      ours?.Status === 'Enabled' &&
      ours.AbortIncompleteMultipartUpload?.DaysAfterInitiation === ABORT_AFTER_DAYS &&
      (ours.Filter?.Prefix ?? ours.Prefix ?? '') === ''
    )
      return { status: 'unchanged', detail };
    if (options.dryRun) return { status: 'skipped', detail: `dry-run: would ${detail}` };
    // The call replaces the whole configuration: keep the owner's other rules.
    const others = rules.filter((rule) => (rule as { ID?: unknown }).ID !== LIFECYCLE_RULE_ID);
    await cli.call([
      's3api',
      'put-bucket-lifecycle-configuration',
      '--bucket',
      bucket,
      '--lifecycle-configuration',
      JSON.stringify({
        Rules: [
          ...others,
          {
            ID: LIFECYCLE_RULE_ID,
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_AFTER_DAYS },
          },
        ],
      }),
    ]);
    return { status: ours ? 'updated' : 'created', detail };
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
