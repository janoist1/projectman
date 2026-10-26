import type { AiMemberConfig } from './schema';

/**
 * The name under which an AI member's state is kept on disk and on the engine (workspace, `.home`,
 * sandbox cache, memory file): its oldest handle. It stays the same when the member is renamed,
 * so nothing moves and the agent's conversations keep their working directory (PM-1024).
 */
export function memberStorageHandle(member: Pick<AiMemberConfig, 'handle' | 'formerHandles'>): string {
  return member.formerHandles?.[0] ?? member.handle;
}
