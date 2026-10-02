import { stageOf } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { DomainError } from '../errors';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { StageChange, TaskService } from '../tasks';
import { SYSTEM_AUTHOR } from '../util';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';
import type { TaskStarts } from './task-starts';

type WorkStartSpec = Extract<StartSpec, { kind: 'work_start' }>;

/**
 * Work start (PM-119): an active card moved into a work stage without an assignee starts like the
 * Start button starts it (`TaskStarts.startLocked`: the same developer choice, temp worker,
 * admission checks and session start). Nobody free waits (`no_free_member`, and the refusals every
 * automatic start waits for) in the deferred-start store, so the wait survives a restart; the
 * retry loop and the events that free capacity start it later. A card that has an assignee keeps
 * the stage hand-over's notification instead, and while AI work is switched off a move creates no
 * start at all: the switch coming back on does not start what was moved meanwhile. Only a card
 * still in the stage it was moved into, still without an assignee other than the one this start
 * assigned itself, is started: a move, a closure, someone's assignment or the Start button ends the
 * wait. A missing repository is not waited for (`repo_required`; the card shows it, see `TaskStore`).
 */
export class WorkStarts {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;
  private readonly starts: TaskStarts;
  /** The start of each card that is running or waiting: a repeated move event does not replace it. */
  private readonly pending = new Map<string, AutomaticStart>();
  /** The starts with an attempt under way (their deferral is out of the store meanwhile). */
  private readonly running = new Set<AutomaticStart>();

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    admission: Admission;
    starts: TaskStarts;
  }) {
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.starts = deps.starts;
  }

  /** Stage change listener. */
  async begin(change: StageChange): Promise<void> {
    const { projectKey, key: taskKey } = change.task;
    const task = this.tasks.find(projectKey, taskKey);
    if (!task || task.status !== 'active' || task.stageId !== change.to || task.assignee) return;
    const config = await this.projects.config(projectKey);
    if (stageOf(config, change.to)?.kind !== 'work' || !config.team.limits.aiEnabled) return;
    const key = keyOf(projectKey, taskKey);
    // A start that runs or waits (stored) carries on; one the store dropped is replaced.
    const existing = this.pending.get(key);
    if (existing?.stillValid(task) && (this.running.has(existing) || this.admission.isWaiting(existing)))
      return;
    const start = this.startFor({
      kind: 'work_start',
      projectKey,
      taskKey,
      from: change.from,
      to: change.to,
      actor: change.actor,
      ...(change.despitePrerequisites ? { despitePrerequisites: true } : {}),
    });
    try {
      await this.attempt(start);
    } catch (err) {
      // The card shows that it needs a repository; nothing but a person's choice helps.
      if (err instanceof DomainError && err.code === 'repo_required') return;
      throw err;
    }
  }

  /** A start deferred when the server stopped, made again from what was stored; null when its task is gone. */
  rebuild(spec: WorkStartSpec): AutomaticStart | null {
    return this.tasks.find(spec.projectKey, spec.taskKey) ? this.startFor(spec) : null;
  }

  private startFor(spec: WorkStartSpec): AutomaticStart {
    const { projectKey, taskKey, to, actor } = spec;
    const key = keyOf(projectKey, taskKey);
    let assigned = spec.assignee;
    let waitsFor: string | undefined;
    const workItem = { type: 'task', taskKey } as const;
    const stillValid = (task: Task | null): boolean =>
      task !== null &&
      task.status === 'active' &&
      task.stageId === to &&
      (task.assignee === null ||
        (assigned !== undefined &&
          task.assignee === assigned &&
          !this.sessions.findRunning(projectKey, assigned, workItem)));
    const start: AutomaticStart = {
      key,
      projectKey,
      taskKey,
      spec: () => ({ ...spec, assignee: assigned }),
      stillValid,
      waitsFor: () => waitsFor,
      // A card with an open prerequisite waits for the last one to close (PM-204).
      defers: ['no_free_member', 'prerequisite_open'],
      retry: () => this.attempt(start),
      log: {
        deferred: 'work start deferred',
        retryFailed: 'work start retry failed',
        fields: () => ({ taskKey, stage: to }),
      },
      run: async () => {
        waitsFor = undefined;
        const task = this.tasks.find(projectKey, taskKey);
        if (!stillValid(task)) return;
        const config = await this.projects.config(projectKey);
        if (stageOf(config, to)?.kind !== 'work') return;
        await this.starts.startLocked(projectKey, taskKey, {
          actor,
          author: SYSTEM_AUTHOR,
          stillWanted: stillValid,
          despitePrerequisites: spec.despitePrerequisites,
          onChosen: (member) => {
            waitsFor = member?.handle;
          },
          // Only an assignment this start made is its own: the next try carries on with that one.
          onAssigned: (handle) => {
            assigned = handle;
          },
        });
      },
    };
    this.pending.set(key, start);
    return start;
  }

  private async attempt(start: AutomaticStart): Promise<void> {
    this.running.add(start);
    try {
      await this.admission.attempt(start);
    } finally {
      this.running.delete(start);
      // Settled for good (started, or no longer applies) unless it waits again.
      if (!this.admission.isWaiting(start) && this.pending.get(start.key) === start)
        this.pending.delete(start.key);
    }
  }
}

function keyOf(projectKey: string, taskKey: string): string {
  return `work-start:${projectKey}:${taskKey}`;
}
