import type { ConfigDiffItem, ConfigHistoryEntry } from '@projectman/shared';
import { t } from '../../../i18n/t';
import type { PlainMessageKey } from '../../../i18n/t';

type FieldName = Extract<ConfigDiffItem, { fields: readonly string[] }>['fields'][number];

const FIELD_LABEL = {
  description: 'settings.history.fields.description',
  kind: 'settings.history.fields.kind',
  column: 'settings.history.fields.column',
  duty: 'settings.history.fields.duty',
  owners: 'settings.history.fields.owners',
  gate: 'settings.history.fields.gate',
  color: 'settings.history.fields.color',
  hint: 'settings.history.fields.hint',
  order: 'settings.history.fields.order',
  name: 'settings.history.fields.name',
  meaning: 'settings.history.fields.meaning',
  setBy: 'settings.history.fields.setBy',
  rules: 'settings.history.fields.rules',
} as const satisfies Record<FieldName, PlainMessageKey>;

const SECTION_TEXT = {
  limits: 'settings.history.summary.sectionLimits',
  project: 'settings.history.summary.sectionProject',
  repos: 'settings.history.summary.sectionRepos',
  team: 'settings.history.summary.sectionTeam',
  duties: 'settings.history.summary.sectionDuties',
} as const satisfies Record<Extract<ConfigDiffItem, { kind: 'section_changed' }>['section'], PlainMessageKey>;

const fieldsText = (fields: readonly FieldName[]): string =>
  fields.map((field) => t(FIELD_LABEL[field])).join(', ');

/**
 * The Hungarian line(s) of one change. The summary of a row uses the first line; "Részletek" lists
 * them all, so there a changed stage or label also names its other fields (`detailed`).
 */
function changeLines(item: ConfigDiffItem, detailed: boolean): string[] {
  switch (item.kind) {
    case 'created':
      return [t('settings.history.summary.created')];
    case 'stage_added':
      return [t('settings.history.summary.stageAdded', { name: item.name })];
    case 'stage_removed':
      return [t('settings.history.summary.stageRemoved', { name: item.name })];
    case 'stage_moved':
      return [t('settings.history.summary.stageMoved', { name: item.name })];
    case 'stage_renamed':
      return [t('settings.history.summary.stageRenamed', { from: item.from, name: item.name })];
    case 'stage_changed': {
      const rest = item.fields.filter((field) => field !== 'gate');
      const gate = rest.length < item.fields.length;
      return [
        ...(gate ? [t('settings.history.summary.stageGate', { name: item.name })] : []),
        ...(rest.length === 0
          ? []
          : [
              detailed
                ? t('settings.history.summary.stageChangedFields', {
                    name: item.name,
                    fields: fieldsText(rest),
                  })
                : t('settings.history.summary.stageChanged', { name: item.name }),
            ]),
      ].slice(0, detailed ? undefined : 1);
    }
    case 'column_added':
      return [t('settings.history.summary.columnAdded', { name: item.name })];
    case 'column_removed':
      return [t('settings.history.summary.columnRemoved', { name: item.name })];
    case 'column_renamed':
      return [t('settings.history.summary.columnRenamed', { from: item.from, name: item.name })];
    case 'column_changed':
      return [
        t('settings.history.summary.columnChanged', { name: item.name, fields: fieldsText(item.fields) }),
      ];
    case 'label_added':
      return [t('settings.history.summary.labelAdded', { name: item.name })];
    case 'label_removed':
      return [t('settings.history.summary.labelRemoved', { name: item.name })];
    case 'label_changed':
      return [
        detailed
          ? t('settings.history.summary.labelChangedFields', {
              name: item.name,
              fields: fieldsText(item.fields),
            })
          : t('settings.history.summary.labelChanged', { name: item.name }),
      ];
    case 'section_changed':
      return [t(SECTION_TEXT[item.section])];
    case 'other':
      return [t('settings.history.summary.generic')];
  }
}

/** What a list of changes says in one line: the first change, and how many more there are. */
function changesSummary(changes: readonly ConfigDiffItem[] | null): string {
  const first = changes?.[0];
  if (!changes || !first) return t('settings.history.summary.generic');
  const line = changeLines(first, false)[0] ?? t('settings.history.summary.generic');
  return changes.length > 1
    ? t('settings.history.summary.andMore', { first: line, count: changes.length - 1 })
    : line;
}

/** The one Hungarian line of a history row. */
export function historySummary(entry: ConfigHistoryEntry): string {
  if (entry.restores?.kind === 'revert') return t('settings.history.summary.restored');
  if (entry.restores?.kind === 'undo')
    return t('settings.history.summary.undone', { summary: changesSummary(entry.restores.changes) });
  return changesSummary(entry.changes);
}

/** Every change of a row on its own line; null when the row has no comparison, `[]` is "changed, nothing named". */
export function historyDetailLines(entry: ConfigHistoryEntry): string[] | null {
  if (entry.changes === null) return null;
  const lines = entry.changes.flatMap((item) => changeLines(item, true));
  return lines.length > 0 ? lines : [t('settings.history.summary.generic')];
}
