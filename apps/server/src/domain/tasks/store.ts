import {
  commentMentions,
  coverAttachmentId,
  FullTestErrorReason,
  isOpenTask,
  isTheme,
  memberOf,
  repoRequired,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  CreateTaskCommentRequest,
  ProjectConfig,
  Stage,
  Task,
  WorkOutage,
  TaskFixLimit,
  TaskLoop,
  TaskReviewPin,
  TaskStartWaiting,
  TimelineEvent,
} from '@projectman/shared';
import type { TaskPatch } from '../../db';
import { mergeState, mergedState } from '../../db';
import type { DomainContext } from '../context';
import { requireHuman } from '../access';
import { invalid, notFound } from '../errors';
import type { ProjectService } from '../projects';
import { LIVE_SESSION_STATES } from '../sessions';
import type { TimelineService } from '../timeline';

/** Why the start of AI work on a task waits (the admission's deferred starts). */
export interface StartWaitingReader {
  waitingFor(task: Task): TaskStartWaiting | undefined;
}

/** Work that follows a committed unit of work: notifications and listeners. */
export type Effect = () => Promise<void>;

export async function runEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) await effect();
}

/**
 * What the parts of the task service share: reading tasks as clients see them (with why their
 * AI work waits), writing and publishing them, and recording notes. Writes happen inside a unit
 * of work on a task read in that same unit, so no concurrent change is lost; the domain events
 * they cause are emitted after it committed.
 */
export class TaskStore {
  readonly ctx: DomainContext;
  readonly timeline: TimelineService;
  readonly projects: ProjectService;
  private readonly startWaiting: StartWaitingReader;
  private readonly outageOf?: (task: Task) => WorkOutage | undefined;
  private readonly fixLimit: ((task: Task) => TaskFixLimit | undefined) | undefined;

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    startWaiting: StartWaitingReader;
    outageOf?: (task: Task) => WorkOutage | undefined;
    /** The fix round limit hold on a card (PM-262), shown on it. */
    fixLimit?: (task: Task) => TaskFixLimit | undefined;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.startWaiting = deps.startWaiting;
    this.outageOf = deps.outageOf;
    this.fixLimit = deps.fixLimit;
  }

  view(task: Task): Task {
    const {
      startWaiting: _,
      outage: _outage,
      reviewPin: __,
      coverAttachmentId: ___,
      loop: ____,
      fixLimit: _____,
      handoff: ______,
      lastHandoff: _______,
      merge: _merge,
      merged: _merged,
      handOn: ________,
      ...rest
    } = task;
    const startWaiting = this.startWaiting.waitingFor(task) ?? this.repoWaiting(task);
    const outage = this.outageOf?.(task);
    const reviewPin = this.reviewPin(task);
    const cover = this.cover(task);
    const loop = this.loop(task);
    const fixLimit = this.fixLimit?.(task);
    const handoffs = this.handoffs(task);
    const openMerge = this.ctx.repos.taskMerges.open(task.projectKey, task.key);
    const lastMerge = this.ctx.repos.taskMerges.latestMerged(task.projectKey, task.key);
    const merge = openMerge ? mergeState(openMerge) : undefined;
    const merged = lastMerge ? mergedState(lastMerge) : undefined;
    const record = this.ctx.repos.taskHandOns.get(task.projectKey, task.key);
    const handOn =
      record && isOpenTask(task)
        ? {
            fromStageId: record.fromStageId,
            toStageId: record.toStageId,
            mover: record.mover,
            requestedBy: record.requestedBy,
            requestedAt: record.requestedAt,
            inboxItemId: record.inboxItemId,
          }
        : undefined;
    return {
      ...rest,
      ...(startWaiting ? { startWaiting } : {}),
      ...(outage ? { outage } : {}),
      ...(reviewPin ? { reviewPin } : {}),
      ...(cover ? { coverAttachmentId: cover } : {}),
      ...(loop ? { loop } : {}),
      ...(fixLimit ? { fixLimit } : {}),
      ...handoffs,
      ...(merge ? { merge } : {}),
      ...(merged ? { merged } : {}),
      ...(handOn ? { handOn } : {}),
    };
  }

  /**
   * The handoff open on the card (PM-342) and, while the card is still with its receiver, the latest closed
   * one; none once the card closed.
   */
  private handoffs(task: Task): Pick<Task, 'handoff' | 'lastHandoff'> {
    if (!isOpenTask(task) || isTheme(task)) return {};
    const open = this.ctx.repos.taskHandoffs.open(task.key);
    if (open)
      return {
        handoff: {
          id: open.id,
          from: open.from,
          to: open.to,
          fromProvider: open.fromProvider,
          toProvider: open.toProvider,
          reason: open.reason,
          step: open.step,
          ...(open.fallbackReason ? { fallbackReason: open.fallbackReason } : {}),
          startedAt: open.startedAt,
          deadlineAt: open.deadlineAt,
        },
      };
    const last = this.ctx.repos.taskHandoffs.latestClosed(task.key);
    if (!last || !last.endedAt || last.to === null || last.to !== task.assignee) return {};
    return {
      lastHandoff: {
        id: last.id,
        from: last.from,
        to: last.to,
        fromProvider: last.fromProvider,
        toProvider: last.toProvider,
        outcome: last.outcome === 'note' ? 'note' : 'fallback',
        ...(last.fallbackReason ? { fallbackReason: last.fallbackReason } : {}),
        endedAt: last.endedAt,
      },
    };
  }

  /** The loop open on the card (PM-261), for the board; none once the card closed. */
  private loop(task: Task): TaskLoop | undefined {
    if (!isOpenTask(task) || isTheme(task)) return undefined;
    const loop = this.ctx.repos.taskLoops.open(task.key);
    if (!loop) return undefined;
    return {
      id: loop.id,
      members: loop.members,
      count: loop.count,
      startedAt: loop.startedAt,
      lastMessageAt: loop.lastMessageAt,
      notified: loop.notified,
      phase: loop.phase,
      ownerReason: loop.ownerReason,
      deciders: loop.deciders,
      letRunBy: loop.letRunBy,
    };
  }

  /** The card's cover (PM-195, PM-224): the chosen image, else its first image; none when hidden or without an image. */
  private cover(task: Task): string | null {
    return coverAttachmentId(
      this.ctx.repos.attachments.listReady(task.projectKey, task.key),
      this.ctx.repos.taskCovers.get(task.key)?.choice,
    );
  }

  /** The commit handed over with the task's current stage (PM-183); none once it left that stage. */
  private reviewPin(task: Task): TaskReviewPin | undefined {
    if (!isOpenTask(task)) return undefined;
    const pin = this.ctx.repos.reviewPins.get(task.key);
    if (!pin || pin.stageId !== task.stageId) return undefined;
    // The server's full test of the pinned commit (PM-217): the latest run that was not cancelled.
    const run = this.ctx.repos.fullTestRuns.forPin(pin).find((r) => r.status !== 'cancelled');
    let fullTest: TaskReviewPin['fullTest'];
    if (run && run.status !== 'cancelled') {
      const reason = FullTestErrorReason.safeParse(run.reason);
      fullTest = {
        status: run.status,
        at: run.finishedAt ?? run.startedAt ?? run.createdAt,
        ...(run.status === 'error' && reason.success ? { reason: reason.data } : {}),
      };
    }
    return {
      commit: pin.commit,
      branch: pin.branch,
      pinnedAt: pin.pinnedAt,
      ...(fullTest ? { fullTest } : {}),
    };
  }

  /**
   * The task's AI developer cannot start until a person chooses the task's repository (`repo_required`:
   * the project has several repositories and the task names none). Unlike a deferred start this does
   * not wait for a retry, so it follows from the task itself: a task in a work stage whose assignee is
   * an AI member of a role that changes files and has no session running (a session that is running,
   * for example one from before the repository was cleared, is not waiting). Without an assignee
   * (PM-119: the card was moved there and its automatic start was refused), the same holds when every
   * owner of the stage is such an AI member: nobody could start on it.
   */
  private repoWaiting(task: Task): TaskStartWaiting | undefined {
    if (!isOpenTask(task) || isTheme(task)) return undefined;
    const config = this.projects.cachedConfig(task.projectKey);
    const stage = config ? stageOf(config, task.stageId) : undefined;
    if (!config || stage?.kind !== 'work') return undefined;
    if (!task.assignee) {
      const owners = stageOwners(config, stage).map((handle) => memberOf(config, handle));
      const blocked =
        owners.length > 0 && owners.every((m) => m?.kind === 'ai' && repoRequired(config, m.role, task));
      return blocked ? { reason: 'repo_required', since: task.updatedAt } : undefined;
    }
    const assignee = memberOf(config, task.assignee);
    if (assignee?.kind !== 'ai' || !repoRequired(config, assignee.role, task)) return undefined;
    const running = this.ctx.repos.sessions
      .list(task.projectKey, { taskKey: task.key, member: assignee.handle })
      .some((session) => LIVE_SESSION_STATES.includes(session.state));
    return running ? undefined : { reason: 'repo_required', member: assignee.handle, since: task.updatedAt };
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
      effects.push(() => this.ctx.events.emit('task_note_added', { event, mentions }));
    return event;
  }
}

/** The stage with this id, or 400 unknown_stage. */
export function requireStage(config: ProjectConfig, stageId: string): Stage {
  const stage = stageOf(config, stageId);
  if (!stage) throw invalid('unknown_stage', `unknown stage: ${stageId}`);
  return stage;
}
