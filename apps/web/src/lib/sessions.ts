import { SESSION_IDLE_CLOSE_MINUTES, SessionStop } from '@projectman/shared';
import type { Session } from '@projectman/shared';
import { t } from '../i18n/t';
import { actorLabel, nameOf } from './members';
import type { MemberIndex } from './members';
import type { PipelineIndex } from './pipeline';

/** A session that still runs (it may be idle between turns); exited and failed ones ended. */
export function isLiveSession(session: Pick<Session, 'state'>): boolean {
  return session.state !== 'exited' && session.state !== 'failed';
}

export type SessionStatus = 'needs_you' | 'working' | 'idle' | 'failed' | 'exited';

/** The status dot of a session: needs you, working, idle between turns, or ended. */
export function sessionStatus(session: Pick<Session, 'state'>, needsYou: boolean): SessionStatus {
  if (needsYou) return 'needs_you';
  if (session.state === 'working') return 'working';
  if (isLiveSession(session)) return 'idle';
  return session.state === 'failed' ? 'failed' : 'exited';
}

/**
 * The stops that make an ended session "Lezárva" (closed): it rests, a new message continues the
 * conversation. The server closes a finished or idle session by itself (PM-288); a stop by hand or
 * by the system is the same state with a different reason. Every other kind (login lost, restart,
 * workspace…) and a stop without a reason stay the plain "Leállt".
 */
export const AUTOMATIC_CLOSURES: ReadonlySet<SessionStop['kind']> = new Set([
  'step_done',
  'idle',
  'card_done',
  'task_cancelled',
  'sent_back',
  'pause',
  'handed_off',
  'handoff_timeout',
]);
export function isAutomaticClosureKind(
  kind: SessionStop['kind'],
): kind is
  | 'step_done'
  | 'idle'
  | 'card_done'
  | 'task_cancelled'
  | 'sent_back'
  | 'pause'
  | 'handed_off'
  | 'handoff_timeout' {
  return AUTOMATIC_CLOSURES.has(kind);
}
const STOPPED_CLOSURES: ReadonlySet<SessionStop['kind']> = new Set([
  'manual',
  'assignee_change',
  'loop_stopped',
  'fix_limit_reassign',
]);

/** The stop when it closes the session, else null. */
function closingStop(stop: SessionStop | undefined): SessionStop | null {
  return stop && (AUTOMATIC_CLOSURES.has(stop.kind) || STOPPED_CLOSURES.has(stop.kind)) ? stop : null;
}

/** The reason of an ended session that rests: only an exited one with a closing stop. */
export function sessionClosure(session: Pick<Session, 'state' | 'lastStop'>): SessionStop | null {
  return session.state === 'exited' ? closingStop(session.lastStop) : null;
}

/** The reason in a `session_ended` event's data: a clean end (no exit code, or 0) with a closing stop. */
export function eventClosure(data: Record<string, unknown>): SessionStop | null {
  if (data.exitCode !== null && data.exitCode !== undefined && data.exitCode !== 0) return null;
  const parsed = SessionStop.safeParse(data.stop);
  return parsed.success ? closingStop(parsed.data) : null;
}

export interface ClosureContext {
  pipeline: PipelineIndex | null;
  members: MemberIndex;
  myHandle: string | null;
}

/** The closed state's texts, one per place it appears. */
export interface ClosureTexts {
  /** The header's live label. */
  label: string;
  /** The header's tooltip. */
  hint: string;
  /** The line in the card drawer's and the profile's lists. */
  list: string;
  /** The line above the message box. */
  note: string;
  /** The timeline row. */
  event: string;
}

type Reason = { short: string; long: string };

export function closureReason(stop: SessionStop, ctx: ClosureContext): Reason {
  const key = stop.taskKey;
  const stage = stop.stageId ? (ctx.pipeline?.stageById.get(stop.stageId)?.name ?? stop.stageId) : null;
  const detail = (base: string, withStage = false) =>
    !key
      ? base
      : withStage && stage
        ? t('session.closure.detailStage', { reason: base, key, stage })
        : t('session.closure.detail', { reason: base, key });
  switch (stop.kind) {
    case 'step_done':
      return {
        short: t('session.closure.short.step_done'),
        long: detail(t('session.closure.long.step_done'), true),
      };
    case 'idle': {
      const n = stop.idleMinutes ?? SESSION_IDLE_CLOSE_MINUTES;
      return {
        short: t('session.closure.short.idle', { n }),
        long: t('session.closure.long.idle', { n }),
      };
    }
    case 'card_done':
      return {
        short: t('session.closure.short.card_done'),
        long: detail(t('session.closure.long.card_done')),
      };
    case 'task_cancelled':
      return {
        short: t('session.closure.short.task_cancelled'),
        long: detail(t('session.closure.long.task_cancelled')),
      };
    case 'sent_back':
      return {
        short: t('session.closure.short.sent_back'),
        long: detail(t('session.closure.long.sent_back'), true),
      };
    case 'handed_off':
      return { short: t('session.closure.short.handed_off'), long: t('session.closure.long.handed_off') };
    case 'handoff_timeout':
      return {
        short: t('session.closure.short.handoff_timeout'),
        long: t('session.closure.long.handoff_timeout'),
      };
    default:
      return { short: t('session.closure.short.pause'), long: t('session.closure.long.pause') };
  }
}

/**
 * The texts of a closing stop. A stop by hand names who did it: "Rendszer" when no one did, and its
 * own sentence for the viewer ("leállítottad", not "leállította: Te").
 */
export function closureTexts(stop: SessionStop, ctx: ClosureContext): ClosureTexts {
  const resume = t('session.closure.resume');
  if (STOPPED_CLOSURES.has(stop.kind)) {
    const handle = stop.by?.kind === 'system' ? null : (stop.by?.handle ?? null);
    const byViewer = handle !== null && handle === ctx.myHandle && !stop.by?.via;
    const name =
      stop.by && stop.by.kind !== 'system'
        ? actorLabel(stop.by, ctx.members, ctx.myHandle)
        : nameOf(handle, ctx.members, ctx.myHandle);
    return {
      label: t('session.closure.label'),
      hint: byViewer ? t('session.closure.hintStoppedByYou') : t('session.closure.hintStopped', { name }),
      list: byViewer ? t('session.closure.listStoppedByYou') : t('session.closure.listStopped', { name }),
      note: `${
        byViewer ? t('session.closure.noteStoppedByYou') : t('session.closure.noteStopped', { name })
      } ${resume}`,
      event: byViewer ? t('session.closure.eventStoppedByYou') : t('session.closure.eventStopped', { name }),
    };
  }
  const { short, long } = closureReason(stop, ctx);
  return {
    label: t('session.closure.label'),
    hint: t('session.closure.hint', { reason: short }),
    list: t('session.closure.list', { reason: short }),
    note: `${t('session.closure.note', { reason: long })} ${resume}`,
    event: t('session.closure.event', { reason: long }),
  };
}
