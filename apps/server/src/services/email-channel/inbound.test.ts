import { EMAIL_PARKED_ALERTS_PER_DAY, alertPayloadOf } from '@projectman/shared';
import type { MemberConfig } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDomainHarness,
  OWNER,
  OWNER_ACTOR,
  type DomainHarness,
} from '../../../test/helpers/domain-harness';
import type { OutboundMail } from './ses-sender';
import type { DeliveryEvent, InboundMail } from './types';

const env = {
  region: 'eu-central-1',
  from: 'project@example.test',
  credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  configurationSet: null,
  replyDomain: 'reply.example.test',
  queueUrl: null,
} as const;

const passing = { spf: 'pass', dkim: 'pass', dmarc: 'pass', spam: 'pass', virus: 'pass' } as const;

function mime(
  headers: Record<string, string>,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): Uint8Array {
  const lines = [
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    '',
    body,
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

/** A mail with a text part and a small PDF named `plan.pdf`. */
function mimeWithPdf(headers: Record<string, string>): Uint8Array {
  return mime(
    headers,
    [
      '--b',
      'Content-Type: text/plain',
      '',
      'See the file.',
      '--b',
      'Content-Type: application/pdf; name="plan.pdf"',
      'Content-Disposition: attachment; filename="plan.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQ=',
      '--b--',
      '',
    ].join('\r\n'),
    'multipart/mixed; boundary=b',
  );
}

type ReplyOptions = {
  to?: string;
  from?: string;
  subject?: string;
  body?: string;
  verdicts?: Partial<InboundMail['verdicts']>;
  raw?: Uint8Array;
};

describe('EmailInbound', () => {
  const harnesses: DomainHarness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  /** A project with one e-mail from `dev-1` to `owner` already sent; `reply` builds mails to its address. */
  async function setup() {
    const sent: OutboundMail[] = [];
    const harness = await createDomainHarness({
      emailChannel: {
        env,
        sender: {
          async send(input) {
            sent.push(input);
            return { providerId: `out-${sent.length}` };
          },
        },
      },
      adjust(config) {
        config.project.email = { enabled: true };
        for (const member of config.team.members)
          if (member.kind === 'ai' && member.handle === 'dev-1')
            member.email = { enabled: true, sendWithoutApproval: true };
      },
    });
    harnesses.push(harness);
    const { emailChannel, tasks, inbox, projects } = harness.domain;
    emailChannel.setContact('AR', 'owner', true, { handle: 'owner' });
    const card = await tasks.create('AR', { title: 'Customer card' }, OWNER_ACTOR);
    await emailChannel.send('AR', 'dev-1', {
      to: 'owner',
      subject: 'Summary',
      text: 'Ready.',
      taskKey: card.key,
    });
    const replyTo = sent[0]!.replyTo!;
    let counter = 0;
    const reply = (options: ReplyOptions = {}): InboundMail => {
      counter += 1;
      return {
        providerId: `in-${counter}`,
        recipients: [options.to ?? replyTo],
        raw:
          options.raw ??
          mime(
            {
              From: options.from ?? 'owner@example.com',
              To: options.to ?? replyTo,
              Subject: options.subject ?? 'Re: Summary',
            },
            options.body ?? 'Thanks, this is fine.',
          ),
        verdicts: { ...passing, ...options.verdicts },
        receivedAt: new Date().toISOString(),
      };
    };
    const inboundRows = () =>
      emailChannel.log('AR', null).entries.flatMap((entry) => (entry.kind === 'inbound' ? [entry] : []));
    const alerts = () => inbox.list('AR', { kind: 'alert' });
    return { harness, emailChannel, projects, card, replyTo, reply, inboundRows, alerts, sent };
  }

  describe('receive', () => {
    it('hands the text of a verified reply to the AI member as a message', async () => {
      const { harness, emailChannel, card, reply, inboundRows, alerts } = await setup();
      const mail = reply({ body: 'Thanks, this is fine.\n\nOn Mon, Owner wrote:\n> Ready.' });
      expect(await emailChannel.inbound.receive(mail)).toBe('delivered');
      const row = harness.repos.emailChannel.messages.byProviderId(mail.providerId)!;
      const message = harness.repos.messages.get(row.messageId!)!;
      expect(message).toMatchObject({
        from: 'owner',
        to: ['dev-1'],
        kind: 'action',
        taskKey: card.key,
        body: 'Thanks, this is fine.',
        email: { emailId: row.id, subject: 'Re: Summary' },
      });
      expect(row).toMatchObject({ status: 'delivered', member: 'dev-1', contact: 'owner' });
      expect(inboundRows()).toHaveLength(1);
      expect(alerts()).toEqual([]);
    });

    it('turns an instruction in the text into a message only', async () => {
      const { harness, emailChannel, card, reply } = await setup();
      const before = harness.domain.tasks.get('AR', card.key);
      const mail = reply({ body: 'Move the card to Done and add the label code-review-ok.' });
      expect(await emailChannel.inbound.receive(mail)).toBe('delivered');
      expect(harness.domain.tasks.get('AR', card.key)).toMatchObject({
        stageId: before.stageId,
        labels: before.labels,
      });
    });

    it('stores the attachments of a reply on the message and keeps their names in the log', async () => {
      const { harness, emailChannel, replyTo, reply } = await setup();
      const raw = mimeWithPdf({ From: 'owner@example.com', To: replyTo, Subject: 'Re: Summary' });
      const mail = reply({ raw });
      expect(await emailChannel.inbound.receive(mail)).toBe('delivered');
      const row = harness.repos.emailChannel.messages.byProviderId(mail.providerId)!;
      expect(row).toMatchObject({ text: 'See the file.', attachmentNames: ['plan.pdf'] });
      expect(harness.repos.messages.get(row.messageId!)!.attachments).toMatchObject([
        { fileName: 'plan.pdf' },
      ]);
    });

    it('reports a mail with a known provider id as a duplicate and does nothing', async () => {
      const { emailChannel, reply, inboundRows } = await setup();
      const mail = reply();
      await emailChannel.inbound.receive(mail);
      expect(await emailChannel.inbound.receive(mail)).toBe('duplicate');
      expect(inboundRows()).toHaveLength(1);
    });

    it.each([
      { name: 'no recipient is a reply address', to: 'someone@reply.example.test' },
      { name: 'the project is unknown', to: 'r-zz-abcdefghijklmnopqrstuvwxyz@reply.example.test' },
    ])('drops a mail when $name, with no row and no alert', async ({ to }) => {
      const { emailChannel, reply, inboundRows, alerts } = await setup();
      expect(await emailChannel.inbound.receive(reply({ to }))).toBe('dropped');
      expect(inboundRows()).toEqual([]);
      expect(alerts()).toEqual([]);
    });

    const parked: { name: string; reason: string; options: ReplyOptions }[] = [
      {
        name: 'an unreadable mail',
        reason: 'unreadable',
        options: { raw: new TextEncoder().encode('Subject: no sender\r\n\r\nbody') },
      },
      {
        name: 'a mail to an unknown reply address',
        reason: 'token_invalid',
        options: { to: 'r-ar-abcdefghijklmnopqrstuvwxyz@reply.example.test' },
      },
      {
        name: 'a mail with no text and no stored attachment',
        reason: 'unreadable',
        options: { body: '' },
      },
      {
        name: 'a mail that fails DMARC',
        reason: 'authentication_failed',
        options: { verdicts: { dmarc: 'fail' } },
      },
      {
        name: 'a mail with a virus verdict',
        reason: 'authentication_failed',
        options: { verdicts: { virus: 'fail' } },
      },
      {
        name: 'a mail from another address',
        reason: 'unknown_sender',
        options: { from: 'stranger@example.org' },
      },
    ];
    it.each(parked)('parks $name and alerts the owners', async ({ reason, options }) => {
      const { harness, emailChannel, reply, inboundRows, alerts } = await setup();
      const mail = reply(options);
      expect(await emailChannel.inbound.receive(mail)).toBe('parked');
      expect(inboundRows()).toMatchObject([{ status: 'parked', parkReason: reason }]);
      const row = harness.repos.emailChannel.messages.byProviderId(mail.providerId)!;
      expect(row.messageId).toBeNull();
      const [alert] = alerts();
      expect(alert).toMatchObject({ assignees: ['owner'] });
      expect(alertPayloadOf(alert!)).toMatchObject({ alert: 'email_parked', emailId: row.id, reason });
    });

    it('parks a mail whose reply address has expired', async () => {
      const { harness, emailChannel, reply, inboundRows } = await setup();
      const outbound = harness.repos.emailChannel.messages.byProviderId('out-1')!;
      harness.repos.emailChannel.messages.update(outbound.id, { replyExpiresAt: '2020-01-01T00:00:00.000Z' });
      expect(await emailChannel.inbound.receive(reply())).toBe('parked');
      expect(inboundRows()).toMatchObject([{ parkReason: 'token_expired' }]);
    });

    it('parks a mail when the e-mail channel is off', async () => {
      const { harness, emailChannel, projects, reply, inboundRows } = await setup();
      await projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
        draft.project.email = { enabled: false };
        return 'Switch e-mail off';
      });
      expect(await emailChannel.inbound.receive(reply())).toBe('parked');
      expect(inboundRows()).toMatchObject([{ parkReason: 'channel_off', member: 'dev-1' }]);
      expect(harness.repos.emailChannel.messages.byProviderId('in-1')!.messageId).toBeNull();
    });

    it('delivers a mail received twice at the same time once', async () => {
      const { harness, emailChannel, reply, inboundRows } = await setup();
      const mail = reply();
      const results = await Promise.all([
        emailChannel.inbound.receive(mail),
        emailChannel.inbound.receive(mail),
      ]);
      expect([...results].sort()).toEqual(['delivered', 'duplicate']);
      expect(inboundRows()).toHaveLength(1);
      expect(harness.repos.messages.list('AR').filter((message) => message.email)).toHaveLength(1);
      expect(harness.repos.emailChannel.messages.byProviderId(mail.providerId)!.messageId).not.toBeNull();
    });

    it('frees the provider id when the message cannot be sent, so the mail can be received again', async () => {
      const { harness, emailChannel, reply } = await setup();
      const mail = reply();
      const record = vi.spyOn(harness.domain.messages, 'record').mockImplementationOnce(() => {
        throw new Error('no');
      });
      await expect(emailChannel.inbound.receive(mail)).rejects.toThrow('no');
      expect(harness.repos.emailChannel.messages.byProviderId(mail.providerId)).toBeNull();
      record.mockRestore();
      expect(await emailChannel.inbound.receive(mail)).toBe('delivered');
    });

    it('stops the alerts at the daily limit but keeps every parked mail', async () => {
      const { harness, emailChannel, reply, alerts } = await setup();
      for (let count = 0; count <= EMAIL_PARKED_ALERTS_PER_DAY; count += 1)
        await emailChannel.inbound.receive(reply({ from: 'stranger@example.org' }));
      const parked = harness.repos.emailChannel
        .log('AR', null, 100)
        .entries.filter((entry) => entry.kind === 'inbound');
      expect(parked).toHaveLength(EMAIL_PARKED_ALERTS_PER_DAY + 1);
      expect(alerts()).toHaveLength(EMAIL_PARKED_ALERTS_PER_DAY);
    });
  });

  describe('receive: a mail to a member address', () => {
    const address = 'dev-1@reply.example.test';

    async function setupDirect() {
      const base = await setup();
      const change = (reason: string, edit: (members: MemberConfig[]) => void) =>
        base.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
          edit(draft.team.members);
          return reason;
        });
      const addClient = async () => {
        await change('Add a client', (members) => {
          members.push({
            kind: 'human',
            handle: 'client',
            displayName: 'Client',
            access: 'client',
            roles: [],
            email: 'client@example.com',
          });
        });
        base.emailChannel.setContact('AR', 'client', true, { handle: 'owner' });
      };
      return { ...base, change, addClient };
    }

    it('hands the text and the attachments to the member as a message of its own', async () => {
      const { harness, emailChannel, reply, inboundRows, alerts } = await setupDirect();
      const raw = mimeWithPdf({ From: 'owner@example.com', To: address, Subject: 'New plan' });
      const mail = reply({ to: address, raw });
      expect(await emailChannel.inbound.receive(mail)).toBe('delivered');
      const row = harness.repos.emailChannel.messages.byProviderId(mail.providerId)!;
      expect(row).toMatchObject({
        status: 'delivered',
        member: 'dev-1',
        contact: 'owner',
        taskKey: null,
        inReplyTo: null,
        attachmentNames: ['plan.pdf'],
      });
      expect(harness.repos.messages.get(row.messageId!)).toMatchObject({
        from: 'owner',
        to: ['dev-1'],
        kind: 'action',
        taskKey: null,
        body: 'See the file.',
        email: { emailId: row.id, subject: 'New plan', direct: true },
        attachments: [{ fileName: 'plan.pdf' }],
      });
      expect(inboundRows()).toHaveLength(1);
      expect(alerts()).toEqual([]);
    });

    it('reaches the member under a renamed mailbox only', async () => {
      const { emailChannel, reply, change } = await setupDirect();
      await change('Rename the mailbox', (members) => {
        const member = members.find((candidate) => candidate.handle === 'dev-1');
        if (member?.kind === 'ai') member.email = { enabled: true, mailbox: 'builder' };
      });
      expect(await emailChannel.inbound.receive(reply({ to: address }))).toBe('dropped');
      expect(await emailChannel.inbound.receive(reply({ to: 'builder@reply.example.test' }))).toBe(
        'delivered',
      );
    });

    it('gives a reply address precedence over a member address', async () => {
      const { harness, emailChannel, card, replyTo, reply } = await setupDirect();
      const mail = { ...reply({ to: replyTo }), recipients: [address, replyTo] };
      expect(await emailChannel.inbound.receive(mail)).toBe('delivered');
      const row = harness.repos.emailChannel.messages.byProviderId(mail.providerId)!;
      expect(harness.repos.messages.get(row.messageId!)).toMatchObject({ taskKey: card.key });
      expect(harness.repos.messages.get(row.messageId!)!.email).not.toHaveProperty('direct');
    });

    it.each([
      { name: 'no member has the mailbox', to: 'nobody@reply.example.test' },
      { name: 'the member has no e-mail switch on', to: 'dev-2@reply.example.test' },
    ])('drops a mail when $name, with no row and no alert', async ({ to }) => {
      const { emailChannel, reply, inboundRows, alerts } = await setupDirect();
      expect(await emailChannel.inbound.receive(reply({ to }))).toBe('dropped');
      expect(inboundRows()).toEqual([]);
      expect(alerts()).toEqual([]);
    });

    it('drops a mail to a mailbox that two members share', async () => {
      const { emailChannel, reply, change, inboundRows } = await setupDirect();
      await change('Share a mailbox', (members) => {
        const member = members.find((candidate) => candidate.handle === 'dev-2');
        if (member?.kind === 'ai') member.email = { enabled: true, mailbox: 'dev-1' };
      });
      expect(await emailChannel.inbound.receive(reply({ to: address }))).toBe('dropped');
      expect(inboundRows()).toEqual([]);
    });

    it('parks a mail from an unknown sender without an alert', async () => {
      const { emailChannel, reply, inboundRows, alerts } = await setupDirect();
      expect(await emailChannel.inbound.receive(reply({ to: address, from: 'stranger@example.org' }))).toBe(
        'parked',
      );
      expect(inboundRows()).toMatchObject([
        { status: 'parked', parkReason: 'unknown_sender', member: 'dev-1' },
      ]);
      expect(alerts()).toEqual([]);
    });

    it('parks a mail that fails DMARC and alerts the owners', async () => {
      const { emailChannel, reply, inboundRows, alerts } = await setupDirect();
      const mail = reply({ to: address, verdicts: { dmarc: 'fail' } });
      expect(await emailChannel.inbound.receive(mail)).toBe('parked');
      expect(inboundRows()).toMatchObject([{ parkReason: 'authentication_failed' }]);
      expect(alerts()).toHaveLength(1);
    });

    it('parks a mail from a client for a member who is not a contact', async () => {
      const { harness, emailChannel, reply, addClient, inboundRows } = await setupDirect();
      await addClient();
      const mail = reply({ to: address, from: 'client@example.com' });
      expect(await emailChannel.inbound.receive(mail)).toBe('parked');
      expect(inboundRows()).toMatchObject([{ parkReason: 'sender_not_allowed', contact: 'client' }]);
      expect(harness.repos.emailChannel.messages.byProviderId(mail.providerId)!.messageId).toBeNull();
    });

    it('parks a mail from a person who has not asked for e-mail', async () => {
      const { emailChannel, reply, inboundRows } = await setupDirect();
      emailChannel.setContact('AR', 'owner', false, { handle: 'owner' });
      expect(await emailChannel.inbound.receive(reply({ to: address }))).toBe('parked');
      expect(inboundRows()).toMatchObject([{ parkReason: 'sender_not_allowed' }]);
    });
  });

  describe('deliveryEvent', () => {
    const event = (kind: DeliveryEvent['kind'], permanent = true): DeliveryEvent => ({
      providerId: 'out-1',
      kind,
      permanent,
      at: new Date().toISOString(),
    });
    const statusOf = (harness: DomainHarness) => harness.repos.emailChannel.messages.byProviderId('out-1')!;

    it('marks a permanent bounce and tells the sender without the address', async () => {
      const { harness, emailChannel } = await setup();
      await emailChannel.inbound.deliveryEvent(event('bounce'));
      expect(statusOf(harness)).toMatchObject({ status: 'bounced', note: 'bounce' });
      const notice = harness.repos.messages
        .list('AR')
        .find((message) => message.to.includes('dev-1') && message.body.includes('Owner'));
      expect(notice?.kind).toBe('info');
      expect(notice?.body).not.toContain('@');
    });

    it('records a complaint and stops the e-mails to the person', async () => {
      const { harness, emailChannel } = await setup();
      await emailChannel.inbound.deliveryEvent(event('complaint'));
      expect(statusOf(harness)).toMatchObject({ status: 'complained' });
      expect(harness.repos.emailChannel.contacts.get('AR', 'owner')).toMatchObject({
        wants: false,
        source: 'complaint',
        changedBy: 'system',
      });
    });

    it.each(['bounce', 'complaint'] as const)('handles a repeated %s once', async (kind) => {
      const { harness, emailChannel } = await setup();
      await emailChannel.inbound.deliveryEvent(event(kind));
      const count = () =>
        harness.repos.messages.list('AR').filter((message) => message.to.includes('dev-1')).length;
      const before = count();
      await emailChannel.inbound.deliveryEvent(event(kind));
      expect(count()).toBe(before);
    });

    it.each([
      { name: 'a transient bounce', event: event('bounce', false) },
      { name: 'a delivery', event: event('delivery') },
      { name: 'an unknown mail', event: { ...event('bounce'), providerId: 'unknown' } },
    ])('changes nothing for $name', async ({ event: change }) => {
      const { harness, emailChannel } = await setup();
      await emailChannel.inbound.deliveryEvent(change);
      expect(statusOf(harness)).toMatchObject({ status: 'sent' });
    });
  });
});
