import { memberQueueSourceOf } from '@projectman/shared';
import type { StoredMemberQueueItem } from '../../db';
import type { MemberQueueLane } from './lane';

/** What the lane asks of the system signals (the services' `OperatorSignals`). */
export interface SignalLaneSignals {
  owed(projectKey: string, member: string, signalId: string, followUpAt: string | null): boolean;
  holdsBack(projectKey: string, signalId: string): boolean;
  noticeText(projectKey: string, signalIds: string[]): string;
  markDelivered(projectKey: string, member: string, signalId: string, followUpAt: string | null): void;
}

/** The hold code while the wake interval (or the structural window) keeps a signal from the coordinator. */
const SIGNAL_INTERVAL_HOLD = 'hold_signal_interval';

/** The signal an item is for, and the follow-up time that makes it a new item. */
const signalOf = (item: StoredMemberQueueItem): { signalId: string; followUpAt: string | null } => {
  const source = memberQueueSourceOf(item.source.type, item.source.id);
  return source.type === 'signal' ? source : { signalId: item.source.id, followUpAt: null };
};

/**
 * The lane of the system signals the project manager gets (PM-885, PM-545, PM-694): each pending signal is an
 * item, delivered as the wake-up text and done at the delivery. The items wait while the wake interval of
 * their line (general or fast) has not passed; a signal shown again after the coordinator's own step is a new
 * item.
 */
export function signalLane(deps: { signals: SignalLaneSignals }): MemberQueueLane {
  const { signals } = deps;
  return {
    kinds: ['signal'],
    completion: 'delivery',
    oneAtATime: false,
    cause: () => ({ kind: 'operator_signal' }),
    render: () => null,
    renderBatch: (items) =>
      signals.noticeText(
        items[0]!.projectKey,
        items.map((item) => signalOf(item).signalId),
      ),
    stillOwed: (item) => {
      const { signalId, followUpAt } = signalOf(item);
      return signals.owed(item.projectKey, item.member, signalId, followUpAt);
    },
    hold: async (item) =>
      signals.holdsBack(item.projectKey, signalOf(item).signalId) ? SIGNAL_INTERVAL_HOLD : null,
    // No `refused`: a start that fails keeps the item queued for the next attempt. A closed item would keep the
    // signal from ever being queued again (the source key is unique over closed rows too).
    delivered: (item) => {
      const { signalId, followUpAt } = signalOf(item);
      signals.markDelivered(item.projectKey, item.member, signalId, followUpAt);
    },
  };
}
