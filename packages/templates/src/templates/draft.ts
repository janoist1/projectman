import {
  ProjectConfig,
  type AiMemberConfig,
  type AiRole,
  type BoardColumn,
  type CheckName,
  type GateCondition,
  type MemberConfig,
  type Stage,
  type StageKind,
  type TeamLimits,
} from '@projectman/shared';
import { getLocale, type ColumnKey, type SpecialtyKey, type StageKey, type TemplateId } from '../locales';
import { defaultMemberHandle, defaultMemberName } from '../members';
import { aiRoleDefaults } from '../roles';
import type { BuildTemplateInput, ProjectTemplate } from '../types';

/** Limits every factory template starts with. */
export const DEFAULT_LIMITS: TeamLimits = {
  maxConcurrentAi: 3,
  pauseAbovePlanUsagePercent: 80,
  tempWorkers: { enabled: false, max: 1, role: 'developer' },
};

export const checkPassed = (check: CheckName): GateCondition => ({ type: 'check_passed', check });

export const humanApproval = (...approvers: string[]): GateCondition => ({
  type: 'human_approval',
  approvers,
});

/** Helpers a template uses to assemble a project configuration in the project's language. */
export interface TemplateDraft {
  /** Handle of the human owner (the sponsor of every AI member). */
  owner: string;
  /** Adds an AI member with the role's defaults; returns its handle. */
  hire(role: AiRole, specialty?: SpecialtyKey): string;
  column(key: ColumnKey): BoardColumn;
  stage(key: StageKey, kind: StageKind, column: ColumnKey, owners: string[], ...gate: GateCondition[]): Stage;
  /** Validates the assembled configuration (throws if a template is broken). */
  finish(pipeline: { columns: BoardColumn[]; stages: Stage[] }, limits?: TeamLimits): ProjectConfig;
}

function draftProject(templateId: TemplateId, input: BuildTemplateInput): TemplateDraft {
  const locale = getLocale(input.language);
  const members: MemberConfig[] = [
    {
      kind: 'human',
      handle: input.owner.handle,
      displayName: input.owner.displayName,
      access: 'owner',
      email: input.owner.email,
    },
  ];
  const taken = new Set<string>([input.owner.handle]);
  const perRole = new Map<string, number>();

  return {
    owner: input.owner.handle,

    hire(role, specialty) {
      const handle = defaultMemberHandle(role, taken, specialty);
      taken.add(handle);
      const specialtyName = specialty ? locale.specialties[specialty] : undefined;
      const countKey = `${role}:${specialty ?? ''}`;
      const index = (perRole.get(countKey) ?? 0) + 1;
      perRole.set(countKey, index);
      const defaults = aiRoleDefaults(role);
      const member: AiMemberConfig = {
        kind: 'ai',
        handle,
        displayName: defaultMemberName(role, input.language, index, specialtyName),
        role,
        ...(specialtyName ? { specialty: specialtyName } : {}),
        model: defaults.model,
        permissionMode: defaults.permissionMode,
        capacity: defaults.capacity,
        instructions: defaults.instructions,
        sponsor: input.owner.handle,
        temp: false,
      };
      members.push(member);
      return handle;
    },

    column(key) {
      return { id: key, name: locale.columns[key].name, hint: locale.columns[key].hint };
    },

    stage(key, kind, column, owners, ...gate) {
      return {
        id: key,
        name: locale.stages[key],
        kind,
        owners,
        ...(gate.length > 0 ? { gate: { conditions: gate } } : {}),
        columnId: column,
      };
    },

    finish(pipeline, limits = DEFAULT_LIMITS) {
      return ProjectConfig.parse({
        schemaVersion: 1,
        project: {
          key: input.key,
          name: input.name,
          workspacePath: input.workspacePath,
          repos: [],
          language: input.language,
          templateId,
        },
        team: { members, limits },
        pipeline,
      });
    },
  };
}

export function defineTemplate(
  id: TemplateId,
  build: (draft: TemplateDraft) => ProjectConfig,
): ProjectTemplate {
  return {
    id,
    nameKey: `templates.${id}.name`,
    descriptionKey: `templates.${id}.description`,
    build: (input) => build(draftProject(id, input)),
  };
}
