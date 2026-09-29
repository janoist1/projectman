import type { MemberView, Task, TaskDetail, TaskLink, TimelineEvent } from '@projectman/shared';

/**
 * Tool results are short plain text: cheap for the model to read and easy to scan in
 * transcripts. Free text written by people and agents (titles, notes, messages) is data
 * and is passed through, shortened where it could flood the context.
 */

const MAX_DESCRIPTION_CHARS = 6000;
const MAX_TIMELINE_EVENTS = 20;
const MAX_EVENT_TEXT_CHARS = 300;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Collapses whitespace so free text fits on one line. */
function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** "2026-09-29T10:15:03.000Z" -> "2026-09-29 10:15" (other formats are kept as they are). */
function shortTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

/* ---------- members ---------- */

export function formatMembers(members: MemberView[], self: string): string {
  if (members.length === 0) return 'The team has no members.';
  const lines = members.map((m) => {
    const who = m.handle === self ? `${m.handle} (you)` : m.handle;
    const kind = m.kind === 'ai' ? 'AI' : 'human';
    const role = `${kind} ${m.role}${m.specialty ? ` (${m.specialty})` : ''}${m.temp ? ', temporary' : ''}`;
    const status = m.activity ? `${m.status}: ${oneLine(m.activity, 80)}` : m.status;
    const tasks = m.currentTaskKeys.length > 0 ? ` · tasks: ${m.currentTaskKeys.join(', ')}` : '';
    return `- ${who} — ${m.displayName} · ${role} · ${status}${tasks}`;
  });
  return [`Team (${members.length} members, address them by handle):`, ...lines].join('\n');
}

/* ---------- tasks ---------- */

function describeLink(link: TaskLink): string {
  const title = link.title ? ` "${oneLine(link.title, 100)}"` : '';
  const state = link.state ? ` (${link.state})` : '';
  switch (link.kind) {
    case 'pull_request':
      return `PR ${link.repo ?? ''}#${link.ref}${title}${state}`;
    case 'issue':
      return `issue ${link.repo ?? ''}#${link.ref}${title}${state}`;
    case 'branch':
      return `branch ${link.ref}${link.repo ? ` (${link.repo})` : ''}`;
    case 'prerequisite':
      return `prerequisite ${link.ref}${state}`;
    case 'url':
      return `${link.title ? `${oneLine(link.title, 100)}: ` : ''}${link.ref}`;
  }
}

function checksText(task: Task): string {
  const entries = Object.entries(task.checks).filter(([, state]) => state !== undefined);
  return entries.length > 0 ? entries.map(([name, state]) => `${name} ${state}`).join(', ') : 'none recorded';
}

/** One line with where the task stands. */
export function taskStatusLine(task: Task): string {
  return [
    `Stage: ${task.stageId}`,
    `Status: ${task.status}`,
    `Assignee: ${task.assignee ?? 'none'}`,
    `Checks: ${checksText(task)}`,
  ].join(' · ');
}

function eventText(event: TimelineEvent): string {
  const data = event.data;
  const str = (key: string): string => {
    const value = data[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  };
  const text = (key: string) => oneLine(str(key), MAX_EVENT_TEXT_CHARS);
  switch (event.type) {
    case 'task_created':
      return `created the task "${text('title')}"`;
    case 'task_stage_changed':
      return `moved it ${str('from') || '?'} → ${str('to') || '?'}`;
    case 'task_assigned':
      return `assigned it to ${str('assignee') || 'nobody'}`;
    case 'task_check_changed':
      return `check ${str('check')}: ${str('from') || 'none'} → ${str('to')}`;
    case 'task_link_added': {
      const kind = str('kind');
      const repo = str('repo');
      const numbered = kind === 'pull_request' || kind === 'issue';
      return `linked ${kind} ${numbered ? `${repo}#${str('ref')}` : str('ref')}`;
    }
    case 'task_note':
      return `note: ${text('text')}`;
    case 'team_message': {
      const to = Array.isArray(data.to) ? data.to.join(', ') : str('to');
      return `message to ${to}: ${text('excerpt')}`;
    }
    case 'question_asked':
      return `asked a human: ${text('question')}`;
    case 'question_answered':
      return `human answer: ${text('answer')}`;
    default: {
      const fields = Object.entries(data)
        .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
        .map(([key, value]) => `${key}=${oneLine(String(value), 80)}`);
      return fields.length > 0 ? `${event.type} (${fields.join(', ')})` : event.type;
    }
  }
}

function timelineLines(events: TimelineEvent[]): string[] {
  if (events.length === 0) return ['Timeline: no events yet.'];
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recent = sorted.slice(-MAX_TIMELINE_EVENTS);
  const header =
    recent.length < sorted.length
      ? `Recent timeline (last ${recent.length} of ${sorted.length}, oldest first):`
      : 'Timeline (oldest first):';
  return [
    header,
    ...recent.map((e) => `- ${shortTime(e.createdAt)} ${e.actor.handle ?? e.actor.kind}: ${eventText(e)}`),
  ];
}

export function formatTaskDetail(detail: TaskDetail): string {
  const { task, timeline, sessions } = detail;
  const description = task.description.trim();
  const lines = [
    `${task.key} — ${task.title}`,
    taskStatusLine(task),
    `Repo: ${task.repo ?? 'workspace root'} · Visibility: ${task.visibility} · Priority: ${task.priority ?? 'none'}` +
      (task.labels.length > 0 ? ` · Labels: ${task.labels.join(', ')}` : ''),
    `Links: ${task.links.length > 0 ? task.links.map(describeLink).join('; ') : 'none'}`,
    `Created by ${task.createdBy} at ${shortTime(task.createdAt)} · Updated ${shortTime(task.updatedAt)}`,
    '',
    'Description:',
    description ? truncate(description, MAX_DESCRIPTION_CHARS) : '(none)',
  ];
  if (sessions.length > 0) {
    lines.push('', `Sessions: ${sessions.map((s) => `${s.member} (${s.state})`).join(', ')}`);
  }
  lines.push('', ...timelineLines(timeline));
  return lines.join('\n');
}

export function formatTaskUpdate(
  task: Task,
  change: { stageId?: string; check?: { name: string; state: string }; note: boolean },
): string {
  const done: string[] = [];
  if (change.check) done.push(`check ${change.check.name} → ${change.check.state}`);
  if (change.note) done.push('note added');
  if (change.stageId) done.push(`moved to ${change.stageId}`);
  return `Updated ${task.key}: ${done.join('; ')}.\nNow: ${taskStatusLine(task)}`;
}

export function formatLinkedPullRequest(task: Task, repo: string, number: number): string {
  const prs = task.links.filter((l) => l.kind === 'pull_request').map(describeLink);
  const all = prs.length > 0 ? `\nPull requests on ${task.key}: ${prs.join('; ')}` : '';
  return `Linked PR ${repo}#${number} to ${task.key}.${all}`;
}

/* ---------- messages and questions ---------- */

export function formatSentMessage(result: {
  messageId: string;
  requested: string[];
  deliveredTo: string[];
  taskKey: string | null;
}): string {
  const about = result.taskKey ? ` about ${result.taskKey}` : '';
  const missing = result.requested.filter((h) => !result.deliveredTo.includes(h));
  const sent =
    result.deliveredTo.length > 0
      ? `Message ${result.messageId}${about} sent to ${result.deliveredTo.join(', ')}.`
      : `Message ${result.messageId}${about} was not delivered to anyone.`;
  return missing.length > 0 ? `${sent} Not delivered to: ${missing.join(', ')}.` : sent;
}

export function formatQuestionAsked(inboxItemId: string, to: string[] | undefined): string {
  const whose = to && to.length > 0 ? ` of ${to.join(', ')}` : '';
  return (
    `Question ${inboxItemId} is waiting in the inbox${whose}. ` +
    'The answer will arrive later in this session as a team message. Do not wait or poll for it: ' +
    'continue with work that does not depend on the answer, or end your turn.'
  );
}
