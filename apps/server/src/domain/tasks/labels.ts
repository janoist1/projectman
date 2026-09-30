import { expiredLabels, planLabelChange } from '@projectman/shared';
import type { Actor, LabelChangeReason, LabelClearTrigger, ProjectConfig, Task } from '@projectman/shared';
import { isoNow } from '../context';
import { forbidden, invalid } from '../errors';
import { SYSTEM_ACTOR } from '../util';
import type { TaskStore } from './store';

/** A planned label change: the task's labels after it, and what it adds, removes and notifies. */
export interface PlannedLabels {
  labels: string[];
  added: string[];
  removed: string[];
  notify: string[];
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
    opts: {
      comment?: string;
      sessionId?: string | null;
      reason?: LabelChangeReason;
    } = {},
  ): Promise<Task> {
    const { ctx, timeline } = this.store;
    const config = await this.store.projects.config(projectKey);
    const task = this.store.get(projectKey, taskKey);
    const plan = planLabelsOrThrow(config, task, change, actor, opts.comment);
    if (plan.added.length === 0 && plan.removed.length === 0) return task;
    const next: Task = { ...task, labels: plan.labels, updatedAt: isoNow(ctx) };
    ctx.repos.tasks.update(next);
    timeline.append({
      projectKey,
      taskKey,
      sessionId: opts.sessionId ?? null,
      actor,
      type: 'task_labels_changed',
      data: { added: plan.added, removed: plan.removed, ...(opts.reason ? { reason: opts.reason } : {}) },
    });
    this.store.publish(next);
    const comment = opts.comment?.trim();
    if (comment) await this.store.addNote(projectKey, taskKey, comment, actor, opts.sessionId ?? null);
    const notify = plan.notify;
    if (notify.length > 0 && next.assignee && actor.handle && next.assignee !== actor.handle)
      await this.store.labelNotifier?.(next, notify, actor, comment);
    return next;
  }

  /** Removes the labels that expire on an event (the task moving back, its PR changing). */
  async clearLabels(projectKey: string, taskKey: string, trigger: LabelClearTrigger): Promise<void> {
    const config = await this.store.projects.config(projectKey);
    const task = this.store.get(projectKey, taskKey);
    const expired = expiredLabels(config, task, trigger);
    if (expired.length > 0)
      await this.changeLabels(projectKey, taskKey, { remove: expired }, SYSTEM_ACTOR, { reason: trigger });
  }
}
