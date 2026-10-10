import {
  DEFAULT_AGENT_PROVIDER,
  CODEX_PERMISSION_PROFILE_MIN_VERSION,
  labelDefinition,
  openPrerequisites,
  stageAdvance,
  startBlock,
  taskWait,
  waitHolders,
} from '@projectman/shared';
import type {
  InboxItem,
  LabelView,
  MemberView,
  PausedSession,
  ProjectConfig,
  StartBlock,
  Task,
  TaskPhase,
  TaskStartWaiting,
  TaskWait,
  WorkDoing,
} from '@projectman/shared';
import { formatAge, formatStamp } from '../i18n/format';
import { joinAlternatives, joinNames, t } from '../i18n/t';
import { decidesFixLimit, fixLimitStatus } from './fixLimit';
import { isAssignedTo, openItems, permissionCommand, shortCommand } from './inbox';
import { labelName } from './labels';
import { nameOf } from './members';
import type { MemberIndex } from './members';
import { nextStage } from './pipeline';
import { outageStuckLabel, outageStuckTitle } from './outage';
import type { PipelineIndex } from './pipeline';

/**
 * Where a task stands from the viewer's point of view. The board, the phone list and
 * the drawer all use this, so "Rád vár" means the same everywhere.
 */
export type { TaskPhase };

/**
 * The prerequisites a card still waits for (PM-192): the first in the order of the card's prerequisite
 * links (or of the waiting start's list), how many more, and all of them for the tooltip. Only those
 * the viewer sees count (a client does not see an internal card), so a card none of whose
 * prerequisites is visible has no wait at all; `key` is null only for a label made without one.
 */
export interface PrerequisiteWait {
  key: string | null;
  more: number;
  cards: { key: string; title: string }[];
  /** The state's label already says it (the card stands on it): no second mention on the card. */
  inLabel: boolean;
}

export interface TaskState {
  phase: TaskPhase;
  label: string;
  /** What to do about it, as a tooltip: set on a `stuck` card (PM-468). */
  title?: string;
  /** When the current state began (for the age on the card); the first worker's, while it works. */
  since: string;
  /** The AI member working on it right now, if any (the first of `workers`). */
  worker: MemberView | null;
  /** Everyone working on it right now, in the order the card names them; empty unless the phase is `working`. */
  workers: TaskWorker[];
  /** Set on an open card with an open prerequisite, whatever else is happening to it. */
  prerequisite?: PrerequisiteWait;
  /** The blocking labels the state's label names: the card shows them once, not again as chips. */
  holdingLabels?: string[];
  /**
   * Why a person's Start of the card is refused now (PM-291), from the shared rule; absent when the card
   * can be started, and when the context has no configuration (a client, or the configuration still loads).
   */
  startBlock?: StartBlock;
}

export interface TaskStateContext {
  pipeline: PipelineIndex;
  members: MemberIndex;
  /** Open inbox items by task key (any assignee). */
  openInboxByTask: ReadonlyMap<string, InboxItem[]>;
  tasksByKey: ReadonlyMap<string, Task>;
  myHandle: string | null;
  /** Label definitions; a blocking label on a task makes it wait under the label's name. */
  labels?: readonly LabelView[];
  /** The sessions a team pause holds (PM-220), by session id: their workers read "szünetel" / "megáll…". */
  pausedSessions?: ReadonlyMap<string, PausedSession>;
  /** The team and the pipeline, for the shared start rule (PM-291); missing for a client and while it loads. */
  config?: Pick<ProjectConfig, 'team' | 'pipeline'>;
  /** Engine names by engine id (PM-316), for the `engine_offline` start wait; an unknown id reads as itself. */
  engineNames?: ReadonlyMap<string, string>;
}

/** Done and cancelled tasks are closed: they no longer move or start. */
export function isTaskClosed(task: Pick<Task, 'status'>): boolean {
  return task.status === 'done' || task.status === 'cancelled';
}

export function groupOpenInboxByTask(items: readonly InboxItem[] | undefined): Map<string, InboxItem[]> {
  const map = new Map<string, InboxItem[]>();
  for (const item of openItems(items)) {
    if (!item.taskKey) continue;
    const list = map.get(item.taskKey) ?? [];
    list.push(item);
    map.set(item.taskKey, list);
  }
  return map;
}

function needsYouLabel(item: InboxItem): string {
  const kind = t(`inbox.kindsLower.${item.kind}`);
  const detail = item.kind === 'permission' ? shortCommand(permissionCommand(item)) : null;
  return t('taskStatus.needsYou', { what: detail ? t('taskStatus.needsYouDetail', { kind, detail }) : kind });
}

/** In what capacity a member works on a card; the verb of "X átnézi" / "X dolgozik rajta". */
export type WorkerVerb =
  'working' | 'reviewing' | 'testing' | 'designing' | 'planning' | 'analysing' | 'handingOff';

/** A member's role says the capacity first; the others fall through to the stage rule. */
const ROLE_VERBS: Readonly<Record<string, WorkerVerb>> = {
  qa: 'testing',
  code_review: 'reviewing',
  security_review: 'reviewing',
  designer: 'designing',
  architect: 'planning',
  business_analyst: 'analysing',
};

/** One member working on a card: who, in what capacity, since when and in which session. */
export interface TaskWorker {
  member: MemberView;
  verb: WorkerVerb;
  /** "Vezető Fejlesztő átnézi": the member's own line, with no command in it. */
  sentence: string;
  /** What the member says it does on the card (PM-238); null when it gave no sentence. */
  doing: WorkDoing | null;
  /** The whole line for a tooltip or a screen reader: "{name}: {summary}", or `sentence` without one. */
  line: string;
  since: string;
  sessionId: string;
}

/**
 * The capacity of a member on a card: the member's role first, then a card standing in a step stage
 * (e.g. review) that the member owns, otherwise plain work. Review is so the lead developer reviewing
 * a card of the senior developer reads "átnézi", while the developer reads "dolgozik rajta".
 */
function workerVerb(member: MemberView, task: Task, pipeline: PipelineIndex): WorkerVerb {
  // The old assignee of an open handoff is not working on the card any more, they hand it over (PM-342).
  if (task.handoff?.from === member.handle) return 'handingOff';
  for (const role of [member.role, ...member.roles]) {
    const verb = ROLE_VERBS[role];
    if (verb) return verb;
  }
  const stage = pipeline.stageById.get(task.stageId);
  return stage?.kind === 'step' && stage.owners?.includes(member.handle) ? 'reviewing' : 'working';
}

/**
 * Who works on this card now, in the order the card names them: the owner of the card's current step
 * (e.g. the reviewer) first, then the assignee, then the rest by when they began. Only a member with a working session on
 * the card itself counts. A member's status and activity describe the member as a whole (the member
 * may work on another card), and the command a session runs is never part of this: it lives in the
 * session view.
 */
function findWorkers(
  task: Task,
  ctx: Pick<TaskStateContext, 'members' | 'pipeline' | 'pausedSessions'>,
): TaskWorker[] {
  // A step stage (e.g. review) has the owners who do it; a work stage's owners are the pool the assignee came from.
  const stage = ctx.pipeline.stageById.get(task.stageId);
  const stepOwners = stage?.kind === 'step' ? (stage.owners ?? []) : [];
  const rank = (member: MemberView) =>
    stepOwners.includes(member.handle) ? 0 : member.handle === task.assignee ? 1 : 2;
  const working = [...ctx.members.values()].flatMap((member) => {
    const work = member.taskWork?.find((entry) => entry.taskKey === task.key);
    return work ? [{ member, work }] : [];
  });
  working.sort((a, b) => rank(a.member) - rank(b.member) || a.work.since.localeCompare(b.work.since));
  return working.map(({ member, work }) => {
    const verb = workerVerb(member, task, ctx.pipeline);
    const paused = ctx.pausedSessions?.get(work.sessionId);
    // A paused worker says so, not what it was doing: the sentence would read as if it still works.
    const sentence = paused
      ? t(paused.point === null ? 'taskStatus.workerPausing' : 'taskStatus.workerPaused', {
          name: member.displayName,
        })
      : t(`taskStatus.worker.${verb}`, { name: member.displayName });
    const doing = paused || verb === 'handingOff' ? null : (work.doing ?? null);
    return {
      member,
      verb,
      sentence,
      doing,
      line: doing
        ? t('taskStatus.workerDoing', { name: member.displayName, summary: doing.summary })
        : sentence,
      since: work.since,
      sessionId: work.sessionId,
    };
  });
}

/** The card's short line for those who work on it: one sentence, or the names sharing the verb. */
export function workersLabel(workers: readonly TaskWorker[]): string {
  const names = workers.map((worker) => worker.member.displayName);
  if (workers.length <= 1) return workers[0]?.sentence ?? '';
  if (workers.length === 2) return t('taskStatus.workersTwo', { names: joinNames(names) });
  return t('taskStatus.workersMany', {
    names: names.slice(0, 2).join(t('common.listSeparator')),
    more: names.length - 2,
  });
}

/** The most workers the card names in rows of their own. */
const CARD_WORKER_ROWS = 2;

/**
 * The rows the card's status line shows when a worker has said what they do (PM-239): at most two
 * workers, each with their own sentence, and how many more work on it. Null when nobody has a
 * sentence: the card then shows `state.label` as before. A worker without a sentence keeps their
 * own `sentence` row.
 */
export function cardWorkerRows(
  state: Pick<TaskState, 'workers'>,
): { rows: TaskWorker[]; more: number } | null {
  if (!state.workers.some((worker) => worker.doing)) return null;
  return {
    rows: state.workers.slice(0, CARD_WORKER_ROWS),
    more: Math.max(0, state.workers.length - CARD_WORKER_ROWS),
  };
}

/**
 * The open prerequisites of an open card, from the cards the viewer sees (the shared rule: a closed
 * or withdrawn one no longer holds the card). A start that waits for prerequisites (PM-204) names
 * them too; those the viewer cannot see are left out.
 */
function prerequisiteWait(task: Task, tasksByKey: ReadonlyMap<string, Task>): PrerequisiteWait | null {
  if (isTaskClosed(task)) return null;
  const linked = task.links.flatMap((link) => {
    const other = link.kind === 'prerequisite' ? tasksByKey.get(link.ref) : undefined;
    return other ? [other] : [];
  });
  const open = openPrerequisites(task, linked);
  const keys =
    open.length > 0
      ? open.map((card) => card.key)
      : task.startWaiting?.reason === 'prerequisite_open'
        ? (task.startWaiting.prerequisites ?? []).filter((key) => tasksByKey.has(key))
        : [];
  if (keys.length === 0) return null;
  return {
    key: keys[0]!,
    more: keys.length - 1,
    cards: keys.map((key) => ({ key, title: tasksByKey.get(key)?.title ?? '' })),
    inLabel: false,
  };
}

/** "Előfeltételre vár: PM-202 +1": the label of a card that stands on its prerequisites. */
export function prerequisiteLabel(wait: Pick<PrerequisiteWait, 'key' | 'more'> | null): string {
  if (!wait?.key) return t('taskStatus.prerequisite');
  return wait.more > 0
    ? t('taskStatus.prerequisiteOnMore', { key: wait.key, more: wait.more })
    : t('taskStatus.prerequisiteOn', { key: wait.key });
}

/** The state of a card that stands on its prerequisites: waiting, under the label that names them. */
function standingOnPrerequisite(wait: PrerequisiteWait | null, since: string): Omit<TaskState, 'workers'> {
  return {
    phase: 'waiting',
    label: prerequisiteLabel(wait),
    since,
    worker: null,
    ...(wait ? { prerequisite: { ...wait, inLabel: true } } : {}),
  };
}

/**
 * What a card whose start waits needs, in a sentence. A Senior wait that someone decided to keep says who
 * (the viewer is not named "Te" in the sentence, it reads differently).
 */
export function startWaitingHint(task: Task, members: MemberIndex, myHandle: string | null): string | null {
  const waiting = task.startWaiting;
  if (!waiting) return null;
  if (waiting.reason === 'senior_busy' && waiting.waitDecidedBy) {
    return waiting.waitDecidedBy === myHandle
      ? t('taskStatus.startHints.senior_busy_decided_me')
      : t('taskStatus.startHints.senior_busy_decided', {
          name: nameOf(waiting.waitDecidedBy, members, myHandle),
        });
  }
  return t(`taskStatus.startHints.${waiting.reason}`, {
    minCliVersion: CODEX_PERMISSION_PROFILE_MIN_VERSION,
  });
}

function startWaitingLabel(task: Task, ctx: TaskStateContext): string {
  return startWaitingText(task.startWaiting!, ctx);
}

/** Why a start waits, as a sentence; the project manager's panel (PM-429) says it with the card's words. */
export function startWaitingText(
  waiting: TaskStartWaiting,
  ctx: Pick<TaskStateContext, 'members' | 'myHandle' | 'labels' | 'engineNames'>,
): string {
  if (waiting.reason === 'provider_rate_limited' && !waiting.until)
    return t('taskStatus.startWaiting.provider_rate_limited_unknown');
  if (waiting.reason === 'engine_offline' && !waiting.engine)
    return t('taskStatus.startWaiting.engine_offline_none');
  return t(`taskStatus.startWaiting.${waiting.reason}`, {
    provider: t(`providers.${waiting.provider ?? DEFAULT_AGENT_PROVIDER}`),
    engine: waiting.engine ? (ctx.engineNames?.get(waiting.engine) ?? waiting.engine) : '',
    percent: waiting.threshold ?? '',
    until: waiting.until ? formatStamp(waiting.until) : '',
    prerequisites: (waiting.prerequisites ?? []).join(', '),
    labels: (waiting.labels ?? []).map((id) => labelName(id, ctx.labels ?? [])).join(', '),
    name: waiting.member ? nameOf(waiting.member, ctx.members, ctx.myHandle) : t('taskStatus.stageOwners'),
  });
}

/**
 * The state of a card. An open prerequisite shows in the label when the card stands on it (it waits
 * in a queue, or its start waits), and as `prerequisite` on the state when something else is
 * happening to the card, so the card and the drawer never say it twice.
 */
export function deriveTaskState(task: Task, ctx: TaskStateContext): TaskState {
  const wait = prerequisiteWait(task, ctx.tasksByKey);
  const block = ctx.config ? startBlock(task, ctx.config) : null;
  const { workers = [], ...state } = deriveOpenState(task, ctx, wait, block);
  return {
    ...state,
    workers,
    ...(wait && !state.prerequisite ? { prerequisite: wait } : {}),
    ...(block ? { startBlock: block } : {}),
  };
}

/** A label's name in a status line, in quotes; several read as a list. */
function quotedLabels(ids: readonly string[], ctx: Pick<TaskStateContext, 'labels'>): string {
  return joinNames(ids.map((id) => t('taskStatus.quoted', { name: labelName(id, ctx.labels ?? []) })));
}

/**
 * The main line of a card that waits for approvals only a person may give (PM-445), whether the card
 * cannot start yet or its stage is done: the viewer when they may give it, otherwise the people who may
 * (any one of them), or that nobody may.
 */
function approvalWaiting(
  labelIds: readonly string[],
  approvers: readonly string[],
  since: string,
  ctx: Pick<TaskStateContext, 'members' | 'myHandle' | 'labels'>,
): Omit<TaskState, 'workers'> {
  const label = quotedLabels(labelIds, ctx);
  const state = (phase: TaskPhase, text: string) => ({ phase, label: text, since, worker: null });
  if (approvers.length === 0) return state('blocked', t('taskStatus.approvalNobody', { label }));
  if (ctx.myHandle && approvers.includes(ctx.myHandle))
    return state('needs_you', t('taskStatus.approvalMissingYou', { label }));
  const who = joinAlternatives(approvers.map((handle) => nameOf(handle, ctx.members, ctx.myHandle)));
  return state('waiting', t('taskStatus.approvalMissingBy', { who, label }));
}

/**
 * The main line of a card a person cannot start yet (PM-291), who or what it waits for: the part of
 * the shared start rule the viewer reads. Null when the rule does not hold the card back, or when an
 * earlier line (someone works on it, a blocking label holds it) already says it.
 */
function startBlockState(
  task: Task,
  block: StartBlock,
  ctx: TaskStateContext,
): Omit<TaskState, 'workers'> | null {
  const { members, myHandle, config } = ctx;
  const waiting = (label: string, phase: TaskPhase = 'waiting'): Omit<TaskState, 'workers'> => ({
    phase,
    label,
    since: task.updatedAt,
    worker: null,
  });
  switch (block.kind) {
    case 'refining': {
      const { turn } = block.refinement;
      if (turn.kind === 'done') return waiting(t('taskStatus.refinement.moving'), 'done');
      if (turn.kind === 'blocked') {
        const system = config && labelDefinition(config, turn.label)?.setBy === 'system';
        return system
          ? waiting(t('taskStatus.refinement.system', { label: quotedLabels([turn.label], ctx) }))
          : waiting(joinNames([labelName(turn.label, ctx.labels ?? [])]));
      }
      const label = quotedLabels([turn.label], ctx);
      if (turn.aiSetters.length === 0 && myHandle && turn.humanSetters.includes(myHandle))
        return waiting(t('taskStatus.refinement.yourStep', { label }), 'needs_you');
      const setters = turn.aiSetters.length > 0 ? turn.aiSetters : turn.humanSetters;
      if (setters.length === 0) return waiting(t('taskStatus.refinement.nobody', { label }), 'blocked');
      const who = joinNames(setters.map((handle) => nameOf(handle, members, myHandle)));
      return waiting(t('taskStatus.waitingOn', { who }));
    }
    case 'approval':
      return approvalWaiting([block.label], block.approvers, task.updatedAt, ctx);
    case 'unmet':
      return block.refines
        ? { ...waiting(t('taskStatus.notRefined'), 'ready'), since: task.createdAt }
        : waiting(t('taskStatus.labelsMissing', { labels: quotedLabels(block.labels, ctx) }));
    case 'held':
      return waiting(joinNames(block.labels.map((id) => labelName(id, ctx.labels ?? []))));
  }
}

/** A state before `workers` is filled in: every phase but `working` has none. */
type DerivedState = Omit<TaskState, 'workers'> & { workers?: TaskWorker[] };

function deriveOpenState(
  task: Task,
  ctx: TaskStateContext,
  prerequisites: PrerequisiteWait | null,
  block: StartBlock | null,
): DerivedState {
  const { pipeline, members, myHandle } = ctx;
  const stage = pipeline.stageById.get(task.stageId);
  const open = ctx.openInboxByTask.get(task.key) ?? [];

  if (task.status === 'cancelled') {
    const original = task.links.find((link) => link.kind === 'duplicate_of')?.ref;
    return {
      phase: 'cancelled',
      label: original ? t('taskStatus.duplicateOf', { key: original }) : t('taskStatus.statuses.cancelled'),
      since: task.updatedAt,
      worker: null,
    };
  }
  if (task.status === 'done' || stage?.kind === 'done') {
    const closed = task.closedAt ?? task.updatedAt;
    return {
      phase: 'done',
      label: t('taskStatus.done', { when: formatAge(closed) }),
      since: closed,
      worker: null,
    };
  }

  const workers = findWorkers(task, ctx);
  const wait = taskWait({
    task,
    // Where the configuration is not known (a client, or it still loads) the team and the stages are
    // sketched from what the board has, and the start rule and the gates are not asked (PM-460).
    config: ctx.config ?? sketchConfig(ctx),
    rulesKnown: !!ctx.config,
    openItems: open,
    workers: workers.map((worker) => ({
      handle: worker.member.handle,
      since: worker.since,
      handingOff: worker.verb === 'handingOff',
    })),
    holders: waitHolders(task, [...members.values()]),
    openPrerequisites: (prerequisites?.cards ?? []).map((card) => card.key),
    viewer: myHandle,
  });
  // The card stands because its provider or engine cannot work (PM-468), a start or a continuation alike.
  // It wins over every other reason but a prerequisite and a handing-off, which stay the news (PM-342).
  if (task.outage && wait?.reason !== 'prerequisite' && wait?.reason !== 'handing_off') {
    return {
      phase: 'stuck',
      label: outageStuckLabel(task.outage),
      title: outageStuckTitle(task.outage),
      since: task.startWaiting?.since ?? task.outage.since,
      worker: null,
    };
  }
  if (!wait) return queuedFor(task, ctx);
  return stateOfWait(task, wait, { ctx, workers, prerequisites, block });
}

function queuedFor(task: Task, ctx: Pick<TaskStateContext, 'pipeline'>): Omit<TaskState, 'workers'> {
  const stage = ctx.pipeline.stageById.get(task.stageId);
  return {
    phase: 'waiting',
    label: t('taskStatus.queuedFor', { stage: stage?.name ?? task.stageId }),
    since: task.updatedAt,
    worker: null,
  };
}

/**
 * The team and the stages as far as the board knows them, for the shared rule where the configuration
 * is not known: members with their kind, stages without gates, the blocking labels.
 */
function sketchConfig(ctx: TaskStateContext): Pick<ProjectConfig, 'team' | 'pipeline'> {
  return {
    team: {
      members: [...ctx.members.values()].map((member) => ({
        handle: member.handle,
        kind: member.kind,
        displayName: member.displayName,
      })),
    },
    pipeline: {
      stages: ctx.pipeline.stages.map(({ gate: _gate, ...stage }) => stage),
      labels: (ctx.labels ?? []).map(({ id, name, blocks }) => ({ id, name, blocks })),
    },
  } as unknown as Pick<ProjectConfig, 'team' | 'pipeline'>;
}

/**
 * The state of a card from the shared reason it stands still (PM-460): the phase and the sentence the
 * board has always shown for each reason. A reason that several causes share (`nobody`, `labels_missing`,
 * `refinement`) keeps the line of its cause.
 */
function stateOfWait(
  task: Task,
  wait: TaskWait,
  parts: {
    ctx: TaskStateContext;
    workers: TaskWorker[];
    prerequisites: PrerequisiteWait | null;
    block: StartBlock | null;
  },
): DerivedState {
  const { ctx, workers, prerequisites, block } = parts;
  const { members, myHandle } = ctx;
  const stage = ctx.pipeline.stageById.get(task.stageId);
  const item = ctx.openInboxByTask.get(task.key)?.find((entry) => entry.id === wait.inboxItemId);
  const mine = !!item && isAssignedTo(item, myHandle);
  const handles = wait.next.map((actor) => actor.handle);
  const waitingOn = (who: readonly string[], since: string): Omit<TaskState, 'workers'> => ({
    phase: 'waiting',
    label: t('taskStatus.waitingOn', {
      who: joinNames(who.map((handle) => nameOf(handle, members, myHandle))),
    }),
    since,
    worker: null,
  });

  switch (wait.reason) {
    case 'prerequisite':
      return standingOnPrerequisite(prerequisites, wait.since);
    case 'handing_off': {
      const handing = workers.filter((worker) => worker.verb === 'handingOff');
      return {
        phase: 'working',
        label: workersLabel(handing),
        since: handing[0]!.since,
        worker: handing[0]!.member,
        workers: handing,
      };
    }
    case 'start_waiting':
      return { phase: 'waiting', label: startWaitingLabel(task, ctx), since: wait.since, worker: null };
    case 'inbox':
    case 'hand_on': {
      if (item && mine)
        return { phase: 'needs_you', label: needsYouLabel(item), since: wait.since, worker: null };
      return waitingOn(handles, wait.since);
    }
    case 'blocked':
      return { phase: 'blocked', label: t('taskStatus.statuses.blocked'), since: wait.since, worker: null };
    case 'fix_limit': {
      const limit = task.fixLimit!;
      return {
        phase: mine || decidesFixLimit(limit, myHandle) ? 'needs_you' : 'waiting',
        label: fixLimitStatus(limit, members, myHandle),
        since: wait.since,
        worker: null,
      };
    }
    case 'working':
      return {
        phase: 'working',
        label: workersLabel(workers),
        since: wait.since,
        worker: workers[0]!.member,
        workers,
      };
    case 'held': {
      const names = wait.labels.map((id) => labelName(id, ctx.labels ?? []));
      return {
        phase: 'waiting',
        label: joinNames(names),
        since: wait.since,
        worker: null,
        holdingLabels: [...wait.labels],
      };
    }
    case 'approval':
      return approvalWaiting(wait.labels, handles, wait.since, ctx);
    case 'labels_missing':
    case 'refinement':
      return (block && startBlockState(task, block, ctx)) || queuedFor(task, ctx);
    case 'ready': {
      // An earlier queue (e.g. incoming requests before "ready") is not ready to start yet.
      const label =
        stage && nextStage(ctx.pipeline, stage.id)?.kind === 'queue' ? stage.name : t('taskStatus.ready');
      return { phase: 'ready', label, since: wait.since, worker: null };
    }
    case 'queued': {
      const [first] = wait.next;
      // The people who own the stage: the viewer among them is asked, the others are waited for.
      if (first?.kind === 'human') {
        return myHandle && handles.includes(myHandle)
          ? {
              phase: 'needs_you',
              label: t('taskStatus.needsYou', { what: stage?.name ?? '' }),
              since: wait.since,
              worker: null,
            }
          : waitingOn(handles, wait.since);
      }
      // An AI stage owner already carries the card (its session is idle between turns).
      return first ? waitingOn(handles, wait.since) : queuedFor(task, ctx);
    }
    case 'assignee':
      return waitingOn(handles, wait.since);
    case 'nobody': {
      // Nobody can act: the line says what is missing, as its cause always did.
      const blocked = block ? startBlockState(task, block, ctx) : null;
      if (blocked) return blocked;
      const advance = ctx.config ? stageAdvance(task, ctx.config) : null;
      if (advance?.kind === 'approve') {
        return approvalWaiting(
          advance.approvals.map((approval) => approval.label),
          [],
          task.updatedAt,
          ctx,
        );
      }
      return queuedFor(task, ctx);
    }
  }
}

/** Sort order inside a column: what needs you first, finished work last. */
export const phaseOrder: Record<TaskPhase, number> = {
  needs_you: 0,
  blocked: 1,
  stuck: 1,
  working: 2,
  waiting: 3,
  ready: 4,
  done: 5,
  cancelled: 6,
};

export type BoardFilter = 'all' | 'needsYou' | 'waiting';

export function matchesFilter(phase: TaskPhase, filter: BoardFilter): boolean {
  if (filter === 'needsYou') return phase === 'needs_you';
  if (filter === 'waiting') return phase === 'waiting' || phase === 'blocked' || phase === 'stuck';
  return phase !== 'cancelled';
}
