import { describeLink, linkTarget, recentTimeline } from '../agent-text';
import type { ContextPackInput } from '../contracts';
import { code, promptStyle, stageLabel } from './format';
import type { Situation } from './work-item';

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
 * labels, links, prerequisites and a compact recent timeline. What is expected next is in the
 * system prompt ("What done means for you here"), which follows the task to its current stage.
 * Labels are English; task data (title, description, notes) is shown as it was written.
 * Scheduled work uses its configured prompt; other non-task work has no brief.
 */
export function buildBrief(input: ContextPackInput, situation: Situation): string | null {
  if (input.workItem.type === 'schedule') return input.member.schedule?.prompt ?? null;
  const task = input.workItem.type === 'task' ? input.task : null;
  if (!task) return null;

  const style = promptStyle(input.project);
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
      `- Labels: ${task.labels.length > 0 ? task.labels.map((label) => style.label(label)).join(', ') : 'none'}`,
      `- Visibility: ${task.visibility}`,
    ].join('\n'),
  );

  sections.push(['## Description', description(task.description)].join('\n'));

  const links = task.links.filter((l) => l.kind !== 'prerequisite').map((l) => `- ${describeLink(l, style)}`);
  sections.push(['## Links', ...(links.length > 0 ? links : ['None.'])].join('\n'));

  const prerequisites = task.links
    .filter((l) => l.kind === 'prerequisite')
    .map((l) => `- ${linkTarget(l, style)}`);
  sections.push(['## Prerequisites', ...(prerequisites.length > 0 ? prerequisites : ['None.'])].join('\n'));

  const { lines, total } = recentTimeline(input.timeline, {
    limit: TIMELINE_LIMIT,
    textLimit: TEXT_LIMIT,
    style,
    skip: QUIET_EVENTS,
  });
  const omitted = total - lines.length;
  sections.push(
    [
      '## Recent timeline',
      ...(omitted > 0 ? [`(${omitted} earlier events omitted)`] : []),
      ...(lines.length > 0 ? lines : ['Nothing yet.']),
    ].join('\n'),
  );

  // The steps themselves are in the system prompt, which is rebuilt for the task's current stage
  // whenever the session starts or resumes; this brief is typed once.
  sections.push(
    ['## What is expected next', 'See "What done means for you here" in your instructions.'].join('\n'),
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
