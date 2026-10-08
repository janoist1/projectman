import { evaluateStart, stageOf } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { DomainError } from '../errors';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { StageChange, TaskService } from '../tasks';
import { SYSTEM_AUTHOR } from '../util';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';
import type { LabelWait, LabelWaitRequest, SeniorWait, SeniorWaitRequest, TaskStarts } from './task-starts';

type WorkStartSpec = Extract<StartSpec, { kind: 'work_start' }>;

/**
 * Work start (PM-119): an active card moved into a work stage without an assignee starts like the
 * Start button starts it (`TaskStarts.startLocked`: the same developer choice, temp worker,
 * admission checks and session start). Nobody free waits (`no_free_member`, and the refusals every
 * automatic start waits for) in the deferred-start store, so the wait survives a restart; the
 * retry loop and the events that free capacity start it later. A card that has an assignee keeps
 * the stage hand-over instead (it tells the assignee's session, and starts an AI assignee that has
 * none when the card was sent back, PM-420), and while AI work is switched off a move creates no
 * start at all: the switch coming back on does not start what was moved meanwhile. Only a card
 * still in the stage it was moved into, still without an assignee other than the one this start
 * assigned itself, is started: a move, a closure, someone's assignment or the Start button ends the
 * wait. A missing repository is not waited for (`repo_required`; the card shows it, see `TaskStore`).
 * A card recommended for the Senior waits for one the same way (`senior_busy`, PM-348): the start is
 * deferred while every Senior is busy, and `SeniorWaits` asks the owners after the wait limit.
 */
export class WorkStarts implements LabelWait, SeniorWait {
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

  /**
   * PM-236: the person's Start on a card that lacks labels an AI member sets started that member;
   * the developer's start waits, as a work start, until the gate lets the card through
   * (`LabelWait`, under the admission lock). A repeated Start keeps the waiting one.
   */
  awaitLabels(wait: LabelWaitRequest): void {
    const { projectKey, taskKey } = wait;
    const task = this.tasks.find(projectKey, taskKey);
    const existing = this.pending.get(keyOf(projectKey, taskKey));
    if (task && existing?.stillValid(task) && this.admission.isWaiting(existing)) return;
    const start = this.startFor({
      kind: 'work_start',
      projectKey,
      taskKey,
      from: wait.from,
      to: wait.to,
      actor: wait.actor,
      afterLabels: true,
      ...(wait.assignee ? { assignee: wait.assignee } : {}),
      ...(wait.developer ? { developer: wait.developer } : {}),
      ...(wait.despitePrerequisites ? { despitePrerequisites: true } : {}),
    });
    this.admission.defer(start, { reason: 'label_missing', labels: wait.labels, member: wait.member });
  }

  /**
   * PM-348: the person's Start on a card recommended for the Senior, with every Senior busy, leaves
   * the card in the work stage without an assignee and keeps its start as a work start that waits
   * (`SeniorWait`, under the admission lock). The stage move's own `begin` may have made a start
   * for the card too: both use the same key, so the deferral that is stored replaces the other and
   * keeps when the wait began.
   */
  awaitSenior(wait: SeniorWaitRequest): void {
    const start = this.startFor({
      kind: 'work_start',
      projectKey: wait.projectKey,
      taskKey: wait.taskKey,
      from: wait.from,
      to: wait.to,
      actor: wait.actor,
      ...(wait.despitePrerequisites ? { despitePrerequisites: true } : {}),
    });
    this.admission.defer(start, {
      reason: 'senior_busy',
      seniors: wait.seniors,
      ...(wait.waitDecidedBy ? { waitDecidedBy: wait.waitDecidedBy } : {}),
    });
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
      // Waiting for labels (PM-236), the card is still where the person started it.
      (task.stageId === to || (spec.afterLabels === true && task.stageId === spec.from)) &&
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
      defers: ['no_free_member', 'prerequisite_open', 'senior_busy'],
      // Still short of a label the gate asks for: the card does not start yet.
      blocked: (task, config) => task.stageId !== to && evaluateStart(task, config, to).unmet.length > 0,
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
          automatic: true,
          assignee: spec.developer,
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
