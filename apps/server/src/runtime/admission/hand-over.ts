import { isOnLeave, isRefinementStage, memberOf, stageIndex, stageOf, stageOwners } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig, Session, Stage, Task } from '@projectman/shared';
import { conflict, SYSTEM_ACTOR } from '../../kernel';
import type { MessageDelivery } from '../delivery';
import type { ProjectService } from '../../core/projects';
import type { SessionOrchestrator } from '../sessions';
import type { StageChange, TaskService } from '../../core/tasks';
import { actorHandle } from '../../kernel';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';

/**
 * Stage hand-over: a task entering a later stage owned by AI members (review, QA, deploy,
 * release, …), by anyone's move, gets a session for the least loaded free owner, so work does
 * not stall when a human moved the task or approved the release. The kick-off brief carries
 * the stage rules. An owner already working the task is told instead; the task's assignee never
 * takes over a later stage (no self-review). Back in the work stage, the assignee's live
 * session is told, and an AI assignee with no session is started unless it moved the card itself
 * or the fix round limit holds the card (PM-420). The same applies to an assigned card moving
 * forward into work (PM-927). A refused hand-over waits while the task stays in that stage.
 */
export class StageHandOver {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;
  private readonly delivery: MessageDelivery;
  private fixLimit: { heldFor(task: Task, config: ProjectConfig): boolean } | undefined;
  private fullTests: { holds(task: Task, config: ProjectConfig): boolean } | undefined;

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    admission: Admission;
    delivery: MessageDelivery;
  }) {
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.delivery = deps.delivery;
  }

  /** Binds the fix round limit (PM-262), which is built after the hand-over. */
  useFixLimit(fixLimit: { heldFor(task: Task, config: ProjectConfig): boolean }): void {
    this.fixLimit = fixLimit;
  }

  /** Binds the server's full test before review (PM-217), which is built after the hand-over. */
  useFullTests(fullTests: { holds(task: Task, config: ProjectConfig): boolean }): void {
    this.fullTests = fullTests;
  }

  /** Stage change listener (also the retry of a refused hand-over). */
  async handOff(change: StageChange): Promise<void> {
    await this.admission.attempt(this.startFor(change));
  }

  /** An interrupted card keeps its member and conversation, under normal stage admission. */
  async resumeInterrupted(session: Session): Promise<void> {
    if (session.lastStop?.kind !== 'server_restart' || session.workItem.type !== 'task') return;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task || task.status !== 'active') return;
    await this.admission.attempt(
      this.startFor({ task, from: task.stageId, to: task.stageId, actor: SYSTEM_ACTOR }, session.member),
    );
  }

  /**
   * A hand-over that was deferred when the server stopped, made again from what was stored;
   * null when its task is gone.
   */
  rebuild(spec: Extract<StartSpec, { kind: 'hand_over' }>): AutomaticStart | null {
    const task = this.tasks.find(spec.projectKey, spec.taskKey);
    return task
      ? this.startFor(
          { task, from: spec.from, to: spec.to, actor: spec.actor, eventId: spec.eventId },
          spec.resumeMember,
        )
      : null;
  }

  private startFor(change: StageChange, resumeMember?: string): AutomaticStart {
    const { projectKey, key: taskKey } = change.task;
    const config = this.projects.cachedConfig(projectKey);
    const stage = config && stageOf(config, change.to);
    const owners = config && stage ? stageOwners(config, stage) : [];
    let waitsFor =
      resumeMember ??
      (stage?.kind === 'work'
        ? (change.task.assignee ?? undefined)
        : owners.length === 1
          ? owners[0]
          : undefined);
    const ownsStage = (task: Task, config: ProjectConfig): boolean => {
      if (!resumeMember) return true;
      const stage = stageOf(config, task.stageId);
      return stage?.kind === 'work'
        ? task.assignee === resumeMember
        : stage?.kind === 'step' &&
            !isRefinementStage(stage) &&
            task.assignee !== resumeMember &&
            stageOwners(config, stage).includes(resumeMember);
    };
    return {
      key: resumeMember
        ? `restart-resume:${projectKey}:${taskKey}:${resumeMember}`
        : `hand-over:${projectKey}:${taskKey}`,
      projectKey,
      taskKey,
      spec: () => ({
        kind: 'hand_over',
        projectKey,
        taskKey,
        from: change.from,
        to: change.to,
        actor: change.actor,
        eventId: change.eventId,
        ...(resumeMember ? { resumeMember } : {}),
      }),
      stillValid: (task) => {
        if (!task || task.stageId !== change.to || task.status !== 'active') return false;
        const current = this.projects.cachedConfig(projectKey);
        return !resumeMember || (!!current && ownsStage(task, current));
      },
      waitsFor: () => waitsFor,
      defers: ['full_test_pending'],
      blocked: (task, config) => this.fullTests?.holds(task, config) ?? false,
      retry: async () => {
        await this.admission.attempt(this.startFor(change, resumeMember));
      },
      log: {
        deferred: 'stage hand-over deferred',
        retryFailed: 'stage hand-over retry failed',
        fields: () => ({ taskKey, stage: change.to }),
      },
      run: async () => {
        const task = this.tasks.get(projectKey, taskKey);
        if (task.stageId !== change.to || task.status !== 'active') return;
        const current: StageChange = { ...change, task };
        const config = await this.projects.config(projectKey);
        if (!ownsStage(task, config)) return;
        const stage = stageOf(config, change.to);
        if (!stage || stage.kind === 'queue' || stage.kind === 'done') return;
        // A stage for refinement has its own line: one member per step, never the whole stage's owners.
        if (isRefinementStage(stage)) return;
        if (stage.kind === 'work') {
          // A card held by its fix round limit (PM-262) tells its assignee nothing: its decider's decision does.
          if (!task.assignee || this.fixLimit?.heldFor(task, config)) return;
          const assignee = memberOf(config, task.assignee);
          const workItem = { type: 'task', taskKey } as const;
          if (this.sessions.findRunning(projectKey, task.assignee, workItem))
            return this.notify(current, stage, task.assignee);
          const wentBack = stageIndex(config.pipeline, change.to) < stageIndex(config.pipeline, change.from);
          if (assignee?.kind !== 'ai' || (!resumeMember && !wentBack && isOnLeave(assignee))) return;
          // A forward hand-over applies to the assignment at the move, not to a later assignment.
          if (!wentBack && change.task.assignee !== task.assignee) return;
          if (change.actor.kind === 'ai' && change.actor.handle === assignee.handle) return;
          waitsFor = assignee.handle;
          // The messages that waited for the start (a send-back's label message) go in its first input.
          let resumed = undefined as Session | undefined;
          await this.delivery.startAndDeliver(projectKey, assignee.handle, workItem, async (messages) => {
            const result = await this.admission.start({
              config,
              member: assignee,
              workItem,
              messages,
              cause: {
                kind: 'hand_over',
                from: change.from,
                to: change.to,
                by: change.actor,
                eventId: change.eventId,
              },
            });
            if (result.resumed) resumed = result.session;
            return result;
          });
          if (resumed) this.notify(current, stage, resumed.member);
          return;
        }
        // The reviewers wait for the server's full test of the pinned commit (PM-217).
        if (this.fullTests?.holds(task, config))
          throw conflict('full_test_pending', `task ${taskKey} waits for the full test of its commit`, {
            taskKey,
          });
        const owners = stageOwners(config, stage)
          .filter((handle) => !resumeMember || handle === resumeMember)
          .map((handle) => memberOf(config, handle))
          .filter((m): m is AiMemberConfig => m?.kind === 'ai' && m.handle !== task.assignee);
        if (owners.length === 0) return;
        const workItem = { type: 'task', taskKey } as const;
        const working = owners.find((m) => this.sessions.findRunning(projectKey, m.handle, workItem));
        if (working) return this.notify(current, stage, working.handle);
        // Members on leave are not picked; when every owner is away, admission refuses the first.
        const present = owners.filter((m) => !isOnLeave(m));
        const candidates = present.length > 0 ? present : owners;
        const free = present
          .map((member) => ({ member, load: this.admission.memberLoad(config, member.handle, taskKey) }))
          .filter(({ member, load }) => load < member.capacity)
          .sort((a, b) => a.load - b.load)[0]?.member;
        waitsFor = (free ?? (candidates.length === 1 ? candidates[0] : undefined))?.handle;
        // Nobody free: admission refuses the first owner (on leave or at capacity, unless the switch is off).
        const result = await this.admission.start({
          config,
          member: free ?? candidates[0]!,
          workItem,
          cause: {
            kind: 'hand_over',
            from: change.from,
            to: change.to,
            by: change.actor,
            eventId: change.eventId,
          },
        });
        // Resumed sessions get no brief, so tell them which stage the task is in now.
        if (result.resumed) this.notify(current, stage, result.session.member);
      },
    };
  }

  /** Tells a member's live task session that the task entered its stage, unless it moved it itself. */
  private notify(change: StageChange, stage: Stage, handle: string): void {
    if (change.actor.kind === 'ai' && change.actor.handle === handle) return;
    const { task } = change;
    const session = this.sessions.findRunning(task.projectKey, handle, { type: 'task', taskKey: task.key });
    if (!session) return;
    this.delivery.notice(
      session,
      change.actor.handle ?? 'projectman',
      `Task ${task.key} is now in stage ${stage.name} (\`${stage.id}\`). ` +
        'You own this stage: do your part by its rules; get_task shows the latest state.',
      task.key,
    );
  }
}
