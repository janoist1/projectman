import type { QuestionScreening } from '../../core/inbox';
import type { MemberQueueLane } from './lane';

/** The code a start is deferred with while the PM's machine is offline: the question waits for it (PM-708). */
const ENGINE_OFFLINE = 'engine_offline';

/**
 * The lane of the questions the PM screens (PM-885, PM-558): a `screening` item is the question as the PM's work.
 * The questions go to the PM in one input, the item stays `processing` until the question leaves screening (the
 * PM decided it, the people got it, or it was closed), and the ten minutes run from the delivery (PM-708). When
 * the PM cannot take a question the people get it at once, except while its machine is offline: then the
 * question waits for the machine.
 */
export function screeningLane(deps: { screening: QuestionScreening }): MemberQueueLane {
  const { screening } = deps;
  return {
    kinds: ['screening'],
    completion: 'source',
    oneAtATime: false,
    cause: () => ({ kind: 'question_screening' }),
    render: () => null,
    renderBatch: (items) => screening.noticeText(items.map((item) => item.source.id)),
    stillOwed: (item) => screening.isScreened(item.source.id),
    hold: async () => null,
    delivered: (item, _sessionId, at) => screening.markDelivered(item.source.id, at),
    deferred: async (item, code) => {
      if (code === ENGINE_OFFLINE) {
        screening.holdForEngine(item.projectKey);
        return 'wait';
      }
      await screening.releaseUnavailable(item.source.id);
      return 'closed';
    },
    refused: async (item) => {
      await screening.releaseUnavailable(item.source.id);
      return 'closed';
    },
  };
}
