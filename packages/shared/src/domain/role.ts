import { z } from 'zod';
import { DUTIES, DutyId } from './duty';

/**
 * Team roles. An AI member holds exactly one role; a human member may hold several.
 * Roles describe responsibilities; access levels (owner, admin, client, …) describe what a
 * human may do in the app and are separate.
 *
 * Built-in roles ship with the app (display names and descriptions live in the templates
 * package locales). Teams may add custom roles in their configuration.
 */
export const RoleId = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase letters, digits and underscores');
export type RoleId = z.infer<typeof RoleId>;

/** Who may hold a role. */
export const RoleHolders = z.enum(['human', 'ai', 'both']);
export type RoleHolders = z.infer<typeof RoleHolders>;

export const BUILT_IN_ROLE_IDS = [
  'operator',
  'product_owner',
  'project_manager',
  'business_analyst',
  'architect',
  'designer',
  'developer',
  'code_review',
  'security_review',
  'qa',
  'devops',
  'communication',
  'support',
  'researcher',
  'maintainer',
  'coach',
  'watchdog',
  'content',
  'translator',
  'docs',
] as const;

export const BuiltInRoleId = z.enum(BUILT_IN_ROLE_IDS);
export type BuiltInRoleId = z.infer<typeof BuiltInRoleId>;

/** Default bundles; a team override replaces the entire bundle. */
export const BUILT_IN_ROLE_DUTIES: Record<BuiltInRoleId, DutyId[]> = {
  operator: ['final_decision', 'release_approval', 'monitoring'],
  product_owner: ['prioritization', 'requirements_analysis', 'testing_acceptance', 'final_decision'],
  project_manager: ['scheduling', 'triage', 'standup_facilitation', 'refinement_facilitation'],
  business_analyst: ['requirements_analysis', 'task_breakdown'],
  architect: ['technical_direction', 'task_breakdown'],
  designer: ['ux_design'],
  developer: ['implementation'],
  code_review: ['code_review'],
  security_review: ['security_review'],
  qa: ['testing_acceptance'],
  devops: ['deployment', 'monitoring'],
  communication: ['client_communication'],
  support: ['support', 'triage'],
  researcher: ['research'],
  maintainer: ['maintenance'],
  coach: ['retro_facilitation', 'process_improvement'],
  watchdog: ['monitoring'],
  content: ['content'],
  translator: ['translation'],
  docs: ['docs'],
};
export const RoleBundle = z.object({
  duties: z.array(DutyId).refine((ids) => new Set(ids).size === ids.length, 'duplicate duties'),
  instructions: z.string().default(''),
});
export type RoleBundle = z.infer<typeof RoleBundle>;
export const RoleOverrides = z.partialRecord(BuiltInRoleId, RoleBundle);
export type RoleOverrides = Partial<Record<BuiltInRoleId, RoleBundle>>;

/** Intersection; null means mutually incompatible duties. Empty bundles allow both. */
export function dutyHolders(duties: readonly DutyId[]): RoleHolders | null {
  const human = duties.every((id) => DUTIES[id].holders !== 'ai');
  const ai = duties.every((id) => DUTIES[id].holders !== 'human');
  return human && ai ? 'both' : human ? 'human' : ai ? 'ai' : null;
}
/** Compatibility export derived from defaults, never a separate policy table. */
export const BUILT_IN_ROLE_HOLDERS = Object.fromEntries(
  BUILT_IN_ROLE_IDS.map((id) => [id, dutyHolders(BUILT_IN_ROLE_DUTIES[id])!]),
) as Record<BuiltInRoleId, RoleHolders>;

export function isBuiltInRole(id: string): id is BuiltInRoleId {
  return (BUILT_IN_ROLE_IDS as readonly string[]).includes(id);
}

/** A team-defined role, stored in the customization repo. Texts are in the project's language. */
export const CustomRoleDefinition = z.object({
  id: RoleId,
  name: z.string().min(1).max(60),
  /** What the role does, one or two short sentences. */
  summary: z.string().min(1).max(280),
  /** What the role does not do, one short sentence (keeps roles apart). */
  notTheirJob: z.string().max(200).default(''),
  /** Legacy eligibility for roles without duties; explicit duties determine eligibility. */
  holders: RoleHolders.default('both'),
  duties: z
    .array(DutyId)
    .refine((ids) => new Set(ids).size === ids.length, 'duplicate duties')
    .optional(),
  /** Instructions for AI members holding this role (prompt text). */
  instructions: z.string().default(''),
});
export type CustomRoleDefinition = z.infer<typeof CustomRoleDefinition>;

/** Built-in roles an AI member may hold (holders "ai" or "both"). */
export type AiBuiltInRoleId = Exclude<BuiltInRoleId, 'operator' | 'product_owner'>;
export const AI_BUILT_IN_ROLE_IDS: readonly AiBuiltInRoleId[] = BUILT_IN_ROLE_IDS.filter(
  (id): id is AiBuiltInRoleId => BUILT_IN_ROLE_HOLDERS[id] !== 'human',
);

/** Whether a role with these holders may be held by a member of this kind. */
export function holdersAllow(holders: RoleHolders, kind: 'human' | 'ai'): boolean {
  return holders === 'both' || holders === kind;
}

/**
 * Who may hold a role: the built-in role, else the team's custom role with that id (a custom
 * role never replaces a built-in one). Null when the role is unknown.
 */
export function roleHolders(
  id: string,
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'holders' | 'duties'>[] = [],
  overrides: RoleOverrides = {},
): RoleHolders | null {
  if (isBuiltInRole(id)) return dutyHolders(overrides[id]?.duties ?? BUILT_IN_ROLE_DUTIES[id]);
  const role = customRoles.find((role) => role.id === id);
  return role ? (role.duties === undefined ? role.holders : dutyHolders(role.duties)) : null;
}

/** In-memory compatibility for custom roles written before duties existed. */
export function customRoleDuties(role: Pick<CustomRoleDefinition, 'duties' | 'holders'>): DutyId[] {
  return role.duties ?? [];
}
