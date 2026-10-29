import type { ProjectConfig } from '@projectman/shared';
import { EMAIL_SENDS_PER_CONTACT_DAY } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmailSender, OutboundMail } from './ses-sender';
import { EmailSendError } from './ses-sender';
import {
  createDomainHarness,
  OWNER,
  OWNER_ACTOR,
  type DomainHarness,
} from '../../../test/helpers/domain-harness';
import { addTwinEmailProject } from '../../../test/helpers/email-twin-project';

const env = {
  region: 'eu-central-1',
  from: 'project@example.test',
  credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  configurationSet: null,
  replyDomain: 'reply.example.test',
  queueUrl: null,
} as const;

const mail = { replyTo: null, to: 'owner', subject: 'Summary', text: 'Ready.', taskKey: null };

describe('EmailChannelService', () => {
  const harnesses: DomainHarness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
  });

  async function setup(
    options: {
      withoutApproval?: boolean;
      configured?: boolean;
      sender?: EmailSender;
      adjust?: (config: ProjectConfig) => void;
    } = {},
  ) {
    const sent: OutboundMail[] = [];
    const sender: EmailSender = options.sender ?? {
      async send(input) {
        sent.push(input);
        return { providerId: `provider-${sent.length}` };
      },
    };
    const harness = await createDomainHarness({
      ...(options.configured === false ? {} : { emailChannel: { sender, env } }),
      adjust(config) {
        config.project.email = { enabled: true };
        for (const member of config.team.members)
          if (member.kind === 'ai' && member.handle === 'dev-1')
            member.email = { enabled: true, sendWithoutApproval: options.withoutApproval ?? false };
        config.team.members.push({
          kind: 'human',
          handle: 'acme',
          displayName: 'Acme',
          email: 'acme@example.test',
          access: 'client',
          roles: [],
        });
        options.adjust?.(config);
      },
    });
    harnesses.push(harness);
    const { emailChannel, inbox, projects } = harness.domain;
    if (options.configured !== false) {
      emailChannel.setContact('AR', 'owner', true, { handle: 'owner' });
      emailChannel.setContact('AR', 'acme', true, { handle: 'owner' });
    }
    const outbound = () => emailChannel.log('AR', null).entries.filter((entry) => entry.kind === 'outbound');
    const pendingItem = () => inbox.list('AR', { state: 'open' }).find((item) => item.kind === 'approval')!;
    const approve = (optionId: 'approve' | 'reject', note?: string) =>
      inbox.resolve(
        'AR',
        pendingItem().id,
        { optionId, ...(note ? { note } : {}) },
        { handle: 'owner', access: 'owner' },
      );
    const update = (change: (config: ProjectConfig) => void) =>
      projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
        change(draft);
        return 'Change the e-mail settings';
      });
    return { harness, emailChannel, sent, outbound, pendingItem, approve, update };
  }

  function received(harness: DomainHarness) {
    const at = new Date().toISOString();
    return harness.repos.emailChannel.messages.insert({
      projectKey: 'AR',
      direction: 'inbound',
      member: 'dev-1',
      contact: 'owner',
      taskKey: null,
      subject: 'Question',
      text: 'Original <text>',
      status: 'delivered',
      parkReason: null,
      note: null,
      fromAddress: 'owner@example.com',
      attachmentNames: [],
      replyTokenHash: null,
      replyExpiresAt: null,
      inReplyTo: null,
      providerId: 'received-1',
      inboxItemId: null,
      messageId: null,
      mimeMessageId: '<parent@example.test>',
      mimeReferences: '<root@example.test>',
      decidedBy: null,
      decidedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  describe('send', () => {
    it('keeps reply metadata through approval and filters only the authored text', async () => {
      const { harness, emailChannel, sent, approve, pendingItem } = await setup();
      const parent = received(harness);
      harness.repos.emailChannel.messages.update(parent.id, { text: 'Contact stranger@external.test.' });
      const result = await emailChannel.send('AR', 'dev-1', { ...mail, subject: null, replyTo: parent.id });
      expect(result.status).toBe('pending_approval');
      expect(pendingItem()).toMatchObject({ body: mail.text });
      expect(sent).toHaveLength(0);
      await approve('approve');
      expect(sent[0]!.headers).toContainEqual({ name: 'In-Reply-To', value: '<parent@example.test>' });
      expect(sent[0]!.text).toContain('> Contact stranger@external.test.');
    });

    it('inherits the subject and card and quotes a received mail with MIME headers', async () => {
      const { harness, emailChannel, sent } = await setup({ withoutApproval: true });
      const card = await harness.domain.tasks.create('AR', { title: 'Question' }, OWNER_ACTOR);
      const parent = received(harness);
      harness.repos.emailChannel.messages.update(parent.id, { taskKey: card.key });
      const result = await emailChannel.send('AR', 'dev-1', { ...mail, subject: null, replyTo: parent.id });
      expect(harness.repos.emailChannel.messages.get(result.emailId)).toMatchObject({
        subject: 'Re: Question',
        taskKey: card.key,
        inReplyTo: parent.id,
      });
      expect(sent[0]!.headers).toEqual([
        { name: 'In-Reply-To', value: '<parent@example.test>' },
        { name: 'References', value: '<root@example.test> <parent@example.test>' },
      ]);
      expect(sent[0]!.text).toContain('> Original <text>');
      expect(sent[0]!.html).toContain('Original &lt;text&gt;');
    });

    it('keeps the first and newest references within the header limit', async () => {
      const { harness, emailChannel, sent } = await setup({ withoutApproval: true });
      const parent = received(harness);
      const ids = Array.from({ length: 20 }, (_, i) => `<${i}-${'x'.repeat(70)}@example.test>`);
      harness.repos.emailChannel.messages.update(parent.id, { mimeReferences: ids.join(' ') });
      await emailChannel.send('AR', 'dev-1', { ...mail, replyTo: parent.id });
      const references = sent[0]!.headers!.find((header) => header.name === 'References')!.value;
      expect(references.length).toBeLessThanOrEqual(900);
      expect(references.split(' ')[0]).toBe(ids[0]);
      expect(references.endsWith(`${ids.at(-1)} <parent@example.test>`)).toBe(true);
      expect(references).not.toContain(ids[1]);
    });

    it('sends a reply without MIME headers when the parent has no Message-ID', async () => {
      const { harness, emailChannel, sent } = await setup({ withoutApproval: true });
      const parent = received(harness);
      harness.repos.emailChannel.messages.update(parent.id, { mimeMessageId: null });
      await emailChannel.send('AR', 'dev-1', { ...mail, subject: null, replyTo: parent.id });
      expect(sent[0]).toMatchObject({ subject: 'Re: Question' });
      expect(sent[0]).not.toHaveProperty('headers');
    });

    it.each([
      { projectKey: 'OTHER' },
      { member: 'dev-2' },
      { contact: 'acme' },
      { direction: 'outbound' as const },
      { status: 'parked' as const },
    ])('rejects an ineligible parent %o', async (patch) => {
      const { harness, emailChannel } = await setup({ withoutApproval: true });
      const parent = received(harness);
      if ('projectKey' in patch)
        harness.repos.db
          .prepare('UPDATE email_messages SET project_key = ? WHERE id = ?')
          .run(patch.projectKey, parent.id);
      else harness.repos.emailChannel.messages.update(parent.id, patch);
      await expect(emailChannel.send('AR', 'dev-1', { ...mail, replyTo: parent.id })).rejects.toMatchObject({
        code: 'email_unknown',
        status: 404,
      });
    });

    it('requires a subject or a reply parent', async () => {
      const { emailChannel } = await setup({ withoutApproval: true });
      await expect(emailChannel.send('AR', 'dev-1', { ...mail, subject: null })).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
    });

    it('sends without approval and records the provider id', async () => {
      const { emailChannel, sent, outbound } = await setup({ withoutApproval: true });
      expect(await emailChannel.send('AR', 'dev-1', mail)).toMatchObject({ status: 'sent' });
      expect(sent[0]).toMatchObject({
        to: 'owner@example.com',
        subject: 'Summary',
      });
      expect(outbound()[0]).toMatchObject({ status: 'sent' });
    });

    const fromAddressOf = (harness: DomainHarness) => {
      const [row] = harness.repos.db
        .prepare("SELECT from_address AS fromAddress FROM email_messages WHERE direction = 'outbound'")
        .all() as { fromAddress: string }[];
      return row?.fromAddress;
    };

    it('writes from the member address without a reply token', async () => {
      const { harness, emailChannel, sent } = await setup({ withoutApproval: true });
      await emailChannel.send('AR', 'dev-1', mail);
      expect(sent[0]).toMatchObject({
        from: 'dev-1@reply.example.test',
        fromName: expect.not.stringContaining('·'),
      });
      expect(sent[0]).not.toHaveProperty('replyTo');
      const row = harness.repos.emailChannel.messages.byProviderId('provider-1')!;
      expect(row).toMatchObject({ replyTokenHash: null, replyExpiresAt: null });
      expect(fromAddressOf(harness)).toBe('dev-1@reply.example.test');
    });

    it('writes from the shared address when the handle is in conflict', async () => {
      const { harness, emailChannel, sent } = await setup({ withoutApproval: true });
      await addTwinEmailProject(harness);
      await emailChannel.send('AR', 'dev-1', mail);
      expect(sent[0]).toMatchObject({ from: env.from, fromName: expect.stringContaining('·') });
      expect(fromAddressOf(harness)).toBe(env.from);
    });

    it('resends once from the shared address when the provider refuses the member address', async () => {
      const sent: OutboundMail[] = [];
      const sender: EmailSender = {
        async send(input) {
          sent.push(input);
          if (input.from !== env.from) throw new EmailSendError('unavailable', true);
          return { providerId: 'provider-1' };
        },
      };
      const { harness, emailChannel, outbound } = await setup({ withoutApproval: true, sender });
      expect(await emailChannel.send('AR', 'dev-1', mail)).toMatchObject({ status: 'sent' });
      expect(sent.map((input) => input.from)).toEqual(['dev-1@reply.example.test', env.from]);
      expect(sent[1]!.fromName).toContain('·');
      expect(sent[1]!.replyTo).toMatch(/^r-ar-/);
      expect(harness.repos.emailChannel.messages.byProviderId('provider-1')).toMatchObject({
        replyTokenHash: expect.any(String),
        replyExpiresAt: expect.any(String),
      });
      expect(fromAddressOf(harness)).toBe(env.from);
      expect(outbound()[0]).toMatchObject({ status: 'sent' });
    });

    it('does not resend after another failure', async () => {
      const sent: OutboundMail[] = [];
      const sender: EmailSender = {
        async send(input) {
          sent.push(input);
          throw new EmailSendError('throttled');
        },
      };
      const { emailChannel } = await setup({ withoutApproval: true, sender });
      await expect(emailChannel.send('AR', 'dev-1', mail)).rejects.toMatchObject({
        code: 'email_send_failed',
      });
      expect(sent).toHaveLength(1);
    });

    it('puts the notice on the first mail to a contact only', async () => {
      const { emailChannel, sent } = await setup({ withoutApproval: true });
      await emailChannel.send('AR', 'dev-1', mail);
      await emailChannel.send('AR', 'dev-1', mail);
      await emailChannel.send('AR', 'dev-1', { ...mail, to: 'acme' });
      expect(sent.map((input) => input.text.includes('\n-- \n'))).toEqual([true, false, true]);
      expect(sent[0]!.html).toContain('color:');
      expect(sent[1]!.html).not.toContain('color:');
    });

    it('sends plain HTML without a card or a background', async () => {
      const { emailChannel, sent } = await setup({ withoutApproval: true });
      await emailChannel.send('AR', 'dev-1', mail);
      expect(sent[0]!.html).not.toMatch(/background|border-radius|font-family/);
    });

    it('lets the member write its own address in the text', async () => {
      const { emailChannel } = await setup({ withoutApproval: true });
      expect(
        await emailChannel.send('AR', 'dev-1', { ...mail, text: 'Write to dev-1@reply.example.test.' }),
      ).toMatchObject({ status: 'sent' });
    });

    it('sends an internal card to a consenting owner only after approval', async () => {
      const { harness, emailChannel, sent, outbound, pendingItem, approve } = await setup();
      const card = await harness.domain.tasks.create('AR', { title: 'Internal card' }, OWNER_ACTOR);
      expect((await emailChannel.view('AR')).contacts).toContainEqual(
        expect.objectContaining({ handle: 'owner', access: 'owner', wants: true }),
      );
      expect(
        await emailChannel.send('AR', 'dev-1', { ...mail, text: `See ${card.key}.`, taskKey: card.key }),
      ).toMatchObject({ status: 'pending_approval' });
      expect(sent).toEqual([]);
      expect(pendingItem()).toBeTruthy();
      await approve('approve');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        to: 'owner@example.com',
        text: expect.stringContaining(`See ${card.key}.`),
      });
      expect(outbound()[0]).toMatchObject({ status: 'sent', decidedBy: 'owner' });
    });

    it('marks a failed send, reports the reason and does not retry', async () => {
      const sender: EmailSender = {
        async send() {
          throw new EmailSendError('throttled');
        },
      };
      const { emailChannel, outbound } = await setup({ withoutApproval: true, sender });
      await expect(emailChannel.send('AR', 'dev-1', mail)).rejects.toMatchObject({
        code: 'email_send_failed',
        details: { reason: 'throttled' },
      });
      expect(outbound()[0]).toMatchObject({ status: 'failed', note: 'throttled' });
    });

    it.each([
      {
        name: 'the channel is not configured',
        code: 'email_not_configured',
        options: { configured: false },
      },
      {
        name: 'the project switch is off',
        code: 'email_channel_off',
        options: { adjust: (config: ProjectConfig) => void (config.project.email = { enabled: false }) },
      },
      {
        name: 'the AI member is not enabled',
        code: 'email_sender_not_enabled',
        options: {
          adjust: (config: ProjectConfig) => {
            for (const member of config.team.members) if (member.handle === 'dev-1') delete member.email;
          },
        },
      },
    ])('refuses when $name', async ({ code, options }) => {
      const { emailChannel, outbound } = await setup(options);
      await expect(emailChannel.send('AR', 'dev-1', mail)).rejects.toMatchObject({ code });
      expect(outbound()).toEqual([]);
    });

    it('refuses a recipient who does not ask for e-mail', async () => {
      const { emailChannel } = await setup();
      emailChannel.setContact('AR', 'owner', false, { handle: 'owner' });
      await expect(emailChannel.send('AR', 'dev-1', mail)).rejects.toMatchObject({
        code: 'email_recipient_refused',
        details: { reason: 'not_wanted' },
      });
    });

    it('refuses an internal teammate with an address but no recorded consent', async () => {
      const { emailChannel, sent, outbound } = await setup({
        adjust(config) {
          config.team.members.push({
            kind: 'human',
            handle: 'colleague',
            displayName: 'Colleague',
            access: 'developer',
            email: 'colleague@example.test',
            roles: [],
          });
        },
      });
      await expect(emailChannel.send('AR', 'dev-1', { ...mail, to: 'colleague' })).rejects.toMatchObject({
        code: 'email_recipient_refused',
        details: { reason: 'not_wanted' },
      });
      expect(sent).toEqual([]);
      expect(outbound()).toEqual([]);
    });

    it('refuses once the daily limit to one recipient is reached', async () => {
      const { emailChannel } = await setup();
      for (let count = 0; count < EMAIL_SENDS_PER_CONTACT_DAY; count += 1)
        await emailChannel.send('AR', 'dev-1', mail);
      await expect(emailChannel.send('AR', 'dev-1', mail)).rejects.toMatchObject({
        code: 'email_rate_limited',
      });
    });

    it.each([
      {
        name: 'a card that does not exist',
        to: 'acme',
        text: 'See AR-99 for the status.',
        reason: 'task_not_visible',
      },
      {
        name: 'an unknown e-mail address',
        to: 'owner',
        text: 'Write to stranger@example.org.',
        reason: 'email_address',
      },
    ])('refuses content with $name', async ({ to, text, reason }) => {
      const { harness, emailChannel, outbound } = await setup();
      await expect(emailChannel.send('AR', 'dev-1', { ...mail, to, text })).rejects.toMatchObject({
        code: 'email_content_refused',
        details: { reason },
      });
      expect(outbound()).toEqual([]);
    });
  });

  describe('view: the address of a member', () => {
    const senderOf = async (emailChannel: DomainHarness['domain']['emailChannel'], handle = 'dev-1') =>
      (await emailChannel.view('AR')).senders.find((sender) => sender.handle === handle)!;

    it('gives the member domain and the address of a member who may write', async () => {
      const { emailChannel } = await setup();
      expect(await emailChannel.view('AR')).toMatchObject({ memberDomain: 'reply.example.test' });
      expect(await senderOf(emailChannel)).toMatchObject({
        address: 'dev-1@reply.example.test',
        addressConflict: false,
      });
    });

    it('moves the address with a renamed handle', async () => {
      const { harness, emailChannel } = await setup();
      await harness.domain.members.rename('AR', 'dev-1', 'builder', { actor: OWNER_ACTOR, author: OWNER });
      expect(await senderOf(emailChannel, 'builder')).toMatchObject({
        address: 'builder@reply.example.test',
      });
    });

    it('gives no address while the project has the channel off', async () => {
      const { emailChannel, update } = await setup();
      await update((config) => {
        config.project.email = { enabled: false };
      });
      expect(await senderOf(emailChannel)).toMatchObject({ address: null, addressConflict: false });
    });

    it('gives no address to a member whose handle another project’s member shares, and flags the conflict', async () => {
      const { harness, emailChannel } = await setup();
      await addTwinEmailProject(harness);
      expect(await senderOf(emailChannel)).toMatchObject({ address: null, addressConflict: true });
    });

    it('has no member domain while the server has no e-mail channel', async () => {
      const { emailChannel } = await setup({ configured: false });
      expect(await emailChannel.view('AR')).toMatchObject({ memberDomain: null });
    });
  });

  describe('decision', () => {
    it('rejects an e-mail with the note and sends nothing', async () => {
      const { emailChannel, sent, outbound, approve } = await setup();
      await emailChannel.send('AR', 'dev-1', mail);
      await approve('reject', 'Not now');
      expect(sent).toEqual([]);
      expect(outbound()[0]).toMatchObject({ status: 'rejected', note: 'Not now', decidedBy: 'owner' });
    });

    it('cancels at approval when the recipient no longer asks for e-mail', async () => {
      const { emailChannel, sent, outbound, approve } = await setup();
      await emailChannel.send('AR', 'dev-1', mail);
      emailChannel.setContact('AR', 'owner', false, { handle: 'owner' });
      await approve('approve');
      expect(sent).toEqual([]);
      expect(outbound()[0]).toMatchObject({ status: 'cancelled', note: 'not_wanted' });
    });

    it('lets only one of a parallel approve and reject through, and sends nothing after a reject', async () => {
      const { emailChannel, sent, outbound, pendingItem } = await setup();
      await emailChannel.send('AR', 'dev-1', mail);
      const item = pendingItem();
      const by = { handle: 'owner', access: 'owner' } as const;
      // The approve awaits the project config before it decides; the reject lands in that gap.
      const [approval, rejection] = await Promise.allSettled([
        emailChannel.decideApproval(item, by, 'approve', null),
        emailChannel.decideApproval(item, by, 'reject', null),
      ]);
      expect(rejection.status).toBe('fulfilled');
      expect(approval).toMatchObject({ status: 'rejected', reason: { code: 'email_unknown' } });
      expect(sent).toEqual([]);
      expect(outbound()[0]).toMatchObject({ status: 'rejected' });
    });

    it('marks a failed send at approval and closes the item', async () => {
      const sender: EmailSender = {
        async send() {
          throw new Error('unavailable');
        },
      };
      const { emailChannel, outbound, pendingItem, approve, harness } = await setup({ sender });
      await emailChannel.send('AR', 'dev-1', mail);
      const itemId = pendingItem().id;
      await approve('approve');
      expect(outbound()[0]).toMatchObject({ status: 'failed', note: 'unavailable' });
      expect(harness.domain.inbox.get('AR', itemId).state).toBe('resolved');
    });

    it.each([
      {
        name: 'a send without approval',
        withoutApproval: true,
        run: async (s: Awaited<ReturnType<typeof setup>>) => s.emailChannel.send('AR', 'dev-1', mail),
      },
      {
        name: 'an approval',
        withoutApproval: false,
        run: async (s: Awaited<ReturnType<typeof setup>>) => {
          await s.emailChannel.send('AR', 'dev-1', mail);
          await s.approve('approve');
          return { status: 'sent' };
        },
      },
    ])('keeps the sent outcome of $name when telling the sender fails', async ({ withoutApproval, run }) => {
      const state = await setup({ withoutApproval });
      const notices = vi.spyOn(state.harness.domain.messaging, 'send').mockRejectedValue(new Error('down'));
      await expect(run(state)).resolves.toMatchObject({ status: 'sent' });
      expect(state.sent).toHaveLength(1);
      expect(state.outbound()[0]).toMatchObject({ status: 'sent' });
      expect(notices).toHaveBeenCalled();
      for (const [, , input] of notices.mock.calls) expect(input.text).not.toContain('could not be sent');
    });

    it('refuses an approval from the integrator or super mode', async () => {
      const { emailChannel, sent, pendingItem, harness } = await setup();
      await emailChannel.send('AR', 'dev-1', mail);
      await expect(
        harness.domain.inbox.resolve(
          'AR',
          pendingItem().id,
          { optionId: 'approve' },
          { handle: 'operator', access: 'owner', via: 'integrator' },
        ),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
      expect(sent).toEqual([]);
    });
  });

  describe('switching e-mail off', () => {
    it.each([
      {
        name: 'the project switch',
        change: (config: ProjectConfig) => void (config.project.email = { enabled: false }),
      },
      {
        name: "the member's switch",
        change: (config: ProjectConfig) => {
          for (const member of config.team.members) if (member.handle === 'dev-1') delete member.email;
        },
      },
    ])('cancels pending e-mails when $name goes off', async ({ change }) => {
      const { emailChannel, sent, outbound, pendingItem, update, harness } = await setup();
      await emailChannel.send('AR', 'dev-1', mail);
      const itemId = pendingItem().id;
      await update(change);
      emailChannel.onConfigChanged('AR');
      expect(sent).toEqual([]);
      expect(outbound()[0]).toMatchObject({ status: 'cancelled' });
      expect(harness.domain.inbox.get('AR', itemId).state).toBe('cancelled');
    });
  });

  describe('contacts by an AI member', () => {
    it('refuses a request that no one made for the person', async () => {
      const { emailChannel } = await setup();
      expect(() =>
        emailChannel.setContactByMember('AR', 'dev-1', { handle: 'acme', wants: true, requestedBy: 'dev-1' }),
      ).toThrowError(expect.objectContaining({ code: 'email_contact_refused' }));
    });

    it('records an opt-out the person asked for without a source', async () => {
      const { emailChannel, harness } = await setup();
      expect(
        emailChannel.setContactByMember('AR', 'dev-1', { handle: 'acme', wants: false, requestedBy: 'acme' }),
      ).toEqual({ handle: 'acme', wants: false });
      expect(emailChannel.contactsForMember('AR').find((contact) => contact.handle === 'acme')?.wants).toBe(
        false,
      );
      const rows = harness.repos.db
        .prepare(
          "SELECT source FROM email_contacts WHERE handle = 'acme' UNION ALL SELECT source FROM email_contact_events WHERE handle = 'acme' AND wants = 0",
        )
        .all();
      expect(rows).toEqual([{ source: 'member' }, { source: 'member' }]);
    });

    it('lists contacts with an address flag only', async () => {
      const { emailChannel } = await setup();
      const contacts = emailChannel.contactsForMember('AR');
      expect(contacts.find((contact) => contact.handle === 'acme')).toEqual({
        handle: 'acme',
        displayName: 'Acme',
        wants: true,
        hasAddress: true,
      });
    });
  });
});
