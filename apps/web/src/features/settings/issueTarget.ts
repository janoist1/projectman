import type { ProjectConfig } from '@projectman/shared';
import type { SettingsSectionId } from './sections';
import type { SettingsShow } from './selection';

export interface IssueTarget {
  section: SettingsSectionId;
  show?: SettingsShow;
  field?: string;
}

export function issueTarget(path: string, config: ProjectConfig): IssueTarget | null {
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  const match = /^pipeline\.(stages|columns|labels)\.(\d+)(?:\.(.*))?$/.exec(normalized);
  if (match) {
    const collection = match[1] as 'stages' | 'columns' | 'labels';
    const element = config.pipeline[collection][Number(match[2])];
    return {
      section: collection === 'labels' ? 'labels' : 'pipeline',
      ...(element
        ? {
            show: {
              type: collection === 'stages' ? 'stage' : collection === 'columns' ? 'column' : 'label',
              id: element.id,
            } as SettingsShow,
          }
        : {}),
      ...(match[3] ? { field: match[3] } : {}),
    };
  }
  const starts = (prefix: string) => normalized === prefix || normalized.startsWith(`${prefix}.`);
  if (starts('team.members')) return { section: 'team' };
  if (starts('team.limits')) return { section: 'limits' };
  if (starts('team')) return { section: 'duties' };
  if (starts('project.repos')) return { section: 'repos' };
  if (starts('project')) return { section: 'project' };
  if (starts('pipeline')) return { section: 'pipeline' };
  return null;
}
