import { z } from 'zod';
import { HumanAccess, MemberHandle } from './member';
import { PausePoint, WorkItemRef } from './session';

/** What a pause covers (PM-219): the whole instance, or one project. Not a single member. */
export const PauseScopeKind = z.enum(['instance', 'project']);
export type PauseScopeKind = z.infer<typeof PauseScopeKind>;

/** `manual`: a person or the control command asked; `shutdown`: the server pauses before it stops. */
export const PauseKind = z.enum(['manual', 'shutdown']);
export type PauseKind = z.infer<typeof PauseKind>;

/** `pausing`: some session has not stopped yet; `paused`: every session has. */
export const PauseState = z.enum(['pausing', 'paused']);
export type PauseState = z.infer<typeof PauseState>;

export const PauseSource = z.enum(['app', 'control', 'system']);
export type PauseSource = z.infer<typeof PauseSource>;

/** A session that has not stopped this long after the request is cut with one Esc. */
export const DEFAULT_PAUSE_FORCE_AFTER_MS = 300_000;
export const MAX_PAUSE_FORCE_AFTER_MS = 3_600_000;

/** Cut mid-turn: a live session gets a nudge on release. */
export const NUDGE_POINTS: readonly PausePoint[] = ['after_tool', 'before_tool', 'interrupted'];
/** A session whose process is gone restarts on resume only from these. */
export const RESTART_POINTS: readonly PausePoint[] = [...NUDGE_POINTS, 'waiting_permission', 'waiting_input'];

/** One session a pause holds: where it stopped, or what it is still waiting for. */
export const PausedSession = z.object({
  sessionId: z.string(),
  projectKey: z.string(),
  member: MemberHandle,
  workItem: WorkItemRef,
  since: z.string(),
  /** Null: the session is still stopping. */
  point: PausePoint.nullable(),
  tool: z.string().nullable(),
  /** While stopping: the running tool the session waits for (`session_pausing.waitingFor`). */
  waitingFor: z.string().nullable(),
  pausedAt: z.string().nullable(),
  /** Its process no longer runs. */
  stopped: z.boolean(),
});
export type PausedSession = z.infer<typeof PausedSession>;

export const PauseStatus = z.object({
  /** "pau_...". */
  id: z.string(),
  scope: PauseScopeKind,
  /** Null for a pause of the instance. */
  projectKey: z.string().nullable(),
  kind: PauseKind,
  state: PauseState,
  source: PauseSource,
  /** The name of the person who asked; null for the control command and the system. */
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  reason: z.string().nullable(),
  /** `requestedAt` plus the deadline; a forced pause writes "now". */
  forceAt: z.string(),
  sessions: z.array(PausedSession),
});
export type PauseStatus = z.infer<typeof PauseStatus>;

/** The open pauses that touch a project: its own and the instance's. */
export const ProjectPauseView = z.object({
  project: PauseStatus.nullable(),
  instance: PauseStatus.nullable(),
});
export type ProjectPauseView = z.infer<typeof ProjectPauseView>;

export const InstancePauseView = z.object({
  pause: PauseStatus.nullable(),
  /** The viewer may pause, resume and force the instance (`canManageInstancePause`). */
  canManage: z.boolean(),
});
export type InstancePauseView = z.infer<typeof InstancePauseView>;

/** The body of a pause request; resume and force take the same shape (an empty body is fine). */
export const PauseRequest = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
  forceAfterMs: z.number().int().min(0).max(MAX_PAUSE_FORCE_AFTER_MS).optional(),
});
export type PauseRequest = z.infer<typeof PauseRequest>;

/** The control socket's file name inside PROJECTMAN_HOME (the server opens it, the control command and the session policy name it). */
export const CONTROL_SOCKET_NAME = 'control.sock';

/**
 * The control socket's requests (PM-219), one JSON object per line. Always about the instance, with
 * no person behind them: the socket is the deploy script's, not a login.
 */
export const ControlRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('pause') }).extend(PauseRequest.shape),
  z.object({ op: z.literal('resume') }),
  z.object({ op: z.literal('force') }),
  z.object({ op: z.literal('status') }),
]);
export type ControlRequest = z.infer<typeof ControlRequest>;

/** One JSON line back: the instance's pause as it is after the request (null: none is open). */
export const ControlResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pause: PauseStatus.nullable() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ControlResponse = z.infer<typeof ControlResponse>;

/** What decides whether work may run: the scope of an open pause. */
export interface OpenPause {
  scope: PauseScopeKind;
  projectKey: string | null;
}

/** Work of a project is held while its own pause or the instance's is open. */
export function isWorkPaused(pauses: readonly OpenPause[], projectKey: string): boolean {
  return pauses.some((p) => p.scope === 'instance' || p.projectKey === projectKey);
}

/**
 * Who may pause the whole instance: a person with access to at least one project, and 'owner' in
 * every project of the instance. `null`: no access to that project.
 */
export function canManageInstancePause(accesses: readonly (HumanAccess | null)[]): boolean {
  return accesses.length > 0 && accesses.every((a) => a === 'owner');
}

/** 'paused' when every session has a point (no sessions: 'paused'). */
export function pauseStateOf(sessions: readonly Pick<PausedSession, 'point'>[]): PauseState {
  return sessions.every((s) => s.point !== null) ? 'paused' : 'pausing';
}
