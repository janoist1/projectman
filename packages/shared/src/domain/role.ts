import { z } from 'zod';

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

/** Who may hold each built-in role. */
export const BUILT_IN_ROLE_HOLDERS: Record<BuiltInRoleId, RoleHolders> = {
  operator: 'human',
  product_owner: 'human',
  project_manager: 'both',
  business_analyst: 'both',
  architect: 'both',
  designer: 'both',
  developer: 'both',
  code_review: 'both',
  security_review: 'both',
  qa: 'both',
  devops: 'both',
  communication: 'both',
  support: 'both',
  researcher: 'both',
  maintainer: 'both',
  coach: 'both',
  watchdog: 'ai',
  content: 'both',
  translator: 'both',
  docs: 'both',
};

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
  holders: RoleHolders,
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
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'holders'>[] = [],
): RoleHolders | null {
  if (isBuiltInRole(id)) return BUILT_IN_ROLE_HOLDERS[id];
  return customRoles.find((role) => role.id === id)?.holders ?? null;
}
