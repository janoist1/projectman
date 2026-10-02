import { DEFAULT_AGENT_PROVIDER, openPrerequisites } from '@projectman/shared';
import type { InboxItem, LabelView, MemberView, Task, WorkDoing } from '@projectman/shared';
import { formatAge } from '../i18n/format';
import { joinNames, t } from '../i18n/t';
import { isAssignedTo, newestFirst, openItems, permissionCommand, shortCommand } from './inbox';
import { labelName } from './labels';
import { nameOf } from './members';
import type { MemberIndex } from './members';
import { nextStage } from './pipeline';
import type { PipelineIndex } from './pipeline';

/**
 * Where a task stands from the viewer's point of view. The board, the phone list and
 * the drawer all use this, so "Rád vár" means the same everywhere.
 */
export type TaskPhase = 'needs_you' | 'working' | 'waiting' | 'blocked' | 'ready' | 'done' | 'cancelled';

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
  /** When the current state began (for the age on the card); the first worker's, while it works. */
  since: string;
  /** The AI member working on it right now, if any (the first of `workers`). */
  worker: MemberView | null;
  /** Everyone working on it right now, in the order the card names them; empty unless the phase is `working`. */
  workers: TaskWorker[];
  /** Set on an open card with an open prerequisite, whatever else is happening to it. */
  prerequisite?: PrerequisiteWait;
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
export type WorkerVerb = 'working' | 'reviewing' | 'testing' | 'designing' | 'planning' | 'analysing';

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
function findWorkers(task: Task, ctx: Pick<TaskStateContext, 'members' | 'pipeline'>): TaskWorker[] {
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
    const sentence = t(`taskStatus.worker.${verb}`, { name: member.displayName });
    return {
      member,
      verb,
      sentence,
      doing: work.doing ?? null,
      line: work.doing
        ? t('taskStatus.workerDoing', { name: member.displayName, summary: work.doing.summary })
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

export function startWaitingHint(task: Task): string | null {
  return task.startWaiting ? t(`taskStatus.startHints.${task.startWaiting.reason}`) : null;
}

function startWaitingLabel(task: Task, ctx: TaskStateContext): string {
  const waiting = task.startWaiting!;
  return t(`taskStatus.startWaiting.${waiting.reason}`, {
    provider: t(`providers.${waiting.provider ?? DEFAULT_AGENT_PROVIDER}`),
    percent: waiting.threshold ?? '',
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
  const { workers = [], ...state } = deriveOpenState(task, ctx, wait);
  return { ...state, workers, ...(wait && !state.prerequisite ? { prerequisite: wait } : {}) };
}

/** A state before `workers` is filled in: every phase but `working` has none. */
type DerivedState = Omit<TaskState, 'workers'> & { workers?: TaskWorker[] };

function deriveOpenState(task: Task, ctx: TaskStateContext, wait: PrerequisiteWait | null): DerivedState {
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

  if (task.startWaiting?.reason === 'prerequisite_open') {
    return standingOnPrerequisite(wait, task.startWaiting.since);
  }
  if (task.startWaiting) {
    return {
      phase: 'waiting',
      label: startWaitingLabel(task, ctx),
      since: task.startWaiting.since,
      worker: null,
    };
  }

  const mine = newestFirst(open.filter((item) => isAssignedTo(item, myHandle)));
  if (mine[0]) {
    return { phase: 'needs_you', label: needsYouLabel(mine[0]), since: mine[0].createdAt, worker: null };
  }

  if (task.status === 'blocked') {
    return { phase: 'blocked', label: t('taskStatus.statuses.blocked'), since: task.updatedAt, worker: null };
  }

  const workers = findWorkers(task, ctx);
  if (workers[0]) {
    return {
      phase: 'working',
      label: workersLabel(workers),
      since: workers[0].since,
      worker: workers[0].member,
      workers,
    };
  }

  // A blocking label (e.g. "waiting for an answer") holds the task until someone takes it off.
  const holding = (ctx.labels ?? []).filter((label) => label.blocks && task.labels.includes(label.id));
  if (holding.length > 0) {
    return {
      phase: 'waiting',
      label: joinNames(holding.map((label) => label.name)),
      since: task.updatedAt,
      worker: null,
    };
  }

  const others = newestFirst(open);
  if (others[0]) {
    const who = joinNames(others[0].assignees.map((handle) => nameOf(handle, members, myHandle)));
    return {
      phase: 'waiting',
      label: t('taskStatus.waitingOn', { who }),
      since: others[0].createdAt,
      worker: null,
    };
  }

  if (stage?.kind === 'queue') {
    if (task.status === 'waiting' || wait) return standingOnPrerequisite(wait, task.updatedAt);
    // An earlier queue (e.g. incoming requests before "ready") is not ready to start yet.
    const label = nextStage(pipeline, stage.id)?.kind === 'queue' ? stage.name : t('taskStatus.ready');
    return { phase: 'ready', label, since: task.createdAt, worker: null };
  }

  const owners = stage?.owners ?? [];
  const humanOwners = owners.filter((handle) => members.get(handle)?.kind === 'human');
  if (task.status === 'waiting' && humanOwners.length > 0) {
    if (myHandle && humanOwners.includes(myHandle)) {
      return {
        phase: 'needs_you',
        label: t('taskStatus.needsYou', { what: stage?.name ?? '' }),
        since: task.updatedAt,
        worker: null,
      };
    }
    const who = joinNames(humanOwners.map((handle) => nameOf(handle, members, myHandle)));
    return {
      phase: 'waiting',
      label: t('taskStatus.waitingOn', { who }),
      since: task.updatedAt,
      worker: null,
    };
  }

  const assignee = task.assignee ? members.get(task.assignee) : undefined;
  if (task.status === 'active' && assignee && stage?.kind === 'work') {
    return {
      phase: 'waiting',
      label: t('taskStatus.waitingOn', { who: nameOf(assignee.handle, members, myHandle) }),
      since: task.updatedAt,
      worker: null,
    };
  }

  // An AI stage owner already carries the task (its session is idle between turns).
  const holder = owners.find(
    (handle) =>
      handle !== task.assignee &&
      members.get(handle)?.kind === 'ai' &&
      members.get(handle)?.currentTaskKeys.includes(task.key),
  );
  if (holder) {
    return {
      phase: 'waiting',
      label: t('taskStatus.waitingOn', { who: nameOf(holder, members, myHandle) }),
      since: task.updatedAt,
      worker: null,
    };
  }

  return {
    phase: 'waiting',
    label: t('taskStatus.queuedFor', { stage: stage?.name ?? task.stageId }),
    since: task.updatedAt,
    worker: null,
  };
}

/** Sort order inside a column: what needs you first, finished work last. */
export const phaseOrder: Record<TaskPhase, number> = {
  needs_you: 0,
  blocked: 1,
  working: 2,
  waiting: 3,
  ready: 4,
  done: 5,
  cancelled: 6,
};

export type BoardFilter = 'all' | 'needsYou' | 'waiting';

export function matchesFilter(phase: TaskPhase, filter: BoardFilter): boolean {
  if (filter === 'needsYou') return phase === 'needs_you';
  if (filter === 'waiting') return phase === 'waiting' || phase === 'blocked';
  return phase !== 'cancelled';
}
