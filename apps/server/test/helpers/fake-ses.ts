import type { CloudDeps, RunResult } from '../../../../scripts/cloud/deps';
import { writeSecret } from '../../../../scripts/cloud/secrets';
import { ACCOUNT, baseConfig, CloudWorld, FOREIGN_ACCOUNT } from './fake-aws';
import { CF_TOKEN, FakeCloudflare } from './fake-cloudflare';

export const SES_CONFIG: {
  profile?: string;
  region: string;
  domain: string;
  from: string;
  inbound?: { replyDomain: string };
} = {
  region: 'eu-central-1',
  domain: 'istvan.io',
  from: 'login@istvan.io',
};
/** The PM-729 target: the registrar account owns the SES identity; the central account `aroom` hosts the server. */
export const I_SES_CONFIG = { ...SES_CONFIG, profile: 'i', region: 'eu-west-1' };
/** Fictitious account ids of the two profiles; a call to the wrong one must be visible to the tests. */
export const SES_ACCOUNTS: Record<string, string> = { aroom: ACCOUNT, i: FOREIGN_ACCOUNT };
export const TOKENS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
export const USER = 'projectman-cloud-ses';
const ok = (value: unknown = {}): RunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const missing = (): RunResult => ({
  code: 254,
  stdout: '',
  stderr: 'An error occurred (NoSuchEntity): missing',
});
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;

/** The Easy DKIM tokens of the reply domain's identity (PM-945). */
export const REPLY_TOKENS = ['d'.repeat(32), 'e'.repeat(32), 'f'.repeat(32)];

export function sesIdentity(tokens = TOKENS) {
  return {
    IdentityType: 'DOMAIN',
    VerifiedForSendingStatus: false,
    DkimAttributes: {
      SigningEnabled: true,
      Status: 'PENDING',
      Tokens: [...tokens],
      SigningAttributesOrigin: 'AWS_SES',
      SigningHostedZone: 'dkim.amazonses.com',
    },
    Policies: {} as Record<string, unknown>,
  };
}

interface User {
  UserName: string;
  Arn: string;
  Tags: { Key: string; Value: string }[];
}

/** A stateful SES/IAM CLI fake of one AWS account (profile); no network and no SendEmail implementation. */
class FakeSes {
  readonly profile: string;
  readonly accountId: string;

  constructor(profile = 'aroom', accountId = ACCOUNT) {
    this.profile = profile;
    this.accountId = accountId;
  }

  calls: { argv: string[]; args: string[] }[] = [];
  identity: ReturnType<typeof sesIdentity> | null = null;
  /** The identity of the reply domain (PM-945), kept apart from the sender's `identity`. */
  replyDomain: string | null = null;
  replyIdentity: ReturnType<typeof sesIdentity> | null = null;
  account = {
    ProductionAccessEnabled: false,
    SendingEnabled: true,
    Details: { ReviewDetails: { Status: 'NONE' } },
  };
  user: User | null = null;
  inline = new Map<string, unknown>();
  attached: string[] = [];
  groups: string[] = [];
  keys: { AccessKeyId: string; Status: string }[] = [];
  issuedSecret = 'fake-ses-secret-0123456789/abcdefghijklmnopqrstuvwxyz';
  request: unknown = null;
  failOperation: string | null = null;
  loseKeyResponse = false;

  mutations() {
    return this.calls.filter((call) => !/^(get|list|describe)-/.test(call.args[1]!));
  }

  // The state of the receiving resources (PM-945): SNS, SQS, the SES receipt rules and configuration sets.
  topic: { arn: string; policy: string | null; tags: { Key: string; Value: string }[] } | null = null;
  queues = new Map<string, { attributes: Record<string, string>; tags: Record<string, string> }>();
  subscriptions: { SubscriptionArn: string; Protocol: string; Endpoint: string; raw: boolean }[] = [];
  configurationSet: { tags: { Key: string; Value: string }[] } | null = null;
  eventDestinations: Record<string, unknown>[] = [];
  ruleSets = new Map<string, Record<string, unknown>[]>();
  activeRuleSet: string | null = null;
  deadLetterMessages = 0;

  private denied(code: string): RunResult {
    return { code: 254, stdout: '', stderr: `An error occurred (${code}): ${code}` };
  }

  private queueUrl(region: string, name: string) {
    return `https://sqs.${region}.amazonaws.com/${this.accountId}/${name}`;
  }

  private receiving(args: string[], region: string): RunResult | null {
    const operation = args[1]!;
    const queueName = () => flag(args, '--queue-url').split('/').pop()!;
    const tagPairs = (text: string) => ({ projectman: text.split('=')[1]! });
    switch (`${args[0]} ${operation}`) {
      case 'sns get-topic-attributes':
        return this.topic?.arn === flag(args, '--topic-arn')
          ? ok({
              Attributes: {
                TopicArn: this.topic.arn,
                ...(this.topic.policy ? { Policy: this.topic.policy } : {}),
              },
            })
          : this.denied('NotFound');
      case 'sns list-tags-for-resource':
        return ok({ Tags: this.topic?.tags ?? [] });
      case 'sns create-topic':
        this.topic = {
          arn: `arn:aws:sns:${region}:${this.accountId}:${flag(args, '--name')}`,
          policy: null,
          tags: [{ Key: 'projectman', Value: 'cloud' }],
        };
        return ok({ TopicArn: this.topic.arn });
      case 'sns set-topic-attributes':
        this.topic!.policy = flag(args, '--attribute-value');
        return ok();
      case 'sns list-subscriptions-by-topic':
        return ok({ Subscriptions: this.subscriptions.map(({ raw, ...subscription }) => subscription) });
      case 'sns get-subscription-attributes': {
        const found = this.subscriptions.find(
          (item) => item.SubscriptionArn === flag(args, '--subscription-arn'),
        );
        return ok({ Attributes: { RawMessageDelivery: String(found?.raw ?? false) } });
      }
      case 'sns subscribe': {
        const SubscriptionArn = `${this.topic!.arn}:00000000-0000-0000-0000-000000000001`;
        this.subscriptions.push({
          SubscriptionArn,
          Protocol: flag(args, '--protocol'),
          Endpoint: flag(args, '--notification-endpoint'),
          raw: flag(args, '--attributes') === 'RawMessageDelivery=true',
        });
        return ok({ SubscriptionArn });
      }
      case 'sns set-subscription-attributes':
        this.subscriptions.find((item) => item.SubscriptionArn === flag(args, '--subscription-arn'))!.raw =
          flag(args, '--attribute-value') === 'true';
        return ok();
      case 'sqs get-queue-url':
        return this.queues.has(flag(args, '--queue-name'))
          ? ok({ QueueUrl: this.queueUrl(region, flag(args, '--queue-name')) })
          : this.denied('AWS.SimpleQueueService.NonExistentQueue');
      case 'sqs get-queue-attributes': {
        const name = queueName();
        return ok({
          Attributes: {
            QueueArn: `arn:aws:sqs:${region}:${this.accountId}:${name}`,
            ApproximateNumberOfMessages: String(name.endsWith('-dlq') ? this.deadLetterMessages : 0),
            ...this.queues.get(name)!.attributes,
          },
        });
      }
      case 'sqs list-queue-tags':
        return ok({ Tags: this.queues.get(queueName())!.tags });
      case 'sqs create-queue': {
        const name = flag(args, '--queue-name');
        this.queues.set(name, {
          attributes: JSON.parse(flag(args, '--attributes')),
          tags: tagPairs(flag(args, '--tags')),
        });
        return ok({ QueueUrl: this.queueUrl(region, name) });
      }
      case 'sqs set-queue-attributes':
        Object.assign(this.queues.get(queueName())!.attributes, JSON.parse(flag(args, '--attributes')));
        return ok();
      case 'sesv2 get-configuration-set':
        return this.configurationSet
          ? ok({
              ConfigurationSetName: flag(args, '--configuration-set-name'),
              Tags: this.configurationSet.tags,
            })
          : this.denied('NotFoundException');
      case 'sesv2 create-configuration-set':
        this.configurationSet = { tags: [{ Key: 'projectman', Value: 'cloud' }] };
        return ok();
      case 'sesv2 get-configuration-set-event-destinations':
        return ok({ EventDestinations: this.eventDestinations });
      case 'sesv2 create-configuration-set-event-destination':
      case 'sesv2 update-configuration-set-event-destination': {
        const destination = {
          Name: flag(args, '--event-destination-name'),
          ...JSON.parse(flag(args, '--event-destination')),
        };
        this.eventDestinations = [
          ...this.eventDestinations.filter((item) => item.Name !== destination.Name),
          destination,
        ];
        return ok();
      }
      case 'ses describe-active-receipt-rule-set':
        return this.activeRuleSet
          ? ok({ Metadata: { Name: this.activeRuleSet }, Rules: this.ruleSets.get(this.activeRuleSet) })
          : ok();
      case 'ses describe-receipt-rule-set': {
        const rules = this.ruleSets.get(flag(args, '--rule-set-name'));
        return rules
          ? ok({ Metadata: { Name: flag(args, '--rule-set-name') }, Rules: rules })
          : this.denied('RuleSetDoesNotExist');
      }
      case 'ses create-receipt-rule-set':
        this.ruleSets.set(flag(args, '--rule-set-name'), []);
        return ok();
      case 'ses create-receipt-rule':
      case 'ses update-receipt-rule': {
        const rules = this.ruleSets.get(flag(args, '--rule-set-name'));
        if (!rules) return this.denied('RuleSetDoesNotExist');
        if (!this.topic) return this.denied('InvalidSnsTopic');
        const rule = JSON.parse(flag(args, '--rule'));
        this.ruleSets.set(flag(args, '--rule-set-name'), [
          ...rules.filter((item) => item.Name !== rule.Name),
          rule,
        ]);
        return ok();
      }
      case 'ses set-active-receipt-rule-set':
        if (!this.ruleSets.has(flag(args, '--rule-set-name'))) return this.denied('RuleSetDoesNotExist');
        this.activeRuleSet = flag(args, '--rule-set-name');
        return ok();
      default:
        return null;
    }
  }
  resetCalls() {
    this.calls.length = 0;
  }

  managedUser() {
    this.user = {
      UserName: USER,
      Arn: `arn:aws:iam::${this.accountId}:user/${USER}`,
      Tags: [{ Key: 'projectman', Value: 'cloud' }],
    };
  }

  run = async (command: string, argv: string[]): Promise<RunResult> => {
    const args = argv.slice(6);
    this.calls.push({ argv, args });
    if (
      command !== 'aws' ||
      argv[0] !== '--profile' ||
      argv[1] !== this.profile ||
      argv[2] !== '--region' ||
      argv[4] !== '--output' ||
      argv[5] !== 'json'
    )
      throw new Error('unexpected AWS target');
    const operation = args[1]!;
    if (this.failOperation === operation)
      return { code: 254, stdout: '', stderr: 'An error occurred (AccessDeniedException): denied' };
    if (args[0] === 'sts') return ok({ Account: this.accountId });
    if (args[0] === 'sesv2') {
      if (operation === 'get-account') return ok(this.account);
      const ofReply = this.replyDomain !== null && flag(args, '--email-identity') === this.replyDomain;
      if (operation === 'get-email-identity') {
        const identity = ofReply ? this.replyIdentity : this.identity;
        return identity
          ? ok(identity)
          : { code: 254, stdout: '', stderr: 'An error occurred (NotFoundException): no identity' };
      }
      if (operation === 'create-email-identity') {
        if (ofReply) {
          this.replyIdentity = sesIdentity(REPLY_TOKENS);
          return ok(this.replyIdentity);
        }
        this.identity = sesIdentity();
        return ok(this.identity);
      }
      if (operation === 'put-account-details') {
        this.request = JSON.parse(flag(args, '--cli-input-json'));
        this.account.Details.ReviewDetails.Status = 'PENDING';
        return ok();
      }
    }
    if (args[0] === 'iam') {
      if (operation === 'create-user') {
        this.managedUser();
        return ok({ User: this.user });
      }
      if (!this.user) return missing();
      if (flag(args, '--user-name') !== this.user.UserName) throw new Error('unexpected IAM user');
      switch (operation) {
        case 'get-user':
          return ok({ User: this.user });
        case 'list-user-policies':
          return ok({ PolicyNames: [...this.inline.keys()] });
        case 'list-attached-user-policies':
          return ok({ AttachedPolicies: this.attached.map((PolicyName) => ({ PolicyName })) });
        case 'list-groups-for-user':
          return ok({ Groups: this.groups.map((GroupName) => ({ GroupName })) });
        case 'get-user-policy':
          return this.inline.has(flag(args, '--policy-name'))
            ? ok({ PolicyDocument: this.inline.get(flag(args, '--policy-name')) })
            : missing();
        case 'put-user-policy':
          this.inline.set(flag(args, '--policy-name'), JSON.parse(flag(args, '--policy-document')));
          return ok();
        case 'list-access-keys':
          return ok({ AccessKeyMetadata: this.keys });
        case 'create-access-key': {
          const key = { AccessKeyId: 'AKIAFAKESES0000000001', Status: 'Active' };
          this.keys.push(key);
          if (this.loseKeyResponse) return { code: 1, stdout: this.issuedSecret, stderr: '' };
          return ok({ AccessKey: { UserName: USER, ...key, SecretAccessKey: this.issuedSecret } });
        }
        case 'delete-access-key':
          this.keys = this.keys.filter((key) => key.AccessKeyId !== flag(args, '--access-key-id'));
          return ok();
      }
    }
    const handled = this.receiving(args, argv[3]!);
    if (handled) return handled;
    throw new Error(`unexpected fake operation: ${args[0]} ${operation}`);
  };
}

/**
 * `ses` is the account the configuration points SES at (`ses.profile`, else `aws.profile` = aroom);
 * `other` is the remaining account. Tests assert that `other` is never called.
 */
export class SesWorld extends CloudWorld {
  readonly ses: FakeSes;
  readonly other: FakeSes;
  readonly cf = new FakeCloudflare();

  constructor(sesConfig: typeof SES_CONFIG = SES_CONFIG) {
    super();
    this.aws.accounts.set('aroom', ACCOUNT);
    this.aws.accounts.set('i', FOREIGN_ACCOUNT);
    const target = sesConfig.profile ?? 'aroom';
    const remaining = target === 'i' ? 'aroom' : 'i';
    this.ses = new FakeSes(target, SES_ACCOUNTS[target]);
    this.other = new FakeSes(remaining, SES_ACCOUNTS[remaining]);
    this.ses.replyDomain = sesConfig.inbound?.replyDomain ?? null;
    this.writeConfig({
      aws: { ...(baseConfig().aws as object), profile: 'aroom' },
      route53: { profile: 'i' },
      cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
      ses: sesConfig,
    });
    writeSecret(this.secretsDir, 'cloudflare-token', CF_TOKEN);
    this.cf.addZone('istvan.io');
  }

  override deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
    const run = (command: string, argv: string[]) =>
      (argv[1] === this.other.profile ? this.other : this.ses).run(command, argv);
    return super.deps({ run, fetch: this.cf.fetch, ...overrides });
  }

  verify() {
    this.ses.identity!.VerifiedForSendingStatus = true;
    this.ses.identity!.DkimAttributes.Status = 'SUCCESS';
    this.ses.account.ProductionAccessEnabled = true;
  }
}
