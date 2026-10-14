import type { CloudDeps, RunResult } from '../../../../scripts/cloud/deps';
import { writeSecret } from '../../../../scripts/cloud/secrets';
import { ACCOUNT, baseConfig, CloudWorld, FOREIGN_ACCOUNT } from './fake-aws';
import { CF_TOKEN, FakeCloudflare } from './fake-cloudflare';

export const SES_CONFIG = { region: 'eu-central-1', domain: 'istvan.io', from: 'login@istvan.io' };
export const TOKENS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
export const USER = 'projectman-cloud-ses';
const ok = (value: unknown = {}): RunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const missing = (): RunResult => ({
  code: 254,
  stdout: '',
  stderr: 'An error occurred (NoSuchEntity): missing',
});
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;

export function sesIdentity() {
  return {
    IdentityType: 'DOMAIN',
    VerifiedForSendingStatus: false,
    DkimAttributes: {
      SigningEnabled: true,
      Status: 'PENDING',
      Tokens: [...TOKENS],
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

/** A stateful SES/IAM CLI fake; no network and no SendEmail implementation. */
export class FakeSes {
  calls: { argv: string[]; args: string[] }[] = [];
  identity: ReturnType<typeof sesIdentity> | null = null;
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
    return this.calls.filter((call) => !/^(get|list)-/.test(call.args[1]!));
  }
  resetCalls() {
    this.calls.length = 0;
  }

  managedUser() {
    this.user = {
      UserName: USER,
      Arn: `arn:aws:iam::${ACCOUNT}:user/${USER}`,
      Tags: [{ Key: 'projectman', Value: 'cloud' }],
    };
  }

  run = async (command: string, argv: string[]): Promise<RunResult> => {
    const args = argv.slice(6);
    this.calls.push({ argv, args });
    if (
      command !== 'aws' ||
      argv[0] !== '--profile' ||
      argv[1] !== 'aroom' ||
      argv[2] !== '--region' ||
      argv[4] !== '--output' ||
      argv[5] !== 'json'
    )
      throw new Error('unexpected AWS target');
    const operation = args[1]!;
    if (this.failOperation === operation)
      return { code: 254, stdout: '', stderr: 'An error occurred (AccessDeniedException): denied' };
    if (args[0] === 'sts') return ok({ Account: ACCOUNT });
    if (args[0] === 'sesv2') {
      if (operation === 'get-account') return ok(this.account);
      if (operation === 'get-email-identity')
        return this.identity
          ? ok(this.identity)
          : { code: 254, stdout: '', stderr: 'An error occurred (NotFoundException): no identity' };
      if (operation === 'create-email-identity') {
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
    throw new Error(`unexpected fake operation: ${args[0]} ${operation}`);
  };
}

export class SesWorld extends CloudWorld {
  readonly ses = new FakeSes();
  readonly cf = new FakeCloudflare();

  constructor() {
    super();
    this.aws.accounts.set('aroom', ACCOUNT);
    this.aws.accounts.set('i', FOREIGN_ACCOUNT);
    this.writeConfig({
      aws: { ...(baseConfig().aws as object), profile: 'aroom' },
      route53: { profile: 'i' },
      cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
      ses: SES_CONFIG,
    });
    writeSecret(this.secretsDir, 'cloudflare-token', CF_TOKEN);
    this.cf.addZone('istvan.io');
  }

  override deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
    return super.deps({ run: this.ses.run, fetch: this.cf.fetch, ...overrides });
  }

  verify() {
    this.ses.identity!.VerifiedForSendingStatus = true;
    this.ses.identity!.DkimAttributes.Status = 'SUCCESS';
    this.ses.account.ProductionAccessEnabled = true;
  }
}
