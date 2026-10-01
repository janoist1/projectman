import { z } from 'zod';
import { AgentProvider, Approver, MemberHandle, SelectablePermissionMode } from './member';
import { TaskKey } from './task';
import { UsageSummary } from './token-usage';

/**
 * Every AI member works in a fresh Claude Code session per work item:
 * (member x task), (member x meeting) or (member x general chat).
 * Messages about the same work item resume the same session.
 */
export const WorkItemRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task'), taskKey: TaskKey }),
  z.object({ type: z.literal('meeting'), meetingId: z.string() }),
  z.object({ type: z.literal('general') }),
  z.object({ type: z.literal('schedule'), runId: z.string() }),
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
  /**
   * The agent CLI whose conversation the session holds (its transcript and conversation id).
   * The server always sets it; it is optional for data from before it existed.
   */
  provider: AgentProvider.optional(),
  cwd: z.string(),
  branch: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  state: SessionState,
  /** Short description of the latest activity, e.g. "Bash: npm test". */
  activity: z.string().nullable(),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  endedAt: z.string().nullable(),
  /**
   * The session's own permission mode (PM-170), set by an owner in place of the member's. Absent:
   * the member's mode. Resumes of the session keep it; a new session starts without it. The value
   * that applies is `effectiveSessionPermissions`.
   */
  permissionModeOverride: SelectablePermissionMode.optional(),
  /** Who answers when the CLI asks, for this session only (PM-170); absent: the member's approver. */
  approverOverride: Approver.optional(),
  /**
   * The permission mode changed while the session was in a turn: it restarts with its conversation
   * (`--resume`) at its next idle moment, and takes the new mode from then on.
   */
  permissionRestartPending: z.literal(true).optional(),
  /**
   * The restart for a new permission mode dropped what a person allowed "for this session"
   * (the CLI forgets it with its process); the CLI asks again.
   */
  permissionGrantsLost: z.literal(true).optional(),
  /**
   * The tokens the session used (PM-178), per model, its subagents' on rows of their own. Absent
   * when nothing was measured: a session from before the measurement (or an older server).
   */
  usage: UsageSummary.optional(),
});
export type Session = z.infer<typeof Session>;
