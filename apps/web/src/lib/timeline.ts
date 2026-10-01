import { BoundaryAuditReason, BoundaryState, LabelChangeReason } from '@projectman/shared';
import type { LabelView, TimelineEvent } from '@projectman/shared';
import { joinNames, t, tDynamic } from '../i18n/t';
import { labelName } from './labels';
import { nameOf, namesOf } from './members';
import type { MemberIndex } from './members';
import type { PipelineIndex } from './pipeline';

export interface TimelineContext {
  pipeline: PipelineIndex | null;
  /** The project's label definitions, for label names. */
  labels?: readonly LabelView[];
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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stageName(ctx: TimelineContext, id: string): string {
  return ctx.pipeline?.stageById.get(id)?.name ?? id;
}

const fieldKeys = ['title', 'description', 'labels', 'visibility', 'stageId', 'parentKey', 'repo'] as const;

function fieldLabel(field: string): string {
  return (fieldKeys as readonly string[]).includes(field)
    ? t(`timeline.fields.${field as (typeof fieldKeys)[number]}`)
    : field;
}

/** A repository named in an event: its name, or that the task had or has none. */
function repoName(value: unknown): string {
  return typeof value === 'string' && value ? value : t('timeline.noRepo');
}

/**
 * A changed field of a task update. A repository change names the repositories it went from and to
 * (events recorded without them name the field only).
 */
function fieldText(field: string, data: Record<string, unknown>): string {
  return field === 'repo' && 'repo' in data
    ? t('timeline.repoChange', { previous: repoName(data.previousRepo), repo: repoName(data.repo) })
    : fieldLabel(field);
}

export function linkLabel(kind: string, ref: string, repo?: string): string {
  switch (kind) {
    case 'pull_request':
      return repo
        ? t('links.prLabelRepo', { number: ref, repo: repo.split('/').pop() ?? repo })
        : t('links.prLabel', { number: ref });
    case 'issue':
      return t('links.issueLabel', { number: ref });
    case 'prerequisite':
      return `${t('links.kinds.prerequisite')}: ${ref}`;
    default:
      return ref;
  }
}

const LEGACY_CHECKS = ['code_review', 'security_review', 'qa', 'client_test'] as const;
const LEGACY_CHECK_STATES = ['pending', 'passed', 'blocked', 'failed', 'retest_needed'] as const;

/** Checks were replaced by labels; events recorded before that still read as they did. */
export function checkLine(check: string, state: string): string {
  const name = (LEGACY_CHECKS as readonly string[]).includes(check)
    ? t(`timeline.legacyChecks.names.${check as (typeof LEGACY_CHECKS)[number]}`)
    : check;
  const label = (LEGACY_CHECK_STATES as readonly string[]).includes(state)
    ? t(`timeline.legacyChecks.states.${state as (typeof LEGACY_CHECK_STATES)[number]}`)
    : state;
  return t('timeline.events.task_check_changed', { check: name, state: label });
}

function labelsChanged(d: Record<string, unknown>, ctx: TimelineContext): string {
  const names = (key: string) =>
    ((d[key] as string[] | undefined) ?? []).map((id) => labelName(id, ctx.labels ?? [])).join(', ');
  const parts = [
    names('added') && t('timeline.labelsAdded', { labels: names('added') }),
    names('removed') && t('timeline.labelsRemoved', { labels: names('removed') }),
  ].filter(Boolean);
  const reason = LabelChangeReason.safeParse(d.reason);
  const why = reason.success ? ` (${t(`timeline.labelReasons.${reason.data}`)})` : '';
  return `${parts.join('; ')}${why}`;
}

/** Attributed, translated text of a timeline event. Free text (notes, messages) stays as written. */
export function describeEvent(event: TimelineEvent, ctx: TimelineContext): DescribedEvent {
  const d = event.data;
  const normal = (text: string): DescribedEvent => ({ text, emphasis: 'normal' });
  switch (event.type) {
    case 'boundary_changed': {
      const state = BoundaryState.safeParse(d.state);
      const reason = BoundaryAuditReason.safeParse(d.reason);
      return {
        text: `${t('boundary.heading')}: ${str(d.resource)} · ${state.success ? t(`boundary.states.${state.data}`) : str(d.state)}${reason.success ? ` · ${t(`boundary.reasons.${reason.data}`)}` : ''}`,
        emphasis: ctx.openInboxIds.has(str(d.requestId)) ? 'needs' : 'normal',
      };
    }
    case 'task_subtask_added':
    case 'task_subtask_removed':
      return normal(
        t(event.type === 'task_subtask_added' ? 'timeline.subtaskAdded' : 'timeline.subtaskRemoved', {
          parentKey: str(d.parentKey),
          subtaskKey: str(d.subtaskKey),
        }),
      );
    case 'task_created':
      return normal(
        t(d.imported === true ? 'timeline.events.task_created_imported' : 'timeline.events.task_created'),
      );
    case 'task_updated': {
      if (d.action === 'cancelled')
        return normal(
          d.reason
            ? t('timeline.events.task_cancelled_reason', { reason: str(d.reason) })
            : t('timeline.events.task_cancelled'),
        );
      if (d.action === 'reopened') return normal(t('timeline.events.task_reopened'));
      // Gate outcomes are recorded as task updates by the server.
      const request = record(d.gateRequest);
      if (request) {
        const pending = strings(request.inboxItemIds).some((id) => ctx.openInboxIds.has(id));
        return {
          text: t('timeline.events.gate_requested', {
            from: stageName(ctx, str(request.from)),
            to: stageName(ctx, str(request.to)),
          }),
          emphasis: pending ? 'needs' : 'normal',
        };
      }
      const rejected = record(d.gateRejected);
      if (rejected)
        return normal(t('timeline.events.gate_rejected', { to: stageName(ctx, str(rejected.to)) }));
      const blocked = record(d.gateBlocked);
      if (blocked) return normal(t('timeline.events.gate_blocked', { to: stageName(ctx, str(blocked.to)) }));
      return normal(
        t('timeline.events.task_updated', {
          fields: strings(d.fields)
            .map((field) => fieldText(field, d))
            .join(t('common.listSeparator')),
        }),
      );
    }
    case 'task_stage_changed':
      return normal(
        t('timeline.events.task_stage_changed', {
          from: stageName(ctx, str(d.from)),
          to: stageName(ctx, str(d.to)),
        }),
      );
    case 'task_assigned': {
      const assignment = d.assignee
        ? t('timeline.events.task_assigned', { assignee: nameOf(str(d.assignee), ctx.members, ctx.myHandle) })
        : t('timeline.events.task_unassigned');
      return normal(
        d.previous
          ? t('timeline.events.assignment_previous', {
              assignment,
              previous: nameOf(str(d.previous), ctx.members, ctx.myHandle),
            })
          : assignment,
      );
    }
    case 'task_check_changed':
      return normal(checkLine(str(d.check), str(d.to)));
    case 'task_labels_changed':
      return normal(labelsChanged(d, ctx));
    case 'task_link_added':
      return normal(
        t('timeline.events.task_link_added', {
          link: linkLabel(str(d.kind), str(d.ref), d.repo ? str(d.repo) : undefined),
        }),
      );
    case 'task_note':
      return normal(str(d.text));
    case 'attachment_added':
    case 'attachment_deleted':
      return normal(
        t(event.type === 'attachment_added' ? 'timeline.attachmentAdded' : 'timeline.attachmentDeleted', {
          fileName: str(d.fileName),
        }),
      );
    case 'schedule_started':
      return normal(t('schedules.startedEvent'));
    case 'schedule_skipped':
      return normal(
        t('schedules.skippedEvent', {
          reason: tDynamic(`schedules.reasons.${str(d.reason)}`, str(d.reason)),
        }),
      );
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
      if (event.actor.kind === 'system')
        return normal(
          t(
            d.decision === 'deny'
              ? 'timeline.events.permission_automatic_deny'
              : 'timeline.events.permission_automatic_allow',
          ),
        );
      // A level of "ask, AI decides": an AI member answered the request, not a person.
      if (event.actor.kind === 'ai')
        return normal(
          t(
            d.decision === 'deny'
              ? 'timeline.events.permission_ai_denied'
              : 'timeline.events.permission_ai_allowed',
          ),
        );
      return normal(
        d.decision === 'deny'
          ? t('timeline.events.permission_denied')
          : t('timeline.events.permission_allowed'),
      );
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
