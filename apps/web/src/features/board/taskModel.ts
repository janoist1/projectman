import type { Session, Task } from '@projectman/shared';
import { isLiveSession } from '../../lib/sessions';

/**
 * The session to open for a task: the newest live one (e.g. the reviewer's while the task is in
 * review), otherwise the assignee's latest, otherwise the latest one.
 */
export function primarySession(task: Task, sessions: readonly Session[]): Session | null {
  const sorted = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return (
    sorted.find(isLiveSession) ??
    sorted.find((session) => session.member === task.assignee) ??
    sorted[0] ??
    null
  );
}
