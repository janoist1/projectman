import { stageIndex } from '../config/gates';
import type { ProjectConfig, StartCondition } from '../config/schema';
import { effectivePriority, PRIORITY_RANK, pullSourceStage } from './start-order';
import { isOpenTask } from './task';
import type { Task } from './task';

type ConditionCard = Pick<
  Task,
  'key' | 'kind' | 'status' | 'archivedAt' | 'stageId' | 'priority' | 'parentKey' | 'themeKey' | 'labels'
>;

export const startConditionOf = (config: ProjectConfig): StartCondition | null =>
  config.team.startCondition ?? null;

export function startConditionTracked(task: ConditionCard, config: ProjectConfig): boolean {
  const source = pullSourceStage(config);
  const index = stageIndex(config.pipeline, task.stageId);
  return (
    !!startConditionOf(config) &&
    task.status === 'active' &&
    !task.archivedAt &&
    task.kind !== 'theme' &&
    !!source &&
    index >= 0 &&
    index <= stageIndex(config.pipeline, source.id) &&
    config.pipeline.stages[index]?.kind === 'queue'
  );
}

function inheritedLabels(task: ConditionCard, tasks: readonly ConditionCard[]): string[] {
  const parent = tasks.find((card) => card.key === task.parentKey);
  const theme = tasks.find((card) => card.key === (task.themeKey ?? parent?.themeKey));
  return [
    task,
    ...[parent, theme].filter(
      (card): card is ConditionCard => !!card && isOpenTask(card) && !card.archivedAt,
    ),
  ].flatMap((card) => card.labels);
}

export function startConditionHeld(
  task: ConditionCard,
  tasks: readonly ConditionCard[],
  config: ProjectConfig,
): boolean {
  const labels = inheritedLabels(task, tasks);
  return !!startConditionOf(config)?.hold.some((id) => labels.includes(id));
}

export function startConditionHolds(
  task: ConditionCard,
  tasks: readonly ConditionCard[],
  config: ProjectConfig,
): boolean {
  const condition = startConditionOf(config);
  if (!condition || !startConditionTracked(task, config) || startConditionHeld(task, tasks, config))
    return false;
  const forms: boolean[] = [];
  if (condition.stages) forms.push(condition.stages.includes(task.stageId));
  if (condition.priority) {
    const priority = effectivePriority(task, tasks);
    forms.push(
      !!priority &&
        (condition.priority === 'any' || PRIORITY_RANK[priority] <= PRIORITY_RANK[condition.priority]),
    );
  }
  if (condition.labels) {
    const labels = inheritedLabels(task, tasks);
    forms.push(condition.labels.some((id) => labels.includes(id)));
  }
  return condition.combine === 'all' ? forms.every(Boolean) : forms.some(Boolean);
}

export function startConditionImmediate(
  task: ConditionCard,
  tasks: readonly ConditionCard[],
  config: ProjectConfig,
): boolean {
  const condition = startConditionOf(config);
  return (
    !!condition &&
    (effectivePriority(task, tasks) === 'urgent' ||
      condition.graceMinutes === 0 ||
      (!!condition.stages?.includes(task.stageId) &&
        (condition.combine === 'any' || (!condition.priority && !condition.labels))))
  );
}

export function startConditionGoes(input: {
  task: Task;
  tasks: readonly Task[];
  config: ProjectConfig;
  metSince: string | null;
  now: string;
}): boolean {
  const { task, tasks, config, metSince, now } = input;
  return (
    startConditionHolds(task, tasks, config) &&
    (startConditionImmediate(task, tasks, config) ||
      (metSince !== null &&
        Date.parse(metSince) + config.team.startCondition!.graceMinutes * 60_000 <= Date.parse(now)))
  );
}

export function startConditionMarkChanges(input: {
  config: ProjectConfig;
  tasks: readonly Task[];
  marks: ReadonlyMap<string, string>;
  now: string;
}): { add: { taskKey: string; metSince: string }[]; remove: string[] } {
  const holding = new Set(
    input.tasks
      .filter((task) => startConditionHolds(task, input.tasks, input.config))
      .map((task) => task.key),
  );
  return {
    add: [...holding]
      .filter((key) => !input.marks.has(key))
      .map((taskKey) => ({ taskKey, metSince: input.now })),
    remove: [...input.marks.keys()].filter((key) => !holding.has(key)),
  };
}

export function startConditionShift(input: {
  before: ProjectConfig;
  after: ProjectConfig;
  tasks: readonly Task[];
}): { stopped: string[]; started: string[]; stoppedCount: number; startedCount: number } {
  const holds = (task: Task, config: ProjectConfig) =>
    startConditionOf(config)
      ? startConditionHolds(task, input.tasks, config)
      : task.status === 'active' &&
        !task.archivedAt &&
        task.kind !== 'theme' &&
        task.stageId === pullSourceStage(config)?.id;
  const stopped = input.tasks
    .filter((task) => holds(task, input.before) && !holds(task, input.after))
    .map((task) => task.key);
  const started = input.tasks
    .filter((task) => !holds(task, input.before) && holds(task, input.after))
    .map((task) => task.key);
  return {
    stopped: stopped.slice(0, 20),
    started: started.slice(0, 20),
    stoppedCount: stopped.length,
    startedCount: started.length,
  };
}

export function startConditionSummary(
  condition: StartCondition,
  config: ProjectConfig,
  _locale?: string,
): string {
  const forms: string[] = [];
  if (condition.stages)
    forms.push(
      `cards in ${condition.stages.map((id) => config.pipeline.stages.find((stage) => stage.id === id)?.name ?? id).join(', ')}`,
    );
  if (condition.priority)
    forms.push(
      condition.priority === 'any' ? 'with any priority' : `with ${condition.priority} or higher priority`,
    );
  const names = (ids: string[]) =>
    ids.map((id) => config.pipeline.labels.find((label) => label.id === id)?.name ?? id).join(', ');
  if (condition.labels) forms.push(`with labels ${names(condition.labels)}`);
  return `${forms.join(condition.combine === 'all' ? ' and ' : ' or ')}${condition.hold.length ? `; held by ${names(condition.hold)}` : ''}; grace ${condition.graceMinutes} min`;
}
