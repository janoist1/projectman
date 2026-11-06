import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes, TaskDetail } from '@projectman/shared';
import type { ServerEvent, Session, TeamMessage } from '@projectman/shared';
import { canSeeProjectEvent } from '../src/core/projects';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import { createDomainHarness, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let now = new Date('2026-10-10T20:00:00Z');
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup() {
  now = new Date('2026-10-10T20:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    adjust: (c) => {
      const pm = c.team.members.find((m) => m.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = false;
    },
  });
  const task = await h.domain.tasks.create('AR', { title: 'Question' }, OWNER_ACTOR);
  const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
  const message = h.domain.messages.record({
    projectKey: 'AR',
    from: 'owner',
    to: ['pm'],
    taskKey: task.key,
    body: 'What is next?',
    actor: OWNER_ACTOR,
    delivered: false,
  });
  return { session, message, task };
}
const turnsOf = (id: string) => h.repos.messageTurns.ofMessages([id]).get(id) ?? [];
const idle = (session: Session, at: string): Session => ({ ...session, state: 'idle', stateSince: at });
const published = (): ServerEvent[] => {
  const events: ServerEvent[] = [];
  h.domain.bus.subscribe((event) => events.push(event));
  return events;
};

describe('message turns', () => {
  it('opens one turn per message and recipient, only when a session typed the message', async () => {
    const { session, message } = await setup();
    h.domain.messages.markRecipientDelivered(message.id, 'pm');
    expect(turnsOf(message.id)).toEqual([]);
    h.domain.messages.markRecipientDelivered(message.id, 'pm', session.id);
    h.domain.messages.markRecipientDelivered(message.id, 'pm', session.id);
    expect(turnsOf(message.id)).toMatchObject([{ handle: 'pm', sessionId: session.id, endedAt: null }]);
  });

  it('closes the turns typed before the session went idle, once', async () => {
    const { session, message } = await setup();
    h.domain.messages.markRecipientDelivered(message.id, 'pm', session.id);
    const typedAt = turnsOf(message.id)[0]!.typedAt;
    // A late event from before the message was typed closes nothing.
    await h.domain.ctx.events.emit(
      'session_idle',
      idle(session, new Date(Date.parse(typedAt) - 1000).toISOString()),
    );
    expect(turnsOf(message.id)[0]!.endedAt).toBeNull();
    const first = later(5);
    await h.domain.ctx.events.emit('session_idle', idle(session, first));
    expect(turnsOf(message.id)[0]).toMatchObject({ endedAt: first, endState: 'idle' });
    // A repeated, later event leaves the closed turn as it was.
    await h.domain.ctx.events.emit('session_idle', idle(session, later(60)));
    await h.domain.ctx.events.emit('session_ended', { ...session, state: 'exited', endedAt: later(90) });
    expect(turnsOf(message.id)[0]).toMatchObject({ endedAt: first, endState: 'idle' });
  });

  it('closes an open turn when the session fails', async () => {
    const { session, message } = await setup();
    h.domain.messages.markRecipientDelivered(message.id, 'pm', session.id);
    await h.domain.ctx.events.emit('session_ended', { ...session, state: 'failed', endedAt: later(5) });
    expect(turnsOf(message.id)[0]).toMatchObject({ endState: 'failed' });
  });
});

describe('message processing', () => {
  it('follows the turn: delivered, ended, then replied by a message to the sender', async () => {
    const { session, message, task } = await setup();
    h.domain.messages.markRecipientDelivered(message.id, 'pm', session.id);
    const stateOf = () =>
      h.domain.messageProcessing.ofMessages([h.repos.messages.get(message.id)!]).get(message.id);
    expect(stateOf()).toMatchObject([{ handle: 'pm', state: 'delivered' }]);
    now = new Date(now.getTime() + 5000);
    await h.domain.ctx.events.emit('session_idle', idle(session, later(1)));
    expect(stateOf()).toMatchObject([{ state: 'turn_ended' }]);
    now = new Date(now.getTime() + 5000);
    await h.domain.messaging.send(
      'AR',
      'pm',
      { to: ['owner'], taskKey: task.key, text: 'Next is the review' },
      { kind: 'info' },
    );
    expect(stateOf()).toMatchObject([{ state: 'replied' }]);
  });

  it('tells which recipient of a message was handled and which was not', async () => {
    const { session } = await setup();
    const both = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['pm', 'dev-1'],
      taskKey: null,
      body: 'Both of you',
      actor: OWNER_ACTOR,
      delivered: false,
    });
    h.domain.messages.markRecipientDelivered(both.id, 'pm', session.id);
    const items = h.domain.messageProcessing.ofMessages([h.repos.messages.get(both.id)!]).get(both.id)!;
    expect(items.map((item) => [item.handle, item.state === 'delivered'])).toEqual([
      ['pm', true],
      ['dev-1', false],
    ]);
  });

  it('has no items for a comment that mentions nobody', async () => {
    await setup();
    const note = await h.domain.tasks.addNote('AR', 'AR-1', 'no mention', OWNER_ACTOR, null);
    expect(h.domain.messageProcessing.ofComments('AR', 'AR-1', [note]).get(note.id)).toEqual([]);
  });
});

describe('the manager’s reply to a comment', () => {
  const comment = async () => {
    const { session, task } = await setup();
    const note = await h.domain.tasks.addNote('AR', task.key, 'What is next?', OWNER_ACTOR, null);
    const message = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['pm'],
      taskKey: task.key,
      body: 'What is next?',
      actor: OWNER_ACTOR,
      delivered: true,
      origin: { kind: 'note', eventId: note.id },
    });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/fake/reply.jsonl' });
    h.runnerModule.transcripts.set('/fake/reply.jsonl', [
      { id: 'final', kind: 'assistant_text', ts: '2026-10-10T20:00:01Z', text: 'Final reply' },
    ]);
    now = new Date('2026-10-10T20:00:02Z');
    return { session: h.domain.sessions.get('AR', session.id), note, message, task };
  };
  const notesOf = (
    taskKey: string,
  ): Array<{ data: Record<string, unknown>; actor: { handle: string | null } }> =>
    h.repos.timeline.notesOfCard('AR', taskKey);

  it('lands in the comment’s thread, marked as relayed', async () => {
    const { session, note, task } = await comment();
    await h.domain.ctx.events.emit('session_idle', session);
    await flush();
    const reply = notesOf(task.key).find((candidate) => candidate.actor.handle === 'pm');
    expect(reply?.data).toMatchObject({ text: 'Final reply', replyTo: note.id, relayedFrom: session.id });
    expect(h.domain.messages.list('AR').filter((m: TeamMessage) => m.relayed)).toEqual([]);
  });

  it('is not added when the manager already answered in the thread', async () => {
    const { session, note, task } = await comment();
    await h.domain.tasks.addNote('AR', task.key, 'Already answered', { kind: 'ai', handle: 'pm' }, null, {
      replyTo: note.id,
    });
    await h.domain.ctx.events.emit('session_idle', session);
    await flush();
    expect(notesOf(task.key).filter((candidate) => candidate.actor.handle === 'pm')).toHaveLength(1);
  });
});

describe('who is told that processing changed', () => {
  const event: ServerEvent = {
    type: 'message_processing_changed',
    projectKey: 'AR',
    messageId: 'm1',
    taskKey: null,
    from: 'robin',
  };
  const viewer = (handle: string, access: 'owner' | 'developer') => ({ handle, access });

  it('is the sender and an owner, nobody else', () => {
    expect(canSeeProjectEvent(viewer('robin', 'developer'), event)).toBe(true);
    expect(canSeeProjectEvent(viewer('boss', 'owner'), event)).toBe(true);
    expect(canSeeProjectEvent(viewer('other', 'developer'), event)).toBe(false);
  });

  it('is published when a turn opens and when it closes', async () => {
    const { session, message } = await setup();
    const events = published();
    h.domain.messages.markRecipientDelivered(message.id, 'pm', session.id);
    await h.domain.ctx.events.emit('session_idle', idle(session, later(5)));
    const changes = events.filter((candidate) => candidate.type === 'message_processing_changed');
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes[0]).toMatchObject({ messageId: message.id, from: 'owner' });
  });
});

describe('a comment that mentions an AI member (boundary)', () => {
  it('shows delivered, working, ended and replied as the session goes', async () => {
    const app = await createAppHarness();
    try {
      const owner = await setupOwner(app.app);
      await createProject(app, owner);
      await addHumanAndLogin(app.app, { handle: 'robin', name: 'Robin', roles: ['developer'] });
      const { domain } = app.app.projectman;
      await domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
      const events: ServerEvent[] = [];
      domain.bus.subscribe((event) => events.push(event));
      const response = await app.app.inject({
        method: 'POST',
        url: routes.taskComments('AR', 'AR-1'),
        headers: { cookie: owner },
        payload: { text: '@dev-1 @robin please look' },
      });
      expect(response.statusCode).toBe(201);
      const comment = TaskDetail.parse(response.json()).timeline.find((event) => event.type === 'task_note')!;
      await vi.waitFor(() => expect(app.runner.started).toHaveLength(1));
      await flush();
      const processing = () => domain.messageProcessing.ofComments('AR', 'AR-1', [comment]).get(comment.id)!;
      const stateOf = () => processing().filter((item) => item.handle === 'dev-1');
      // A person is told by a mention item, which counts as the notice.
      expect(processing().find((item) => item.handle === 'robin')).toMatchObject({ state: 'delivered' });
      expect(stateOf()).toMatchObject([{ handle: 'dev-1', state: 'delivered' }]);
      const { sessionId } = app.runner.started[0]!;
      app.runner.setState(sessionId, 'working');
      await flush();
      expect(stateOf()).toMatchObject([{ state: 'working' }]);
      app.runner.setState(sessionId, 'idle');
      await flush();
      expect(stateOf()).toMatchObject([{ state: 'turn_ended' }]);
      await domain.tasks.addNote('AR', 'AR-1', 'Done', { kind: 'ai', handle: 'dev-1' }, null, {
        replyTo: comment.id,
      });
      expect(stateOf()).toMatchObject([{ state: 'replied' }]);
      expect(events.some((event) => event.type === 'message_processing_changed')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
