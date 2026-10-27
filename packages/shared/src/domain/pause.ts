import { z } from 'zod';
import { EngineId } from './engine';
import { HumanAccess, MemberHandle } from './member';
import {
  HybridDeployment,
  Release,
  ReleaseDeployBegin,
  ReleaseDeployChange,
  ReleaseDrainStatus,
  ReleaseReport,
} from './release';
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
  /** The viewer is the host owner and may pause, resume and force the instance. */
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
  /** The release watcher (PM-491): the next release to act on, if any. */
  z.object({ op: z.literal('release_next') }),
  /** The watcher starts the deploy of an approved release; `previousCommit` is what runs now. */
  z.object({ op: z.literal('release_claim'), releaseId: z.string(), previousCommit: z.string().nullable() }),
  z.object({ op: z.literal('release_report'), releaseId: z.string(), report: ReleaseReport }),
  /** Reads one release of the instance, in any state (PM-749): how a lost claim or report answer is reconciled. */
  z.object({ op: z.literal('release_get'), releaseId: z.string() }),
  /** The connected engines as the cloud registry knows them (PM-749); `[]` in single mode. */
  z.object({ op: z.literal('engine_status') }),
  /** The hybrid release's durable deployment (PM-752): reads it (and the drain state) of one release. */
  z.strictObject({ op: z.literal('release_deploy_get'), releaseId: z.string() }),
  z.strictObject({ op: z.literal('release_deploy_begin'), ...ReleaseDeployBegin.shape }),
  z.strictObject({ op: z.literal('release_deploy_change'), ...ReleaseDeployChange.shape }),
]);
export type ControlRequest = z.infer<typeof ControlRequest>;

/** The longest control request taken on the admin channel (PM-749), its newline included; the socket's own limit. */
export const MAX_CONTROL_REQUEST_BYTES = 16 * 1024;
/** The longest control response line the admin channel relays. */
export const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;

export type ControlRequestInput =
  { ok: true; request: ControlRequest; line: string } | { ok: false; reason: string };

/**
 * The admin channel's input rule (PM-749), one place for both ends: exactly one UTF-8 line of at most
 * `MAX_CONTROL_REQUEST_BYTES`, ending in a newline, that is a `ControlRequest`. The text is data only; the
 * reason of a refusal never repeats it.
 */
export function parseControlRequestInput(bytes: Uint8Array): ControlRequestInput {
  if (bytes.length > MAX_CONTROL_REQUEST_BYTES)
    return { ok: false, reason: 'the request is longer than 16 KiB' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'the request is not UTF-8' };
  }
  const newline = text.indexOf('\n');
  if (newline < 0) return { ok: false, reason: 'the request has no terminating newline' };
  if (newline !== text.length - 1) return { ok: false, reason: 'exactly one request line is accepted' };
  const line = text.slice(0, -1);
  if (!line.trim()) return { ok: false, reason: 'the request is empty' };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'the request is not JSON' };
  }
  const parsed = ControlRequest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      reason: `not a control request: ${issue?.path.join('.') || 'request'}: ${issue?.message ?? 'invalid'}`,
    };
  }
  return { ok: true, request: parsed.data, line };
}

/** One engine as `engine_status` reports it: only what the registry already holds (PM-749). */
export const ReleaseEngineStatus = z.object({
  id: EngineId,
  online: z.boolean(),
  version: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});
export type ReleaseEngineStatus = z.infer<typeof ReleaseEngineStatus>;

/**
 * One JSON line back: the instance's pause as it is after the request (null: none is open). Every
 * answer carries `appVersion`, the commit the answering server runs; `release_next` answers with the
 * release to act on (null: none), the release ops with the release as it is after the request.
 */
export const ControlResponse = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    pause: PauseStatus.nullable(),
    release: Release.nullable().optional(),
    appVersion: z.string().nullable().optional(),
    /** `engine_status` only (PM-749). */
    engines: z.array(ReleaseEngineStatus).optional(),
    /** The `release_deploy_*` ops (PM-752): the deployment, the drain state and the schema the database has. */
    deployment: HybridDeployment.nullable().optional(),
    drain: ReleaseDrainStatus.optional(),
    databaseSchemaVersion: z.number().int().nonnegative().optional(),
  }),
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
 * Whether a person is 'owner' in every project they are looked up in (at least one). `null`: no access to that
 * project. It no longer decides who pauses the instance (the host owner does, PM-1058); its remaining use is
 * `canManageProviderKeys`, which another slice moves (PM-1068).
 */
export function canManageInstancePause(accesses: readonly (HumanAccess | null)[]): boolean {
  return accesses.length > 0 && accesses.every((a) => a === 'owner');
}

/** 'paused' when every session has a point (no sessions: 'paused'). */
export function pauseStateOf(sessions: readonly Pick<PausedSession, 'point'>[]): PauseState {
  return sessions.every((s) => s.point !== null) ? 'paused' : 'pausing';
}
