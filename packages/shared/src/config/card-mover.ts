import type { Actor } from '../domain/event';
import { stageIndex } from './gates';
import { memberOf } from './lookup';
import { projectManagerOf } from './project-manager';
import { isRefinementStage } from './refinement';
import type { CardMover, ProjectConfig } from './schema';

export const DEFAULT_CARD_MOVER: CardMover = { kind: 'worker' };

export function cardMoverOf(config: Pick<ProjectConfig, 'team'>): CardMover {
  return config.team.cardMover ?? DEFAULT_CARD_MOVER;
}

export function cardMoverHandle(config: Pick<ProjectConfig, 'team'>): string | null {
  const mover = cardMoverOf(config);
  if (mover.kind === 'project_manager') return projectManagerOf(config)?.handle ?? null;
  if (mover.kind === 'human') return memberOf(config, mover.handle)?.kind === 'human' ? mover.handle : null;
  return null;
}

/** Forward movement from a work, step or release stage, except refinement. */
export function isHandOnMove(
  config: Pick<ProjectConfig, 'pipeline'>,
  fromStageId: string,
  toStageId: string,
): boolean {
  const from = stageIndex(config.pipeline, fromStageId);
  const to = stageIndex(config.pipeline, toStageId);
  if (from < 0 || to <= from) return false;
  const stage = config.pipeline.stages[from]!;
  if (isRefinementStage(stage)) return false;
  const kind = stage.kind;
  return kind === 'work' || kind === 'step' || kind === 'release';
}

export type HandOnDecision = { kind: 'move' } | { kind: 'request'; mover: string };

export function handOnDecision(
  config: Pick<ProjectConfig, 'team' | 'pipeline'>,
  actor: Pick<Actor, 'kind' | 'handle'>,
  fromStageId: string,
  toStageId: string,
): HandOnDecision {
  if (actor.kind === 'human' || !isHandOnMove(config, fromStageId, toStageId)) return { kind: 'move' };
  const mover = cardMoverHandle(config);
  return mover !== null && mover !== actor.handle ? { kind: 'request', mover } : { kind: 'move' };
}
