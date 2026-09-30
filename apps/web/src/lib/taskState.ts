import type { InboxItem, LabelView, MemberView, Task } from '@projectman/shared';
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

export interface TaskState {
  phase: TaskPhase;
  label: string;
  /** When the current state began (for the age on the card). */
  since: string;
  /** The AI member working on it right now, if any. */
  worker: MemberView | null;
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

function findWorker(task: Task, members: MemberIndex): MemberView | null {
  const working = [...members.values()].filter(
    (member) => member.status === 'working' && member.currentTaskKeys.includes(task.key),
  );
  return working.find((member) => member.handle === task.assignee) ?? working[0] ?? null;
}

function unmetPrerequisites(task: Task, tasksByKey: ReadonlyMap<string, Task>): boolean {
  return task.links.some((link) => {
    if (link.kind !== 'prerequisite') return false;
    const other = tasksByKey.get(link.ref);
    return !other || !isTaskClosed(other);
  });
}

export function startWaitingHint(task: Task): string | null {
  return task.startWaiting ? t(`taskStatus.startHints.${task.startWaiting.reason}`) : null;
}

function startWaitingLabel(task: Task, ctx: TaskStateContext): string {
  const waiting = task.startWaiting!;
  return t(`taskStatus.startWaiting.${waiting.reason}`, {
    provider: t(`providers.${waiting.provider ?? 'claude'}`),
    percent: waiting.threshold ?? '',
    name: waiting.member ? nameOf(waiting.member, ctx.members, ctx.myHandle) : t('taskStatus.stageOwners'),
  });
}

export function deriveTaskState(task: Task, ctx: TaskStateContext): TaskState {
  const { pipeline, members, myHandle } = ctx;
  const stage = pipeline.stageById.get(task.stageId);
  const open = ctx.openInboxByTask.get(task.key) ?? [];

  if (task.status === 'cancelled') {
    return { phase: 'cancelled', label: t('taskStatus.cancelled'), since: task.updatedAt, worker: null };
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
    return { phase: 'blocked', label: t('taskStatus.blocked'), since: task.updatedAt, worker: null };
  }

  const worker = findWorker(task, members);
  if (worker) {
    return {
      phase: 'working',
      label: worker.activity
        ? t('taskStatus.working', { activity: worker.activity })
        : t('taskStatus.workingPlain'),
      since: task.updatedAt,
      worker,
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
    if (task.status === 'waiting' || unmetPrerequisites(task, ctx.tasksByKey)) {
      return { phase: 'waiting', label: t('taskStatus.prerequisite'), since: task.updatedAt, worker: null };
    }
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
