import { z } from 'zod';
import { AwsCli } from './aws-cli';
import { sameJson } from './cloudflare-api';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { StepStatus } from './report';
import { ensureSecretsDir, updateEnvFile } from './secrets';
import {
  TAG,
  callerSchema,
  dnsState,
  iamState,
  identitySchema,
  localEnv,
  parseShape,
  policyMatches,
  recordSchema,
  requiredConfig,
  sesPolicy,
} from './ses';

// Receiving the replies of the e-mail channel (PM-945): SES receives for `ses.inbound.replyDomain`, publishes to
// an SNS topic, which feeds an SQS queue the board reads. Owner-run provisioning only, like `ses configure`: it
// never sends a mail. Every AWS operation uses the SES profile and region. The cost is in docs/AWS.md.
const POLICY = 'ses-send';
const MX_PRIORITY = 10;
const DLQ_RETENTION_SECONDS = '1209600';
const MAX_RECEIVE_COUNT = 5;
const EVENT_TYPES = ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'];
const EVENT_DESTINATION = 'sns';
const MISSING_QUEUE = ['AWS.SimpleQueueService.NonExistentQueue', 'QueueDoesNotExist'];
const ENV_KEYS = [
  'PROJECTMAN_EMAIL_CHANNEL_ENABLED',
  'PROJECTMAN_EMAIL_REPLY_DOMAIN',
  'PROJECTMAN_EMAIL_QUEUE_URL',
  'PROJECTMAN_EMAIL_CONFIGURATION_SET',
] as const;
const COST =
  'estimated cost of receiving: SES 0.10 USD per 1000 mails received and 0.09 USD per 1000 incoming chunks of ' +
  '256 kB; SNS and SQS stay within their free tier at this volume. The prices are AWS pricing pages ' +
  '(https://aws.amazon.com/ses/pricing/); the figures here are an estimate';

const tagsSchema = z.array(z.looseObject({ Key: z.string(), Value: z.string() })).optional();
const ruleSchema = z.looseObject({
  Name: z.string(),
  Enabled: z.boolean().optional(),
  TlsPolicy: z.string().optional(),
  Recipients: z.array(z.string()).optional(),
  Actions: z.array(z.looseObject({})).optional(),
  ScanEnabled: z.boolean().optional(),
});
const activeSchema = z.looseObject({
  Metadata: z.looseObject({ Name: z.string() }).optional(),
});
const ruleSetSchema = z.looseObject({
  Metadata: z.looseObject({ Name: z.string() }),
  Rules: z.array(ruleSchema).optional(),
});
const topicSchema = z.looseObject({
  Attributes: z.looseObject({ TopicArn: z.string(), Policy: z.string().optional() }),
});
const snsTagsSchema = z.looseObject({ Tags: tagsSchema });
const queueUrlSchema = z.looseObject({ QueueUrl: z.string().min(1) });
const queueAttributesSchema = z.looseObject({
  Attributes: z.looseObject({
    QueueArn: z.string(),
    Policy: z.string().optional(),
    RedrivePolicy: z.string().optional(),
    MessageRetentionPeriod: z.string().optional(),
    ApproximateNumberOfMessages: z.string().optional(),
  }),
});
const queueTagsSchema = z.looseObject({ Tags: z.record(z.string(), z.string()).optional() });
const subscriptionsSchema = z.looseObject({
  Subscriptions: z.array(
    z.looseObject({ SubscriptionArn: z.string(), Protocol: z.string(), Endpoint: z.string() }),
  ),
});
const subscriptionSchema = z.looseObject({
  Attributes: z.looseObject({ RawMessageDelivery: z.string().optional() }),
});
const configurationSetSchema = z.looseObject({
  ConfigurationSetName: z.string(),
  Tags: tagsSchema,
});
const destinationsSchema = z.looseObject({
  EventDestinations: z.array(
    z.looseObject({
      Name: z.string(),
      Enabled: z.boolean().optional(),
      MatchingEventTypes: z.array(z.string()),
      SnsDestination: z.looseObject({ TopicArn: z.string() }).optional(),
    }),
  ),
});
const mxSchema = recordSchema.extend({ priority: z.number().optional() });
type RecordRow = z.output<typeof mxSchema>;

type Action = 'keep' | 'create' | 'update';
interface Step {
  name: string;
  action: Action;
  apply(): Promise<void>;
}

function resourceNames(instance: string, region: string, account: string) {
  const arn = (service: string, name: string) => `arn:aws:${service}:${region}:${account}:${name}`;
  return {
    topic: `${instance}-email-in`,
    queue: `${instance}-email-in`,
    deadLetterQueue: `${instance}-email-in-dlq`,
    configurationSet: `${instance}-email`,
    ruleSet: `${instance}-email`,
    rule: `${instance}-email-reply`,
    topicArn: arn('sns', `${instance}-email-in`),
    queueArn: arn('sqs', `${instance}-email-in`),
    deadLetterQueueArn: arn('sqs', `${instance}-email-in-dlq`),
    queueUrl: `https://sqs.${region}.amazonaws.com/${account}/${instance}-email-in`,
  };
}
type Names = ReturnType<typeof resourceNames>;

/** SES may publish to the topic, for the account's receipt rules and configuration sets only. */
export function topicPolicy(names: Pick<Names, 'topicArn'>, account: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'SesPublish',
        Effect: 'Allow',
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 'sns:Publish',
        Resource: names.topicArn,
        Condition: { StringEquals: { 'aws:SourceAccount': account } },
      },
    ],
  };
}

/** Only this topic may send to the queue. */
export function queuePolicy(names: Pick<Names, 'topicArn' | 'queueArn'>) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'TopicSend',
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: names.queueArn,
        Condition: { ArnEquals: { 'aws:SourceArn': names.topicArn } },
      },
    ],
  };
}

function receiptRule(names: Names, replyDomain: string) {
  return {
    Name: names.rule,
    Enabled: true,
    TlsPolicy: 'Optional',
    Recipients: [replyDomain],
    Actions: [{ SNSAction: { TopicArn: names.topicArn, Encoding: 'Base64' } }],
    ScanEnabled: true,
  };
}

function normalizedRule(rule: z.output<typeof ruleSchema>) {
  return {
    Name: rule.Name,
    Enabled: rule.Enabled ?? false,
    TlsPolicy: rule.TlsPolicy ?? 'Optional',
    Recipients: rule.Recipients ?? [],
    Actions: rule.Actions ?? [],
    ScanEnabled: rule.ScanEnabled ?? false,
  };
}

function redriveMatches(value: string | undefined, names: Names): boolean {
  if (!value) return false;
  try {
    const parsed = z
      .looseObject({ deadLetterTargetArn: z.string(), maxReceiveCount: z.union([z.number(), z.string()]) })
      .parse(JSON.parse(value));
    return (
      parsed.deadLetterTargetArn === names.deadLetterQueueArn &&
      Number(parsed.maxReceiveCount) === MAX_RECEIVE_COUNT
    );
  } catch {
    return false;
  }
}

function hostOf(content: string): string {
  return content.toLowerCase().replace(/\.$/, '');
}

interface State {
  steps: Step[];
  conflicts: string[];
  identityVerified: boolean;
  deadLetterMessages: number | null;
}

/** Reads everything and changes nothing; the steps carry what applying them would do, in the order to do it. */
async function gather(context: CloudContext, readOnly: boolean): Promise<State> {
  const ses = requiredConfig(context);
  const replyDomain = ses.inbound?.replyDomain;
  if (!replyDomain)
    throw refused('ses.inbound is missing from config.json; receiving is not enabled automatically');
  const env = localEnv(context);
  const cli = new AwsCli(context.deps, { profile: ses.profile, region: ses.region });
  const { Account: account } = await cli.callAs(['sts', 'get-caller-identity'], callerSchema);
  context.report.line(
    `SES receiving profile ${ses.profile}, account ${account}, region ${ses.region}, reply domain ${replyDomain}`,
  );
  const names = resourceNames(context.config.aws.instanceName, ses.region, account);
  const steps: Step[] = [];
  const conflicts: string[] = [];
  const add = (name: string, action: Action, apply: () => Promise<void>) =>
    steps.push({ name, action, apply });
  const ownTagged = (tags: { Key: string; Value: string }[] | undefined, what: string) => {
    if (!tags?.some((tag) => tag.Key === TAG.Key && tag.Value === TAG.Value))
      throw refused(`${what} exists but is not managed by projectman; refusing adoption`);
  };

  // The reply domain's own SES identity with Easy DKIM.
  const replySes = { ...ses, domain: replyDomain };
  const identity = await cli.callAsOrNull(
    ['sesv2', 'get-email-identity', '--email-identity', replyDomain],
    ['NotFoundException'],
    identitySchema,
  );
  let dns = await dnsState(context, identity, replySes, readOnly);
  add(`SES identity ${replyDomain}`, identity ? 'keep' : 'create', async () => {
    await cli.callAs(
      ['sesv2', 'create-email-identity', '--email-identity', replyDomain],
      z.looseObject({ IdentityType: z.literal('DOMAIN') }),
    );
    const created = await cli.callAs(
      ['sesv2', 'get-email-identity', '--email-identity', replyDomain],
      identitySchema,
    );
    dns = await dnsState(context, created, replySes, false);
  });
  add(
    `DKIM records of ${replyDomain}`,
    !identity ? 'create' : dns.changes.every((change) => change.matches) ? 'keep' : 'update',
    async () => {
      for (const { wanted, current, matches } of dns.changes) {
        if (matches) continue;
        const answer = current
          ? await dns.api.patch(`${dns.base}/${current.id}`, { proxied: false })
          : await dns.api.post(dns.base, wanted);
        const record = parseShape(recordSchema, answer, 'DNS write');
        if (
          record.name !== wanted.name ||
          record.type !== 'CNAME' ||
          hostOf(record.content) !== wanted.content ||
          record.proxied !== false
        )
          throw new CloudError('Cloudflare did not retain the expected DNS-only DKIM record');
      }
    },
  );

  // The SNS topic and its policy.
  const topic = await cli.callAsOrNull(
    ['sns', 'get-topic-attributes', '--topic-arn', names.topicArn],
    ['NotFound'],
    topicSchema,
  );
  if (topic)
    ownTagged(
      (await cli.callAs(['sns', 'list-tags-for-resource', '--resource-arn', names.topicArn], snsTagsSchema))
        .Tags,
      `SNS topic ${names.topic}`,
    );
  const wantedTopicPolicy = topicPolicy(names, account);
  const topicPolicyOk =
    Boolean(topic?.Attributes.Policy) && policyMatches(topic?.Attributes.Policy, wantedTopicPolicy);
  add(`SNS topic ${names.topic}`, !topic ? 'create' : topicPolicyOk ? 'keep' : 'update', async () => {
    if (!topic)
      await cli.callAs(
        ['sns', 'create-topic', '--name', names.topic, '--tags', `Key=${TAG.Key},Value=${TAG.Value}`],
        z.looseObject({ TopicArn: z.literal(names.topicArn) }),
      );
    await cli.callAs(
      [
        'sns',
        'set-topic-attributes',
        '--topic-arn',
        names.topicArn,
        '--attribute-name',
        'Policy',
        '--attribute-value',
        JSON.stringify(wantedTopicPolicy),
      ],
      z.looseObject({}),
    );
  });

  // The queue, its dead-letter queue and the policy that lets only the topic send.
  const readQueue = async (name: string) => {
    const found = await cli.callAsOrNull(
      ['sqs', 'get-queue-url', '--queue-name', name],
      MISSING_QUEUE,
      queueUrlSchema,
    );
    if (!found) return null;
    const { Attributes: attributes } = await cli.callAs(
      ['sqs', 'get-queue-attributes', '--queue-url', found.QueueUrl, '--attribute-names', 'All'],
      queueAttributesSchema,
    );
    const { Tags: tags } = await cli.callAs(
      ['sqs', 'list-queue-tags', '--queue-url', found.QueueUrl],
      queueTagsSchema,
    );
    if (tags?.[TAG.Key] !== TAG.Value)
      throw refused(`SQS queue ${name} exists but is not managed by projectman; refusing adoption`);
    return { url: found.QueueUrl, attributes };
  };
  const writeQueue = async (
    name: string,
    existing: { url: string } | null,
    attributes: Record<string, string>,
  ): Promise<string> => {
    if (existing) {
      await cli.callAs(
        [
          'sqs',
          'set-queue-attributes',
          '--queue-url',
          existing.url,
          '--attributes',
          JSON.stringify(attributes),
        ],
        z.looseObject({}),
      );
      return existing.url;
    }
    const created = await cli.callAs(
      [
        'sqs',
        'create-queue',
        '--queue-name',
        name,
        '--attributes',
        JSON.stringify(attributes),
        '--tags',
        `${TAG.Key}=${TAG.Value}`,
      ],
      queueUrlSchema,
    );
    return created.QueueUrl;
  };
  const deadLetter = await readQueue(names.deadLetterQueue);
  add(
    `SQS dead-letter queue ${names.deadLetterQueue}`,
    !deadLetter
      ? 'create'
      : deadLetter.attributes.MessageRetentionPeriod === DLQ_RETENTION_SECONDS
        ? 'keep'
        : 'update',
    async () => {
      await writeQueue(names.deadLetterQueue, deadLetter, { MessageRetentionPeriod: DLQ_RETENTION_SECONDS });
    },
  );
  const queue = await readQueue(names.queue);
  const wantedQueuePolicy = queuePolicy(names);
  let queueUrl = queue?.url ?? names.queueUrl;
  const queueOk =
    Boolean(queue?.attributes.Policy) &&
    policyMatches(queue?.attributes.Policy, wantedQueuePolicy) &&
    redriveMatches(queue?.attributes.RedrivePolicy, names);
  add(`SQS queue ${names.queue}`, !queue ? 'create' : queueOk ? 'keep' : 'update', async () => {
    queueUrl = await writeQueue(names.queue, queue, {
      Policy: JSON.stringify(wantedQueuePolicy),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: names.deadLetterQueueArn,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    });
  });

  // The subscription of the queue to the topic, with the SES message delivered as it is.
  const subscriptions = topic
    ? (
        await cli.callAs(
          ['sns', 'list-subscriptions-by-topic', '--topic-arn', names.topicArn],
          subscriptionsSchema,
        )
      ).Subscriptions
    : [];
  const subscription = subscriptions.find(
    (item) => item.Protocol === 'sqs' && item.Endpoint === names.queueArn,
  );
  if (subscriptions.some((item) => item !== subscription))
    conflicts.push(`SNS topic ${names.topic} has a subscription that is not the mail queue`);
  const raw = subscription
    ? (
        await cli.callAs(
          ['sns', 'get-subscription-attributes', '--subscription-arn', subscription.SubscriptionArn],
          subscriptionSchema,
        )
      ).Attributes.RawMessageDelivery === 'true'
    : false;
  add('SNS subscription of the queue', !subscription ? 'create' : raw ? 'keep' : 'update', async () => {
    if (subscription)
      await cli.callAs(
        [
          'sns',
          'set-subscription-attributes',
          '--subscription-arn',
          subscription.SubscriptionArn,
          '--attribute-name',
          'RawMessageDelivery',
          '--attribute-value',
          'true',
        ],
        z.looseObject({}),
      );
    else
      await cli.callAs(
        [
          'sns',
          'subscribe',
          '--topic-arn',
          names.topicArn,
          '--protocol',
          'sqs',
          '--notification-endpoint',
          names.queueArn,
          '--attributes',
          'RawMessageDelivery=true',
          '--return-subscription-arn',
        ],
        z.looseObject({ SubscriptionArn: z.string() }),
      );
  });

  // The configuration set that sends the delivery events of the outgoing mails to the same topic.
  const configurationSet = await cli.callAsOrNull(
    ['sesv2', 'get-configuration-set', '--configuration-set-name', names.configurationSet],
    ['NotFoundException'],
    configurationSetSchema,
  );
  if (configurationSet) ownTagged(configurationSet.Tags, `SES configuration set ${names.configurationSet}`);
  const destinations = configurationSet
    ? (
        await cli.callAs(
          [
            'sesv2',
            'get-configuration-set-event-destinations',
            '--configuration-set-name',
            names.configurationSet,
          ],
          destinationsSchema,
        )
      ).EventDestinations
    : [];
  const destination = destinations.find((item) => item.Name === EVENT_DESTINATION);
  const wantedDestination = {
    Enabled: true,
    MatchingEventTypes: EVENT_TYPES,
    SnsDestination: { TopicArn: names.topicArn },
  };
  const destinationOk =
    destination?.Enabled === true &&
    sameJson([...destination.MatchingEventTypes].sort(), EVENT_TYPES) &&
    destination.SnsDestination?.TopicArn === names.topicArn;
  add(`SES configuration set ${names.configurationSet}`, configurationSet ? 'keep' : 'create', async () => {
    await cli.callAs(
      [
        'sesv2',
        'create-configuration-set',
        '--configuration-set-name',
        names.configurationSet,
        '--tags',
        `Key=${TAG.Key},Value=${TAG.Value}`,
      ],
      z.looseObject({}),
    );
  });
  add(
    'SES event destination of the configuration set',
    !destination ? 'create' : destinationOk ? 'keep' : 'update',
    async () => {
      await cli.callAs(
        [
          'sesv2',
          destination
            ? 'update-configuration-set-event-destination'
            : 'create-configuration-set-event-destination',
          '--configuration-set-name',
          names.configurationSet,
          '--event-destination-name',
          EVENT_DESTINATION,
          '--event-destination',
          JSON.stringify(wantedDestination),
        ],
        z.looseObject({}),
      );
    },
  );

  // The receipt rule set: one per region may be active, so a foreign active one is a refusal, not a change.
  const active = await cli.callAs(['ses', 'describe-active-receipt-rule-set'], activeSchema);
  const activeName = active.Metadata?.Name ?? null;
  if (activeName !== null && activeName !== names.ruleSet)
    conflicts.push(
      `the receipt rule set ${activeName} is active in ${ses.region}; only one can be active per region, nothing is changed`,
    );
  const ruleSet = await cli.callAsOrNull(
    ['ses', 'describe-receipt-rule-set', '--rule-set-name', names.ruleSet],
    ['RuleSetDoesNotExist'],
    ruleSetSchema,
  );
  const rules = ruleSet?.Rules ?? [];
  if (rules.some((rule) => rule.Name !== names.rule))
    conflicts.push(`the receipt rule set ${names.ruleSet} has a rule that is not ours`);
  const wantedRule = receiptRule(names, replyDomain);
  const rule = rules.find((item) => item.Name === names.rule);
  add(`SES receipt rule set ${names.ruleSet}`, ruleSet ? 'keep' : 'create', async () => {
    await cli.callAs(['ses', 'create-receipt-rule-set', '--rule-set-name', names.ruleSet], z.looseObject({}));
  });
  add(
    `SES receipt rule ${names.rule}`,
    !rule ? 'create' : sameJson(normalizedRule(rule), wantedRule) ? 'keep' : 'update',
    async () => {
      await cli.callAs(
        [
          'ses',
          rule ? 'update-receipt-rule' : 'create-receipt-rule',
          '--rule-set-name',
          names.ruleSet,
          '--rule',
          JSON.stringify(wantedRule),
        ],
        z.looseObject({}),
      );
    },
  );
  add(
    `active receipt rule set ${names.ruleSet}`,
    activeName === names.ruleSet ? 'keep' : 'update',
    async () => {
      await cli.callAs(
        ['ses', 'set-active-receipt-rule-set', '--rule-set-name', names.ruleSet],
        z.looseObject({}),
      );
    },
  );

  // The sender's IAM policy gains member sends, the configuration set and the queue; no key is made.
  const iam = await iamState(context, cli, account, env);
  if (!iam.user || !iam.hasKey)
    conflicts.push('the sender IAM user or its key is missing; run ses configure first');
  const wantedPolicy = sesPolicy(ses, account, {
    replyDomain,
    configurationSet: names.configurationSet,
    queue: names.queue,
  });
  add(
    `IAM policy ${iam.name}/${POLICY}`,
    policyMatches(iam.document, wantedPolicy) ? 'keep' : 'update',
    async () => {
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
    },
  );

  // The protected cloud.env.
  const wantedEnv = () => ({
    PROJECTMAN_EMAIL_CHANNEL_ENABLED: '1',
    PROJECTMAN_EMAIL_REPLY_DOMAIN: replyDomain,
    PROJECTMAN_EMAIL_QUEUE_URL: queueUrl,
    PROJECTMAN_EMAIL_CONFIGURATION_SET: names.configurationSet,
  });
  const envOk = Object.entries(wantedEnv()).every(([key, value]) => env.get(key) === value);
  add(
    'protected cloud.env',
    envOk ? 'keep' : ENV_KEYS.some((key) => env.has(key)) ? 'update' : 'create',
    async () => {
      ensureSecretsDir(context.secretsDir);
      updateEnvFile(context.envFile, wantedEnv());
    },
  );

  // The MX record goes last: from then on the mails arrive, so everything behind them has to be ready.
  const base = dns.base;
  const mxHost = `inbound-smtp.${ses.region}.amazonaws.com`;
  const rows = (await dns.api.list(base, { name: replyDomain })).map((row) =>
    parseShape(mxSchema, row, 'DNS record'),
  );
  if (rows.some((row) => row.name.toLowerCase() !== replyDomain))
    throw new CloudError('Cloudflare returned a DNS record outside the requested reply domain');
  if (rows.some((row) => row.type === 'CNAME' || (row.type === 'MX' && hostOf(row.content) !== mxHost)))
    throw refused(`${replyDomain} has a conflicting CNAME or MX record; nothing at this name is overwritten`);
  const mx: RecordRow | undefined = rows.find((row) => row.type === 'MX');
  add(
    `MX ${replyDomain} -> ${mxHost}`,
    !mx ? 'create' : mx.priority === MX_PRIORITY ? 'keep' : 'update',
    async () => {
      const answer = mx
        ? await dns.api.patch(`${base}/${mx.id}`, { priority: MX_PRIORITY })
        : await dns.api.post(base, {
            type: 'MX',
            name: replyDomain,
            content: mxHost,
            priority: MX_PRIORITY,
            ttl: 1,
            proxied: false,
          });
      const record = parseShape(mxSchema, answer, 'DNS write');
      if (
        record.type !== 'MX' ||
        record.name.toLowerCase() !== replyDomain ||
        hostOf(record.content) !== mxHost ||
        record.priority !== MX_PRIORITY
      )
        throw new CloudError('Cloudflare did not retain the expected MX record');
    },
  );

  const messages = Number(deadLetter?.attributes.ApproximateNumberOfMessages);
  return {
    steps,
    conflicts,
    identityVerified:
      identity?.VerifiedForSendingStatus === true && identity.DkimAttributes.Status === 'SUCCESS',
    deadLetterMessages: Number.isInteger(messages) ? messages : null,
  };
}

function printSteps(context: CloudContext, state: State): void {
  for (const { name, action } of state.steps)
    context.report.line(action === 'keep' ? `unchanged ${name}` : `would ${action} ${name}`);
}

function refuseConflicts(state: State): void {
  if (state.conflicts.length) throw refused(state.conflicts.join('; '));
}

export async function runSesReceivePlan(context: CloudContext): Promise<void> {
  await context.report.guard('ses receive-plan', async () => {
    const state = await gather(context, true);
    printSteps(context, state);
    context.report.line(COST);
    context.report.line(
      'Owner: approve receive-configure after its dry-run, then run receive-check and approve the deploy. Receiving creates no key and sends no mail.',
    );
    refuseConflicts(state);
  });
}

export async function runSesReceiveConfigure(context: CloudContext, dryRun: boolean): Promise<void> {
  await context.report.guard('ses receive-configure', async () => {
    const state = await gather(context, dryRun);
    refuseConflicts(state);
    if (dryRun) {
      printSteps(context, state);
      context.report.line('dry-run: nothing was changed');
      return;
    }
    for (const step of state.steps) {
      if (step.action !== 'keep') await step.apply();
      const status: StepStatus =
        step.action === 'keep' ? 'unchanged' : step.action === 'create' ? 'created' : 'updated';
      context.report.step(status, step.name);
    }
    context.report.line(
      'receiving is configured; run receive-check, then the deploy needs the owner approval',
    );
  });
}

export async function runSesReceiveCheck(context: CloudContext): Promise<void> {
  await context.report.guard('ses receive-check', async () => {
    const state = await gather(context, true);
    const failed: string[] = [...state.conflicts];
    for (const { name, action } of state.steps) {
      if (action === 'keep') context.report.step('ok', name);
      else {
        context.report.line(`FAIL ${name}: needs ${action}`);
        failed.push(`${name} needs ${action}`);
      }
    }
    if (!state.identityVerified) failed.push('the reply domain identity is not verified with DKIM SUCCESS');
    context.report.line(
      `dead-letter queue messages: ${state.deadLetterMessages === null ? 'unknown' : state.deadLetterMessages}`,
    );
    if (failed.length) throw new CloudError(`receiving is not ready: ${failed.join('; ')}`);
    context.report.step(
      'ok',
      'ses receive-check',
      'receiving resources, policies and protected cloud.env match; no mail sent',
    );
  });
}
