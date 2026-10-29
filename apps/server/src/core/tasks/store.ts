import {
  accessOfHandle,
  canCommentOnTask,
  commentMentions,
  coverAttachmentId,
  effectiveRepo,
  FullTestErrorReason,
  isOpenTask,
  isTheme,
  LIVE_SESSION_STATES,
  memberOf,
  repoOf,
  repoRequired,
  reviewTestRunnerBeforeReview,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type {
  Actor,
  CreateTaskCommentRequest,
  ProjectConfig,
  Stage,
  Task,
  TaskReadyHold,
  TaskStartOffer,
  WorkOutage,
  TaskFixLimit,
  TaskLoop,
  TaskReviewPin,
  TaskStartWaiting,
  TimelineEvent,
} from '@projectman/shared';
import type { TaskSchedulingQuery } from '../../contracts';
import type { TaskPatch } from '../../db';
import { mergeState, mergedState } from '../../db';
import type { DomainContext } from '../base';
import { requireHuman } from '../members';
import { forbidden, invalid, notFound } from '../../kernel';
import { assertIntegratorAccess, assertOwnApproval } from '../../kernel';
import type { ProjectService } from '../projects';
import type { TimelineService } from '../timeline';

/** Why the start of AI work on a task waits (the admission's deferred starts). */
export interface StartWaitingReader {
  waitingFor(task: Task): TaskStartWaiting | undefined;
  /** Whether a deferred start of the task is under a new attempt (its wait is silent meanwhile). */
  attempting(task: Task): boolean;
  /** Runs a synchronous read of many cards with the waits of the member queue loaded once for all of them. */
  reading<T>(read: () => T): T;
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
  private readonly readyHold?: (task: Task) => TaskReadyHold | undefined;
  private readonly startOffer?: (task: Task) => TaskStartOffer | undefined;
  private readonly fixLimit: ((task: Task) => TaskFixLimit | undefined) | undefined;
  /** The rows of the cards being viewed together (`views`); null for a single card, which reads its own. */
  private reads: {
    keys: ReadonlySet<string>;
    images: Map<string, string[]>;
    covers: ReturnType<DomainContext['repos']['taskCovers']['choicesOf']>;
    merges: ReturnType<DomainContext['repos']['taskMerges']['ofTasks']>;
    handOns: ReturnType<DomainContext['repos']['taskHandOns']['ofTasks']>;
  } | null = null;

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    startWaiting: StartWaitingReader;
    outageOf?: (task: Task) => WorkOutage | undefined;
    readyHold?: (task: Task) => TaskReadyHold | undefined;
    /** The open offer to start the ready card (PM-804). */
    startOffer?: (task: Task) => TaskStartOffer | undefined;
    /** The fix round limit hold on a card (PM-262), shown on it. */
    fixLimit?: (task: Task) => TaskFixLimit | undefined;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.startWaiting = deps.startWaiting;
    this.outageOf = deps.outageOf;
    this.readyHold = deps.readyHold;
    this.startOffer = deps.startOffer;
    this.fixLimit = deps.fixLimit;
  }

  view(task: Task): Task {
    const {
      startWaiting: _,
      outage: _outage,
      readyHold: _readyHold,
      startOffer: _startOffer,
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
    // A closed card has no work to wait for: only its cover and its merge are read.
    const open = isOpenTask(task);
    const startWaiting = open ? this.startWaitingOf(task) : undefined;
    const outage = open ? this.outageOf?.(task) : undefined;
    const readyHold = open ? this.readyHold?.(task) : undefined;
    const startOffer = open ? this.startOffer?.(task) : undefined;
    const reviewPin = this.reviewPin(task);
    const cover = this.cover(task);
    const loop = this.loop(task);
    const fixLimit = open ? this.fixLimit?.(task) : undefined;
    const handoffs = this.handoffs(task);
    const reads = this.batched(task);
    const openMerge = reads
      ? reads.merges.open.get(task.key)
      : this.ctx.repos.taskMerges.open(task.projectKey, task.key);
    const lastMerge = reads
      ? reads.merges.latestMerged.get(task.key)
      : this.ctx.repos.taskMerges.latestMerged(task.projectKey, task.key);
    const merge = openMerge ? mergeState(openMerge) : undefined;
    const merged = lastMerge ? mergedState(lastMerge) : undefined;
    const record = open ? this.handOnRecord(task) : undefined;
    const handOn =
      record && open
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
      ...(readyHold ? { readyHold } : {}),
      ...(startOffer ? { startOffer } : {}),
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
    const reads = this.batched(task);
    if (reads)
      return coverAttachmentId(
        (reads.images.get(task.key) ?? []).map((id) => ({ id, preview: 'image' as const })),
        reads.covers.get(task.key),
      );
    return coverAttachmentId(
      this.ctx.repos.attachments.listReady(task.projectKey, task.key),
      this.ctx.repos.taskCovers.get(task.key)?.choice,
    );
  }

  private handOnRecord(task: Task) {
    const reads = this.batched(task);
    return reads ? reads.handOns.get(task.key) : this.ctx.repos.taskHandOns.get(task.projectKey, task.key);
  }

  /** The rows read together for `task`, while its view is one of many; a card outside that set reads its own. */
  private batched(task: Task): NonNullable<TaskStore['reads']> | null {
    return this.reads?.keys.has(task.key) ? this.reads : null;
  }

  /** The commit handed over with the task's current stage (PM-183); none once it left that stage. */
  private reviewPin(task: Task): TaskReviewPin | undefined {
    if (!isOpenTask(task)) return undefined;
    const pin = this.ctx.repos.reviewPins.get(task.key);
    if (!pin || pin.stageId !== task.stageId) return undefined;
    // The server's full test of the pinned commit (PM-217): the latest run that was not cancelled, of the
    // runner the repository's setting asks for now (PM-909); with the check off, none.
    const config = this.projects.cachedConfig(task.projectKey);
    const repo = config ? repoOf(config, effectiveRepo(config, task)) : undefined;
    const runner = repo ? reviewTestRunnerBeforeReview(repo) : undefined;
    const run =
      repo && !runner
        ? undefined
        : this.ctx.repos.fullTestRuns
            .forPin(pin, runner ? { runner } : undefined)
            .find((r) => r.status !== 'cancelled');
    let fullTest: TaskReviewPin['fullTest'];
    if (run && run.status !== 'cancelled') {
      const reason = FullTestErrorReason.safeParse(run.reason);
      fullTest = {
        status: run.status,
        at: run.finishedAt ?? run.startedAt ?? run.createdAt,
        ...(run.status === 'error' && reason.success ? { reason: reason.data } : {}),
        runner: run.runner,
        ...(run.externalUrl ? { externalUrl: run.externalUrl } : {}),
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

  /** Why the start of AI work on a raw card waits: a deferred start, else the missing repository choice (PM-455). */
  startWaitingOf(task: Task): TaskStartWaiting | undefined {
    return this.startWaiting.waitingFor(task) ?? this.repoWaiting(task);
  }

  /** Whether the system is trying a deferred start of the card right now: its wait reads empty meanwhile. */
  startAttempting(task: Task): boolean {
    return this.startWaiting.attempting(task);
  }

  /** Every card of the project, closed ones too. */
  list(projectKey: string): Task[] {
    return this.views(this.ctx.repos.tasks.list(projectKey));
  }

  /** The cards a scheduling query selects (an open card read, a `list_tasks` page), as `get` shows them. */
  listQuery(projectKey: string, query: TaskSchedulingQuery): Task[] {
    return this.views(this.ctx.repos.tasks.readScheduling(projectKey, query));
  }

  /**
   * The views of many cards, with the member queue's waits and the rows of the cards' own parts (cover, merge,
   * hand-on) read once for all of them: the reads do not grow with the cards, closed ones included (PM-1109).
   */
  private views(tasks: Task[]): Task[] {
    const keys = tasks.map((task) => task.key);
    const { repos } = this.ctx;
    this.reads = {
      keys: new Set(keys),
      images: repos.attachments.readyImagesOf(keys),
      covers: repos.taskCovers.choicesOf(keys),
      merges: repos.taskMerges.ofTasks(keys),
      handOns: repos.taskHandOns.ofTasks(tasks.filter(isOpenTask).map((task) => task.key)),
    };
    try {
      return this.startWaiting.reading(() => tasks.map((task) => this.view(task)));
    } finally {
      this.reads = null;
    }
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
    const next = { ...task, ...Object.fromEntries(written) };
    if (patch.complexity === null) delete next.complexity;
    return next;
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
    assertIntegratorAccess(config, 'write', actor);
    // The author's current access counts, not the one the request was authorized with.
    const authorAccess = actor.kind === 'human' ? accessOfHandle(config, actor.handle) : undefined;
    if (authorAccess !== undefined && !canCommentOnTask(authorAccess))
      throw forbidden('insufficient_access', 'read-only members cannot comment');
    if (imported.importedAuthor !== undefined || imported.importedAt !== undefined) {
      assertOwnApproval(actor);
      requireHuman(config, actor, 'owner', { message: 'imported comments require owner access' });
    }
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
    if (isImported) assertOwnApproval(actor);
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
