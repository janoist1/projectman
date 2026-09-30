import { evaluateMove, gateRequestOf } from '@projectman/shared';
import type {
  Actor,
  ApprovalRequirement,
  GateEvaluation,
  GateRequestPayload,
  InboxItem,
  Stage,
  Task,
} from '@projectman/shared';
import { isoNow } from '../context';
import { conflict } from '../errors';
import { DECISION_OPTIONS } from '../inbox';
import type { InboxService } from '../inbox';
import { actorHandle, humanActor, newId, unique } from '../util';
import type { TaskLabels } from './labels';
import { requireStage } from './store';
import type { TaskStore } from './store';

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
 * task back takes off the labels that expire then; listeners hear of every move.
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
    const task = this.store.get(projectKey, taskKey);
    if (task.status === 'cancelled') throw conflict('task_closed', `task ${taskKey} is cancelled`);
    const target = requireStage(config, stageId);
    if (task.stageId === target.id) return { task, moved: false, pendingApproval: [] };
    const evaluation = evaluateMove(task, config, task.stageId, target.id);
    if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    if (evaluation.approvals.length > 0) {
      const pending = this.requestApproval(task, target, evaluation.approvals, actor);
      return { task: this.store.get(projectKey, taskKey), moved: false, pendingApproval: pending };
    }
    return { task: await this.applyMove(task, target, actor, {}), moved: true, pendingApproval: [] };
  }

  /** Handler for resolved `decision` items: completes (or drops) the requested stage move. */
  async handleDecisionResolved(item: InboxItem): Promise<void> {
    const gate = gateRequestOf(item);
    const resolution = item.resolution;
    if (!gate || !resolution) return;
    const task = this.store.find(item.projectKey, gate.taskKey);
    if (!task) return;
    const actor = humanActor(resolution.by);
    const siblings = this.inbox
      .list(item.projectKey, { kind: 'decision', taskKey: task.key })
      .filter((i) => gateRequestOf(i)?.requestId === gate.requestId);

    if (resolution.optionId !== 'approve') {
      for (const s of siblings) if (s.state === 'open') this.inbox.cancel(s.id);
      this.settleWaiting(task, actor, {
        gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
      });
      return;
    }
    if (siblings.some((s) => s.state === 'open')) return; // other approvers still have to decide
    if (!siblings.every((s) => s.state === 'resolved' && s.resolution?.optionId === 'approve')) return;
    if (task.stageId !== gate.fromStageId || task.status === 'cancelled') return; // stale request

    const config = await this.store.projects.config(item.projectKey);
    const target = config.pipeline.stages.find((s) => s.id === gate.toStageId);
    if (!target) {
      this.settleWaiting(task, actor, { gateBlocked: { to: gate.toStageId, reason: 'unknown_stage' } });
      return;
    }
    // Approving puts each requested human-only label on the task in the approver's name.
    let current = task;
    for (const sibling of siblings) {
      const payload = gateRequestOf(sibling)!;
      if (!payload.label) {
        // A request from before approvals were labels names no label to put on.
        this.settleWaiting(current, actor, { gateBlocked: { to: target.id } });
        return;
      }
      if (current.labels.includes(payload.label)) continue;
      try {
        current = await this.labels.changeLabels(
          item.projectKey,
          task.key,
          { add: [payload.label] },
          humanActor(sibling.resolution!.by),
          { reason: 'approval' },
        );
      } catch (err) {
        this.settleWaiting(current, actor, {
          gateBlocked: { to: target.id, label: payload.label, reason: (err as { code?: string }).code },
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
    await this.applyMove(current, target, actor, {
      approvedBy: unique(siblings.map((s) => s.resolution!.by)),
      inboxItemIds: siblings.map((s) => s.id),
    });
  }

  private requestApproval(
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
  ): InboxItem[] {
    const { ctx, timeline } = this.store;
    const open = this.inbox
      .list(task.projectKey, { kind: 'decision', state: 'open', taskKey: task.key })
      .filter((i) => {
        const p = gateRequestOf(i);
        return p?.toStageId === target.id && p.fromStageId === task.stageId;
      });
    if (open.length > 0) return open;

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
    const next: Task =
      task.status === 'active' ? { ...task, status: 'waiting', updatedAt: isoNow(ctx) } : task;
    if (next !== task) ctx.repos.tasks.update(next);
    timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: {
        fields: next !== task ? ['status'] : [],
        gateRequest: { requestId, from: task.stageId, to: target.id, inboxItemIds: items.map((i) => i.id) },
      },
    });
    if (next !== task) this.store.publish(next);
    return items;
  }

  private async applyMove(
    task: Task,
    target: Stage,
    actor: Actor,
    extra: Record<string, unknown>,
  ): Promise<Task> {
    const { ctx, timeline } = this.store;
    const at = isoNow(ctx);
    const next: Task = { ...task, stageId: target.id, updatedAt: at };
    if (target.kind === 'done') {
      next.status = 'done';
      next.closedAt = at;
    } else if (task.status === 'done' || task.status === 'waiting') {
      next.status = 'active';
      next.closedAt = null;
    }
    ctx.repos.tasks.update(next);
    timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_stage_changed',
      data: { from: task.stageId, to: target.id, ...extra },
    });
    this.store.publish(next);
    // Facts that expire when work goes back (e.g. "code review ok") come off the task.
    const pipeline = (await this.store.projects.config(task.projectKey)).pipeline;
    const back =
      pipeline.stages.findIndex((s) => s.id === target.id) <
      pipeline.stages.findIndex((s) => s.id === task.stageId);
    if (back) await this.labels.clearLabels(task.projectKey, task.key, 'moved_back');
    // Requests made from the previous stage are stale now.
    for (const item of this.inbox.list(task.projectKey, {
      kind: 'decision',
      state: 'open',
      taskKey: task.key,
    })) {
      this.inbox.cancel(item.id);
    }
    for (const listener of this.stageListeners) {
      try {
        await listener({ task: next, from: task.stageId, to: target.id, actor });
      } catch (err) {
        ctx.logger.error({ err, taskKey: task.key }, 'stage change listener failed');
      }
    }
    return next;
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(task: Task, actor: Actor, data: Record<string, unknown>): void {
    const { ctx, timeline } = this.store;
    const next: Task =
      task.status === 'waiting' ? { ...task, status: 'active', updatedAt: isoNow(ctx) } : task;
    if (next !== task) ctx.repos.tasks.update(next);
    timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: { fields: next !== task ? ['status'] : [], ...data },
    });
    if (next !== task) this.store.publish(next);
  }
}
