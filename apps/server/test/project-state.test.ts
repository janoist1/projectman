import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';
import { flush, planUsage } from './helpers/fakes';
import { TEAM_TOOLS } from '../src/mcp';
import { formatProjectState } from '../src/mcp/format';

let h: DomainHarness;
afterEach(async () => {
  await h?.cleanup();
});
const operator = { sessionId: 'ses_operator', projectKey: 'AR', member: 'operator', taskKey: null };
const report = (key = 'AR-1') => h.domain.projectState.task('AR', key);

describe('project state from server records', () => {
  it.each([undefined, 'report', 'unblock', 'drive'] as const)(
    'reports the watch level %s through get_project_state',
    async (level) => {
      h = await createDomainHarness({
        adjust: (config) => {
          config.team.operatorWatch = level;
        },
      });
      expect(await h.domain.teamTools.getProjectState(operator, {})).toHaveProperty(
        'operatorWatch',
        level ?? 'report',
      );
      const tool = TEAM_TOOLS.find((t) => t.name === 'get_project_state')!;
      expect(await tool.run({ ctx: operator, args: {}, handler: h.domain.teamTools })).toContain(
        `Operator watch: ${level ?? 'report'}.`,
      );
    },
  );
  it('reports the shared TaskWait result before other reasons', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    h.repos.tasks.update(task.id, { status: 'blocked' });
    const state = await report();
    const config = await h.domain.projects.config('AR');
    expect(state.wait).toEqual(h.domain.taskWaits.ofCard(config, h.domain.tasks.get('AR', task.key), null));
    expect(state.wait?.reason).toBe('blocked');
    expect(formatProjectState(state).split('\n')[1]).toBe(
      '- blocked: the card is blocked: someone has to unblock it.',
    );
  });

  it('reports only delivered active public signals, sorted and scoped to their card', async () => {
    let now = new Date('2026-10-01T10:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
    const first = await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const second = await h.domain.tasks.create('AR', { title: 'Other card' }, OWNER_ACTOR);
    const raise = (
      kind: 'silent' | 'stalled' | 'outage' | 'nobody',
      taskKey: string | null,
      state: 'pending' | 'open' | 'accepted' | 'dismissed' | 'resolved',
      delivered = true,
      resolved = false,
    ) => {
      now = new Date(now.getTime() + 1000);
      const signal = h.domain.operatorSignals.raise({
        projectKey: 'AR',
        kind,
        caseKey: `${state}:${kind}:${taskKey}:${delivered}:${resolved}`,
        taskKey,
      });
      h.repos.operatorSignals.save({
        ...signal,
        state,
        deliveredAt: delivered ? now.toISOString() : null,
        resolvedAt: resolved ? now.toISOString() : null,
      });
      return signal.id;
    };
    const pending = raise('silent', first.key, 'pending');
    const open = raise('nobody', second.key, 'open');
    const general = raise('outage', null, 'open');
    raise('stalled', first.key, 'pending', false);
    raise('silent', first.key, 'open', true, true);
    for (const state of ['accepted', 'dismissed', 'resolved'] as const) raise('stalled', first.key, state);
    // Active reports are not limited to the channel's seven-day presentation window.
    now = new Date('2026-10-11T10:00:00.000Z');
    const before = h.repos.operatorSignals.list('AR');
    expect((await report(first.key)).signals.map((s) => s.id)).toEqual([pending]);
    expect((await report(second.key)).signals.map((s) => s.id)).toEqual([open]);
    const overview = await h.domain.projectState.overview('AR');
    expect(overview.signals.map((s) => s.id)).toEqual([pending, open, general]);
    for (const signal of overview.signals) {
      expect(signal).not.toHaveProperty('projectKey');
      expect(signal).not.toHaveProperty('caseKey');
      expect(signal).not.toHaveProperty('deliveredAt');
    }
    expect(h.repos.operatorSignals.list('AR')).toEqual(before);
    expect(formatProjectState(overview)).toContain('Signals:\n- signal_silent:');
  });
  it('uses the common Operator guard to refuse internal reports in guest conversations', async () => {
    h = await createDomainHarness({
      adjust: (config) =>
        config.team.members.push({
          kind: 'human',
          handle: 'guest',
          displayName: 'Guest',
          access: 'client',
          roles: [],
        }),
    });
    await h.domain.tasks.create('AR', { title: 'Internal checkout' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'operator', {
      type: 'general',
      with: 'guest',
    });
    for (const args of [{}, { taskKey: 'AR-1' }]) {
      await expect(
        h.domain.teamTools.getProjectState({ ...operator, sessionId: session.id }, args),
      ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('operator_owner_only') });
    }
  });

  it('returns an invalid tool refusal for themes and unknown stages', async () => {
    h = await createDomainHarness();
    const theme = await h.domain.tasks.create('AR', { title: 'Checkout theme', kind: 'theme' }, OWNER_ACTOR);
    await expect(h.domain.teamTools.getProjectState(operator, { taskKey: theme.key })).rejects.toMatchObject({
      code: 'invalid',
    });
    const task = await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    h.repos.tasks.update(task.id, { stageId: 'obsolete' });
    await expect(h.domain.teamTools.getProjectState(operator, { taskKey: task.key })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
  it('reads fix-limit, senior and loop records without changing them', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const at = '2026-10-10T20:00:00.000Z';
    h.repos.taskFixLimits.save({
      taskKey: 'AR-1',
      projectKey: 'AR',
      countedFrom: null,
      extraRounds: 0,
      holdPhase: 'owner',
      heldAt: at,
      decider: null,
      deciders: ['owner'],
      reason: 'passed_on',
      inboxItemId: null,
    });
    h.repos.seniorWaits.create({ id: 'senior_test', projectKey: 'AR', taskKey: 'AR-1', since: at });
    h.repos.taskLoops.create({
      id: 'loop_test',
      projectKey: 'AR',
      taskKey: 'AR-1',
      startedAt: at,
      raisedAt: at,
      lastMessageAt: at,
      members: ['dev-1', 'cr'],
      count: 3,
      notified: null,
      notifiedCount: 0,
      phase: 'owner',
      ownerReason: 'no_watcher',
      deciders: ['owner'],
      inboxItemId: null,
      headCommit: null,
    });
    const before = h.repos.taskLoops.open('AR-1');
    expect((await report()).holds).toEqual(['fix_limit', 'senior_wait', 'loop']);
    expect(h.repos.taskLoops.open('AR-1')).toEqual(before);
  });
  it.each(['ai_limit_reached', 'plan_usage_paused', 'team_paused', 'member_on_leave'] as const)(
    'reports an automatic start waiting for %s',
    async (reason) => {
      h = await createDomainHarness({
        adjust: (c) => {
          if (reason === 'ai_limit_reached') c.team.limits.maxConcurrentAi = 1;
          if (reason === 'member_on_leave') {
            const reviewer = c.team.members.find((m) => m.handle === 'cr')!;
            if (reviewer.kind === 'ai') reviewer.onLeave = true;
          }
        },
      });
      await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
      if (reason === 'ai_limit_reached') await h.domain.messageStarts.startConversation('AR', 'dev-1');
      if (reason === 'plan_usage_paused') h.runnerModule.planUsage.value = planUsage(95);
      if (reason === 'team_paused')
        await h.domain.pauses.pause(
          { scope: 'project', projectKey: 'AR' },
          { source: 'system', userId: null },
        );
      await h.domain.messaging.send('AR', 'owner', { to: ['cr'], taskKey: 'AR-1', text: 'Review checkout' });
      await vi.waitFor(async () => expect((await report()).startWaiting?.reason).toBe(reason));
      const state = await report();
      expect(state.startWaiting?.member).toBe('cr');
      expect(formatProjectState(state)).toContain(reason);
      const overview = await h.domain.projectState.overview('AR');
      expect(overview.waitingStarts).toContainEqual({ taskKey: 'AR-1', member: 'cr', reason });
      expect(overview.paused.project).toBe(reason === 'team_paused');
      expect(state.holds.includes('paused')).toBe(reason === 'team_paused');
    },
  );

  it('reports an open prerequisite from the automatic work start', async () => {
    h = await createDomainHarness();
    const prerequisite = await h.domain.tasks.create('AR', { title: 'API' }, OWNER_ACTOR);
    const task = await h.domain.tasks.create(
      'AR',
      { title: 'Checkout', relations: [{ kind: 'prerequisite', key: prerequisite.key }] },
      OWNER_ACTOR,
    );
    await h.domain.tasks.moveToStage('AR', task.key, 'development', OWNER_ACTOR);
    await vi.waitFor(async () =>
      expect((await report(task.key)).startWaiting?.reason).toBe('prerequisite_open'),
    );
    expect((await report(task.key)).startWaiting?.prerequisites).toEqual([prerequisite.key]);
  });

  it('reports conditional next-stage gates and start blocks using shared rules', async () => {
    h = await createDomainHarness({
      adjust: (c) => {
        c.pipeline.stages.find((s) => s.id === 'development')!.gate = {
          conditions: [
            { type: 'has_label', label: 'merge-ok' },
            { type: 'has_label', label: 'code-review-ok', when: 'waiting' },
          ],
        };
        c.pipeline.stages.find((s) => s.id === 'backlog')!.gate = {
          conditions: [{ type: 'has_label', label: 'merge-ok' }],
        };
      },
    });
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    expect(await report()).toMatchObject({
      missingGateLabels: ['merge-ok'],
      startBlock: { kind: 'approval', label: 'merge-ok' },
    });
  });

  it('includes open questions, owner items and idle sessions, excluding resolved items and ended sessions', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: 'AR-1',
    });
    h.runner.setState(session.id, 'idle');
    await flush();
    const question = await h.domain.teamTools.askHuman(
      { ...operator, member: 'dev-1', taskKey: 'AR-1', sessionId: session.id },
      { question: 'Which checkout?', taskKey: 'AR-1', to: ['owner'] },
    );
    const state = await report();
    expect(state.openQuestions).toEqual([
      expect.objectContaining({ id: question.inboxItemId, from: 'dev-1' }),
    ]);
    expect(state.session).toEqual({
      id: session.id,
      member: 'dev-1',
      state: 'idle',
      since: h.repos.sessions.get(session.id)!.lastActivityAt,
    });
    const overview = await h.domain.projectState.overview('AR');
    expect(overview.sessions).toContainEqual({ ...state.session, taskKey: 'AR-1' });
    expect(overview.stages.find((s) => s.stageId === 'backlog')?.count).toBe(1);
    expect(overview.openOwnerItems).toContainEqual(
      expect.objectContaining({ id: question.inboxItemId, kind: 'question', taskKey: 'AR-1' }),
    );
    expect(formatProjectState(state)).toContain('session_idle');
    h.repos.inbox.close(question.inboxItemId, 'cancelled', null, new Date().toISOString());
    h.repos.sessions.update(session.id, { state: 'exited' });
    expect((await report()).openQuestions).toEqual([]);
    expect((await report()).session).toBeNull();
    expect((await h.domain.projectState.overview('AR')).openOwnerItems).toEqual([]);
  });

  it('allows the Operator to read without an owner request and refuses other callers', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout' }, OWNER_ACTOR);
    await expect(
      h.domain.teamTools.getProjectState({ ...operator, member: 'dev-1' }, {}),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: 'operator_only: only the Operator may read project state.',
    });
    expect(await h.domain.teamTools.getProjectState(operator, {})).toHaveProperty('stages');
    expect(await h.domain.teamTools.getProjectState(operator, { taskKey: 'AR-1' })).toHaveProperty(
      'taskKey',
      'AR-1',
    );
    await expect(h.domain.teamTools.getProjectState(operator, { taskKey: 'OTHER-1' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const tool = TEAM_TOOLS.find((t) => t.name === 'get_project_state')!;
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(
      await tool.run({ ctx: operator, args: { task_key: 'AR-1' }, handler: h.domain.teamTools }),
    ).toContain('AR-1: Checkout');
    expect(await tool.run({ ctx: operator, args: {}, handler: h.domain.teamTools })).toContain(
      'Cards by stage:',
    );
  });
});
