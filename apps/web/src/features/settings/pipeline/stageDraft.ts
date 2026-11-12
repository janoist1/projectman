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
  /** The small-card rule (PM-1378); the values stay while the rule is switched off, so switching it on again finds them. */
  smallEnabled: boolean;
  smallPoints: SmallCardsRule['maxPoints'];
  smallOwners: string[];
  /** The central patterns as typed: one per line, blank lines kept so an error can name its line. */
  smallPaths: string;
}

type SmallCardsRule = NonNullable<Stage['smallCards']>;

/** The limits the point choice offers. */
export const SMALL_CARD_POINTS: readonly SmallCardsRule['maxPoints'][] = [1, 2, 3, 5, 8];

/** The small-card fields of a stage without the rule: switched off, with the starting values. */
export const NO_SMALL_CARDS = {
  smallEnabled: false,
  smallPoints: 3,
  smallOwners: [],
  smallPaths: '',
} satisfies Pick<StageDraft, 'smallEnabled' | 'smallPoints' | 'smallOwners' | 'smallPaths'>;

/** The patterns of the text: trimmed, a blank line goes nowhere. */
function pathLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The line (counting from 1, blank lines included) that holds the pattern of the given index. */
function lineOfPattern(text: string, index: number): number {
  let seen = -1;
  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line++) {
    if (lines[line]!.trim() !== '') seen += 1;
    if (seen === index) return line + 1;
  }
  return lines.length;
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
    smallEnabled: stage.smallCards !== undefined,
    smallPoints: stage.smallCards?.maxPoints ?? NO_SMALL_CARDS.smallPoints,
    smallOwners: stage.smallCards?.owners ?? [],
    smallPaths: (stage.smallCards?.centralPaths ?? []).join('\n'),
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
  // The rule belongs to a step stage that has it switched on; any other leaves the field out.
  if (draft.kind === 'step' && draft.smallEnabled)
    stage.smallCards = {
      maxPoints: draft.smallPoints,
      owners: draft.smallOwners,
      centralPaths: pathLines(draft.smallPaths),
    };
  return stage;
}

/** The errors of a draft sorted by the field they belong to; the rest has no field of its own. */
export function sortIssues(
  issues: readonly IssueRef[],
  config: ProjectConfig,
  stageId: string,
  draft: Pick<StageDraft, 'name' | 'conditions' | 'smallPaths'>,
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
          issue.code === 'first_stage_not_queue' || issue.code === 'last_stage_not_done'
            ? 'kind'
            : issue.code === 'stage_without_owner' || issue.code === 'work_stage_without_worker'
              ? 'owners'
              : null;
      else if (part === 'name') {
        field = 'name';
        if (draft.name.trim() === '') message = t('settings.pipeline.edit.nameRequired');
      } else if (part === 'kind' || part === 'duty' || part === 'description') field = part;
      else if (part === 'columnId') field = 'column';
      else if (part === 'owners' || part.startsWith('owners.')) field = 'owners';
      else if (part.startsWith('smallCards.owners')) {
        field = 'smallOwners';
        if (issue.code === 'small_cards_unknown_owner')
          message = t('settings.pipeline.edit.smallRule.errors.unknownOwner', { handle: issue.detail ?? '' });
        else message = t('settings.pipeline.edit.smallRule.errors.noOwner');
      } else if (part.startsWith('smallCards.centralPaths')) {
        field = 'smallPaths';
        const index = /^smallCards\.centralPaths\.(\d+)$/.exec(part)?.[1];
        if (issue.code === 'small_cards_invalid_path' && index !== undefined)
          message = t('settings.pipeline.edit.smallRule.errors.invalidPath', {
            line: lineOfPattern(draft.smallPaths, Number(index)),
            pattern: issue.detail ?? '',
          });
        else message = t('settings.pipeline.edit.smallRule.errors.tooManyPaths');
      } else {
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
