import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

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
  const told = (member: string) =>
    h.repos.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((event) => event.type === 'team_message' && (event.data.to as string[]).includes(member));
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
      expect(told('lead').map((event) => event.data.excerpt)).toEqual([
        expect.stringContaining('AR-1 has had 2 fix rounds (the limit is 2)'),
      ]);
      expect(items()).toEqual([]);
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
      expect(told('arch').map((event) => event.data.excerpt)).toEqual([
        expect.stringContaining('more exact plan'),
      ]);
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

  describe('the people decide', () => {
    async function owned() {
      await prepare();
      await round('First fix');
      await round('Second fix');
      await tool('lead', 'to_owner', 'Your call.');
    }
    const resolve = (optionId: string) =>
      h.domain.inbox.resolve('AR', items()[0]!.id, { optionId }, OWNER_ACCESS);

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

    it('replan gives the card to the first technical direction holder, who releases it', async () => {
      await owned();
      await resolve('replan');
      await settle();
      expect(record()).toMatchObject({ holdPhase: 'replan', decider: 'lead' });
      await tool('lead', 'continue', 'Done.');
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
    });

    it('reassign stops the first implementer and starts another one with a fresh count', async () => {
      await owned();
      const stop = vi.spyOn(h.domain.sessions, 'stopTask');
      await resolve('reassign');
      await settle();
      expect(stop).toHaveBeenCalledWith('AR', 'AR-1');
      expect(task().assignee).toBe('dev-2');
      expect(record()).toMatchObject({ holdPhase: null, extraRounds: 0 });
      expect(h.runner.started.some((spec) => spec.member === 'dev-2')).toBe(true);
      const config = await h.domain.projects.config('AR');
      expect(h.domain.fixLimit.fixRounds(task(), config)).toEqual({ rounds: 0, limit: 2 });
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
        h.repos.sessions.update(session.id, { state: 'ended' });
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
