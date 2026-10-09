import { useProjectManagerChannel, useTeamThreads } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';

/** The project manager as the header and its panel see it: who, whether it can answer, unread replies. */
export function usePm() {
  const { key, can } = useProject();
  const { members } = useProjectIndexes(key);
  const channel = useProjectManagerChannel(key, can.createTasks);
  const threads = useTeamThreads(key);
  const handle = channel.data?.member?.handle ?? null;
  const member = handle ? members.get(handle) : undefined;
  const unread = handle
    ? (threads.data?.threads.find((thread) => thread.peer === handle)?.unreadCount ?? 0)
    : 0;
  return { channel, state: channel.data, handle, member, unread };
}
