import {
  pullSourceStage,
  stageIndex,
  startConditionImmediate,
  startConditionMarkChanges,
  startConditionOf,
} from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import { startContext } from '../../core/tasks';
import type { TaskService } from '../../core/tasks';
import { KeyedMutex } from '../../kernel';

interface Deps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'config'>;
  tasks: Pick<TaskService, 'readSchedulingTasks'>;
  onDue(projectKey: string): void;
}

/** Persistent condition timestamps shared by admission and coordination. */
export class StartConditionMarks {
  private readonly locks = new KeyedMutex();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  update(projectKey: string): Promise<ReadonlyMap<string, string>> {
    return this.locks.run(projectKey, async () => {
      const { ctx, projects, tasks } = this.deps;
      const config = await projects.config(projectKey);
      const repo = ctx.repos.startConditionMarks;
      const timer = this.timers.get(projectKey);
      if (timer) clearTimeout(timer);
      this.timers.delete(projectKey);
      const condition = startConditionOf(config);
      if (!condition) {
        repo.clearProject(projectKey);
        return new Map();
      }
      const source = pullSourceStage(config);
      const cards = source
        ? config.pipeline.stages
            .slice(0, stageIndex(config.pipeline, source.id) + 1)
            .filter((stage) => stage.kind === 'queue')
            .flatMap((stage) => tasks.readSchedulingTasks(projectKey, { kind: 'queue', stageId: stage.id }))
        : [];
      const context = startContext(tasks, projectKey, cards);
      const now = isoNow(ctx);
      repo.apply(
        projectKey,
        startConditionMarkChanges({ config, tasks: context, marks: repo.ofProject(projectKey), now }),
      );
      const marks = repo.ofProject(projectKey);
      const deadlines = cards
        .filter((task) => marks.has(task.key) && !startConditionImmediate(task, context, config))
        .map((task) => Date.parse(marks.get(task.key)!) + condition.graceMinutes * 60_000)
        .filter((due) => due > Date.parse(now));
      if (!this.disposed && deadlines.length) {
        const next = setTimeout(
          () => {
            this.timers.delete(projectKey);
            this.deps.onDue(projectKey);
          },
          Math.min(...deadlines) - Date.parse(now),
        );
        next.unref();
        this.timers.set(projectKey, next);
      }
      return marks;
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
