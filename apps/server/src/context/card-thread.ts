import { cardQuestionLines, cardWorkerLines } from '../agent-text';
import type { ContextPackInput } from '../contracts';
import { promptStyle } from './format';
import { handoffBlock } from './handoff';

/**
 * The members working on the card besides the reader (PM-249): who, in what role and state, and the
 * sentence they gave; how to split the work. Null when nobody else does. Shared by the brief and by
 * the message a resumed session gets first.
 */
export function cardWorkersBlock(input: ContextPackInput): string | null {
  const workers = input.cardWorkers ?? [];
  if (workers.length === 0) return null;
  return [
    '## Also working on this card',
    ...cardWorkerLines(workers, promptStyle(input.project)),
    "Each of you works from your own conversation, and none sees another's. Split the work by send_message with the members it concerns, do not overwrite each other's part (the description above all), and send a message about coordinating to all of them.",
  ].join('\n');
}

/**
 * The questions asked on the card (PM-249), answered or open, oldest first. Null when there are none.
 */
export function cardQuestionsBlock(input: ContextPackInput): string | null {
  const questions = input.cardQuestions ?? [];
  const task = input.workItem.type === 'task' ? input.task : null;
  if (questions.length === 0 || !task) return null;
  return [
    '## Questions to people on this card',
    ...cardQuestionLines(questions, task.key, promptStyle(input.project)),
    'Before you ask a person, check here (and in get_task) that it was not answered and is not open already.',
  ].join('\n');
}

/**
 * What a resumed task session is told first about the card now (PM-249): `Now on PM-1:` and the
 * blocks of the brief (a handover to the member, PM-342, the other workers and the questions). The
 * previous conversation is only for a new conversation, so it is not here. Null when there is neither (then nothing is added to the message).
 */
export function buildStanding(input: ContextPackInput): string | null {
  const task = input.workItem.type === 'task' ? input.task : null;
  if (!task) return null;
  const blocks = [handoffBlock(input), cardWorkersBlock(input), cardQuestionsBlock(input)].filter(
    (b) => b !== null,
  );
  return blocks.length > 0 ? [`Now on ${task.key}:`, ...blocks].join('\n\n') : null;
}
