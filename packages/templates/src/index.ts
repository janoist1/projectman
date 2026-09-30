import type { TemplateSummary } from '@projectman/shared';
import { dailyRoutine } from './templates/daily-routine';
import { internalTool } from './templates/internal-tool';
import { smallTeam } from './templates/small-team';
import { webClientProject } from './templates/web-client-project';
import type { ProjectTemplate } from './types';

/**
 * Factory team + pipeline templates a new project starts from. Source code is English;
 * user-facing default names (stages, columns, members) come from src/locales/<lang>.ts.
 */

export type { BuildTemplateInput, ProjectTemplate, TemplateOwner } from './types';
export { aiMemberDefaults, aiRoleDefaults, CUSTOM_ROLE_DEFAULTS, type AiRoleDefaults } from './roles';
export { defaultMemberHandle, defaultMemberName, roleHandleStem, roleName, uniqueHandle } from './members';
export { DAILY_WORKER_SCHEDULE } from './templates/daily-routine';
export {
  hasLabel,
  isStandardLabel,
  lacksLabel,
  legacyCheckLabels,
  migrateLegacyConfig,
  STANDARD_LABEL_RULES,
  standardLabel,
  standardLabelsFor,
} from './labels';
export {
  en,
  getLocale,
  hu,
  type ColumnKey,
  type RoleText,
  type SpecialtyKey,
  type StageKey,
  type TemplateId,
  type TemplateLocale,
  type TemplateMemberKey,
} from './locales';

export const templates: ProjectTemplate[] = [webClientProject, smallTeam, internalTool, dailyRoutine];

export function getTemplate(id: string): ProjectTemplate | undefined {
  return templates.find((t) => t.id === id);
}

export function summarizeTemplate(template: ProjectTemplate): TemplateSummary {
  const sample = template.build({
    key: 'XX',
    name: 'sample',
    workspacePath: '/tmp',
    language: 'en',
    owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
  });
  return {
    id: template.id,
    nameKey: template.nameKey,
    descriptionKey: template.descriptionKey,
    memberCount: {
      human: sample.team.members.filter((m) => m.kind === 'human').length,
      ai: sample.team.members.filter((m) => m.kind === 'ai').length,
    },
    stageCount: sample.pipeline.stages.length,
  };
}
