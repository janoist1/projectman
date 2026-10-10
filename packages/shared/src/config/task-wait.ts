import { z } from 'zod';
import {
  alertPayloadOf,
  fixLimitDecisionOf,
  gateRequestOf,
  handOnRequestOf,
  mergeRequestOf,
  InboxKind,
} from '../domain/inbox';
import type { InboxItem } from '../domain/inbox';
import { LabelId } from '../domain/label';
import { MemberHandle } from '../domain/member';
import { StageId } from '../domain/pipeline';
import { isTheme, TaskKey, TaskStartWaiting } from '../domain/task';
import type { Task } from '../domain/task';
import { stageOwners } from './duties';
import { aiLabelSetters, evaluateStart, stageAdvance, stageIndex } from './gates';
import { labelDefinition } from './labels';
import { memberOf, stageOf } from './lookup';
import { developmentStage } from './refinement';
import type { ProjectConfig } from './schema';
import { startBlock } from './start-block';
import type { StartBlock } from './start-block';

/**
 * Why a card stands still (PM-460): one rule for the board, the API and the text the AI members read.
 * The web turns the result into its phases and sentences, the server fills `TaskDetail.wait` and the
 * `get_task` / `list_tasks` lines from it. A pure function: everything it needs is passed in.
 */

export const TaskWaitReason = z.enum([
  /** Somebody works on it now. */
  'working',
  /** The old assignee hands it over (PM-342). */
  'handing_off',
  /** The start waits (`startWaiting.reason` says for what). */
  'start_waiting',
  /** An open prerequisite holds it. */
  'prerequisite',
  /** An open item waits for a person (a question, a permission, a decision...). */
  'inbox',
  /** The status is blocked. */
  'blocked',
  /** It is held at the fix round limit and waits for a decision (PM-262). */
  'fix_limit',
  /** A holding label (for example waiting-answer) holds it. */
  'held',
  /** The card merger must merge the approved work before the target stage. */
  'merge',
  /** The work is done, the card mover takes it on. */
  'hand_on',
  /** A person's approval of the next gate is missing (PM-445). */
  'approval',
  /** Labels of the next gate are missing. */
  'labels_missing',
  /** A refinement step is on turn. */
  'refinement',
  /** It stands in the queue and may start. */
  'ready',
  /** It waits for the owner of its stage or for its queue. */
  'queued',
  /** In a work stage its assignee takes it on. */
  'assignee',
  /** Nobody can take it on (a faulty set-up). */
  'nobody',
]);
export type TaskWaitReason = z.infer<typeof TaskWaitReason>;

export const TaskWait = z.object({
  reason: TaskWaitReason,
  /** Who acts next, in order; empty when the system or nobody does. */
  next: z.array(z.object({ handle: MemberHandle, kind: z.enum(['human', 'ai']) })),
  /** The stage the card would enter, when the wait is about a move. */
  toStageId: StageId.nullable(),
  /** Missing gate labels, approvals or holding labels the wait is about. */
  labels: z.array(LabelId),
  /** The open inbox item the wait is about (reason inbox, hand_on, approval, fix_limit). */
  inboxItemId: z.string().nullable(),
  inboxKind: InboxKind.nullable(),
  startWaiting: TaskStartWaiting.nullable(),
  prerequisites: z.array(TaskKey),
  since: z.string(),
});
export type TaskWait = z.infer<typeof TaskWait>;

export interface TaskWaitInput {
  task: Task;
  config: Pick<ProjectConfig, 'team' | 'pipeline'>;
  /** The card's open inbox items, any assignee. */
  openItems: readonly InboxItem[];
  /** Members working on the card now, in the card's order. */
  workers: readonly { handle: string; since: string; handingOff: boolean }[];
  /** AI members whose idle session holds the card. */
  holders: readonly string[];
  /** Open prerequisites the viewer sees (openPrerequisites). */
  openPrerequisites: readonly string[];
  /** The viewer: an inbox item assigned to them comes first, as on the board today; null for the API and AI text. */
  viewer: string | null;
  /**
   * False when `config` is only a sketch of the team and the stages (a client, or the configuration still
   * loads in the web): the start rule and the gates are then not asked, as the board never asked them.
   */
  rulesKnown?: boolean;
}

type Fields = Partial<Omit<TaskWait, 'reason' | 'since' | 'next'>>;

/** The members as `next` entries: configured ones only, each once, in the given order. */
function actors(config: Pick<ProjectConfig, 'team'>, handles: readonly string[]): TaskWait['next'] {
  const seen = new Set<string>();
  return handles.flatMap((handle) => {
    const member = memberOf(config, handle);
    if (!member || seen.has(handle)) return [];
    seen.add(handle);
    return [{ handle, kind: member.kind }];
  });
}

function make(
  config: Pick<ProjectConfig, 'team'>,
  reason: TaskWaitReason,
  since: string,
  handles: readonly string[],
  fields: Fields = {},
): TaskWait {
  return {
    reason,
    next: actors(config, handles),
    toStageId: null,
    labels: [],
    inboxItemId: null,
    inboxKind: null,
    startWaiting: null,
    prerequisites: [],
    ...fields,
    since,
  };
}

function newestFirst(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The labels and the approvers of the open gate requests among the items, null when one names no label. */
function gateApprovalsOf(
  items: readonly InboxItem[],
): { labels: string[]; approvers: string[]; toStageId: string } | null {
  const gates = items.flatMap((item) => {
    const gate = gateRequestOf(item);
    return gate ? [{ gate, item }] : [];
  });
  if (gates.length === 0 || gates.some(({ gate }) => !gate.label)) return null;
  return {
    labels: [...new Set(gates.map(({ gate }) => gate.label!))],
    approvers: [...new Set(gates.flatMap(({ item }) => item.assignees))],
    toStageId: gates[0]!.gate.toStageId,
  };
}

/** The stage after the card's own, null at the end of the pipeline. */
function nextStageId(config: Pick<ProjectConfig, 'pipeline'>, task: Pick<Task, 'stageId'>): string | null {
  return config.pipeline.stages[stageIndex(config.pipeline, task.stageId) + 1]?.id ?? null;
}

/** An approval only people may give: whose it is, or that nobody may. */
function approvalWait(
  config: Pick<ProjectConfig, 'team'>,
  labels: readonly string[],
  approvers: readonly string[],
  since: string,
  fields: Fields,
): TaskWait {
  const next = actors(config, approvers);
  return make(config, next.length === 0 ? 'nobody' : 'approval', since, approvers, {
    ...fields,
    labels: [...labels],
  });
}

/** The wait an open item of the card stands for. */
function itemWait(
  item: InboxItem,
  items: readonly InboxItem[],
  task: Task,
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
): TaskWait {
  const merge = task.merge;
  const alert = alertPayloadOf(item);
  if (
    merge &&
    (mergeRequestOf(item)?.mergeId === merge.id ||
      (alert?.alert === 'merge_blocked' && alert.mergeId === merge.id))
  ) {
    return make(config, 'merge', merge.requestedAt, [merge.merger], {
      toStageId: merge.toStageId,
      inboxItemId: item.id,
      inboxKind: item.kind,
    });
  }
  const gate = gateRequestOf(item) ? gateApprovalsOf(items) : null;
  if (gate) {
    return approvalWait(config, gate.labels, gate.approvers, item.createdAt, {
      toStageId: gate.toStageId,
      inboxItemId: item.id,
      inboxKind: item.kind,
    });
  }
  const fields = { inboxItemId: item.id, inboxKind: item.kind };
  if (task.fixLimit && fixLimitDecisionOf(item)) {
    return make(config, 'fix_limit', item.createdAt, fixLimitDeciders(task), fields);
  }
  if (item.kind === 'hand_on') {
    const toStageId = task.handOn?.toStageId ?? handOnRequestOf(item)?.toStageId ?? null;
    return make(config, 'hand_on', item.createdAt, item.assignees, { ...fields, toStageId });
  }
  return make(config, 'inbox', item.createdAt, item.assignees, fields);
}

function fixLimitDeciders(task: Pick<Task, 'fixLimit'>): string[] {
  const limit = task.fixLimit;
  if (!limit) return [];
  return limit.phase === 'owner' ? limit.deciders : limit.decider ? [limit.decider] : [];
}

/** The wait of a card whose start the shared start rule refuses (PM-291). */
function startBlockWait(
  task: Task,
  block: StartBlock,
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
): TaskWait {
  const since = task.updatedAt;
  const toStageId = nextStageId(config, task);
  switch (block.kind) {
    case 'refining': {
      const { turn, targetStageId } = block.refinement;
      if (turn.kind === 'step') {
        const setters = turn.aiSetters.length > 0 ? turn.aiSetters : turn.humanSetters;
        return make(config, setters.length === 0 ? 'nobody' : 'refinement', since, setters, {
          labels: [turn.label],
          toStageId: targetStageId,
        });
      }
      return make(config, 'refinement', since, [], {
        labels: turn.kind === 'blocked' ? [turn.label] : [],
        toStageId: targetStageId,
      });
    }
    case 'approval':
      return approvalWait(config, [block.label], block.approvers, since, { toStageId });
    case 'unmet': {
      const work = developmentStage(config);
      const unmet = work ? evaluateStart(task, config, work.id).unmet : [];
      const ai = aiLabelSetters(config, unmet, () => false);
      const setters = ai
        ? ai.members.map((member) => member.handle)
        : unmet
            .flatMap((entry) => entry.setters ?? [])
            .filter((handle) => memberOf(config, handle)?.kind === 'human');
      return make(
        config,
        setters.length === 0 ? 'nobody' : 'labels_missing',
        block.refines ? task.createdAt : since,
        setters,
        {
          labels: block.labels,
          toStageId,
        },
      );
    }
    case 'held':
      return make(config, 'held', since, [], { labels: block.labels });
  }
}

/**
 * Why a card stands still, in this order: a start waiting for prerequisites, a handoff, the start's
 * wait, an item for the viewer, a blocked status, the fix round limit, the workers, a holding label,
 * a hand-on to the card mover, an item for somebody else, what keeps the start back, the queue, the
 * humans owning the stage, the assignee, an AI member holding the card, the stage's queue. Null for a
 * done or cancelled card (and a theme, which does not move).
 */
export function taskWait(input: TaskWaitInput): TaskWait | null {
  const { task, config, workers, holders, viewer } = input;
  const stage = stageOf(config, task.stageId);
  if (task.status === 'done' || task.status === 'cancelled' || stage?.kind === 'done' || isTheme(task))
    return null;

  const items = input.openItems.filter((item) => item.state === 'open');
  const waiting = task.startWaiting;

  if (waiting?.reason === 'prerequisite_open') {
    const prerequisites =
      input.openPrerequisites.length > 0 ? [...input.openPrerequisites] : [...(waiting.prerequisites ?? [])];
    return make(config, 'prerequisite', waiting.since, [], { startWaiting: waiting, prerequisites });
  }
  // The old assignee still hands the card over (PM-342): that, and not the receiver's wait, is the news.
  if (task.handoff) {
    const handing = workers.filter((worker) => worker.handingOff);
    if (handing[0]) {
      return make(
        config,
        'handing_off',
        handing[0].since,
        handing.map((worker) => worker.handle),
      );
    }
  }
  if (waiting) {
    return make(config, 'start_waiting', waiting.since, waiting.member ? [waiting.member] : [], {
      startWaiting: waiting,
      prerequisites: [...(waiting.prerequisites ?? [])],
    });
  }

  const mine = viewer ? newestFirst(items.filter((item) => item.assignees.includes(viewer))) : [];
  if (mine[0]) return itemWait(mine[0], mine, task, config);

  if (task.status === 'blocked') return make(config, 'blocked', task.updatedAt, []);

  // A card held at its fix round limit waits for a decision, whoever else is on it (PM-262).
  if (task.fixLimit) {
    const decision = newestFirst(items).find((item) => fixLimitDecisionOf(item));
    return make(config, 'fix_limit', task.fixLimit.heldAt, fixLimitDeciders(task), {
      inboxItemId: decision?.id ?? null,
      inboxKind: decision?.kind ?? null,
    });
  }

  const working = workers.filter((worker) => !worker.handingOff);
  if (working[0]) {
    return make(
      config,
      'working',
      working[0].since,
      working.map((worker) => worker.handle),
    );
  }

  // A blocking label (e.g. "waiting for an answer") holds the task until someone takes it off.
  const holding = task.labels.filter((id) => labelDefinition(config, id)?.blocks);
  if (holding.length > 0) return make(config, 'held', task.updatedAt, [], { labels: holding });

  if (task.merge) {
    const item = newestFirst(items).find(
      (item) =>
        item.kind === 'merge_request' ||
        (item.kind === 'alert' && alertPayloadOf(item)?.alert === 'merge_blocked'),
    );
    return make(config, 'merge', task.merge.requestedAt, [task.merge.merger], {
      toStageId: task.merge.toStageId,
      inboxItemId: item?.id ?? null,
      inboxKind: item?.kind ?? null,
    });
  }
  const handOnItem = newestFirst(items).find((item) => item.kind === 'hand_on');
  if (task.handOn || handOnItem) {
    const handOn = task.handOn;
    const request = handOnItem ? handOnRequestOf(handOnItem) : null;
    return make(
      config,
      'hand_on',
      handOn?.requestedAt ?? handOnItem!.createdAt,
      handOn ? [handOn.mover] : handOnItem!.assignees,
      {
        toStageId: handOn?.toStageId ?? request?.toStageId ?? null,
        inboxItemId: handOn?.inboxItemId ?? handOnItem?.id ?? null,
        inboxKind: handOn?.inboxItemId || handOnItem ? 'hand_on' : null,
      },
    );
  }

  const others = newestFirst(items);
  if (others[0]) return itemWait(others[0], others, task, config);

  // A card that cannot be started yet says what it waits for, before the queue's "ready" (PM-291).
  const block = input.rulesKnown === false ? null : startBlock(task, config);
  if (block) return startBlockWait(task, block, config);

  // The stage is done and only an approval only a person may give is missing (PM-445).
  const advance = input.rulesKnown === false ? null : stageAdvance(task, config);
  if (advance?.kind === 'approve') {
    return approvalWait(
      config,
      advance.approvals.map((approval) => approval.label),
      advance.approvals.flatMap((approval) => approval.approvers),
      task.updatedAt,
      { toStageId: advance.to.id },
    );
  }

  if (stage?.kind === 'queue') {
    if (task.status === 'waiting' || input.openPrerequisites.length > 0) {
      return make(config, 'prerequisite', task.updatedAt, [], {
        prerequisites: [...input.openPrerequisites],
      });
    }
    return make(config, 'ready', task.createdAt, [], { toStageId: nextStageId(config, task) });
  }

  const owners = stage ? stageOwners(config, stage) : [];
  const humanOwners = owners.filter((handle) => memberOf(config, handle)?.kind === 'human');
  if (task.status === 'waiting' && humanOwners.length > 0) {
    return make(config, 'queued', task.updatedAt, humanOwners);
  }

  if (
    task.status === 'active' &&
    task.assignee &&
    memberOf(config, task.assignee) &&
    stage?.kind === 'work'
  ) {
    return make(config, 'assignee', task.updatedAt, [task.assignee]);
  }

  // An AI stage owner already carries the task (its session is idle between turns).
  const holder = owners.find(
    (handle) =>
      handle !== task.assignee && memberOf(config, handle)?.kind === 'ai' && holders.includes(handle),
  );
  if (holder) return make(config, 'queued', task.updatedAt, [holder]);

  // A step nobody owns cannot be done by anyone.
  if (stage?.kind === 'step' && owners.length === 0) return make(config, 'nobody', task.updatedAt, []);
  return make(config, 'queued', task.updatedAt, []);
}

/** The part of a member's roster entry (`MemberView`) that says who works on or holds a card. */
export interface WaitMember {
  handle: string;
  kind: 'human' | 'ai';
  currentTaskKeys: readonly string[];
  taskWork?: readonly { taskKey: string; since: string }[] | undefined;
}

/**
 * Who works on the card now, for `taskWork` of the roster: the owners of the card's current step (e.g.
 * the reviewer) first, then the assignee, then the rest by when they began. The old assignee of an open
 * handoff works on it as `handingOff` (PM-342).
 */
export function waitWorkers(
  task: Pick<Task, 'key' | 'stageId' | 'assignee' | 'handoff'>,
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  members: readonly WaitMember[],
): TaskWaitInput['workers'] {
  const stage = stageOf(config, task.stageId);
  const stepOwners = stage?.kind === 'step' ? stageOwners(config, stage) : [];
  const rank = (handle: string) => (stepOwners.includes(handle) ? 0 : handle === task.assignee ? 1 : 2);
  return members
    .flatMap((member) => {
      const work = member.taskWork?.find((entry) => entry.taskKey === task.key);
      return work ? [{ handle: member.handle, since: work.since }] : [];
    })
    .sort((a, b) => rank(a.handle) - rank(b.handle) || a.since.localeCompare(b.since))
    .map((worker) => ({ ...worker, handingOff: task.handoff?.from === worker.handle }));
}

/** The AI members that carry the card without working on it now (a session idle between turns). */
export function waitHolders(task: Pick<Task, 'key'>, members: readonly WaitMember[]): string[] {
  return members
    .filter((member) => member.kind === 'ai' && member.currentTaskKeys.includes(task.key))
    .map((member) => member.handle);
}
