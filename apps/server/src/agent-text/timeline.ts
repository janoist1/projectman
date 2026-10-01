import type { TimelineEvent } from '@projectman/shared';
import { numberedRef } from './links';
import { formatTimestamp, oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Maximum length of a data value shown for an event type without its own wording. */
const FIELD_LIMIT = 80;

/**
 * What a team message line says when the message is for the reader and has not been typed into its
 * session yet (it waits for the end of the turn): the line shows only an excerpt, and the reader
 * must not ask the sender to write it again (PM-180).
 */
const NOT_DELIVERED_YET =
  '(not delivered to you yet: the full text is typed in when your current turn ends; do not ask for a resend)';

/**
 * What the actor did, e.g. `moved it from Ready to Development` or `labels added: qa-ok`. Free
 * text (notes, messages, questions) is shortened to `textLimit` characters. Every event type
 * has a wording, including legacy ones that stay in the append-only timeline.
 */
export function describeEvent(
  event: TimelineEvent,
  textLimit: number,
  style: TextStyle = PLAIN_STYLE,
  undelivered?: ReadonlySet<string>,
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
      return describeTaskUpdate(data, text, list, style);
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
    case 'attachment_added':
      return `attached the file ${text('fileName') ?? '?'}`;
    case 'attachment_deleted':
      return `deleted the attachment ${text('fileName') ?? '?'}`;
    case 'team_message': {
      const to = list('to').length > 0 ? list('to') : [text('to')].filter((h): h is string => !!h);
      const recipients = to.length > 0 ? ` to ${to.map((h) => style.code(h)).join(', ')}` : '';
      const line = `message${recipients}: ${text('excerpt') ?? ''}`.trimEnd();
      const id = typeof data.messageId === 'string' ? data.messageId : null;
      return id && undelivered?.has(id) ? `${line} ${NOT_DELIVERED_YET}` : line;
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

/**
 * A `task_updated` event: what happened to the task (cancelled with the reason, reopened, an
 * approval requested or rejected, a move refused after approval, a pull request changing),
 * else which fields changed.
 */
function describeTaskUpdate(
  data: Record<string, unknown>,
  text: (key: string) => string | null,
  list: (key: string) => string[],
  style: TextStyle,
): string {
  const record = (key: string): Record<string, unknown> | null => {
    const value = data[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  };
  const field = (value: Record<string, unknown>, key: string): string | null =>
    typeof value[key] === 'string' || typeof value[key] === 'number' ? String(value[key]) : null;

  const action = text('action');
  if (action === 'cancelled') return `cancelled the task${text('reason') ? `: ${text('reason')}` : ''}`;
  if (action === 'reopened') return 'reopened the task';
  const request = record('gateRequest');
  if (request) {
    const to = field(request, 'to');
    return `asked a human to approve the move${to ? ` to ${style.stage(to)}` : ''}`;
  }
  const rejected = record('gateRejected');
  if (rejected) {
    const to = field(rejected, 'to');
    return `the move${to ? ` to ${style.stage(to)}` : ''} was not approved`;
  }
  const blocked = record('gateBlocked');
  if (blocked) {
    const to = field(blocked, 'to');
    const why = field(blocked, 'reason');
    return `the approved move${to ? ` to ${style.stage(to)}` : ''} could not happen${why ? ` (${why})` : ''}`;
  }
  const pr = record('pullRequest');
  if (pr) {
    const repo = field(pr, 'repo');
    const number = field(pr, 'number');
    const state = field(pr, 'state');
    return `pull request ${numberedRef(number ?? '', repo)}${state ? ` is ${state}` : ' changed'}`.trim();
  }
  // A repository change names the repositories it went from and to.
  const repos =
    'repo' in data ? ` (${repoName(data.previousRepo, style)} -> ${repoName(data.repo, style)})` : '';
  const fields = list('fields').map((name) => (name === 'repo' ? `repo${repos}` : name));
  return fields.length > 0 ? `updated ${fields.join(', ')}` : 'updated the task';
}

/** A repository named in an event, or "none" when the task had or has none. */
function repoName(value: unknown, style: TextStyle): string {
  return typeof value === 'string' && value ? style.code(value) : 'none';
}

/** `- 2026-09-28 08:06 UTC · fe-1: moved it from Ready to Development` */
export function timelineLine(
  event: TimelineEvent,
  textLimit: number,
  style: TextStyle = PLAIN_STYLE,
  undelivered?: ReadonlySet<string>,
): string {
  const actor = event.actor.handle ? style.code(event.actor.handle) : event.actor.kind;
  return `- ${formatTimestamp(event.createdAt)} · ${actor}: ${describeEvent(event, textLimit, style, undelivered)}`;
}

export interface TimelineOptions {
  /** How many of the most recent events are shown. */
  limit: number;
  /** Maximum length of free text (notes, messages, questions) in a line. */
  textLimit: number;
  style?: TextStyle;
  /** Event types left out, e.g. session bookkeeping. */
  skip?: ReadonlySet<string>;
  /** Ids of the team messages for the reader that were not typed into its session yet. */
  undelivered?: ReadonlySet<string>;
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
    lines: kept.slice(-opts.limit).map((e) => timelineLine(e, opts.textLimit, opts.style, opts.undelivered)),
    total: kept.length,
  };
}
