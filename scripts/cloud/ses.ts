import { z } from 'zod';
import { AwsCli } from './aws-cli';
import { CloudflareApi, sameJson } from './cloudflare-api';
import type { CloudConfig } from './config';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import { checkSecretsDir, ensureSecretsDir, readEnvFile, updateEnvFile } from './secrets';

// Owner-run provisioning only (PM-678). These commands never send a message or request production
// access as a side effect of configure/up. Every AWS operation uses the SES profile (ses.profile, else aws.profile) and the SES region.
const POLICY = 'ses-send';
const KEY_ID = 'PROJECTMAN_SES_ACCESS_KEY_ID';
const KEY_SECRET = 'PROJECTMAN_SES_SECRET_ACCESS_KEY';
const SESSION_TOKEN = 'PROJECTMAN_SES_SESSION_TOKEN';
export const TAG = { Key: 'projectman', Value: 'cloud' };
const USE_CASE =
  'Projectman sends transactional, short-lived one-time login codes only to customers invited by ' +
  'the project owner who explicitly request sign-in. There is no public registration, marketing ' +
  'mail or purchased mailing list. Codes expire after ten minutes. Sending is rate limited.';

export const callerSchema = z.looseObject({ Account: z.string().regex(/^\d{12}$/) });
export const dkimSchema = z.looseObject({
  SigningEnabled: z.boolean(),
  Status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE', 'NOT_STARTED']),
  Tokens: z.array(z.string().regex(/^[a-z0-9]{32}$/)).optional(),
  SigningAttributesOrigin: z.string().optional(),
  SigningHostedZone: z
    .string()
    .regex(/^(?:[a-z0-9-]+\.)*dkim\.(?:[a-z0-9-]+\.)?amazonses\.com$/)
    .optional(),
});
export const identitySchema = z.looseObject({
  IdentityType: z.literal('DOMAIN'),
  VerifiedForSendingStatus: z.boolean(),
  DkimAttributes: dkimSchema,
  Policies: z.record(z.string(), z.unknown()).optional(),
});
const accountSchema = z.looseObject({
  ProductionAccessEnabled: z.boolean(),
  SendingEnabled: z.boolean(),
  Details: z
    .looseObject({
      ReviewDetails: z.looseObject({ Status: z.string() }).optional(),
    })
    .optional(),
});
const userSchema = z.looseObject({
  User: z.looseObject({
    UserName: z.string(),
    Arn: z.string(),
    Tags: z.array(z.looseObject({ Key: z.string(), Value: z.string() })).optional(),
  }),
});
const keysSchema = z.looseObject({
  AccessKeyMetadata: z.array(
    z.looseObject({
      AccessKeyId: z.string().min(1),
      Status: z.enum(['Active', 'Inactive']),
    }),
  ),
});
const newKeySchema = z.looseObject({
  AccessKey: z.looseObject({
    UserName: z.string(),
    AccessKeyId: z.string().min(1),
    SecretAccessKey: z.string().min(1),
  }),
});
const zoneSchema = z.looseObject({ id: z.string().min(1), name: z.string(), status: z.string() });
export const recordSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
});
export type Identity = z.output<typeof identitySchema>;
type RecordRow = z.output<typeof recordSchema>;
export type SesConfig = NonNullable<CloudConfig['ses']>;

export function requiredConfig(context: CloudContext): SesConfig {
  if (!context.config.ses) throw refused('ses is missing from config.json; SES is not enabled automatically');
  return context.config.ses;
}

export function localEnv(context: CloudContext): Map<string, string> {
  checkSecretsDir(context.secretsDir);
  const env = readEnvFile(context.envFile);
  // Protect every stored value as a final guard against downstream errors echoing existing secrets.
  for (const value of env.values()) context.report.protect(value);
  return env;
}

async function awsState(context: CloudContext) {
  const ses = requiredConfig(context);
  const cli = new AwsCli(context.deps, { profile: ses.profile, region: ses.region });
  const { Account: account } = await cli.callAs(['sts', 'get-caller-identity'], callerSchema);
  context.report.line(`SES profile ${ses.profile}, account ${account}, region ${ses.region}`);
  const identity = await cli.callAsOrNull(
    ['sesv2', 'get-email-identity', '--email-identity', ses.domain],
    ['NotFoundException'],
    identitySchema,
  );
  const status = await cli.callAs(['sesv2', 'get-account'], accountSchema);
  context.report.line(
    `SES identity ${ses.domain}: verified=${identity?.VerifiedForSendingStatus ?? false}, DKIM=${identity?.DkimAttributes.Status ?? 'missing'}; production=${status.ProductionAccessEnabled}, sending=${status.SendingEnabled}, review=${status.Details?.ReviewDetails?.Status ?? 'none'}`,
  );
  return { cli, ses, account, identity, status };
}

/** The names of the e-mail channel's receiving resources the sender's policy refers to (PM-945). */
export interface SesInboundNames {
  configurationSet: string;
  queue: string;
}

/**
 * No SendRawEmail, wildcard resource, sender authorization or other permissions. With `inbound` the
 * channel's configuration set may be named in a send, and the one mail queue may be read and emptied.
 */
export function sesPolicy(
  ses: Pick<SesConfig, 'region' | 'domain' | 'from'>,
  account: string,
  inbound?: SesInboundNames,
) {
  const fromAddress = { StringEquals: { 'ses:FromAddress': ses.from } };
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 'ses:SendEmail',
        Resource: `arn:aws:ses:${ses.region}:${account}:identity/${ses.domain}`,
        Condition: fromAddress,
      },
      ...(inbound
        ? [
            {
              Effect: 'Allow',
              Action: 'ses:SendEmail',
              Resource: `arn:aws:ses:${ses.region}:${account}:configuration-set/${inbound.configurationSet}`,
              Condition: fromAddress,
            },
            {
              Effect: 'Allow',
              Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'],
              Resource: `arn:aws:sqs:${ses.region}:${account}:${inbound.queue}`,
            },
          ]
        : []),
    ],
  };
}

/**
 * The policy `ses configure` and `ses check` hold the user to: the one with the receiving statements when
 * it already carries them (`ses receive-configure` put them there), else the sender-only one.
 */
export function wantedSesPolicy(
  context: CloudContext,
  ses: Pick<SesConfig, 'region' | 'domain' | 'from'>,
  account: string,
  document: unknown,
) {
  const inbound = {
    configurationSet: `${context.config.aws.instanceName}-email`,
    queue: `${context.config.aws.instanceName}-email-in`,
  };
  const withInbound = sesPolicy(ses, account, inbound);
  return policyMatches(document, withInbound) ? withInbound : sesPolicy(ses, account);
}

export function policyMatches(document: unknown, wanted: unknown): boolean {
  let decoded = document;
  if (typeof document === 'string') {
    try {
      decoded = JSON.parse(decodeURIComponent(document));
    } catch {
      return false;
    }
  }
  const normalize = (value: unknown) => {
    const parsed = z
      .looseObject({
        Version: z.string(),
        Statement: z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]),
      })
      .safeParse(value);
    if (!parsed.success) return null;
    const statements = Array.isArray(parsed.data.Statement) ? parsed.data.Statement : [parsed.data.Statement];
    return {
      ...parsed.data,
      Statement: statements.map((statement) => {
        const result = { ...statement };
        for (const key of ['Action', 'Resource']) {
          const item = result[key];
          result[key] = Array.isArray(item) ? item : [item];
        }
        return result;
      }),
    };
  };
  return sameJson(normalize(decoded), normalize(wanted));
}

// Legacy responses lack SigningHostedZone. Prefer AWS's actual zone (including its cell prefix);
// the fallback follows https://docs.aws.amazon.com/general/latest/gr/ses.html#ses_dkim.
const REGIONAL_DKIM = new Set([
  'af-south-1',
  'ap-south-2',
  'ap-southeast-3',
  'ap-southeast-5',
  'ca-west-1',
  'ap-northeast-3',
  'eu-south-1',
  'eu-central-2',
  'il-central-1',
  'me-central-1',
  'us-gov-east-1',
]);

function dnsSpecs(identity: Identity, ses: SesConfig) {
  const dkim = identity.DkimAttributes;
  if (!dkim.SigningEnabled || (dkim.SigningAttributesOrigin && dkim.SigningAttributesOrigin !== 'AWS_SES'))
    throw refused('the existing identity must use enabled Easy DKIM; it is not reconfigured automatically');
  if (Object.keys(identity.Policies ?? {}).length)
    throw refused(
      'the identity has sending authorization policies; resolve them explicitly before provisioning',
    );
  const tokens = dkim.Tokens ?? [];
  if (tokens.length !== 3 || new Set(tokens).size !== 3)
    throw refused('SES must return three distinct Easy DKIM tokens; retry after identity propagation');
  const hostedZone =
    dkim.SigningHostedZone ??
    (REGIONAL_DKIM.has(ses.region) ? `dkim.${ses.region}.amazonses.com` : 'dkim.amazonses.com');
  return tokens.map((token) => ({
    type: 'CNAME',
    name: `${token}._domainkey.${ses.domain}`,
    content: `${token}.${hostedZone}`,
    proxied: false,
    ttl: 1,
  }));
}

export function parseShape<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CloudError(`Cloudflare ${what} answered in an unexpected shape`);
  return parsed.data;
}

export async function dnsState(
  context: CloudContext,
  identity: Identity | null,
  ses: SesConfig,
  readOnly: boolean,
) {
  const api = CloudflareApi.fromTokenFile(context, context.config.cloudflare.tokenFile, readOnly);
  const zones = (
    await api.list('/zones', {
      name: context.config.cloudflare.zone,
      ...(context.config.cloudflare.accountId ? { 'account.id': context.config.cloudflare.accountId } : {}),
    })
  )
    .map((row) => parseShape(zoneSchema, row, 'zone'))
    .filter((zone) => zone.name === context.config.cloudflare.zone);
  if (zones.length !== 1 || zones[0]!.status !== 'active')
    throw refused(
      'SES requires exactly one existing active authoritative Cloudflare zone; DNS is not migrated',
    );
  const base = `/zones/${zones[0]!.id}/dns_records`;
  const changes: {
    wanted: ReturnType<typeof dnsSpecs>[number];
    current: RecordRow | null;
    matches: boolean;
  }[] = [];
  for (const wanted of identity ? dnsSpecs(identity, ses) : []) {
    const records = (await api.list(base, { name: wanted.name })).map((row) =>
      parseShape(recordSchema, row, 'DNS record'),
    );
    if (
      records.length > 1 ||
      records.some(
        (record) =>
          record.type !== 'CNAME' || record.content.toLowerCase().replace(/\.$/, '') !== wanted.content,
      )
    )
      throw refused(
        `DKIM name ${wanted.name} has conflicting DNS records; nothing at this name is overwritten`,
      );
    const current = records[0] ?? null;
    if (current && current.name.toLowerCase().replace(/\.$/, '') !== wanted.name)
      throw new CloudError('Cloudflare returned a DNS record outside the requested DKIM name');
    changes.push({ wanted, current, matches: current?.proxied === false });
    context.report.line(
      `DKIM ${wanted.name} -> ${wanted.content}, DNS only: ${current?.proxied === false ? 'unchanged' : current ? 'would disable proxy' : 'would create'}`,
    );
  }
  if (!identity)
    context.report.line(
      'DKIM: would create three DNS-only CNAMEs using the tokens returned by SES identity creation',
    );
  return { api, base, changes };
}

export async function iamState(
  context: CloudContext,
  cli: AwsCli,
  account: string,
  env: Map<string, string>,
) {
  const name = `${context.config.aws.instanceName}-ses`;
  const user = await cli.callAsOrNull(['iam', 'get-user', '--user-name', name], ['NoSuchEntity'], userSchema);
  let document: unknown = null;
  let keys: z.output<typeof keysSchema>['AccessKeyMetadata'] = [];
  if (user) {
    if (
      user.User.UserName !== name ||
      user.User.Arn !== `arn:aws:iam::${account}:user/${name}` ||
      !user.User.Tags?.some((tag) => tag.Key === TAG.Key && tag.Value === TAG.Value)
    )
      throw refused(`${name} is not the managed SES user in the configured SES account; refusing adoption`);
    const inline = await cli.callAs(
      ['iam', 'list-user-policies', '--user-name', name],
      z.looseObject({ PolicyNames: z.array(z.string()) }),
    );
    const attached = await cli.callAs(
      ['iam', 'list-attached-user-policies', '--user-name', name],
      z.looseObject({ AttachedPolicies: z.array(z.looseObject({})) }),
    );
    const groups = await cli.callAs(
      ['iam', 'list-groups-for-user', '--user-name', name],
      z.looseObject({ Groups: z.array(z.looseObject({})) }),
    );
    if (
      inline.PolicyNames.some((policy) => policy !== POLICY) ||
      attached.AttachedPolicies.length ||
      groups.Groups.length
    )
      throw refused(`${name} must have only ${POLICY}, no managed policies or IAM groups`);
    const policy = await cli.callAsOrNull(
      ['iam', 'get-user-policy', '--user-name', name, '--policy-name', POLICY],
      ['NoSuchEntity'],
      z.looseObject({ PolicyDocument: z.unknown() }),
    );
    document = policy?.PolicyDocument;
    keys = (await cli.callAs(['iam', 'list-access-keys', '--user-name', name], keysSchema)).AccessKeyMetadata;
  }
  const knownId = env.get(KEY_ID)?.trim();
  const knownSecret = env.get(KEY_SECRET)?.trim();
  if (env.get(SESSION_TOKEN))
    throw refused('cloud.env contains temporary SES credentials; refusing automatic replacement');
  if (
    Boolean(knownId) !== Boolean(knownSecret) ||
    (keys.length > 0 &&
      !(
        keys.length === 1 &&
        keys[0]!.AccessKeyId === knownId &&
        keys[0]!.Status === 'Active' &&
        knownSecret
      )) ||
    (knownId && keys.length === 0)
  )
    throw refused(`${name} has unknown, inactive or incomplete credentials; no key is rotated automatically`);
  return { name, user, document, hasKey: keys.length === 1 };
}

function preview(context: CloudContext, ses: SesConfig, account: string, env: Map<string, string>) {
  context.report.line(
    'cost SES: sending mail may incur AWS charges; provisioning and checks never send mail',
  );
  context.report.line(
    `planned IAM ${context.config.aws.instanceName}-ses / ${POLICY}: ${JSON.stringify(sesPolicy(ses, account))}`,
  );
  context.report.line(
    `sender ${ses.from}: protected credentials=${Boolean(env.get(KEY_ID) && env.get(KEY_SECRET))}, enabled=${env.get('PROJECTMAN_EMAIL_LOGIN_ENABLED') === '1'}; configured region/from match=${env.get('PROJECTMAN_SES_REGION') === ses.region && env.get('PROJECTMAN_SES_FROM') === ses.from}`,
  );
  context.report.line(
    'Owner: approve configure after its dry-run, then separately approve request-production; wait for verification and production approval, run ses check, then approve deploy. Backend reports actual login availability.',
  );
}

export async function runSesPlan(context: CloudContext): Promise<void> {
  await context.report.guard('ses plan', async () => {
    requiredConfig(context);
    const env = localEnv(context);
    const state = await awsState(context);
    preview(context, state.ses, state.account, env);
    await dnsState(context, state.identity, state.ses, true);
    context.report.line(
      'IAM scope is a plan, not a live IAM verification; ses configure --dry-run and ses check read IAM.',
    );
  });
}

export async function runSesConfigure(context: CloudContext, dryRun: boolean): Promise<void> {
  await context.report.guard('ses configure', async () => {
    requiredConfig(context);
    const env = localEnv(context);
    const { cli, ses, account, identity } = await awsState(context);
    preview(context, ses, account, env);
    // Read all existing ownership/key/DNS state before changing any resource.
    const iam = await iamState(context, cli, account, env);
    let dns = await dnsState(context, identity, ses, dryRun);
    const wantedPolicy = wantedSesPolicy(context, ses, account, iam.document);
    if (dryRun) {
      context.report.line(
        `dry-run: identity=${identity ? 'keep' : 'create'}, user=${iam.user ? 'keep' : 'create'}, policy=${policyMatches(iam.document, wantedPolicy) ? 'keep' : 'set'}, key=${iam.hasKey ? 'keep' : 'create'}; would set PROJECTMAN_SES_* and PROJECTMAN_EMAIL_LOGIN_ENABLED=1 in protected cloud.env`,
      );
      return;
    }
    ensureSecretsDir(context.secretsDir);
    if (!identity) {
      await cli.callAs(
        ['sesv2', 'create-email-identity', '--email-identity', ses.domain],
        z.looseObject({ IdentityType: z.literal('DOMAIN'), DkimAttributes: dkimSchema }),
      );
      context.report.step('created', `ses identity ${ses.domain}`);
      const created = await cli.callAs(
        ['sesv2', 'get-email-identity', '--email-identity', ses.domain],
        identitySchema,
      );
      dns = await dnsState(context, created, ses, false);
    }
    for (const { wanted, current, matches } of dns.changes) {
      if (!matches) {
        const answer = current
          ? await dns.api.patch(`${dns.base}/${current.id}`, { proxied: false })
          : await dns.api.post(dns.base, wanted);
        const record = parseShape(recordSchema, answer, 'DNS write');
        if (
          record.name !== wanted.name ||
          record.type !== 'CNAME' ||
          record.content.toLowerCase().replace(/\.$/, '') !== wanted.content ||
          record.proxied !== false
        )
          throw new CloudError('Cloudflare did not retain the expected DNS-only DKIM record');
      }
      context.report.step(matches ? 'unchanged' : current ? 'updated' : 'created', `DKIM ${wanted.name}`);
    }
    if (!iam.user) {
      const created = await cli.callAs(
        ['iam', 'create-user', '--user-name', iam.name, '--tags', `Key=${TAG.Key},Value=${TAG.Value}`],
        userSchema,
      );
      if (
        created.User.UserName !== iam.name ||
        created.User.Arn !== `arn:aws:iam::${account}:user/${iam.name}`
      )
        throw new CloudError('IAM did not create the expected SES user in the configured SES account');
      context.report.step('created', `user ${iam.name}`);
    }
    if (!policyMatches(iam.document, wantedPolicy)) {
      await cli.callAs(
        [
          'iam',
          'put-user-policy',
          '--user-name',
          iam.name,
          '--policy-name',
          POLICY,
          '--policy-document',
          JSON.stringify(wantedPolicy),
        ],
        z.looseObject({}),
      );
      context.report.step('updated', `policy ${iam.name}`);
    }
    if (!iam.hasKey) {
      // The provider may echo a secret on failure: never surface raw create-access-key output.
      let created: z.output<typeof newKeySchema>['AccessKey'];
      try {
        created = (await cli.callAs(['iam', 'create-access-key', '--user-name', iam.name], newKeySchema))
          .AccessKey;
      } catch {
        throw new CloudError(
          'IAM key creation failed; inspect the managed user before retrying, no automatic rotation',
        );
      }
      context.report.protect(created.SecretAccessKey);
      context.report.protect(created.AccessKeyId);
      if (created.UserName !== iam.name) throw new CloudError('IAM returned a key for an unexpected user');
      try {
        // Save the irretrievable credential immediately, before enabling login.
        updateEnvFile(context.envFile, {
          [KEY_ID]: created.AccessKeyId,
          [KEY_SECRET]: created.SecretAccessKey,
        });
      } catch {
        await cli
          .callAs(
            ['iam', 'delete-access-key', '--user-name', iam.name, '--access-key-id', created.AccessKeyId],
            z.looseObject({}),
          )
          .catch(() => undefined);
        throw new CloudError('could not persist the SES key; cleanup attempted, inspect IAM before retrying');
      }
      context.report.step('created', `key ${iam.name}`, 'saved in protected cloud.env');
    }
    const changed = updateEnvFile(context.envFile, {
      PROJECTMAN_SES_REGION: ses.region,
      PROJECTMAN_SES_FROM: ses.from,
      PROJECTMAN_EMAIL_LOGIN_ENABLED: '1',
    });
    context.report.step(
      changed.length ? 'updated' : 'unchanged',
      'cloud.env',
      'SES sender configured; deploy requires owner approval',
    );
  });
}

export async function runSesRequestProduction(context: CloudContext, dryRun: boolean): Promise<void> {
  await context.report.guard('ses request-production', async () => {
    const ses = requiredConfig(context);
    const emails = context.config.access.emails;
    if (emails.length > 4 || emails.some((email) => email.length > 254 || email.length < 6))
      throw refused(
        'SES production requests accept at most four contact addresses of 6-254 characters in access.emails',
      );
    const { cli, status } = await awsState(context);
    const request = {
      ProductionAccessEnabled: true,
      MailType: 'TRANSACTIONAL',
      WebsiteURL: `https://${context.config.cloudflare.hostname}`,
      UseCaseDescription: USE_CASE,
      ContactLanguage: 'EN',
      AdditionalContactEmailAddresses: emails,
    };
    context.report.line(`production request preview ${ses.region}: ${JSON.stringify(request)}`);
    context.report.line(
      'Owner approval is required for this separate request; AWS accepting a request does not mean production access is granted.',
    );
    if (status.ProductionAccessEnabled || status.Details?.ReviewDetails?.Status === 'PENDING') {
      context.report.step(
        'unchanged',
        'production request',
        status.ProductionAccessEnabled ? 'already production' : 'review pending; no resubmission',
      );
      return;
    }
    if (dryRun) {
      context.report.step('skipped', 'production request', 'dry-run: would submit put-account-details');
      return;
    }
    await cli.callAs(
      ['sesv2', 'put-account-details', '--cli-input-json', JSON.stringify(request)],
      z.looseObject({}),
    );
    context.report.step(
      'updated',
      'production request',
      'submitted; run ses check after AWS grants production access',
    );
  });
}

export async function runSesCheck(context: CloudContext): Promise<void> {
  await context.report.guard('ses check', async () => {
    requiredConfig(context);
    const env = localEnv(context);
    const { cli, ses, account, identity, status } = await awsState(context);
    if (
      !identity ||
      !identity.VerifiedForSendingStatus ||
      identity.DkimAttributes.Status !== 'SUCCESS' ||
      !identity.DkimAttributes.SigningEnabled
    )
      throw new CloudError('SES identity is not verified with DKIM SUCCESS and signing enabled');
    if (!status.ProductionAccessEnabled || !status.SendingEnabled)
      throw new CloudError('SES is still in the sandbox or sending is disabled in the configured region');
    const dns = await dnsState(context, identity, ses, true);
    if (dns.changes.some((change) => !change.matches))
      throw new CloudError('Cloudflare DKIM tokens are not all present as DNS-only CNAMEs');
    const iam = await iamState(context, cli, account, env);
    if (
      !iam.user ||
      !iam.hasKey ||
      !policyMatches(iam.document, wantedSesPolicy(context, ses, account, iam.document))
    )
      throw new CloudError(
        'SES sender IAM scope or protected active key does not match the configured identity/from',
      );
    if (
      env.get('PROJECTMAN_EMAIL_LOGIN_ENABLED') !== '1' ||
      env.get('PROJECTMAN_SES_REGION') !== ses.region ||
      env.get('PROJECTMAN_SES_FROM') !== ses.from
    )
      throw new CloudError('cloud.env does not enable the configured SES region and sender');
    context.report.step(
      'ok',
      'ses check',
      'verified DKIM/DNS, production/sending enabled, exact IAM scope and protected sender; no mail sent',
    );
  });
}
