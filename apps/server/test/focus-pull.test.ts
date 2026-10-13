import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, TaskPriority } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-436 (PM-427): deferred starts are retried urgent first, then by the focus's order, then as before; a free
 * developer takes a ready urgent card, else the next focus card, from the queue stage into development. `dev-2`
 * is the Senior and `dev-1` the other developer, both with capacity 1 (the test project's queue is `backlog`).
 */
describe('the order of deferred starts and the focus pull', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const PAUSE_BY = { userId: null, source: 'system' } as const;
  const WAITING = 'waiting-answer';

  const roomy = (c: ProjectConfig) => {
    c.team.limits.maxConcurrentAi = 10;
    c.pipeline.labels.push({ id: WAITING, name: 'Waiting for an answer', setBy: 'anyone', blocks: true });
    const senior = c.team.members.find((m) => m.handle === 'dev-2');
    if (senior?.kind === 'ai') senior.senior = true;
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

  const create = async (
    title: string,
    extra: { developerLevel?: 'senior' | 'any'; themeKey?: string } = {},
  ) =>
    (
      await h.domain.tasks.create(
        'AR',
        {
          title,
          ...(extra.themeKey ? { themeKey: extra.themeKey } : {}),
          ...(extra.developerLevel === 'senior'
            ? { developerLevel: { level: 'senior' as const, reason: 'the runner' } }
            : {}),
        },
        OWNER_ACTOR,
      )
    ).key;
  const theme = async (title: string) =>
    (await h.domain.tasks.create('AR', { title, kind: 'theme' }, OWNER_ACTOR)).key;
  const priority = (key: string, value: TaskPriority | null = 'urgent') =>
    h.domain.tasks.update('AR', key, { priority: value }, OWNER_ACTOR);
  const focus = (key: string, position?: number) =>
    h.domain.projectFocus.add('AR', key, OWNER_ACTOR, position);
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
    const key = await create('Senior busy', { developerLevel: 'senior' });
    await move(key);
    await waitFor(key, 'dev-2');
    return key;
  };
  const deferred = async (title: string) => {
    const key = await create(title, { developerLevel: 'senior' });
    await move(key);
    await vi.waitFor(() => expect(task(key).startWaiting).toMatchObject({ reason: 'senior_busy' }));
    return key;
  };

  describe('the order of the deferred starts', () => {
    it('starts an urgent card first, then the focus cards by place, then the others', async () => {
      await harness();
      const busy = await busySenior();
      const other = await deferred('Other');
      const second = await deferred('Second in focus');
      const first = await deferred('First in focus');
      const urgent = await deferred('Urgent');
      await focus(second);
      await focus(first, 1);
      await priority(urgent);
      await flush();
      expect(task(urgent).assignee).toBeNull();

      await cancel(busy);
      await waitFor(urgent, 'dev-2');
      for (const key of [other, second, first]) expect(task(key).assignee).toBeNull();

      await cancel(urgent);
      await waitFor(first, 'dev-2');
      expect(task(second).assignee).toBeNull();
      await cancel(first);
      await waitFor(second, 'dev-2');
      expect(task(other).assignee).toBeNull();
      await cancel(second);
      await waitFor(other, 'dev-2');
    });

    it('keeps the order of the store without focus or urgent cards', async () => {
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

    it('gives the next focus card, with the place and the item that covers it', async () => {
      await harness(oneDeveloper);
      const busy = await busyDeveloper();
      const second = await create('Second card');
      const first = await create('First card');
      await focus(second);
      await focus(first, 1);
      await cancel(busy);
      await waitFor(first, 'dev-1');
      expect(pulledOf(first)).toEqual({ reason: 'focus', position: 1, key: first, title: 'First card' });
      // The developer is busy: the second card waits for its turn.
      await settle();
      expect(task(second).assignee).toBeNull();
      expect(task(second).stageId).toBe('backlog');
      await cancel(first);
      await waitFor(second, 'dev-1');
      expect(pulledOf(second)).toEqual({ reason: 'focus', position: 2, key: second, title: 'Second card' });
    });

    it('pulls the cards of a theme the focus covers, naming the theme', async () => {
      await harness(oneDeveloper);
      const parent = await theme('The theme');
      const key = await create('Card of the theme', { themeKey: parent });
      await focus(parent);
      await waitFor(key, 'dev-1');
      expect(pulledOf(key)).toEqual({ reason: 'focus', position: 1, key: parent, title: 'The theme' });
      expect(task(parent).assignee).toBeNull();
    });

    it('takes an urgent card before a focus card', async () => {
      await harness(oneDeveloper);
      const busy = await busyDeveloper();
      const next = await create('Next focus card');
      const urgent = await create('Urgent card');
      await focus(next);
      await priority(urgent);
      await cancel(busy);
      await waitFor(urgent, 'dev-1');
      expect(pulledOf(urgent)).toEqual({ reason: 'urgent' });
      expect(task(next).stageId).toBe('backlog');
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
      const parent = await theme('A theme');
      const senior = await create('Senior card', { developerLevel: 'senior' });
      const plain = await create('Neither urgent nor in the focus');
      const assigned = await create('Somebody else has it');
      await h.domain.tasks.update('AR', assigned, { assignee: 'cr' }, OWNER_ACTOR);
      for (const key of [blocked, waiting, senior, assigned]) await priority(key);
      await focus(parent);
      await settle();
      for (const key of [blocked, waiting, senior, plain, assigned, prerequisite])
        expect(task(key).stageId).toBe('backlog');
      expect(task(parent).assignee).toBeNull();
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

    it('pulls nothing once the priority is taken back or the card leaves the focus', async () => {
      await harness(oneDeveloper);
      const busy = await create('Busy');
      await priority(busy);
      await waitFor(busy, 'dev-1');
      const urgent = await create('Urgent, then not');
      const covered = await create('Focus, then not');
      await priority(urgent);
      await focus(covered);
      await priority(urgent, null);
      await h.domain.projectFocus.remove('AR', covered, OWNER_ACTOR);
      await cancel(busy);
      await settle();
      expect(task(urgent).stageId).toBe('backlog');
      expect(task(covered).stageId).toBe('backlog');
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
