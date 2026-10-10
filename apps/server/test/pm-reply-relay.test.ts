import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
let now = new Date('2026-10-10T20:00:00Z');
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup(member = 'pm', from = 'owner') {
  now = new Date('2026-10-10T20:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    adjust: (c) => {
      const pm = c.team.members.find((m) => m.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = false;
    },
  });
  const task = await h.domain.tasks.create('AR', { title: 'Manager question' }, OWNER_ACTOR);
  const { session } = await h.domain.sessions.ensureSession('AR', member, { type: 'general' });
  const message = h.domain.messages.record({
    projectKey: 'AR',
    from,
    to: [member],
    taskKey: task.key,
    body: 'What is next?',
    actor: from === 'system' ? { kind: 'system', handle: null } : OWNER_ACTOR,
    delivered: true,
  });
  h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/reply.jsonl' });
  h.runnerModule.transcripts.set('/fake/reply.jsonl', [
    { id: 'old', kind: 'assistant_text', ts: '2026-10-10T19:59:00Z', text: 'Old reply' },
    { id: 'final', kind: 'assistant_text', ts: '2026-10-10T20:00:01Z', text: 'Final reply' },
  ]);
  now = new Date('2026-10-10T20:00:02Z');
  return { session: h.domain.sessions.get('AR', session.id), message, task };
}
const relays = () => h.domain.messages.list('AR').filter((m) => m.relayed);
const finish = (session: Session, event: 'session_idle' | 'session_ended' = 'session_idle') =>
  h.domain.ctx.events.emit(event, session);

describe('project manager reply relay', () => {
  it.each(['session_idle', 'session_ended'] as const)(
    'relays the final reply on %s with receipts and a card event',
    async (event) => {
      const { session, message, task } = await setup();
      await finish(session, event);
      expect(relays()).toHaveLength(1);
      expect(relays()[0]).toMatchObject({
        from: 'pm',
        to: ['owner'],
        taskKey: task.key,
        body: 'Final reply',
        kind: 'info',
        relayed: { sessionId: session.id, inReplyTo: message.id },
        receipts: [{ handle: 'owner', kind: 'human', deliveredAt: now.toISOString(), readAt: null }],
      });
      expect(h.domain.timeline.latest('AR', task.key, 'team_message')?.data).toMatchObject({
        messageId: relays()[0]!.id,
      });
      expect(h.repos.messages.countUnread('AR', 'owner')).toBe(1);
      expect(h.runner.started).toHaveLength(1);
    },
  );
  it('does not relay after an explicit reply', async () => {
    const { session } = await setup();
    await h.domain.messaging.send('AR', 'pm', { to: ['owner'], text: 'Already answered' }, { kind: 'info' });
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it('serializes repeated idle and ended events without duplicate replies', async () => {
    const { session } = await setup();
    await Promise.all([finish(session), finish(session), finish(session, 'session_ended')]);
    expect(relays()).toHaveLength(1);
  });
  it('ignores messages outside the two-hour window', async () => {
    const { session } = await setup();
    now = new Date('2026-10-10T22:00:01Z');
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it('ignores undelivered messages', async () => {
    const { session, message } = await setup();
    h.repos.messages.updateReceipts(
      message.id,
      [{ handle: 'pm', kind: 'ai', deliveredAt: null, readAt: null }],
      null,
    );
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it('ignores task session events', async () => {
    const { session, task } = await setup();
    await finish({ ...session, workItem: { type: 'task', taskKey: task.key } });
    expect(relays()).toHaveLength(0);
  });
  it('ignores non-manager sessions', async () => {
    const { session } = await setup('dev-1');
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it.each(['system', 'dev-1'])('ignores messages from %s', async (from) => {
    const { session } = await setup('pm', from);
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it.each(['', '   '])('ignores empty final text (%j)', async (text) => {
    const { session } = await setup();
    h.runnerModule.transcripts.set('/fake/reply.jsonl', [
      { id: 'empty', kind: 'assistant_text', ts: now.toISOString(), text },
    ]);
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it('ignores text before or exactly at delivery', async () => {
    const { session } = await setup();
    h.runnerModule.transcripts.set('/fake/reply.jsonl', [
      { id: 'old', kind: 'assistant_text', ts: '2026-10-10T20:00:00Z', text: 'Previous reply' },
    ]);
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it('rechecks explicit replies sent during transcript reading', async () => {
    const { session } = await setup();
    const detail = h.domain.sessions.detail.bind(h.domain.sessions);
    vi.spyOn(h.domain.sessions, 'detail').mockImplementation(async (project, id) => {
      await h.domain.messaging.send('AR', 'pm', { to: ['owner'], text: 'Explicit reply' }, { kind: 'info' });
      return detail(project, id);
    });
    await finish(session);
    expect(relays()).toHaveLength(0);
  });
  it('keeps the end of long text and answers only the latest candidate per person', async () => {
    const { session } = await setup();
    const newer = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['pm'],
      taskKey: null,
      body: 'Latest question',
      actor: OWNER_ACTOR,
      delivered: true,
    });
    h.runnerModule.transcripts.set('/fake/reply.jsonl', [
      { id: 'long', kind: 'assistant_text', ts: '2026-10-10T20:00:03Z', text: 'x'.repeat(21000) + 'END' },
    ]);
    await finish(session);
    expect(relays()).toHaveLength(1);
    expect(relays()[0]!.relayed?.inReplyTo).toBe(newer.id);
    expect(relays()[0]!.body).toHaveLength(20000);
    expect(relays()[0]!.body.endsWith('END')).toBe(true);
  });
});
