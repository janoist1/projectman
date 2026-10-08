import { SessionStartCause, SessionStop } from '@projectman/shared';
import type { Actor, TimelineEvent } from '@projectman/shared';
import { t } from '../i18n/t';
import { actorLabel } from './members';
import { labelName } from './labels';
import { isAutomaticClosureKind, closureReason } from './sessions';
import type { TimelineContext } from './timeline';

export interface InvolvementDescription {
  verb: string;
  reason: string;
  ref?: { text: string; eventId?: string; messageId?: string; inboxItemId?: string; runId?: string };
  by?: string;
  tone?: 'accent' | 'needs' | 'blocked' | 'neutral';
}
const byLabel = (actor: Actor | undefined, ctx: TimelineContext) =>
  actor && actor.kind !== 'system' ? actorLabel(actor, ctx.members, ctx.myHandle) : undefined;

export function describeStart(event: TimelineEvent, ctx: TimelineContext): InvolvementDescription {
  const parsed = SessionStartCause.safeParse(event.data.cause);
  if (!parsed.success)
    return {
      verb: t(event.data.resumed ? 'timeline.events.session_resumed' : 'timeline.events.session_started'),
      reason: '',
    };
  const cause = parsed.data;
  const verb = t(
    cause.kind === 'schedule'
      ? 'involvement.verbs.scheduled'
      : cause.kind === 'permission_change'
        ? 'involvement.verbs.restarted'
        : event.data.resumed
          ? 'involvement.verbs.resumed'
          : 'involvement.verbs.started',
  );
  const stage = (id: string) => ctx.pipeline?.stageById.get(id)?.name ?? id;
  const text = cause.quote
    ? t('involvement.quote', { text: cause.quote })
    : (cause.labels?.map((id) => labelName(id, ctx.labels ?? [])).join(', ') ??
      (cause.from && cause.to
        ? `${stage(cause.from)} → ${stage(cause.to)}`
        : cause.kind === 'fix_limit'
          ? t('involvement.limit', { rounds: cause.rounds ?? 0, limit: cause.limit ?? 0 })
          : ''));
  return {
    verb,
    tone: cause.kind === 'provider_resume' || cause.kind === 'pause_resume' ? 'neutral' : 'accent',
    reason: t(`involvement.reasons.${cause.kind}`),
    by: byLabel(cause.by, ctx),
    ...(text || cause.eventId || cause.messageId || cause.inboxItemId || cause.runId
      ? {
          ref: {
            text,
            eventId: cause.eventId,
            messageId: cause.messageId,
            inboxItemId: cause.inboxItemId,
            runId: cause.runId,
          },
        }
      : {}),
  };
}

export function describeStop(event: TimelineEvent, ctx: TimelineContext): InvolvementDescription {
  const parsed = SessionStop.safeParse(event.data.stop);
  if (!parsed.success) return { verb: t('timeline.events.session_ended'), reason: '' };
  const stop = parsed.data;
  const kind = stop.kind;
  const closed = isAutomaticClosureKind(kind);
  if (closed && event.data.exitCode != null && event.data.exitCode !== 0) {
    return { verb: t('timeline.events.session_ended'), reason: '' };
  }
  const human = !closed && stop.by && stop.by.kind !== 'system';
  return {
    verb: t(
      closed ? 'involvement.verbs.closed' : human ? 'involvement.verbs.stopped' : 'involvement.verbs.ended',
    ),
    tone: stop.kind === 'failed' ? 'blocked' : human ? 'needs' : 'neutral',
    reason: closed
      ? closureReason(stop, ctx).long
      : stop.note
        ? t('involvement.quote', { text: stop.note })
        : t(`involvement.stops.${kind}`, {
            code: String(event.data.exitCode ?? ''),
          }),
    by: byLabel(stop.by, ctx),
  };
}

export function involvementText(description: InvolvementDescription): string {
  const detail = [description.reason, description.ref?.text].filter(Boolean).join(': ');
  const main = [description.verb, detail].filter(Boolean).join(' — ');
  return [main, description.by].filter(Boolean).join(' · ');
}
