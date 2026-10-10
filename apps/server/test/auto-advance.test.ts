import { afterEach, describe, expect, it } from 'vitest';
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
});
