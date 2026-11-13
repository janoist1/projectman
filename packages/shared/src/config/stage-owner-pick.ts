import type { Stage } from '../domain/pipeline';
import type { ChangedFiles, StageOwnerPick } from '../domain/stage-owner-pick';
import type { Task } from '../domain/task';
import { stageOwners, taskAuthors } from './duties';
import { isHandleOnLeave } from './leave';
import { matchesPathPattern } from './path-pattern';
import type { ProjectConfig } from './schema';

type PickConfig = Pick<ProjectConfig, 'team'>;
/** What the pick needs of a card; the fields are optional so a caller with a partial card compiles (no links, no points: the main owners). */
export type PickTask = Pick<Task, 'assignee'> &
  Partial<Pick<Task, 'links' | 'complexity' | 'stageOwnerPick'>>;

/** How many matching files a `central_files` reason names. */
const NAMED_FILES = 3;

/** The small-card owners that could take the card: not its authors, and not on leave. */
function availableSmallOwners(config: PickConfig, rule: NonNullable<Stage['smallCards']>, task: PickTask) {
  const authors = taskAuthors(task);
  const others = rule.owners.filter((handle) => !authors.includes(handle));
  return { others, free: others.filter((handle) => !isHandleOnLeave(config, handle)) };
}

/**
 * Whether the rule needs the branch's changed files to decide for this card: the stage has central
 * paths, the card is within the point limit and a small owner could take it. The server reads files only then.
 */
export function needsChangedFiles(config: PickConfig, stage: Stage, task: PickTask): boolean {
  const rule = stage.smallCards;
  const points = task.complexity?.points;
  if (!rule || rule.centralPaths.length === 0 || points === undefined || points > rule.maxPoints)
    return false;
  return availableSmallOwners(config, rule, task).free.length > 0;
}

/**
 * Whom the step stage gives the card to, decided on entry; null when the stage has no small-card rule.
 * The first match decides: no points, over the limit, the small owners are the card's authors, the small
 * owners are on leave, no branch to read, files unreadable, a central file changed, else small. Any reason
 * but `small` leaves the card to the stage's main owners.
 */
export function pickStageOwners(
  config: PickConfig,
  stage: Stage,
  task: PickTask,
  changed?: ChangedFiles,
): StageOwnerPick | null {
  const rule = stage.smallCards;
  if (!rule) return null;
  const main = (reason: StageOwnerPick['reason']): StageOwnerPick => ({
    stageId: stage.id,
    small: false,
    reason,
  });
  const points = task.complexity?.points;
  if (points === undefined) return main({ code: 'no_points' });
  if (points > rule.maxPoints) return main({ code: 'over_limit', points, maxPoints: rule.maxPoints });
  const { others, free } = availableSmallOwners(config, rule, task);
  if (others.length === 0) return main({ code: 'small_owner_is_author' });
  if (free.length === 0) return main({ code: 'small_owners_on_leave' });
  const small: StageOwnerPick = { stageId: stage.id, small: true, reason: { code: 'small', points } };
  if (rule.centralPaths.length === 0) return small;
  if (changed === undefined) return main({ code: 'no_branch' });
  const reason = centralFilesReason(rule, changed);
  return reason ? main(reason) : small;
}

/** A review round only escalates for central or unreadable files; it does not repeat entry eligibility. */
export function repinStageOwners(stage: Stage, changed: ChangedFiles): StageOwnerPick | null {
  if (!stage.smallCards) return null;
  const reason = centralFilesReason(stage.smallCards, changed);
  return reason ? { stageId: stage.id, small: false, reason } : null;
}

function centralFilesReason(
  rule: NonNullable<Stage['smallCards']>,
  changed: ChangedFiles,
): StageOwnerPick['reason'] | null {
  if (changed === null) return { code: 'unreadable' };
  const central = changed.paths.filter((path) => rule.centralPaths.some((p) => matchesPathPattern(p, path)));
  if (central.length > 0)
    return { code: 'central_files', files: central.slice(0, NAMED_FILES), count: central.length };
  return changed.truncated ? { code: 'unreadable' } : null;
}

/**
 * The owners of the stage for this card: the small-card owners (without the card's authors) when the stage
 * gave it to them on entry and still has the rule; else the stage's own owners. Resolved on use, never stored.
 */
export function cardStageOwners(config: PickConfig, stage: Stage, task: PickTask): string[] {
  const pick = task.stageOwnerPick;
  if (pick?.stageId === stage.id && pick.small && stage.smallCards) {
    const authors = taskAuthors(task);
    const owners = stage.smallCards.owners.filter((handle) => !authors.includes(handle));
    if (owners.length > 0) return owners;
  }
  return stageOwners(config, stage);
}

/** Everyone who can own the stage, whatever the card: the stage's own owners and its small-card owners. */
export function allStageOwners(config: PickConfig, stage: Stage): string[] {
  return [...new Set([...stageOwners(config, stage), ...(stage.smallCards?.owners ?? [])])];
}

/**
 * Who may own the stage for a card that is not in it yet: the stage's owners, plus the small-card owners
 * (without the card's authors) unless the card's points already rule the small owners out.
 */
export function possibleStageOwners(config: PickConfig, stage: Stage, task: PickTask): string[] {
  const rule = stage.smallCards;
  const points = task.complexity?.points;
  const main = stageOwners(config, stage);
  if (!rule || points === undefined || points > rule.maxPoints) return main;
  const authors = taskAuthors(task);
  return [...new Set([...main, ...rule.owners.filter((handle) => !authors.includes(handle))])];
}
