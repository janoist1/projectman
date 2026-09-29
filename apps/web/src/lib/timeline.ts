import { CheckName, CheckState } from '@projectman/shared';
import type { TimelineEvent } from '@projectman/shared';
import { joinNames, t } from '../i18n/t';
import { nameOf, namesOf } from './members';
import type { MemberIndex } from './members';
import type { PipelineIndex } from './pipeline';

export interface TimelineContext {
  pipeline: PipelineIndex | null;
  members: MemberIndex;
  myHandle: string | null;
  /** Inbox items still open: their request events are highlighted. */
  openInboxIds: ReadonlySet<string>;
}

export interface DescribedEvent {
  text: string;
  emphasis: 'normal' | 'needs';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stageName(ctx: TimelineContext, id: string): string {
  return ctx.pipeline?.stageById.get(id)?.name ?? id;
}

const fieldKeys = ['title', 'description', 'labels', 'visibility', 'stageId'] as const;

function fieldLabel(field: string): string {
  return (fieldKeys as readonly string[]).includes(field) ? t(`timeline.fields.${field as (typeof fieldKeys)[number]}`) : field;
}

export function linkLabel(kind: string, ref: string, repo?: string): string {
  switch (kind) {
    case 'pull_request':
      return repo ? t('links.prLabelRepo', { number: ref, repo: repo.split('/').pop() ?? repo }) : t('links.prLabel', { number: ref });
    case 'issue':
      return t('links.issueLabel', { number: ref });
    case 'prerequisite':
      return `${t('links.kinds.prerequisite')}: ${ref}`;
    default:
      return ref;
  }
}

export function checkLine(check: string, state: string): string {
  const name = CheckName.safeParse(check).success ? t(`checks.names.${check as CheckName}`) : check;
  const label = CheckState.safeParse(state).success ? t(`checks.states.${state as CheckState}`) : state;
  return t('checks.line', { name, state: label });
}

/** Attributed, translated text of a timeline event. Free text (notes, messages) stays as written. */
export function describeEvent(event: TimelineEvent, ctx: TimelineContext): DescribedEvent {
  const d = event.data;
  const normal = (text: string): DescribedEvent => ({ text, emphasis: 'normal' });
  switch (event.type) {
    case 'task_created':
      return normal(t('timeline.events.task_created'));
    case 'task_updated': {
      // Gate outcomes are recorded as task updates by the server.
      const request = record(d.gateRequest);
      if (request) {
        const pending = strings(request.inboxItemIds).some((id) => ctx.openInboxIds.has(id));
        return {
          text: t('timeline.events.gate_requested', { from: stageName(ctx, str(request.from)), to: stageName(ctx, str(request.to)) }),
          emphasis: pending ? 'needs' : 'normal',
        };
      }
      const rejected = record(d.gateRejected);
      if (rejected) return normal(t('timeline.events.gate_rejected', { to: stageName(ctx, str(rejected.to)) }));
      const blocked = record(d.gateBlocked);
      if (blocked) return normal(t('timeline.events.gate_blocked', { to: stageName(ctx, str(blocked.to)) }));
      return normal(t('timeline.events.task_updated', { fields: strings(d.fields).map(fieldLabel).join(t('common.listSeparator')) }));
    }
    case 'task_stage_changed':
      return normal(
        t('timeline.events.task_stage_changed', { from: stageName(ctx, str(d.from)), to: stageName(ctx, str(d.to)) }),
      );
    case 'task_assigned':
      return normal(
        d.assignee
          ? t('timeline.events.task_assigned', { assignee: nameOf(str(d.assignee), ctx.members, ctx.myHandle) })
          : t('timeline.events.task_unassigned'),
      );
    case 'task_check_changed':
      return normal(checkLine(str(d.check), str(d.to)));
    case 'task_link_added':
      return normal(t('timeline.events.task_link_added', { link: linkLabel(str(d.kind), str(d.ref), d.repo ? str(d.repo) : undefined) }));
    case 'task_note':
      return normal(str(d.text));
    case 'session_started':
      return normal(d.resumed ? t('timeline.events.session_resumed') : t('timeline.events.session_started'));
    case 'session_ended':
      return normal(t('timeline.events.session_ended'));
    case 'team_message':
      return normal(
        t('timeline.events.team_message', {
          to: joinNames(namesOf(strings(d.to), ctx.members, ctx.myHandle)),
          excerpt: str(d.excerpt),
        }),
      );
    case 'permission_requested':
      return {
        text: t('timeline.events.permission_requested', { summary: str(d.summary) || str(d.toolName) }),
        emphasis: ctx.openInboxIds.has(str(d.inboxItemId)) ? 'needs' : 'normal',
      };
    case 'permission_resolved':
      return normal(d.decision === 'deny' ? t('timeline.events.permission_denied') : t('timeline.events.permission_allowed'));
    case 'question_asked':
      return {
        text: t('timeline.events.question_asked', { question: str(d.question) }),
        emphasis: ctx.openInboxIds.has(str(d.inboxItemId)) ? 'needs' : 'normal',
      };
    case 'question_answered':
      return normal(t('timeline.events.question_answered', { answer: str(d.answer) }));
    case 'member_hired':
      return normal(t('timeline.events.member_hired', { handle: str(d.handle) }));
    case 'member_retired':
      return normal(
        d.handoverTo
          ? t('timeline.events.member_retired_handover', {
              handle: str(d.handle),
              to: nameOf(str(d.handoverTo), ctx.members, ctx.myHandle),
            })
          : t('timeline.events.member_retired', { handle: str(d.handle) }),
      );
    case 'config_changed':
      return normal(t('timeline.events.config_changed', { message: str(d.message) }));
  }
}
