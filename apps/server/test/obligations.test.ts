import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_ENGINE_ID, questionPayloadOf } from '@projectman/shared';
import type { EngineId, ProjectConfig } from '@projectman/shared';
import type { EngineHost } from '../src/contracts';
import { createLocalEngine } from '../src/engine-host';
import { LocalEngineDirectory } from '../src/runtime/sessions';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { capturingLogger, FakeWorktreeManager, flush } from './helpers/fakes';

/**
 * PM-806: an open step of an AI member has a responsible and a deadline. At the first deadline the
 * responsible gets one reminder, at the second the step becomes one integrator todo. The system never
 * merges, decides or sets a label. The merge is the example kind here; the others use the same sweep.
 */
describe('obligations: the responsible, the deadline, one reminder, one todo', () => {
  let h: DomainHarness;
  let clock = new Date('2026-10-19T10:00:00.000Z');
  const integrator = { available: true };
  afterEach(() => h?.cleanup());

  const minutes = (n: number) => void (clock = new Date(clock.getTime() + n * 60_000));
  const roomy = (c: ProjectConfig) => {
    c.team.limits.maxConcurrentAi = 10;
  };
  const harness = async (adjust: (c: ProjectConfig) => void = roomy, persistent = false) => {
    clock = new Date('2026-10-19T10:00:00.000Z');
    integrator.available = true;
    h = await createDomainHarness({
      adjust,
      now: () => clock,
      persistent,
      integratorTodoAccess: { available: () => integrator.available },
    });
  };

  /** A round of the sweep; the wake message starts its session a moment later, at the clock of the round. */
  const sweep = async () => {
    await h.domain.obligations.sweep();
    await flush();
  };
  const create = async (title = 'A card') => (await h.domain.tasks.create('AR', { title }, OWNER_ACTOR)).key;
  /** The merger `cr` is asked to merge the card: the merge request is stored as the tool does. */
  const requestMerge = async (key: string, state: 'requested' | 'blocked' | 'queued' = 'requested') => {
    const now = clock.toISOString();
    h.repos.taskMerges.save({
      id: `mrg_${key}`,
      projectKey: 'AR',
      taskKey: key,
      repo: 'web',
      base: 'main',
      commit: 'approved',
      branch: `task/${key}`,
      fromStageId: h.domain.tasks.get('AR', key).stageId,
      toStageId: 'done',
      merger: 'cr',
      requestedAt: now,
      state,
      step: state === 'queued' ? 'queued' : 'waiting',
      landed: 'nowhere',
      createdAt: now,
      updatedAt: now,
    } as never);
  };
  const finishMerge = (key: string, state: 'merged' | 'cancelled') => {
    const row = h.repos.taskMerges.get(`mrg_${key}`)!;
    h.repos.taskMerges.save({
      ...row,
      state,
      finishedAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    });
  };
  const restart = async () => {
    h = await restartDomainHarness(h, {
      now: () => clock,
      integratorTodoAccess: { available: () => integrator.available },
    });
  };
  const rows = (key: string) => h.repos.obligations.listLive('AR', key);
  const events = (type: string) => h.domain.timeline.list('AR').filter((e) => e.type === type);
  const reminders = (key: string) =>
    h.repos.messages.list('AR').filter((m) => m.taskKey === key && m.body.startsWith('projectman reminder'));
  const todos = () =>
    h.domain.inbox.list('AR', {}).filter((i) => questionPayloadOf(i)?.obligation !== undefined);
  const ownerCount = () => h.domain.inbox.countOpenFor('AR', 'owner');

  it('wakes the merger once, then hands the merge to the integrator once', async () => {
    await harness();
    const key = await create();
    await requestMerge(key);
    await sweep();
    expect(rows(key)).toMatchObject([{ kind: 'merge', responsible: 'cr', subject: `mrg_${key}` }]);
    expect(rows(key)[0]!.dueAt).toBe('2026-10-19T10:30:00.000Z');

    minutes(29);
    await sweep();
    expect(reminders(key)).toHaveLength(0);

    minutes(2);
    await sweep();
    expect(reminders(key)).toHaveLength(1);
    expect(reminders(key)[0]).toMatchObject({ from: 'system', to: ['cr'], kind: 'action' });
    expect(events('obligation_woken')).toHaveLength(1);
    expect(events('obligation_woken')[0]).toMatchObject({
      actor: { kind: 'system' },
      data: { kind: 'merge', responsible: 'cr', subject: `mrg_${key}`, minutes: 30 },
    });
    expect(todos()).toHaveLength(0);

    minutes(31);
    await sweep();
    expect(todos()).toHaveLength(1);
    const todo = todos()[0]!;
    expect(questionPayloadOf(todo)).toMatchObject({
      recipient: 'integrator',
      obligation: { kind: 'merge', responsible: 'cr' },
    });
    expect(todo.taskKey).toBe(key);
    expect(rows(key)).toMatchObject([{ state: 'handed_over', inboxItemId: todo.id }]);
    expect(events('obligation_handed_over')).toHaveLength(1);
    expect(events('obligation_handed_over')[0]?.data).not.toHaveProperty('recipientRefusal');
    // The owners' inbox stays empty: the integrator has it.
    expect(ownerCount()).toBe(0);

    minutes(120);
    await sweep();
    await sweep();
    expect(reminders(key)).toHaveLength(1);
    expect(todos()).toHaveLength(1);
    expect(events('obligation_woken')).toHaveLength(1);
    expect(events('obligation_handed_over')).toHaveLength(1);
  });

  it('never merges, decides or sets a label itself', async () => {
    await harness();
    const key = await create();
    await requestMerge(key);
    const labels = h.domain.tasks.get('AR', key).labels;
    const stage = h.domain.tasks.get('AR', key).stageId;
    for (const n of [31, 31, 60]) {
      minutes(n);
      await sweep();
    }
    expect(h.repos.taskMerges.get(`mrg_${key}`)).toMatchObject({ state: 'requested' });
    expect(events('task_merged')).toHaveLength(0);
    expect(h.domain.tasks.get('AR', key)).toMatchObject({ labels, stageId: stage });
  });

  it('gives the todo to the owners when no integrator can take it', async () => {
    await harness();
    integrator.available = false;
    const key = await create();
    await requestMerge(key);
    for (const n of [31, 31]) {
      minutes(n);
      await sweep();
    }
    expect(todos()).toHaveLength(1);
    expect(questionPayloadOf(todos()[0]!)).toMatchObject({ recipient: 'owner' });
    expect(events('obligation_handed_over')[0]?.data).toMatchObject({
      recipient: 'owner',
      recipientRefusal: 'integrator_unavailable',
    });
    expect(ownerCount()).toBe(1);
  });

  it('closes without a reminder when the merge lands in time', async () => {
    await harness();
    const key = await create();
    await requestMerge(key);
    await sweep();
    minutes(10);
    finishMerge(key, 'merged');
    await sweep();
    expect(rows(key)).toEqual([]);
    expect(h.repos.obligations.find('AR', key, 'merge', 'cr', `mrg_${key}`)).toMatchObject({
      state: 'fulfilled',
    });
    minutes(60);
    await sweep();
    expect(reminders(key)).toHaveLength(0);
    expect(todos()).toHaveLength(0);
  });

  describe('a reminder that waits after its step is done (PM-813)', () => {
    /** A reminder of the row that nobody has taken yet, as one that could not start (capacity, leave) stays. */
    const waitingReminder = (key: string, obligationId: string, responsible = 'cr') => {
      const message = {
        id: `msg_wait_${key}`,
        projectKey: 'AR',
        from: 'system',
        to: [responsible],
        taskKey: key,
        body: 'projectman reminder: waits for you',
        createdAt: clock.toISOString(),
        deliveredAt: null,
        kind: 'action' as const,
        subject: { type: 'obligation' as const, obligationId },
        receipts: [{ handle: responsible, kind: 'ai' as const, deliveredAt: null, readAt: null }],
      };
      h.repos.messages.insert(message);
      return message;
    };

    it('carries its obligation in the reminder', async () => {
      await harness();
      const key = await create();
      await requestMerge(key);
      await sweep();
      minutes(31);
      await sweep();
      expect(reminders(key)[0]!.subject).toEqual({ type: 'obligation', obligationId: rows(key)[0]!.id });
    });

    it('starts no session for the reminder of a step that is done, and drops it from the queue', async () => {
      await harness();
      const key = await create();
      await requestMerge(key);
      await sweep();
      const row = rows(key)[0]!;
      const message = waitingReminder(key, row.id);
      const config = await h.domain.projects.config('AR');

      // While the step is open the reminder is valid and stays.
      expect(h.domain.messages.wakes(config, message, 'cr')).toBe(true);
      await sweep();
      expect(h.repos.messages.pending('AR', 'cr').map((m) => m.id)).toContain(message.id);

      minutes(10);
      finishMerge(key, 'merged');
      await sweep();
      expect(h.repos.obligations.get(row.id)).toMatchObject({ state: 'fulfilled' });
      expect(h.domain.messages.wakes(config, message, 'cr')).toBe(false);
      expect(h.repos.messages.pending('AR', 'cr').map((m) => m.id)).not.toContain(message.id);
      expect(h.repos.messages.get(message.id)).toMatchObject({
        receipts: [{ handle: 'cr', deliveredAt: expect.any(String) }],
      });
    });

    it('drops the waiting reminder of a cancelled step too', async () => {
      await harness();
      const key = await create();
      await requestMerge(key);
      await sweep();
      const row = rows(key)[0]!;
      const message = waitingReminder(key, row.id);
      minutes(5);
      finishMerge(key, 'cancelled');
      await sweep();
      expect(h.repos.messages.pending('AR', 'cr').map((m) => m.id)).not.toContain(message.id);
    });
  });

  it('cancels the row and closes an open todo when the merge is called off', async () => {
    await harness();
    const key = await create();
    await requestMerge(key);
    for (const n of [31, 31]) {
      minutes(n);
      await sweep();
    }
    const todo = todos()[0]!;
    expect(todo.state).toBe('open');
    finishMerge(key, 'cancelled');
    await sweep();
    expect(h.repos.obligations.find('AR', key, 'merge', 'cr', `mrg_${key}`)).toMatchObject({
      state: 'cancelled',
    });
    expect(h.domain.inbox.get('AR', todo.id)).toMatchObject({
      state: 'cancelled',
      resolution: { rule: 'obligation_closed' },
    });
  });

  it('lets the owner answer the todo without a message to anybody', async () => {
    await harness();
    integrator.available = false;
    const key = await create();
    await requestMerge(key);
    for (const n of [31, 31]) {
      minutes(n);
      await sweep();
    }
    const todo = todos()[0]!;
    const sent = h.repos.messages.list('AR').length;
    await h.domain.inbox.resolve(
      'AR',
      todo.id,
      { optionId: 'todo_done' },
      { handle: 'owner', access: 'owner' },
    );
    await flush();
    expect(h.domain.inbox.get('AR', todo.id)).toMatchObject({ state: 'resolved' });
    expect(h.repos.messages.list('AR')).toHaveLength(sent);
    expect(ownerCount()).toBe(0);
  });

  it('counts the deadline from the configured minutes', async () => {
    await harness((c) => {
      roomy(c);
      c.team.limits.obligationMinutes = 5;
    });
    const key = await create();
    await requestMerge(key);
    await sweep();
    expect(rows(key)[0]!.dueAt).toBe('2026-10-19T10:05:00.000Z');
    minutes(5);
    await sweep();
    expect(reminders(key)).toHaveLength(1);
    expect(events('obligation_woken')[0]).toMatchObject({ data: { minutes: 5 } });
  });

  describe('pauses', () => {
    it('does not count the time a question of a person stands open on the card', async () => {
      await harness();
      const key = await create();
      await requestMerge(key);
      await sweep();
      minutes(10);
      const question = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        taskKey: key,
        assignees: ['owner'],
        title: 'Which way?',
        payload: { question: 'Which way?', requestedRecipient: 'owner', recipient: 'owner' },
        options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
      });
      await sweep();
      expect(rows(key)[0]).toMatchObject({ pauseReason: 'inbox' });
      minutes(120);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      await h.domain.inbox.resolve(
        'AR',
        question.id,
        { optionId: 'answer', note: 'Straight on' },
        { handle: 'owner', access: 'owner' },
      );
      await sweep();
      expect(rows(key)[0]).toMatchObject({ pausedSince: null, dueAt: '2026-10-19T12:40:00.000Z' });
      minutes(29);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      minutes(2);
      await sweep();
      expect(reminders(key)).toHaveLength(1);
    });

    it('stands still while the team is paused', async () => {
      await harness();
      const key = await create();
      await requestMerge(key);
      await sweep();
      await h.domain.pauses.pause({ scope: 'instance' }, { userId: null, source: 'system' });
      minutes(40);
      await sweep();
      expect(rows(key)[0]).toMatchObject({ pauseReason: 'start_refused' });
      minutes(120);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });
  });

  describe('pauses (held and engine)', () => {
    it('does not count the time a holding label stands on the card', async () => {
      await harness();
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      expect(rows(key)).toMatchObject([{ kind: 'work', responsible: 'dev-1' }]);
      minutes(10);
      await h.domain.tasks.changeLabels('AR', key, { add: ['waiting'] }, OWNER_ACTOR);
      await sweep();
      expect(rows(key)[0]).toMatchObject({ pauseReason: 'held' });
      minutes(120);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
      await h.domain.tasks.changeLabels('AR', key, { remove: ['waiting'] }, OWNER_ACTOR);
      await sweep();
      expect(rows(key)[0]).toMatchObject({ pausedSince: null, dueAt: '2026-10-19T12:40:00.000Z' });
    });

    it('does not count the time the responsible’s engine is offline', async () => {
      class SwitchableEngines extends LocalEngineDirectory {
        online = true;
        override get(id: EngineId): EngineHost | null {
          return this.online ? super.get(id) : null;
        }
      }
      const dir = mkdtempSync(join(tmpdir(), 'pm-obligations-'));
      try {
        const engines = new SwitchableEngines({
          ...createLocalEngine(
            {
              worktrees: new FakeWorktreeManager(join(dir, 'worktrees')),
              workspacePath: () => dir,
              claudeTmpRoots: [],
            },
            capturingLogger().logger,
          ),
          id: LOCAL_ENGINE_ID,
        });
        clock = new Date('2026-10-19T10:00:00.000Z');
        integrator.available = true;
        h = await createDomainHarness({
          adjust: roomy,
          now: () => clock,
          engines,
          integratorTodoAccess: { available: () => integrator.available },
        });
        const key = await create();
        await requestMerge(key);
        await sweep();
        engines.online = false;
        minutes(40);
        await sweep();
        expect(rows(key)[0]).toMatchObject({ pauseReason: 'start_refused' });
        minutes(180);
        await sweep();
        expect(reminders(key)).toHaveLength(0);
        expect(todos()).toHaveLength(0);
        engines.online = true;
        await sweep();
        expect(rows(key)[0]).toMatchObject({ pausedSince: null, dueAt: '2026-10-19T14:10:00.000Z' });
        expect(reminders(key)).toHaveLength(0);
      } finally {
        await h?.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /** The same rule on the other kinds: one reminder to the responsible, then one todo, nothing in the owners' inbox. */
  /** The woken sessions of the card do a turn that does not do the step, and end it. */
  const endTurns = async (key: string) => {
    for (const session of h.domain.sessions.list('AR', { taskKey: key }))
      if (h.domain.sessions.isRunning(session.id)) {
        h.runner.setState(session.id, 'working');
        h.runner.setState(session.id, 'idle');
      }
    await flush();
  };
  const oneReminderOneTodo = async (key: string, responsible: string) => {
    minutes(31);
    await sweep();
    expect(reminders(key)).toHaveLength(1);
    expect(reminders(key)[0]).toMatchObject({ from: 'system', to: [responsible], kind: 'action' });
    expect(todos()).toHaveLength(0);
    await endTurns(key);
    minutes(31);
    await sweep();
    expect(todos()).toHaveLength(1);
    expect(questionPayloadOf(todos()[0]!)).toMatchObject({ recipient: 'integrator' });
    minutes(180);
    await sweep();
    await sweep();
    expect(reminders(key)).toHaveLength(1);
    expect(todos()).toHaveLength(1);
    expect(ownerCount()).toBe(0);
  };
  const stopSessions = async () => {
    for (const session of h.domain.sessions.list('AR')) await h.domain.sessions.stop('AR', session.id);
  };

  describe('work', () => {
    /** A card in development whose developer's session ended without a result. */
    const openWork = async () => {
      await harness();
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      return key;
    };

    it('reminds the assignee once, then hands the work to the integrator once', async () => {
      const key = await openWork();
      expect(rows(key)).toMatchObject([{ kind: 'work', responsible: 'dev-1' }]);
      await oneReminderOneTodo(key, 'dev-1');
      expect(questionPayloadOf(todos()[0]!)).toMatchObject({
        obligation: { kind: 'work', responsible: 'dev-1' },
      });
    });

    it('is not tracked while the assignee works on it from the start', async () => {
      await harness();
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
      await flush();
      const session = h.domain.sessions.list('AR').find((s) => s.member === 'dev-1')!;
      h.runner.setState(session.id, 'working');
      await sweep();
      expect(rows(key)).toEqual([]);
      minutes(120);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
    });

    it('gives the assignee more time instead of a reminder while it works', async () => {
      const key = await openWork();
      minutes(10);
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], taskKey: key, text: 'Go on.' });
      await flush();
      const session = h.domain.sessions
        .list('AR', { taskKey: key })
        .find((s) => s.member === 'dev-1' && h.domain.sessions.isRunning(s.id))!;
      h.runner.setState(session.id, 'working');
      minutes(25);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(rows(key)[0]).toMatchObject({ state: 'open', wokenAt: null });
      expect(Date.parse(rows(key)[0]!.dueAt)).toBeGreaterThan(clock.getTime());
      minutes(31);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });

    it('does not count the time a session waits for a permission', async () => {
      const key = await openWork();
      await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], taskKey: key, text: 'Go on.' });
      await flush();
      const session = h.domain.sessions
        .list('AR', { taskKey: key })
        .find((s) => s.member === 'dev-1' && h.domain.sessions.isRunning(s.id))!;
      h.runner.setState(session.id, 'waiting_permission');
      minutes(40);
      await sweep();
      expect(rows(key)[0]).toMatchObject({ pauseReason: 'permission' });
      minutes(180);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });

    it('cancels the row and the todo when the card goes back', async () => {
      const key = await openWork();
      minutes(31);
      await sweep();
      await endTurns(key);
      minutes(31);
      await sweep();
      const todo = todos()[0]!;
      await h.domain.tasks.moveToStage('AR', key, 'backlog', OWNER_ACTOR);
      await sweep();
      expect(rows(key)).toEqual([]);
      expect(h.domain.inbox.get('AR', todo.id)).toMatchObject({
        state: 'cancelled',
        resolution: { rule: 'obligation_closed' },
      });
    });

    it('moves the row to the new assignee when the card changes hands', async () => {
      const key = await openWork();
      await h.domain.tasks.update('AR', key, { assignee: 'dev-2' }, OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      expect(h.repos.obligations.listLive('AR', key).map((row) => row.responsible)).toEqual(['dev-2']);
      expect(h.repos.obligations.find('AR', key, 'work', 'dev-1', rows(key)[0]!.subject)).toMatchObject({
        state: 'cancelled',
      });
    });
  });

  describe('refinement and review steps', () => {
    /** The analyst `ana` sets `scope-ok`, the gate of the stage `ready`; a card marked `refine` is refined. */
    const refinery = (c: ProjectConfig) => {
      roomy(c);
      // The project manager takes a stalled turn's report, so no alert of the owners stands on the card.
      const pm = c.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      for (const stage of c.pipeline.stages) if (stage.kind !== 'release') delete stage.gate;
      c.pipeline.stages = c.pipeline.stages.filter((stage) => stage.kind !== 'release');
      c.team.members.push({
        kind: 'ai',
        handle: 'ana',
        displayName: 'ana',
        role: 'business_analyst',
        sponsor: 'owner',
      } as ProjectConfig['team']['members'][number]);
      c.pipeline.labels.push(
        { id: 'scope-ok', name: 'Scope ok', setBy: { duties: ['task_breakdown'], members: ['owner'] } },
        { id: 'refine', name: 'Refine', setBy: 'anyone' },
      );
      c.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue' as const,
        owners: ['owner'],
        columnId: 'todo',
        gate: { conditions: [{ type: 'has_label' as const, label: 'scope-ok' }] },
      });
    };

    it('reminds the analyst once, then hands the refinement turn to the integrator once', async () => {
      await harness(refinery);
      const key = await create();
      await h.domain.tasks.changeLabels('AR', key, { add: ['refine'] }, OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      expect(rows(key)).toMatchObject([{ kind: 'refinement_turn', responsible: 'ana' }]);
      await oneReminderOneTodo(key, 'ana');
    });

    it('is fulfilled when the label is set in time', async () => {
      await harness(refinery);
      const key = await create();
      await h.domain.tasks.changeLabels('AR', key, { add: ['refine'] }, OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      const subject = rows(key)[0]!.subject;
      minutes(10);
      await h.domain.tasks.changeLabels('AR', key, { add: ['scope-ok'] }, OWNER_ACTOR);
      await flush();
      await sweep();
      // The card now stands in the ready queue: the start offer to the pm is its own row (PM-804).
      expect(rows(key).filter((row) => row.kind === 'refinement_turn')).toEqual([]);
      expect(h.repos.obligations.find('AR', key, 'refinement_turn', 'ana', subject)).toMatchObject({
        state: 'fulfilled',
      });
      minutes(120);
      await sweep();
      // Only the pm's start offer (PM-804) is left to remind; the analyst's turn is over.
      expect(reminders(key).filter((m) => m.to.includes('ana'))).toHaveLength(0);
    });

    it('opens no review step for a card of a queue stage that waits for the analyst’s label', async () => {
      await harness(refinery);
      const key = await create();
      await flush();
      await stopSessions();
      await sweep();
      expect(rows(key)).toEqual([]);
      minutes(120);
      await sweep();
      expect(rows(key)).toEqual([]);
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });

    it('follows a card under refinement by its refinement turn alone', async () => {
      await harness(refinery);
      const key = await create();
      await h.domain.tasks.changeLabels('AR', key, { add: ['refine'] }, OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      expect(rows(key).map((row) => row.kind)).toEqual(['refinement_turn']);
      minutes(31);
      await sweep();
      expect(rows(key).map((row) => row.kind)).toEqual(['refinement_turn']);
    });
  });

  /** PM-809: the step of an AI owner of a `step` stage (the code review of the test project, owner `cr`). */
  describe('review step', () => {
    /** A card entered the code review, whose sessions all stopped. */
    const inReview = async () => {
      await harness();
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'code_review', OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      return key;
    };
    const reviewer = aiActor('cr');
    const setReviewOwners = (owners: string[]) =>
      h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        config.pipeline.stages.find((s) => s.id === 'code_review')!.owners = owners;
        return 'Set the owners of the code review';
      });
    const review = (key: string) =>
      h.repos.obligations.listLive('AR', key).filter((r) => r.kind === 'review_step');
    const crSessions = (key: string) =>
      h.domain.sessions.list('AR', { taskKey: key }).filter((s) => s.member === 'cr');
    const movedBack = async (key: string) => {
      await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
      await flush();
      await stopSessions();
    };

    it('reminds the reviewer once, then hands the step to the integrator once', async () => {
      const key = await inReview();
      const stage = h.domain.tasks.get('AR', key);
      expect(review(key)).toMatchObject([
        {
          responsible: 'cr',
          subject: `code_review@${stage.stageEnteredAt}`,
          openedAt: stage.stageEnteredAt,
        },
      ]);
      await oneReminderOneTodo(key, 'cr');
      expect(reminders(key)[0]!.body).toContain('the Code review step of');
      expect(reminders(key)[0]!.body).toContain('(code-review-ok or code-review-changes)');
      expect(questionPayloadOf(todos()[0]!)).toMatchObject({
        obligation: { kind: 'review_step', responsible: 'cr' },
      });
      expect(questionPayloadOf(todos()[0]!)!.screening?.todo?.expected).toContain(
        'a result label (code-review-ok or code-review-changes) is set on',
      );
      expect(events('obligation_woken')).toHaveLength(1);
      expect(events('obligation_handed_over')).toHaveLength(1);
    });

    it('gives the reviewer more time instead of a reminder while its session works', async () => {
      const key = await inReview();
      minutes(10);
      await h.domain.messaging.send('AR', 'owner', { to: ['cr'], taskKey: key, text: 'Go on.' });
      await flush();
      const session = crSessions(key).find((s) => h.domain.sessions.isRunning(s.id))!;
      h.runner.setState(session.id, 'working');
      minutes(25);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(review(key)[0]).toMatchObject({ state: 'open', wokenAt: null });
      expect(Date.parse(review(key)[0]!.dueAt)).toBeGreaterThan(clock.getTime());
      minutes(31);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });

    it('sends the reminder into the idle session that holds the card', async () => {
      await harness();
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'code_review', OWNER_ACTOR);
      await flush();
      await endTurns(key);
      await sweep();
      expect(review(key)).toHaveLength(1);
      const sessions = crSessions(key).map((s) => s.id);
      expect(sessions).toHaveLength(1);
      minutes(31);
      await sweep();
      expect(reminders(key)).toHaveLength(1);
      expect(reminders(key)[0]).toMatchObject({ to: ['cr'], kind: 'action' });
      expect(crSessions(key).map((s) => s.id)).toEqual(sessions);
    });

    it('is fulfilled when the result label is set in time, with no reminder and no todo', async () => {
      const key = await inReview();
      const subject = review(key)[0]!.subject;
      minutes(10);
      await h.domain.tasks.changeLabels('AR', key, { add: ['code-review-ok'] }, reviewer);
      await flush();
      await stopSessions();
      await sweep();
      expect(review(key)).toEqual([]);
      expect(h.repos.obligations.find('AR', key, 'review_step', 'cr', subject)).toMatchObject({
        state: 'fulfilled',
      });
      minutes(120);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });

    it('is fulfilled when the card moves on', async () => {
      const key = await inReview();
      const subject = review(key)[0]!.subject;
      await h.domain.tasks.changeLabels('AR', key, { add: ['code-review-ok'] }, reviewer);
      await h.domain.tasks.changeLabels('AR', key, { add: ['merge-ok'] }, OWNER_ACTOR);
      await flush();
      await stopSessions();
      expect(h.domain.tasks.get('AR', key).stageId).not.toBe('code_review');
      await sweep();
      expect(h.repos.obligations.find('AR', key, 'review_step', 'cr', subject)).toMatchObject({
        state: 'fulfilled',
      });
      minutes(120);
      await sweep();
      expect(reminders(key)).toHaveLength(0);
    });

    it('is fulfilled by another result of the label group, and does not open again for that entry', async () => {
      const key = await inReview();
      const subject = review(key)[0]!.subject;
      await h.domain.tasks.changeLabels('AR', key, { add: ['code-review-changes'] }, reviewer, {
        comment: 'Fix the tests.',
      });
      await flush();
      await stopSessions();
      await sweep();
      expect(h.repos.obligations.find('AR', key, 'review_step', 'cr', subject)).toMatchObject({
        state: 'fulfilled',
      });
      expect(h.domain.tasks.get('AR', key).stageId).toBe('code_review');
      minutes(120);
      await sweep();
      await sweep();
      expect(review(key)).toEqual([]);
      expect(reminders(key).filter((m) => m.to.includes('cr'))).toHaveLength(0);
      expect(todos()).toHaveLength(0);
    });

    it('is cancelled when the card goes back, and a new entry is a new step with a new clock', async () => {
      const key = await inReview();
      const first = review(key)[0]!;
      minutes(31);
      await sweep();
      await endTurns(key);
      minutes(31);
      await sweep();
      const todo = todos()[0]!;
      await movedBack(key);
      await sweep();
      expect(review(key)).toEqual([]);
      expect(h.repos.obligations.find('AR', key, 'review_step', 'cr', first.subject)).toMatchObject({
        state: 'cancelled',
      });
      expect(h.domain.inbox.get('AR', todo.id)).toMatchObject({
        state: 'cancelled',
        resolution: { rule: 'obligation_closed' },
      });
      // The change request of the first round stays on the card: it is not the result of the new entry.
      minutes(5);
      await h.domain.tasks.changeLabels('AR', key, { add: ['code-review-changes'] }, reviewer, {
        comment: 'Again.',
      });
      minutes(1);
      await h.domain.tasks.moveToStage('AR', key, 'code_review', OWNER_ACTOR);
      await flush();
      await stopSessions();
      minutes(5);
      await sweep();
      const second = review(key);
      expect(second).toHaveLength(1);
      expect(second[0]!.subject).not.toBe(first.subject);
      expect(second[0]!.openedAt).toBe(h.domain.tasks.get('AR', key).stageEnteredAt);
      expect(Date.parse(second[0]!.dueAt)).toBeGreaterThan(clock.getTime());
    });

    it('cancels the row when the responsible stops owning the stage', async () => {
      const key = await inReview();
      const subject = review(key)[0]!.subject;
      await setReviewOwners(['dev-2']);
      await sweep();
      expect(review(key).map((r) => r.responsible)).toEqual([]);
      expect(h.repos.obligations.find('AR', key, 'review_step', 'cr', subject)).toMatchObject({
        state: 'cancelled',
      });
    });

    it('opens no step for a card imported into the stage, and opens one when the card enters it again', async () => {
      await harness();
      const task = await h.domain.tasks.create(
        'AR',
        { title: 'Imported review', stageId: 'code_review', importedAt: '2026-01-01T09:00:00.000Z' },
        OWNER_ACTOR,
      );
      await flush();
      await stopSessions();
      await sweep();
      minutes(120);
      await sweep();
      expect(review(task.key)).toEqual([]);
      expect(reminders(task.key)).toHaveLength(0);
      expect(todos()).toHaveLength(0);
      await movedBack(task.key);
      minutes(1);
      await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      expect(review(task.key)).toMatchObject([{ responsible: 'cr' }]);
    });

    describe('pauses', () => {
      it('stands still while a question of a person or waiting-answer stands on the card', async () => {
        const key = await inReview();
        minutes(10);
        const question = h.domain.inbox.create({
          projectKey: 'AR',
          kind: 'question',
          source: 'dev-1',
          taskKey: key,
          assignees: ['owner'],
          title: 'Which way?',
          payload: { question: 'Which way?', requestedRecipient: 'owner', recipient: 'owner' },
          options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
        });
        await sweep();
        expect(review(key)[0]).toMatchObject({ state: 'open', pauseReason: 'inbox' });
        minutes(120);
        await sweep();
        expect(reminders(key)).toHaveLength(0);
        await h.domain.inbox.resolve(
          'AR',
          question.id,
          { optionId: 'answer', note: 'Straight on' },
          { handle: 'owner', access: 'owner' },
        );
        await sweep();
        expect(review(key)[0]).toMatchObject({ state: 'open', pausedSince: null });
        await h.domain.tasks.changeLabels('AR', key, { add: ['waiting'] }, OWNER_ACTOR);
        await sweep();
        expect(review(key)[0]).toMatchObject({ state: 'open', pauseReason: 'held' });
        minutes(120);
        await sweep();
        expect(reminders(key)).toHaveLength(0);
        await h.domain.tasks.changeLabels('AR', key, { remove: ['waiting'] }, OWNER_ACTOR);
        await sweep();
        expect(review(key)[0]).toMatchObject({ pausedSince: null, dueAt: '2026-10-19T14:40:00.000Z' });
        minutes(29);
        await sweep();
        expect(reminders(key)).toHaveLength(0);
        minutes(2);
        await sweep();
        expect(reminders(key)).toHaveLength(1);
      });

      it('stands still while a fix round limit holds the card', async () => {
        const key = await inReview();
        h.repos.taskFixLimits.save({
          taskKey: key,
          projectKey: 'AR',
          countedFrom: null,
          extraRounds: 0,
          holdPhase: 'lead',
          heldAt: clock.toISOString(),
          decider: 'dev-2',
          deciders: [],
          reason: 'passed_on',
          inboxItemId: null,
        });
        expect(h.domain.tasks.get('AR', key).fixLimit).toBeDefined();
        minutes(10);
        await sweep();
        expect(review(key)[0]).toMatchObject({ state: 'open', pauseReason: 'held' });
        minutes(120);
        await sweep();
        // The decider's own `fix_limit` step is woken (PM-807); the review step stays silent.
        expect(reminders(key).filter((message) => message.to.includes('cr'))).toHaveLength(0);
        expect(todos().filter((item) => questionPayloadOf(item)?.obligation?.kind === 'review_step')).toEqual(
          [],
        );
      });
    });

    it('has no review step while a merge of the card is going on, only the merge', async () => {
      const key = await inReview();
      expect(review(key)).toHaveLength(1);
      await requestMerge(key);
      await sweep();
      expect(review(key)).toEqual([]);
      expect(rows(key).map((row) => row.kind)).toEqual(['merge']);
    });

    it('opens no step for a stage of people, or for a reviewer who is the author of the card', async () => {
      await harness((c) => {
        roomy(c);
        c.pipeline.stages.find((s) => s.id === 'code_review')!.owners = ['owner'];
      });
      const people = await create();
      await h.domain.tasks.moveToStage('AR', people, 'code_review', OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      minutes(120);
      await sweep();
      expect(rows(people)).toEqual([]);
      await setReviewOwners(['cr']);
      const authored = await create('Authored by the reviewer');
      await h.domain.tasks.update('AR', authored, { assignee: 'cr' }, OWNER_ACTOR);
      await h.domain.tasks.moveToStage('AR', authored, 'code_review', OWNER_ACTOR);
      await flush();
      await stopSessions();
      await sweep();
      expect(review(authored)).toEqual([]);
    });

    it('ends the rows of a queue stage on the first round, with no reminder and no todo', async () => {
      await harness();
      const key = await create();
      const at = clock.toISOString();
      const open = h.domain.obligations.open({
        projectKey: 'AR',
        taskKey: key,
        kind: 'review_step',
        responsible: 'cr',
        subject: `backlog@${at}`,
        openedAt: at,
      });
      const handed = h.domain.obligations.open({
        projectKey: 'AR',
        taskKey: key,
        kind: 'review_step',
        responsible: 'dev-2',
        subject: `backlog@${at}`,
        openedAt: at,
      });
      const item = await h.domain.inbox.openIntegratorTodo({
        projectKey: 'AR',
        taskKey: key,
        askedBy: 'system',
        question: 'dev-2 has not finished the backlog step',
        todo: { what: 'It stands.', where: key, expected: 'It is done.' },
        obligation: { id: handed.id, kind: 'review_step', responsible: 'dev-2', openedAt: at },
      });
      h.repos.obligations.update(handed.id, { handedOverAt: at, inboxItemId: item.itemId }, at);
      // A question of a person stands on the card: it holds a row of other kinds, but not these.
      h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        taskKey: key,
        assignees: ['owner'],
        title: 'Which way?',
        payload: { question: 'Which way?', requestedRecipient: 'owner', recipient: 'owner' },
        options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
      });
      minutes(120);
      await sweep();
      expect(rows(key)).toEqual([]);
      for (const row of [open, handed])
        expect(h.repos.obligations.get(row.id)).toMatchObject({ state: 'cancelled' });
      expect(h.domain.inbox.get('AR', item.itemId)).toMatchObject({
        state: 'cancelled',
        resolution: { rule: 'obligation_closed' },
      });
      expect(events('obligation_woken')).toHaveLength(0);
      expect(reminders(key)).toHaveLength(0);
    });

    it('sends no second reminder and opens no second todo after a double sweep or a restart', async () => {
      await harness(roomy, true);
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'code_review', OWNER_ACTOR);
      await flush();
      await endTurns(key);
      await stopSessions();
      await sweep();
      minutes(31);
      await sweep();
      await sweep();
      expect(reminders(key)).toHaveLength(1);
      await restart();
      await sweep();
      expect(reminders(key)).toHaveLength(1);
      await endTurns(key);
      minutes(31);
      await sweep();
      await sweep();
      expect(todos()).toHaveLength(1);
      await restart();
      minutes(60);
      await sweep();
      await sweep();
      expect(reminders(key)).toHaveLength(1);
      expect(todos()).toHaveLength(1);
      expect(events('obligation_woken')).toHaveLength(1);
      expect(events('obligation_handed_over')).toHaveLength(1);
    });
  });

  describe('after a restart', () => {
    it('sends no second reminder and opens no second todo', async () => {
      await harness(roomy, true);
      const key = await create();
      await h.domain.tasks.moveToStage('AR', key, 'development', OWNER_ACTOR);
      await flush();
      // The developer's session ends without a result; the step stays open.
      for (const session of h.domain.sessions.list('AR')) await h.domain.sessions.stop('AR', session.id);
      await sweep();
      minutes(31);
      await sweep();
      expect(rows(key)).toMatchObject([{ kind: 'work', responsible: 'dev-1' }]);
      expect(reminders(key)).toHaveLength(1);
      await restart();
      await sweep();
      expect(reminders(key)).toHaveLength(1);
      minutes(31);
      await sweep();
      expect(todos()).toHaveLength(1);
      await restart();
      minutes(31);
      await sweep();
      await sweep();
      expect(reminders(key)).toHaveLength(1);
      expect(todos()).toHaveLength(1);
      expect(events('obligation_woken')).toHaveLength(1);
      expect(events('obligation_handed_over')).toHaveLength(1);
    });

    it('finds the todo again when the crash came before the row was written', async () => {
      await harness();
      const key = await create();
      await requestMerge(key);
      for (const n of [31, 31]) {
        minutes(n);
        await sweep();
      }
      const row = rows(key)[0]!;
      const todo = todos()[0]!;
      // The crash: the todo exists, the row still waits for its second deadline. The responsible's
      // session started meanwhile, so the deadline is counted from its activity.
      h.repos.db
        .prepare(
          "UPDATE obligations SET state = 'open', handed_over_at = NULL, inbox_item_id = NULL WHERE id = ?",
        )
        .run(row.id);
      minutes(31);
      await sweep();
      expect(todos()).toHaveLength(1);
      expect(rows(key)[0]).toMatchObject({ state: 'handed_over', inboxItemId: todo.id });
    });
  });
});
