import { TEAM_RULE_IDS, defaultBoardColumnColor } from '@projectman/shared';
import type {
  BoardColumn,
  BoardColumnColor,
  LabelView,
  TeamMap,
  TeamMapLabel,
  TeamMapStage,
  TeamRuleId,
} from '@projectman/shared';

/** What the details panel shows, as the `?show=` value names it: `stage:<id>`, `legend` and so on. */
export type ShowTarget =
  | { kind: 'stage'; id: string }
  | { kind: 'member'; id: string }
  | { kind: 'label'; id: string }
  | { kind: 'rule'; id: TeamRuleId }
  | { kind: 'legend' };

export function parseShow(value: string | null): ShowTarget | null {
  if (!value) return null;
  if (value === 'legend') return { kind: 'legend' };
  const split = value.indexOf(':');
  if (split < 1) return null;
  const kind = value.slice(0, split);
  const id = value.slice(split + 1);
  if (!id) return null;
  if (kind === 'stage' || kind === 'member' || kind === 'label') return { kind, id };
  if (kind === 'rule' && (TEAM_RULE_IDS as readonly string[]).includes(id)) {
    return { kind, id: id as TeamRuleId };
  }
  return null;
}

export function showValue(target: ShowTarget): string {
  return target.kind === 'legend' ? 'legend' : `${target.kind}:${target.id}`;
}

/** Whether the item a `?show=` value names is still in the map (a settings change can remove it). */
export function showExists(map: TeamMap, target: ShowTarget): boolean {
  switch (target.kind) {
    case 'legend':
      return true;
    case 'stage':
      return map.stages.some((entry) => entry.stage.id === target.id);
    case 'member':
      return map.members.some((entry) => entry.member.handle === target.id);
    case 'label':
      return map.labels.some((entry) => entry.label.id === target.id);
    case 'rule':
      return map.rules.some((rule) => rule.id === target.id);
  }
}

/** The stages whose description in the map differs from the previous map's (new stages count). */
export function changedStageIds(previous: TeamMap | null, next: TeamMap): Set<string> {
  const changed = new Set<string>();
  if (!previous) return changed;
  const before = new Map(previous.stages.map((entry) => [entry.stage.id, JSON.stringify(entry)]));
  for (const entry of next.stages) {
    const old = before.get(entry.stage.id);
    if (old !== undefined && old !== JSON.stringify(entry)) changed.add(entry.stage.id);
  }
  return changed;
}

export interface StageColumn {
  column: BoardColumn;
  color: BoardColumnColor;
  stages: TeamMapStage[];
}

/** The pipeline's stages in order, grouped by the board column they are shown in (consecutive stages share one). */
export function stageColumns(map: TeamMap, columns: readonly BoardColumn[]): StageColumn[] {
  const result: StageColumn[] = [];
  for (const entry of map.stages) {
    const last = result[result.length - 1];
    if (last && last.column.id === entry.stage.columnId) {
      last.stages.push(entry);
      continue;
    }
    const index = columns.findIndex((column) => column.id === entry.stage.columnId);
    const column = columns[index] ?? { id: entry.stage.columnId, name: entry.stage.columnId };
    result.push({
      column,
      color: column.color ?? defaultBoardColumnColor(Math.max(index, 0)),
      stages: [entry],
    });
  }
  return result;
}

/** The map's labels in the shape the label chip takes. */
export function labelViews(map: TeamMap): LabelView[] {
  return map.labels.map((entry) => ({ ...entry.label, holders: entry.holders }));
}

export type LabelGroupId = 'results' | 'approvals' | 'blocking' | 'other';

/**
 * Which box of the labels section a label belongs to: a result (one of an exclusive group), a
 * human's approval, a label that holds the card back, or the rest.
 */
export function labelGroupOf(entry: TeamMapLabel): LabelGroupId {
  if (entry.label.group) return 'results';
  if (entry.approval) return 'approvals';
  if (entry.label.blocks) return 'blocking';
  return 'other';
}
