import { z } from 'zod';
import { MemberHandle } from './member';
import { TaskKey } from './task';

/**
 * Every AI member works in a fresh Claude Code session per work item:
 * (member x task), (member x meeting) or (member x general chat).
 * Messages about the same work item resume the same session.
 */
export const WorkItemRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task'), taskKey: TaskKey }),
  z.object({ type: z.literal('meeting'), meetingId: z.string() }),
  z.object({ type: z.literal('general') }),
]);
export type WorkItemRef = z.infer<typeof WorkItemRef>;

export const SessionState = z.enum([
  'starting',
  'idle',
  'working',
  'waiting_permission',
  'waiting_input',
  'exited',
  'failed',
]);
export type SessionState = z.infer<typeof SessionState>;

export const Session = z.object({
  /** Our id ("ses_..."). */
  id: z.string(),
  projectKey: z.string(),
  member: MemberHandle,
  workItem: WorkItemRef,
  /** Claude Code session UUID (used with --session-id / --resume). */
  claudeSessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  cwd: z.string(),
  branch: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  state: SessionState,
  /** Short description of the latest activity, e.g. "Bash: npm test". */
  activity: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  endedAt: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;
