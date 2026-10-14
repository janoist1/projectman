import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conflict } from '../src/kernel';
import type { MergeGate } from '../src/core/tasks';
import type { InboxDecider } from '../src/core/inbox';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

function fakeMergeGate() {
  return {
    checkGate: vi.fn<MergeGate['checkGate']>(async () => {}),
    notMergedError: vi.fn<MergeGate['notMergedError']>(() =>
      conflict('task_not_merged', 'The registered gate refused the move'),
    ),
    reconcile: vi.fn<MergeGate['reconcile']>(async () => {}),
    mergerOf: vi.fn<MergeGate['mergerOf']>(() => 'dev-1'),
    cancel: vi.fn<MergeGate['cancel']>(),
  } satisfies MergeGate;
}

describe('TaskService.registerMergeGate', () => {
  let h: DomainHarness;
  let gate: ReturnType<typeof fakeMergeGate>;

  beforeEach(async () => {
    h = await createDomainHarness({
      adjust(config) {
        config.project.repos[0]!.requireMerge = true;
        config.team.merger = { kind: 'member', handle: 'dev-1' };
        config.pipeline.stages = config.pipeline.stages.filter(
          (stage) => stage.id !== 'merge' && stage.id !== 'release',
        );
        config.pipeline.stages.find((stage) => stage.id === 'done')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
      },
    });
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    await h.domain.tasks.create(
      'AR',
      { title: 'Card with a registered merge gate', repo: 'web' },
      OWNER_ACTOR,
    );
    const task = h.domain.tasks.get('AR', 'AR-1');
    h.repos.tasks.update(task.id, { stageId: 'code_review', labels: ['code-review-ok'] });
    gate = fakeMergeGate();
    // Replace the merge service already registered by assembly.
    h.domain.tasks.registerMergeGate(gate);
  });

  afterEach(() => h.cleanup());

  it('propagates the registered gate refusal and leaves the card in its stage', async () => {
    const error = conflict('task_not_merged', 'The registered gate refused the move');
    gate.checkGate.mockRejectedValue(error);

    await expect(h.domain.tasks.moveToStage('AR', 'AR-1', 'done', OWNER_ACTOR)).rejects.toBe(error);
    expect(h.domain.tasks.get('AR', 'AR-1').stageId).toBe('code_review');
  });

  it('moves when the replacement gate resolves and supplies the move facts once', async () => {
    const config = await h.domain.projects.config('AR');
    const task = h.domain.tasks.get('AR', 'AR-1');

    const result = await h.domain.tasks.moveToStage('AR', 'AR-1', 'done', OWNER_ACTOR);

    expect(result.moved).toBe(true);
    expect(result.task.stageId).toBe('done');
    expect(gate.checkGate).toHaveBeenCalledExactlyOnceWith(config, task, 'done');
  });

  it('skips merge checks before the target and cancels the previous merge request', async () => {
    const task = h.domain.tasks.get('AR', 'AR-1');
    h.repos.tasks.update(task.id, { stageId: 'backlog', labels: [] });

    const result = await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);

    expect(result.moved).toBe(true);
    expect(result.task.stageId).toBe('development');
    for (const method of [gate.checkGate, gate.notMergedError, gate.reconcile, gate.mergerOf]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(gate.cancel).toHaveBeenCalledExactlyOnceWith('AR', 'AR-1', expect.any(Array));
  });

  it('cancels through the registered gate with the keys and unit-of-work effects', async () => {
    await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);

    expect(gate.cancel).toHaveBeenCalledExactlyOnceWith('AR', 'AR-1', expect.any(Array));
    expect(h.domain.tasks.get('AR', 'AR-1').status).toBe('cancelled');
  });
});

describe('inbox and messaging extension points', () => {
  let h: DomainHarness;
  const resolver = { handle: 'owner', access: 'owner' } as const;

  beforeEach(async () => {
    h = await createDomainHarness();
    vi.spyOn(h.domain.autoAdvance, 'check').mockResolvedValue(undefined);
    await h.domain.tasks.create('AR', { title: 'Card with extension points' }, OWNER_ACTOR);
    const task = h.domain.tasks.get('AR', 'AR-1');
    h.repos.tasks.update(task.id, { stageId: 'code_review', assignee: 'dev-1' });
  });
  afterEach(() => h.cleanup());

  function mergeRequest() {
    return h.domain.inbox.create({
      projectKey: 'AR',
      taskKey: 'AR-1',
      kind: 'merge_request',
      assignees: ['owner'],
      source: 'dev-1',
      title: 'Merge request',
      payload: {},
      options: [{ id: 'merge', label: 'merge', style: 'primary' }],
    });
  }

  it('passes decision arguments, propagates refusal and leaves the item open', async () => {
    const item = mergeRequest();
    const error = conflict('task_not_merged', 'The registered decider refused');
    const decide = vi.fn<InboxDecider>(async () => {
      throw error;
    });
    h.domain.inbox.registerDecider('merge_request', decide);

    await expect(
      h.domain.inbox.resolve('AR', item.id, { optionId: 'merge', note: '  Ready  ' }, resolver),
    ).rejects.toBe(error);

    expect(decide).toHaveBeenCalledExactlyOnceWith(item, resolver, 'merge', 'Ready');
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it('replaces the decider registered for the same key', async () => {
    const item = mergeRequest();
    const first = vi.fn<InboxDecider>();
    const second = vi.fn<InboxDecider>((item, by) => h.domain.inbox.resolveMergeRequest(item.id, by.handle));
    h.domain.inbox.registerDecider('merge_request', first);
    h.domain.inbox.registerDecider('merge_request', second);

    const result = await h.domain.inbox.resolve('AR', item.id, { optionId: 'merge' }, resolver);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(item, resolver, 'merge', null);
    expect(result.state).toBe('resolved');
  });

  it('holds a reviewer and replaces the full-test hold on re-registration', async () => {
    h.domain.messaging.registerCardHold('full_test', { holds: () => true });
    const held = await h.domain.messaging.sendReporting(
      'AR',
      'dev-2',
      {
        to: ['cr'],
        taskKey: 'AR-1',
        text: 'Held review',
      },
      { kind: 'info' },
    );
    expect(held.recipients[0]?.hold).toBe('full_test');

    h.domain.messaging.registerCardHold('full_test', { holds: () => false });
    const released = await h.domain.messaging.sendReporting(
      'AR',
      'dev-2',
      {
        to: ['cr'],
        taskKey: 'AR-1',
        text: 'Available review',
      },
      { kind: 'info' },
    );
    expect(released.recipients[0]?.hold).not.toBe('full_test');
  });

  it('awaits one review-round event before recording the assignee action message', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listener = vi.fn(async () => {
      expect(h.repos.messages.list('AR', { taskKey: 'AR-1' })).toHaveLength(0);
      await pending;
      expect(h.repos.messages.list('AR', { taskKey: 'AR-1' })).toHaveLength(0);
    });
    h.domain.ctx.events.on('task_review_round', listener);

    const sending = h.domain.messaging.sendReporting(
      'AR',
      'dev-1',
      {
        to: ['cr'],
        taskKey: 'AR-1',
        text: 'Review the new round',
      },
      { kind: 'action' },
    );
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledExactlyOnceWith({
        projectKey: 'AR',
        taskKey: 'AR-1',
        from: 'dev-1',
      }),
    );
    expect(h.repos.messages.list('AR', { taskKey: 'AR-1' })).toHaveLength(0);
    release();
    const { message } = await sending;
    expect(h.repos.messages.list('AR', { taskKey: 'AR-1' }).map((stored) => stored.id)).toEqual([message.id]);
  });
});
