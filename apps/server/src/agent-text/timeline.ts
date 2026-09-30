import type { TimelineEvent } from '@projectman/shared';
import { numberedRef } from './links';
import { formatTimestamp, oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Maximum length of a data value shown for an event type without its own wording. */
const FIELD_LIMIT = 80;

/**
 * What the actor did, e.g. `moved it from Ready to Development` or `labels added: qa-ok`. Free
 * text (notes, messages, questions) is shortened to `textLimit` characters. Every event type
 * has a wording, including legacy ones that stay in the append-only timeline.
 */
export function describeEvent(
  event: TimelineEvent,
  textLimit: number,
  style: TextStyle = PLAIN_STYLE,
): string {
  const data = event.data;
  const text = (key: string): string | null => {
    const value = data[key];
    return (typeof value === 'string' && value.trim()) || typeof value === 'number'
      ? oneLine(String(value), textLimit)
      : null;
  };
  const list = (key: string): string[] => {
    const value = data[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  };
  const stage = (key: string): string => {
    const id = text(key);
    return id ? style.stage(id) : '?';
  };
  const member = (key: string, fallback: string): string => {
    const handle = text(key);
    return handle ? style.code(handle) : fallback;
  };

  switch (event.type) {
    case 'task_created':
      return text('title') ? `created the task "${text('title')}"` : 'created the task';
    case 'task_updated':
      return list('fields').length > 0 ? `updated ${list('fields').join(', ')}` : 'updated the task';
    case 'task_stage_changed':
      return `moved it from ${stage('from')} to ${stage('to')}`;
    case 'task_assigned':
      return text('assignee') ? `assigned it to ${member('assignee', '')}` : 'unassigned it';
    case 'task_labels_changed': {
      const added = list('added').map((id) => style.label(id));
      const removed = list('removed').map((id) => style.label(id));
      const parts = [
        ...(added.length > 0 ? [`labels added: ${added.join(', ')}`] : []),
        ...(removed.length > 0 ? [`labels removed: ${removed.join(', ')}`] : []),
      ];
      return parts.length > 0 ? parts.join('; ') : 'changed the labels';
    }
    case 'task_check_changed':
      // Checks were replaced by labels; events recorded before that stay in the timeline.
      return `set the ${text('check') ?? '?'} check to ${text('to') ?? '?'}${text('from') ? ` (was ${text('from')})` : ''}`;
    case 'task_link_added': {
      const kind = (text('kind') ?? 'link').replace(/_/g, ' ');
      return `linked ${kind} ${numberedRef(text('ref') ?? '', text('repo'))}`.trimEnd();
    }
    case 'task_note':
      return `note: ${text('text') ?? ''}`.trimEnd();
    case 'team_message': {
      const to = list('to').length > 0 ? list('to') : [text('to')].filter((h): h is string => !!h);
      const recipients = to.length > 0 ? ` to ${to.map((h) => style.code(h)).join(', ')}` : '';
      return `message${recipients}: ${text('excerpt') ?? ''}`.trimEnd();
    }
    case 'question_asked':
      return `asked a human: ${text('question') ?? ''}`.trimEnd();
    case 'question_answered':
      return `answered: ${text('answer') ?? ''}`.trimEnd();
    case 'member_hired':
      return `hired ${member('handle', 'a member')}`;
    case 'member_retired':
      return `retired ${member('handle', 'a member')}`;
    case 'config_changed':
      return `changed the configuration${text('message') ? `: ${text('message')}` : ''}`;
    default: {
      const fields = Object.entries(data)
        .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => `${key}=${oneLine(String(value), FIELD_LIMIT)}`);
      return fields.length > 0 ? `${event.type} (${fields.join(', ')})` : event.type;
    }
  }
}

/** `- 2026-09-28 08:06 UTC · fe-1: moved it from Ready to Development` */
export function timelineLine(
  event: TimelineEvent,
  textLimit: number,
  style: TextStyle = PLAIN_STYLE,
): string {
  const actor = event.actor.handle ? style.code(event.actor.handle) : event.actor.kind;
  return `- ${formatTimestamp(event.createdAt)} · ${actor}: ${describeEvent(event, textLimit, style)}`;
}

export interface TimelineOptions {
  /** How many of the most recent events are shown. */
  limit: number;
  /** Maximum length of free text (notes, messages, questions) in a line. */
  textLimit: number;
  style?: TextStyle;
  /** Event types left out, e.g. session bookkeeping. */
  skip?: ReadonlySet<string>;
}

export interface RecentTimeline {
  /** One line per shown event, oldest first. */
  lines: string[];
  /** Events after skipping, shown or not. */
  total: number;
}

/** The most recent events as timeline lines, oldest first (the input may be in any order). */
export function recentTimeline(events: readonly TimelineEvent[], opts: TimelineOptions): RecentTimeline {
  const kept = events
    .filter((e) => !opts.skip?.has(e.type))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    lines: kept.slice(-opts.limit).map((e) => timelineLine(e, opts.textLimit, opts.style)),
    total: kept.length,
  };
}
