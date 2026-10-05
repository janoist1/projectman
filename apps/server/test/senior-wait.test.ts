import { afterEach, describe, expect, it, vi } from 'vitest';
import { seniorWaitDecisionOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-348: a card recommended for the Senior waits for the Senior, the owners are asked once after the
 * wait limit, and an any card goes to the Senior only when no other developer is free. `dev-2` is the
 * Senior here (not the first developer), so that the team order cannot explain a choice.
 */
describe('the Senior card: assignment, wait and the question', () => {
  let h: DomainHarness;
  let clock = new Date('2026-10-05T10:00:00.000Z');
  afterEach(() => h?.cleanup());

  const minutes = (n: number) => void (clock = new Date(clock.getTime() + n * 60_000));
  const by = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const roomy = (c: ProjectConfig) => {
    c.team.limits.maxConcurrentAi = 10;
    const senior = c.team.members.find((m) => m.handle === 'dev-2');
    if (senior?.kind === 'ai') senior.senior = true;
  };
  const withTemp = (c: ProjectConfig) => {
    roomy(c);
    c.team.limits.tempWorkers = { enabled: true, max: 2, role: 'developer' };
  };
  const harness = async (adjust: (c: ProjectConfig) => void = roomy, persistent = false) => {
    clock = new Date('2026-10-05T10:00:00.000Z');
    h = await createDomainHarness({ adjust, now: () => clock, persistent });
  };

  const create = async (title: string, level: 'senior' | 'any' = 'senior') =>
    (
      await h.domain.tasks.create(
        'AR',
        { title, ...(level === 'senior' ? { developerLevel: { level, reason: 'the runner' } } : {}) },
        OWNER_ACTOR,
      )
    ).key;
  const move = (key: string, stage = 'development') =>
    h.domain.tasks.moveToStage('AR', key, stage, OWNER_ACTOR);
  const task = (key: string) => h.domain.tasks.get('AR', key);
  const waiting = (key: string) => task(key).startWaiting;
  const storedKeys = () => h.repos.deferredStarts.list().map((r) => r.key);
  const waitRow = (key: string) => h.repos.seniorWaits.open('AR', key);
  const questions = () => h.domain.inbox.list('AR', { kind: 'decision' }).filter(seniorWaitDecisionOf);
  const waitEvents = (key: string) =>
    h.domain.timeline.list('AR', { taskKey: key }).filter((e) => e.type === 'task_senior_wait');
  const phases = (key: string) => waitEvents(key).map((e) => e.data.phase);
  const answer = (id: string, optionId: 'wait_for_senior' | 'any_developer') =>
    h.domain.inbox.resolve('AR', id, { optionId }, { handle: 'owner', access: 'owner' });
  const cancel = (key: string) =>
    h.domain.tasks.cancel('AR', key, { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
  /** The Senior and the other developer both work on a card of their own; returns those cards. */
  const busyTeam = async () => {
    const first = await create('Busy one', 'any');
    await move(first);
    await vi.waitFor(() => expect(task(first).assignee).toBe('dev-1'));
    const second = await create('Busy two', 'any');
    await move(second);
    await vi.waitFor(() => expect(task(second).assignee).toBe('dev-2'));
    return { first, second };
  };
  /** Only the Senior is busy: it works on a card of its own. */
  const busySenior = async () => {
    const key = await create('Senior busy');
    await move(key);
    await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
    return key;
  };
  /** A Senior card whose wait is past the limit and has been asked. */
  const askedCard = async () => {
    const busy = await busySenior();
    const key = await create('Asked');
    await move(key);
    await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
    minutes(31);
    h.domain.seniorWaits.sweep();
    expect(questions()).toHaveLength(1);
    return { busy, key, item: questions()[0]! };
  };

  describe('assignment', () => {
    it('gives a Senior card to a free Senior, though another developer is first in the team', async () => {
      await harness();
      const key = await create('Senior card');
      await move(key);
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
      expect(waiting(key)).toBeUndefined();
      expect(storedKeys()).toEqual([]);
      expect(waitRow(key)).toBeNull();
      expect(phases(key)).toEqual([]);
    });

    it('makes an automatic start wait while the Senior is busy, and gives the card to nobody else', async () => {
      await harness(withTemp);
      await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() =>
        expect(waiting(key)).toMatchObject({ reason: 'senior_busy', seniors: ['dev-2'] }),
      );
      await h.domain.admission.retryDeferred();
      await flush();
      // dev-1 is free and a temp worker could be hired: neither takes the card.
      expect(task(key)).toMatchObject({ stageId: 'development', assignee: null });
      expect(h.runner.started).toHaveLength(1);
      expect((await h.domain.projects.config('AR')).team.members.some((m) => m.kind === 'ai' && m.temp)).toBe(
        false,
      );
      expect(storedKeys()).toEqual(['work-start:AR:AR-2']);
      expect(waitRow(key)).toMatchObject({ since: clock.toISOString(), askedAt: null, decision: null });
      expect(h.domain.tasks.list('AR').find((t) => t.key === key)?.startWaiting).toEqual(waiting(key));
    });

    it("answers a person's Start with the card in Development, unassigned, and the wait on it", async () => {
      await harness();
      await busySenior();
      const key = await create('Started by a person');
      const result = await h.domain.taskStarts.start('AR', key, by());
      expect(result.seniorWait).toEqual({ seniors: ['dev-2'] });
      expect(result.task).toMatchObject({ stageId: 'development', assignee: null });
      expect(waiting(key)).toMatchObject({ reason: 'senior_busy', seniors: ['dev-2'] });
      await flush();
      await h.domain.admission.retryDeferred();
      expect(task(key).assignee).toBeNull();
      expect(h.runner.started).toHaveLength(1);
      // The move's own automatic start and the Start share one key: one wait is stored.
      expect(storedKeys()).toEqual([`work-start:AR:${key}`]);
      expect(h.repos.seniorWaits.listOpen('AR')).toHaveLength(1);
      await h.domain.workStarts.begin({
        task: task(key),
        from: 'backlog',
        to: 'development',
        actor: OWNER_ACTOR,
      });
      expect(storedKeys()).toEqual([`work-start:AR:${key}`]);
    });

    it('keeps when the wait began across repeated attempts', async () => {
      await harness();
      await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      const since = waiting(key)!.since;
      minutes(10);
      await h.domain.admission.retryDeferred();
      expect(waiting(key)).toMatchObject({ reason: 'senior_busy', since });
      expect(waitRow(key)?.since).toBe(since);
    });

    it('gives an any card to the Senior only when no other developer is free', async () => {
      await harness();
      const one = await create('One', 'any');
      await move(one);
      await vi.waitFor(() => expect(task(one).assignee).toBe('dev-1'));
      const two = await create('Two', 'any');
      await move(two);
      await vi.waitFor(() => expect(task(two).assignee).toBe('dev-2'));
    });

    it('lets a Senior that frees up take the Senior card before an older any card', async () => {
      await harness();
      const { second } = await busyTeam();
      const anyCard = await create('Any card', 'any');
      await move(anyCard);
      await vi.waitFor(() => expect(waiting(anyCard)).toMatchObject({ reason: 'no_free_member' }));
      const seniorCard = await create('Senior card');
      await move(seniorCard);
      await vi.waitFor(() => expect(waiting(seniorCard)).toMatchObject({ reason: 'senior_busy' }));

      await cancel(second);
      await vi.waitFor(() => expect(task(seniorCard).assignee).toBe('dev-2'));
      expect(task(anyCard).assignee).toBeNull();
      expect(waiting(anyCard)).toMatchObject({ reason: 'no_free_member' });
    });

    it('starts a Senior card at once when the team has no Senior, and says so once', async () => {
      await harness((c) => void (c.team.limits.maxConcurrentAi = 10));
      const key = await create('Senior card');
      await move(key);
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
      expect(phases(key)).toEqual(['no_senior']);
      expect(waitRow(key)).toBeNull();
      await h.domain.admission.retryDeferred();
      expect(phases(key)).toEqual(['no_senior']);
    });

    it('lets the card go by the any rule when the Senior mark is taken away during the wait', async () => {
      await harness();
      await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      await h.domain.members.update('AR', 'dev-2', { senior: false }, by());
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
      expect(waitRow(key)).toBeNull();
      expect(phases(key)).toEqual(['no_senior']);
    });

    it('keeps an existing assignee and a manual choice over the recommendation', async () => {
      await harness();
      await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      const result = await h.domain.taskStarts.start('AR', key, { assignee: 'dev-1', ...by() });
      expect(result.task.assignee).toBe('dev-1');
      await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
      expect(waitRow(key)).toBeNull();
      expect(storedKeys()).toEqual([]);
    });
  });

  describe('the question after the wait limit', () => {
    it('asks the owners once, after 30 minutes and not before, and never repeats it', async () => {
      await harness();
      await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      minutes(29);
      h.domain.seniorWaits.sweep();
      expect(questions()).toHaveLength(0);

      minutes(2);
      h.domain.seniorWaits.sweep();
      h.domain.seniorWaits.sweep();
      minutes(120);
      h.domain.seniorWaits.sweep();
      const [item, ...rest] = questions();
      expect(rest).toEqual([]);
      expect(item).toMatchObject({
        state: 'open',
        source: 'system',
        taskKey: key,
        assignees: ['owner'],
        payload: { seniorWait: { taskKey: key, minutes: 30, seniors: ['dev-2'], reason: 'the runner' } },
      });
      expect(item!.options.map((o) => o.id)).toEqual(['wait_for_senior', 'any_developer']);
      expect(phases(key)).toEqual(['asked']);
      expect(waitRow(key)?.inboxItemId).toBe(item!.id);
    });

    it('uses the project’s own wait limit', async () => {
      await harness((c) => {
        roomy(c);
        c.team.limits.seniorWaitMinutes = 5;
      });
      await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      minutes(6);
      h.domain.seniorWaits.sweep();
      expect(questions()).toHaveLength(1);
      expect(questions()[0]!.payload).toMatchObject({ seniorWait: { minutes: 5 } });
    });

    it('goes on waiting after "wait on", remembers who decided, and does not ask again', async () => {
      await harness();
      const { item, key } = await askedCard();
      await answer(item.id, 'wait_for_senior');
      await flush();
      await h.domain.admission.retryDeferred();
      expect(task(key).assignee).toBeNull();
      expect(waiting(key)).toMatchObject({ reason: 'senior_busy', waitDecidedBy: 'owner' });
      expect(waitRow(key)).toMatchObject({ decision: 'wait', decidedBy: 'owner' });
      minutes(180);
      h.domain.seniorWaits.sweep();
      expect(questions()).toHaveLength(1);
      expect(phases(key)).toEqual(['asked', 'decided']);
    });

    it('leaves the card waiting while the question is unanswered', async () => {
      await harness();
      const { key } = await askedCard();
      minutes(600);
      h.domain.seniorWaits.sweep();
      await h.domain.admission.retryDeferred();
      expect(task(key).assignee).toBeNull();
      expect(waiting(key)).toMatchObject({ reason: 'senior_busy' });
      expect(questions()).toHaveLength(1);
    });

    it('gives the card to a free developer after "any developer"', async () => {
      await harness();
      const { item, key } = await askedCard();
      await answer(item.id, 'any_developer');
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
      expect(waitRow(key)).toBeNull();
      expect(storedKeys()).toEqual([]);
      expect(phases(key)).toEqual(['asked', 'decided']);
      // The owners' answer stays as it was given.
      expect(h.domain.inbox.get('AR', item.id).resolution).toMatchObject({
        optionId: 'any_developer',
        by: 'owner',
      });
    });

    it('waits for a free developer, and hires no temp worker, when nobody is free after "any developer"', async () => {
      await harness(withTemp);
      const { item, key } = await askedCard();
      const other = await create('Occupies dev-1', 'any');
      await move(other);
      await vi.waitFor(() => expect(task(other).assignee).toBe('dev-1'));
      await answer(item.id, 'any_developer');
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'no_free_member' }));
      await h.domain.admission.retryDeferred();
      expect(task(key).assignee).toBeNull();
      expect((await h.domain.projects.config('AR')).team.members.some((m) => m.kind === 'ai' && m.temp)).toBe(
        false,
      );
      // A developer that frees up takes it.
      await cancel(other);
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
    });
  });

  describe('the end of the wait', () => {
    it('gives the card to the Senior that frees up and closes the question', async () => {
      await harness();
      const { busy, key, item } = await askedCard();
      await cancel(busy);
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
      expect(waitRow(key)).toBeNull();
      expect(h.domain.inbox.get('AR', item.id)).toMatchObject({
        state: 'resolved',
        resolution: { rule: 'senior_took', by: 'system' },
      });
      expect(phases(key)).toEqual(['asked', 'senior_took']);
      expect(storedKeys()).toEqual([]);
    });

    it('takes the card without a question when the Senior frees up in time', async () => {
      await harness();
      const busy = await busySenior();
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      await cancel(busy);
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
      expect(waitRow(key)).toBeNull();
      expect(questions()).toHaveLength(0);
      expect(phases(key)).toEqual([]);
    });

    it('closes the question when somebody assigns the card', async () => {
      await harness();
      const { key, item } = await askedCard();
      await h.domain.tasks.update('AR', key, { assignee: 'dev-1' }, OWNER_ACTOR);
      expect(waitRow(key)).toBeNull();
      expect(h.domain.inbox.get('AR', item.id)).toMatchObject({
        state: 'resolved',
        resolution: { rule: 'senior_wait_ended' },
      });
    });

    it('closes the question when the card moves on', async () => {
      await harness();
      const { key, item } = await askedCard();
      await move(key, 'backlog');
      expect(waitRow(key)).toBeNull();
      // A move already cancels the decision requests of the card's earlier stage (`TaskMoves`).
      expect(h.domain.inbox.get('AR', item.id).state).toBe('cancelled');
      expect(storedKeys()).toEqual([]);
    });

    it('closes the question when the card is closed', async () => {
      await harness();
      const { key, item } = await askedCard();
      await cancel(key);
      expect(waitRow(key)).toBeNull();
      expect(h.domain.inbox.get('AR', item.id)).toMatchObject({
        state: 'resolved',
        resolution: { rule: 'senior_wait_ended' },
      });
    });

    it('ends the wait when the recommendation is set to any', async () => {
      await harness();
      const { key, item } = await askedCard();
      await h.domain.tasks.update('AR', key, { developerLevel: { level: 'any' } }, OWNER_ACTOR);
      expect(waitRow(key)).toBeNull();
      expect(h.domain.inbox.get('AR', item.id).resolution).toMatchObject({ rule: 'senior_wait_ended' });
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-1'));
    });
  });

  describe('a restart', () => {
    /** The Senior is on leave (it stays so over a restart; a busy Senior's session would not). */
    const awayCard = async () => {
      await h.domain.members.update('AR', 'dev-2', { onLeave: true }, by());
      const key = await create('Waits');
      await move(key);
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      minutes(31);
      h.domain.seniorWaits.sweep();
      expect(questions()).toHaveLength(1);
      return { key, item: questions()[0]! };
    };

    it('keeps the wait, the question and the answer', async () => {
      await harness(roomy, true);
      const { item, key } = await awayCard();
      await answer(item.id, 'wait_for_senior');
      await flush();
      const since = waitRow(key)!.since;

      h = await restartDomainHarness(h, { now: () => clock });
      expect(waitRow(key)).toMatchObject({ since, decision: 'wait', decidedBy: 'owner' });
      // The restored start is retried at once: while it is, the card does not show it.
      await vi.waitFor(() =>
        expect(waiting(key)).toMatchObject({ reason: 'senior_busy', since, waitDecidedBy: 'owner' }),
      );
      expect(storedKeys()).toEqual([`work-start:AR:${key}`]);
      minutes(300);
      h.domain.seniorWaits.sweep();
      expect(questions()).toHaveLength(1);
      expect(task(key).assignee).toBeNull();

      // The Senior comes back: it takes the card, and the wait is over.
      await h.domain.members.update('AR', 'dev-2', { onLeave: false }, by());
      await vi.waitFor(() => expect(task(key).assignee).toBe('dev-2'));
      expect(waitRow(key)).toBeNull();
    });

    it('does not repeat a question that was asked before the restart', async () => {
      await harness(roomy, true);
      const { key } = await awayCard();
      h = await restartDomainHarness(h, { now: () => clock });
      await vi.waitFor(() => expect(waiting(key)).toMatchObject({ reason: 'senior_busy' }));
      minutes(60);
      h.domain.seniorWaits.sweep();
      expect(questions()).toHaveLength(1);
      expect(phases(key)).toEqual(['asked']);
    });
  });
});
