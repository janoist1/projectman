import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conflict } from '../src/domain/errors';
import type { MergeGate } from '../src/domain/tasks';
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
