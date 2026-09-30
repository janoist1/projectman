import { memberOf, stageOf, stageOwners } from '@projectman/shared';
import type { AiMemberConfig, Stage } from '@projectman/shared';
import type { MessageDelivery } from '../messaging';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { StageChange, TaskService } from '../tasks';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';

/**
 * Stage hand-over: a task entering a later stage owned by AI members (review, QA, deploy,
 * release, …), by anyone's move, gets a session for the least loaded free owner, so work does
 * not stall when a human moved the task or approved the release. The kick-off brief carries
 * the stage rules. An owner already working the task is told instead; the task's assignee never
 * takes over a later stage (no self-review). Back in the work stage, the assignee's live
 * session is told (starting work again goes through task starts). A refused hand-over waits
 * and is retried while the task stays in that stage.
 */
export class StageHandOver {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;
  private readonly delivery: MessageDelivery;

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

  /** Stage change listener (also the retry of a refused hand-over). */
  async handOff(change: StageChange): Promise<void> {
    await this.admission.attempt(this.startFor(change));
  }

  /**
   * A hand-over that was deferred when the server stopped, made again from what was stored;
   * null when its task is gone.
   */
  rebuild(spec: Extract<StartSpec, { kind: 'hand_over' }>): AutomaticStart | null {
    const task = this.tasks.find(spec.projectKey, spec.taskKey);
    return task ? this.startFor({ task, from: spec.from, to: spec.to, actor: spec.actor }) : null;
  }

  private startFor(change: StageChange): AutomaticStart {
    const { projectKey, key: taskKey } = change.task;
    let waitsFor: string | undefined;
    return {
      key: `hand-over:${projectKey}:${taskKey}`,
      projectKey,
      taskKey,
      spec: () => ({
        kind: 'hand_over',
        projectKey,
        taskKey,
        from: change.from,
        to: change.to,
        actor: change.actor,
      }),
      stillValid: (task) => task !== null && task.stageId === change.to && task.status === 'active',
      waitsFor: () => waitsFor,
      retry: () => this.handOff(change),
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
        const stage = stageOf(config, change.to);
        if (!stage || stage.kind === 'queue' || stage.kind === 'done') return;
        if (stage.kind === 'work') {
          if (task.assignee) this.notify(current, stage, task.assignee);
          return;
        }
        const owners = stageOwners(config, stage)
          .map((handle) => memberOf(config, handle))
          .filter((m): m is AiMemberConfig => m?.kind === 'ai' && m.handle !== task.assignee);
        if (owners.length === 0) return;
        const workItem = { type: 'task', taskKey } as const;
        const working = owners.find((m) => this.sessions.findRunning(projectKey, m.handle, workItem));
        if (working) return this.notify(current, stage, working.handle);
        const free = owners
          .map((member) => ({ member, load: this.admission.memberLoad(projectKey, member.handle, taskKey) }))
          .filter(({ member, load }) => load < member.capacity)
          .sort((a, b) => a.load - b.load)[0]?.member;
        waitsFor = (free ?? (owners.length === 1 ? owners[0] : undefined))?.handle;
        // Nobody free: admission refuses the first owner (at capacity, unless the switch is off).
        const result = await this.admission.start({ config, member: free ?? owners[0]!, workItem });
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
