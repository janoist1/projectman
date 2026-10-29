import {
  assigneeFitApplies,
  assigneeFitRefusal,
  complexityLimitOf,
  complexityOf,
  stageDevelopers,
  stageOwners,
} from '@projectman/shared';
import type { Actor, ProjectConfig, Stage, Task } from '@projectman/shared';
import { conflict } from '../../kernel';

/**
 * Refuses (`assignee_unfit`) the AI member an AI actor names for a card when the member's complexity limit
 * or specialty does not fit it (PM-1136). Nothing happens when the project does not ask for it
 * (`assigneeFitApplies`), the actor is a person, the member is not an AI owner of the work stage, or the shared
 * rule (`assigneeFitRefusal`) finds no misfit. Called before anything is written.
 */
export function assertAssigneeFits(input: {
  config: ProjectConfig;
  actor: Actor;
  task: Pick<Task, 'complexity' | 'labels'>;
  workStage: Stage;
  member: string;
  /** The owners released the card to any developer (the "any" decision of the Senior wait). */
  anyDecided: boolean;
}): void {
  const { config, actor, task, workStage, member } = input;
  if (!assigneeFitApplies(config, actor)) return;
  const named = config.team.members.find((candidate) => candidate.handle === member);
  if (named?.kind !== 'ai' || !stageOwners(config, workStage).includes(member)) return;
  // `stageDevelopers` leaves the temp workers out: a named one is judged by the project's temp maximum.
  const developers = stageDevelopers(config, workStage);
  if (named.temp) developers.push({ handle: member, limit: complexityLimitOf(config, named) });
  const refusal = assigneeFitRefusal({
    member,
    points: complexityOf(task),
    labels: task.labels,
    developers,
    anyDecided: input.anyDecided,
  });
  if (!refusal) return;
  throw conflict(
    'assignee_unfit',
    `${member} does not fit this card (${refusal.reason}: ${refusal.points} points, limit ${refusal.limit})`,
    { member, ...refusal },
  );
}
