import { defaultBoardColumnColor } from '@projectman/shared';
import type { BoardColumn, BoardColumnColor, ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import { pipelineId } from '../../../lib/ids';
import type { FieldIssue } from '../edit/FieldErrors';
import { issueTarget } from '../issueTarget';
import { columnColor } from './flow';

/** What the column panels edit: the name and the colour the column shows in. */
export interface ColumnDraft {
  id: string;
  name: string;
  color: BoardColumnColor;
}

export function columnDraftOf(config: ProjectConfig, column: BoardColumn): ColumnDraft {
  return { id: column.id, name: column.name, color: columnColor(config.pipeline, column) };
}

/** The draft of a column that does not exist yet: the default colour of the place it would take at the end. */
export function blankColumn(config: ProjectConfig): ColumnDraft {
  return { id: '', name: '', color: defaultBoardColumnColor(config.pipeline.columns.length) };
}

/** The identifier a new column gets from its name. */
export function newColumnId(config: ProjectConfig, name: string): string {
  return pipelineId(
    name,
    config.pipeline.columns.map((column) => column.id),
  );
}

/** The saved column with the draft's name; its colour is written only when it differs from what it shows now. */
export function applyColumnDraft(config: ProjectConfig, draft: ColumnDraft): ProjectConfig {
  return {
    ...config,
    pipeline: {
      ...config.pipeline,
      columns: config.pipeline.columns.map((column) => {
        if (column.id !== draft.id) return column;
        const next: BoardColumn = { ...column, name: draft.name.trim() };
        if (draft.color !== columnColor(config.pipeline, column)) next.color = draft.color;
        return next;
      }),
    },
  };
}

/** A new column goes among the columns without a stage, which come last: at the end. */
export function appendColumn(config: ProjectConfig, draft: ColumnDraft): ProjectConfig {
  const column: BoardColumn = {
    id: newColumnId(config, draft.name),
    name: draft.name.trim(),
    color: draft.color,
  };
  return { ...config, pipeline: { ...config.pipeline, columns: [...config.pipeline.columns, column] } };
}

/** The errors of a column draft: the name's under the name, the rest in the band. */
export function sortColumnIssues(
  issues: readonly IssueRef[],
  config: ProjectConfig,
  columnId: string,
  draft: Pick<ColumnDraft, 'name'>,
): { name: FieldIssue[]; other: FieldIssue[] } {
  const name: FieldIssue[] = [];
  const other: FieldIssue[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const id = `${issue.code}:${issue.path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const target = issueTarget(issue.path, config);
    const mine = target?.show?.type === 'column' && target.show.id === columnId;
    const entry = { message: issueMessage(issue), code: issue.code, path: issue.path };
    if (mine && target?.field === 'name') {
      name.push(
        draft.name.trim() === '' ? { ...entry, message: t('settings.pipeline.edit.nameRequired') } : entry,
      );
    } else other.push(entry);
  }
  return { name, other };
}
