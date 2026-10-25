import { collectingAutoClose, labelDefinition } from '@projectman/shared';
import type { ProjectConfig, Task } from '@projectman/shared';
import type { DomainContext } from '../base';
import type { ProjectService } from '../projects';
import type { TaskService } from './service';
import { DomainError, KeyedMutex, SYSTEM_ACTOR } from '../../kernel';

/** The refusals that only mean the card stays open for a person to move. */
const REFUSALS: ReadonlySet<string> = new Set([
  'gate_blocked',
  'task_not_merged',
  'task_closed',
  'approval_requested',
]);

/**
 * A collecting card closes with its parts (PM-647): when the last subtask closes (enters the done stage or
 * is cancelled), or the card loses its last blocking label, the system moves the card to the done stage
 * without the gates (`collectingAutoClose` says when). The move is the system's, so the timeline shows it;
 * it is valid only for the stage stay it was read in (`expectedFrom`) and only while the waiver holds
 * (`partsClosed`), and it never falls back to the gates. The recovery sweep skips cards reopened from Done.
 */
export class CollectingCloser {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly mutex = new KeyedMutex();

  constructor(deps: { ctx: DomainContext; projects: ProjectService; tasks: TaskService }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
  }

  /** A subtask closed (entered the done stage or was cancelled): closes its parent when `collectingAutoClose` holds. */
  async partClosed(part: Task): Promise<void> {
    if (!part.parentKey) return;
    await this.close(part.projectKey, part.parentKey, part.key);
  }

  /** Recover missed close events, without closing a card that somebody reopened from Done. */
  async sweep(): Promise<void> {
    for (const project of this.projects.summaries()) {
      for (const task of this.tasks.readSchedulingTasks(project.key, { kind: 'open' })) {
        try {
          await this.close(project.key, task.key, undefined, true);
        } catch (err) {
          this.ctx.logger.warn({ err, taskKey: task.key }, 'collecting card recovery failed');
        }
      }
    }
  }

  /** A collecting card lost its last blocking label: closes it when `collectingAutoClose` holds. */
  async unblocked(task: Task, previousLabels: readonly string[]): Promise<void> {
    const config = await this.projects.config(task.projectKey);
    const blocking = (labels: readonly string[]) =>
      labels.some((id) => labelDefinition(config, id)?.blocks === true);
    if (!blocking(previousLabels) || blocking(task.labels)) return;
    await this.close(task.projectKey, task.key);
  }

  /** `trigger`: the subtask whose close started this, recorded on the timeline (PM-373). */
  private async close(
    projectKey: string,
    cardKey: string,
    trigger?: string,
    recovery = false,
  ): Promise<void> {
    await this.mutex.run(`${projectKey}:${cardKey}`, async () => {
      const config = await this.projects.config(projectKey);
      const task = this.ctx.repos.tasks.get(cardKey);
      if (!task || task.projectKey !== projectKey) return;
      const close = this.autoClose(config, task);
      if (!close) return;
      if (
        recovery &&
        this.ctx.repos.timeline
          .roundEvents(projectKey, cardKey)
          .some(
            (event) =>
              event.type === 'task_stage_changed' &&
              config.pipeline.stages.some((stage) => stage.kind === 'done' && stage.id === event.data.from),
          )
      )
        return;
      try {
        await this.tasks.moveToStage(projectKey, cardKey, close.to.id, SYSTEM_ACTOR, {
          expectedFrom: { stageId: task.stageId, stageEnteredAt: task.stageEnteredAt },
          partsClosed: true,
          ...(trigger ? { partsClosedTrigger: trigger } : {}),
        });
      } catch (err) {
        if (!(err instanceof DomainError) || !REFUSALS.has(err.code)) throw err;
        this.ctx.logger.warn({ err, taskKey: cardKey }, 'could not close the collecting card');
      }
    });
  }

  private autoClose(config: ProjectConfig, task: Task) {
    return collectingAutoClose(config, task, this.ctx.repos.tasks.children(task.projectKey, task.key));
  }
}
