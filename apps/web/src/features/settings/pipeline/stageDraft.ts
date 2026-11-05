import type { DutyId, GateCondition, ProjectConfig, Stage, StageKind } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import type { FieldIssue } from '../edit/FieldErrors';
import { issueTarget } from '../issueTarget';

/** The value of a stage's column that stands for the column a new stage brings along (never a valid id). */
export const NEW_COLUMN = '+new';

/** What the panels edit: the stage, with both ways of choosing owners kept while the draft is open. */
export interface StageDraft {
  id: string;
  name: string;
  description: string;
  kind: StageKind;
  columnId: string;
  duty: DutyId | null;
  ownersMode: 'duty' | 'names';
  members: string[];
  conditions: GateCondition[];
}

export function draftOf(stage: Stage): StageDraft {
  return {
    id: stage.id,
    name: stage.name,
    description: stage.description ?? '',
    kind: stage.kind,
    columnId: stage.columnId,
    duty: stage.duty ?? null,
    ownersMode: stage.owners !== undefined || !stage.duty ? 'names' : 'duty',
    members: stage.owners ?? [],
    conditions: stage.gate?.conditions.map((condition) => ({ ...condition })) ?? [],
  };
}

export function stageOf(draft: StageDraft): Stage {
  const stage: Stage = {
    id: draft.id,
    name: draft.name.trim(),
    kind: draft.kind,
    columnId: draft.columnId,
  };
  if (draft.description.trim()) stage.description = draft.description;
  if (draft.duty) stage.duty = draft.duty;
  // Only the chosen way is saved; without a duty, nobody chosen is the same as no list.
  if (draft.ownersMode === 'names' && (draft.members.length > 0 || draft.duty)) stage.owners = draft.members;
  if (draft.conditions.length > 0) stage.gate = { conditions: draft.conditions };
  return stage;
}

/** The errors of a draft sorted by the field they belong to; the rest has no field of its own. */
export function sortIssues(
  issues: readonly IssueRef[],
  config: ProjectConfig,
  stageId: string,
  draft: Pick<StageDraft, 'name' | 'conditions'>,
): { fields: Map<string, FieldIssue[]>; other: FieldIssue[] } {
  const fields = new Map<string, FieldIssue[]>();
  const other: FieldIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const id = `${issue.code}:${issue.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const target = issueTarget(issue.path, config);
    const mine = target?.show?.type === 'stage' && target.show.id === stageId;
    let field: string | null = null;
    let message = issueMessage(issue);
    if (mine) {
      const part = target?.field;
      if (part === undefined)
        field =
          issue.code === 'first_stage_not_queue' || issue.code === 'last_stage_not_done' ? 'kind' : null;
      else if (part === 'name') {
        field = 'name';
        if (draft.name.trim() === '') message = t('settings.pipeline.edit.nameRequired');
      } else if (part === 'kind' || part === 'duty' || part === 'description') field = part;
      else if (part === 'columnId') field = 'column';
      else if (part === 'owners' || part.startsWith('owners.')) field = 'owners';
      else {
        const row = /^gate\.conditions\.(\d+)(?:\.(label|when|type))?$/.exec(part);
        if (row) {
          field = `gate:${row[1]}`;
          const condition = draft.conditions[Number(row[1])];
          if (row[2] === 'label' && condition?.label === '')
            message = t('settings.pipeline.edit.labelRequired');
          if (row[2] === 'when' && condition?.when === '') message = t('settings.pipeline.edit.whenRequired');
        } else if (part.startsWith('gate')) field = 'gate';
      }
    }
    const entry = { message, code: issue.code, path: issue.path };
    if (field === null) other.push(entry);
    else fields.set(field, [...(fields.get(field) ?? []), entry]);
  }
  return { fields, other };
}

/** "Anna, Béla és Cecil" / "Anna és még 3". */
export function namesText(names: readonly string[]): string {
  if (names.length > 3)
    return t('howWeWork.flow.ownersMore', {
      names: names.slice(0, 2).join(t('common.listSeparator')),
      count: names.length - 2,
    });
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(t('common.listSeparator'))}${t('common.and')}${names[names.length - 1]}`;
}
