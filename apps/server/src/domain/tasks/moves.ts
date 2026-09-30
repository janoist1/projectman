import { evaluateMove, gateRequestOf, stageIndex, stageOf } from '@projectman/shared';
import type {
  Actor,
  ApprovalRequirement,
  GateEvaluation,
  GateRequestPayload,
  InboxItem,
  ProjectConfig,
  Stage,
  Task,
} from '@projectman/shared';
import type { TaskPatch } from '../../db';
import { isoNow } from '../context';
import { conflict } from '../errors';
import { DECISION_OPTIONS } from '../inbox';
import type { InboxService } from '../inbox';
import { actorHandle, humanActor, newId, unique } from '../util';
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

export type StageChangeListener = (change: StageChange) => void | Promise<void>;

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
 * task back takes off the labels that expire then; listeners hear of every move once it is
 * committed.
 */
export class TaskMoves {
  private readonly store: TaskStore;
  private readonly labels: TaskLabels;
  private readonly inbox: InboxService;
  private readonly stageListeners: StageChangeListener[] = [];

  constructor(deps: { store: TaskStore; labels: TaskLabels; inbox: InboxService }) {
    this.store = deps.store;
    this.labels = deps.labels;
    this.inbox = deps.inbox;
  }

  onStageChanged(listener: StageChangeListener): void {
    this.stageListeners.push(listener);
  }

  /**
   * Moves a task to a stage if the gates allow it. Unmet conditions throw `gate_blocked`;
   * human approvals create `decision` inbox items for the approvers and the task moves only
   * once they approve (an AI member can never resolve inbox items).
   */
  async moveToStage(projectKey: string, taskKey: string, stageId: string, actor: Actor): Promise<MoveResult> {
    const config = await this.store.projects.config(projectKey);
    const effects: Effect[] = [];
    const result = this.store.ctx.unitOfWork(() =>
      this.move(config, this.store.get(projectKey, taskKey), stageId, actor, effects),
    );
    await runEffects(effects);
    return result;
  }

  /**
   * Moves `task`, read in the running unit of work, or requests the approvals the move needs.
   * The stage listeners are added to `effects`.
   */
  move(config: ProjectConfig, task: Task, stageId: string, actor: Actor, effects: Effect[]): MoveResult {
    if (task.status === 'cancelled') throw conflict('task_closed', `task ${task.key} is cancelled`);
    const target = requireStage(config, stageId);
    if (task.stageId === target.id) return { task, moved: false, pendingApproval: [] };
    const evaluation = evaluateMove(task, config, task.stageId, target.id);
    if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    if (evaluation.approvals.length > 0) {
      const requested = this.requestApproval(task, target, evaluation.approvals, actor);
      return { task: requested.task, moved: false, pendingApproval: requested.items };
    }
    return {
      task: this.applyMove(config, task, target, actor, {}, effects),
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
    const effects: Effect[] = [];
    this.store.ctx.unitOfWork(() => this.decide(config, item, gate, humanActor(resolution.by), effects));
    await runEffects(effects);
  }

  private decide(
    config: ProjectConfig,
    item: InboxItem,
    gate: GateRequestPayload,
    actor: Actor,
    effects: Effect[],
  ): void {
    const task = this.store.find(item.projectKey, gate.taskKey);
    if (!task) return;
    const siblings = this.inbox
      .list(item.projectKey, { kind: 'decision', taskKey: task.key })
      .filter((i) => gateRequestOf(i)?.requestId === gate.requestId);

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
    // Approving puts each requested human-only label on the task in the approver's name.
    let current = task;
    for (const sibling of siblings) {
      const label = gateRequestOf(sibling)!.label;
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
      },
      effects,
    );
  }

  /** Opens one decision per missing approval (or finds the open request) and marks the task waiting. */
  private requestApproval(
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
  ): { task: Task; items: InboxItem[] } {
    const open = this.inbox
      .list(task.projectKey, { kind: 'decision', state: 'open', taskKey: task.key })
      .filter((i) => {
        const p = gateRequestOf(i);
        return p?.toStageId === target.id && p.fromStageId === task.stageId;
      });
    if (open.length > 0) return { task, items: open };

    if (approvals.some((req) => req.approvers.length === 0))
      throw conflict('release_four_eyes', 'no independent human approver is available');
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
    extra: { approvedBy?: string[]; inboxItemIds?: string[] },
    effects: Effect[],
  ): Task {
    const at = isoNow(this.store.ctx);
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
    effects.push(() => this.notifyStageChanged(change));
    return next;
  }

  private async notifyStageChanged(change: StageChange): Promise<void> {
    for (const listener of this.stageListeners) {
      try {
        await listener(change);
      } catch (err) {
        this.store.ctx.logger.error({ err, taskKey: change.task.key }, 'stage change listener failed');
      }
    }
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(task: Task, actor: Actor, data: Record<string, unknown>): void {
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
