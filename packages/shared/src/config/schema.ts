import { z } from 'zod';
import { AgentEffort } from '../domain/member';
import { AgentProvider, GithubLogin, HumanAccess, MemberHandle, PermissionMode } from '../domain/member';
import { Pipeline } from '../domain/pipeline';
import { DEFAULT_PROVIDER_MODELS } from '../domain/provider-model';
import { CustomRoleDefinition, RoleId, RoleOverrides } from '../domain/role';

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
  githubLogin: GithubLogin.optional(),
  /** What the person may do in the app; separate from the roles they hold. */
  access: HumanAccess,
  /** Roles (responsibilities) the person holds; a human may hold several. */
  roles: z.array(RoleId).default([]),
  /** Links the member to a user account. */
  email: z.string().optional(),
});
export type HumanMemberConfig = z.infer<typeof HumanMemberConfig>;

/**
 * A recurring run of an AI member ("daily worker"): at every `cron` time (five fields,
 * evaluated in the project's time zone) `prompt` starts the member's work. Any AI member may
 * have one; it is not a role.
 */
export const MemberSchedule = z.object({
  cron: z.string().trim().min(1),
  /** What the member is asked to do on each run (English prompt text). */
  prompt: z.string().trim().min(1),
});
export type MemberSchedule = z.infer<typeof MemberSchedule>;

export const AiMemberConfig = z.object({
  kind: z.literal('ai'),
  handle: MemberHandle,
  displayName: z.string().min(1),
  githubLogin: GithubLogin.optional(),
  /** The one role this member holds: a built-in role or one of the team's custom roles. */
  role: RoleId,
  specialty: z.string().optional(),
  /**
   * The agent CLI the member runs in (default "claude"). Parsing fills in the default; the
   * type stays optional so hand-written configs without it remain valid.
   */
  provider: AgentProvider.default('claude').optional(),
  /**
   * Model alias or id, e.g. "opus", "sonnet" (Claude Code) or a Codex model id. Claude aliases
   * are ignored for Codex members, which then use Codex's default model.
   */
  model: z.string().default(DEFAULT_PROVIDER_MODELS.claude),
  /** Agent reasoning effort; omitted values use the provider default. */
  effort: AgentEffort.optional(),
  /** Claude Code permission mode; for Codex members it maps to a sandbox and approval policy. */
  permissionMode: PermissionMode.default('default'),
  /** How many work items this member may run at the same time. */
  capacity: z.number().int().min(1).max(5).default(1),
  /** Role instructions (English prompt text) appended to the system prompt. */
  instructions: z.string().default(''),
  /** Human member whose Claude subscription runs this member. */
  sponsor: MemberHandle,
  /** Temporary stand-in ("beugró"): hired for one task, retired when it is done. */
  temp: z.boolean().default(false),
  /** Recurring runs, e.g. every weekday morning. */
  schedule: MemberSchedule.optional(),
});
export type AiMemberConfig = z.infer<typeof AiMemberConfig>;

export const MemberConfig = z.discriminatedUnion('kind', [HumanMemberConfig, AiMemberConfig]);
export type MemberConfig = z.infer<typeof MemberConfig>;

export const TeamLimits = z.object({
  /**
   * When false, no AI session starts or resumes in this project: automatic hand-overs,
   * message wake-ups, schedules, manual starts and humans writing into a stopped session.
   * Running sessions keep running.
   */
  aiEnabled: z.boolean().default(true),
  /** Global cap on concurrently working AI sessions (protects the subscription). */
  maxConcurrentAi: z.number().int().min(1).max(20).default(3),
  /** Do not start new AI work above this plan usage percentage. */
  pauseAbovePlanUsagePercent: z.number().int().min(10).max(100).default(80),
  tempWorkers: z
    .object({
      enabled: z.boolean().default(false),
      max: z.number().int().min(0).max(5).default(1),
      /** Role a temp worker is hired for (an AI-capable built-in or custom role). */
      role: RoleId.default('developer'),
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

/** Language of projects that do not name one (the team's own language). */
export const DEFAULT_PROJECT_LANGUAGE = 'hu';

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
    language: z.string().default(DEFAULT_PROJECT_LANGUAGE),
    /** IANA time zone of the team, e.g. "Europe/Budapest"; schedules run in it. */
    timezone: z.string().min(1).default('UTC'),
    templateId: z.string().optional(),
  }),
  team: z.object({
    members: z.array(MemberConfig).min(1),
    /** Roles the team defined in addition to the built-in ones. */
    roles: z.array(CustomRoleDefinition).default([]),
    roleOverrides: RoleOverrides.optional(),
    releaseFourEyes: z.boolean().default(false).optional(),
    limits: TeamLimits,
  }),
  pipeline: Pipeline,
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
/** Input form (defaults not yet applied), e.g. for templates and YAML files. */
export type ProjectConfigInput = z.input<typeof ProjectConfig>;
