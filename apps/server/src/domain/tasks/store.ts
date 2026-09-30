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
import type { TaskPatch } from '../../db';
import type { DomainContext } from '../context';
import { requireHuman } from '../access';
import { invalid, notFound } from '../errors';
import type { ProjectService } from '../projects';
import type { TimelineService } from '../timeline';

export type LabelNotifier = (task: Task, labels: string[], actor: Actor, comment?: string) => Promise<void>;
export type NoteNotifier = (event: TimelineEvent, mentions: string[]) => Promise<void>;

/** Work that follows a committed unit of work: notifications and listeners. */
export type Effect = () => Promise<void>;

export async function runEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) await effect();
}

/**
 * What the parts of the task service share: reading tasks as clients see them, writing and
 * publishing them, recording notes, and the notifiers the composition root wires to team
 * messages. Writes happen inside a unit of work on a task read in that same unit, so no
 * concurrent change is lost; the notifications they cause run after it committed.
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

  /** Writes the changed fields of `task` (read in the same unit of work) and returns it as written. */
  write(task: Task, patch: TaskPatch): Task {
    this.ctx.repos.tasks.update(task.id, patch);
    const written = Object.entries(patch).filter(([, value]) => value !== undefined);
    return { ...task, ...Object.fromEntries(written) };
  }

  publish(task: Task): void {
    this.ctx.bus.publish({ type: 'task_upserted', projectKey: task.projectKey, task: this.view(task) });
  }

  /** Adds a comment to the task's timeline; the members it mentions get it as a message. */
  async addNote(
    projectKey: string,
    taskKey: string,
    text: string,
    actor: Actor,
    sessionId: string | null = null,
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): Promise<TimelineEvent> {
    const task = this.get(projectKey, taskKey);
    const config = await this.projects.config(projectKey);
    if (imported.importedAuthor !== undefined || imported.importedAt !== undefined)
      requireHuman(config, actor, 'owner', { message: 'imported comments require owner access' });
    const effects: Effect[] = [];
    const event = this.recordNote(config, task, text, actor, sessionId, effects, imported);
    await runEffects(effects);
    return event;
  }

  /** Records a comment; notifying the members it mentions is added to `effects`. */
  recordNote(
    config: ProjectConfig,
    task: Task,
    text: string,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): TimelineEvent {
    const isImported = imported.importedAuthor !== undefined || imported.importedAt !== undefined;
    const mentions = commentMentions(
      text,
      config.team.members.map((member) => member.handle),
      actor.handle,
    );
    const event = this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      sessionId,
      actor,
      type: 'task_note',
      data: { text, mentions, ...imported },
    });
    if (!isImported && mentions.length)
      effects.push(async () => {
        await this.noteNotifier?.(event, mentions);
      });
    return event;
  }
}

/** The stage with this id, or 400 unknown_stage. */
export function requireStage(config: ProjectConfig, stageId: string): Stage {
  const stage = stageOf(config, stageId);
  if (!stage) throw invalid('unknown_stage', `unknown stage: ${stageId}`);
  return stage;
}
