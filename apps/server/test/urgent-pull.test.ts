import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, TaskPriority } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-436: deferred starts are retried urgent first, then as before; a free developer takes a ready urgent
 * card from the queue stage into development. `dev-2` has the limit 13 and `dev-1` the default 5, both with
 * capacity 1 (the test project's queue is `backlog`).
 */
describe('the order of deferred starts and the urgent pull', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const PAUSE_BY = { userId: null, source: 'system' } as const;
  const WAITING = 'waiting-answer';

  const roomy = (c: ProjectConfig) => {
    c.team.limits.maxConcurrentAi = 10;
    c.pipeline.labels.push({ id: WAITING, name: 'Waiting for an answer', setBy: 'anyone', blocks: true });
    const senior = c.team.members.find((m) => m.handle === 'dev-2');
    if (senior?.kind === 'ai') senior.complexityLimit = 13;
  };
  /** Only `dev-1` can take a card: the Senior is on leave. */
  const oneDeveloper = (c: ProjectConfig) => {
    roomy(c);
    const senior = c.team.members.find((m) => m.handle === 'dev-2');
    if (senior?.kind === 'ai') senior.onLeave = true;
  };
  const harness = async (adjust: (c: ProjectConfig) => void = roomy) => {
    h = await createDomainHarness({ adjust });
  };

  const create = async (title: string, extra: { heavy?: boolean } = {}) =>
    (
      await h.domain.tasks.create(
        'AR',
        {
          title,
          ...(extra.heavy ? { complexity: { points: 8 as const, reason: 'the runner' } } : {}),
        },
        OWNER_ACTOR,
      )
    ).key;
  const priority = (key: string, value: TaskPriority | null = 'urgent') =>
    h.domain.tasks.update('AR', key, { priority: value }, OWNER_ACTOR);
  const move = (key: string, stage = 'development') =>
    h.domain.tasks.moveToStage('AR', key, stage, OWNER_ACTOR);
  const cancel = (key: string) =>
    h.domain.tasks.cancel('AR', key, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const settle = async () => {
    await h.domain.admission.retryDeferred();
    await flush();
  };
  const stageChange = (key: string) =>
    h.domain.timeline.list('AR', { taskKey: key }).filter((e) => e.type === 'task_stage_changed');
  const pulledOf = (key: string) => stageChange(key).at(-1)?.data.pulled;
  const sessionsOf = (key: string) => h.domain.sessions.list('AR', { taskKey: key });
  const waitFor = (key: string, assignee: string) =>
    vi.waitFor(() => expect(task(key).assignee).toBe(assignee));

  /** `dev-1` (the only developer, see `oneDeveloper`) works on a card of its own. */
  const busyDeveloper = async () => {
    const key = await create('Busy');
    await priority(key);
    await waitFor(key, 'dev-1');
    return key;
  };
  /** The Senior works on a card of its own; the cards that follow, recommended for the Senior, are deferred. */
  const busySenior = async () => {
    const key = await create('Senior busy', { heavy: true });
    await move(key);
    await waitFor(key, 'dev-2');
    return key;
  };
  const deferred = async (title: string) => {
    const key = await create(title, { heavy: true });
    await move(key);
    await vi.waitFor(() => expect(task(key).startWaiting).toMatchObject({ reason: 'senior_busy' }));
    return key;
  };

  describe('the order of the deferred starts', () => {
    it('starts an urgent card first, then the others', async () => {
      await harness();
      const busy = await busySenior();
      const other = await deferred('Other');
      const urgent = await deferred('Urgent');
      await priority(urgent);
      await flush();
      expect(task(urgent).assignee).toBeNull();

      await cancel(busy);
      await waitFor(urgent, 'dev-2');
      expect(task(other).assignee).toBeNull();

      await cancel(urgent);
      await waitFor(other, 'dev-2');
    });

    it('keeps the order of the store without urgent cards', async () => {
      await harness();
      const busy = await busySenior();
      const early = await deferred('Early');
      const late = await deferred('Late');
      await cancel(busy);
      await waitFor(early, 'dev-2');
      expect(task(late).assignee).toBeNull();
      await cancel(early);
      await waitFor(late, 'dev-2');
    });
  });

  describe('the pull', () => {
    it('leaves an urgent collector in the queue and starts its urgent subtask', async () => {
      await harness(oneDeveloper);
      const parent = await create('Collecting card');
      const child = (await h.domain.tasks.create('AR', { title: 'Subtask', parentKey: parent }, OWNER_ACTOR))
        .key;
      await priority(parent);
      await priority(child);
      await waitFor(child, 'dev-1');
      await settle();
      expect(task(parent)).toMatchObject({ stageId: 'backlog', assignee: null });
      expect(stageChange(parent)).toEqual([]);
      expect(sessionsOf(parent)).toEqual([]);
      expect(pulledOf(child)).toEqual({ reason: 'urgent' });
    });

    it('gives a ready urgent card to a free developer in the name of the system', async () => {
      await harness(oneDeveloper);
      const key = await create('Urgent card');
      await priority(key);
      await waitFor(key, 'dev-1');
      expect(task(key).stageId).toBe('development');
      expect(pulledOf(key)).toEqual({ reason: 'urgent' });
      expect(stageChange(key).at(-1)?.actor).toMatchObject({ kind: 'system' });
      await vi.waitFor(() => expect(sessionsOf(key)).toHaveLength(1));
    });

    it('gives each free developer one card, and the rest waits for a developer to be freed', async () => {
      await harness();
      const keys = [await create('Urgent one'), await create('Urgent two'), await create('Urgent three')];
      for (const key of keys) await priority(key);
      await settle();
      const taken = keys.filter((key) => task(key).assignee !== null);
      expect(taken.map((key) => task(key).assignee).sort()).toEqual(['dev-1', 'dev-2']);
      const left = keys.find((key) => !taken.includes(key))!;
      expect(task(left).stageId).toBe('backlog');
      // The developer freed by a cancel takes the card that waits.
      const freed = task(taken[0]!).assignee!;
      await cancel(taken[0]!);
      await waitFor(left, freed);
    });

    it('gives the Senior to the deferred start that waits for them, not to a pulled card', async () => {
      await harness();
      const busy = await busySenior();
      const waiting = await deferred('Waits for the Senior');
      const urgent = await create('Urgent card');
      await priority(urgent);
      // `dev-1` is free and takes the urgent card; the Senior, once free, goes to the card that waits for them.
      await waitFor(urgent, 'dev-1');
      const other = await create('Another urgent card');
      await priority(other);
      await cancel(busy);
      await waitFor(waiting, 'dev-2');
      expect(task(other).assignee).toBeNull();
    });

    it('does not pull what is not ready, not a start, or not open to everyone', async () => {
      await harness(oneDeveloper);
      const prerequisite = await create('Prerequisite');
      const blocked = await create('Has an open prerequisite');
      await h.domain.tasks.update(
        'AR',
        blocked,
        { relations: { add: [{ kind: 'prerequisite', key: prerequisite }] } },
        OWNER_ACTOR,
      );
      const waiting = await create('Waits for an answer');
      await h.domain.tasks.update('AR', waiting, { addLabels: [WAITING] }, OWNER_ACTOR);
      const senior = await create('Senior card', { heavy: true });
      const plain = await create('Not urgent');
      const assigned = await create('Somebody else has it');
      await h.domain.tasks.update('AR', assigned, { assignee: 'cr' }, OWNER_ACTOR);
      for (const key of [blocked, waiting, senior, assigned]) await priority(key);
      await settle();
      for (const key of [blocked, waiting, senior, plain, assigned, prerequisite])
        expect(task(key).stageId).toBe('backlog');
      expect(h.runner.started).toHaveLength(0);

      // The same developer takes a plain urgent card, so that none of the above is left out by a fault of the setup.
      const control = await create('Control');
      await priority(control);
      await waitFor(control, 'dev-1');
    });

    it('does not pull while AI work is off', async () => {
      await harness((c) => {
        roomy(c);
        c.team.limits.aiEnabled = false;
      });
      const key = await create('Urgent card');
      await priority(key);
      await settle();
      expect(task(key).stageId).toBe('backlog');
      expect(h.runner.started).toHaveLength(0);
    });

    it('reads no card while no developer is free, and only the open ones once one is (PM-770)', async () => {
      await harness(oneDeveloper);
      const busy = await busyDeveloper();
      const closed: string[] = [];
      for (let n = 0; n < 12; n++) {
        const card = await h.domain.tasks.create('AR', { title: `Closed ${n}` }, OWNER_ACTOR);
        h.repos.tasks.update(card.id, { status: 'cancelled', closedAt: new Date().toISOString() });
        closed.push(card.key);
      }
      const urgent = await create('Urgent card');
      await priority(urgent);
      const reads: { kind: string; keys: string[] }[] = [];
      const read = h.repos.tasks.readScheduling.bind(h.repos.tasks);
      vi.spyOn(h.repos.tasks, 'readScheduling').mockImplementation((projectKey, query) => {
        const rows = read(projectKey, query);
        reads.push({ kind: query.kind, keys: rows.map((row) => row.key) });
        return rows;
      });
      const pullReads = () => reads.filter((r) => ['pull', 'open'].includes(r.kind));

      // The only developer is busy: the round stops before it reads a card.
      await settle();
      expect(pullReads()).toEqual([]);
      expect(task(urgent).stageId).toBe('backlog');

      await cancel(busy);
      await waitFor(urgent, 'dev-1');
      expect(pullReads().length).toBeGreaterThan(0);
      expect(reads.flatMap((r) => r.keys).filter((key) => closed.includes(key))).toEqual([]);
    });

    it('hires no temp worker when every developer is busy', async () => {
      await harness((c) => {
        roomy(c);
        c.team.limits.tempWorkers = { enabled: true, max: 2, role: 'developer' };
      });
      for (const title of ['One', 'Two']) {
        const key = await create(title);
        await priority(key);
        await vi.waitFor(() => expect(task(key).assignee).not.toBeNull());
      }
      const members = (await h.domain.projects.config('AR')).team.members.length;
      const key = await create('Third urgent');
      await priority(key);
      await settle();
      expect(task(key).stageId).toBe('backlog');
      expect(h.runner.started).toHaveLength(2);
      expect((await h.domain.projects.config('AR')).team.members).toHaveLength(members);
    });

    it.each([
      ['the instance', { scope: 'instance' }],
      ['the project', { scope: 'project', projectKey: 'AR' }],
    ] as const)(
      'does not pull while %s is paused, and pulls again after the resume',
      async (_name, target) => {
        await harness(oneDeveloper);
        await h.domain.pauses.pause(target, PAUSE_BY);
        const key = await create('Urgent card');
        await priority(key);
        await settle();
        expect(task(key).stageId).toBe('backlog');
        await h.domain.pauses.resume(target, PAUSE_BY);
        await settle();
        await waitFor(key, 'dev-1');
      },
    );

    it('pulls at once when a card becomes ready, without waiting for the timer', async () => {
      await harness(oneDeveloper);
      const key = await create('Waits for an answer');
      await h.domain.tasks.update('AR', key, { addLabels: [WAITING] }, OWNER_ACTOR);
      await priority(key);
      await settle();
      expect(task(key).stageId).toBe('backlog');
      await h.domain.tasks.update('AR', key, { removeLabels: [WAITING] }, OWNER_ACTOR);
      await waitFor(key, 'dev-1');
    });

    it('pulls nothing once the priority is taken back', async () => {
      await harness(oneDeveloper);
      const busy = await create('Busy');
      await priority(busy);
      await waitFor(busy, 'dev-1');
      const urgent = await create('Urgent, then not');
      await priority(urgent);
      await priority(urgent, null);
      await cancel(busy);
      await settle();
      expect(task(urgent).stageId).toBe('backlog');
    });

    it('pulls a card at once when it reaches the queue stage, without waiting for the timer', async () => {
      await harness((c) => {
        oneDeveloper(c);
        const queue = c.pipeline.stages[0];
        if (queue) c.pipeline.stages.unshift({ ...queue, id: 'ideas', name: 'Ideas' });
      });
      const key = await create('Urgent idea');
      expect(task(key).stageId).toBe('ideas');
      await priority(key);
      await settle();
      expect(task(key).stageId).toBe('ideas');
      await move(key, 'backlog');
      await waitFor(key, 'dev-1');
      expect(task(key).stageId).toBe('development');
      expect(pulledOf(key)).toMatchObject({ reason: 'urgent' });
    });

    it('starts a card once when the Start button and the pull take it together', async () => {
      await harness(oneDeveloper);
      const busy = await busyDeveloper();
      const key = await create('Urgent card');
      await priority(key);
      await settle();
      expect(task(key).stageId).toBe('backlog');
      // The developer is freed (which starts a pull round) while the Start button is pressed on the card.
      await Promise.all([
        cancel(busy),
        h.domain.taskStarts.start('AR', key, { actor: OWNER_ACTOR, author: OWNER }),
        h.domain.admission.retryDeferred(),
      ]);
      await flush();
      await waitFor(key, 'dev-1');
      await settle();
      expect(task(key).stageId).toBe('development');
      expect(sessionsOf(key)).toHaveLength(1);
      expect(stageChange(key)).toHaveLength(1);
      // The busy card's session and this card's: no second session for the card.
      expect(h.runner.started).toHaveLength(2);
    });
  });
});
