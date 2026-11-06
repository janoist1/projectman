import { memberDuties } from '../config/duties';
import type { MemberConfig, ProjectConfig } from '../config/schema';
import type { FeedbackCardRef, FeedbackOutcome, FeedbackStatus } from './feedback';
import type { Task } from './task';

export { feedbackOriginRefusal, normalizeFeedbackOrigin } from './feedback-origin';

/**
 * Whether the member decides marks: they hold the `feedback_processing` duty, or they are a human
 * owner or admin (who may always process).
 */
export function canProcessFeedback(config: Pick<ProjectConfig, 'team'>, member: MemberConfig): boolean {
  if (member.kind === 'human' && (member.access === 'owner' || member.access === 'admin')) return true;
  return memberDuties(config, member).includes('feedback_processing');
}

/**
 * Whether the member deletes the mark (PM-1189): its author, or a human owner or admin. A viewer
 * never deletes, and neither does an AI member, not even a processor.
 */
export function canDeleteFeedback(member: MemberConfig, mark: { author: string }): boolean {
  if (member.kind !== 'human' || member.access === 'viewer') return false;
  if (member.access === 'owner' || member.access === 'admin') return true;
  return member.handle === mark.author;
}

export type FeedbackMarkRefusalReason = 'not_human' | 'viewer' | 'blocked' | 'no_surface';

/** Why the member cannot place marks, or null: a human who is not a viewer, not blocked, with a surface set up. */
export function feedbackMarkRefusal(
  config: Pick<ProjectConfig, 'project'>,
  member: MemberConfig,
): FeedbackMarkRefusalReason | null {
  if (member.kind !== 'human') return 'not_human';
  if (member.access === 'viewer') return 'viewer';
  if (config.project.feedback?.blockedMarkers.includes(member.handle)) return 'blocked';
  if ((config.project.feedback?.surfaces.length ?? 0) === 0) return 'no_surface';
  return null;
}

export function canMarkFeedback(config: Pick<ProjectConfig, 'project'>, member: MemberConfig): boolean {
  return feedbackMarkRefusal(config, member) === null;
}

/** The card of a mark. Every member sees every card (PM-79). */
export function feedbackCardRef(task: Pick<Task, 'key' | 'title'>, stageName: string): FeedbackCardRef {
  return { visible: true, key: task.key, title: task.title, stageName };
}

export type FeedbackAction = 'comment' | 'create_task' | 'link' | 'forward' | 'close' | 'reopen';

export type FeedbackRefusal =
  | 'feedback_closed'
  | 'feedback_not_closed'
  | 'feedback_task_exists'
  | 'feedback_waiting_owner'
  | 'feedback_processor_only';

export interface FeedbackPlan {
  status: FeedbackStatus;
  outcome: FeedbackOutcome | null;
  /** The processor decided: the "an AI was woken for it" mark is cleared. */
  clearHanded: boolean;
  /** The processor is woken for the mark. */
  wakeProcessor: boolean;
}

/**
 * What an action does to a mark, or why it is refused. A processor's step is what a processor
 * other than the marker does; the marker's own comment is a marker's comment even if they are a
 * processor. Deciding (a card, a link, closing, forwarding, reopening) is a processor's alone.
 */
export function planFeedbackAction(
  mark: { status: FeedbackStatus; outcome: FeedbackOutcome | null; taskKey: string | null; author: string },
  action: FeedbackAction,
  actor: { handle: string; kind: 'human' | 'ai'; processor: boolean },
): FeedbackPlan | { refused: FeedbackRefusal } {
  const refuse = (refused: FeedbackRefusal) => ({ refused });
  const closed = mark.status === 'closed';
  switch (action) {
    case 'comment': {
      if (closed) return refuse('feedback_closed');
      if (actor.processor && actor.handle !== mark.author) {
        // A person's answer settles a mark that waits for the owner; an AI's does not.
        const status: FeedbackStatus =
          mark.status === 'waiting_owner' && actor.kind === 'ai' ? 'waiting_owner' : 'handled';
        const outcome = status === 'handled' && mark.outcome === null ? 'answered' : mark.outcome;
        return { status, outcome, clearHanded: true, wakeProcessor: false };
      }
      const status: FeedbackStatus = mark.status === 'handled' ? 'new' : mark.status;
      return { status, outcome: mark.outcome, clearHanded: false, wakeProcessor: true };
    }
    case 'create_task':
    case 'link': {
      if (!actor.processor) return refuse('feedback_processor_only');
      if (closed) return refuse('feedback_closed');
      if (action === 'create_task' && mark.taskKey) return refuse('feedback_task_exists');
      if (actor.kind === 'ai' && mark.status === 'waiting_owner') return refuse('feedback_waiting_owner');
      return {
        status: 'handled',
        outcome: action === 'create_task' ? 'card_created' : 'card_linked',
        clearHanded: true,
        wakeProcessor: false,
      };
    }
    case 'forward': {
      if (!actor.processor || actor.kind !== 'ai') return refuse('feedback_processor_only');
      if (closed) return refuse('feedback_closed');
      if (mark.status === 'waiting_owner') return refuse('feedback_waiting_owner');
      return { status: 'waiting_owner', outcome: mark.outcome, clearHanded: true, wakeProcessor: false };
    }
    case 'close': {
      if (!actor.processor) return refuse('feedback_processor_only');
      if (closed) return refuse('feedback_closed');
      if (actor.kind === 'ai' && mark.status === 'waiting_owner') return refuse('feedback_waiting_owner');
      return { status: 'closed', outcome: mark.outcome, clearHanded: true, wakeProcessor: false };
    }
    case 'reopen': {
      if (!actor.processor) return refuse('feedback_processor_only');
      if (!closed) return refuse('feedback_not_closed');
      const decided = mark.taskKey !== null || mark.outcome !== null;
      return {
        status: decided ? 'handled' : 'new',
        outcome: mark.outcome,
        clearHanded: false,
        wakeProcessor: false,
      };
    }
  }
}

/**
 * The address a person is sent to so the tool starts on the customer page. A target without `#`
 * carries the one-time code in the fragment (`#pm-feedback=…`); a target with one (a hash-routed
 * page) carries it in the query before the `#`, where the router does not swallow it. The widget
 * reads both places.
 */
export function feedbackLaunchUrl(target: string, code: string, markId?: string): string {
  const params = `pm-feedback=${encodeURIComponent(code)}${
    markId ? `&pm-feedback-mark=${encodeURIComponent(markId)}` : ''
  }`;
  const hashAt = target.indexOf('#');
  if (hashAt < 0) return `${target}#${params}`;
  const base = target.slice(0, hashAt);
  const hash = target.slice(hashAt);
  return `${base}${base.includes('?') ? '&' : '?'}${params}${hash}`;
}
