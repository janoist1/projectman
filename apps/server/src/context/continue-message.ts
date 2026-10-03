import type { PausePoint } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { code, languageName, relationText, stageLabel } from './format';
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
  const related = input.relatedSessions ?? [];
  const pin = task.reviewPin;
  const reviewed = input.lastReviewedCommit;
  return [
    'Your session was restarted.',
    `You are working on ${task.key} "${task.title}", now in stage ${stage}.`,
    `Check where you left off (git status in your working directory, and the task's comments and attachments in get_task), then carry on as usual, writing in ${languageName(language)} (${code(language)}), the project's language.`,
    // A returning reviewer reads only what changed since its last round (PM-213).
    ...(pin && reviewed
      ? [
          reviewed === pin.commit
            ? `You last reviewed commit ${code(reviewed)}, the one handed over now: the branch has not moved since, so check only that your earlier findings were fixed or answered.`
            : `You last reviewed commit ${code(reviewed)}; the commit handed over now is ${code(pin.commit)} on ${code(pin.branch)}. Review only the change since your last review (git diff ${reviewed} ${pin.commit}) and whether your earlier findings were fixed; do not read the whole change again.`,
        ]
      : []),
    ...(related.length > 0
      ? [
          `Your other running sessions: ${related.map((s) => `${s.taskKey} (${relationText(s.relation)})`).join(', ')}; the standing is on the cards, so read them before you give direction.`,
        ]
      : []),
  ].join(' ');
}

/** What a session was cut at (the tool it ran, if any), in a few words. */
function toolText(tool: string | null): string {
  return tool ? ` (${code(tool)})` : '';
}

/**
 * What a session is told when the team's pause ended (PM-219): the work was paused, where it was cut,
 * what that means for the step it was in, and that it goes on. Pauses that cut nothing mid-turn
 * (`idle`, `turn_end`) need no text; a session that was started again says what did not survive.
 */
export function buildPauseNudge(input: {
  point: PausePoint;
  tool: string | null;
  restarted: boolean;
}): string {
  const { point, tool, restarted } = input;
  const lines = [
    restarted
      ? 'The team was paused and your session was started again: your earlier conversation is intact, but your process is new.'
      : 'The team was paused and is resumed now.',
  ];
  switch (point) {
    case 'after_tool':
      lines.push(`The tool you ran${toolText(tool)} finished before the pause; carry on from its result.`);
      break;
    case 'before_tool':
      lines.push(
        `The tool call you were about to make${toolText(tool)} did not run; run it again if it is still needed.`,
      );
      break;
    case 'interrupted':
      lines.push(
        `The tool you ran${toolText(tool)} was interrupted by the pause. Check its effect (git status in your working directory) and run the tests again before you rely on it.`,
      );
      break;
    default:
      break;
  }
  if (restarted) {
    lines.push(
      'An approval request that was open is withdrawn: ask for it again if you still need it. Commands you left running in the background have stopped.',
    );
  }
  return lines.join(' ');
}
