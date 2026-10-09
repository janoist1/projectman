import { BUILT_IN_ROLE_DUTIES, customRoleDuties, isBuiltInRole } from '../domain/role';
import { DUTIES } from '../domain/duty';
import type { DutyId } from '../domain/duty';
import type { Stage } from '../domain/pipeline';
import type { Session, SessionState } from '../domain/session';
import { isOpenTask } from '../domain/task';
import type { Task } from '../domain/task';
import { isOnLeave } from './leave';
import { memberRoles, stageOf } from './lookup';
import type { MemberConfig, ProjectConfig } from './schema';

export function roleBundle(config: Pick<ProjectConfig, 'team'>, role: string) {
  if (isBuiltInRole(role))
    return config.team.roleOverrides?.[role] ?? { duties: BUILT_IN_ROLE_DUTIES[role], instructions: '' };
  const custom = config.team.roles.find((r) => r.id === role);
  return { duties: custom ? customRoleDuties(custom) : [], instructions: custom?.instructions ?? '' };
}
/**
 * Whether a role changes files: one of its duties has the `task_worktree` tool policy, so its task
 * sessions work in the task's own git worktree (custom roles and project overrides included).
 */
export function roleUsesWorktree(config: Pick<ProjectConfig, 'team'>, role: string): boolean {
  return roleBundle(config, role).duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree');
}
export function memberDuties(config: Pick<ProjectConfig, 'team'>, member: MemberConfig): DutyId[] {
  return [...new Set(memberRoles(member).flatMap((role) => roleBundle(config, role).duties))];
}
export function dutyMembers(config: Pick<ProjectConfig, 'team'>, duty: DutyId): MemberConfig[] {
  return config.team.members.filter((m) => memberDuties(config, m).includes(duty));
}
/** The label the analyst sets when the requirement of a card is ready (the refinement gate `analysis-ok`). */
export const ANALYSIS_LABEL = 'analysis-ok';
/**
 * The analyst of a card (PM-421): the AI member who set the analysis label on it, unless they are on
 * leave; else the first member with the requirements analysis duty, in the team's order; else null. A
 * person who set the label does not count: they have no session to ask.
 */
export function cardAnalyst(config: Pick<ProjectConfig, 'team'>, labelSetter: string | null): string | null {
  const setter = labelSetter ? config.team.members.find((m) => m.handle === labelSetter) : undefined;
  if (setter?.kind === 'ai' && !isOnLeave(setter)) return setter.handle;
  const responsible = dutyMembers(config, 'requirements_analysis').find(
    (m) => m.kind === 'ai' && !isOnLeave(m),
  );
  return responsible?.handle ?? null;
}
export function stageOwners(config: Pick<ProjectConfig, 'team'>, stage: Stage): string[] {
  return stage.owners ?? (stage.duty ? dutyMembers(config, stage.duty).map((m) => m.handle) : []);
}
/** The duty a stage stands for: its own, or `implementation` for a work stage that names none. */
export function stageDuty(stage: Stage): DutyId | undefined {
  return stage.duty ?? (stage.kind === 'work' ? 'implementation' : undefined);
}
/**
 * The stages with a fixed owner list (`owners`) that the member's roles carry the duty of and that
 * do not list the member yet (PM-133): a newly hired developer joins the work stage's owners, so a
 * hand-over or a Start without an assignee can choose them. Queue and done stages are never joined.
 */
export function stagesToJoin(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  member: MemberConfig,
): Stage[] {
  const duties = memberDuties(config, member);
  return config.pipeline.stages.filter((stage) => {
    if (!stage.owners || stage.kind === 'queue' || stage.kind === 'done') return false;
    const duty = stageDuty(stage);
    return !!duty && duties.includes(duty) && !stage.owners.includes(member.handle);
  });
}
/**
 * Whether the stage is a code review step (PM-222): a step stage that carries the code review duty,
 * by the stage's own duty or, when it names none, by one of its owners.
 */
export function isCodeReviewStage(config: Pick<ProjectConfig, 'team'>, stage: Stage): boolean {
  if (stage.kind !== 'step') return false;
  if (stage.duty) return stage.duty === 'code_review';
  const owners = new Set(stageOwners(config, stage));
  return config.team.members.some(
    (m) => owners.has(m.handle) && memberDuties(config, m).includes('code_review'),
  );
}
/** The duties whose sessions review or test a handed-over commit (they get a review copy, PM-138). */
export const REVIEW_DUTIES: readonly DutyId[] = ['code_review', 'security_review', 'testing_acceptance'];
/**
 * Whether entering the stage hands the task's committed work over for review or testing (PM-183):
 * a step or release stage that a reviewing or testing duty belongs to, by the stage's own duty or by
 * one of its owners. The same set that places a session in a review copy.
 */
export function stageHandsOverForReview(config: Pick<ProjectConfig, 'team'>, stage: Stage): boolean {
  if (stage.kind !== 'step' && stage.kind !== 'release') return false;
  if (stage.duty && REVIEW_DUTIES.includes(stage.duty)) return true;
  const owners = new Set(stageOwners(config, stage));
  return config.team.members.some(
    (m) => owners.has(m.handle) && memberDuties(config, m).some((duty) => REVIEW_DUTIES.includes(duty)),
  );
}
/** The duties whose members review a card wherever it is (PM-426): an AI member's message may start them on any card. */
export const CARD_REVIEWER_DUTIES: readonly DutyId[] = [...REVIEW_DUTIES, 'ux_design'];
/**
 * Whether `handle` has a role on the card (PM-426), so that an AI member's action message may start them
 * there: its assignee; a member with a duty of CARD_REVIEWER_DUTIES, in any stage of the card; an owner of
 * its current stage when that is a `step` stage (a work stage's owners do not count); or a member who
 * worked on it (`workedOn`, a server fact: has or had a session on the card, or on its parent when it is a
 * subtask).
 */
export function hasCardRole(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  task: Pick<Task, 'assignee' | 'stageId'>,
  handle: string,
  workedOn: boolean,
): boolean {
  if (workedOn || task.assignee === handle) return true;
  const member = config.team.members.find((m) => m.handle === handle);
  if (member && memberDuties(config, member).some((duty) => CARD_REVIEWER_DUTIES.includes(duty))) return true;
  const stage = stageOf(config, task.stageId);
  return stage?.kind === 'step' && stageOwners(config, stage).includes(handle);
}
/**
 * Session states of a member that is doing something now: a turn runs, or it waits for an answer.
 * The server's `BUSY_SESSION_STATES` (the concurrency limit) leaves out `waiting_input`: a session
 * waiting for a person's answer does no work, but its member still holds the task.
 */
const ENGAGED_SESSION_STATES: SessionState[] = ['starting', 'working', 'waiting_permission', 'waiting_input'];
/**
 * Whether a member's live session on an open task is work it does now (what counts against its
 * capacity): a turn is running or waiting for an answer, or the task sits in a stage the member
 * works in (the assignee of a work stage, an owner of a step or release stage). A session idling after the
 * member handed the task on does not count.
 */
export function isWorkingOnTask(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  task: Pick<Task, 'stageId' | 'assignee'>,
  handle: string,
  sessionState: SessionState,
): boolean {
  const stage = stageOf(config, task.stageId);
  return isWorkingInStage(
    stage && { kind: stage.kind, owners: stageOwners(config, stage) },
    task,
    handle,
    sessionState,
  );
}
/**
 * Whether the member has a step on the card (PM-288): it is the member whose turn it is in the
 * refinement (`turnMember`, `RefinementSteps.turnMember`), or the member works in the stage the card
 * sits in. A card in refinement is worked one step at a time, one member per step: while it has a turn
 * member, the other owners of its stage have no step on it. A member with no step on an open card is
 * done with it.
 */
export function hasStepOnTask(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  task: Pick<Task, 'status' | 'stageId' | 'assignee'>,
  handle: string,
  turnMember: string | null,
): boolean {
  if (!isOpenTask(task)) return false;
  return turnMember !== null ? turnMember === handle : isWorkingOnTask(config, task, handle, 'idle');
}
/**
 * Whether a session works now (PM-288): it is in an engaged state, or it is idle and one of the
 * signals holds: it awaits its first turn, it has typed input that has not started, or a message
 * is on its way to it. Such a session is not closed.
 */
export function isSessionAtWork(
  session: Pick<Session, 'state'>,
  signals: { awaitsFirstTurn: boolean; pendingInput: boolean; messageOnItsWay: boolean },
): boolean {
  if (ENGAGED_SESSION_STATES.includes(session.state)) return true;
  return (
    session.state === 'idle' && (signals.awaitsFirstTurn || signals.pendingInput || signals.messageOnItsWay)
  );
}
/** A stage with its owners resolved (`resolvedStages`; the board's `stages` carry them). */
export type StageWithOwners = Pick<Stage, 'kind'> & { owners: readonly string[] };
/** `isWorkingOnTask` against a stage whose owners are resolved (the web has no ProjectConfig). */
export function isWorkingInStage(
  stage: StageWithOwners | undefined,
  task: Pick<Task, 'assignee'>,
  handle: string,
  sessionState: SessionState,
): boolean {
  if (ENGAGED_SESSION_STATES.includes(sessionState)) return true;
  if (!stage) return false;
  if (stage.kind === 'work') return task.assignee ? task.assignee === handle : stage.owners.includes(handle);
  return stage.kind !== 'queue' && stage.kind !== 'done' && stage.owners.includes(handle);
}
/** Session states of a live session: a process that runs (or starts) for its work item. */
const LIVE_SESSION_STATES: SessionState[] = [
  'starting',
  'idle',
  'working',
  'waiting_permission',
  'waiting_input',
];
/**
 * The sessions that work on a card now (PM-249): live sessions whose work item is the card and whose
 * member works on it (`isWorkingInStage`). One per member. Order: the owners of a step stage, then the
 * assignee, then the others; within a group by `stateSince ?? lastActivityAt`, oldest first.
 */
export function cardWorkerSessions(
  stage: StageWithOwners | undefined,
  task: Pick<Task, 'key' | 'assignee'>,
  sessions: readonly Session[],
): Session[] {
  const since = (s: Session) => s.stateSince ?? s.lastActivityAt;
  const rank = (s: Session) =>
    stage?.kind === 'step' && stage.owners.includes(s.member) ? 0 : s.member === task.assignee ? 1 : 2;
  const working = sessions
    .filter(
      (s) =>
        s.workItem.type === 'task' &&
        s.workItem.taskKey === task.key &&
        LIVE_SESSION_STATES.includes(s.state) &&
        isWorkingInStage(stage, task, s.member, s.state),
    )
    .sort((a, b) => rank(a) - rank(b) || since(a).localeCompare(since(b)));
  const seen = new Set<string>();
  return working.filter((s) => !seen.has(s.member) && !!seen.add(s.member));
}
/** The task's assignee and the attributed authors of its pull requests. */
export function taskAuthors(task: Pick<Task, 'assignee' | 'links'>): string[] {
  return [
    ...new Set(
      [task.assignee, ...task.links.filter((l) => l.kind === 'pull_request').map((l) => l.author)].filter(
        (h): h is string => !!h,
      ),
    ),
  ];
}
/** Resolve at use time, never persist derived member lists into customization YAML. */
export function resolvedStages(config: ProjectConfig): (Stage & { owners: string[] })[] {
  return config.pipeline.stages.map((stage) => ({ ...stage, owners: stageOwners(config, stage) }));
}
