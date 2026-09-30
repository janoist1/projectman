import {
  ProjectConfig,
  BUILT_IN_ROLE_DUTIES,
  type AiBuiltInRoleId,
  type AiMemberConfig,
  type BoardColumn,
  type BoardColumnColor,
  type DutyId,
  type GateCondition,
  type MemberConfig,
  type MemberSchedule,
  type Stage,
  type StageKind,
  type TeamLimits,
} from '@projectman/shared';
import {
  getLocale,
  type ColumnKey,
  type SpecialtyKey,
  type StageKey,
  type TemplateId,
  type TemplateMemberKey,
} from '../locales';
import { defaultMemberHandle, defaultMemberName, uniqueHandle } from '../members';
import { standardLabelsFor } from '../labels';
import { aiRoleDefaults } from '../roles';
import type { BuildTemplateInput, ProjectTemplate } from '../types';

/** Limits every factory template starts with. */
export const DEFAULT_LIMITS: TeamLimits = {
  aiEnabled: true,
  maxConcurrentAi: 3,
  pauseAbovePlanUsagePercent: 80,
  tempWorkers: { enabled: false, max: 1, role: 'developer' },
};

export { hasLabel } from '../labels';

export interface HireOptions {
  specialty?: SpecialtyKey;
  /** A display name of its own instead of the role's name, e.g. the "daily worker". */
  name?: TemplateMemberKey;
  /** Handle stem instead of the role's (a suffix is added when taken). */
  handle?: string;
  schedule?: MemberSchedule;
}

/** Helpers a template uses to assemble a project configuration in the project's language. */
export interface TemplateDraft {
  /** Handle of the human owner (the sponsor of every AI member). */
  owner: string;
  /** Adds an AI member with the role's defaults; returns its handle. */
  hire(role: AiBuiltInRoleId, opts?: HireOptions): string;
  column(key: ColumnKey): BoardColumn;
  /**
   * A stage carried by a duty: an AI owner's role decides it, otherwise the kind's default
   * (queue, work, release). Pass the duty instead of owners when neither fits (e.g. a merge
   * step decided by humans). Stages without a duty keep the given owners.
   */
  stage(
    key: StageKey,
    kind: StageKind,
    column: ColumnKey,
    owners: string[] | DutyId,
    ...gate: GateCondition[]
  ): Stage;
  /** Validates the assembled configuration (throws if a template is broken). */
  finish(pipeline: { columns: BoardColumn[]; stages: Stage[] }, limits?: TeamLimits): ProjectConfig;
}

/** The duty that carries a stage of this kind when no AI owner decides it. */
const KIND_DUTIES: Partial<Record<StageKind, DutyId>> = {
  queue: 'prioritization',
  work: 'implementation',
  release: 'deployment',
};

export const TEMPLATE_COLUMN_COLORS: Record<ColumnKey, BoardColumnColor> = {
  ready: 'gray',
  development: 'blue',
  in_progress: 'blue',
  review: 'purple',
  client_test: 'pink',
  awaiting_merge: 'teal',
  awaiting_release: 'orange',
  done: 'green',
};

function draftProject(templateId: TemplateId, input: BuildTemplateInput): TemplateDraft {
  const locale = getLocale(input.language);
  const members: MemberConfig[] = [
    {
      kind: 'human',
      handle: input.owner.handle,
      displayName: input.owner.displayName,
      access: 'owner',
      // The person who sets up the project runs it and decides what gets built.
      roles: ['operator', 'product_owner'],
      email: input.owner.email,
    },
  ];
  const taken = new Set<string>([input.owner.handle]);
  const perRole = new Map<string, number>();

  return {
    owner: input.owner.handle,

    hire(role, opts = {}) {
      const { specialty } = opts;
      const handle = opts.handle
        ? uniqueHandle(opts.handle, taken)
        : defaultMemberHandle(role, taken, specialty);
      taken.add(handle);
      const specialtyName = specialty ? locale.specialties[specialty] : undefined;
      const countKey = `${opts.name ?? role}:${specialty ?? ''}`;
      const index = (perRole.get(countKey) ?? 0) + 1;
      perRole.set(countKey, index);
      const defaults = aiRoleDefaults(role);
      const displayName = opts.name
        ? `${locale.members[opts.name]}${index > 1 ? ` ${index}` : ''}`
        : defaultMemberName(role, input.language, index, { specialty: specialtyName });
      const member: AiMemberConfig = {
        kind: 'ai',
        handle,
        displayName,
        role,
        ...(specialtyName ? { specialty: specialtyName } : {}),
        model: defaults.model,
        permissionMode: defaults.permissionMode,
        capacity: defaults.capacity,
        instructions: defaults.instructions,
        sponsor: input.owner.handle,
        temp: false,
        ...(opts.schedule ? { schedule: opts.schedule } : {}),
      };
      members.push(member);
      return handle;
    },

    column(key) {
      return {
        color: TEMPLATE_COLUMN_COLORS[key],
        id: key,
        name: locale.columns[key].name,
        hint: locale.columns[key].hint,
      };
    },

    stage(key, kind, column, owners, ...gate) {
      return {
        id: key,
        name: locale.stages[key],
        kind,
        ...(() => {
          if (typeof owners === 'string') return { duty: owners };
          const worker = members.find((m) => owners.includes(m.handle) && m.kind === 'ai');
          const duty =
            worker?.kind === 'ai'
              ? BUILT_IN_ROLE_DUTIES[worker.role as AiBuiltInRoleId][0]
              : KIND_DUTIES[kind];
          return duty ? { duty } : { owners };
        })(),
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
          timezone: locale.timezone,
          templateId,
        },
        team: { members, roles: [], limits },
        pipeline: {
          ...pipeline,
          // The standard labels the gates use, whole groups included.
          labels: standardLabelsFor(
            pipeline.stages.flatMap((stage) => (stage.gate?.conditions ?? []).map((c) => c.label)),
            locale,
          ),
        },
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
