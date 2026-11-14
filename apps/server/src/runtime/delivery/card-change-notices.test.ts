import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../contracts';
import { createDomainHarness, OWNER_ACTOR } from '../../../test/helpers/domain-harness';
import type { DomainHarness } from '../../../test/helpers/domain-harness';
import { makeRepoless } from '../../../test/helpers/test-template';
import { aiActor } from '../../kernel';

const DEV = 'dev-1';

describe('card change notices (PM-1512)', () => {
  let h: DomainHarness;
  let tool: ToolContext;
  let sessionId: string;

  /** AR-1 stands in the first stage with two acceptance items; dev-1 has a working session on it. */
  async function setup() {
    h = await createDomainHarness({
      adjust(config) {
        makeRepoless(config);
      },
    });
    await h.domain.tasks.create(
      'AR',
      { title: 'A card', description: 'First scope', acceptance: ['It builds', 'It is documented'] },
      OWNER_ACTOR,
    );
    await h.domain.tasks.create('AR', { title: 'Another card' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', DEV, { type: 'task', taskKey: 'AR-1' });
    h.runner.setState(session.id, 'working');
    sessionId = session.id;
    tool = { sessionId, projectKey: 'AR', member: DEV, taskKey: 'AR-1' };
  }
  beforeEach(setup);
  afterEach(() => h?.cleanup());

  const take = (ctx = tool) => h.domain.cardNotices.take(ctx);
  const itemId = (n: number) => h.domain.tasks.detail('AR', 'AR-1').acceptance![n]!.id;
  const eventOf = (type: 'task_updated' | 'team_message') =>
    h.repos.timeline.latestOfType('AR', 'AR-1', type)!;
  const send = (from: string, text: string, kind: 'action' | 'info' = 'action', to = [DEV]) =>
    h.domain.messaging.send('AR', from, { to, text, taskKey: 'AR-1' }, { kind });

  it('tells a description change of somebody else once, with the event and without free text', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope: SECRET-TEXT' }, OWNER_ACTOR);
    const notice = take();
    expect(notice?.text).toContain('AR-1');
    expect(notice?.text).toContain('description');
    expect(notice?.text).toContain('owner');
    expect(notice?.text).toContain(eventOf('task_updated').id);
    expect(notice?.text).toContain('get_task');
    expect(notice?.text).not.toContain('SECRET-TEXT');
    expect(take()).toBeNull();
  });

  it('puts the changes that gathered on the card into one block', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-1', { acceptance: [{ op: 'add', text: 'Extra' }] }, OWNER_ACTOR);
    const notice = take();
    expect(notice?.text.match(/event_id evt_/g)).toHaveLength(2);
    expect(take()).toBeNull();
  });

  it('lists ten changes and counts the rest', async () => {
    for (let i = 0; i < 12; i++)
      await h.domain.tasks.update('AR', 'AR-1', { description: `Scope ${i}` }, OWNER_ACTOR);
    const notice = take();
    expect(notice?.text.match(/event_id evt_/g)).toHaveLength(10);
    expect(notice?.text).toContain('and 2 more changes');
  });

  it.each(['edit', 'add', 'remove'] as const)('tells an acceptance %s of somebody else', async (op) => {
    const change =
      op === 'add'
        ? ({ op, text: 'Extra' } as const)
        : op === 'edit'
          ? ({ op, itemId: itemId(0), text: 'Changed' } as const)
          : ({ op, itemId: itemId(0) } as const);
    await h.domain.tasks.update('AR', 'AR-1', { acceptance: [change] }, OWNER_ACTOR);
    expect(take()?.text).toContain(`(${op})`);
  });

  it('tells a reopened and a moved acceptance item', async () => {
    const [first, second] = [itemId(0), itemId(1)];
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { acceptance: [{ op: 'done', itemId: first, evidence: 'a commit' }] },
      OWNER_ACTOR,
    );
    expect(take()).toBeNull();
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { acceptance: [{ op: 'reopen', itemId: first, note: 'it does not hold' }] },
      OWNER_ACTOR,
    );
    expect(take()?.text).toContain('(reopen)');
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      { acceptance: [{ op: 'move', itemId: second, taskKey: 'AR-2' }] },
      OWNER_ACTOR,
    );
    expect(take()?.text).toContain('(move)');
  });

  it('does not tell the state marks: done and not_needed', async () => {
    await h.domain.tasks.update(
      'AR',
      'AR-1',
      {
        acceptance: [
          { op: 'done', itemId: itemId(0), evidence: 'a commit' },
          { op: 'not_needed', itemId: itemId(1), reason: 'it does not apply' },
        ],
      },
      OWNER_ACTOR,
    );
    expect(take()).toBeNull();
  });

  it('tells an action message for the member without its text, from a person and from an AI member', async () => {
    await send('owner', 'Please stop: SECRET-TEXT');
    await send('cr', 'Look at this: SECRET-TEXT-2');
    const notice = take();
    expect(notice?.text.match(/a message for you arrived/g)).toHaveLength(2);
    expect(notice?.text).not.toContain('SECRET-TEXT');
  });

  it('does not mark the message delivered: it still comes when the session is idle', async () => {
    const sent = await send('cr', 'Please stop');
    expect(take()).not.toBeNull();
    expect(h.repos.messages.get(sent.id)?.deliveredAt).toBeNull();
    h.runner.setState(sessionId, 'idle');
    await vi.waitFor(() => expect(h.runner.messages.some((m) => m.text.includes('Please stop'))).toBe(true));
  });

  it('tells the answer to the member own question', async () => {
    await h.domain.messaging.send(
      'AR',
      'owner',
      { to: [DEV], text: 'Use the second option', taskKey: 'AR-1' },
      { kind: 'action', answer: { inboxItemId: 'inb_x', question: 'Which?', answer: 'Second' } },
    );
    expect(take()?.text).toContain('your question was answered');
  });

  it('does not tell an info message or a message for another member', async () => {
    await send('owner', 'FYI', 'info');
    await send('owner', 'For the reviewer', 'action', ['cr']);
    expect(take()).toBeNull();
  });

  it('does not tell an AI member message that was already delivered', async () => {
    h.runner.setState(sessionId, 'idle');
    await send('cr', 'Please stop');
    await vi.waitFor(() => expect(h.runner.messages.some((m) => m.text.includes('Please stop'))).toBe(true));
    expect(take()).toBeNull();
  });

  it('tells a person message although it stands in the input queue already', async () => {
    const sent = await send('owner', 'Please stop');
    await vi.waitFor(() => expect(h.repos.messages.get(sent.id)?.receipts?.[0]?.deliveredAt).toBeTruthy());
    expect(take()?.text).toContain('a message for you arrived');
  });

  it('does not tell a message a newer action replaced', async () => {
    await send('cr', 'First idea');
    await send('cr', 'Second idea');
    const notice = take();
    expect(notice?.text.match(/a message for you arrived/g)).toHaveLength(1);
    expect(notice?.text).toContain(eventOf('team_message').id);
  });

  it('does not tell its own changes', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { description: 'Mine' }, aiActor(DEV));
    await h.domain.tasks.update('AR', 'AR-1', { acceptance: [{ op: 'add', text: 'Mine' }] }, aiActor(DEV));
    expect(take()).toBeNull();
  });

  it('does not tell a label change, a stage change, a plain note or a change of another card', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['tag'] }, OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-1', { stageId: 'development' }, OWNER_ACTOR);
    await h.domain.tasks.addNote('AR', 'AR-1', 'A plain note', OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-2', { description: 'Other card' }, OWNER_ACTOR);
    expect(take()).toBeNull();
  });

  it('does not tell a card that is closed', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    expect(take()).toBeNull();
  });

  it('tells nothing to a session without a card', async () => {
    await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
    expect(take({ ...tool, taskKey: null })).toBeNull();
  });

  describe('cursor', () => {
    it('does not tell what happened before a session started', async () => {
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
      const { session } = await h.domain.sessions.ensureSession('AR', 'cr', {
        type: 'task',
        taskKey: 'AR-1',
      });
      const reviewer = { sessionId: session.id, projectKey: 'AR', member: 'cr', taskKey: 'AR-1' };
      expect(take(reviewer)).toBeNull();
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Third scope' }, OWNER_ACTOR);
      expect(take(reviewer)).not.toBeNull();
    });

    it('starts a session that has no cursor row at the end of the timeline, telling nothing back in time', async () => {
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
      const unknown = { ...tool, sessionId: 'ses_unknown' };
      expect(take(unknown)).toBeNull();
      expect(take(unknown)).toBeNull();
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Third scope' }, OWNER_ACTOR);
      expect(take(unknown)).not.toBeNull();
    });

    it('takes a notice back, so the next call tells it again', async () => {
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
      const first = take()!;
      h.domain.cardNotices.rollback(sessionId, [first.grant]);
      expect(take()?.text).toBe(first.text);
    });

    it('does not take a notice back over a later call', async () => {
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
      const first = take()!;
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Third scope' }, OWNER_ACTOR);
      expect(take()).not.toBeNull();
      h.domain.cardNotices.rollback(sessionId, [first.grant]);
      expect(take()).toBeNull();
    });

    it('takes back the notices of several calls in the reverse order', async () => {
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Second scope' }, OWNER_ACTOR);
      const first = take()!;
      await h.domain.tasks.update('AR', 'AR-1', { description: 'Third scope' }, OWNER_ACTOR);
      const second = take()!;
      h.domain.cardNotices.rollback(sessionId, [first.grant, second.grant]);
      expect(take()?.text.match(/event_id evt_/g)).toHaveLength(2);
    });
  });
});
