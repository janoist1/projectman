import type { ContextPackInput } from '../contracts';
import { code, languageName, stageLabel } from './format';
import type { Situation } from './work-item';

/**
 * The first message of a resumed task session that no other message caused: it was restarted,
 * which task and stage it is in now, and to check where it left off before it carries on. The
 * brief is already in the conversation and the system prompt was rebuilt for the current stage,
 * so it stays short (three sentences). Null for work items that are not a task.
 */
export function buildContinueMessage(input: ContextPackInput, situation: Situation): string | null {
  const task = input.workItem.type === 'task' ? input.task : null;
  if (!task) return null;
  const stage = situation.current ? stageLabel(situation.current) : code(task.stageId);
  const language = input.project.project.language;
  return [
    'Your session was restarted.',
    `You are working on ${task.key} "${task.title}", now in stage ${stage}.`,
    `Check where you left off (git status in your working directory, and the task's comments in get_task), then carry on as usual, writing in ${languageName(language)} (${code(language)}), the project's language.`,
  ].join(' ');
}
