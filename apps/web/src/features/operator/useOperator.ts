import { useOperatorChannel, useOperatorGrant, useTeamThreads } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';

/**
 * The Operator as the corner button and its panel see it: who, whether it can answer, unread replies, the
 * owner's open signals, the length of its queue and the grant of machine operations. Every person of the project
 * has the corner (PM-475), so only a viewer who is a member of the project (has a handle) reads it.
 */
export function useOperator() {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const channel = useOperatorChannel(key, myHandle !== null);
  const grantQuery = useOperatorGrant(myHandle !== null);
  const threads = useTeamThreads(key);
  const handle = channel.data?.member?.handle ?? null;
  const member = handle ? members.get(handle) : undefined;
  const unread = handle
    ? (threads.data?.threads.find((thread) => thread.peer === handle)?.unreadCount ?? 0)
    : 0;
  return {
    channel,
    state: channel.data,
    handle,
    member,
    unread,
    openSignals: channel.data?.openSignals ?? 0,
    /** Undefined while it loads or when it could not be read: the ring and the chip stay off, the panel says so. */
    grant: grantQuery.isError ? undefined : grantQuery.data,
    grantFailed: grantQuery.isError,
  };
}
