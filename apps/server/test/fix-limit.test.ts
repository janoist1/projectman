import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import { SYSTEM_ACTOR, aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { planUsage, settle } from './helpers/fakes';

/**
 * The fix round limit (PM-262). Card AR-1 is carried by `dev-1`; the limit is two rounds here, and a
 * round is a code review change request (the label put on the card). The lead developer is `lead`
 * (technical direction and code review), the planner `arch`; `cr` reviews.
 */

const OWNER_ACCESS = { handle: 'owner', access: 'owner' } as const;
const TASK = { type: 'task', taskKey: 'AR-1' } as const;

describe('fix round limit', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const setup =
    (opts: { lead?: boolean; planner?: boolean } = {}) =>
    (config: ProjectConfig) => {
      config.team.limits.maxConcurrentAi = 10;
      config.team.limits.maxFixRounds = 2;
      if (opts.lead ?? true)
        config.team.members.push({
          kind: 'ai',
          handle: 'lead',
          displayName: 'Lead',
          role: 'lead_developer',
          sponsor: 'owner',
        } as ProjectConfig['team']['members'][number]);
      if (opts.planner ?? true)
        config.team.members.push({
          kind: 'ai',
          handle: 'arch',
          displayName: 'Architect',
          role: 'architect',
          sponsor: 'owner',
        } as ProjectConfig['team']['members'][number]);
    };

  async function prepare(opts: Parameters<typeof setup>[0] = {}) {
    h = await createDomainHarness({ adjust: setup(opts) });
    h.runner.idleOnStart = true;
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await settle();
    expect(task().stageId).toBe('development');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
    await settle();
  }

  /** The reviewer asks for changes: one more round counted. */
  async function round(comment: string) {
    const labels = h.domain.tasks.get('AR', 'AR-1').labels;
    if (labels.includes('code-review-changes'))
      await h.domain.tasks.changeLabels('AR', 'AR-1', { remove: ['code-review-changes'] }, aiActor('cr'));
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['code-review-changes'] }, aiActor('cr'), {
      comment,
    });
    await settle();
  }

  const record = () => h.repos.taskFixLimits.get('AR-1');
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const waiting = () => h.domain.messages.waiting('AR', 'dev-1', TASK).map((m) => m.body);
  const typed = (text: string) => h.runner.messages.some((m) => m.text.includes(text));
  const items = (): InboxItem[] => h.domain.inbox.list('AR', { kind: 'decision', taskKey: 'AR-1' });
  const events = () =>
    h.repos.timeline.list('AR', { taskKey: 'AR-1' }).filter((event) => event.type === 'task_fix_limit');
  /** What a member's sessions of the card got as a notice: in their first input, or typed into them. */
  const told = (member: string): string[] => {
    const sessions = h.runner.started.filter((spec) => spec.member === member);
    return [
      ...sessions.map((spec) => spec.initialMessage ?? ''),
      ...h.runner.messages
        .filter((message) => sessions.some((spec) => spec.sessionId === message.sessionId))
        .map((message) => message.text),
    ];
  };
  /** The notices are not stored as team messages, which the timeline would show in English. */
  const stored = (member: string) =>
    h.repos.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter(
        (event) =>
          event.type === 'team_message' &&
          event.actor.kind === 'system' &&
          (event.data.to as string[]).includes(member),
      );
  const tool = (member: string, decision: 'continue' | 'replan' | 'to_owner', reason = 'Because.') =>
    h.domain.fixLimit.decide(member, 'AR', 'AR-1', decision, reason);

  describe('holding a card at the limit', () => {
    it('lets the first round through and holds the second: its notice waits, the lead is told', async () => {
      await prepare();
      await round('First fix');
      expect(record()?.holdPhase ?? null).toBeNull();
      await vi.waitFor(() => expect(typed('First fix')).toBe(true));

      await round('Second fix');
      expect(record()).toMatchObject({ holdPhase: 'lead', decider: 'lead', extraRounds: 0 });
      expect(waiting()).toEqual(['Code review: changes\n\nSecond fix']);
      expect(typed('Second fix')).toBe(false);
      expect(task().fixLimit).toMatchObject({
        phase: 'lead',
        rounds: 2,
        limit: 2,
        changeRequests: 2,
        decider: 'lead',
      });
      expect(events().map((event) => event.data)).toMatchObject([
        { phase: 'reached', rounds: 2, limit: 2, decider: 'lead' },
      ]);
      await vi.waitFor(() =>
        expect(
          told('lead').filter((text) => text.includes('AR-1 has had 2 fix rounds (the limit is 2)')),
        ).toHaveLength(1),
      );
      expect(stored('lead')).toEqual([]);
      expect(items()).toEqual([]);
    });

    it("tells an AI sender that the assignee's message is held back (PM-144)", async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      const { recipients } = await h.domain.messaging.sendReporting('AR', 'cr', {
        to: ['dev-1'],
        text: 'One more thing',
        taskKey: 'AR-1',
      });
      expect(recipients).toEqual([{ handle: 'dev-1', delivery: 'held', hold: 'fix_limit' }]);
    });

    it('lets a person write to the assignee while the card is held', async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        text: 'Mind the tests',
        taskKey: 'AR-1',
      });
      await vi.waitFor(() => expect(typed('Mind the tests')).toBe(true));
      expect(record()?.holdPhase).toBe('lead');
    });

    it("holds the system's message (a send-back) as well, and lets it through with the hold's end", async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      await h.domain.messaging.send(
        'AR',
        'system',
        { to: ['dev-1'], text: 'The branch moved', taskKey: 'AR-1' },
        { actor: SYSTEM_ACTOR },
      );
      await settle();
      expect(typed('The branch moved')).toBe(false);
      expect(waiting()).toContain('The branch moved');
      await tool('lead', 'continue');
      await vi.waitFor(() => expect(typed('The branch moved')).toBe(true));
    });

    it('lets a paused assignee whose process ended stay stopped while held, with the nudge waiting for the hold', async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      const by = { userId: null, source: 'system' } as const;
      const session = h.domain.sessions.findRunning('AR', 'dev-1', TASK)!;
      h.runner.pauseOutcomes.set(session.id, { point: 'after_tool', tool: 'Bash' });
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
      await vi.waitFor(() => expect(h.domain.sessions.get('AR', session.id).pause?.point).toBe('after_tool'));
      h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
      const starts = h.runner.started.length;
      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
      await settle();
      // Nothing started, and the held notice was not typed in by a restart that skipped admission.
      expect(h.runner.started).toHaveLength(starts);
      expect(waiting()).toEqual(['Code review: changes\n\nSecond fix', 'Nudge after_tool restarted']);
      await tool('lead', 'continue');
      await vi.waitFor(() => expect(h.runner.started).toHaveLength(starts + 1));
      const input = h.runner.started.at(-1)!.initialMessage ?? '';
      expect(input).toContain('Second fix');
      expect(input).toContain('Nudge after_tool restarted');
    });

    it('does not type the held notice into a paused assignee that is still running when the pause ends', async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      const by = { userId: null, source: 'system' } as const;
      const session = h.domain.sessions.findRunning('AR', 'dev-1', TASK)!;
      h.runner.pauseOutcomes.set(session.id, { point: 'idle', tool: null });
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
      await vi.waitFor(() => expect(h.domain.sessions.get('AR', session.id).pause?.point).toBe('idle'));
      const starts = h.runner.started.length;
      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
      await settle();
      expect(typed('Second fix')).toBe(false);
      expect(waiting()).toEqual(['Code review: changes\n\nSecond fix']);
      expect(h.runner.started).toHaveLength(starts);
      await tool('lead', 'continue');
      await vi.waitFor(() => expect(typed('Second fix')).toBe(true));
    });

    it('does not hold a card whose assignee is a person', async () => {
      await prepare();
      h.domain.tasks.assign('AR', 'AR-1', 'owner', OWNER_ACTOR);
      await round('First fix');
      await round('Second fix');
      expect(record()?.holdPhase ?? null).toBeNull();
      expect(task().fixLimit).toBeUndefined();
    });

    it('reports the rounds of the card against the limit', async () => {
      await prepare();
      await round('First fix');
      const config = await h.domain.projects.config('AR');
      expect(h.domain.fixLimit.fixRounds(task(), config)).toEqual({ rounds: 1, limit: 2 });
    });
  });

  describe('the lead decides', () => {
    async function held() {
      await prepare();
      await round('First fix');
      await round('Second fix');
    }

    it('logs a rejected message release after continuing without an unhandled rejection', async () => {
      await held();
      const error = new Error('Message release failed');
      vi.spyOn(h.domain.messaging, 'releaseWaiting').mockRejectedValueOnce(error);
      await tool('lead', 'continue');
      await vi.waitFor(() =>
        expect(h.log.warnings).toContainEqual([
          { err: error, taskKey: 'AR-1' },
          'could not release messages after the fix-limit hold',
        ]),
      );
    });

    it('continue gives one more round: the waiting notice reaches the assignee and the limit is raised', async () => {
      await held();
      await expect(tool('lead', 'continue', 'The plan is fine.')).resolves.toEqual({ phase: 'released' });
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1 });
      await vi.waitFor(() => expect(typed('Second fix')).toBe(true));
      await vi.waitFor(() => expect(typed('The plan is fine.')).toBe(true));
      expect(task().fixLimit).toBeUndefined();
      const config = await h.domain.projects.config('AR');
      expect(h.domain.fixLimit.fixRounds(task(), config)).toEqual({ rounds: 2, limit: 3 });
      expect(events().map((event) => event.data)).toMatchObject([
        { phase: 'reached' },
        { phase: 'decided', decision: 'another_round', by: 'lead', note: 'The plan is fine.' },
      ]);
    });

    it('reaching the limit again after one more round goes to the people', async () => {
      await held();
      await tool('lead', 'continue');
      await round('Third fix');
      expect(record()).toMatchObject({ holdPhase: 'owner', reason: 'again', extraRounds: 1 });
      expect(items()).toHaveLength(1);
      expect(items()[0]).toMatchObject({
        source: 'system',
        assignees: ['owner'],
        options: [{ id: 'replan' }, { id: 'reassign' }, { id: 'another_round' }],
        payload: { fixLimit: { reason: 'again', rounds: 3, limit: 3 } },
      });
      expect(task().fixLimit).toMatchObject({ phase: 'owner', reason: 'again', deciders: ['owner'] });
    });

    it('replan asks another technical direction holder, who releases the card with a fresh count', async () => {
      await held();
      await expect(tool('lead', 'replan', 'The plan is too loose.')).resolves.toEqual({ phase: 'replan' });
      expect(record()).toMatchObject({ holdPhase: 'replan', decider: 'arch' });
      await vi.waitFor(() =>
        expect(told('arch').filter((text) => text.includes('more exact plan'))).toHaveLength(1),
      );
      expect(stored('arch')).toEqual([]);
      expect(waiting()).toHaveLength(1);
      // Only the planner decides now.
      await expect(tool('lead', 'continue')).rejects.toMatchObject({ code: 'fix_limit_not_decider' });
      await expect(tool('arch', 'replan')).rejects.toMatchObject({ code: 'fix_limit_no_planner' });
      await expect(tool('arch', 'continue', 'Plan written.')).resolves.toEqual({ phase: 'released' });
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
      expect(record()?.countedFrom).not.toBeNull();
      const config = await h.domain.projects.config('AR');
      expect(h.domain.fixLimit.fixRounds(task(), config)).toEqual({ rounds: 0, limit: 2 });
      await vi.waitFor(() => expect(typed('Plan written.')).toBe(true));
    });

    it('to_owner gives the decision to the people with its reason', async () => {
      await held();
      await expect(tool('lead', 'to_owner', 'I cannot judge this.')).resolves.toEqual({ phase: 'owner' });
      expect(record()).toMatchObject({ holdPhase: 'owner', reason: 'passed_on' });
      expect(items()[0]).toMatchObject({
        payload: { fixLimit: { reason: 'passed_on', decider: 'lead', note: 'I cannot judge this.' } },
      });
      expect(events().map((event) => event.data)).toMatchObject([
        { phase: 'reached' },
        { phase: 'passed_on', decider: 'lead', note: 'I cannot judge this.' },
      ]);
    });

    it('refuses a decision when the card is not held, and one of a member who does not decide', async () => {
      await prepare();
      await expect(tool('lead', 'continue')).rejects.toMatchObject({ code: 'fix_limit_not_held' });
      await round('First fix');
      await round('Second fix');
      await expect(tool('arch', 'continue')).rejects.toMatchObject({ code: 'fix_limit_not_decider' });
      await expect(tool('dev-1', 'continue')).rejects.toMatchObject({ code: 'fix_limit_not_decider' });
      expect(record()?.holdPhase).toBe('lead');
    });
  });

  /**
   * PM-420: a decision that lets the card go on starts its assignee when it has no running session and
   * no message was waiting for it; nothing else would have woken it.
   */
  describe('a decision starts an assignee that does not run (PM-420)', () => {
    const startsOfDev = () => h.runner.started.filter((spec) => spec.member === 'dev-1').length;
    const devSessions = () =>
      h.domain.sessions.list('AR', { taskKey: 'AR-1' }).filter((s) => s.member === 'dev-1');
    const lifted = (text: string) => text.includes('The fix round limit on AR-1 was lifted by');

    /** The card is held and its assignee has no session and no waiting message. */
    async function idleHeld(opts: Parameters<typeof prepare>[0] = {}) {
      await prepare(opts);
      await round('First fix');
      await round('Second fix');
      for (const message of h.domain.messages.waiting('AR', 'dev-1', TASK))
        h.domain.messages.markRecipientDelivered(message.id, 'dev-1');
      for (const session of devSessions()) await h.domain.sessions.stop('AR', session.id);
      await settle();
      expect(h.domain.sessions.findRunning('AR', 'dev-1', TASK)).toBeNull();
      expect(waiting()).toEqual([]);
    }

    it('starts the assignee when the lead lets the card go on', async () => {
      await idleHeld();
      const before = startsOfDev();
      await tool('lead', 'continue', 'The plan is fine.');
      await vi.waitFor(() => expect(startsOfDev()).toBe(before + 1));
      expect(h.runner.started.filter((spec) => spec.member === 'dev-1').at(-1)?.initialMessage).toSatisfy(
        (text: string) => lifted(text) && text.includes('Reason: The plan is fine.'),
      );
      expect(devSessions().at(-1)?.startCause).toMatchObject({
        kind: 'fix_limit',
        rounds: 2,
        limit: 3,
      });
    });

    it('starts the assignee when a person lets the card go on with one more round', async () => {
      await idleHeld();
      await tool('lead', 'to_owner', 'Your call.');
      const before = startsOfDev();
      await h.domain.inbox.resolve('AR', items()[0]!.id, { optionId: 'another_round' }, OWNER_ACCESS);
      await vi.waitFor(() => expect(startsOfDev()).toBe(before + 1));
      expect(h.runner.started.filter((spec) => spec.member === 'dev-1').at(-1)?.initialMessage).toSatisfy(
        lifted,
      );
      expect(devSessions().at(-1)?.startCause).toMatchObject({ kind: 'fix_limit' });
    });

    it('starts the assignee when the planner of a replan decision is gone and it is one more round instead', async () => {
      await idleHeld();
      await tool('lead', 'to_owner', 'Your call.');
      expect(items()[0]?.options).toContainEqual(expect.objectContaining({ id: 'replan' }));
      await h.domain.members.retire('AR', 'arch', {}, { actor: OWNER_ACTOR, author: OWNER });
      const before = startsOfDev();
      await h.domain.inbox.resolve('AR', items()[0]!.id, { optionId: 'replan' }, OWNER_ACCESS);
      await vi.waitFor(() => expect(startsOfDev()).toBe(before + 1));
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1 });
    });

    it('starts the planner-released assignee with a fresh count', async () => {
      await idleHeld();
      await tool('lead', 'replan', 'Too loose.');
      const before = startsOfDev();
      await tool('arch', 'continue', 'Plan written.');
      await vi.waitFor(() => expect(startsOfDev()).toBe(before + 1));
    });

    it('starts one session when messages waited for the assignee as well', async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      for (const session of devSessions()) await h.domain.sessions.stop('AR', session.id);
      await settle();
      expect(waiting()).toEqual(['Code review: changes\n\nSecond fix']);
      const before = startsOfDev();
      await tool('lead', 'continue', 'Go on.');
      await vi.waitFor(() => expect(startsOfDev()).toBeGreaterThan(before));
      await settle();
      expect(startsOfDev()).toBe(before + 1);
      expect(waiting()).toEqual([]);
      // The waiting message and the notice are both typed into the one session or its first input.
      const texts = [
        ...h.runner.started
          .filter((spec) => spec.member === 'dev-1')
          .map((spec) => spec.initialMessage ?? ''),
        ...h.runner.messages.map((message) => message.text),
      ].join('\n');
      expect(texts).toContain('Second fix');
      expect(texts).toContain('Go on.');
    });

    it('stores the notice and wakes the assignee once the plan usage allows it', async () => {
      await idleHeld();
      h.runnerModule.planUsage.value = planUsage(95);
      const before = startsOfDev();
      await tool('lead', 'continue', 'Go on.');
      await settle();
      expect(startsOfDev()).toBe(before);
      expect(stored('dev-1')).toHaveLength(1);
      expect(h.repos.deferredStarts.list().map((record) => record.spec)).toContainEqual(
        expect.objectContaining({ kind: 'message_wake', handle: 'dev-1', workItem: TASK }),
      );

      h.runnerModule.planUsage.value = planUsage(30);
      await vi.waitFor(async () => {
        await h.domain.admission.retryDeferred();
        expect(startsOfDev()).toBe(before + 1);
      });
      expect(h.runner.started.filter((spec) => spec.member === 'dev-1').at(-1)?.initialMessage).toContain(
        'was lifted by lead',
      );
      expect(h.repos.deferredStarts.list()).toEqual([]);
    });

    it('does not start a held assignee when the card is sent back into the work stage', async () => {
      await idleHeld();
      const before = startsOfDev();
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
      await settle();
      expect(record()?.holdPhase).toBe('lead');
      expect(startsOfDev()).toBe(before);
      expect(h.repos.deferredStarts.list()).toEqual([]);
    });
  });

  describe('the people decide', () => {
    async function owned() {
      await prepare();
      await round('First fix');
      await round('Second fix');
      await tool('lead', 'to_owner', 'Your call.');
    }
    const resolve = (optionId: string) =>
      h.domain.inbox.resolve('AR', items()[0]!.id, { optionId }, OWNER_ACCESS);

    it('stage change does not close the decision item and decision still works', async () => {
      await owned();
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', aiActor('dev-1'));
      await settle();
      expect(task().stageId).toBe('development');
      expect(items()).toHaveLength(1);
      expect(items()[0]!.state).toBe('open');
      await resolve('reassign');
      await settle();
      expect(record()).toMatchObject({ holdPhase: null, inboxItemId: null, extraRounds: 0 });
      expect(task().fixLimit).toBeUndefined();
      expect(task().assignee).not.toBe('dev-1');
    });

    it('another_round lets the card go on with one more round', async () => {
      await owned();
      await resolve('another_round');
      await settle();
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1, inboxItemId: null });
      expect(task().fixLimit).toBeUndefined();
      await vi.waitFor(() => expect(typed('Second fix')).toBe(true));
      expect(events().map((event) => event.data)).toMatchObject([
        { phase: 'reached' },
        { phase: 'passed_on' },
        { phase: 'decided', decision: 'another_round', by: 'owner' },
      ]);
    });

    it('replan gives the card to another technical direction holder than the lead who passed it on', async () => {
      await owned();
      await resolve('replan');
      await settle();
      expect(record()).toMatchObject({ holdPhase: 'replan', decider: 'arch' });
      await expect(tool('lead', 'continue')).rejects.toMatchObject({ code: 'fix_limit_not_decider' });
      await tool('arch', 'continue', 'Done.');
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
    });

    it('replan is not offered when only the lead could plan', async () => {
      await prepare({ planner: false });
      await round('First fix');
      await round('Second fix');
      await tool('lead', 'to_owner', 'Your call.');
      expect(items()[0]?.options).toMatchObject([{ id: 'reassign' }, { id: 'another_round' }]);
    });

    it('reassign stops the first implementer and starts another one with a fresh count', async () => {
      await owned();
      const startsOf = (member: string) => h.runner.started.filter((spec) => spec.member === member).length;
      const before = startsOf('dev-1');
      const stop = vi.spyOn(h.domain.sessions, 'stopTask');
      await resolve('reassign');
      await settle();
      // The first implementer's own session is left for its handoff note (PM-342).
      expect(stop).toHaveBeenCalledWith(
        'AR',
        'AR-1',
        { kind: 'fix_limit_reassign', by: { kind: 'human', handle: 'owner' } },
        { except: 'dev-1' },
      );
      expect(task().assignee).toBe('dev-2');
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
      expect(h.runner.started.some((spec) => spec.member === 'dev-2')).toBe(true);
      // What waited stays with the first implementer and does not wake it on a card it no longer has.
      expect(startsOf('dev-1')).toBe(before);
      expect(waiting()).toEqual(['Code review: changes\n\nSecond fix']);
      const config = await h.domain.projects.config('AR');
      expect(h.domain.fixLimit.fixRounds(task(), config)).toEqual({ rounds: 0, limit: 2 });
    });

    it('reassign asks the first implementer for a handoff note, and the next one starts with it (PM-342)', async () => {
      await owned();
      const first = h.repos.sessions.findByWorkItem('AR', 'dev-1', TASK)!;
      h.runner.emit({ type: 'transcript_path', sessionId: first.id, path: `/tmp/${first.id}.jsonl` });
      h.runner.setState(first.id, 'working');

      await resolve('reassign');
      await vi.waitFor(() => expect(h.repos.taskHandoffs.open('AR-1')).toMatchObject({ step: 'writing' }));

      expect(h.repos.taskHandoffs.open('AR-1')).toMatchObject({
        from: 'dev-1',
        reason: 'fix_limit_reassign',
        // The next implementer is picked by the start that follows.
        to: 'dev-2',
      });
      expect(h.runner.started.some((spec) => spec.member === 'dev-2')).toBe(false);
      await h.domain.handoffs.recordNote(
        { projectKey: 'AR', member: 'dev-1', sessionId: first.id },
        'AR-1',
        'Two rounds went to the same test.',
      );
      h.runner.setState(first.id, 'idle');
      await vi.waitFor(() => expect(h.runner.started.some((spec) => spec.member === 'dev-2')).toBe(true));
      const input = h.contextBuilder.inputs.filter((i) => i.member.handle === 'dev-2').at(-1)!;
      expect(input.handoff).toMatchObject({ outcome: 'note', note: 'Two rounds went to the same test.' });
    });

    it('puts a reassign decision made while paused off until the team is resumed (PM-219)', async () => {
      await owned();
      const by = { userId: null, source: 'system' } as const;
      await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
      await resolve('reassign');
      await settle();
      // Nobody is stopped or started while the team is paused: the card stays with its holder.
      expect(task().assignee).toBe('dev-1');
      expect(h.runner.started.some((spec) => spec.member === 'dev-2')).toBe(false);
      expect(record()).toMatchObject({ holdPhase: 'owner' });
      await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
      await settle();
      expect(task().assignee).toBe('dev-2');
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
      expect(h.runner.started.some((spec) => spec.member === 'dev-2')).toBe(true);
    });

    it('closes the item by itself when the assignee changes, and when the card is cancelled', async () => {
      await owned();
      const id = items()[0]!.id;
      h.domain.tasks.assign('AR', 'AR-1', 'dev-2', OWNER_ACTOR);
      await settle();
      expect(h.repos.inbox.get(id)).toMatchObject({
        state: 'resolved',
        resolution: { by: 'system', rule: 'fix_limit_ended' },
      });
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
      expect(task().fixLimit).toBeUndefined();
      expect(events().at(-1)?.data).toMatchObject({ phase: 'ended', endReason: 'assignee_changed' });

      await round('Fix 3');
      await round('Fix 4');
      expect(record()?.holdPhase).toBe('lead');
      await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
      await settle();
      expect(record()?.holdPhase ?? null).toBeNull();
      expect(events().at(-1)?.data).toMatchObject({ phase: 'ended', endReason: 'closed' });
    });

    it('closes the item by itself when a person changes the assignee in the card (PATCH), too', async () => {
      await owned();
      const id = items()[0]!.id;
      // The card's drawer changes the assignee only of a card nobody works on: the session is stopped first.
      for (const session of h.repos.sessions.list('AR', { taskKey: 'AR-1' }))
        h.repos.sessions.update(session.id, { state: 'exited' });
      await h.domain.tasks.update('AR', 'AR-1', { assignee: 'dev-2' }, OWNER_ACTOR);
      await settle();
      expect(h.repos.inbox.get(id)).toMatchObject({
        state: 'resolved',
        resolution: { by: 'system', rule: 'fix_limit_ended' },
      });
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
      expect(task().fixLimit).toBeUndefined();
      expect(events().at(-1)?.data).toMatchObject({ phase: 'ended', endReason: 'assignee_changed' });
      const config = await h.domain.projects.config('AR');
      expect(h.domain.fixLimit.fixRounds(task(), config)).toEqual({ rounds: 0, limit: 2 });
    });

    it("a person's Start of the held card is one more round", async () => {
      await prepare();
      await round('First fix');
      await round('Second fix');
      expect(record()?.holdPhase).toBe('lead');
      await h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER });
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 1 });
      await vi.waitFor(() => expect(typed('Second fix')).toBe(true));
    });
  });

  describe('nobody on the team can decide', () => {
    it('goes straight to the people, without the replan button when nobody could plan', async () => {
      await prepare({ lead: false, planner: false });
      await round('First fix');
      await round('Second fix');
      expect(record()).toMatchObject({ holdPhase: 'owner', reason: 'no_ai_decider', decider: null });
      expect(items()[0]).toMatchObject({
        options: [{ id: 'reassign' }, { id: 'another_round' }],
        payload: { fixLimit: { reason: 'no_ai_decider', decider: null } },
      });
    });

    it('the lead has no replan when no other member can plan', async () => {
      await prepare({ planner: false });
      await round('First fix');
      await round('Second fix');
      await expect(tool('lead', 'replan')).rejects.toMatchObject({ code: 'fix_limit_no_planner' });
      expect(record()?.holdPhase).toBe('lead');
    });
  });
});
