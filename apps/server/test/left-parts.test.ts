import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@projectman/shared';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * Parts of a broken-down card that were left in the first stage (PM-480): the member who broke the card
 * down is told once when their turn ends (the owners' alert after the next turn is retired, PM-1226). The
 * system never moves or labels a card.
 */
describe('parts left in the first stage after a breakdown', () => {
  let h: DomainHarness;

  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        // A stage between the first one and development to take the parts to, and a `refine` label dev-1 may set.
        const dev = config.pipeline.stages.findIndex((s) => s.id === 'development');
        config.pipeline.stages.splice(dev, 0, {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          owners: ['owner'],
          columnId: 'todo',
        });
        config.pipeline.labels.push({ id: 'refine', name: 'Refine', setBy: { members: ['dev-1'] } });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Big feature' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  const DEV = aiActor('dev-1');

  /** dev-1 works on AR-1; its turn is over (idle). */
  async function breakingDown(): Promise<Session> {
    const { session } = await h.domain.taskStarts.start('AR', 'AR-1', {
      assignee: 'dev-1',
      actor: OWNER_ACTOR,
      author: OWNER,
    });
    h.runner.setState(session!.id, 'working');
    await flush();
    return session!;
  }

  /** The member's turn ends: the session goes idle. */
  async function endTurn(session: Session) {
    h.runner.setState(session.id, 'idle');
    await flush(10);
  }

  /** The member's next turn: the typed message makes it work, then it goes idle again. */
  async function nextTurn(session: Session) {
    h.runner.setState(session.id, 'working');
    await flush();
    await endTurn(session);
  }

  const part = (title: string) => h.domain.tasks.create('AR', { title, parentKey: 'AR-1' }, DEV);
  const events = (phase: 'told' | 'alerted') =>
    h.repos.timeline
      .listOfTypes('AR', 'AR-1', ['task_parts_left'], 100)
      .filter((e) => (e.data as { phase?: string }).phase === phase);
  const alerts = () =>
    h.domain.inbox
      .list('AR', { kind: 'alert', taskKey: 'AR-1' })
      .filter((item) => (item.payload as { alert?: string } | null)?.alert === 'parts_left');

  it('tells the member once, with the parts, when their turn ends with parts left', async () => {
    const session = await breakingDown();
    await part('Part one');
    await part('Part two');
    await endTurn(session);

    const told = events('told');
    expect(told).toHaveLength(1);
    expect(told[0]!.data).toMatchObject({ member: 'dev-1', parts: ['AR-2', 'AR-3'] });
    expect(
      h.runner.messages
        .filter((m) => m.sessionId === session.id)
        .map((m) => m.text)
        .join('\n'),
    ).toContain('AR-2');
    expect(alerts()).toEqual([]);
  });

  it('does not tell a member whose turn ends with the parts out of the first stage', async () => {
    const session = await breakingDown();
    const one = await part('Part one');
    await h.domain.tasks.update('AR', one.key, { stageId: 'ready' }, DEV);
    await endTurn(session);
    expect(events('told')).toEqual([]);
  });

  it('does not tell about a part that carries refine', async () => {
    const session = await breakingDown();
    const one = await part('Part one');
    await h.domain.tasks.update('AR', one.key, { addLabels: ['refine'] }, DEV);
    await endTurn(session);
    expect(events('told')).toEqual([]);
  });

  it('does not tell a part created by someone else', async () => {
    const session = await breakingDown();
    await h.domain.tasks.create('AR', { title: 'By the owner', parentKey: 'AR-1' }, OWNER_ACTOR);
    await endTurn(session);
    expect(events('told')).toEqual([]);
  });

  it('does not tell while the parent waits for an answer', async () => {
    const session = await breakingDown();
    await part('Part one');
    await h.domain.tasks.update('AR', 'AR-1', { addLabels: ['waiting'] }, OWNER_ACTOR);
    await endTurn(session);
    expect(events('told')).toEqual([]);
  });

  it('opens no owner alert when the parts are still left after the next turn (PM-1226)', async () => {
    const session = await breakingDown();
    await part('Part one');
    await endTurn(session);
    await nextTurn(session);
    await nextTurn(session);

    expect(alerts()).toEqual([]);
    expect(events('alerted')).toEqual([]);
    expect(events('told')).toHaveLength(1);
  });

  it('closes the alert an older build left when the parts are taken out afterwards', async () => {
    const one = await part('Part one');
    h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      assignees: ['owner'],
      source: 'system',
      taskKey: 'AR-1',
      title: 'AR-1: 1 part left in the first stage after a reminder',
      payload: { alert: 'parts_left', taskKey: 'AR-1', member: 'dev-1', parts: [one.key] },
      options: [],
    });
    expect(alerts().filter((item) => item.state === 'open')).toHaveLength(1);

    await h.domain.tasks.update('AR', one.key, { stageId: 'ready' }, DEV);
    await flush(10);
    expect(alerts().filter((item) => item.state === 'open')).toEqual([]);
  });

  it('never moves or labels a card itself', async () => {
    const session = await breakingDown();
    const one = await part('Part one');
    await endTurn(session);
    await nextTurn(session);

    const after = h.repos.tasks.get(one.key)!;
    expect(after.stageId).toBe(one.stageId);
    expect(after.labels).toEqual(one.labels);
    const systemChanges = h.repos.timeline
      .listOfTypes('AR', one.key, ['task_stage_changed', 'task_labels_changed'], 50)
      .filter((e) => e.actor.kind === 'system');
    expect(systemChanges).toEqual([]);
  });
});
