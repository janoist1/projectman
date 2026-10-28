import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateRequestOf } from '@projectman/shared';
import { aiActor, SYSTEM_ACTOR } from '../src/kernel';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

const owner = { handle: 'owner', access: 'owner' as const };

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** A card that lacks only a person's approval for its next stage asks for it by itself (PM-445). */
describe('automatic stage advance', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  async function cardInCodeReview(): Promise<string> {
    const task = await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    return task.key;
  }
  const approve = (key: string) =>
    h.domain.tasks.changeLabels('AR', key, { add: ['code-review-ok'] }, aiActor('cr'));
  const openDecisions = (key: string) =>
    h.domain.inbox.list('AR', { kind: 'decision', state: 'open', taskKey: key });

  it('opens the approval decision when the last other condition is met, once', async () => {
    h = await createDomainHarness();
    const key = await cardInCodeReview();
    await approve(key);
    await settle();

    const [item, ...rest] = openDecisions(key);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ source: 'system', assignees: ['owner'] });
    expect(gateRequestOf(item!)).toMatchObject({
      fromStageId: 'code_review',
      toStageId: 'merge',
      label: 'merge-ok',
    });
    expect(h.domain.tasks.get('AR', key)).toMatchObject({ stageId: 'code_review', status: 'waiting' });

    // Another look at the card does not ask again.
    await h.domain.autoAdvance.check(h.domain.tasks.get('AR', key));
    expect(openDecisions(key)).toHaveLength(1);

    // The approval moves the card, with the label on it.
    await h.domain.inbox.resolve('AR', item!.id, { optionId: 'approve' }, owner);
    expect(h.domain.tasks.get('AR', key)).toMatchObject({ stageId: 'merge', status: 'active' });
  });

  it('does not ask while another condition is open, nor from a work stage', async () => {
    h = await createDomainHarness();
    const key = await cardInCodeReview();
    // Code review has not approved: the gate lacks more than an approval.
    await h.domain.autoAdvance.check(h.domain.tasks.get('AR', key));
    expect(openDecisions(key)).toEqual([]);

    const work = await h.domain.tasks.create('AR', { title: 'In development' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', work.key, 'development', OWNER_ACTOR);
    await h.domain.autoAdvance.check(h.domain.tasks.get('AR', work.key));
    expect(openDecisions(work.key)).toEqual([]);
    expect(h.domain.tasks.get('AR', work.key).stageId).toBe('development');
  });

  it.each(['before', 'after'])(
    'does not repeat an approval request when automatic preparation starts %s the decision closes',
    async (timing) => {
      h = await createDomainHarness({
        adjust: (config) => {
          // A review handover gives the real move preparation an asynchronous boundary to hold.
          config.pipeline.stages.find((s) => s.id === 'merge')!.owners = ['cr'];
        },
      });
      const key = await cardInCodeReview();
      await approve(key);
      await settle();
      const item = openDecisions(key)[0]!;
      const businessEvents = () =>
        // The stage notice to a live session is a stored system message (PM-82), not a business event here.
        h.domain.timeline
          .list('AR', { taskKey: key })
          .filter((e) => !e.type.startsWith('session_') && e.type !== 'team_message');
      const before = businessEvents();
      const waiting = h.domain.tasks.get('AR', key);
      const handler = h.domain.tasks.handleDecisionResolved.bind(h.domain.tasks);
      const closed = barrier();
      const decisionBarrier = barrier();
      const delayedDecision = vi
        .spyOn(h.domain.tasks, 'handleDecisionResolved')
        .mockImplementationOnce(async (resolved) => {
          expect(resolved).toMatchObject({ id: item.id, state: 'resolved' });
          closed.release();
          await decisionBarrier.promise;
          await handler(resolved);
        });
      const sourceHead = h.domain.sessions.sourceHead.bind(h.domain.sessions);
      const preparing = barrier();
      const moveBarrier = barrier();
      const delayedMove = vi
        .spyOn(h.domain.sessions, 'sourceHead')
        .mockImplementationOnce(async (...args) => {
          preparing.release();
          await moveBarrier.promise;
          return sourceHead(...args);
        });
      let automatic: Promise<void> | undefined;
      let resolution: ReturnType<typeof h.domain.inbox.resolve> | undefined;
      try {
        if (timing === 'before') {
          automatic = h.domain.autoAdvance.check(waiting);
          await preparing.promise;
        }
        resolution = h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, owner);
        await closed.promise;
        expect(h.domain.inbox.isResolvingGate('AR', key, 'code_review', 'merge')).toBe(true);
        if (timing === 'after') {
          automatic = h.domain.autoAdvance.check(waiting);
          await preparing.promise;
        }
        moveBarrier.release();
        await automatic;
        expect.soft(businessEvents()).toEqual(before);
        expect.soft(h.domain.inbox.list('AR', { kind: 'decision', taskKey: key })).toHaveLength(1);
        expect.soft(h.domain.tasks.get('AR', key)).toEqual(waiting);

        decisionBarrier.release();
        await resolution;
        expect(h.domain.inbox.isResolvingGate('AR', key, 'code_review', 'merge')).toBe(false);
        await h.domain.autoAdvance.check(h.domain.tasks.get('AR', key));
        // The golden path accounts for exactly two human events before awaitSystem reads its tail.
        for (const event of businessEvents().slice(before.length + 2)) {
          expect(event.actor, `${event.type} that nobody asked for is the system's`).toEqual(SYSTEM_ACTOR);
        }
        expect(businessEvents().slice(0, before.length)).toEqual(before);
        expect(businessEvents().slice(before.length)).toMatchObject([
          {
            type: 'task_labels_changed',
            actor: OWNER_ACTOR,
            data: { added: ['merge-ok'], removed: [], reason: 'approval' },
          },
          {
            type: 'task_stage_changed',
            actor: OWNER_ACTOR,
            data: { from: 'code_review', to: 'merge', approvedBy: ['owner'], inboxItemIds: [item.id] },
          },
        ]);
        expect(h.domain.inbox.list('AR', { kind: 'decision', taskKey: key })).toMatchObject([
          { id: item.id, state: 'resolved', resolution: { optionId: 'approve', by: 'owner' } },
        ]);
        expect(h.domain.tasks.get('AR', key)).toMatchObject({
          stageId: 'merge',
          status: 'active',
          labels: ['code-review-ok', 'merge-ok'],
        });
      } finally {
        moveBarrier.release();
        decisionBarrier.release();
        await automatic;
        await resolution;
        delayedMove.mockRestore();
        delayedDecision.mockRestore();
      }
    },
  );

  it.each(['approve', 'reject'])(
    'keeps simultaneous gate decisions independent while one finishes with %s',
    async (optionId) => {
      h = await createDomainHarness({
        adjust: (config) => {
          config.team.members.push({
            kind: 'human',
            handle: 'approver',
            displayName: 'Second approver',
            access: 'owner',
            roles: ['operator'],
          });
          config.pipeline.labels.push({
            id: 'second-approval',
            name: 'Second approval',
            setBy: { members: ['approver'], humansOnly: true },
          });
          config.pipeline.stages
            .find((s) => s.id === 'merge')!
            .gate!.conditions.push({
              type: 'has_label',
              label: 'second-approval',
            });
        },
      });
      const key = await cardInCodeReview();
      await approve(key);
      await settle();
      const items = openDecisions(key);
      expect(items).toHaveLength(2);
      const first = items.find((item) => item.assignees.includes('owner'))!;
      const second = items.find((item) => item.assignees.includes('approver'))!;
      const gates = items.map(() => ({ closed: barrier(), resume: barrier() }));
      const handler = h.domain.tasks.handleDecisionResolved.bind(h.domain.tasks);
      const delayed = vi.spyOn(h.domain.tasks, 'handleDecisionResolved').mockImplementation(async (item) => {
        const gate = gates[items.findIndex((candidate) => candidate.id === item.id)]!;
        gate.closed.release();
        await gate.resume.promise;
        await handler(item);
      });
      const firstGate = gates[items.indexOf(first)]!;
      const secondGate = gates[items.indexOf(second)]!;
      const resolutions = [
        h.domain.inbox.resolve('AR', first.id, { optionId }, owner),
        h.domain.inbox.resolve('AR', second.id, { optionId: 'approve' }, { ...owner, handle: 'approver' }),
      ];
      const resolving = () => h.domain.inbox.isResolvingGate('AR', key, 'code_review', 'merge');
      try {
        await Promise.all(gates.map((gate) => gate.closed.promise));
        expect(resolving()).toBe(true);
        for (const [project, task, from, to] of [
          ['OTHER', key, 'code_review', 'merge'],
          ['AR', 'AR-999', 'code_review', 'merge'],
          ['AR', key, 'development', 'merge'],
          ['AR', key, 'code_review', 'release'],
        ]) {
          expect(h.domain.inbox.isResolvingGate(project!, task!, from!, to!)).toBe(false);
        }
        firstGate.resume.release();
        await resolutions[0];
        expect(resolving()).toBe(true);
        secondGate.resume.release();
        await resolutions[1];
        expect(resolving()).toBe(false);
        expect(h.domain.tasks.get('AR', key)).toMatchObject({
          stageId: optionId === 'approve' ? 'merge' : 'code_review',
          status: 'active',
        });
        const changes = h.domain.timeline
          .list('AR', { taskKey: key })
          .filter((event) => event.type === 'task_labels_changed' && event.data.reason === 'approval');
        expect(changes).toMatchObject(
          optionId === 'approve'
            ? [
                { actor: OWNER_ACTOR, data: { added: ['merge-ok'], removed: [], reason: 'approval' } },
                {
                  actor: { kind: 'human', handle: 'approver' },
                  data: { added: ['second-approval'], removed: [], reason: 'approval' },
                },
              ]
            : [],
        );
        if (optionId === 'approve') {
          expect(
            h.domain.timeline.list('AR', { taskKey: key }).filter((e) => e.type === 'task_stage_changed'),
          ).toMatchObject([
            { actor: OWNER_ACTOR, data: { from: 'backlog', to: 'code_review' } },
            {
              actor: OWNER_ACTOR,
              data: {
                from: 'code_review',
                to: 'merge',
                approvedBy: ['owner', 'approver'],
                inboxItemIds: items.map((item) => item.id),
              },
            },
          ]);
        } else {
          const retry = await h.domain.tasks.moveToStage('AR', key, 'merge', SYSTEM_ACTOR);
          expect(retry.pendingApproval).toHaveLength(2);
        }
      } finally {
        for (const gate of gates) gate.resume.release();
        await Promise.all(resolutions);
        delayed.mockRestore();
      }
    },
  );

  it('releases a gate decision when closing it fails, so the same approval can be retried', async () => {
    h = await createDomainHarness();
    const key = await cardInCodeReview();
    await approve(key);
    await settle();
    const item = openDecisions(key)[0]!;
    const delayed = vi.spyOn(h.repos.inbox, 'close').mockImplementationOnce(() => {
      expect(h.domain.inbox.isResolvingGate('AR', key, 'code_review', 'merge')).toBe(true);
      throw new Error('injected close failure');
    });
    try {
      await expect(h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, owner)).rejects.toThrow(
        'injected close failure',
      );
      expect(h.domain.inbox.isResolvingGate('AR', key, 'code_review', 'merge')).toBe(false);
      expect(openDecisions(key)).toMatchObject([{ id: item.id }]);
      await h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, owner);
      expect(h.domain.tasks.get('AR', key).stageId).toBe('merge');
    } finally {
      delayed.mockRestore();
    }
  });

  it('releases a refused approval handover so committed work can request approval again', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.pipeline.stages.find((s) => s.id === 'merge')!.owners = ['cr'];
      },
    });
    const key = await cardInCodeReview();
    await approve(key);
    await settle();
    const item = openDecisions(key)[0]!;
    const dirty = vi.spyOn(h.domain.sessions, 'sourceHead').mockResolvedValueOnce({
      path: h.workspace,
      branch: 'task/AR-1',
      commit: 'c1',
      dirty: true,
      changes: 1,
      committedAt: null,
    });
    try {
      await h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, owner);
      expect(h.domain.inbox.isResolvingGate('AR', key, 'code_review', 'merge')).toBe(false);
      expect(h.domain.tasks.get('AR', key)).toMatchObject({ stageId: 'code_review', status: 'active' });
      expect(h.domain.timeline.list('AR', { taskKey: key }).at(-1)).toMatchObject({
        type: 'task_updated',
        actor: OWNER_ACTOR,
        data: { gateBlocked: { to: 'merge', reason: 'handover_uncommitted' } },
      });
      const retry = await h.domain.tasks.moveToStage('AR', key, 'merge', SYSTEM_ACTOR);
      expect(retry.pendingApproval).toHaveLength(1);
      await h.domain.inbox.resolve('AR', retry.pendingApproval[0]!.id, { optionId: 'approve' }, owner);
      expect(h.domain.tasks.get('AR', key).stageId).toBe('merge');
    } finally {
      dirty.mockRestore();
    }
  });

  it('does not ask again after the approver rejected the request in this stay in the stage', async () => {
    h = await createDomainHarness();
    const key = await cardInCodeReview();
    await approve(key);
    await settle();
    await h.domain.inbox.resolve('AR', openDecisions(key)[0]!.id, { optionId: 'reject' }, owner);

    await h.domain.autoAdvance.check(h.domain.tasks.get('AR', key));
    expect(openDecisions(key)).toEqual([]);
    expect(h.domain.tasks.get('AR', key).stageId).toBe('code_review');

    // A change of the card's labels may change their mind: the system asks again.
    await h.domain.tasks.changeLabels('AR', key, { add: ['checkout'] }, OWNER_ACTOR);
    await settle();
    expect(openDecisions(key)).toHaveLength(1);
  });

  it('moves the card by itself when nothing but the stage is missing', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const merge = config.pipeline.stages.find((s) => s.id === 'merge')!;
        merge.gate = { conditions: [{ type: 'has_label', label: 'code-review-ok' }] };
      },
    });
    const key = await cardInCodeReview();
    await approve(key);
    await settle();

    expect(h.domain.tasks.get('AR', key).stageId).toBe('merge');
    expect(openDecisions(key)).toEqual([]);
  });

  it('does not move the card while a member works on it, and moves it when the session goes idle', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const merge = config.pipeline.stages.find((s) => s.id === 'merge')!;
        merge.gate = { conditions: [{ type: 'has_label', label: 'code-review-ok' }] };
      },
    });
    const key = await cardInCodeReview();
    await settle();
    const [reviewer] = h.repos.sessions.list('AR', { taskKey: key });
    expect(reviewer).toBeDefined();

    h.runner.setState(reviewer!.id, 'working');
    await settle();
    await approve(key);
    await settle();
    expect(h.domain.tasks.get('AR', key).stageId).toBe('code_review');

    // The round ends: the card is looked at again and goes on.
    h.runner.setState(reviewer!.id, 'idle');
    await settle();
    expect(h.domain.tasks.get('AR', key).stageId).toBe('merge');
  });

  it('asks for a card that got stuck before, in the sweep after the start', async () => {
    h = await createDomainHarness();
    const key = await cardInCodeReview();
    await approve(key);
    await settle();
    // The request is gone (as if the card had been left from before this rule).
    h.domain.inbox.cancel(openDecisions(key)[0]!.id);
    expect(openDecisions(key)).toEqual([]);

    await h.domain.autoAdvance.sweep();
    expect(openDecisions(key)).toHaveLength(1);
  });

  it('runs one advance per card at a time, then one more round for the events that came meanwhile (PM-770)', async () => {
    h = await createDomainHarness();
    const key = await cardInCodeReview();
    const other = await cardInCodeReview();
    await settle();
    const first = barrier();
    const reconcile = vi.spyOn(h.domain.merges, 'reconcile');
    reconcile.mockImplementationOnce(() => first.promise);
    const check = vi.spyOn(h.domain.autoAdvance, 'check');
    const reconciled = (taskKey: string) => reconcile.mock.calls.filter(([, k]) => k === taskKey).length;

    await approve(key);
    await vi.waitFor(() => expect(reconciled(key)).toBe(1));
    // Three more events on the card while the run waits: no second run beside it.
    await h.domain.tasks.changeLabels('AR', key, { remove: ['code-review-ok'] }, aiActor('cr'));
    await approve(key);
    await h.domain.tasks.changeLabels('AR', key, { remove: ['code-review-ok'] }, aiActor('cr'));
    await settle();
    expect(reconciled(key)).toBe(1);
    // Another card is not held back by it.
    await approve(other);
    await vi.waitFor(() => expect(reconciled(other)).toBeGreaterThan(0));

    first.release();
    // One more round, which reads the card as it is now (without the label).
    await vi.waitFor(() => expect(reconciled(key)).toBe(2));
    await settle();
    expect(reconciled(key)).toBe(2);
    const last = check.mock.calls.filter(([card]) => card.key === key).at(-1)![0];
    expect(last.labels).not.toContain('code-review-ok');
    expect(openDecisions(key)).toEqual([]);
  });

  it.each(['done', 'development'])(
    'discards an automatic move when a human moves the card to %s during its preparation',
    async (stageId) => {
      h = await createDomainHarness({
        adjust: (config) => {
          config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.id !== 'release');
        },
      });
      const key = await cardInCodeReview();
      await settle();
      let signalPreparing!: () => void;
      let signalResume!: () => void;
      const preparing = new Promise<void>((resolve) => {
        signalPreparing = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        signalResume = resolve;
      });
      const moveToStage = h.domain.tasks.moveToStage.bind(h.domain.tasks);
      const delayed = vi.spyOn(h.domain.tasks, 'moveToStage').mockImplementationOnce(async (...args) => {
        // Hold the system's move at an async boundary, without relying on machine load or a timer.
        signalPreparing();
        await resume;
        return moveToStage(...args);
      });
      try {
        await approve(key);
        await preparing;
        await h.domain.tasks.update('AR', key, { addLabels: ['merge-ok'], stageId }, OWNER_ACTOR);
        const finished = h.domain.tasks.get('AR', key);
        const moves = () =>
          h.domain.timeline
            .list('AR', { taskKey: key })
            .filter((event) =>
              [
                'task_stage_changed',
                'task_labels_changed',
                'task_updated',
                'task_hand_on_requested',
              ].includes(event.type),
            );
        const timeline = moves();
        expect(finished).toMatchObject({ stageId, status: stageId === 'done' ? 'done' : 'active' });

        signalResume();
        // This check queues behind the held one: completion means the stale move has finished too.
        await h.domain.autoAdvance.check(finished);
        expect(h.domain.tasks.get('AR', key)).toMatchObject({
          stageId: finished.stageId,
          status: finished.status,
          closedAt: finished.closedAt,
          stageEnteredAt: finished.stageEnteredAt,
          labels: finished.labels,
        });
        expect(moves()).toEqual(timeline);
        expect(openDecisions(key)).toEqual([]);
      } finally {
        signalResume();
        delayed.mockRestore();
      }
    },
  );
});
