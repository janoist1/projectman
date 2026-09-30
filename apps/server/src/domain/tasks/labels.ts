import { expiredLabels, planLabelChange } from '@projectman/shared';
import type { Actor, LabelChangeReason, LabelClearTrigger, ProjectConfig, Task } from '@projectman/shared';
import { isoNow } from '../context';
import { forbidden, invalid } from '../errors';
import { SYSTEM_ACTOR } from '../util';
import { runEffects } from './store';
import type { Effect, TaskStore } from './store';

/** A planned label change: the task's labels after it, and what it adds, removes and notifies. */
export interface PlannedLabels {
  labels: string[];
  added: string[];
  removed: string[];
  notify: string[];
}

export interface LabelChangeOptions {
  /** Why the labels need to change, recorded as a task comment (mentions notify). */
  comment?: string;
  sessionId?: string | null;
  /** An automatic change: what caused it. */
  reason?: LabelChangeReason;
}

/** Whether a planned change adds or removes anything. */
export function labelsChange(plan: PlannedLabels): boolean {
  return plan.added.length > 0 || plan.removed.length > 0;
}

/** Plans a label change under the project's label rules; a refusal throws the domain error. */
export function planLabelsOrThrow(
  config: ProjectConfig,
  task: Task,
  change: { add?: string[]; remove?: string[] },
  actor: Actor,
  comment: string | undefined,
): PlannedLabels {
  const plan = planLabelChange(config, task, change, actor, comment);
  if (plan.ok) return plan;
  const refusal = plan.refusal;
  switch (refusal.code) {
    case 'self_review_forbidden':
      throw forbidden('self_review_forbidden', 'the assignee and PR authors cannot set this label', {
        label: refusal.label,
      });
    case 'label_not_allowed':
      throw forbidden('label_not_allowed', `label ${refusal.label} cannot be changed: ${refusal.reason}`, {
        label: refusal.label,
        reason: refusal.reason,
      });
    case 'comment_required':
      throw invalid('comment_required', 'these labels need a comment with the reason', {
        labels: refusal.labels,
      });
  }
}

/**
 * Labels on tasks: adding and removing them under the project's label rules, and taking off
 * the ones that expire on an event.
 */
export class TaskLabels {
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  /**
   * Adds and removes labels under the project's label rules: who may set them, no self-review,
   * a comment when a label asks for one. Adding a grouped label replaces the other labels of
   * its group. The comment is recorded as a task comment (mentions notify), and a label that
   * notifies the assignee sends them the change.
   */
  async changeLabels(
    projectKey: string,
    taskKey: string,
    change: { add?: string[]; remove?: string[] },
    actor: Actor,
    opts: LabelChangeOptions = {},
  ): Promise<Task> {
    const config = await this.store.projects.config(projectKey);
    const effects: Effect[] = [];
    const task = this.store.ctx.unitOfWork(() =>
      this.apply(config, this.store.get(projectKey, taskKey), change, actor, opts, effects),
    );
    await runEffects(effects);
    return task;
  }

  /** Removes the labels that expire on an event (the task moving back, its PR changing). */
  async clearLabels(projectKey: string, taskKey: string, trigger: LabelClearTrigger): Promise<void> {
    const config = await this.store.projects.config(projectKey);
    const effects: Effect[] = [];
    this.store.ctx.unitOfWork(() =>
      this.expire(config, this.store.get(projectKey, taskKey), trigger, effects),
    );
    await runEffects(effects);
  }

  /**
   * Applies a label change to `task`, read in the running unit of work; refused as a whole
   * before anything is written. Notifications are added to `effects`.
   */
  apply(
    config: ProjectConfig,
    task: Task,
    change: { add?: string[]; remove?: string[] },
    actor: Actor,
    opts: LabelChangeOptions,
    effects: Effect[],
  ): Task {
    const plan = planLabelsOrThrow(config, task, change, actor, opts.comment);
    if (!labelsChange(plan)) return task;
    const next = this.store.write(task, { labels: plan.labels, updatedAt: isoNow(this.store.ctx) });
    this.store.publish(next);
    this.record(config, next, plan, actor, opts, effects);
    return next;
  }

  /**
   * Records a planned change already written to `task`: the timeline event, the comment, and
   * (in `effects`) the notice to the assignee.
   */
  record(
    config: ProjectConfig,
    task: Task,
    plan: PlannedLabels,
    actor: Actor,
    opts: LabelChangeOptions,
    effects: Effect[],
  ): void {
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      sessionId: opts.sessionId ?? null,
      actor,
      type: 'task_labels_changed',
      data: { added: plan.added, removed: plan.removed, ...(opts.reason ? { reason: opts.reason } : {}) },
    });
    const comment = opts.comment?.trim();
    if (comment) this.store.recordNote(config, task, comment, actor, opts.sessionId ?? null, effects);
    if (plan.notify.length > 0 && task.assignee && actor.handle && task.assignee !== actor.handle)
      effects.push(() =>
        this.store.ctx.events.emit('task_labels_notice', { task, labels: plan.notify, actor, comment }),
      );
  }

  /** Takes off the labels of `task` that expire on `trigger`, in the running unit of work. */
  expire(config: ProjectConfig, task: Task, trigger: LabelClearTrigger, effects: Effect[]): Task {
    const expired = expiredLabels(config, task, trigger);
    if (expired.length === 0) return task;
    return this.apply(config, task, { remove: expired }, SYSTEM_ACTOR, { reason: trigger }, effects);
  }
}
