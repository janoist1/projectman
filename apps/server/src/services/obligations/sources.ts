import { isOpenTask, memberOf, stageIndex, stageOf } from '@projectman/shared';
import type {
  Obligation,
  ObligationKind,
  ProjectConfig,
  QuestionTodo,
  Task,
  TaskWait,
} from '@projectman/shared';
import type { ObligationRefinement, ObligationSessions } from './ports';

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
}

/**
 * One kind of obligation (PM-806): when a step is open, who has to do it, how it ends and what the
 * reminder and the integrator todo say. The sweep does the rest the same way for every kind.
 */
export interface ObligationSource {
  kind: ObligationKind;
  /** The open steps of the project, or null when they cannot be read now (the rows then stay as they are). */
  derive(project: ProjectView): ReadonlyArray<DerivedObligation> | null;
  /** How a row that is not derived any more ended. */
  closedAs(row: Obligation, project: ProjectView): 'fulfilled' | 'cancelled';
  /** The one reminder to the responsible (English; `waited` minutes since the step began, `minutes` is N). */
  wakeText(row: Obligation, minutes: number, waited: number): string;
  /** The integrator todo, after the second deadline. */
  todo(row: Obligation, minutes: number, waited: number): { question: string; todo: QuestionTodo };
}

export interface SourceDeps {
  sessions: ObligationSessions;
  refinement: ObligationRefinement;
  /** The state of a merge by its id: how it ended, null when there is no such merge. */
  mergeState(mergeId: string): string | null;
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

function reviewSource(deps: SourceDeps): ObligationSource {
  return {
    kind: 'review_step',
    derive(project) {
      const found: DerivedObligation[] = [];
      for (const task of project.tasks.values()) {
        const wait = project.waits.get(task.key);
        if (!isOpenTask(task) || !wait) continue;
        // A card in a queue (Ideas, Ready) is nobody's open step: a card put aside waits there on purpose, and
        // one under refinement is covered by the refinement source.
        const kind = stageOf(project.config, task.stageId)?.kind;
        if (kind !== 'step' && kind !== 'release') continue;
        const since = stageEntered(task);
        const subject = `${task.stageId}@${since}`;
        const candidates =
          wait.reason === 'labels_missing'
            ? wait.next.filter((entry) => entry.kind === 'ai').map((entry) => entry.handle)
            : wait.reason === 'working'
              ? // Someone else working on the card does not close the step of a responsible who is not at work.
                [
                  ...new Set([
                    ...wait.next.map((entry) => entry.handle),
                    ...project.live
                      .filter((row) => row.kind === 'review_step' && row.taskKey === task.key)
                      .map((row) => row.responsible),
                  ]),
                ]
              : [];
        for (const responsible of candidates) {
          if (!isAi(project.config, responsible)) continue;
          const candidate = { taskKey: task.key, responsible, subject };
          if (wait.reason === 'working' && !hasLive(project, 'review_step', candidate)) continue;
          const atWork = deps.sessions
            .ofMember(task.projectKey, task.key, responsible)
            .some((session) => session.running && session.atWork);
          found.push({ ...candidate, since, active: atWork });
        }
      }
      return found;
    },
    closedAs: closedByMove,
    wakeText: (row, minutes, waited) =>
      `projectman reminder: the ${stageNameOf(row)} step of ${row.taskKey} has waited ${ago(waited)} for you. ` +
      `Do the review and set the result label with update_task, or say with the reason why you cannot. ` +
      `If nothing happens in ${ago(minutes)}, the step goes to the integrator.${askHuman}`,
    todo: (row, _minutes, waited) =>
      todoOf(
        row,
        waited,
        `finished the ${stageNameOf(row)} step of ${row.taskKey}`,
        `${row.taskKey}, stage ${stageNameOf(row)}`,
        `the result label of the ${stageNameOf(row)} step is set on ${row.taskKey}`,
      ),
  };
}

/** The stage a stage-bound row is about (the subject is `<stageId>@<time>`). */
const stageNameOf = (row: Obligation): string => row.subject.split('@')[0] || 'current';

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
        `${row.taskKey}, stage ${stageNameOf(row)}`,
        `${row.taskKey} is worked on again or handed over`,
      ),
  };
}

/** The four kinds this card tracks (`fix_limit` and the pm path are other cards'). */
export function obligationSources(deps: SourceDeps): ObligationSource[] {
  return [mergeSource(deps), refinementSource(deps), reviewSource(deps), workSource(deps)];
}
