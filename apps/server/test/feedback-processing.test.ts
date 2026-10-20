import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateFeedbackMarkRequest, FeedbackForwardedAlert, Session } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { humanActor } from '../src/kernel';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

const toolError = (promise: Promise<unknown>) => rejection(promise, TeamToolError);

/**
 * The project manager's side of the feedback marks (PM-512): the wake-up message, the team tools over the
 * real domain, the forwarding to the owners and what a remote engine gets of the screenshot.
 */
describe('feedback processing', () => {
  let h: DomainHarness;
  let pm: ToolContext;
  const cleo = humanActor('cleo');

  const png = () =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: '#cc3333' } })
      .png()
      .toBuffer();
  const request = async (
    opts: { screenshot?: boolean; body?: string } = {},
  ): Promise<CreateFeedbackMarkRequest> => ({
    pageUrl: 'https://shop.example.com/cart?step=2#top',
    pageTitle: 'Cart',
    kind: 'point',
    body: opts.body ?? 'The total is wrong',
    anchor: {
      kind: 'point',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: { x: 10, y: 20 },
      rect: null,
    },
    environment: {
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      devicePixelRatio: 2,
      userAgent: 'Mozilla/5.0 (test)',
      browser: 'Chrome 140',
      os: 'macOS',
      language: 'hu-HU',
    },
    screenshot: opts.screenshot
      ? { mediaType: 'image/png', dataBase64: (await png()).toString('base64') }
      : null,
  });
  const mark = async (opts: Parameters<typeof request>[0] = {}) =>
    (
      await h.domain.feedback.createMark({
        projectKey: 'AR',
        author: 'cleo',
        surfaceId: 'shop',
        request: await request(opts),
      })
    ).id;
  const view = (markId: string) => h.domain.feedback.detail('AR', markId, OWNER_ACTOR);
  const wakeUps = () =>
    h.repos.messages.list('AR', { member: 'pm' }).filter((message) => message.from === 'system');
  const alerts = () => h.repos.inbox.list('AR', { kind: 'alert' });
  /** The project manager's general session (a member has one), on this machine's engine. */
  const session = (id: string): Session => {
    const now = new Date().toISOString();
    const s: Session = {
      id,
      projectKey: 'AR',
      member: 'pm',
      workItem: { type: 'general' },
      claudeSessionId: '',
      cwd: h.workspace,
      branch: null,
      transcriptPath: null,
      state: 'working',
      activity: null,
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
    };
    h.repos.sessions.insert(s);
    return s;
  };

  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const manager = config.team.members.find((member) => member.handle === 'pm');
        if (manager?.kind === 'ai') manager.onLeave = false;
        config.team.members.push({
          kind: 'human',
          handle: 'cleo',
          displayName: 'Cleo',
          email: 'cleo@example.test',
          access: 'client',
          roles: [],
        });
        config.project.feedback = {
          surfaces: [{ id: 'shop', name: 'Shop', origin: 'https://shop.example.com' }],
          blockedMarkers: [],
        };
      },
    });
    // The wake-up message must stay undelivered until a test takes it: no session of the manager runs.
    pm = { sessionId: session('ses_pmlocal001').id, projectKey: 'AR', member: 'pm', taskKey: null };
  });
  afterEach(() => h.cleanup());

  describe('waking the processor', () => {
    it('sends one action message for several new marks and marks them as taken up', async () => {
      const first = await mark();
      const second = await mark({ body: 'The button is missing' });
      const messages = wakeUps();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'action', to: ['pm'], taskKey: null });
      expect(messages[0]!.body).toContain('get_feedback');
      for (const id of [first, second]) {
        expect(h.repos.feedback.getMark(id)).toMatchObject({
          handedTo: 'pm',
          handedMessageId: messages[0]!.id,
        });
        expect((await view(id)).working).toBe(true);
      }
    });

    it('wakes again for a mark that arrives after the message was taken', async () => {
      const first = await mark();
      const taken = wakeUps()[0]!;
      h.domain.messages.markRecipientDelivered(taken.id, 'pm');
      const second = await mark({ body: 'Another one' });
      expect(wakeUps()).toHaveLength(2);
      expect(h.repos.feedback.getMark(second)!.handedMessageId).not.toBe(taken.id);
      expect(h.repos.feedback.getMark(first)!.handedMessageId).toBe(taken.id);
    });

    it('stops showing "the manager is working on it" when the manager’s turn ends', async () => {
      const id = await mark();
      const general = h.repos.sessions.get(pm.sessionId)!;
      // The message is still on its way: the mark stays taken.
      await h.domain.ctx.events.emit('session_idle', general);
      expect((await view(id)).working).toBe(true);

      h.domain.messages.markRecipientDelivered(wakeUps()[0]!.id, 'pm');
      await h.domain.ctx.events.emit('session_idle', general);
      expect((await view(id)).working).toBe(false);
      expect(h.repos.feedback.getMark(id)).toMatchObject({ handedTo: null, handedMessageId: null });
    });

    it('wakes the processor again when the marker answers on a mark it had handled', async () => {
      const id = await mark();
      h.domain.messages.markRecipientDelivered(wakeUps()[0]!.id, 'pm');
      await h.domain.teamTools.replyFeedback(pm, { markId: id, body: 'Which cart?' });
      expect((await view(id)).status).toBe('handled');
      await h.domain.feedback.comment('AR', id, cleo, 'The one on the shop page.');
      expect((await view(id)).status).toBe('new');
      expect(wakeUps()).toHaveLength(2);
      expect(h.repos.feedback.getMark(id)!.handedTo).toBe('pm');
    });

    it('sends nothing when the manager is on leave', async () => {
      await h.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: { name: 'O', email: 'o@example.com' } },
        (draft) => {
          const manager = draft.team.members.find((member) => member.handle === 'pm');
          if (manager?.kind === 'ai') manager.onLeave = true;
          return 'Send the manager on leave';
        },
      );
      await mark();
      expect(wakeUps()).toHaveLength(0);
    });

    it('does not wake the processor for a comment on a mark that waits for the owner', async () => {
      const id = await mark();
      await h.domain.teamTools.forwardFeedback(pm, {
        markId: id,
        reason: 'Needs a price decision',
        reply: 'We ask.',
      });
      expect(wakeUps()).toHaveLength(1);
      await h.domain.feedback.comment('AR', id, cleo, 'Any news?');
      // A mark that waits for the owner is not the processor’s to decide: no new wake-up.
      expect(wakeUps()).toHaveLength(1);
    });
  });

  describe('the tools', () => {
    it('refuses everyone who does not process feedback, the Operator included', async () => {
      const id = await mark();
      for (const member of ['dev-1', 'operator']) {
        const caller: ToolContext = { sessionId: 'ses_x', projectKey: 'AR', member, taskKey: null };
        const err = await toolError(
          h.domain.teamTools.getFeedbackList(caller, { status: 'todo', limit: 30 }),
        );
        expect(err.message).toContain('feedback_processor_only');
        await toolError(h.domain.teamTools.closeFeedback(caller, { markId: id }));
      }
      expect((await view(id)).status).toBe('new');
    });

    it('lists the marks to decide, the oldest first, with the marker’s access', async () => {
      const first = await mark();
      // The list is ordered by `updated_at`, then by the random id: two marks made in the same
      // millisecond (a warm process can) would come in any order.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await mark({ body: 'Second' });
      const list = await h.domain.teamTools.getFeedbackList(pm, { status: 'todo', limit: 30 });
      expect(list.total).toBe(2);
      expect(list.marks.map((m) => m.id)).toEqual([first, second]);
      expect(list.authorAccess).toMatchObject({ cleo: 'client' });
      await h.domain.teamTools.closeFeedback(pm, { markId: first, reply: 'Thanks' });
      expect(
        (await h.domain.teamTools.getFeedbackList(pm, { status: 'todo', limit: 30 })).marks,
      ).toHaveLength(1);
      expect((await h.domain.teamTools.getFeedbackList(pm, { status: 'all', limit: 30 })).total).toBe(2);
    });

    it('opens a card from the mark with its screenshot as the card’s attachment', async () => {
      const id = await mark({ screenshot: true });
      const result = await h.domain.teamTools.createTaskFromFeedback(pm, {
        markId: id,
        title: 'Fix the cart total',
        description: 'The total ignores the discount.',
        reply: 'A card is open.',
      });
      expect(result).toMatchObject({ markId: id, status: 'handled', task: { title: 'Fix the cart total' } });
      const attachments = h.repos.attachments.listReady('AR', result.task!.key);
      expect(attachments.map((a) => a.fileName)).toEqual([`jeloles-${id}.png`]);
      expect(attachments[0]!.uploadedBy).toMatchObject({ kind: 'ai', handle: 'pm' });
      expect(h.repos.feedback.getMark(id)).toMatchObject({ status: 'handled', taskKey: result.task!.key });
      // A mark gets one card.
      const again = await toolError(
        h.domain.teamTools.createTaskFromFeedback(pm, { markId: id, title: 'Again', description: 'Again' }),
      );
      expect(again.message).toContain('feedback_task_exists');
    });

    it('links a mark to an existing card and closes another with a reply', async () => {
      const card = await h.domain.tasks.create('AR', { title: 'Cart' }, OWNER_ACTOR);
      const linked = await mark();
      const closed = await mark({ body: 'Praise' });
      expect(await h.domain.teamTools.linkFeedback(pm, { markId: linked, taskKey: card.key })).toMatchObject({
        status: 'handled',
      });
      expect(
        await h.domain.teamTools.closeFeedback(pm, { markId: closed, reply: 'Thank you' }),
      ).toMatchObject({
        status: 'closed',
      });
      const thread = (await h.domain.feedback.detail('AR', closed, OWNER_ACTOR)).thread;
      expect(thread.map((entry) => entry.type)).toContain('comment');
    });

    it('says what is wrong with an unknown mark or card', async () => {
      const missing = await toolError(
        h.domain.teamTools.getFeedbackMark(pm, { markId: 'fbm_doesnotexist01' }),
      );
      expect(missing.code).toBe('not_found');
      const id = await mark();
      const noCard = await toolError(h.domain.teamTools.linkFeedback(pm, { markId: id, taskKey: 'AR-99' }));
      expect(noCard.code).toBe('not_found');
    });
  });

  describe('forwarding to the owners', () => {
    it('raises an alert, shows the mark as waiting and does not let the AI decide it again', async () => {
      const id = await mark({ body: 'Can the price be lower?' });
      const card = await h.domain.tasks.create('AR', { title: 'Prices' }, OWNER_ACTOR);
      const result = await h.domain.teamTools.forwardFeedback(pm, {
        markId: id,
        reason: 'A price decision is the owner’s',
        reply: 'We ask the owner.',
      });
      expect(result).toMatchObject({ markId: id, status: 'waiting_owner' });
      const [alert] = alerts();
      expect(alert).toMatchObject({ state: 'open', assignees: ['owner'], source: 'system' });
      expect(alert!.payload as unknown as FeedbackForwardedAlert).toMatchObject({
        alert: 'feedback_forwarded',
        markId: id,
        author: 'cleo',
        reason: 'A price decision is the owner’s',
      });
      expect(h.repos.feedback.getMark(id)).toMatchObject({ status: 'waiting_owner', inboxItemId: alert!.id });

      for (const step of [
        () => h.domain.teamTools.closeFeedback(pm, { markId: id }),
        () => h.domain.teamTools.linkFeedback(pm, { markId: id, taskKey: card.key }),
        () => h.domain.teamTools.forwardFeedback(pm, { markId: id, reason: 'again', reply: 'again' }),
      ]) {
        const err = await toolError(step());
        expect(err.message).toContain('feedback_waiting_owner');
      }
      expect(alerts()).toHaveLength(1);
    });

    it('settles the alert with the rule "feedback_handled" when a person answers', async () => {
      const id = await mark();
      await h.domain.teamTools.forwardFeedback(pm, { markId: id, reason: 'Owner’s call', reply: 'Asked.' });
      const [alert] = alerts();
      await h.domain.feedback.comment('AR', id, OWNER_ACTOR, 'Yes, go ahead.');
      const settled = h.repos.inbox.get(alert!.id)!;
      expect(settled).toMatchObject({
        state: 'resolved',
        resolution: { by: 'system', rule: 'feedback_handled' },
      });
      expect(h.repos.feedback.getMark(id)).toMatchObject({ inboxItemId: null });
      expect((await view(id)).status).not.toBe('waiting_owner');
    });
  });

  describe('the screenshot', () => {
    it('gives a session on this machine the path of the stored file', async () => {
      const id = await mark({ screenshot: true });
      const opened = await h.domain.teamTools.getFeedbackMark(pm, { markId: id });
      expect(opened.authorAccess).toBe('client');
      expect(opened.screenshot.kind).toBe('local');
      if (opened.screenshot.kind === 'local') expect(existsSync(opened.screenshot.path)).toBe(true);
    });

    it('does not give a session on a remote engine a path of this machine', async () => {
      const id = await mark({ screenshot: true });
      h.repos.sessions.update(pm.sessionId, { engineId: 'eng_aaaaaaaaaaaa' });
      const opened = await h.domain.teamTools.getFeedbackMark(pm, { markId: id });
      expect(opened.screenshot).toEqual({ kind: 'remote' });
      expect(opened.mark.screenshot).not.toBeNull();
    });

    it('says there is none for a mark without a screenshot', async () => {
      const id = await mark();
      expect((await h.domain.teamTools.getFeedbackMark(pm, { markId: id })).screenshot).toEqual({
        kind: 'none',
      });
    });
  });
});
