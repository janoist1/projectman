import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { sesPolicy } from '../../../scripts/cloud/ses';
import { ACCOUNT, baseConfig } from './helpers/fake-aws';
import { CF_TOKEN } from './helpers/fake-cloudflare';
import { REPLY_TOKENS, SES_CONFIG, SesWorld } from './helpers/fake-ses';

const REPLY_DOMAIN = 'reply.istvan.io';
const INSTANCE = 'projectman-cloud';
const TOPIC_ARN = `arn:aws:sns:eu-central-1:${ACCOUNT}:${INSTANCE}-email-in`;
const QUEUE_ARN = `arn:aws:sqs:eu-central-1:${ACCOUNT}:${INSTANCE}-email-in`;
const DLQ_ARN = `${QUEUE_ARN}-dlq`;
const QUEUE_URL = `https://sqs.eu-central-1.amazonaws.com/${ACCOUNT}/${INSTANCE}-email-in`;
const INBOUND_NAMES = { configurationSet: `${INSTANCE}-email`, queue: `${INSTANCE}-email-in` };
const INBOUND_CONFIG = { ...SES_CONFIG, inbound: { replyDomain: REPLY_DOMAIN } };

let world: SesWorld;
beforeEach(() => {
  world = new SesWorld(INBOUND_CONFIG);
});
afterEach(() => {
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
/** The sender exists (`ses configure`), as receiving builds on its user and key. */
const withSender = async () => {
  expect(await run('configure')).toBe(0);
  clear();
};
const verifyReply = () => {
  world.verify();
  world.ses.replyIdentity!.VerifiedForSendingStatus = true;
  world.ses.replyIdentity!.DkimAttributes.Status = 'SUCCESS';
};
const configureWithRetained = async () => {
  await withSender();
  expect(await run('receive-configure')).toBe(0);
  verifyReply();
  clear();
};

describe('sesPolicy with the receiving statements', () => {
  it('is the sender-only policy without inbound', () => {
    expect(sesPolicy(SES_CONFIG, ACCOUNT).Statement).toHaveLength(1);
  });

  it('adds the configuration set to the sends and the one queue to the reads, nothing wide', () => {
    const policy = sesPolicy(SES_CONFIG, ACCOUNT, INBOUND_NAMES);
    expect(policy.Statement.slice(1)).toEqual([
      {
        Effect: 'Allow',
        Action: 'ses:SendEmail',
        Resource: `arn:aws:ses:eu-central-1:${ACCOUNT}:configuration-set/${INSTANCE}-email`,
        Condition: { StringEquals: { 'ses:FromAddress': SES_CONFIG.from } },
      },
      {
        Effect: 'Allow',
        Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'],
        Resource: QUEUE_ARN,
      },
    ]);
    const text = JSON.stringify(policy);
    expect(text).not.toContain('*');
    expect(text).not.toContain('SendRawEmail');
  });
});

describe('ses.inbound configuration', () => {
  it.each([
    ['the zone itself', { ...SES_CONFIG, inbound: { replyDomain: 'istvan.io' } }],
    ['another zone', { ...SES_CONFIG, inbound: { replyDomain: 'reply.elsewhere.io' } }],
    [
      'the sender domain',
      {
        ...SES_CONFIG,
        domain: 'mail.istvan.io',
        from: 'login@mail.istvan.io',
        inbound: { replyDomain: 'mail.istvan.io' },
      },
    ],
  ])('refuses a reply domain that is %s before any external call', async (_name, ses) => {
    world.writeConfig({
      aws: { ...(baseConfig().aws as object), profile: 'aroom' },
      cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
      ses,
    });
    expect(await run('receive-plan')).toBe(2);
    expect(world.output).toContain('ses.inbound.replyDomain');
    expect(world.ses.calls).toEqual([]);
  });

  it('refuses the receiving commands when ses.inbound is absent', async () => {
    world.writeConfig({
      aws: { ...(baseConfig().aws as object), profile: 'aroom' },
      cloudflare: { zone: 'istvan.io', hostname: 'chopper.istvan.io' },
      ses: SES_CONFIG,
    });
    for (const command of ['receive-plan', 'receive-configure', 'receive-check'])
      expect(await run(command)).toBe(2);
    expect(world.ses.calls).toEqual([]);
  });

  it('does not accept the dry-run flag on plan and check', async () => {
    expect(await run('receive-plan', '--dry-run')).toBe(64);
    expect(await run('receive-check', '--dry-run')).toBe(64);
  });
});

describe('ses receive-plan and receive-configure', () => {
  it('plan reads only, shows the cost and what would be created', async () => {
    await withSender();
    expect(await run('receive-plan')).toBe(0);
    noWrites();
    expect(world.output).toContain('would create SNS topic');
    expect(world.output).toContain('would create MX reply.istvan.io');
    expect(world.output).toMatch(/0\.10 USD per 1000 mails/);
    expect(world.output).toContain('aws.amazon.com/ses/pricing');
  });

  it('dry-run changes nothing in AWS, Cloudflare or cloud.env', async () => {
    await withSender();
    const env = readFileSync(world.envFile, 'utf8');
    expect(await run('receive-configure', '--dry-run')).toBe(0);
    noWrites();
    expect(readFileSync(world.envFile, 'utf8')).toBe(env);
    expect(world.output).toContain('dry-run');
  });

  it('creates the reply path with exact policies and converges on a second run', async () => {
    await withSender();
    const keys = [...world.ses.keys];
    world.cf.records.push({
      id: 'root-mx',
      zone_id: world.cf.zones[0]!.id,
      type: 'MX',
      name: 'istvan.io',
      content: 'mail.example.org',
      priority: 5,
    });
    expect(await run('receive-configure')).toBe(0);

    // The reply domain gets its identity, DKIM and an MX of its own; the zone's own mail is left alone.
    expect(world.ses.replyIdentity).not.toBeNull();
    expect(world.cf.records.find((record) => record.id === 'root-mx')).toMatchObject({ priority: 5 });
    expect(world.cf.records.filter((record) => record.name === REPLY_DOMAIN)).toEqual([
      expect.objectContaining({
        type: 'MX',
        content: 'inbound-smtp.eu-central-1.amazonaws.com',
        priority: 10,
        proxied: false,
      }),
    ]);
    for (const token of REPLY_TOKENS)
      expect(world.cf.records).toContainEqual(
        expect.objectContaining({
          type: 'CNAME',
          name: `${token}._domainkey.${REPLY_DOMAIN}`,
          proxied: false,
        }),
      );

    // The topic admits SES of this account only; the queue admits this topic only; five tries lead to the DLQ.
    expect(JSON.parse(world.ses.topic!.policy!).Statement).toEqual([
      expect.objectContaining({
        Principal: { Service: 'ses.amazonaws.com' },
        Action: 'sns:Publish',
        Resource: TOPIC_ARN,
        Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } },
      }),
    ]);
    const queue = world.ses.queues.get(`${INSTANCE}-email-in`)!;
    expect(JSON.parse(queue.attributes.Policy!).Statement).toEqual([
      expect.objectContaining({
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: QUEUE_ARN,
        Condition: { ArnEquals: { 'aws:SourceArn': TOPIC_ARN } },
      }),
    ]);
    expect(JSON.parse(queue.attributes.RedrivePolicy!)).toEqual({
      deadLetterTargetArn: DLQ_ARN,
      maxReceiveCount: 5,
    });
    expect(world.ses.queues.get(`${INSTANCE}-email-in-dlq`)!.attributes.MessageRetentionPeriod).toBe(
      '1209600',
    );
    expect(world.ses.subscriptions).toEqual([
      expect.objectContaining({ Protocol: 'sqs', Endpoint: QUEUE_ARN, raw: true }),
    ]);

    // Delivery events and receiving both go to the topic.
    expect(world.ses.eventDestinations).toEqual([
      expect.objectContaining({
        Enabled: true,
        MatchingEventTypes: ['BOUNCE', 'COMPLAINT', 'DELIVERY', 'REJECT'],
        SnsDestination: { TopicArn: TOPIC_ARN },
      }),
    ]);
    expect(world.ses.activeRuleSet).toBe(`${INSTANCE}-email`);
    expect(world.ses.ruleSets.get(`${INSTANCE}-email`)).toEqual([
      {
        Name: `${INSTANCE}-email-reply`,
        Enabled: true,
        TlsPolicy: 'Optional',
        Recipients: [REPLY_DOMAIN],
        Actions: [{ SNSAction: { TopicArn: TOPIC_ARN, Encoding: 'Base64' } }],
        ScanEnabled: true,
      },
    ]);

    // The sender's policy grows; the key stays; the protected env names the new settings.
    expect(world.ses.inline.get('ses-send')).toEqual(sesPolicy(SES_CONFIG, ACCOUNT, INBOUND_NAMES));
    expect(world.ses.keys).toEqual(keys);
    const env = readFileSync(world.envFile, 'utf8');
    expect(env).toContain('PROJECTMAN_EMAIL_CHANNEL_ENABLED=1\n');
    expect(env).toContain(`PROJECTMAN_EMAIL_REPLY_DOMAIN=${REPLY_DOMAIN}\n`);
    expect(env).toContain(`PROJECTMAN_EMAIL_QUEUE_URL=${QUEUE_URL}\n`);
    expect(env).toContain(`PROJECTMAN_EMAIL_CONFIGURATION_SET=${INSTANCE}-email\n`);
    for (const secret of [world.ses.issuedSecret, CF_TOKEN]) {
      expect(world.output).not.toContain(secret);
      expect(JSON.stringify(world.ses.calls)).not.toContain(secret);
    }
    expect(world.ses.calls.some((call) => /send|create-access-key/i.test(call.args[1]!))).toBe(false);

    clear();
    expect(await run('receive-configure')).toBe(0);
    noWrites();
    expect(readFileSync(world.envFile, 'utf8')).toBe(env);
  });

  it('puts the MX last, after the rule and the policies it relies on', async () => {
    await withSender();
    expect(await run('receive-configure')).toBe(0);
    const calls = [...world.ses.mutations().map((call) => call.args.slice(0, 2).join(' ')), 'MX'];
    expect(calls.indexOf('sns create-topic')).toBeLessThan(calls.indexOf('ses create-receipt-rule'));
    expect(calls.indexOf('ses set-active-receipt-rule-set')).toBeLessThan(calls.indexOf('MX'));
    expect(world.cf.mutationsTo('POST', /dns_records/).at(-1)!.body).toMatchObject({ type: 'MX' });
  });

  it('refuses another active receipt rule set and changes nothing', async () => {
    await withSender();
    world.ses.ruleSets.set('someone-elses', []);
    world.ses.activeRuleSet = 'someone-elses';
    expect(await run('receive-configure')).toBe(2);
    noWrites();
    expect(world.output).toContain('someone-elses');
    expect(world.ses.activeRuleSet).toBe('someone-elses');
    expect(await run('receive-configure', '--dry-run')).toBe(2);
    noWrites();
  });

  it('refuses before the sender exists, and a conflicting record at the reply name', async () => {
    expect(await run('receive-configure')).toBe(2);
    expect(world.output).toContain('ses configure first');
    noWrites();
    await withSender();
    world.cf.records.push({
      id: 'foreign-mx',
      zone_id: world.cf.zones[0]!.id,
      type: 'MX',
      name: REPLY_DOMAIN,
      content: 'mail.elsewhere.example',
      priority: 10,
    });
    expect(await run('receive-configure')).toBe(2);
    noWrites();
  });

  it.each([
    ['topic', () => world.ses.topic!.tags.splice(0)],
    ['queue', () => (world.ses.queues.get(`${INSTANCE}-email-in`)!.tags = {})],
  ])('refuses to adopt a %s that projectman did not tag', async (what) => {
    await withSender();
    expect(await run('receive-configure')).toBe(0);
    if (what === 'topic') world.ses.topic!.tags.splice(0);
    else world.ses.queues.get(`${INSTANCE}-email-in`)!.tags = {};
    clear();
    expect(await run('receive-configure')).toBe(2);
    noWrites();
  });

  it('does not let ses configure or ses check undo the receiving policy', async () => {
    await configureWithRetained();
    const policy = world.ses.inline.get('ses-send');
    expect(await run('configure')).toBe(0);
    expect(world.ses.inline.get('ses-send')).toEqual(policy);
    expect(world.ses.mutations()).toEqual([]);
    expect(await run('check')).toBe(0);
  });
});

describe('ses receive-check', () => {
  it('passes without sending anything and prints the dead-letter count', async () => {
    await configureWithRetained();
    world.ses.deadLetterMessages = 3;
    expect(await run('receive-check')).toBe(0);
    noWrites();
    expect(world.output).toContain('dead-letter queue messages: 3');
    expect(world.output).toContain('no mail sent');
  });

  it('fails while the reply identity is not verified', async () => {
    await configureWithRetained();
    world.ses.replyIdentity!.VerifiedForSendingStatus = false;
    expect(await run('receive-check')).toBe(1);
    expect(world.output).toContain('not verified');
  });

  it.each([
    [
      'the topic policy',
      () => (world.ses.topic!.policy = JSON.stringify({ Version: '2012-10-17', Statement: [] })),
    ],
    ['the queue policy', () => (world.ses.queues.get(`${INSTANCE}-email-in`)!.attributes.Policy = '{}')],
    [
      'the redrive count',
      () => (world.ses.queues.get(`${INSTANCE}-email-in`)!.attributes.RedrivePolicy = '{}'),
    ],
    ['the subscription', () => (world.ses.subscriptions[0]!.raw = false)],
    ['the event destination', () => (world.ses.eventDestinations = [])],
    ['the receipt rule', () => (world.ses.ruleSets.get(`${INSTANCE}-email`)![0]!.ScanEnabled = false)],
    ['the sender policy', () => world.ses.inline.set('ses-send', sesPolicy(SES_CONFIG, ACCOUNT))],
    [
      'the MX record',
      () =>
        world.cf.records.splice(
          world.cf.records.findIndex((record) => record.type === 'MX'),
          1,
        ),
    ],
  ])('fails when %s drifted', async (_what, drift) => {
    await configureWithRetained();
    drift();
    expect(await run('receive-check')).toBe(1);
    expect(world.output).toContain('FAIL');
    noWrites();
  });

  it('fails when cloud.env lacks the receiving keys or another rule set is active', async () => {
    await configureWithRetained();
    world.ses.activeRuleSet = 'someone-elses';
    world.ses.ruleSets.set('someone-elses', []);
    expect(await run('receive-check')).toBe(1);
    expect(world.output).toContain('someone-elses');
  });
});
