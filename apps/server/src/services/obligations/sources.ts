import {
  developmentStage,
  isOpenTask,
  memberOf,
  pullSourceStage,
  stageIndex,
  stageOf,
  stageOwners,
  stepResult,
} from '@projectman/shared';
import type {
  Obligation,
  ObligationKind,
  ProjectConfig,
  QuestionTodo,
  Task,
  TaskWait,
} from '@projectman/shared';
import type { Repositories } from '../../db';
import type {
  ObligationFixLimit,
  ObligationRefinement,
  ObligationSessions,
  ObligationStartOffers,
} from './ports';

/** What the sources read: the project's cards, their waits (without the tracking's own todos) and the live rows. */
export interface ProjectView {
  config: ProjectConfig;
  tasks: ReadonlyMap<string, Task>;
  waits: ReadonlyMap<string, TaskWait | null>;
  live: readonly Obligation[];
}

/** A step that is open now and has an AI responsible. */
export interface DerivedObligation {
  taskKey: string;
  responsible: string;
  subject: string;
  /** When the step began: the first deadline is `since` + N minutes. */
  since: string;
  /** The responsible, or the system, is working the step now: the deadline moves on (`planObligation` step 6). */
  active?: boolean;
  /** The card waits for a decision the source knows of (a fix round limit): the clock stands still as for a held card. */
  held?: boolean;
}

/**
 * One kind of obligation (PM-806): when a step is open, who has to do it, how it ends and what the
 * reminder and the integrator todo say. The sweep does the rest the same way for every kind.
 */
export interface ObligationSource {
  kind: ObligationKind;
  /** The source derives its steps whatever holds the card: a step it does not derive has ended, paused or not. */
  derivesWhilePaused?: boolean;
  /** The open steps of the project, or null when they cannot be read now (the rows then stay as they are). */
  derive(project: ProjectView): ReadonlyArray<DerivedObligation> | null;
  /** How a row that is not derived any more ended. */
  closedAs(row: Obligation, project: ProjectView): 'fulfilled' | 'cancelled';
  /** The one reminder to the responsible (English; `waited` minutes since the step began, `minutes` is N). */
  wakeText(row: Obligation, minutes: number, waited: number, project: ProjectView): string;
  /** Transfer a decision instead of opening a todo; null means it already ended. */
  handOver?(row: Obligation): Promise<{ decisionItemId: string } | null>;
  /** Whether the transferred step still waits for its new responsible. */
  keepsHandedOver?(row: Obligation, project: ProjectView): boolean;
  /** The integrator todo, after the second deadline. */
  todo?(
    row: Obligation,
    minutes: number,
    waited: number,
    project: ProjectView,
  ): { question: string; todo: QuestionTodo };
}

export interface SourceDeps {
  sessions: ObligationSessions;
  refinement: ObligationRefinement;
  fixLimit: ObligationFixLimit;
  startOffers: ObligationStartOffers;
  fixLimits: Repositories['taskFixLimits'];
  roundsOf(projectKey: string, taskKey: string): number;
  /** The state of a merge by its id: how it ended, null when there is no such merge. */
  mergeState(mergeId: string): string | null;
  /** Whether one of the labels was added to the card at `since` or later (its `task_labels_changed` events). */
  labelsAddedSince(projectKey: string, taskKey: string, labels: readonly string[], since: string): boolean;
  /** Whether the card was imported into its stage at `since` (its `task_created` event): it was not handed over. */
  importedEntry(projectKey: string, taskKey: string, since: string): boolean;
}

const isAi = (config: ProjectConfig, handle: string): boolean => memberOf(config, handle)?.kind === 'ai';

const stageEntered = (task: Task): string => task.stageEnteredAt ?? task.updatedAt;

const latest = (times: readonly (string | null)[]): string | null =>
  times.reduce<string | null>((best, at) => (at && (!best || at > best) ? at : best), null);

/** The step ends with a move: forward it was done, back (or a cancelled card) it was called off. */
function closedByMove(row: Obligation, project: ProjectView): 'fulfilled' | 'cancelled' {
  const task = project.tasks.get(row.taskKey);
  if (!task || task.status === 'cancelled') return 'cancelled';
  const stageId = row.subject.split('@')[0] ?? '';
  const subjectIndex = stageIndex(project.config.pipeline, stageId);
  const nowIndex = stageIndex(project.config.pipeline, task.stageId);
  return subjectIndex >= 0 && nowIndex >= 0 && nowIndex < subjectIndex ? 'cancelled' : 'fulfilled';
}

/** Whether a live row of this exact step exists (the responsible's work on it goes on while it does). */
const hasLive = (project: ProjectView, kind: ObligationKind, d: Omit<DerivedObligation, 'since'>): boolean =>
  project.live.some(
    (row) =>
      row.kind === kind &&
      row.taskKey === d.taskKey &&
      row.responsible === d.responsible &&
      row.subject === d.subject,
  );

const ago = (minutes: number): string => `${minutes} minute${minutes === 1 ? '' : 's'}`;

const askHuman = ' If you are stuck, ask a person with ask_human.';

function todoOf(
  row: Obligation,
  waited: number,
  action: string,
  where: string,
  expected: string,
): { question: string; todo: QuestionTodo } {
  const what =
    `${row.responsible} has not ${action} for ${ago(waited)}; ` +
    `woken once${row.wokenAt ? ` at ${row.wokenAt}` : ''}, no result.`;
  return { question: what, todo: { what, where, expected } };
}

function mergeSource(deps: SourceDeps): ObligationSource {
  return {
    kind: 'merge',
    derive(project) {
      const found: DerivedObligation[] = [];
      for (const task of project.tasks.values()) {
        const merge = task.merge;
        if (!isOpenTask(task) || !merge || !isAi(project.config, merge.merger)) continue;
        if (!['requested', 'failed', 'blocked', 'queued', 'running', 'fixing'].includes(merge.state))
          continue;
        found.push({
          taskKey: task.key,
          responsible: merge.merger,
          subject: merge.id,
          since: merge.requestedAt,
          // The server runs a queued or running merge, and the merger fixes a conflict in `fixing`.
          active: ['queued', 'running', 'fixing'].includes(merge.state),
        });
      }
      return found;
    },
    closedAs: (row) => (deps.mergeState(row.subject) === 'merged' ? 'fulfilled' : 'cancelled'),
    wakeText: (row, minutes, waited) =>
      `projectman reminder: the merge of ${row.taskKey} (${row.subject}) has waited ${ago(waited)} for you. ` +
      `Call merge_task for ${row.taskKey}, or send the card back with the reason if it cannot merge. ` +
      `If nothing happens in ${ago(minutes)}, the step goes to the integrator.${askHuman}`,
    todo: (row, _minutes, waited) =>
      todoOf(
        row,
        waited,
        `called merge_task for ${row.taskKey}`,
        `${row.taskKey}, merge ${row.subject}`,
        `${row.taskKey} merged or sent back`,
      ),
  };
}

function refinementSource(deps: SourceDeps): ObligationSource {
  return {
    kind: 'refinement_turn',
    derive(project) {
      const found: DerivedObligation[] = [];
      for (const task of project.tasks.values()) {
        const wait = project.waits.get(task.key);
        if (!isOpenTask(task) || !wait) continue;
        const turn = deps.refinement.openTurn(task.projectKey, task.key);
        if (!turn || !isAi(project.config, turn.member)) continue;
        const subject = `turn:${turn.label ?? ''}@${turn.at}`;
        const candidate = { taskKey: task.key, responsible: turn.member, subject };
        const atWork = deps.sessions
          .ofMember(task.projectKey, task.key, turn.member)
          .some((session) => session.running && session.atWork);
        if (
          wait.reason === 'refinement' ||
          (wait.reason === 'working' && hasLive(project, 'refinement_turn', candidate))
        )
          found.push({ ...candidate, since: turn.at, active: atWork });
      }
      return found;
    },
    closedAs: (row, project) => {
      const task = project.tasks.get(row.taskKey);
      return !task || task.status === 'cancelled' ? 'cancelled' : 'fulfilled';
    },
    wakeText: (row, minutes, waited) =>
      `projectman reminder: the refinement step of ${row.taskKey} (${labelOf(row)}) has waited ${ago(waited)} for you. ` +
      `Do it and set the label with update_task, or say with the reason why the card cannot be refined. ` +
      `If nothing happens in ${ago(minutes)}, the step goes to the integrator.${askHuman}`,
    todo: (row, _minutes, waited) =>
      todoOf(
        row,
        waited,
        `done its refinement step (${labelOf(row)}) on ${row.taskKey}`,
        `${row.taskKey}, refinement step ${labelOf(row)}`,
        `the label ${labelOf(row)} is set on ${row.taskKey}, or the refinement is stopped`,
      ),
  };
}

/** The label a refinement row waits for (the subject is `turn:<label>@<time>`). */
const labelOf = (row: Obligation): string =>
  row.subject.replace(/^turn:/, '').split('@')[0] || 'the next label';

/**
 * The step stage of an AI member (PM-809): one entry of a card into a `step` stage, for each AI owner of
 * the stage who may set a label the next stage's gate lacks. The step is derived from the stage, not from
 * the card's wait: whoever else works on the card or holds it, the step stays open until its result is
 * there (the pause of the sweep stops the clock). A queue stage has no such step: its cards are the
 * owner's, and a card being refined has its refinement turn.
 */
function reviewSource(deps: SourceDeps): ObligationSource {
  return {
    kind: 'review_step',
    derivesWhilePaused: true,
    derive(project) {
      const found: DerivedObligation[] = [];
      const { config } = project;
      for (const task of project.tasks.values()) {
        if (!isOpenTask(task) || task.kind === 'theme') continue;
        const stage = stageOf(config, task.stageId);
        // A card in a merge is the merge's: the `merge` kind follows it.
        if (stage?.kind !== 'step' || task.merge) continue;
        const since = stageEntered(task);
        for (const owner of stageOwners(config, stage)) {
          if (!isAi(config, owner)) continue;
          const result = stepResult(config, task, owner);
          if (!result || result.gate.every((label) => task.labels.includes(label))) continue;
          if (deps.labelsAddedSince(task.projectKey, task.key, result.results, since)) continue;
          // An imported card stands in the stage since its import: it was not handed over, so no work starts
          // on it by itself (the Operator's idle signal follows it). Entering the stage again is a hand-over.
          if (deps.importedEntry(task.projectKey, task.key, since)) continue;
          found.push({
            taskKey: task.key,
            responsible: owner,
            subject: `${stage.id}@${since}`,
            since,
            active: deps.sessions
              .ofMember(task.projectKey, task.key, owner)
              .some((session) => session.running && session.atWork),
            held: !!task.fixLimit,
          });
        }
      }
      return found;
    },
    closedAs: (row, project) => {
      const task = project.tasks.get(row.taskKey);
      const { config } = project;
      const stage = stageOf(config, stageIdOf(row));
      if (!task || task.status === 'cancelled' || stage?.kind !== 'step') return 'cancelled';
      if (!stageOwners(config, stage).includes(row.responsible)) return 'cancelled';
      const subjectIndex = stageIndex(config.pipeline, stage.id);
      const nowIndex = stageIndex(config.pipeline, task.stageId);
      if (nowIndex > subjectIndex) return 'fulfilled';
      if (nowIndex < subjectIndex) return 'cancelled';
      // In the stage again: another entry than the row's is another step.
      const since = row.subject.slice(row.subject.indexOf('@') + 1);
      if (stageEntered(task) !== since) return 'cancelled';
      if (deps.importedEntry(task.projectKey, task.key, since)) return 'cancelled';
      const result = stepResult(config, task, row.responsible);
      if (!result) return 'cancelled';
      const done =
        result.gate.some((label) => task.labels.includes(label)) ||
        deps.labelsAddedSince(task.projectKey, task.key, result.results, since);
      return done ? 'fulfilled' : 'cancelled';
    },
    wakeText: (row, minutes, waited, project) =>
      `projectman reminder: the ${stageNameOf(row, project)} step of ${row.taskKey} has waited ${ago(waited)} for you. ` +
      `Do it and set its result label with update_task (${resultsOf(row, project)}), or say with the reason why you cannot. ` +
      `If nothing happens in ${ago(minutes)}, the step goes to the integrator.${askHuman}`,
    todo: (row, _minutes, waited, project) =>
      todoOf(
        row,
        waited,
        `finished the ${stageNameOf(row, project)} step of ${row.taskKey}`,
        `${row.taskKey}, stage ${stageNameOf(row, project)}`,
        `a result label (${resultsOf(row, project)}) is set on ${row.taskKey}, or ${row.taskKey} moves on`,
      ),
  };
}

/** The stage a stage-bound row is about (the subject is `<stageId>@<time>`). */
const stageIdOf = (row: Obligation): string => row.subject.split('@')[0] || 'current';

/** The name of the stage a row is about, or its id when the stage is gone. */
const stageNameOf = (row: Obligation, project: ProjectView): string =>
  stageOf(project.config, stageIdOf(row))?.name ?? stageIdOf(row);

/** The labels that end a review step for its responsible, as text (`a, b or c`). */
function resultsOf(row: Obligation, project: ProjectView): string {
  const task = project.tasks.get(row.taskKey);
  const labels = task ? (stepResult(project.config, task, row.responsible)?.results ?? []) : [];
  if (labels.length === 0) return 'the result label';
  return labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

function workSource(deps: SourceDeps): ObligationSource {
  return {
    kind: 'work',
    derive(project) {
      const found: DerivedObligation[] = [];
      for (const task of project.tasks.values()) {
        const wait = project.waits.get(task.key);
        const assignee = task.assignee;
        if (!isOpenTask(task) || !wait || !assignee || !isAi(project.config, assignee)) continue;
        if (stageOf(project.config, task.stageId)?.kind !== 'work') continue;
        if (wait.reason !== 'assignee' && wait.reason !== 'working') continue;
        const sessions = deps.sessions.ofMember(task.projectKey, task.key, assignee);
        const atWork = sessions.some((session) => session.running && session.atWork);
        const entered = stageEntered(task);
        const candidate = { taskKey: task.key, responsible: assignee, subject: `${task.stageId}@${entered}` };
        // A session at work is the work itself: only a step that was open before it goes on being tracked.
        if (atWork && !hasLive(project, 'work', candidate)) continue;
        found.push({
          ...candidate,
          since: latest([entered, ...sessions.map((session) => session.endedAt)]) ?? entered,
          active: atWork,
        });
      }
      return found;
    },
    closedAs: (row, project) => {
      const task = project.tasks.get(row.taskKey);
      if (!task || task.assignee !== row.responsible) return 'cancelled';
      return closedByMove(row, project);
    },
    wakeText: (row, minutes, waited) =>
      `projectman reminder: ${row.taskKey} has stood without your work for ${ago(waited)}. ` +
      `Continue the work, and when it is done hand it over, or say with the reason why you cannot. ` +
      `If nothing happens in ${ago(minutes)}, the step goes to the integrator.${askHuman}`,
    todo: (row, _minutes, waited) =>
      todoOf(
        row,
        waited,
        `continued the work on ${row.taskKey}`,
        `${row.taskKey}, stage ${stageIdOf(row)}`,
        `${row.taskKey} is worked on again or handed over`,
      ),
  };
}

function fixLimitSource(deps: SourceDeps): ObligationSource {
  const ownerHold = (row: Obligation) => {
    const held = deps.fixLimits.get(row.taskKey);
    return held?.holdPhase === 'owner' && row.subject.startsWith(`${held.heldAt}:`) ? held : null;
  };
  return {
    kind: 'fix_limit',
    derive(project) {
      return deps.fixLimits.listHeld(project.config.project.key).flatMap((held) => {
        const task = project.tasks.get(held.taskKey);
        if (
          !task ||
          !isOpenTask(task) ||
          !held.heldAt ||
          !held.decider ||
          (held.holdPhase !== 'lead' && held.holdPhase !== 'replan') ||
          !isAi(project.config, held.decider)
        )
          return [];
        return [
          {
            taskKey: held.taskKey,
            responsible: held.decider,
            subject: `${held.heldAt}:${held.holdPhase}`,
            since: held.heldAt,
            active: deps.sessions
              .ofMember(held.projectKey, held.taskKey, held.decider)
              .some((s) => s.running && s.atWork),
          },
        ];
      });
    },
    closedAs: (row, project) =>
      !project.tasks.has(row.taskKey) || project.tasks.get(row.taskKey)?.status === 'cancelled'
        ? 'cancelled'
        : 'fulfilled',
    keepsHandedOver: (row, project) => {
      const task = project.tasks.get(row.taskKey);
      return !!ownerHold(row) && !!task && isOpenTask(task);
    },
    async handOver(row) {
      // Recover a decision hand-over if the process stopped before the obligation row was stored.
      const owner = ownerHold(row);
      if (owner?.reason === 'decider_timeout' && owner.inboxItemId)
        return { decisionItemId: owner.inboxItemId };
      const held = deps.fixLimits.get(row.taskKey);
      if (!held || row.subject !== `${held.heldAt}:${held.holdPhase}`) return null;
      return deps.fixLimit.timeOut(row.projectKey, row.taskKey, row.responsible);
    },
    wakeText(row, minutes, waited) {
      const taskRounds = deps.roundsOf(row.projectKey, row.taskKey);
      return (
        `projectman reminder: ${row.taskKey} is held at the fix round limit (round ${taskRounds}) and waits for your decision for ${ago(waited)}. ` +
        `Call decide_fix_limit for ${row.taskKey}. If nothing happens in ${ago(minutes)}, the decision goes to the integrator, or to the owners when no integrator is available.`
      );
    },
  };
}

/**
 * The offer to start a ready card (PM-804): the start round opens the row with `open` when it asks the
 * card mover to start the card, and says through `startOffers` whether the offer still stands. The row ends
 * with the card's move into development or an assignee (fulfilled), or when the card does not stand in the
 * queue any more or the round no longer offers it (cancelled).
 */
function startSource(deps: SourceDeps): ObligationSource {
  const targets = (project: ProjectView) => {
    const { config } = project;
    return {
      toStageId: developmentStage(config)?.id ?? 'the development stage',
      backStageId: config.pipeline.stages[0]?.id ?? 'the first stage',
    };
  };
  return {
    kind: 'start',
    derivesWhilePaused: true,
    derive(project) {
      const queue = pullSourceStage(project.config);
      if (!queue) return null;
      const found: DerivedObligation[] = [];
      for (const row of project.live) {
        if (row.kind !== 'start') continue;
        const task = project.tasks.get(row.taskKey);
        if (!task || !isOpenTask(task) || task.assignee || task.stageId !== queue.id) continue;
        const state = deps.startOffers.stateOf(row.projectKey, row.taskKey);
        if (state === 'ended') continue;
        found.push({
          taskKey: row.taskKey,
          responsible: row.responsible,
          subject: row.subject,
          since: row.openedAt,
          held: state === 'paused',
        });
      }
      return found;
    },
    closedAs: (row, project) => {
      const task = project.tasks.get(row.taskKey);
      if (!task || task.status === 'cancelled') return 'cancelled';
      if (task.assignee) return 'fulfilled';
      const development = developmentStage(project.config);
      const pipeline = project.config.pipeline;
      return development && stageIndex(pipeline, task.stageId) >= stageIndex(pipeline, development.id)
        ? 'fulfilled'
        : 'cancelled';
    },
    wakeText: (row, minutes, waited, project) => {
      const { toStageId, backStageId } = targets(project);
      return (
        `projectman reminder: ${row.taskKey} has waited ${ago(waited)} to be started by you. ` +
        `Move it to ${toStageId} with update_task (stage_id ${toStageId}), ` +
        `or open an integrator todo to move it back to ${backStageId} if the owner holds it. ` +
        `If nothing happens in ${ago(minutes)}, the step goes to the integrator.`
      );
    },
    todo: (row, _minutes, waited, project) => {
      const { toStageId, backStageId } = targets(project);
      return todoOf(
        row,
        waited,
        `started ${row.taskKey}`,
        `${row.taskKey}, stage ${stageOf(project.config, project.tasks.get(row.taskKey)?.stageId ?? '')?.name ?? 'the queue'}`,
        `move ${row.taskKey} to ${toStageId}, or, if the owner holds it, back to ${backStageId}`,
      );
    },
  };
}

/** The open steps tracked by the common obligation clock. */
export function obligationSources(deps: SourceDeps): ObligationSource[] {
  return [
    mergeSource(deps),
    refinementSource(deps),
    reviewSource(deps),
    workSource(deps),
    fixLimitSource(deps),
    startSource(deps),
  ];
}
