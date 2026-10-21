import { afterEach, describe, expect, it, vi } from 'vitest';
import { questionPayloadOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor, SYSTEM_AUTHOR } from '../src/kernel';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-804 (PM-795 part 2): the start round offers a startable card to the card mover (the pm) in one action
 * message and opens a `start` obligation. The system never starts a card by itself: the pm moves it and the
 * system picks the developer. `dev-2` is the Senior, `dev-1` the other developer, both with capacity 1. The
 * queue stage before development is `ready` (the pm moves cards from there); `backlog` is the idea stage.
 */
describe('the start offer to the project manager', () => {
  let h: DomainHarness;
  let clock = new Date('2026-10-19T10:00:00.000Z');
  afterEach(() => h?.cleanup());

  const minutes = (n: number) => void (clock = new Date(clock.getTime() + n * 60_000));
  const roomy = (c: ProjectConfig) => {
    c.team.limits.maxConcurrentAi = 10;
    const senior = c.team.members.find((m) => m.handle === 'dev-2');
    if (senior?.kind === 'ai') senior.senior = true;
    // A member on leave is not started, so the wake of the pm would never run.
    const pm = c.team.members.find((m) => m.handle === 'pm');
    if (pm?.kind === 'ai') pm.onLeave = false;
    for (const stage of c.pipeline.stages) delete stage.gate;
    c.pipeline.stages = c.pipeline.stages.filter((stage) => stage.kind !== 'release');
    c.pipeline.stages.splice(1, 0, {
      id: 'ready',
      name: 'Ready',
      kind: 'queue' as const,
      owners: ['owner'],
      columnId: 'todo',
    });
  };
  const harness = async (adjust: (c: ProjectConfig) => void = () => {}, persistent = false) => {
    clock = new Date('2026-10-19T10:00:00.000Z');
    h = await createDomainHarness({
      adjust: (c) => {
        roomy(c);
        adjust(c);
      },
      now: () => clock,
      persistent,
      integratorTodoAccess: { available: () => true },
    });
  };
  const restart = async () => {
    h = await restartDomainHarness(h, { now: () => clock });
  };

  /** A card in the idea stage. */
  const idea = async (title: string, extra: Record<string, unknown> = {}) =>
    (await h.domain.tasks.create('AR', { title, ...extra }, OWNER_ACTOR)).key;
  /** A card in the Ready queue, the pull source stage. */
  const create = async (title: string, extra: Record<string, unknown> & { priority?: 'urgent' } = {}) => {
    const { priority, ...rest } = extra;
    const key = await idea(title, rest);
    if (priority) await h.domain.tasks.update('AR', key, { priority }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', key, 'ready', OWNER_ACTOR);
    return key;
  };
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const settle = async () => {
    await h.domain.admission.retryDeferred();
    await flush();
  };
  const sweep = async () => {
    await h.domain.obligations.sweep();
    await flush();
  };
  const pmMove = (key: string, stage = 'development') =>
    h.domain.tasks.moveToStage('AR', key, stage, aiActor('pm'));
  const urgent = (key: string) => h.domain.tasks.update('AR', key, { priority: 'urgent' }, OWNER_ACTOR);

  /** The system's start messages to a member, newest last. */
  const offers = (to = 'pm') =>
    h.repos.messages
      .list('AR')
      .filter(
        (m) =>
          m.from === 'system' &&
          m.to.includes(to) &&
          m.body.includes('start') &&
          !m.body.startsWith('projectman reminder'),
      );
  const startRows = (key: string) =>
    h.repos.obligations.listLive('AR', key).filter((r) => r.kind === 'start');
  /** How a row ended, by the id it had while it was open. */
  const stateOf = (id: string) => h.repos.obligations.get(id)?.state;
  const reminders = () => h.repos.messages.list('AR').filter((m) => m.body.startsWith('projectman reminder'));
  const todos = () =>
    h.domain.inbox.list('AR', {}).filter((i) => questionPayloadOf(i)?.obligation !== undefined);

  /** Both developers work on an urgent card each: no one is free. */
  const busyDevelopers = async () => {
    const keys: string[] = [];
    for (const title of ['Busy one', 'Busy two']) {
      keys.push(await create(title, { priority: 'urgent' }));
    }
    await vi.waitFor(() => expect(keys.map((k) => task(k).assignee).sort()).toEqual(['dev-1', 'dev-2']));
    return keys;
  };

  it('sends one action message and opens a start obligation; the pm move starts the right developer', async () => {
    await harness();
    const key = await create('Runner work', { developerLevel: { level: 'senior', reason: 'The runner' } });
    await settle();
    expect(offers()).toHaveLength(1);
    expect(offers()[0]).toMatchObject({ from: 'system', to: ['pm'], kind: 'action', taskKey: key });
    expect(offers()[0]!.body).toContain(`${key} "Runner work"`);
    expect(startRows(key)).toMatchObject([{ responsible: 'pm', state: 'open' }]);
    expect(task(key).assignee).toBeNull();
    expect(task(key).stageId).toBe('ready');
    const row = startRows(key)[0]!.id;
    // The system never starts the card by itself.
    await settle();
    await settle();
    expect(task(key).assignee).toBeNull();
    expect(offers()).toHaveLength(1);

    await pmMove(key);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
    await sweep();
    expect(startRows(key)).toEqual([]);
    expect(stateOf(row)).toBe('fulfilled');
    expect(offers()).toHaveLength(1);
  });

  it('shows the offer to the pm on the card, and not to a client', async () => {
    await harness();
    const key = await create('Visible');
    await settle();
    const wait = h.domain.taskWaits.ofCard(await h.domain.projects.config('AR'), task(key));
    expect(wait).toMatchObject({ reason: 'ready', next: [{ handle: 'pm' }] });
    expect(wait?.hold).toBeUndefined();
  });

  describe('a collector', () => {
    it.each(['done', 'cancelled'] as const)('never offers a collector with only %s parts', async (status) => {
      await harness();
      // An imported collector can remain open behind its merge gate after its parts close (PM-797).
      const collector = await idea('Collector', { importedAt: clock.toISOString() });
      const part = await idea('Closed part', { parentKey: collector });
      h.repos.tasks.update(task(part).id, { status, stageId: 'done' });
      h.repos.tasks.update(task(collector).id, { stageId: 'ready' });
      await settle();
      expect(task(collector).status).toBe('active');
      expect(startRows(collector)).toEqual([]);
      expect(offers()).toEqual([]);
      minutes(61);
      await sweep();
      expect(reminders()).toEqual([]);
      expect(todos()).toEqual([]);
    });

    it('cancels an old collector offer and closes its todo even while the start round is paused', async () => {
      await harness((c) => {
        c.team.limits.obligationMinutes = 5;
      });
      const collector = await create('Previously offered collector');
      await settle();
      const row = startRows(collector)[0]!;
      minutes(6);
      await sweep();
      minutes(6);
      await sweep();
      expect(todos()[0]?.state).toBe('open');
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      const part = await idea('Closed part', { parentKey: collector });
      h.repos.tasks.update(task(part).id, { status: 'cancelled', stageId: 'done' });
      await settle();
      await sweep();
      expect(stateOf(row.id)).toBe('cancelled');
      expect(startRows(collector)).toEqual([]);
      expect(todos()[0]).toMatchObject({ state: 'cancelled', resolution: { rule: 'obligation_closed' } });
      expect(reminders()).toHaveLength(1);
    });

    const prerequisite = (key: string, on: string) =>
      h.domain.tasks.update(
        'AR',
        key,
        { relations: { add: [{ kind: 'prerequisite', key: on }] } },
        OWNER_ACTOR,
      );

    it('sends one grouped message for the startable parts, with the reasons of the waiting ones', async () => {
      await harness();
      const collector = await idea('Collector');
      const first = await idea('First part', { parentKey: collector });
      const second = await idea('Second part', { parentKey: collector });
      const third = await idea('Third part', { parentKey: collector });
      await prerequisite(third, first);
      // The team is paused while the cards move, so that one round sees all of them.
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      for (const key of [collector, first, second, third])
        await h.domain.tasks.moveToStage('AR', key, 'ready', OWNER_ACTOR);
      await settle();
      expect(offers()).toEqual([]);
      await h.domain.pauses.resume(
        { scope: 'project', projectKey: 'AR' },
        { userId: null, source: 'system' },
      );
      await settle();
      expect(offers()).toHaveLength(1);
      const body = offers()[0]!.body;
      expect(offers()[0]).toMatchObject({ to: ['pm'], kind: 'action', taskKey: collector });
      expect(body).toContain(first);
      expect(body).toContain(second);
      expect(body).toMatch(new RegExp(`The other parts wait: ${third}`));
      expect(startRows(first)).toHaveLength(1);
      expect(startRows(second)).toHaveLength(1);
      expect(startRows(third)).toHaveLength(0);
      // The collector itself does not start.
      expect(startRows(collector)).toHaveLength(0);
    });

    it('sends one message when the last prerequisite closes', async () => {
      await harness();
      const collector = await idea('Collector');
      const part = await idea('Part', { parentKey: collector });
      const first = await idea('Prerequisite');
      await prerequisite(part, first);
      for (const key of [collector, part, first])
        await h.domain.tasks.moveToStage('AR', key, 'ready', OWNER_ACTOR);
      await settle();
      const before = offers().length;
      expect(startRows(part)).toHaveLength(0);
      await h.domain.tasks.cancel('AR', first, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
      await settle();
      expect(offers()).toHaveLength(before + 1);
      expect(offers().at(-1)!.body).toContain(part);
      expect(startRows(part)).toHaveLength(1);
      await settle();
      expect(offers()).toHaveLength(before + 1);
    });
  });

  it('sends no message without a free developer, and one after a developer frees up', async () => {
    await harness();
    const [busy] = await busyDevelopers();
    const key = await create('Waiting card');
    await settle();
    expect(offers().filter((m) => m.taskKey === key)).toEqual([]);
    expect(startRows(key)).toEqual([]);
    await h.domain.tasks.cancel('AR', busy!, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    await settle();
    expect(offers().filter((m) => m.taskKey === key)).toHaveLength(1);
    expect(startRows(key)).toHaveLength(1);
  });

  it('offers a card that already has an assignee once that assignee is free (PM-879)', async () => {
    await harness();
    const busy = await busyDevelopers();
    const key = await create('Assigned card');
    h.domain.tasks.assign('AR', key, 'dev-1', OWNER_ACTOR);
    await settle();
    expect(offers().filter((m) => m.taskKey === key)).toEqual([]);
    for (const card of busy) await h.domain.tasks.cancel('AR', card, { reason: 'Fictional.' }, OWNER_ACTOR);
    await settle();
    expect(offers().filter((m) => m.taskKey === key)).toHaveLength(1);
    expect(startRows(key)).toMatchObject([{ responsible: 'pm', state: 'open' }]);
    await settle();
    expect(offers().filter((m) => m.taskKey === key)).toHaveLength(1);
    expect(offers().find((m) => m.taskKey === key)!.body).toContain('start_task');
    // A plain move starts nobody, so it does not answer the offer; start_task starts the assignee.
    const row = startRows(key)[0]!.id;
    await h.domain.taskStarts.start('AR', key, { actor: aiActor('pm'), author: SYSTEM_AUTHOR });
    await sweep();
    expect(task(key)).toMatchObject({ stageId: 'development', assignee: 'dev-1' });
    expect(h.repos.sessions.findByWorkItem('AR', 'dev-1', { type: 'task', taskKey: key })).not.toBeNull();
    expect(startRows(key)).toEqual([]);
    expect(stateOf(row)).toBe('fulfilled');
  });

  describe('an assigned card in the work stage that nobody started (PM-879)', () => {
    /** A card the owner moved forward with its assignee: going forward starts nothing (PM-119). */
    const waitingInWork = async (title: string, assignee = 'dev-1') => {
      const key = await idea(title);
      h.domain.tasks.assign('AR', key, assignee, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
      return key;
    };
    const startText = (key: string) => offers().filter((m) => m.taskKey === key);

    it('is offered once to be started with start_task, and the obligation ends when the session starts', async () => {
      await harness();
      const key = await waitingInWork('Moved forward');
      await settle();
      expect(startText(key)).toHaveLength(1);
      expect(startText(key)[0]!.body).toContain('start_task');
      expect(startRows(key)).toMatchObject([{ responsible: 'pm', state: 'open' }]);
      const row = startRows(key)[0]!.id;
      await settle();
      expect(startText(key)).toHaveLength(1);
      await h.domain.taskStarts.start('AR', key, {
        actor: aiActor('pm'),
        author: SYSTEM_AUTHOR,
      });
      await sweep();
      expect(startRows(key)).toEqual([]);
      expect(stateOf(row)).toBe('fulfilled');
    });

    it('is not offered while its assignee is busy, and keeps its assignee from other cards', async () => {
      await harness();
      const busy = await busyDevelopers();
      const key = await waitingInWork('Moved forward');
      const other = await create('Plain card');
      await settle();
      expect(startText(key)).toEqual([]);
      const own = busy.find((card) => task(card).assignee === 'dev-1')!;
      await h.domain.tasks.cancel('AR', own, { reason: 'Fictional.' }, OWNER_ACTOR);
      await settle();
      expect(startText(key)).toHaveLength(1);
      expect(startText(other)).toEqual([]);
    });
  });

  describe('urgent and focus cards', () => {
    it('are not offered: the pull starts them', async () => {
      await harness();
      const hot = await create('Urgent card', { priority: 'urgent' });
      const focused = await idea('Focus card');
      await h.domain.projectFocus.add('AR', focused, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', focused, 'ready', OWNER_ACTOR);
      await settle();
      await vi.waitFor(() => expect(task(hot).assignee).not.toBeNull());
      await vi.waitFor(() => expect(task(focused).assignee).not.toBeNull());
      expect(offers()).toEqual([]);
      expect(startRows(hot)).toEqual([]);
      expect(startRows(focused)).toEqual([]);
    });

    it('fulfil an open offer when the card turns urgent and the pull starts it', async () => {
      await harness();
      const key = await create('Late urgent');
      await settle();
      expect(startRows(key)).toHaveLength(1);
      const row = startRows(key)[0]!.id;
      await urgent(key);
      await settle();
      await vi.waitFor(() => expect(task(key).assignee).not.toBeNull());
      await sweep();
      expect(startRows(key)).toEqual([]);
      expect(stateOf(row)).toBe('fulfilled');
    });
  });

  it('does not pull a non-urgent card outside the focus', async () => {
    await harness();
    const key = await create('Plain card');
    await settle();
    await settle();
    expect(task(key).assignee).toBeNull();
    expect(task(key).stageId).toBe('ready');
    expect(offers()).toHaveLength(1);
  });

  it('gives one assignee and one session when the pm, the pull and a human start it together', async () => {
    await harness();
    const key = await create('Contested card');
    await settle();
    expect(offers()).toHaveLength(1);
    const results = await Promise.allSettled([
      pmMove(key),
      h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR),
      urgent(key),
      h.domain.admission.retryDeferred(),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    await flush();
    await vi.waitFor(() => expect(task(key).assignee).not.toBeNull());
    await settle();
    expect(
      h.domain.sessions.list('AR', { taskKey: key }).filter((s) => s.member === task(key).assignee),
    ).toHaveLength(1);
    expect(offers()).toHaveLength(1);
    await sweep();
    expect(startRows(key)).toEqual([]);
  });

  describe('the clock', () => {
    it('wakes the pm once after N minutes and hands a todo to the integrator after 2N', async () => {
      await harness((c) => {
        c.team.limits.obligationMinutes = 10;
      });
      const key = await create('Waiting for the pm');
      await settle();
      await sweep();
      expect(startRows(key)[0]!.dueAt).toBe('2026-10-19T10:10:00.000Z');
      minutes(9);
      await sweep();
      expect(reminders()).toEqual([]);
      minutes(2);
      await sweep();
      expect(reminders()).toHaveLength(1);
      expect(reminders()[0]).toMatchObject({ from: 'system', to: ['pm'], kind: 'action' });
      expect(reminders()[0]!.body).toContain(key);
      expect(todos()).toEqual([]);
      minutes(10);
      await sweep();
      expect(todos()).toHaveLength(1);
      expect(questionPayloadOf(todos()[0]!)).toMatchObject({
        recipient: 'integrator',
        obligation: { kind: 'start', responsible: 'pm' },
      });
      // The owner's inbox gets nothing.
      expect(h.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
      minutes(120);
      await sweep();
      await sweep();
      expect(reminders()).toHaveLength(1);
      expect(todos()).toHaveLength(1);
    });
  });

  describe('a project frame lock', () => {
    it('gives no message while the team is paused', async () => {
      await harness();
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      const key = await create('Paused');
      await settle();
      expect(offers()).toEqual([]);
      expect(startRows(key)).toEqual([]);
    });

    it('pauses the obligation of an open offer, and resumes it', async () => {
      await harness();
      const key = await create('Offered');
      await settle();
      await sweep();
      expect(startRows(key)[0]).toMatchObject({ pausedSince: null });
      minutes(5);
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
      await settle();
      await sweep();
      expect(startRows(key)[0]!.pausedSince).not.toBeNull();
      minutes(180);
      await sweep();
      expect(reminders()).toEqual([]);
      expect(todos()).toEqual([]);
      await h.domain.pauses.resume(
        { scope: 'project', projectKey: 'AR' },
        { userId: null, source: 'system' },
      );
      await settle();
      await sweep();
      expect(startRows(key)[0]).toMatchObject({ pausedSince: null });
      expect(offers()).toHaveLength(1);
    });
  });

  it('sends no second message after the start round is recreated (a restart)', async () => {
    await harness(() => {}, true);
    const key = await create('Before the restart');
    await settle();
    expect(offers()).toHaveLength(1);
    await restart();
    await settle();
    await sweep();
    await settle();
    expect(offers()).toHaveLength(1);
    expect(startRows(key)).toHaveLength(1);
    expect(task(key).assignee).toBeNull();
  });

  describe('a card that goes back', () => {
    it('cancels the obligation when it returns to the idea stage, and offers it again in Ready', async () => {
      await harness();
      const key = await idea('Parked');
      expect(task(key).stageId).toBe('backlog');
      await settle();
      expect(offers()).toEqual([]);
      await h.domain.tasks.moveToStage('AR', key, 'ready', OWNER_ACTOR);
      await settle();
      expect(offers()).toHaveLength(1);
      expect(startRows(key)).toHaveLength(1);
      const first = startRows(key)[0]!.id;

      minutes(1);
      await h.domain.tasks.moveToStage('AR', key, 'backlog', OWNER_ACTOR);
      await settle();
      await sweep();
      expect(startRows(key)).toEqual([]);
      expect(stateOf(first)).toBe('cancelled');

      minutes(1);
      await h.domain.tasks.moveToStage('AR', key, 'ready', OWNER_ACTOR);
      await settle();
      await sweep();
      expect(offers()).toHaveLength(2);
      expect(startRows(key)).toHaveLength(1);
      expect(startRows(key)[0]!.id).not.toBe(first);
    });
  });
});
