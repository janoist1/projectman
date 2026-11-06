import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertPayload, InboxItem } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { systemNotices } from './helpers/notices';

/**
 * Every alert goes through `InboxService.raiseAlert` (PM-1250): the route rule picks the recipient, so a machine
 * alert is a todo of the integrator, a pm alert a signal, information a notice, and a retired kind is refused.
 */

const HOUR_MS = 3_600_000;
const disk: AlertPayload = { alert: 'disk_low', freeBytes: 1, thresholdBytes: 2 };
const kept = (taskKey: string): AlertPayload => ({ alert: 'worktree_kept', taskKey, path: '/w', changes: 3 });

describe('raiseAlert', () => {
  let h: DomainHarness;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-10-01T12:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
  });
  afterEach(() => h.cleanup());

  const todos = (): InboxItem[] =>
    h.domain.inbox
      .list('AR', { kind: 'question' })
      .filter((item) => (item.payload.systemAlert as { alert?: string } | undefined) !== undefined);
  const raise = (payload: AlertPayload, extra: { taskKey?: string; assignees?: string[] } = {}) =>
    h.domain.inbox.raiseAlert({ projectKey: 'AR', title: 'An alert', payload, ...extra });

  const setPmOnLeave = (onLeave: boolean) =>
    h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const pm = config.team.members.find((member) => member.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = onLeave;
      return 'Set the project manager on or off leave';
    });

  describe('machine alerts', () => {
    it('open one todo of the integrator for each kind and card, and no alert item of the owners', () => {
      expect(raise(disk)).not.toBeNull();
      expect(raise(disk)).toBeNull();
      raise(kept('AR-1'), { taskKey: 'AR-1' });
      raise(kept('AR-1'), { taskKey: 'AR-1' });
      raise(kept('AR-2'), { taskKey: 'AR-2' });
      expect(todos().map((item) => (item.payload.systemAlert as { alert: string; key: string }).key)).toEqual(
        expect.arrayContaining(['', 'AR-1', 'AR-2']),
      );
      expect(todos()).toHaveLength(3);
      expect(h.domain.inbox.list('AR', { kind: 'alert' })).toEqual([]);
    });

    it('raise again once the earlier todo was settled', () => {
      raise(disk);
      expect(h.domain.inbox.settleAlert('AR', 'disk_low')).toBe(1);
      expect(raise(disk)).not.toBeNull();
      expect(todos().filter((item) => item.state === 'open')).toHaveLength(1);
    });
  });

  describe('settling an alert of an older version', () => {
    const legacy = (taskKey: string, sessionId: string | null) =>
      h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'alert',
        assignees: ['owner'],
        source: 'system',
        taskKey,
        sessionId,
        title: 'Old alert',
        payload: {
          alert: 'session_input',
          workItem: { type: 'task', taskKey },
          since: 'x',
          minutes: 5,
          activity: null,
        },
        options: [],
      });

    it('close only the legacy items of the session or the card it was asked for', () => {
      const mine = legacy('AR-1', 'ses_1');
      const other = legacy('AR-2', 'ses_2');
      expect(h.domain.inbox.settleAlert('AR', 'session_input', { taskKey: 'AR-1', sessionId: 'ses_1' })).toBe(
        1,
      );
      expect(h.domain.inbox.get('AR', mine.id)?.state).not.toBe('open');
      expect(h.domain.inbox.get('AR', other.id)?.state).toBe('open');
    });
  });

  describe('pm alerts', () => {
    it.each([
      { alert: 'relation_check', taskKey: 'AR-1', relations: [{ kind: 'prerequisite', key: 'AR-2' }] },
      {
        alert: 'work_outage',
        outage: { kind: 'provider_down', provider: 'claude' },
        members: ['dev-1'],
        tasks: ['AR-1'],
        checkedAt: '2026-10-01T12:00:00.000Z',
      },
    ] as unknown as AlertPayload[])(
      'hand $alert to the signal port of the project manager only',
      async (payload) => {
        await setPmOnLeave(false);
        const signals = { raise: vi.fn() };
        h.domain.inbox.registerAlertPmSignals(signals);
        expect(raise(payload)).toBeNull();
        expect(signals.raise).toHaveBeenCalledWith('AR', payload);
        expect(h.domain.inbox.list('AR')).toEqual([]);
      },
    );

    it('tell the owners in a notice when there is no project manager', async () => {
      await setPmOnLeave(true);
      const signals = { raise: vi.fn() };
      h.domain.inbox.registerAlertPmSignals(signals);
      raise({ alert: 'relation_check', taskKey: 'AR-1', relations: [{ kind: 'prerequisite', key: 'AR-2' }] });
      await vi.waitFor(() => expect(systemNotices(h, 'relation_check')).toHaveLength(1));
      expect(signals.raise).not.toHaveBeenCalled();
    });
  });

  describe('notices', () => {
    it.each([
      {
        alert: 'session_tokens',
        countedTokens: 2,
        limitTokens: 1,
        workItem: { type: 'general' },
        sessionStartedAt: 'x',
      },
      { alert: 'provider_rate_limited', provider: 'nanogpt', until: null, weeklyPercent: null, message: 'm' },
      { alert: 'refinement', taskKey: 'AR-1', label: null, reason: 'done' },
      { alert: 'feedback_forwarded', markId: 'm', author: 'a', excerpt: 'e', reason: 'r' },
      { alert: 'host_request_answered', requestId: 'r', title: 't', outcome: 'answered', answer: 'a' },
      {
        alert: 'email_parked',
        emailId: 'e',
        reason: 'unknown_sender',
        fromAddress: 'a@b.c',
        subject: 's',
        excerpt: 'x',
        attachmentNames: [],
      },
    ] as unknown as AlertPayload[])(
      'tell the owners of $alert in a message, with no inbox item',
      async (payload) => {
        expect(raise(payload)).toBeNull();
        await vi.waitFor(() => expect(systemNotices(h)).toHaveLength(1));
        expect(systemNotices(h)[0]).toMatchObject({
          from: 'system',
          to: ['owner'],
          origin: { kind: 'system_notice' },
        });
        expect(h.domain.inbox.list('AR')).toEqual([]);
      },
    );

    it('tell the admins too of a parked e-mail, and who prioritises of a finished refinement', () => {
      const sink = { send: vi.fn(async () => undefined) };
      h.domain.inbox.registerAlertNotices(sink);
      const parked = {
        alert: 'email_parked',
        emailId: 'e',
        reason: 'unknown_sender',
        fromAddress: 'a@b.c',
        subject: 's',
        excerpt: 'x',
        attachmentNames: [],
      } as unknown as AlertPayload;
      return h.domain.projects
        .update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
          config.team.members.push({
            kind: 'human',
            handle: 'ada',
            displayName: 'Ada',
            email: 'ada@example.test',
            access: 'admin',
            roles: [],
          });
          return 'Add an admin';
        })
        .then(() => {
          raise(parked);
          expect(sink.send).toHaveBeenLastCalledWith(
            expect.objectContaining({ recipients: expect.arrayContaining(['owner', 'ada']) }),
          );
          raise(
            { alert: 'refinement', taskKey: 'AR-1', label: null, reason: 'done' },
            { assignees: ['ada'] },
          );
          expect(sink.send).toHaveBeenLastCalledWith(expect.objectContaining({ recipients: ['ada'] }));
        });
    });

    it('leave out the owner who caused the alert', () => {
      const sink = { send: vi.fn(async () => undefined) };
      h.domain.inbox.registerAlertNotices(sink);
      raise({ alert: 'refinement', taskKey: 'AR-1', label: null, reason: 'done' });
      expect(sink.send).toHaveBeenCalledWith(expect.objectContaining({ recipients: ['owner'] }));
      sink.send.mockClear();
      h.domain.inbox.raiseAlert({
        projectKey: 'AR',
        title: 't',
        payload: { alert: 'refinement', taskKey: 'AR-1', label: null, reason: 'done' },
        exceptRecipient: 'owner',
      });
      expect(sink.send).not.toHaveBeenCalled();
    });
  });

  describe('alerts that stay items of people', () => {
    it('keep a refinement manual step an approval of the owners', () => {
      const item = raise({ alert: 'refinement', taskKey: 'AR-1', label: null, reason: 'manual_step' });
      expect(item).toMatchObject({ kind: 'alert', assignees: ['owner'], state: 'open' });
    });

    it('give a merge_blocked alert to the human merger', () => {
      const item = raise(
        {
          alert: 'merge_blocked',
          taskKey: 'AR-1',
          mergeId: 'm',
          reason: 'merge_error',
          message: 'x',
        } as AlertPayload,
        { taskKey: 'AR-1', assignees: ['owner'] },
      );
      expect(item).toMatchObject({ kind: 'alert', assignees: ['owner'] });
    });
  });

  describe('retired kinds', () => {
    it.each([
      { alert: 'release_failed' },
      { alert: 'message_burst' },
      { alert: 'parts_left' },
      { alert: 'work_stalled' },
      { alert: 'refinement', taskKey: 'AR-1', label: null, reason: 'stalled' },
    ] as unknown as AlertPayload[])('cannot be created: $alert $reason', (payload) => {
      expect(() => raise(payload)).toThrow(/alert_retired/);
      expect(h.domain.inbox.list('AR')).toEqual([]);
    });
  });

  describe('the daily digest of what waits', () => {
    const digests = async () => systemNotices(h, 'waiting_digest');

    it('says nothing while nothing waits, or what waits is younger than a day', async () => {
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(false);
      raise(disk);
      now = new Date(now.getTime() + 24 * HOUR_MS);
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(false);
      expect(await digests()).toEqual([]);
    });

    it('tells the owners once a day when a todo has waited more than a day', async () => {
      raise(disk);
      now = new Date(now.getTime() + 24 * HOUR_MS + 1);
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(true);
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(false);
      now = new Date(now.getTime() + 23 * HOUR_MS);
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(false);
      expect(await digests()).toHaveLength(1);
      expect((await digests())[0]).toMatchObject({
        to: ['owner'],
        origin: { params: { todos: 1, questions: 0 } },
      });

      now = new Date(now.getTime() + HOUR_MS);
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(true);
      expect(await digests()).toHaveLength(2);
    });

    it('counts a question that waits in screening, by the time it was asked', async () => {
      h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        taskKey: null,
        title: 'Which font?',
        payload: { question: 'Which font?' },
        options: [],
        state: 'screening',
      });
      now = new Date(now.getTime() + 25 * HOUR_MS);
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(true);
      expect((await digests())[0]).toMatchObject({ origin: { params: { todos: 0, questions: 1 } } });
    });

    it('stops once what waited was settled', async () => {
      raise(disk);
      now = new Date(now.getTime() + 25 * HOUR_MS);
      h.domain.inbox.settleAlert('AR', 'disk_low');
      expect(await h.domain.inbox.sendWaitingDigest('AR')).toBe(false);
    });
  });
});
