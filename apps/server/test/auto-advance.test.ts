import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateRequestOf } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

const owner = { handle: 'owner', access: 'owner' as const };

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
