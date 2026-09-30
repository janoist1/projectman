import type { TaskLink, TimelineEvent } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { code, codeList, formatTimestamp, labelRef, oneLine, stageLabel } from './format';
import { expectedSteps, type Situation } from './work-item';

/** Timeline entries shown in the brief (the most recent ones). */
const TIMELINE_LIMIT = 15;
/** Longer descriptions are cut; the agent reads the rest with get_task. */
const DESCRIPTION_LIMIT = 12_000;
/** Maximum length of free text (notes, messages, questions) in a timeline line. */
const TEXT_LIMIT = 280;
/** Events that say little about the task itself. */
const QUIET_EVENTS = new Set<string>([
  'session_started',
  'session_ended',
  'permission_requested',
  'permission_resolved',
]);

/**
 * The kick-off brief typed as the first message of a new task session: the task, its
 * labels, links, prerequisites, a compact recent timeline and what is expected next.
 * Labels are English; task data (title, description, notes) is shown as it was written.
 * Scheduled work uses its configured prompt; other non-task work has no brief.
 */
export function buildBrief(input: ContextPackInput, situation: Situation): string | null {
  if (input.workItem.type === 'schedule') return input.member.schedule?.prompt ?? null;
  const task = input.workItem.type === 'task' ? input.task : null;
  if (!task) return null;

  const sections: string[] = [];

  sections.push(
    [
      `# ${task.key}: ${task.title}`,
      situation.current
        ? `You are picking up this task at stage ${stageLabel(situation.current)}.`
        : `You are picking up this task (stage ${code(task.stageId)}).`,
      '',
      `- Status: ${task.status}`,
      `- Assignee: ${task.assignee ? code(task.assignee) : 'none'}`,
      `- Repo: ${task.repo ? code(task.repo) : 'the workspace root'}`,
      ...(task.priority !== null ? [`- Priority: ${task.priority}`] : []),
      `- Labels: ${
        task.labels.length > 0
          ? task.labels.map((label) => labelRef(label, input.project.pipeline.labels)).join(', ')
          : 'none'
      }`,
      `- Visibility: ${task.visibility}`,
    ].join('\n'),
  );

  sections.push(['## Description', description(task.description)].join('\n'));

  const links = task.links.filter((l) => l.kind !== 'prerequisite').map(linkLine);
  sections.push(['## Links', ...(links.length > 0 ? links : ['None.'])].join('\n'));

  const prerequisites = task.links.filter((l) => l.kind === 'prerequisite').map(linkLine);
  sections.push(['## Prerequisites', ...(prerequisites.length > 0 ? prerequisites : ['None.'])].join('\n'));

  sections.push(['## Recent timeline', ...timeline(input)].join('\n'));

  sections.push(
    [
      '## What is expected next',
      ...expectedSteps(input, situation).map((step, i) => `${i + 1}. ${step}`),
      '',
      'Use get_task for the latest state at any time.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

function description(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'No description.';
  const chars = Array.from(trimmed);
  if (chars.length <= DESCRIPTION_LIMIT) return trimmed;
  return `${chars.slice(0, DESCRIPTION_LIMIT).join('')}\n\n(The description continues; read it with get_task.)`;
}

function linkLine(link: TaskLink): string {
  const title = link.title ? ` "${oneLine(link.title, 200)}"` : '';
  const state = link.state ? ` (${link.state})` : '';
  const numbered = /^\d+$/.test(link.ref) ? `${link.repo ?? ''}#${link.ref}` : link.ref;
  switch (link.kind) {
    case 'pull_request':
      return `- Pull request: ${numbered}${title}${state}`;
    case 'issue':
      return `- Issue: ${numbered}${title}${state}`;
    case 'branch':
      return `- Branch: ${code(link.ref)}${link.repo ? ` in ${link.repo}` : ''}${state}`;
    case 'url':
      return `- Link: ${link.ref}${title}`;
    case 'prerequisite':
      return `- ${link.ref}${title}${state}`;
  }
}

function timeline(input: ContextPackInput): string[] {
  const events = input.timeline.filter((e) => !QUIET_EVENTS.has(e.type));
  if (events.length === 0) return ['Nothing yet.'];
  const shown = events.slice(-TIMELINE_LIMIT);
  const stageNames = new Map(input.project.pipeline.stages.map((s) => [s.id, s.name]));
  const lines = shown.map((e) => {
    const actor = e.actor.handle ? code(e.actor.handle) : e.actor.kind;
    return `- ${formatTimestamp(e.createdAt)} · ${actor}: ${describeEvent(e, stageNames)}`;
  });
  const omitted = events.length - shown.length;
  return omitted > 0 ? [`(${omitted} earlier events omitted)`, ...lines] : lines;
}

function describeEvent(event: TimelineEvent, stageNames: Map<string, string>): string {
  const data = event.data;
  const text = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.trim() ? oneLine(value, TEXT_LIMIT) : null;
  };
  const list = (key: string): string[] => {
    const value = data[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  };
  const stage = (key: string): string => {
    const id = text(key);
    return id ? (stageNames.get(id) ?? id) : '?';
  };

  switch (event.type) {
    case 'task_created':
      return text('title') ? `created the task "${text('title')}"` : 'created the task';
    case 'task_updated':
      return list('fields').length > 0 ? `updated ${list('fields').join(', ')}` : 'updated the task';
    case 'task_stage_changed':
      return `moved it from ${stage('from')} to ${stage('to')}`;
    case 'task_assigned':
      return text('assignee') ? `assigned it to ${code(text('assignee') ?? '')}` : 'unassigned it';
    case 'task_check_changed':
      return `set the ${text('check') ?? '?'} check to ${text('to') ?? '?'}${text('from') ? ` (was ${text('from')})` : ''}`;
    case 'task_link_added': {
      const ref = text('ref') ?? '';
      const repo = text('repo');
      const target = repo && /^\d+$/.test(ref) ? `${repo}#${ref}` : ref;
      return `linked ${(text('kind') ?? 'link').replace(/_/g, ' ')} ${target}`.trimEnd();
    }
    case 'task_note':
      return `note: ${text('text') ?? ''}`.trimEnd();
    case 'team_message': {
      const to = list('to');
      return `message${to.length > 0 ? ` to ${codeList(to)}` : ''}: ${text('excerpt') ?? ''}`.trimEnd();
    }
    case 'question_asked':
      return `asked a human: ${text('question') ?? ''}`.trimEnd();
    case 'question_answered':
      return `answered: ${text('answer') ?? ''}`.trimEnd();
    case 'member_hired':
      return `hired ${text('handle') ? code(text('handle') ?? '') : 'a member'}`;
    case 'member_retired':
      return `retired ${text('handle') ? code(text('handle') ?? '') : 'a member'}`;
    case 'config_changed':
      return `changed the configuration${text('message') ? `: ${text('message')}` : ''}`;
    default:
      return event.type.replace(/_/g, ' ');
  }
}
