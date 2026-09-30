import type { MemberView, Task, TaskDetail, TimelineEvent } from '@projectman/shared';
import { describeLink, formatTimestamp, linkTarget, oneLine, recentTimeline, truncate } from '../agent-text';

/**
 * Tool results are short plain text: cheap for the model to read and easy to scan in
 * transcripts. Free text written by people and agents (titles, notes, messages) is data
 * and is passed through, shortened where it could flood the context. Links and timeline
 * events are worded by src/agent-text, like in the kick-off brief, with plain ids.
 */

const MAX_DESCRIPTION_CHARS = 6000;
const MAX_TIMELINE_EVENTS = 20;
const MAX_EVENT_TEXT_CHARS = 300;

/* ---------- members ---------- */

export function formatMembers(members: MemberView[], self: string): string {
  if (members.length === 0) return 'The team has no members.';
  const lines = members.map((m) => {
    const who = m.handle === self ? `${m.handle} (you)` : m.handle;
    const kind = m.kind === 'ai' ? 'AI' : 'human';
    // Humans: access level, then the roles they hold; AI members: their one role.
    const held = m.kind === 'human' && m.roles.length > 0 ? `; roles: ${m.roles.join(', ')}` : '';
    const role = `${kind} ${m.role}${m.specialty ? ` (${m.specialty})` : ''}${m.temp ? ', temporary' : ''}${held}`;
    const status = m.activity ? `${m.status}: ${oneLine(m.activity, 80)}` : m.status;
    const tasks = m.currentTaskKeys.length > 0 ? ` · tasks: ${m.currentTaskKeys.join(', ')}` : '';
    return `- ${who} — ${m.displayName} · ${role} · ${status}${tasks}`;
  });
  return [`Team (${members.length} members, address them by handle):`, ...lines].join('\n');
}

/* ---------- tasks ---------- */

/** One line with where the task stands. */
export function taskStatusLine(task: Task): string {
  return [
    `Stage: ${task.stageId}`,
    `Status: ${task.status}`,
    `Assignee: ${task.assignee ?? 'none'}`,
    `Labels: ${task.labels.length > 0 ? task.labels.join(', ') : 'none'}`,
  ].join(' · ');
}

function timelineLines(events: TimelineEvent[]): string[] {
  const { lines, total } = recentTimeline(events, {
    limit: MAX_TIMELINE_EVENTS,
    textLimit: MAX_EVENT_TEXT_CHARS,
  });
  if (total === 0) return ['Timeline: no events yet.'];
  const header =
    lines.length < total
      ? `Recent timeline (last ${lines.length} of ${total}, oldest first):`
      : 'Timeline (oldest first):';
  return [header, ...lines];
}

export function formatTaskDetail(detail: TaskDetail): string {
  const { task, timeline, sessions } = detail;
  const description = task.description.trim();
  const lines = [
    `${task.key} — ${task.title}`,
    taskStatusLine(task),
    `Repo: ${task.repo ?? 'workspace root'} · Visibility: ${task.visibility} · Priority: ${task.priority ?? 'none'}` +
      (task.labels.length > 0 ? ` · Labels: ${task.labels.join(', ')}` : ''),
    `Links: ${task.links.length > 0 ? task.links.map((l) => describeLink(l)).join('; ') : 'none'}`,
    `Created by ${task.createdBy} at ${formatTimestamp(task.createdAt)} · Updated ${formatTimestamp(task.updatedAt)}`,
    '',
    'Description:',
    description ? truncate(description, MAX_DESCRIPTION_CHARS) : '(none)',
  ];
  if (detail.parent)
    lines.push(
      '',
      `Parent: ${detail.parent.key} — ${detail.parent.title} · Stage: ${detail.parent.stageId} · Status: ${detail.parent.status}`,
    );
  if (detail.subtasks?.length)
    lines.push(
      '',
      'Subtasks:',
      ...detail.subtasks.map(
        (child) => `- ${child.key} — ${child.title} · Stage: ${child.stageId} · Status: ${child.status}`,
      ),
    );
  if (sessions.length > 0) {
    lines.push('', `Sessions: ${sessions.map((s) => `${s.member} (${s.state})`).join(', ')}`);
  }
  lines.push('', ...timelineLines(timeline));
  return lines.join('\n');
}

export function formatTaskUpdate(
  task: Task,
  change: {
    stageId?: string;
    labels?: { added: string[]; removed: string[] };
    note: boolean;
    title?: boolean;
    description?: boolean;
  },
): string {
  const done: string[] = [];
  if (change.title) done.push('title changed');
  if (change.description) done.push('description replaced');
  if (change.labels?.added.length) done.push(`labels added: ${change.labels.added.join(', ')}`);
  if (change.labels?.removed.length) done.push(`labels removed: ${change.labels.removed.join(', ')}`);
  if (change.note) done.push('note added');
  if (change.stageId) done.push(`moved to ${change.stageId}`);
  return `Updated ${task.key}: ${done.join('; ')}.\nNow: ${taskStatusLine(task)}`;
}

export function formatTaskCreated(task: Task): string {
  const labels = task.labels.length > 0 ? ` · Labels: ${task.labels.join(', ')}` : '';
  return (
    `Created ${task.key} "${oneLine(task.title, 200)}" in stage ${task.stageId}, unassigned ` +
    `(visibility ${task.visibility}${labels}). Humans prioritise it. If it came from another task, ` +
    `note ${task.key} there with update_task.`
  );
}

export function formatLinkedPullRequest(task: Task, repo: string, number: number): string {
  const prs = task.links.filter((l) => l.kind === 'pull_request').map((l) => linkTarget(l));
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
