import { stageOwners } from '../config/duties';
import { complexityLimitOf } from '../config/complexity';
import type { AiMemberConfig, HumanMemberConfig, ProjectConfig } from '../config/schema';
import type { ComplexityPoints } from './complexity';
import type { Stage } from './pipeline';
import type { Task } from './task';

/** An AI owner of the work stage and the largest card it takes (its complexity limit). */
export interface StageDeveloper {
  handle: string;
  limit: ComplexityPoints;
  specialtyLabels?: readonly string[];
}

/** A free AI owner of the work stage, as the automatic choice sees it (PM-348, PM-1001). */
export interface FreeDeveloper {
  handle: string;
  limit: ComplexityPoints;
  specialtyLabels?: readonly string[];
  temp: boolean;
  /** What the member works on now. */
  load: number;
  /** The member's place in the team list: the tie-break. */
  index: number;
}

/**
 * The outcome of the automatic choice: a member; `senior_busy` a scored card that waits for one of
 * the developers whose limit reaches its points (all busy, `seniors`); `none` nobody is free (a temp
 * worker may be hired when `tempAllowed`).
 */
export type DeveloperChoice =
  | { kind: 'member'; handle: string }
  | { kind: 'senior_busy'; seniors: string[] }
  | { kind: 'none'; tempAllowed: boolean };

/** The points of the card; `null` when nobody scored it yet. */
export function complexityOf(task: Pick<Task, 'complexity'>): ComplexityPoints | null {
  return task.complexity?.points ?? null;
}

/** The non-temp AI owners of the stage, on leave included; the limit is {@link complexityLimitOf}. */
export function stageDevelopers(config: Pick<ProjectConfig, 'team'>, stage: Stage): StageDeveloper[] {
  const owners = new Set(stageOwners(config, stage));
  return config.team.members
    .filter((m): m is AiMemberConfig => m.kind === 'ai' && owners.has(m.handle) && !m.temp)
    .map((m) => ({
      handle: m.handle,
      limit: complexityLimitOf(config, m),
      specialtyLabels: m.specialtyLabels,
    }));
}

/** The first eligible human in team order, used when no AI developer can be chosen. */
export function humanStageOwner(
  config: Pick<ProjectConfig, 'team'>,
  eligible: readonly string[],
): HumanMemberConfig | null {
  return (
    config.team.members.find(
      (member): member is HumanMemberConfig => member.kind === 'human' && eligible.includes(member.handle),
    ) ?? null
  );
}

/** Whether automatic assignment may give a card with these labels to the developer (PM-1038). */
export function fitsSpecialty(
  developer: Pick<StageDeveloper, 'specialtyLabels'>,
  labels: readonly string[],
): boolean {
  return (
    !developer.specialtyLabels?.length || developer.specialtyLabels.some((label) => labels.includes(label))
  );
}

/**
 * Whether the AI assignee of a card that is not under way may be replaced by the automatic choice
 * (PM-1051): its provider is on hold (quota cooldown or plan usage pause) and nothing of the work has
 * begun. Work that began (any session of the assignee on the card, a source trace), an open handoff and
 * the fix round limit's hold keep the card with its assignee.
 */
export function canReplaceUnstartedAssignee(input: {
  providerBlocked: boolean;
  hasWorkSession: boolean;
  handoffOpen: boolean;
  fixLimitHeld: boolean;
}): boolean {
  return input.providerBlocked && !input.hasWorkSession && !input.handoffOpen && !input.fixLimitHeld;
}

/**
 * Whether the developer fits the card: its limit reaches the points (an unscored card fits anyone) and its
 * specialty matches the labels. The one rule behind the automatic choice and the check of a named assignee.
 */
export function fitsCard(
  developer: Pick<StageDeveloper, 'limit' | 'specialtyLabels'>,
  points: ComplexityPoints | null,
  labels: readonly string[],
): boolean {
  return fitsSpecialty(developer, labels) && (points === null || developer.limit >= points);
}

/** The matching developers whose limit reaches the points; none for an unscored card. */
export function reachingDevelopers(
  developers: readonly StageDeveloper[],
  points: ComplexityPoints | null,
  labels: readonly string[],
): string[] {
  if (points === null) return [];
  return developers.filter((d) => fitsCard(d, points, labels)).map((d) => d.handle);
}

export type AssigneeFitRefusal = {
  reason: 'over_complexity_limit' | 'specialty_mismatch';
  points: ComplexityPoints;
  limit: ComplexityPoints;
};

/**
 * Why the AI member named for a card does not fit it, or null when it does (or the rule does not apply).
 * The automatic choice's own condition (`fitsCard`) is the test. Null when: the card is unscored (the points
 * are a tool, not a must, decision 62); the owners released it to any developer (`anyDecided`); no developer
 * of the work stage reaches the points (the automatic rule would give it to anyone too); the member is not
 * among `developers` (a person, or an AI member that is no developer): it is never refused. `developers` is
 * `stageDevelopers`, plus the named member when it is a temp worker (its limit is the temp maximum).
 */
export function assigneeFitRefusal(input: {
  member: string;
  points: ComplexityPoints | null;
  labels: readonly string[];
  developers: readonly StageDeveloper[];
  anyDecided: boolean;
}): AssigneeFitRefusal | null {
  const { points, labels, developers } = input;
  if (points === null || input.anyDecided) return null;
  const developer = developers.find((d) => d.handle === input.member);
  if (!developer || reachingDevelopers(developers, points, labels).length === 0) return null;
  if (fitsCard(developer, points, labels)) return null;
  return {
    reason: fitsSpecialty(developer, labels) ? 'over_complexity_limit' : 'specialty_mismatch',
    points,
    limit: developer.limit,
  };
}

const byLoad = (a: FreeDeveloper, b: FreeDeveloper) => a.load - b.load || a.index - b.index;

/**
 * The automatic choice of the developer among the free AI owners of the work stage (PM-1001).
 * 1. A free developer whose limit reaches the points (anyone for an unscored card): the smallest
 *    limit first, then the least loaded, then the team order, so the stronger ones stay for the
 *    heavier cards.
 * 2. An unscored card with nobody free: `none`, a temp worker may be hired.
 * 3. A scored card that a person released (`anyDecided`) or that nobody's limit reaches: the free
 *    non-temp developer with the largest limit; none: `none`.
 * 4. Otherwise the card waits for `reaching` (`senior_busy`), unless nobody is free at all and a
 *    temp worker could take it.
 */
export function chooseDeveloper(input: {
  points: ComplexityPoints | null;
  labels: readonly string[];
  /** The owners chose that any free developer may take the card. */
  anyDecided: boolean;
  /** The developers whose limit reaches the points, free or not. */
  reaching: string[];
  free: FreeDeveloper[];
  /** The largest card a temp worker takes (`tempMaxPointsOf`): a card above it never goes to one. */
  tempMaxPoints: ComplexityPoints;
}): DeveloperChoice {
  const { points, anyDecided, reaching } = input;
  const free = input.free.filter((developer) => fitsSpecialty(developer, input.labels));
  const fitting = free
    .filter((d) => fitsCard(d, points, input.labels))
    .sort((a, b) => a.limit - b.limit || byLoad(a, b))[0];
  if (fitting) return { kind: 'member', handle: fitting.handle };
  if (points === null) return { kind: 'none', tempAllowed: true };
  const tempAllowed = points <= input.tempMaxPoints;
  if (anyDecided || reaching.length === 0) {
    const largest = free.filter((d) => !d.temp).sort((a, b) => b.limit - a.limit || byLoad(a, b))[0];
    return largest ? { kind: 'member', handle: largest.handle } : { kind: 'none', tempAllowed };
  }
  if (free.length === 0 && tempAllowed) return { kind: 'none', tempAllowed: true };
  return { kind: 'senior_busy', seniors: reaching };
}
