import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-420: a card sent back into the work stage starts its AI assignee when it has no running session
 * (the hand-over used to tell only a running one). Card AR-1 is carried by `dev-1`.
 */
describe('stage hand-over back into the work stage', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const roomy = (c: ProjectConfig) => void (c.team.limits.maxConcurrentAi = 10);
  const move = (stage: string, actor = OWNER_ACTOR, key = 'AR-1') =>
    h.domain.tasks.moveToStage('AR', key, stage, actor);
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const devStarts = () => h.runner.started.filter((spec) => spec.member === 'dev-1');
  const devSessions = () =>
    h.domain.sessions.list('AR', { taskKey: 'AR-1' }).filter((s) => s.member === 'dev-1');

  /** AR-1 carried by dev-1, sent to review (cr started), dev-1 has no session. */
  async function inReview(adjust: (c: ProjectConfig) => void = roomy) {
    h = await createDomainHarness({ adjust });
    h.runner.idleOnStart = true;
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    await move('code_review');
    await vi.waitFor(() => expect(h.runner.started.filter((s) => s.member === 'cr')).toHaveLength(1));
    await flush();
    expect(devStarts()).toEqual([]);
  }

  it('starts the assignee that has no session when the card is sent back', async () => {
    await inReview();
    await move('development');
    await vi.waitFor(() => expect(devStarts()).toHaveLength(1));
    expect(devSessions()[0]?.startCause).toMatchObject({
      kind: 'hand_over',
      from: 'code_review',
      to: 'development',
      by: OWNER_ACTOR,
    });
    expect(h.repos.deferredStarts.list()).toEqual([]);
  });

  it('waits while the assignee is busy on another card, and starts it when the place is free', async () => {
    await inReview();
    await h.domain.tasks.create('AR', { title: 'Other' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-2' });
    const before = devStarts().length;
    await move('development');
    await vi.waitFor(() =>
      expect(h.repos.deferredStarts.list().map((record) => record.key)).toEqual(['hand-over:AR:AR-1']),
    );
    expect(devStarts()).toHaveLength(before);

    await h.domain.tasks.cancel('AR', 'AR-2', { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    await vi.waitFor(async () => {
      await h.domain.admission.retryDeferred();
      expect(devSessions()).toHaveLength(1);
    });
    expect(devSessions()[0]?.startCause).toMatchObject({ kind: 'hand_over', to: 'development' });
    expect(h.repos.deferredStarts.list()).toEqual([]);
  });

  it('stores the wait as a hand-over start, which a restart makes again', async () => {
    await inReview();
    await h.domain.tasks.create('AR', { title: 'Other' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-2' });
    await move('development');
    await vi.waitFor(() => expect(h.repos.deferredStarts.list()).toHaveLength(1));
    expect(h.repos.deferredStarts.list()[0]?.spec).toMatchObject({
      kind: 'hand_over',
      taskKey: 'AR-1',
      from: 'code_review',
      to: 'development',
    });
  });

  it('starts nobody when the assignee moved the card itself', async () => {
    await inReview();
    await move('development', aiActor('dev-1'));
    await flush();
    expect(devStarts()).toEqual([]);
    expect(h.repos.deferredStarts.list()).toEqual([]);
  });

  it('starts nobody on a move forward into the work stage: that is the Start button', async () => {
    h = await createDomainHarness({ adjust: roomy });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    await move('development');
    await flush();
    expect(task().stageId).toBe('development');
    expect(devStarts()).toEqual([]);
    expect(h.repos.deferredStarts.list()).toEqual([]);
  });

  it('tells a running assignee instead of starting another session', async () => {
    await inReview();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: 'AR-1',
    });
    h.runner.setState(session.id, 'idle');
    const before = devStarts().length;
    await move('development');
    await vi.waitFor(() =>
      expect(h.runner.messages.some((m) => m.text.includes('Task AR-1 is now in stage Development'))).toBe(
        true,
      ),
    );
    expect(devStarts()).toHaveLength(before);
  });

  it('starts one session when the send-back comes with a label message', async () => {
    await inReview();
    await h.domain.tasks.changeLabels('AR', 'AR-1', { add: ['code-review-changes'] }, aiActor('cr'), {
      comment: 'Fix the login form.',
    });
    await move('development');
    await vi.waitFor(() => expect(devStarts().length).toBeGreaterThan(0));
    await flush();
    expect(devStarts()).toHaveLength(1);
    const texts = [
      ...devStarts().map((spec) => spec.initialMessage ?? ''),
      ...h.runner.messages.map((message) => message.text),
    ].join('\n');
    expect(texts).toContain('Fix the login form.');
  });
});
