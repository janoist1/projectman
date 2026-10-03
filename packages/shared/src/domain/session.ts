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

/**
 * Where a paused session stopped (PM-218):
 * - `idle`: it stood idle (a starting Claude that became ready, and the end of a compaction asked for, too);
 * - `turn_end`: the turn ended by itself (Stop or StopFailure), without a halting hook answer;
 * - `after_tool`: a tool ran, and the session stopped after it;
 * - `before_tool`: it stopped before the next tool, which did not run (Codex: Esc cut only the generation);
 * - `interrupted`: a forced Esc stopped it (the deadline or `forcePause`);
 * - `waiting_permission`, `waiting_input`: it waits for an approval, or for input in the terminal;
 * - `exited`: the process exited, or is not running.
 */
export const PausePoint = z.enum([
  'idle',
  'turn_end',
  'after_tool',
  'before_tool',
  'interrupted',
  'waiting_permission',
  'waiting_input',
  'exited',
]);
export type PausePoint = z.infer<typeof PausePoint>;

/** When a session's usage reached the warning limit (PM-187), with the two numbers at that moment. */
export const SessionUsageAlert = z.object({
  at: z.string(),
  countedTokens: z.number().int().nonnegative(),
  limitTokens: z.number().int().positive(),
});
export type SessionUsageAlert = z.infer<typeof SessionUsageAlert>;

/** Longest `WorkDoing.summary` (the card shows it on one line) and `WorkDoing.detail`. */
export const WORK_DOING_SUMMARY_MAX = 80;
export const WORK_DOING_DETAIL_MAX = 300;

/**
 * What a member says it is doing on its card now (PM-238), in a declarative sentence of the
 * project's language, e.g. "The gateway's tests are being written". `summary` is one line for the
 * card; `detail` is the longer text for the task page. Free text of the member: shown as text only.
 */
export const WorkDoing = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(WORK_DOING_SUMMARY_MAX)
    .refine((s) => !/[\r\n]/.test(s), 'must be one line'),
  detail: z.string().trim().min(1).max(WORK_DOING_DETAIL_MAX).optional(),
});
export type WorkDoing = z.infer<typeof WorkDoing>;

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
  /**
   * When the session entered its current `state` (PM-207). Absent for a session from before it was
   * kept: its `lastActivityAt` is the closest known moment.
   */
  stateSince: z.string().optional(),
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
  /**
   * The session's usage reached the project's warning limit (PM-187): when, what it counted
   * (`limitTokens`) and the limit then. Absent: it has not. Set once; the session keeps running.
   */
  usageAlert: SessionUsageAlert.optional(),
  /**
   * What the member says it does on the card now (PM-238). Only the latest is kept; it is cleared
   * when the session's round ends (it goes idle) or the session ends. Absent: none given.
   */
  doing: WorkDoing.optional(),
});
export type Session = z.infer<typeof Session>;

/**
 * A member's work on one card (PM-207): a task session that is working. A member's status and
 * activity describe the member as a whole; this is what the member does on that card.
 */
export const TaskWork = z.object({
  sessionId: z.string(),
  taskKey: TaskKey,
  /** What the session does now, e.g. "Bash: npm test". */
  activity: z.string().nullable(),
  /** When the session entered the state it is in. */
  since: z.string(),
  /** What the member says it does on the card (`Session.doing`); absent when it gave no sentence. */
  doing: WorkDoing.optional(),
});
export type TaskWork = z.infer<typeof TaskWork>;

/** The states in which a session works on its card (a starting one counts, as for the member's status). */
const WORKING_SESSION_STATES: ReadonlySet<SessionState> = new Set(['starting', 'working']);

/** The work a session does on its card now; null when it is not a working task session. */
export function taskWorkOf(session: Session): TaskWork | null {
  if (session.workItem.type !== 'task' || !WORKING_SESSION_STATES.has(session.state)) return null;
  return {
    sessionId: session.id,
    taskKey: session.workItem.taskKey,
    activity: session.activity,
    since: session.stateSince ?? session.lastActivityAt,
    ...(session.doing ? { doing: session.doing } : {}),
  };
}

/** The member's work list with this session's change applied (it replaces the session's earlier entry). */
export function withSessionWork(work: readonly TaskWork[], session: Session): TaskWork[] {
  const rest = work.filter((entry) => entry.sessionId !== session.id);
  const entry = taskWorkOf(session);
  return entry ? [...rest, entry] : rest;
}
