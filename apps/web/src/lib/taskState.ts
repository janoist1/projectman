import { DEFAULT_AGENT_PROVIDER, openPrerequisites } from '@projectman/shared';
import type { InboxItem, LabelView, MemberView, Task, TaskWork } from '@projectman/shared';
import { formatAge } from '../i18n/format';
import { joinNames, t } from '../i18n/t';
import { isAssignedTo, newestFirst, openItems, permissionCommand, shortCommand } from './inbox';
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
 * The prerequisites a card still waits for (PM-192): the first by key, how many more, and all of them
 * for the tooltip. `key` is null when none is visible to the viewer (a client does not see an
 * internal card's key).
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
  /** When the current state began (for the age on the card). */
  since: string;
  /** The AI member working on it right now, if any. */
  worker: MemberView | null;
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

/**
 * Who works on this card now: a member with a working session on the card itself. A member's status
 * and activity describe the member as a whole (the member may work on another card), so they say
 * nothing about this one.
 */
function findWorker(task: Task, members: MemberIndex): { member: MemberView; work: TaskWork } | null {
  const working = [...members.values()].flatMap((member) => {
    const work = member.taskWork?.find((entry) => entry.taskKey === task.key);
    return work ? [{ member, work }] : [];
  });
  return working.find(({ member }) => member.handle === task.assignee) ?? working[0] ?? null;
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
function standingOnPrerequisite(wait: PrerequisiteWait | null, since: string): TaskState {
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
  const state = deriveOpenState(task, ctx, wait);
  return wait && !state.prerequisite ? { ...state, prerequisite: wait } : state;
}

function deriveOpenState(task: Task, ctx: TaskStateContext, wait: PrerequisiteWait | null): TaskState {
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

  const found = findWorker(task, members);
  if (found) {
    const { member, work } = found;
    return {
      phase: 'working',
      label: work.activity
        ? t('taskStatus.working', { activity: work.activity })
        : t('taskStatus.workingPlain'),
      since: work.since,
      worker: member,
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
