import { BoundaryAuditReason, BoundaryState, LabelChangeReason, TaskRelationKind } from '@projectman/shared';
import type { LabelView, TimelineEvent } from '@projectman/shared';
import { joinNames, t, tDynamic } from '../i18n/t';
import { fixRoundParts } from './fixLimit';
import { labelName } from './labels';
import { decidesText, pairText } from './loop';
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
  /** Raw (often English) explanation, shown folded behind "Részletek". */
  detail?: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** The first characters of a commit id, as git abbreviates it. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 8);
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

/** The name of a relation kind as the card that shows it sees it; a kind this build does not know shows as it is. */
export function relationKindLabel(kind: string): string {
  const parsed = TaskRelationKind.safeParse(kind);
  return parsed.success ? t(`relations.kinds.${parsed.data}`) : kind;
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
    case 'related':
    case 'duplicate_of':
      return `${t(`links.kinds.${kind}`)}: ${ref}`;
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

const LOOP_END_REASONS = ['label', 'stage', 'commit', 'quiet', 'stopped', 'disabled', 'closed'] as const;

/** A loop on the card (PM-261): found, escalated to people, let run, or over. */
function loopEventText(d: Record<string, unknown>, ctx: TimelineContext): string {
  const decides = () => decidesText(strings(d.deciders), ctx.members, ctx.myHandle);
  switch (d.phase) {
    case 'escalated':
      return t(
        d.reason === 'continued' ? 'loop.events.escalated.continued' : 'loop.events.escalated.no_watcher',
        {
          decides: decides(),
        },
      );
    case 'let_run':
      return t('loop.events.let_run', { name: nameOf(str(d.by), ctx.members, ctx.myHandle) });
    case 'ended': {
      const reason = (LOOP_END_REASONS as readonly string[]).includes(str(d.endReason))
        ? t(`loop.endReasons.${str(d.endReason) as (typeof LOOP_END_REASONS)[number]}`)
        : str(d.endReason);
      return t('loop.events.ended', { reason });
    }
    default: {
      const found = {
        pair: pairText(strings(d.members), ctx.members, ctx.myHandle),
        minutes: Number(d.minutes) || 0,
        count: Number(d.count) || 0,
      };
      return d.notified
        ? t('loop.events.raised', { ...found, name: nameOf(str(d.notified), ctx.members, ctx.myHandle) })
        : t('loop.events.raisedToPeople', found);
    }
  }
}

const FIX_LIMIT_DECISIONS = ['continue', 'another_round', 'replan', 'reassign'] as const;
const FIX_LIMIT_END_REASONS = ['decided', 'assignee_changed', 'closed'] as const;

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A card held at its fix round limit (PM-262): reached, passed on to the people, decided, or over. */
function fixLimitEventText(d: Record<string, unknown>, ctx: TimelineContext): string {
  const note = str(d.note).trim();
  const withNote = note ? t('fixLimit.events.note', { note }) : '';
  switch (d.phase) {
    case 'passed_on':
      // The row's header names who did it, so the text does not.
      return t('fixLimit.events.passed_on', {
        decides: decidesText(strings(d.deciders), ctx.members, ctx.myHandle),
        note: withNote,
      });
    case 'decided': {
      const decision = (FIX_LIMIT_DECISIONS as readonly string[]).includes(str(d.decision))
        ? t(`fixLimit.decisions.${str(d.decision) as (typeof FIX_LIMIT_DECISIONS)[number]}`)
        : str(d.decision);
      return t('fixLimit.events.decided', {
        decision,
        note: withNote,
      });
    }
    case 'ended': {
      const reason = (FIX_LIMIT_END_REASONS as readonly string[]).includes(str(d.endReason))
        ? t(`fixLimit.endReasons.${str(d.endReason) as (typeof FIX_LIMIT_END_REASONS)[number]}`)
        : str(d.endReason);
      return t('fixLimit.events.ended', { reason });
    }
    default: {
      const deciders = strings(d.deciders);
      const who = d.decider
        ? t('fixLimit.events.who', { name: nameOf(str(d.decider), ctx.members, ctx.myHandle) })
        : t('fixLimit.events.people', {
            // It opens a sentence: "Te döntesz." and not "te döntesz."
            decides: upperFirst(decidesText(deciders, ctx.members, ctx.myHandle)),
          });
      const rounds = Number(d.rounds) || 0;
      const limit = Number(d.limit) || 0;
      const parts = fixRoundParts({
        changeRequests: Number(d.changeRequests) || 0,
        designChangeRequests: Number(d.designChangeRequests) || 0,
        sendBacks: Number(d.sendBacks) || 0,
      });
      // The limit is named only when it is not the number of rounds itself.
      return rounds === limit
        ? t('fixLimit.events.reached', { rounds, parts, who })
        : t('fixLimit.events.reachedLimit', { rounds, limit, parts, who });
    }
  }
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
          d.duplicateOf
            ? t('timeline.events.task_cancelled_duplicate', { original: str(d.duplicateOf) })
            : d.reason
              ? t('timeline.events.task_cancelled_reason', { reason: str(d.reason) })
              : t('timeline.events.task_cancelled'),
        );
      if (d.action === 'reopened') return normal(t('timeline.events.task_reopened'));
      if (d.action === 'closed') return normal(t('timeline.events.theme_closed'));
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
      const repinned = record(d.reviewPin);
      if (repinned)
        return normal(
          t('timeline.events.review_repinned', {
            previous: shortCommit(str(repinned.previous)),
            commit: shortCommit(str(repinned.commit)),
          }),
        );
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
    case 'task_stage_changed': {
      const names = { from: stageName(ctx, str(d.from)), to: stageName(ctx, str(d.to)) };
      const moved = record(d.branchMoved);
      if (moved)
        return normal(
          t('timeline.events.task_stage_changed_branch_moved', {
            ...names,
            pinned: shortCommit(str(moved.pinned)),
            head: shortCommit(str(moved.head)),
          }),
        );
      const pin = record(d.reviewPin);
      if (pin)
        return normal(
          t('timeline.events.task_stage_changed_pinned', { ...names, commit: shortCommit(str(pin.commit)) }),
        );
      return normal(t('timeline.events.task_stage_changed', names));
    }
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
    case 'refinement_turn': {
      const label = d.label ? labelName(str(d.label), ctx.labels ?? []) : '';
      if (d.reason === 'done') return normal(t('timeline.refinement.done'));
      // An event of a reason this web app does not know reads like a step that followed the last one.
      const reason = d.reason === 'started' || d.reason === 'label_removed' ? d.reason : 'label_set';
      return normal(
        t(`timeline.refinement.${reason}.${d.member ? 'member' : 'person'}`, {
          label,
          member: d.member ? nameOf(str(d.member), ctx.members, ctx.myHandle) : '',
        }),
      );
    }
    case 'task_loop':
      return normal(loopEventText(d, ctx));
    case 'task_fix_limit':
      return normal(fixLimitEventText(d, ctx));
    case 'task_link_added':
      return normal(
        t('timeline.events.task_link_added', {
          link: linkLabel(str(d.kind), str(d.ref), d.repo ? str(d.repo) : undefined),
        }),
      );
    case 'task_relation_added':
    case 'task_relation_removed':
      return normal(
        t(event.type === 'task_relation_added' ? 'timeline.relationAdded' : 'timeline.relationRemoved', {
          kind: relationKindLabel(str(d.kind)),
          ref: str(d.ref),
        }),
      );
    case 'task_theme_changed': {
      const themeKey = d.themeKey ? str(d.themeKey) : '';
      const previous = d.previous ? str(d.previous) : '';
      if (!themeKey) return normal(t('timeline.themeRemoved', { previous }));
      return normal(
        previous ? t('timeline.themeMoved', { previous, themeKey }) : t('timeline.themeSet', { themeKey }),
      );
    }
    case 'task_prerequisite_closed': {
      const remaining = strings(d.remaining);
      return normal(
        t(str(d.status) === 'cancelled' ? 'timeline.prerequisiteWithdrawn' : 'timeline.prerequisiteDone', {
          ref: str(d.ref),
        }) +
          ' ' +
          (remaining.length > 0
            ? t('timeline.prerequisiteRemaining', { remaining: remaining.join(', ') })
            : t('timeline.prerequisiteFree')),
      );
    }
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
    case 'session_permission_changed': {
      const approver = d.field === 'approver';
      const value = (v: unknown) =>
        !str(v)
          ? t('common.dash')
          : approver
            ? tDynamic(`permissionControls.approvers.${str(v)}`, str(v))
            : tDynamic(`permissionModes.${str(v)}`, str(v));
      const change = t(
        approver ? 'timeline.events.session_permission_approver' : 'timeline.events.session_permission_mode',
        {
          member: nameOf(str(d.member), ctx.members, ctx.myHandle),
          from: value(d.from),
          to: value(d.to),
        },
      );
      const reset = d.reset === true ? t('timeline.events.session_permission_reset', { change }) : change;
      return normal(
        d.restart === true ? t('timeline.events.session_permission_restart', { change: reset }) : reset,
      );
    }
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
        return {
          ...normal(
            t(
              d.decision === 'deny'
                ? 'timeline.events.permission_ai_denied'
                : 'timeline.events.permission_ai_allowed',
            ),
          ),
          ...(str(d.reason) ? { detail: str(d.reason) } : {}),
        };
      return normal(
        d.decision === 'deny'
          ? t('timeline.events.permission_denied')
          : t('timeline.events.permission_allowed'),
      );
    case 'permission_refused':
      return {
        ...normal(
          t(
            d.by === 'classifier'
              ? 'timeline.events.permission_refused_classifier'
              : 'timeline.events.permission_refused_approver_none',
            { summary: str(d.summary) || str(d.toolName) },
          ),
        ),
        ...(str(d.reason) ? { detail: str(d.reason) } : {}),
      };
    case 'permission_escalated':
      return {
        text: t(
          d.cause === 'timeout'
            ? 'timeline.events.permission_escalated_timeout'
            : 'timeline.events.permission_escalated_lead',
        ),
        emphasis: ctx.openInboxIds.has(str(d.inboxItemId)) ? 'needs' : 'normal',
        ...(str(d.reason) ? { detail: str(d.reason) } : {}),
      };
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
