import type { OwnerOnlyChange } from './owner-only';
import { DEFAULT_OWNER_DECISION_TOPICS } from './owner-topics';
import type { ProjectConfig } from './schema';

type Team = ProjectConfig['team'];
type TeamSettingKey = keyof Team;

interface TeamSettingPolicy<T> {
  /** The owner-only change a different effective value is (`ownerOnlyChanges`); null: none of its own. */
  readonly ownerOnly: OwnerOnlyChange | null;
  /** What an absent setting means; without one, the schema or the setting's own rule decides. */
  readonly default?: Readonly<T>;
  /**
   * New projects start with the default and the server's configuration migration writes it into older
   * ones, so a project keeps today's rule when the default changes and restating it is no change.
   */
  readonly stored?: true;
}

/**
 * Every team setting of the project configuration with its policy, the one place for its default (PM-1114).
 * A new setting does not type-check until it is classified here; the owner-only changes follow from it.
 */
export const TEAM_SETTING_POLICY = {
  operatorWatch: { ownerOnly: 'operator_watch', default: 'report' },
  cardMover: {
    ownerOnly: null,
    default: { kind: 'worker' },
    stored: true,
  },
  // PM-1100: a developer or above opens new cards.
  taskCreateAccess: { ownerOnly: 'task_create_access', default: 'developer', stored: true },
  // PM-1094: queue moves and starting work.
  projectManagerMoves: { ownerOnly: null, default: 'queues_and_start', stored: true },
  // PM-1098: the PM reassigns and cancels cards on its own; reopening stays with the admins.
  projectManagerLifecycle: { ownerOnly: null, default: ['assign', 'cancel'], stored: true },
  // PM-204, PM-1099: only people override an open prerequisite.
  prerequisiteOverride: { ownerOnly: null, default: 'people', stored: true },
  // PM-1267: only people involve a member on a card, with their message.
  memberInvolvement: { ownerOnly: null, default: 'people', stored: true },
  // PM-1284: the PM acts on its own only outside the owner-only circle.
  projectManagerAuthority: {
    ownerOnly: 'project_manager_authority',
    default: 'outside_owner_only',
    stored: true,
  },
  // PM-433, PM-1096: the project managers; people and the connected owner always may.
  prioritySetters: { ownerOnly: null, default: ['project_manager'], stored: true },
  // PM-1097: requirements analysis and task breakdown.
  complexitySetters: {
    ownerOnly: null,
    default: ['requirements_analysis', 'task_breakdown'],
    stored: true,
  },
  // PM-1136: only the system's own choice keeps the complexity limit and specialty.
  assigneeFit: { ownerOnly: null, default: 'automatic' },
  // PM-1137: absent reasons show the general ones.
  ruleReasons: { ownerOnly: null },
  // PM-1190: the owner topics an owner decision needs.
  ownerDecisionTopics: {
    ownerOnly: 'owner_decision_topics',
    default: DEFAULT_OWNER_DECISION_TOPICS,
    stored: true,
  },
  // `mergerOf` derives an absent merger from the pipeline; the migration stores it (`addMerger`).
  merger: { ownerOnly: null },
  // PM-1379: the merger's own approval queues the merge (decisions 21, 71, 77, 78); off keeps today's rule.
  mergeAfterReview: { ownerOnly: null, default: false, stored: true },
  startCondition: { ownerOnly: 'project_manager_authority' },
  // PM-1464: the project manager reviews the week on its own; `off` stops it.
  operationsReview: { ownerOnly: null, default: 'weekly' },
  members: { ownerOnly: null },
  contacts: { ownerOnly: null },
  // PM-1102: a read-only viewer writes to the project manager only.
  viewerRecipients: { ownerOnly: null, default: 'project_manager', stored: true },
  roles: { ownerOnly: null },
  roleOverrides: { ownerOnly: null },
  releaseFourEyes: { ownerOnly: 'approval_policy', default: false },
  // Delegation stays off until an owner turns it on.
  boundary: {
    ownerOnly: 'approval_policy',
    default: { enabled: false, leadTimeoutSeconds: 120 },
  },
  limits: { ownerOnly: null },
} as const satisfies { readonly [K in TeamSettingKey]-?: TeamSettingPolicy<NonNullable<Team[K]>> };

export const TEAM_SETTING_KEYS = Object.keys(TEAM_SETTING_POLICY) as TeamSettingKey[];

type DefaultedTeamSetting = {
  [K in TeamSettingKey]: (typeof TEAM_SETTING_POLICY)[K] extends { readonly default: unknown } ? K : never;
}[TeamSettingKey];

function policyOf(key: TeamSettingKey): TeamSettingPolicy<unknown> {
  return TEAM_SETTING_POLICY[key];
}

/** A team setting as the rules read it: the stored value, or its default when absent. */
export function teamSettingValue(config: Pick<ProjectConfig, 'team'>, key: TeamSettingKey): unknown {
  return config.team[key] ?? policyOf(key).default;
}

/** Every team setting by its effective value, so restating a default compares as no change. */
export function effectiveTeamSettings(config: Pick<ProjectConfig, 'team'>): Record<string, unknown> {
  // Keys the schema does not know stay, so a comparison still sees them.
  return {
    ...config.team,
    ...Object.fromEntries(TEAM_SETTING_KEYS.map((key) => [key, teamSettingValue(config, key)])),
  };
}

/** The effective value of a team setting that has a default. */
export function teamSettingOf<K extends DefaultedTeamSetting>(
  config: Pick<ProjectConfig, 'team'>,
  key: K,
): Readonly<NonNullable<Team[K]>> {
  return teamSettingValue(config, key) as Readonly<NonNullable<Team[K]>>;
}

/** The stored defaults (`stored`), as fresh values a new or an older configuration takes in. */
export function storedTeamDefaults(): Partial<Team> {
  return Object.fromEntries(
    TEAM_SETTING_KEYS.flatMap((key) => {
      const policy = policyOf(key);
      return policy.stored ? [[key, structuredClone(policy.default)]] : [];
    }),
  );
}
