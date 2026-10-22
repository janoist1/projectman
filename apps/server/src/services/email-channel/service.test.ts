import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmailSender } from './ses-sender';
import {
  createDomainHarness,
  OWNER,
  OWNER_ACTOR,
  type DomainHarness,
} from '../../../test/helpers/domain-harness';

const env = {
  region: 'eu-central-1',
  from: 'project@example.test',
  credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  configurationSet: null,
  replyDomain: 'reply.example.test',
  queueUrl: null,
} as const;

describe('EmailChannelService', () => {
  let harness: DomainHarness;
  let sent: unknown[];

  beforeEach(async () => {
    sent = [];
    const sender: EmailSender = {
      async send(input) {
        sent.push(input);
        return { providerId: `provider-${sent.length}` };
      },
    };
    harness = await createDomainHarness({
      emailChannel: { sender, env },
      adjust(config) {
        config.project.email = { enabled: true };
        const developer = config.team.members.find((member) => member.handle === 'dev-1');
        if (developer?.kind === 'ai') developer.email = { enabled: true };
      },
    });
    harness.domain.emailChannel.setContact('AR', 'owner', true, { handle: 'owner' });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('sends without approval and records the provider id', async () => {
    const owner = await harness.domain.projects.config('AR');
    const developer = owner.team.members.find((member) => member.handle === 'dev-1');
    if (developer?.kind === 'ai') developer.email = { enabled: true, sendWithoutApproval: true };
    await harness.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      const developer = draft.team.members.find((member) => member.handle === 'dev-1');
      if (developer?.kind === 'ai') developer.email = { enabled: true, sendWithoutApproval: true };
      return 'Allow the developer to send e-mail without approval';
    });
    const result = await harness.domain.emailChannel.send('AR', 'dev-1', {
      to: 'owner',
      subject: 'Summary',
      text: 'Ready.',
      taskKey: null,
    });
    expect(result.status).toBe('sent');
    expect(sent[0]).toMatchObject({
      to: 'owner@example.com',
      subject: 'Summary',
      replyTo: expect.stringMatching(/^r-ar-[a-z234567]{26}@reply\.example\.test$/),
    });
    const record = harness.domain.emailChannel
      .log('AR', null)
      .entries.find((entry) => entry.kind === 'outbound');
    expect(record).toMatchObject({ status: 'sent' });
  });

  it('keeps an approval-required e-mail pending until the owner approves it', async () => {
    const result = await harness.domain.emailChannel.send('AR', 'dev-1', {
      to: 'owner',
      subject: 'Summary',
      text: 'Ready.',
      taskKey: null,
    });
    expect(result.status).toBe('pending_approval');
    const item = harness.domain.inbox
      .list('AR', { state: 'open' })
      .find((candidate) => candidate.kind === 'approval');
    expect(item).toBeTruthy();
    await harness.domain.inbox.resolve(
      'AR',
      item!.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    expect(sent).toHaveLength(1);
    const record = harness.domain.emailChannel
      .log('AR', null)
      .entries.find((entry) => entry.kind === 'outbound');
    expect(record).toMatchObject({ status: 'sent', decidedBy: 'owner' });
  });

  it('rejects an approval when the recipient no longer asks for e-mail', async () => {
    await harness.domain.emailChannel.send('AR', 'dev-1', {
      to: 'owner',
      subject: 'Summary',
      text: 'Ready.',
      taskKey: null,
    });
    const item = harness.domain.inbox
      .list('AR', { state: 'open' })
      .find((candidate) => candidate.kind === 'approval');
    harness.domain.emailChannel.setContact('AR', 'owner', false, { handle: 'owner' });
    await harness.domain.inbox.resolve(
      'AR',
      item!.id,
      { optionId: 'approve' },
      { handle: 'owner', access: 'owner' },
    );
    expect(sent).toEqual([]);
    const record = harness.domain.emailChannel
      .log('AR', null)
      .entries.find((entry) => entry.kind === 'outbound');
    expect(record).toMatchObject({ status: 'cancelled', note: 'not_wanted' });
  });

  it('refuses an approval from the integrator or super mode', async () => {
    await harness.domain.emailChannel.send('AR', 'dev-1', {
      to: 'owner',
      subject: 'Summary',
      text: 'Ready.',
      taskKey: null,
    });
    const item = harness.domain.inbox
      .list('AR', { state: 'open' })
      .find((candidate) => candidate.kind === 'approval');
    await expect(
      harness.domain.inbox.resolve(
        'AR',
        item!.id,
        { optionId: 'approve' },
        {
          handle: 'operator',
          access: 'owner',
          via: 'integrator',
        },
      ),
    ).rejects.toMatchObject({ code: 'owner_approval_required' });
    expect(sent).toEqual([]);
  });

  it('marks a failed provider send and closes its approval', async () => {
    const failing: EmailSender = {
      async send() {
        throw new Error('unavailable');
      },
    };
    const failingHarness = await createDomainHarness({
      emailChannel: { sender: failing, env },
      adjust(config) {
        config.project.email = { enabled: true };
        const developer = config.team.members.find((member) => member.handle === 'dev-1');
        if (developer?.kind === 'ai') developer.email = { enabled: true };
      },
    });
    try {
      failingHarness.domain.emailChannel.setContact('AR', 'owner', true, { handle: 'owner' });
      await failingHarness.domain.emailChannel.send('AR', 'dev-1', {
        to: 'owner',
        subject: 'Summary',
        text: 'Ready.',
        taskKey: null,
      });
      const item = failingHarness.domain.inbox
        .list('AR', { state: 'open' })
        .find((candidate) => candidate.kind === 'approval');
      await failingHarness.domain.inbox.resolve(
        'AR',
        item!.id,
        { optionId: 'approve' },
        { handle: 'owner', access: 'owner' },
      );
      const record = failingHarness.domain.emailChannel
        .log('AR', null)
        .entries.find((entry) => entry.kind === 'outbound');
      expect(record).toMatchObject({ status: 'failed', note: 'unavailable' });
      expect(failingHarness.domain.inbox.get('AR', item!.id).state).toBe('resolved');
    } finally {
      await failingHarness.cleanup();
    }
  });
});
