import { introducedErrors, ownerOnlyChanges } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';

/** The cards in a stage as far as the board is known; only the server decides what may be deleted. */
export type CardCount =
  { status: 'loading' } | { status: 'failed'; retry(): void } | { status: 'ready'; count: number };

/** Why a stage or a column cannot be deleted right now. */
export type DeleteBlock =
  | { kind: 'checking' }
  | { kind: 'check_failed'; retry(): void }
  | { kind: 'cards'; count: number }
  | { kind: 'rule'; reasons: string[] }
  | { kind: 'owner_only' }
  | { kind: 'stages'; names: string[] }
  | { kind: 'last_column' };

export function withoutStage(config: ProjectConfig, stageId: string): ProjectConfig {
  return {
    ...config,
    pipeline: { ...config.pipeline, stages: config.pipeline.stages.filter((stage) => stage.id !== stageId) },
  };
}

export function withoutColumn(config: ProjectConfig, columnId: string): ProjectConfig {
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      columns: config.pipeline.columns.filter((column) => column.id !== columnId),
    },
  };
}

/** What the rules say about the configuration without the element: a broken invariant or an owner-only change. */
function ruleBlock(config: ProjectConfig, candidate: ProjectConfig, isOwner: boolean): DeleteBlock | null {
  const errors = introducedErrors(config, candidate);
  if (errors.length > 0) return { kind: 'rule', reasons: errors.map((issue) => issueMessage(issue)) };
  if (!isOwner && ownerOnlyChanges(config, candidate).length > 0) return { kind: 'owner_only' };
  return null;
}

/** A stage with cards, one the first or last rule needs, or an approval gate only the owner may drop stays. */
export function stageDeleteBlock(
  config: ProjectConfig,
  stageId: string,
  cards: CardCount,
  isOwner: boolean,
): DeleteBlock | null {
  if (cards.status === 'loading') return { kind: 'checking' };
  if (cards.status === 'failed') return { kind: 'check_failed', retry: cards.retry };
  if (cards.count > 0) return { kind: 'cards', count: cards.count };
  return ruleBlock(config, withoutStage(config, stageId), isOwner);
}

/** A column with stages stays, and so does the last column. */
export function columnDeleteBlock(
  config: ProjectConfig,
  columnId: string,
  isOwner: boolean,
): DeleteBlock | null {
  const stages = config.pipeline.stages.filter((stage) => stage.columnId === columnId);
  if (stages.length > 0) return { kind: 'stages', names: stages.map((stage) => stage.name) };
  if (config.pipeline.columns.length <= 1) return { kind: 'last_column' };
  return ruleBlock(config, withoutColumn(config, columnId), isOwner);
}

/** The sentence under the disabled button. */
export function deleteBlockText(block: DeleteBlock): string {
  switch (block.kind) {
    case 'checking':
      return t('settings.pipeline.delete.checking');
    case 'check_failed':
      return t('settings.pipeline.delete.checkFailed');
    case 'cards':
      return t('settings.pipeline.delete.cards', { count: block.count });
    case 'rule':
      return t('settings.pipeline.delete.rule', { reason: block.reasons.join(' ') });
    case 'owner_only':
      return t('settings.pipeline.delete.ownerOnly');
    case 'stages':
      return t('settings.pipeline.delete.stages', { names: block.names.join(t('common.listSeparator')) });
    case 'last_column':
      return t('settings.pipeline.delete.lastColumn');
  }
}
