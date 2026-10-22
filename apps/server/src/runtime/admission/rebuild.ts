import type { FastifyBaseLogger } from 'fastify';
import type { BackgroundTasks } from '../../kernel';
import type { AutomaticStart, StartSpec } from './deferred-starts';
import type { StageHandOver } from './hand-over';
import type { WorkStarts } from './work-starts';
import type { RefinementSteps } from './refinement';
import type { MessageStarts } from './message-starts';
import type { HandoffService } from './handoffs';

/** Restore each start through its owner; legacy message and PM starts now wake their queue. */
export function createDeferredStartRebuilder(deps: {
  handOver: Pick<StageHandOver, 'rebuild'>;
  workStarts: Pick<WorkStarts, 'rebuild'>;
  refinement: Pick<RefinementSteps, 'rebuild'>;
  messageStarts: Pick<MessageStarts, 'rebuildQuota'>;
  handoffs: Pick<HandoffService, 'rebuild'>;
  rebuildLoopNotice(spec: Extract<StartSpec, { kind: 'loop_notice' }>): AutomaticStart | null;
  memberQueueDriver: { ensure(projectKey: string, handle: string): Promise<void> };
  operatorSignals: { deliver(projectKey: string): Promise<void> };
  questionScreening: { enqueue(projectKey: string): Promise<void> };
  background: BackgroundTasks;
  logger: FastifyBaseLogger;
}): (spec: StartSpec) => AutomaticStart | null {
  const {
    handOver,
    workStarts,
    refinement,
    messageStarts,
    handoffs,
    rebuildLoopNotice,
    memberQueueDriver,
    operatorSignals,
    questionScreening,
    background,
    logger,
  } = deps;
  return (spec: StartSpec): AutomaticStart | null => {
    switch (spec.kind) {
      case 'hand_over':
        return handOver.rebuild(spec);
      case 'work_start':
        return workStarts.rebuild(spec);
      case 'refinement_turn':
        return refinement.rebuild(spec);
      case 'message_wake':
        // Stored by an older build: the member queue wakes the member now, and the row is dropped (PM-925).
        background.run(
          () => memberQueueDriver.ensure(spec.projectKey, spec.handle),
          (err) => logger.warn({ err, member: spec.handle }, 'working the member queue failed'),
        );
        return null;
      case 'provider_resume':
        return messageStarts.rebuildQuota(spec);
      case 'loop_notice':
        return rebuildLoopNotice(spec);
      case 'operator_signals':
      case 'question_screening':
        // Stored by an older build: the PM's queue holds these items now; the row is dropped (PM-885).
        background.run(
          () =>
            spec.kind === 'operator_signals'
              ? operatorSignals.deliver(spec.projectKey)
              : questionScreening.enqueue(spec.projectKey),
          (err) => logger.warn({ err, projectKey: spec.projectKey }, 'working the PM queue failed'),
        );
        return null;
      case 'handoff_takeover':
        return handoffs.rebuild(spec);
    }
  };
}
