import {
  developmentStage,
  planStarts,
  pullSourceStage,
  seniorsOf,
  stageOwners,
  startableCards,
} from '@projectman/shared';
import type { Task, TaskReadyHold } from '@projectman/shared';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { startContext } from '../../core/tasks';
import type { ProjectFocusService, TaskService } from '../../core/tasks';
import type { Admission, StartRounding } from './admission';
import type { SeniorWaits } from './senior-waits';

interface ProjectRound {
  sourceStageId: string;
  frame: TaskReadyHold | null;
  holds: Map<string, TaskReadyHold>;
}

interface StartRoundDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'config'>;
  tasks: Pick<TaskService, 'readSchedulingTasks'>;
  focus: Pick<ProjectFocusService, 'covered'>;
  seniorWaits: Pick<SeniorWaits, 'decisionFor'>;
  admission: Pick<Admission, 'freeDevelopers' | 'startFrame' | 'engineOffline'>;
}

/** Computes intentional queue waits after the focus pull, without starting or messaging anyone. */
export class StartRound implements StartRounding {
  private readonly states = new Map<string, ProjectRound>();
  private active: Promise<void> | null = null;
  private readonly deps: StartRoundDeps;

  constructor(deps: StartRoundDeps) {
    this.deps = deps;
  }

  run(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.round().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  holdOf(task: Task): TaskReadyHold | undefined {
    const state = this.states.get(task.projectKey);
    if (!state || task.stageId !== state.sourceStageId || task.status !== 'active' || task.assignee)
      return undefined;
    return state.frame ?? state.holds.get(task.key);
  }

  private async round(): Promise<void> {
    const { ctx } = this.deps;
    const projects = ctx.repos.projects.list();
    const keys = new Set(projects.map(({ key }) => key));
    for (const key of this.states.keys()) if (!keys.has(key)) this.states.delete(key);
    for (const { key } of projects) {
      try {
        await this.forProject(key);
      } catch (err) {
        this.states.delete(key);
        ctx.logger.warn({ err, projectKey: key }, 'start round failed for a project');
      }
    }
  }

  private async forProject(key: string): Promise<void> {
    const { ctx, projects, tasks, focus, seniorWaits, admission } = this.deps;
    const config = await projects.config(key).catch(() => null);
    const source = config && pullSourceStage(config);
    const development = config && developmentStage(config);
    if (!config || !source || !development) {
      this.states.delete(key);
      return;
    }
    const previous = this.states.get(key);
    const old = previous?.sourceStageId === source.id ? previous : undefined;
    const since = isoNow(ctx);
    const keepSince = (hold: TaskReadyHold, prior?: TaskReadyHold | null): TaskReadyHold => ({
      ...hold,
      since: prior?.reason === hold.reason ? prior.since : since,
    });
    const state: ProjectRound = { sourceStageId: source.id, frame: null, holds: new Map() };
    const frame = (hold: TaskReadyHold) => {
      state.frame = keepSince(hold, old?.frame);
      this.states.set(key, state);
    };
    const reason = admission.startFrame(config);
    if (reason) {
      frame({ reason, since });
      return;
    }
    const available = admission.freeDevelopers(config, development.id);
    if (available.length === 0) {
      frame({ reason: 'no_free_member', since });
      return;
    }
    const offline = available.map((member) => admission.engineOffline(key, member.handle));
    const free = available.filter((_member, index) => offline[index] === null);
    if (free.length === 0) {
      const engines = new Set(offline.flatMap((entry) => (entry?.engine ? [entry.engine] : [])));
      const engine = engines.size === 1 ? [...engines][0] : undefined;
      frame({ reason: 'engine_offline', since, ...(engine ? { engine } : {}) });
      return;
    }
    const queued = tasks.readSchedulingTasks(key, { kind: 'queue', stageId: source.id });
    const cards = startableCards({
      config,
      tasks: startContext(tasks, key, queued),
      fromStageId: source.id,
      toStageId: development.id,
    });
    const owners = stageOwners(config, development);
    const seniors = seniorsOf(config, development)
      .map((member) => member.handle)
      .filter((handle) => owners.includes(handle));
    const anyDecided = new Set(
      cards
        .filter((card) => seniorWaits.decisionFor(key, card.key)?.decision === 'any')
        .map((card) => card.key),
    );
    const plan = planStarts({ cards, places: focus.covered(key).places, free, seniors, anyDecided });
    for (const [taskKey, entry] of plan) {
      if (entry.kind !== 'hold') continue;
      const { kind: _kind, ...hold } = entry;
      state.holds.set(taskKey, keepSince({ ...hold, since }, old?.frame ?? old?.holds.get(taskKey)));
    }
    this.states.set(key, state);
  }
}
