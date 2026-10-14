import type { PartsClosed } from '../domain/event';
import type { Stage } from '../domain/pipeline';
import { isOpenTask, isTheme, taskSeq } from '../domain/task';
import type { Task } from '../domain/task';
import { stageIndex } from './gates';
import type { ProjectConfig } from './schema';
import { labelDefinition } from './labels';
import { developmentStage } from './refinement';

/**
 * A collecting card closes with its parts (PM-647). A card with subtasks is a collecting card: its work is
 * the subtasks' work, so once every one of them is closed the gates of the stages on the way (the plan,
 * the review of work nobody did on the card itself) say nothing. One rule for the person's move, the
 * system's own close and the web's test fake.
 */

type GateConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;
type CollectingTask = Pick<Task, 'key' | 'kind' | 'status' | 'stageId' | 'labels'>;
type CollectingPart = Pick<Task, 'key' | 'status'>;

/**
 * The waiver of a move into the done stage: the card goes without the gates when it is an open card, the target is a
 * `done` stage, every subtask is done or cancelled and at least one is done, and no blocking label (an open
 * question) holds the card. Null: the gates apply. When every part was cancelled the plan fell, not the work,
 * and a person decides.
 */
export function partsClosedWaiver(
  config: GateConfig,
  task: CollectingTask,
  parts: readonly CollectingPart[],
  toStageId: string,
): PartsClosed | null {
  if (isTheme(task) || !isOpenTask(task)) return null;
  const target = config.pipeline.stages.find((stage) => stage.id === toStageId);
  if (target?.kind !== 'done' || target.id === task.stageId) return null;
  if (parts.length === 0 || parts.some((part) => isOpenTask(part))) return null;
  if (task.labels.some((id) => labelDefinition(config, id)?.blocks)) return null;
  const byKey = (a: string, b: string) => taskSeq(a) - taskSeq(b);
  const done = parts.filter((part) => part.status === 'done').map((part) => part.key);
  if (done.length === 0) return null;
  const cancelled = parts.filter((part) => part.status === 'cancelled').map((part) => part.key);
  return { done: done.sort(byKey), cancelled: cancelled.sort(byKey) };
}

/**
 * Whether the system closes the card by itself now, and where it goes. Besides the waiver the card must be
 * `active` or `waiting` (not `blocked`) and stand before the development stage (before the done stage when
 * there is none): a card somebody works on is not closed under them, a person moves it. Null: it does not.
 */
export function collectingAutoClose(
  config: GateConfig,
  task: CollectingTask,
  parts: readonly CollectingPart[],
): { to: Stage; parts: PartsClosed } | null {
  const to = config.pipeline.stages.find((stage) => stage.kind === 'done');
  if (!to || (task.status !== 'active' && task.status !== 'waiting')) return null;
  const closed = partsClosedWaiver(config, task, parts, to.id);
  if (!closed) return null;
  const limit = developmentStage(config) ?? to;
  const at = stageIndex(config.pipeline, task.stageId);
  if (at < 0 || at >= stageIndex(config.pipeline, limit.id)) return null;
  return { to, parts: closed };
}
