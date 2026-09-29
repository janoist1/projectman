import { z } from 'zod';
import { AiRole, HumanAccess, MemberHandle, PermissionMode } from '../domain/member';
import { Pipeline } from '../domain/pipeline';

/**
 * Project configuration ("customizations"). Lives as YAML files in a separate git
 * repository (the customization repo), independent from the application source, so
 * every change is a commit that an admin can revert. Display names inside are data in
 * the project's language.
 */

export const HumanMemberConfig = z.object({
  kind: z.literal('human'),
  handle: MemberHandle,
  displayName: z.string().min(1),
  access: HumanAccess,
  /** Links the member to a user account. */
  email: z.string().optional(),
});
export type HumanMemberConfig = z.infer<typeof HumanMemberConfig>;

export const AiMemberConfig = z.object({
  kind: z.literal('ai'),
  handle: MemberHandle,
  displayName: z.string().min(1),
  role: AiRole,
  specialty: z.string().optional(),
  /** Claude Code model alias or id, e.g. "opus", "sonnet". */
  model: z.string().default('opus'),
  permissionMode: PermissionMode.default('default'),
  /** How many work items this member may run at the same time. */
  capacity: z.number().int().min(1).max(5).default(1),
  /** Role instructions (English prompt text) appended to the system prompt. */
  instructions: z.string().default(''),
  /** Human member whose Claude subscription runs this member. */
  sponsor: MemberHandle,
  /** Temporary stand-in ("beugró"): hired for one task, retired when it is done. */
  temp: z.boolean().default(false),
});
export type AiMemberConfig = z.infer<typeof AiMemberConfig>;

export const MemberConfig = z.discriminatedUnion('kind', [HumanMemberConfig, AiMemberConfig]);
export type MemberConfig = z.infer<typeof MemberConfig>;

export const TeamLimits = z.object({
  /** Global cap on concurrently working AI sessions (protects the subscription). */
  maxConcurrentAi: z.number().int().min(1).max(20).default(3),
  /** Do not start new AI work above this plan usage percentage. */
  pauseAbovePlanUsagePercent: z.number().int().min(10).max(100).default(80),
  tempWorkers: z
    .object({
      enabled: z.boolean().default(false),
      max: z.number().int().min(0).max(5).default(1),
      role: AiRole.default('developer'),
    })
    .default({ enabled: false, max: 1, role: 'developer' }),
});
export type TeamLimits = z.infer<typeof TeamLimits>;

export const RepoConfig = z.object({
  /** Short name used in task.repo, e.g. "locked". */
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** Path relative to the workspace root ("." for the root itself). */
  path: z.string(),
  /** GitHub "owner/name", if the repo is on GitHub. */
  github: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
  defaultBranch: z.string().default('main'),
});
export type RepoConfig = z.infer<typeof RepoConfig>;

export const ProjectConfig = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    /** Uppercase project key used in task keys ("AR" -> "AR-21"). */
    key: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
    name: z.string().min(1),
    /** Absolute path of the working directory AI sessions start in. */
    workspacePath: z.string().min(1),
    repos: z.array(RepoConfig),
    /** Language humans and agents communicate in (BCP 47), e.g. "hu". */
    language: z.string().default('hu'),
    templateId: z.string().optional(),
  }),
  team: z.object({
    members: z.array(MemberConfig).min(1),
    limits: TeamLimits,
  }),
  pipeline: Pipeline,
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
/** Input form (defaults not yet applied), e.g. for templates and YAML files. */
export type ProjectConfigInput = z.input<typeof ProjectConfig>;
