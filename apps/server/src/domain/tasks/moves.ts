import {
  evaluateMove,
  gateRequestOf,
  isOpenTask,
  noApproverReason,
  stageHandsOverForReview,
  stageIndex,
  stageOf,
} from '@projectman/shared';
import type {
  Actor,
  ApprovalRequirement,
  GateEvaluation,
  GateRequestPayload,
  InboxItem,
  ProjectConfig,
  Stage,
  Task,
  TimelineEventData,
} from '@projectman/shared';
import type { SourceHead } from '../../contracts';
import type { TaskPatch } from '../../db';
import { isoNow } from '../context';
import { conflict, DomainError } from '../errors';
import { DECISION_OPTIONS } from '../inbox';
import type { InboxService } from '../inbox';
import { actorHandle, humanActor, newId, SYSTEM_ACTOR, unique } from '../util';
import type { TaskLabels } from './labels';
import { requireStage, runEffects } from './store';
import type { Effect, TaskStore } from './store';

export interface MoveResult {
  task: Task;
  moved: boolean;
  /** Decision items waiting for approvers when the target stage needs a human approval. */
  pendingApproval: InboxItem[];
}

export interface StageChange {
  task: Task;
  from: string;
  to: string;
  actor: Actor;
}

/** The head of the developer's branch, read before a move that hands the task over for review or testing. */
export interface Handover {
  head: SourceHead;
}

/** What a move may carry besides its target (PM-183). */
export interface MoveOptions {
  /** Read by `prepareHandover` before the unit of work; the move records the pin. */
  handover?: Handover | null;
  /** The system sends the task back because its branch moved after the hand-over. */
  branchMoved?: NonNullable<TimelineEventData['task_stage_changed']['branchMoved']>;
}

/** Reads the head of the branch a task's developer hands over, null when there is none to read. */
export type SourceHeadReader = (config: ProjectConfig, task: Task) => Promise<SourceHead | null>;

export function gateBlockedError(evaluation: GateEvaluation) {
  return conflict('gate_blocked', 'the gate conditions of the target stage are not met', {
    unmet: evaluation.unmet,
    approvals: evaluation.approvals,
  });
}

export function approvalRequestedError(items: InboxItem[]) {
  return conflict(
    'approval_requested',
    'a human approval was requested; the task moves once it is approved',
    {
      inboxItemIds: items.map((i) => i.id),
      approvers: unique(items.flatMap((i) => i.assignees)),
    },
  );
}

/**
 * Stage moves: gates, approval requests in the inbox and the approvers' decisions. Moving a
 * task back takes off the labels that expire then; every move is a `task_stage_changed` domain
 * event once it is committed.
 */
export class TaskMoves {
  private readonly store: TaskStore;
  private readonly labels: TaskLabels;
  private readonly inbox: InboxService;
  private readonly sourceHead: SourceHeadReader;

  constructor(deps: {
    store: TaskStore;
    labels: TaskLabels;
    inbox: InboxService;
    sourceHead: SourceHeadReader;
  }) {
    this.store = deps.store;
    this.labels = deps.labels;
    this.inbox = deps.inbox;
    this.sourceHead = deps.sourceHead;
  }

  /**
   * Moves a task to a stage if the gates allow it. Unmet conditions throw `gate_blocked`;
   * human approvals create `decision` inbox items for the approvers and the task moves only
   * once they approve (an AI member can never resolve inbox items). Entering a review or test
   * stage hands the branch over: see `prepareHandover`.
   */
  async moveToStage(
    projectKey: string,
    taskKey: string,
    stageId: string,
    actor: Actor,
    opts: Pick<MoveOptions, 'branchMoved'> = {},
  ): Promise<MoveResult> {
    const config = await this.store.projects.config(projectKey);
    const handover = await this.prepareHandover(config, this.store.get(projectKey, taskKey), stageId);
    const effects: Effect[] = [];
    const result = this.store.ctx.unitOfWork(() =>
      this.move(config, this.store.get(projectKey, taskKey), stageId, actor, effects, { ...opts, handover }),
    );
    await runEffects(effects);
    return result;
  }

  /**
   * The hand-over of a move into a review or test stage (PM-183), read before the unit of work:
   * the head of the developer's branch. Uncommitted work in the developer's working directory
   * refuses the move (`handover_uncommitted`), whoever moves it, because reviewers only ever see
   * committed work. Null for any other move, and for a task without a repository or a branch.
   */
  async prepareHandover(config: ProjectConfig, task: Task, stageId: string): Promise<Handover | null> {
    const target = stageOf(config, stageId);
    if (!target || task.stageId === target.id || task.status === 'cancelled') return null;
    if (!stageHandsOverForReview(config, target)) return null;
    const head = await this.sourceHead(config, task);
    if (!head) return null;
    if (head.dirty)
      throw conflict(
        'handover_uncommitted',
        `task ${task.key} cannot enter ${target.name}: ${head.path} has ${head.changes} uncommitted ${head.changes === 1 ? 'change' : 'changes'} on ${head.branch}; commit them (reviewers only see committed work) and move the task again`,
        {
          taskKey: task.key,
          stageId: target.id,
          path: head.path,
          branch: head.branch,
          changes: head.changes,
        },
      );
    return { head };
  }

  /**
   * A new review round of the developer's asking (PM-138) pins the branch head anew: the task
   * stays where it is. Does nothing unless the task is in the stage of its pin and the head moved.
   */
  async repin(projectKey: string, taskKey: string, by: string): Promise<void> {
    const config = await this.store.projects.config(projectKey);
    const task = this.store.get(projectKey, taskKey);
    const pin = this.store.ctx.repos.reviewPins.get(task.key);
    if (!pin || pin.stageId !== task.stageId || !isOpenTask(task)) return;
    const head = await this.sourceHead(config, task);
    if (!head || head.commit === pin.commit) return;
    this.store.ctx.unitOfWork(() => {
      const current = this.store.get(projectKey, taskKey);
      if (current.stageId !== pin.stageId) return;
      const at = isoNow(this.store.ctx);
      this.store.ctx.repos.reviewPins.save({
        ...pin,
        commit: head.commit,
        branch: head.branch,
        pinnedAt: at,
        pinnedBy: by,
      });
      this.store.timeline.append({
        projectKey,
        taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_updated',
        data: {
          fields: ['reviewPin'],
          reviewPin: { commit: head.commit, branch: head.branch, previous: pin.commit },
        },
      });
      this.store.publish(current);
    });
  }

  /**
   * Moves `task`, read in the running unit of work, or requests the approvals the move needs.
   * The stage listeners are added to `effects`.
   */
  move(
    config: ProjectConfig,
    task: Task,
    stageId: string,
    actor: Actor,
    effects: Effect[],
    opts: MoveOptions = {},
  ): MoveResult {
    if (task.status === 'cancelled') throw conflict('task_closed', `task ${task.key} is cancelled`);
    const target = requireStage(config, stageId);
    if (task.stageId === target.id) return { task, moved: false, pendingApproval: [] };
    const evaluation = evaluateMove(task, config, task.stageId, target.id);
    if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    if (evaluation.approvals.length > 0) {
      const requested = this.requestApproval(config, task, target, evaluation.approvals, actor);
      return { task: requested.task, moved: false, pendingApproval: requested.items };
    }
    const head = opts.handover?.head;
    const extra: Pick<TimelineEventData['task_stage_changed'], 'reviewPin' | 'branchMoved'> = {
      ...(head ? { reviewPin: { commit: head.commit, branch: head.branch } } : {}),
      ...(opts.branchMoved ? { branchMoved: opts.branchMoved } : {}),
    };
    return {
      task: this.applyMove(config, task, target, actor, extra, effects, head),
      moved: true,
      pendingApproval: [],
    };
  }

  /** Handler for resolved `decision` items: completes (or drops) the requested stage move. */
  async handleDecisionResolved(item: InboxItem): Promise<void> {
    const gate = gateRequestOf(item);
    const resolution = item.resolution;
    if (!gate || !resolution) return;
    const config = await this.store.projects.config(item.projectKey);
    // An approved move into a review or test stage hands the branch over like any other (PM-183).
    let handover: Handover | null = null;
    let refused = false;
    const task = this.store.find(item.projectKey, gate.taskKey);
    if (
      resolution.optionId === 'approve' &&
      task &&
      task.stageId === gate.fromStageId &&
      task.status !== 'cancelled'
    ) {
      try {
        handover = await this.prepareHandover(config, task, gate.toStageId);
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== 'handover_uncommitted') throw err;
        refused = true;
      }
    }
    const effects: Effect[] = [];
    this.store.ctx.unitOfWork(() =>
      this.decide(config, item, gate, humanActor(resolution.by), effects, { handover, refused }),
    );
    await runEffects(effects);
  }

  private decide(
    config: ProjectConfig,
    item: InboxItem,
    gate: GateRequestPayload,
    actor: Actor,
    effects: Effect[],
    handed: { handover: Handover | null; refused: boolean },
  ): void {
    const task = this.store.find(item.projectKey, gate.taskKey);
    if (!task) return;
    const siblings = this.inbox.gateRequestItems(item.projectKey, task.key, gate.requestId);

    if (item.resolution?.optionId !== 'approve') {
      for (const s of siblings) if (s.state === 'open') this.inbox.cancel(s.id);
      this.settleWaiting(task, actor, {
        gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
      });
      return;
    }
    if (siblings.some((s) => s.state === 'open')) return; // other approvers still have to decide
    if (!siblings.every((s) => s.state === 'resolved' && s.resolution?.optionId === 'approve')) return;
    if (task.stageId !== gate.fromStageId || task.status === 'cancelled') return; // stale request

    const target = stageOf(config, gate.toStageId);
    if (!target) {
      this.settleWaiting(task, actor, { gateBlocked: { to: gate.toStageId, reason: 'unknown_stage' } });
      return;
    }
    if (handed.refused) {
      // Uncommitted work in the developer's working directory: the approved move does not happen.
      this.settleWaiting(task, actor, { gateBlocked: { to: target.id, reason: 'handover_uncommitted' } });
      return;
    }
    // Approving puts each requested human-only label on the task in the approver's name.
    let current = task;
    for (const sibling of siblings) {
      const label = gateRequestOf(sibling)?.label;
      if (!label) {
        // A request from before approvals were labels names no label to put on.
        this.settleWaiting(current, actor, { gateBlocked: { to: target.id } });
        return;
      }
      if (current.labels.includes(label)) continue;
      const approver = humanActor(sibling.resolution!.by);
      try {
        const before = current;
        current = this.store.ctx.unitOfWork(() =>
          this.labels.apply(config, before, { add: [label] }, approver, { reason: 'approval' }, effects),
        );
      } catch (err) {
        this.settleWaiting(current, actor, {
          gateBlocked: { to: target.id, label, reason: (err as { code?: string }).code },
        });
        return;
      }
    }
    const evaluation = evaluateMove(current, config, current.stageId, target.id);
    if (evaluation.unmet.length > 0 || evaluation.approvals.length > 0) {
      this.settleWaiting(current, actor, {
        gateBlocked: { to: target.id, unmet: evaluation.unmet, approvals: evaluation.approvals },
      });
      return;
    }
    this.applyMove(
      config,
      current,
      target,
      actor,
      {
        approvedBy: unique(siblings.map((s) => s.resolution!.by)),
        inboxItemIds: siblings.map((s) => s.id),
        ...(handed.handover
          ? { reviewPin: { commit: handed.handover.head.commit, branch: handed.handover.head.branch } }
          : {}),
      },
      effects,
      handed.handover?.head,
    );
  }

  /** Opens one decision per missing approval (or finds the open request) and marks the task waiting. */
  private requestApproval(
    config: ProjectConfig,
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
  ): { task: Task; items: InboxItem[] } {
    const open = this.inbox.openGateRequests(task.projectKey, task.key, task.stageId, target.id);
    if (open.length > 0) return { task, items: open };

    for (const req of approvals) {
      if (req.approvers.length > 0) continue;
      // Nobody may give it: the holders authored the task, or nobody holds the label.
      const reason = noApproverReason(config, req.label, task) ?? 'missing_duty_holder';
      throw conflict(reason, `nobody may approve the label ${req.label} on this task`, {
        stageId: req.stageId,
        label: req.label,
      });
    }
    const requestId = newId('gat');
    const items = approvals.map((req) => {
      const payload: GateRequestPayload = {
        requestId,
        taskKey: task.key,
        fromStageId: task.stageId,
        toStageId: target.id,
        stageId: req.stageId,
        label: req.label,
        requestedBy: actor,
      };
      return this.inbox.create({
        projectKey: task.projectKey,
        kind: 'decision',
        assignees: req.approvers,
        source: actorHandle(actor),
        taskKey: task.key,
        title: task.title,
        payload: { gate: payload },
        options: DECISION_OPTIONS,
      });
    });
    const waiting = task.status === 'active';
    const next = waiting
      ? this.store.write(task, { status: 'waiting', updatedAt: isoNow(this.store.ctx) })
      : task;
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: {
        fields: waiting ? ['status'] : [],
        gateRequest: { requestId, from: task.stageId, to: target.id, inboxItemIds: items.map((i) => i.id) },
      },
    });
    if (waiting) this.store.publish(next);
    return { task: next, items };
  }

  private applyMove(
    config: ProjectConfig,
    task: Task,
    target: Stage,
    actor: Actor,
    extra: Pick<
      TimelineEventData['task_stage_changed'],
      'approvedBy' | 'inboxItemIds' | 'reviewPin' | 'branchMoved'
    >,
    effects: Effect[],
    pin?: SourceHead,
  ): Task {
    const at = isoNow(this.store.ctx);
    // The commit handed over with the stage the task leaves is no longer its pin.
    this.store.ctx.repos.reviewPins.clear(task.key);
    if (pin)
      this.store.ctx.repos.reviewPins.save({
        projectKey: task.projectKey,
        taskKey: task.key,
        stageId: target.id,
        commit: pin.commit,
        branch: pin.branch,
        pinnedAt: at,
        pinnedBy: actorHandle(actor),
      });
    const patch: TaskPatch = { stageId: target.id, updatedAt: at };
    if (target.kind === 'done') {
      patch.status = 'done';
      patch.closedAt = at;
    } else if (task.status === 'done' || task.status === 'waiting') {
      patch.status = 'active';
      patch.closedAt = null;
    }
    let next = this.store.write(task, patch);
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_stage_changed',
      data: { from: task.stageId, to: target.id, ...extra },
    });
    this.store.publish(next);
    // Facts that expire when work goes back (e.g. "code review ok") come off the task.
    if (stageIndex(config.pipeline, target.id) < stageIndex(config.pipeline, task.stageId))
      next = this.labels.expire(config, next, 'moved_back', effects);
    // Requests made from the previous stage are stale now.
    for (const item of this.inbox.list(task.projectKey, {
      kind: 'decision',
      state: 'open',
      taskKey: task.key,
    })) {
      this.inbox.cancel(item.id);
    }
    const change: StageChange = { task: next, from: task.stageId, to: target.id, actor };
    effects.push(() => this.store.ctx.events.emit('task_stage_changed', change));
    return next;
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(
    task: Task,
    actor: Actor,
    data: Pick<TimelineEventData['task_updated'], 'gateRejected' | 'gateBlocked'>,
  ): void {
    const waiting = task.status === 'waiting';
    const next = waiting
      ? this.store.write(task, { status: 'active', updatedAt: isoNow(this.store.ctx) })
      : task;
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: { fields: waiting ? ['status'] : [], ...data },
    });
    if (waiting) this.store.publish(next);
  }
}
