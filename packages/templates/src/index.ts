import type { AiRole, PermissionMode, ProjectConfig, TemplateSummary } from '@projectman/shared';

/**
 * Factory team + pipeline templates a new project starts from. Source code is English;
 * user-facing default names (stages, columns, members) come from src/locales/<lang>.ts.
 * Placeholder: the templates workstream fills in the templates.
 */

export interface TemplateOwner {
  handle: string;
  displayName: string;
  email: string;
}

export interface BuildTemplateInput {
  key: string;
  name: string;
  workspacePath: string;
  /** Project language; picks the locale for default display names. */
  language: string;
  owner: TemplateOwner;
}

export interface ProjectTemplate {
  id: string;
  /** i18n keys translated by the web app. */
  nameKey: string;
  descriptionKey: string;
  build(input: BuildTemplateInput): ProjectConfig;
}

export const templates: ProjectTemplate[] = [];

/** Defaults used when an AI member is hired from a role template. */
export interface AiRoleDefaults {
  /** English role instructions appended to the member's system prompt. */
  instructions: string;
  model: string;
  permissionMode: PermissionMode;
  capacity: number;
}

/** Placeholder: the templates workstream provides real instructions per role. */
export function aiRoleDefaults(_role: AiRole): AiRoleDefaults {
  return { instructions: '', model: 'opus', permissionMode: 'default', capacity: 1 };
}

/** Default display name for the index-th member of a role, in the project's language. */
export function defaultMemberName(role: AiRole, _language: string, index: number): string {
  return index > 1 ? `${role} ${index}` : role;
}

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
