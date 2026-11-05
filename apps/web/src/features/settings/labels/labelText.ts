import type { LabelDefinition, ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import type { LabelUsage } from './labelDraft';

/** Who may set a label, in words: "Bárki", "Kódátnézés, Anna". */
export function whoText(label: LabelDefinition, config: ProjectConfig): string {
  const { setBy } = label;
  if (typeof setBy === 'string') return t(`settings.labels.whoOptions.${setBy}`);
  const names = new Map(config.team.members.map((member) => [member.handle, member.displayName]));
  return [
    ...(setBy.duties ?? []).map((duty) => t(`dutyNames.${duty}`)),
    ...(setBy.members ?? []).map((handle) => names.get(handle) ?? handle),
  ].join(t('common.listSeparator'));
}

/** The steps that use a label, each once: "QA, Átnézés". */
export function usageStages(uses: readonly LabelUsage[]): string[] {
  return [...new Set(uses.map((use) => use.stageName))];
}
