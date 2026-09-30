import { commentMentions, stageOf } from '@projectman/shared';
import type {
  Actor,
  CreateTaskCommentRequest,
  ProjectConfig,
  Stage,
  Task,
  TaskStartWaiting,
  TimelineEvent,
} from '@projectman/shared';
import type { DomainContext } from '../context';
import { forbidden, invalid, notFound } from '../errors';
import type { ProjectService } from '../projects';
import type { TimelineService } from '../timeline';

export type LabelNotifier = (task: Task, labels: string[], actor: Actor, comment?: string) => Promise<void>;
export type NoteNotifier = (event: TimelineEvent, mentions: string[]) => Promise<void>;

/**
 * What the parts of the task service share: reading tasks as clients see them, publishing
 * them, recording notes, and the notifiers the composition root wires to team messages.
 */
export class TaskStore {
  readonly ctx: DomainContext;
  readonly timeline: TimelineService;
  readonly projects: ProjectService;
  startWaitingReader: (task: Task) => TaskStartWaiting | undefined = () => undefined;
  labelNotifier?: LabelNotifier;
  noteNotifier?: NoteNotifier;

  constructor(deps: { ctx: DomainContext; timeline: TimelineService; projects: ProjectService }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
  }

  view(task: Task): Task {
    const { startWaiting: _, ...rest } = task;
    const startWaiting = this.startWaitingReader(task);
    return startWaiting ? { ...rest, startWaiting } : rest;
  }

  list(projectKey: string): Task[] {
    return this.ctx.repos.tasks.list(projectKey).map((task) => this.view(task));
  }

  get(projectKey: string, taskKey: string): Task {
    const task = this.ctx.repos.tasks.get(taskKey);
    if (!task || task.projectKey !== projectKey) throw notFound('task', taskKey);
    return this.view(task);
  }

  find(projectKey: string, taskKey: string): Task | null {
    const task = this.ctx.repos.tasks.get(taskKey);
    return task && task.projectKey === projectKey ? this.view(task) : null;
  }

  publish(task: Task): void {
    this.ctx.bus.publish({ type: 'task_upserted', projectKey: task.projectKey, task: this.view(task) });
  }

  async addNote(
    projectKey: string,
    taskKey: string,
    text: string,
    actor: Actor,
    sessionId: string | null = null,
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): Promise<TimelineEvent> {
    this.get(projectKey, taskKey);
    const config = await this.projects.config(projectKey);
    const isImported = imported.importedAuthor !== undefined || imported.importedAt !== undefined;
    if (
      isImported &&
      !config.team.members.some(
        (member) =>
          member.handle === actor.handle &&
          member.kind === 'human' &&
          member.access === 'owner' &&
          actor.kind === 'human',
      )
    )
      throw forbidden('insufficient_access', 'imported comments require owner access');
    const mentions = commentMentions(
      text,
      config.team.members.map((member) => member.handle),
      actor.handle,
    );
    const event = this.timeline.append({
      projectKey,
      taskKey,
      sessionId,
      actor,
      type: 'task_note',
      data: { text, mentions, ...imported },
    });
    if (!isImported && mentions.length) await this.noteNotifier?.(event, mentions);
    return event;
  }
}

/** The stage with this id, or 400 unknown_stage. */
export function requireStage(config: ProjectConfig, stageId: string): Stage {
  const stage = stageOf(config, stageId);
  if (!stage) throw invalid('unknown_stage', `unknown stage: ${stageId}`);
  return stage;
}
