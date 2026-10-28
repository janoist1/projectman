import { chmodSync, existsSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS, runCloud } from '../../../scripts/cloud/commands';
import { parseConfig } from '../../../scripts/cloud/config';
import { removeEnvNames, updateEnvFile } from '../../../scripts/cloud/secrets';
import { sesPolicy } from '../../../scripts/cloud/ses';
import { ACCOUNT, baseConfig } from './helpers/fake-aws';
import { CF_TOKEN, CloudflareWorld } from './helpers/fake-cloudflare';
import {
  I_SES_CONFIG,
  SES_ACCOUNTS,
  SES_CONFIG,
  sesIdentity,
  SesWorld,
  TOKENS,
  USER,
} from './helpers/fake-ses';

let world: SesWorld;
beforeEach(() => {
  world = new SesWorld();
});
afterEach(() => {
  // The account that ses.profile does not name is never read or written.
  expect(world.other.calls).toEqual([]);
  world.cleanup();
  vi.restoreAllMocks();
});
const run = (command: string, ...args: string[]) => runCloud(['ses', command, ...args], world.deps());
const clear = () => {
  world.ses.resetCalls();
  world.cf.calls.length = 0;
  world.lines.length = 0;
  world.errors.length = 0;
};
const noWrites = () => {
  expect(world.ses.mutations()).toEqual([]);
  expect(world.cf.mutations()).toEqual([]);
};

describe('SES config and command preconditions', () => {
  it('keeps SES optional and refuses all SES commands when it is absent', async () => {
    expect(parseConfig(baseConfig(), world.home).ses).toBeUndefined();
    world.writeConfig();
    for (const command of ['plan', 'configure', 'request-production', 'check'])
      expect(await run(command)).toBe(2);
    expect(world.ses.calls).toEqual([]);
    expect(world.cf.calls).toEqual([]);
  });

  it.each([
    [{ ...SES_CONFIG, region: '' }, 'ses.region'],
    [{ ...SES_CONFIG, from: 'invalid' }, 'ses.from'],
    [{ ...SES_CONFIG, from: 'login@sub.istvan.io' }, 'ses.from'],
    [{ ...SES_CONFIG, domain: 'elsewhere.io', from: 'login@elsewhere.io' }, 'ses.domain'],
  ])('rejects invalid SES settings before any external calls', async (ses, field) => {
    world.writeConfig({
      aws: { ...(baseConfig().aws as object), profile: 'aroom' },
      cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
      ses,
    });
    expect(await run('configure')).toBe(2);
    expect(world.output).toContain(field);
    expect(world.ses.calls).toEqual([]);
  });

  it('resolves a missing ses.profile to aws.profile, and takes an explicit one', () => {
    const ses = { ...SES_CONFIG, domain: 'example.com', from: 'login@example.com' };
    const resolve = (awsProfile: string, sesProfile?: string) =>
      parseConfig(
        {
          ...baseConfig(),
          aws: { ...(baseConfig().aws as object), profile: awsProfile },
          ses: { ...ses, ...(sesProfile ? { profile: sesProfile } : {}) },
        },
        world.home,
      ).ses!.profile;
    expect(resolve('aroom')).toBe('aroom');
    expect(resolve('aroom', 'i')).toBe('i');
  });

  it.each([['configure', '--rotate-keys'], ['plan', '--dry-run'], ['check', '--dry-run'], ['unknown']])(
    'rejects unsupported SES options',
    async (...args) => {
      expect(await runCloud(['ses', ...args], world.deps())).toBe(64);
      expect(world.ses.calls).toEqual([]);
    },
  );

  it.each(['store-mode', 'env-mode', 'env-link', 'token-mode', 'token-missing', 'zone-pending'])(
    'refuses unsafe secrets or unavailable DNS before any mutation: %s',
    async (state) => {
      updateEnvFile(world.envFile, { UNRELATED: 'keep' });
      if (state === 'store-mode') chmodSync(world.secretsDir, 0o755);
      if (state === 'env-mode') chmodSync(world.envFile, 0o644);
      if (state === 'env-link') {
        const link = path.join(world.secretsDir, 'linked.env');
        symlinkSync(world.envFile, link);
        const deps = world.deps();
        const config = parseConfig(JSON.parse(readFileSync(world.configFile, 'utf8')), world.home);
        const { Report } = await import('../../../scripts/cloud/report');
        const { runSesConfigure } = await import('../../../scripts/cloud/ses');
        await expect(
          runSesConfigure(
            { deps, config, envFile: link, secretsDir: world.secretsDir, report: new Report(deps.out) },
            false,
          ),
        ).rejects.toThrow('symbolic link');
        noWrites();
        return;
      }
      if (state === 'token-mode') chmodSync(path.join(world.secretsDir, 'cloudflare-token'), 0o644);
      if (state === 'token-missing')
        world.writeConfig({
          aws: { ...(baseConfig().aws as object), profile: 'aroom' },
          cloudflare: {
            zone: 'istvan.io',
            hostname: 'chopper.istvan.io',
            tokenFile: path.join(world.secretsDir, 'missing-token'),
          },
          ses: SES_CONFIG,
        });
      if (state === 'zone-pending') world.cf.zones[0]!.status = 'pending';
      expect(await run('configure')).toBe(2);
      noWrites();
    },
  );
});

describe('SES plan and configure', () => {
  it('plan uses only STS, SES identity/account and DNS reads, and does not invent tokens', async () => {
    expect(await run('plan')).toBe(0);
    expect(world.ses.calls.map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'sts get-caller-identity',
      'sesv2 get-email-identity',
      'sesv2 get-account',
    ]);
    expect(world.cf.calls.every((call) => call.method === 'GET' && /^\/zones/.test(call.path))).toBe(true);
    expect(world.output).toContain('tokens returned by SES');
    expect(world.output).toContain('ses:FromAddress');
    expect(world.output).toContain('Owner: approve configure');
    noWrites();
    expect(existsSync(world.envFile)).toBe(false);
  });

  it('creates in aroom and the explicit SES region, keeps unrelated DNS/env, and converges after restart', async () => {
    const mailRecords = ['MX', 'TXT', 'TXT', 'TXT'].map((type, index) => ({
      id: `mail-${index}`,
      zone_id: world.cf.zones[0]!.id,
      type,
      name: index === 2 ? '_dmarc.istvan.io' : 'istvan.io',
      content: ['mail.example.org', 'v=spf1 -all', 'v=DMARC1; p=reject', 'unrelated'][index],
    }));
    world.cf.records.push(...mailRecords);
    updateEnvFile(world.envFile, {
      TUNNEL_TOKEN: 'keep-tunnel-secret',
      RESTIC_PASSWORD: 'keep-backup-secret',
      CUSTOM: 'unchanged',
    });
    expect(await run('configure')).toBe(0);
    expect(world.cf.records.slice(0, 4)).toEqual(mailRecords);
    expect(world.cf.records.slice(4)).toEqual(
      TOKENS.map((token) =>
        expect.objectContaining({
          type: 'CNAME',
          name: `${token}._domainkey.istvan.io`,
          content: `${token}.dkim.amazonses.com`,
          proxied: false,
        }),
      ),
    );
    expect(world.ses.inline.get('ses-send')).toEqual(sesPolicy(SES_CONFIG, ACCOUNT));
    const env = readFileSync(world.envFile, 'utf8');
    expect(env).toContain('TUNNEL_TOKEN=keep-tunnel-secret\n');
    expect(env).toContain('RESTIC_PASSWORD=keep-backup-secret\n');
    expect(env).toContain('PROJECTMAN_EMAIL_LOGIN_ENABLED=1\n');
    expect(env).toContain(`PROJECTMAN_SES_SECRET_ACCESS_KEY=${world.ses.issuedSecret}\n`);
    expect(statSync(world.envFile).mode & 0o777).toBe(0o600);
    expect(statSync(world.secretsDir).mode & 0o777).toBe(0o700);
    expect(
      world.ses.calls.every(
        (call) => call.argv.slice(0, 6).join(' ') === '--profile aroom --region eu-central-1 --output json',
      ),
    ).toBe(true);
    expect(world.output).toContain(`SES profile aroom, account ${ACCOUNT}, region eu-central-1`);
    expect(world.output).toContain('sending mail may incur AWS charges');
    expect(world.ses.calls.some((call) => /put-account-details|[Ss]end[Ee]mail/.test(call.args[1]!))).toBe(
      false,
    );
    for (const secret of [world.ses.issuedSecret, CF_TOKEN, 'keep-tunnel-secret', 'keep-backup-secret']) {
      expect(world.output).not.toContain(secret);
      expect(JSON.stringify(world.ses.calls)).not.toContain(secret);
    }
    clear();
    expect(await run('configure')).toBe(0);
    noWrites();
    expect(readFileSync(world.envFile, 'utf8')).toBe(env);
  });

  it.each([false, true])(
    'dry-run writes no resource or local file with existing identity=%s',
    async (exists) => {
      if (exists) world.ses.identity = sesIdentity();
      const before = readFileSync(world.configFile, 'utf8');
      expect(await run('configure', '--dry-run')).toBe(0);
      noWrites();
      expect(existsSync(world.envFile)).toBe(false);
      expect(readFileSync(world.configFile, 'utf8')).toBe(before);
    },
  );

  it('fixes only the proxy flag of its matching CNAME and uses AWS hosted zone/cell', async () => {
    world.ses.identity = sesIdentity();
    world.ses.identity.DkimAttributes.SigningHostedZone = 'a31d.dkim.us-west-2.amazonses.com';
    world.cf.records.push({
      id: 'own',
      zone_id: world.cf.zones[0]!.id,
      type: 'CNAME',
      name: `${TOKENS[0]}._domainkey.istvan.io`,
      content: `${TOKENS[0]}.a31d.dkim.us-west-2.amazonses.com.`,
      proxied: true,
      ttl: 3600,
    });
    expect(await run('configure')).toBe(0);
    expect(world.cf.mutationsTo('PATCH', /dns_records/)[0]!.body).toEqual({ proxied: false });
    expect(world.cf.records[0]!.ttl).toBe(3600);
    expect(world.ses.calls.some((call) => call.args[1] === 'create-email-identity')).toBe(false);
  });

  it.each(['eu-central-1', 'eu-central-2'])(
    'uses the documented regional fallback for legacy DKIM responses: %s',
    async (region) => {
      world.ses.identity = sesIdentity();
      Reflect.deleteProperty(world.ses.identity.DkimAttributes, 'SigningHostedZone');
      world.writeConfig({
        aws: { ...(baseConfig().aws as object), profile: 'aroom' },
        cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
        ses: { ...SES_CONFIG, region },
      });
      expect(await run('configure')).toBe(0);
      const suffix = region === 'eu-central-2' ? 'dkim.eu-central-2.amazonses.com' : 'dkim.amazonses.com';
      expect(world.cf.records.map((record) => record.content)).toEqual(
        TOKENS.map((token) => `${token}.${suffix}`),
      );
      expect(world.ses.calls.every((call) => call.argv[3] === region)).toBe(true);
    },
  );

  it.each(['external', 'disabled', 'tokens', 'authorization'])(
    'keeps incompatible existing identities and refuses reconfiguration: %s',
    async (state) => {
      world.ses.identity = sesIdentity();
      if (state === 'external') world.ses.identity.DkimAttributes.SigningAttributesOrigin = 'EXTERNAL';
      if (state === 'disabled') world.ses.identity.DkimAttributes.SigningEnabled = false;
      if (state === 'tokens') world.ses.identity.DkimAttributes.Tokens = [TOKENS[0]!, TOKENS[0]!, TOKENS[0]!];
      if (state === 'authorization') world.ses.identity.Policies.otherAccount = {};
      expect(await run('configure')).toBe(2);
      noWrites();
    },
  );

  it('refuses malformed AWS and Cloudflare answers without printing their contents or assuming missing DNS', async () => {
    const original = world.deps();
    expect(
      await runCloud(
        ['ses', 'configure'],
        world.deps({
          run: async (command, args, options) =>
            args[7] === 'get-account'
              ? { code: 0, stdout: JSON.stringify({ secret: world.ses.issuedSecret }), stderr: '' }
              : original.run(command, args, options),
        }),
      ),
    ).toBe(1);
    expect(world.output).not.toContain(world.ses.issuedSecret);
    noWrites();
    world.ses.identity = sesIdentity();
    expect(
      await runCloud(
        ['ses', 'configure'],
        world.deps({
          fetch: async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname.endsWith('/dns_records'))
              return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
            return original.fetch(input, init);
          },
        }),
      ),
    ).toBe(1);
    expect(world.output).toContain('unexpected list shape');
    noWrites();
  });

  it.each(['foreign-cname', 'txt', 'duplicates'])(
    'refuses conflicting DKIM DNS before IAM or DNS mutation: %s',
    async (state) => {
      world.ses.identity = sesIdentity();
      const record = {
        id: 'foreign',
        zone_id: world.cf.zones[0]!.id,
        type: state === 'txt' ? 'TXT' : 'CNAME',
        name: `${TOKENS[0]}._domainkey.istvan.io`,
        content: 'elsewhere.example.com',
        proxied: false,
      };
      world.cf.records.push(record);
      if (state === 'duplicates') world.cf.records.push({ ...record, id: 'second' });
      expect(await run('configure')).toBe(2);
      noWrites();
    },
  );

  it.each([
    'tags',
    'account',
    'groups',
    'managed',
    'extra-inline',
    'unknown-key',
    'incomplete-local',
    'inactive-key',
    'extra-key',
    'missing-user',
    'temporary',
  ])('refuses foreign or unreadable IAM/credential state before writes: %s', async (state) => {
    if (state !== 'missing-user') world.ses.managedUser();
    if (state === 'tags') world.ses.user!.Tags = [];
    if (state === 'account') world.ses.user!.Arn = `arn:aws:iam::999999999999:user/${USER}`;
    if (state === 'groups') world.ses.groups.push('Administrators');
    if (state === 'managed') world.ses.attached.push('AdministratorAccess');
    if (state === 'extra-inline') world.ses.inline.set('other', {});
    if (state === 'unknown-key') world.ses.keys.push({ AccessKeyId: 'unknown', Status: 'Active' });
    if (['incomplete-local', 'inactive-key', 'extra-key', 'missing-user'].includes(state))
      updateEnvFile(world.envFile, {
        PROJECTMAN_SES_ACCESS_KEY_ID: 'known',
        ...(state === 'incomplete-local' ? {} : { PROJECTMAN_SES_SECRET_ACCESS_KEY: 'known-secret' }),
      });
    if (state === 'inactive-key' || state === 'extra-key')
      world.ses.keys.push({ AccessKeyId: 'known', Status: state === 'inactive-key' ? 'Inactive' : 'Active' });
    if (state === 'extra-key') world.ses.keys.push({ AccessKeyId: 'another', Status: 'Active' });
    if (state === 'temporary')
      updateEnvFile(world.envFile, { PROJECTMAN_SES_SESSION_TOKEN: 'temporary-secret' });
    expect(await run('configure')).toBe(2);
    noWrites();
  });

  it('recovers partial DNS/policy failure without duplicating the identity or silently enabling login', async () => {
    world.ses.failOperation = 'put-user-policy';
    expect(await run('configure')).toBe(1);
    expect(existsSync(world.envFile)).toBe(false);
    expect(world.cf.records).toHaveLength(3);
    world.ses.failOperation = null;
    clear();
    expect(await run('configure')).toBe(0);
    expect(world.ses.calls.some((call) => call.args[1] === 'create-email-identity')).toBe(false);
    expect(world.cf.mutations()).toEqual([]);
  });

  it('redacts a lost key response and refuses a retry instead of rotating the irretrievable key', async () => {
    world.ses.loseKeyResponse = true;
    expect(await run('configure')).toBe(1);
    expect(world.output).not.toContain(world.ses.issuedSecret);
    expect(existsSync(world.envFile)).toBe(false);
    clear();
    expect(await run('configure')).toBe(2);
    noWrites();
  });

  it('resumes after a partial DNS failure without duplicating a successful CNAME or creating a key early', async () => {
    const original = world.deps();
    let posted = 0;
    expect(
      await runCloud(
        ['ses', 'configure'],
        world.deps({
          fetch: async (input, init) => {
            if (init?.method === 'POST' && ++posted === 2)
              return new Response(
                JSON.stringify({ success: false, errors: [{ code: 10000, message: 'denied' }] }),
                { status: 403 },
              );
            return original.fetch(input, init);
          },
        }),
      ),
    ).toBe(1);
    expect(world.cf.records).toHaveLength(1);
    expect(world.ses.keys).toEqual([]);
    clear();
    expect(await run('configure')).toBe(0);
    expect(world.cf.mutations()).toHaveLength(2);
    expect(world.cf.records).toHaveLength(3);
  });

  it('never requests SES production or configures SES during up', async () => {
    const other = CloudflareWorld.ready();
    try {
      other.writeToken();
      const configure = vi.spyOn(COMMANDS['ses configure']!, 'run');
      const production = vi.spyOn(COMMANDS['ses request-production']!, 'run');
      expect(await runCloud(['up', '--dry-run'], other.deps())).toBe(0);
      expect(configure).not.toHaveBeenCalled();
      expect(production).not.toHaveBeenCalled();
    } finally {
      other.cleanup();
    }
  });
});

describe('production request and read-only check', () => {
  it('previews the exact transactional request, submits separately and waits for AWS approval', async () => {
    expect(await run('request-production', '--dry-run')).toBe(0);
    noWrites();
    expect(world.ses.request).toBeNull();
    clear();
    expect(await run('request-production')).toBe(0);
    expect(world.ses.request).toMatchObject({
      ProductionAccessEnabled: true,
      MailType: 'TRANSACTIONAL',
      WebsiteURL: 'https://chopper.istvan.io',
      ContactLanguage: 'EN',
      AdditionalContactEmailAddresses: ['owner@example.com'],
    });
    expect((world.ses.request as { UseCaseDescription: string }).UseCaseDescription).toContain(
      'customers invited',
    );
    expect(world.ses.account.ProductionAccessEnabled).toBe(false);
    expect(world.ses.mutations().map((call) => call.args[1])).toEqual(['put-account-details']);
    expect(world.cf.calls).toEqual([]);
    expect(existsSync(world.envFile)).toBe(false);
    clear();
    expect(await run('request-production')).toBe(0);
    noWrites();
    expect(world.output).toContain('review pending');
  });

  it('does not resubmit a production account and rejects too many AWS contact emails', async () => {
    world.ses.account.ProductionAccessEnabled = true;
    expect(await run('request-production')).toBe(0);
    noWrites();
    world.writeConfig({
      aws: { ...(baseConfig().aws as object), profile: 'aroom' },
      cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
      ses: SES_CONFIG,
      access: {
        emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'],
      },
    });
    clear();
    expect(await run('request-production')).toBe(2);
    expect(world.ses.calls).toEqual([]);
  });

  it('requires verified DKIM, production and sending, exact DNS/IAM/env and sends no test mail', async () => {
    expect(await run('configure')).toBe(0);
    clear();
    expect(await run('check')).toBe(1);
    noWrites();
    world.ses.identity!.VerifiedForSendingStatus = true;
    world.ses.identity!.DkimAttributes.Status = 'SUCCESS';
    clear();
    expect(await run('check')).toBe(1);
    expect(world.output).toContain('sandbox');
    world.verify();
    clear();
    expect(await run('check')).toBe(0);
    noWrites();
    expect(world.output).toContain('no mail sent');
    expect(world.ses.calls.every((call) => call.argv[1] === 'aroom' && call.argv[3] === 'eu-central-1')).toBe(
      true,
    );
  });

  it('accepts AWS URL-encoded singleton-array policy responses and refuses blank protected secrets', async () => {
    expect(await run('configure')).toBe(0);
    world.verify();
    const policy = sesPolicy(SES_CONFIG, ACCOUNT);
    const statement = policy.Statement[0]!;
    world.ses.inline.set(
      'ses-send',
      encodeURIComponent(
        JSON.stringify({
          ...policy,
          Statement: { ...statement, Action: [statement.Action], Resource: [statement.Resource] },
        }),
      ),
    );
    clear();
    expect(await run('check')).toBe(0);
    noWrites();
    updateEnvFile(world.envFile, { PROJECTMAN_SES_SECRET_ACCESS_KEY: '   ' });
    clear();
    expect(await run('check')).toBe(2);
    noWrites();
    expect(world.output).toContain('incomplete credentials');
  });

  it.each(['sending', 'dns-missing', 'dns-proxy', 'policy-wide', 'policy-from', 'env-from', 'env-disabled'])(
    'fails read-only check on drift: %s',
    async (state) => {
      expect(await run('configure')).toBe(0);
      world.verify();
      if (state === 'sending') world.ses.account.SendingEnabled = false;
      if (state === 'dns-missing') world.cf.records.pop();
      if (state === 'dns-proxy') world.cf.records[0]!.proxied = true;
      if (state === 'policy-wide')
        world.ses.inline.set('ses-send', {
          ...sesPolicy(SES_CONFIG, ACCOUNT),
          Statement: [{ Effect: 'Allow', Action: 'ses:*', Resource: '*' }],
        });
      if (state === 'policy-from')
        world.ses.inline.set('ses-send', sesPolicy({ ...SES_CONFIG, from: 'other@istvan.io' }, ACCOUNT));
      if (state === 'env-from') updateEnvFile(world.envFile, { PROJECTMAN_SES_FROM: 'other@istvan.io' });
      if (state === 'env-disabled') updateEnvFile(world.envFile, { PROJECTMAN_EMAIL_LOGIN_ENABLED: '0' });
      clear();
      const env = readFileSync(world.envFile, 'utf8');
      expect(await run('check')).toBe(1);
      noWrites();
      expect(readFileSync(world.envFile, 'utf8')).toBe(env);
    },
  );
});

describe('SES in its own AWS account (PM-729)', () => {
  const TARGET = '--profile i --region eu-west-1 --output json';
  const I_ACCOUNT = SES_ACCOUNTS.i!;
  const usesTarget = () =>
    world.ses.calls.every((call) => call.argv.slice(0, 6).join(' ') === TARGET) && world.ses.calls.length > 0;
  const prepared = () => {
    world.ses.identity = sesIdentity();
    world.ses.account.ProductionAccessEnabled = true;
    world.verify();
    world.cf.records.push(
      ...TOKENS.map((token, index) => ({
        id: `own-${index}`,
        zone_id: world.cf.zones[0]!.id,
        type: 'CNAME',
        name: `${token}._domainkey.istvan.io`,
        content: `${token}.dkim.amazonses.com`,
        proxied: false,
        ttl: 1,
      })),
    );
  };

  beforeEach(() => {
    world.cleanup();
    world = new SesWorld(I_SES_CONFIG);
  });

  it('names the target in the log and runs plan, dry-run and check only against it', async () => {
    prepared();
    expect(await run('plan')).toBe(0);
    expect(world.output).toContain(`SES profile i, account ${I_ACCOUNT}, region eu-west-1`);
    expect(world.output).not.toContain('registrar profile');
    expect(usesTarget()).toBe(true);
    clear();
    expect(await run('configure', '--dry-run')).toBe(0);
    noWrites();
    expect(usesTarget()).toBe(true);
    expect(world.output).toContain(`eu-west-1:${I_ACCOUNT}:identity/istvan.io`);
    clear();
    expect(await run('check')).toBe(1);
    expect(usesTarget()).toBe(true);
  });

  it('keeps the existing identity and DKIM, creates the narrow user and key in the target account only', async () => {
    prepared();
    const records = structuredClone(world.cf.records);
    updateEnvFile(world.envFile, { UNRELATED: 'keep' });
    expect(await run('configure')).toBe(0);
    expect(usesTarget()).toBe(true);
    expect(world.ses.calls.some((call) => call.args[1] === 'create-email-identity')).toBe(false);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.cf.records).toEqual(records);
    expect(world.ses.user!.Arn).toBe(`arn:aws:iam::${I_ACCOUNT}:user/${USER}`);
    expect(world.ses.inline.get('ses-send')).toEqual(sesPolicy(I_SES_CONFIG, I_ACCOUNT));
    expect(JSON.stringify(world.ses.inline.get('ses-send'))).toContain(
      `arn:aws:ses:eu-west-1:${I_ACCOUNT}:identity/istvan.io`,
    );
    const env = readFileSync(world.envFile, 'utf8');
    expect(env).toContain('UNRELATED=keep\n');
    expect(env).toContain('PROJECTMAN_SES_REGION=eu-west-1\n');
    expect(env).toContain('PROJECTMAN_EMAIL_LOGIN_ENABLED=1\n');
    expect(env).toContain(`PROJECTMAN_SES_SECRET_ACCESS_KEY=${world.ses.issuedSecret}\n`);
    expect(statSync(world.envFile).mode & 0o777).toBe(0o600);
    expect(world.output).not.toContain(world.ses.issuedSecret);
    clear();
    expect(await run('check')).toBe(0);
    noWrites();
    expect(usesTarget()).toBe(true);
    clear();
    expect(await run('configure')).toBe(0);
    noWrites();
    expect(readFileSync(world.envFile, 'utf8')).toBe(env);
  });

  it('creates a missing identity in the target account and requests production there', async () => {
    expect(await run('configure')).toBe(0);
    expect(world.ses.calls.filter((call) => call.args[1] === 'create-email-identity')).toHaveLength(1);
    expect(usesTarget()).toBe(true);
    expect(world.cf.records).toHaveLength(3);
    clear();
    expect(await run('request-production')).toBe(0);
    expect(world.ses.mutations().map((call) => call.args[1])).toEqual(['put-account-details']);
    expect(usesTarget()).toBe(true);
    world.ses.account.ProductionAccessEnabled = true;
    clear();
    expect(await run('request-production')).toBe(0);
    noWrites();
    expect(usesTarget()).toBe(true);
  });

  it('refuses a key of the former account in the local env until it is explicitly removed', async () => {
    prepared();
    updateEnvFile(world.envFile, {
      PROJECTMAN_SES_ACCESS_KEY_ID: 'AKIAFORMERACCOUNT0001',
      PROJECTMAN_SES_SECRET_ACCESS_KEY: 'former-account-secret',
      PROJECTMAN_SES_REGION: 'eu-central-1',
      PROJECTMAN_EMAIL_LOGIN_ENABLED: '1',
      UNRELATED: 'keep',
    });
    expect(await run('configure')).toBe(2);
    expect(world.output).toContain('incomplete credentials');
    expect(world.output).not.toContain('former-account-secret');
    noWrites();
    expect(world.ses.user).toBeNull();
    removeEnvNames(world.envFile, ['PROJECTMAN_SES_ACCESS_KEY_ID', 'PROJECTMAN_SES_SECRET_ACCESS_KEY']);
    updateEnvFile(world.envFile, { PROJECTMAN_EMAIL_LOGIN_ENABLED: '0' });
    clear();
    expect(await run('configure')).toBe(0);
    expect(world.ses.keys).toHaveLength(1);
    expect(readFileSync(world.envFile, 'utf8')).toContain('UNRELATED=keep\n');
    clear();
    expect(await run('check')).toBe(0);
  });

  it('refuses a user whose ARN belongs to another account than the target', async () => {
    prepared();
    world.ses.managedUser();
    world.ses.user!.Arn = `arn:aws:iam::${SES_ACCOUNTS.aroom}:user/${USER}`;
    expect(await run('configure')).toBe(2);
    expect(world.output).toContain('configured SES account');
    noWrites();
  });

  it('deletes a freshly issued key with the target profile when it cannot be saved', async () => {
    prepared();
    const original = world.deps();
    expect(
      await runCloud(
        ['ses', 'configure'],
        world.deps({
          run: async (command, args, options) => {
            const result = await original.run(command, args, options);
            if (args[6] === 'iam' && args[7] === 'create-access-key') chmodSync(world.secretsDir, 0o500);
            if (args[7] === 'delete-access-key') chmodSync(world.secretsDir, 0o700);
            return result;
          },
        }),
      ),
    ).toBe(1);
    chmodSync(world.secretsDir, 0o700);
    const deletion = world.ses.calls.filter((call) => call.args[1] === 'delete-access-key');
    expect(deletion).toHaveLength(1);
    expect(deletion[0]!.argv.slice(0, 6).join(' ')).toBe(TARGET);
    expect(world.ses.keys).toEqual([]);
    expect(world.output).not.toContain(world.ses.issuedSecret);
  });
});
