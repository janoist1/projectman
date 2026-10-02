import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertPayloadOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * Decision 31: a card that is being refined (label `refine`, or standing in the refinement stage
 * `plan`) is worked out one step at a time, one member per step. The steps are the labels the gate
 * of `ready` asks for: `scope-ok` (set by the analysts `ana` and `ana2`) and `design-ok` on `ui`
 * cards (set by the designer `des`). Card AR-1 starts in `backlog`.
 */
describe('Refinement line', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const setup =
    (opts: { refine?: boolean; plan?: boolean } = {}) =>
    (config: ProjectConfig) => {
      config.team.limits.maxConcurrentAi = 10;
      for (const stage of config.pipeline.stages) if (stage.kind !== 'release') delete stage.gate;
      config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.kind !== 'release');
      for (const [handle, role] of [
        ['ana', 'business_analyst'],
        ['ana2', 'business_analyst'],
        ['des', 'designer'],
      ] as const)
        config.team.members.push({
          kind: 'ai',
          handle,
          displayName: handle,
          role,
          sponsor: 'owner',
        } as ProjectConfig['team']['members'][number]);
      config.pipeline.labels.push(
        { id: 'ui', name: 'UI', setBy: 'anyone' },
        // The owner may set it by hand too (a person doing a step).
        { id: 'scope-ok', name: 'Scope ok', setBy: { duties: ['task_breakdown'], members: ['owner'] } },
        { id: 'design-ok', name: 'Design ok', setBy: { duties: ['ux_design'] } },
      );
      if (opts.refine !== false)
        config.pipeline.labels.push({ id: 'refine', name: 'Refine', setBy: 'anyone' });
      const stages = config.pipeline.stages;
      stages.splice(
        1,
        0,
        ...(opts.plan
          ? [
              {
                id: 'plan',
                name: 'Plan',
                kind: 'step' as const,
                duty: 'task_breakdown' as const,
                owners: ['ana', 'ana2'],
                columnId: 'todo',
              },
            ]
          : []),
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue' as const,
          owners: ['owner'],
          columnId: 'todo',
          gate: {
            conditions: [
              { type: 'has_label' as const, label: 'scope-ok' },
              { type: 'has_label' as const, label: 'design-ok', when: 'ui' },
            ],
          },
        },
      );
    };

  const task = (key = 'AR-1') => h.domain.tasks.get('AR', key);
  const sessionsOf = (key = 'AR-1') => h.domain.sessions.list('AR', { taskKey: key });
  const members = (key = 'AR-1') =>
    sessionsOf(key)
      .map((s) => s.member)
      .sort();
  const turn = () => h.domain.timeline.latest('AR', 'AR-1', 'refinement_turn');
  const alerts = (reason?: string) =>
    h.domain.inbox.list('AR', { kind: 'alert', taskKey: 'AR-1' }).filter((item) => {
      const payload = alertPayloadOf(item);
      return payload?.alert === 'refinement' && (reason === undefined || payload.reason === reason);
    });
  const label = (change: { add?: string[]; remove?: string[] }, actor = OWNER_ACTOR, key = 'AR-1') =>
    h.domain.tasks.changeLabels('AR', key, change, actor);
  /** The member's session works a turn and ends it. */
  const endTurn = (member: string, key = 'AR-1') => {
    const id = sessionsOf(key).find((s) => s.member === member)!.id;
    h.runner.setState(id, 'working');
    h.runner.setState(id, 'idle');
  };

  async function prepare(opts: Parameters<typeof setup>[0] = {}, labels: string[] = ['ui']) {
    h = await createDomainHarness({ persistent: true, adjust: setup(opts) });
    await h.domain.tasks.create('AR', { title: 'Screen', labels }, OWNER_ACTOR);
  }

  it('starts only the setter of the first missing label when the card gets the refine label', async () => {
    await prepare();
    await label({ add: ['refine'] });

    await vi.waitFor(() => expect(members()).toHaveLength(1));
    expect(members()).toEqual(['ana']);
    expect(turn()?.data).toEqual({ label: 'scope-ok', member: 'ana', reason: 'started' });
    expect(h.domain.refinement.turnMember('AR', 'AR-1')).toBe('ana');
    expect(h.runner.started).toHaveLength(1);
  });

  it('gives the next step to the next member once the previous turn ended', async () => {
    await prepare();
    await label({ add: ['refine'] });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));

    // The member sets its label, and its turn is still going: nobody is started yet.
    h.runner.setState(sessionsOf()[0]!.id, 'working');
    await label({ add: ['scope-ok'] }, aiActor('ana'));
    await flush();
    expect(members()).toEqual(['ana']);

    h.runner.setState(sessionsOf()[0]!.id, 'idle');
    await vi.waitFor(() => expect(members()).toEqual(['ana', 'des']));
    expect(turn()?.data).toEqual({ label: 'design-ok', member: 'des', reason: 'label_set' });
    expect(h.domain.refinement.turnMember('AR', 'AR-1')).toBe('des');
    expect(alerts()).toEqual([]);
  });

  it('removes the label, moves the card and tells who prioritises when the chain ends', async () => {
    await prepare();
    await label({ add: ['refine'] });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));
    await label({ add: ['scope-ok'] }, aiActor('ana'));
    endTurn('ana');
    await vi.waitFor(() => expect(members()).toEqual(['ana', 'des']));
    await label({ add: ['design-ok'] }, aiActor('des'));
    endTurn('des');

    await vi.waitFor(() => expect(task().stageId).toBe('ready'));
    expect(task().labels).not.toContain('refine');
    expect(task().labels).toEqual(expect.arrayContaining(['scope-ok', 'design-ok']));
    expect(turn()?.data).toMatchObject({ label: null, member: null, reason: 'done' });
    expect(h.domain.refinement.turnMember('AR', 'AR-1')).toBeNull();
    expect(alerts('done')).toHaveLength(1);
    expect(alerts('done')[0]).toMatchObject({ assignees: ['owner'], state: 'open' });
    // The card is in the queue stage before development: nobody is started for it.
    await flush();
    expect(members()).toEqual(['ana', 'des']);
    expect(alerts('done')).toHaveLength(1);
  });

  it('goes on when a person sets a label, and goes back when an earlier one is removed', async () => {
    await prepare();
    await label({ add: ['refine'] });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));
    endTurn('ana');
    await flush();

    // The person sets the label by hand: the turn goes on to the designer.
    await label({ add: ['scope-ok'] });
    await vi.waitFor(() => expect(members()).toEqual(['ana', 'des']));
    expect(turn()?.data).toEqual({ label: 'design-ok', member: 'des', reason: 'label_set' });

    // The earlier label is removed while the designer works: it finishes its turn first.
    h.runner.setState(sessionsOf().find((s) => s.member === 'des')!.id, 'working');
    await label({ remove: ['scope-ok'] });
    await flush();
    expect(turn()?.data).toMatchObject({ label: 'design-ok', member: 'des' });
    h.runner.setState(sessionsOf().find((s) => s.member === 'des')!.id, 'idle');

    await vi.waitFor(() =>
      expect(turn()?.data).toEqual({ label: 'scope-ok', member: 'ana', reason: 'label_removed' }),
    );
    // The analyst's session was running: it got a notice, not a new session.
    expect(h.runner.started).toHaveLength(2);
    expect(h.runner.messages.some((m) => m.text.includes('scope-ok'))).toBe(true);
  });

  it('alerts the people once for a step only they can do, and closes the alert when it is done', async () => {
    h = await createDomainHarness({
      persistent: true,
      adjust: (config) => {
        setup()(config);
        config.pipeline.labels.push({
          id: 'sign-off',
          name: 'Sign-off',
          setBy: { members: ['owner'], humansOnly: true },
        });
        config.pipeline.stages
          .find((stage) => stage.id === 'ready')!
          .gate!.conditions.push({ type: 'has_label', label: 'sign-off' });
      },
    });
    await h.domain.tasks.create('AR', { title: 'Screen', labels: ['scope-ok'] }, OWNER_ACTOR);
    await label({ add: ['refine'] });

    await vi.waitFor(() => expect(alerts('manual_step')).toHaveLength(1));
    expect(alerts('manual_step')[0]).toMatchObject({ assignees: ['owner'], state: 'open' });
    expect(alertPayloadOf(alerts('manual_step')[0]!)).toMatchObject({ label: 'sign-off' });
    expect(turn()?.data).toEqual({ label: 'sign-off', member: null, reason: 'started' });
    expect(h.runner.started).toHaveLength(0);

    // Looked at again: the same step is not alerted twice.
    await h.domain.refinement.changed(task());
    await h.domain.refinement.changed(task());
    expect(alerts('manual_step')).toHaveLength(1);

    await label({ add: ['sign-off'] });
    await vi.waitFor(() => expect(task().stageId).toBe('ready'));
    expect(alerts('manual_step')[0]).toMatchObject({ state: 'cancelled' });
    expect(h.domain.inbox.list('AR', { kind: 'alert', state: 'open' }).map((i) => alertPayloadOf(i))).toEqual(
      [expect.objectContaining({ alert: 'refinement', reason: 'done' })],
    );
  });

  it('alerts once when the turn ended without the label, and does not start the member again', async () => {
    await prepare();
    await label({ add: ['refine'] });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));

    endTurn('ana');
    await vi.waitFor(() => expect(alerts('stalled')).toHaveLength(1));
    expect(alerts('stalled')[0]).toMatchObject({ assignees: ['owner'], state: 'open' });

    endTurn('ana');
    await flush();
    await h.domain.refinement.changed(task());
    expect(alerts('stalled')).toHaveLength(1);
    expect(h.runner.started).toHaveLength(1);
    expect(h.domain.refinement.turnMember('AR', 'AR-1')).toBe('ana');
  });

  it('starts the line when a card is dragged into a refinement stage, without starting the stage owners', async () => {
    await prepare({ plan: true });
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'plan', OWNER_ACTOR);

    await vi.waitFor(() => expect(members()).toHaveLength(1));
    await flush();
    // One member for the step, not both owners of the stage.
    expect(members()).toEqual(['ana']);
    expect(turn()?.data).toMatchObject({ label: 'scope-ok', member: 'ana' });

    await label({ add: ['scope-ok'] }, aiActor('ana'));
    endTurn('ana');
    await vi.waitFor(() => expect(members()).toEqual(['ana', 'des']));
  });

  it('spreads cards over the setters by load', async () => {
    await prepare({}, []);
    await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR);
    await label({ add: ['refine'] });
    await vi.waitFor(() => expect(members('AR-1')).toEqual(['ana']));
    await label({ add: ['refine'] }, OWNER_ACTOR, 'AR-2');
    await vi.waitFor(() => expect(members('AR-2')).toHaveLength(1));
    expect(members('AR-2')).toEqual(['ana2']);
  });

  it('refuses the Start of a card that is not worked out and starts nobody', async () => {
    await prepare();
    await expect(
      h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER, startSetters: true }),
    ).rejects.toMatchObject({ code: 'gate_blocked' });
    await flush();
    expect(members()).toEqual([]);
    expect(h.repos.deferredStarts.list()).toEqual([]);
    expect(task()).toMatchObject({ stageId: 'backlog', assignee: null });
  });

  it('keeps starting the label setters on a Start in a project without refinement (PM-236)', async () => {
    await prepare({ refine: false });
    const result = await h.domain.taskStarts.start('AR', 'AR-1', {
      actor: OWNER_ACTOR,
      author: OWNER,
      startSetters: true,
    });
    expect(result.awaiting).toBeDefined();
    expect(members().length).toBeGreaterThan(0);
    // The refine label does not exist there: nothing is being refined.
    expect(turn()).toBeNull();
  });

  it('waits when AI work is switched off, and starts the member once it is back on', async () => {
    await prepare();
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = false;
      return 'Switch AI off';
    });
    await label({ add: ['refine'] });

    await vi.waitFor(() =>
      expect(h.repos.deferredStarts.list().map((record) => record.spec)).toEqual([
        { kind: 'refinement_turn', projectKey: 'AR', taskKey: 'AR-1', stageId: 'backlog', label: 'scope-ok' },
      ]),
    );
    expect(members()).toEqual([]);
    expect(turn()).toBeNull();

    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = true;
      return 'Switch AI on';
    });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));
    expect(h.repos.deferredStarts.list()).toEqual([]);
  });

  it('keeps a waiting step over a restart', async () => {
    await prepare();
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = false;
      return 'Switch AI off';
    });
    await label({ add: ['refine'] });
    await vi.waitFor(() => expect(h.repos.deferredStarts.list()).toHaveLength(1));

    h = await restartDomainHarness(h);
    expect(h.repos.deferredStarts.list().map((record) => record.key)).toEqual(['refinement:AR:AR-1']);
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.team.limits.aiEnabled = true;
      return 'Switch AI on';
    });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));
  });

  it('does nothing on a card that is held back by a blocking label', async () => {
    await prepare({}, ['ui', 'waiting']);
    await label({ add: ['refine'] });
    await flush();
    expect(members()).toEqual([]);
    expect(alerts()).toEqual([]);
    expect(turn()?.data).toMatchObject({ label: 'waiting', member: null });
    // The blocker goes: the line goes on.
    await label({ remove: ['waiting'] });
    await vi.waitFor(() => expect(members()).toEqual(['ana']));
  });
});
