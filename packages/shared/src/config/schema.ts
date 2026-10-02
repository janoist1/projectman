import { z } from 'zod';
import { AgentEffort, CheapSubagentModel } from '../domain/member';
import {
  AgentProvider,
  Approver,
  GithubLogin,
  HumanAccess,
  MemberHandle,
  PermissionMode,
} from '../domain/member';
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

/**
 * The size in tokens at which Claude Code compacts a conversation (PM-212): Claude Code 2.1.284
 * accepts 100k to 1M. Passed as the `autoCompactWindow` setting, as a number: a string such as
 * "200k" is ignored there.
 */
export const AutoCompactWindowTokens = z.number().int().min(100_000).max(1_000_000);

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
  /**
   * The size at which Claude Code compacts this member's conversation (PM-212); absent: the
   * project's `autoCompactWindowTokens`. Only Claude Code members use it (Codex ignores it).
   */
  autoCompactWindowTokens: AutoCompactWindowTokens.optional(),
  /**
   * The model of the member's cheap subagent (PM-179); absent means off. Only Claude Code members
   * get one (`cheapSubagentOf`).
   */
  cheapSubagent: CheapSubagentModel.optional(),
  /** Claude Code permission mode; for Codex members it maps to a sandbox and approval policy. */
  permissionMode: PermissionMode.default('default'),
  /**
   * Who answers when the CLI asks for a permission (set by an owner). Absent means a person
   * (`approverOf`), which is how members behaved before the setting existed.
   */
  approver: Approver.optional(),
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
  /**
   * On leave (decision 23): nothing starts a session for this member and it is not picked as an
   * assignee or stage owner. Absent means at work (see `isOnLeave`).
   */
  onLeave: z.boolean().optional(),
});
export type AiMemberConfig = z.infer<typeof AiMemberConfig>;

export const MemberConfig = z.discriminatedUnion('kind', [HumanMemberConfig, AiMemberConfig]);
export type MemberConfig = z.infer<typeof MemberConfig>;

export const MaxConcurrentAi = z.number().int().min(1).max(20);

/**
 * The compaction window of a session whose member and project set none (PM-212). Not the CLI's own
 * default (the model's whole window): that would leave a conversation to grow, and be re-read at
 * every step, up to the end of it.
 */
export const DEFAULT_AUTO_COMPACT_WINDOW_TOKENS = 200_000;

/** The compaction window of a member's sessions: its own value, else the project's, else the default. */
export function autoCompactWindowOf(
  limits: { autoCompactWindowTokens?: number },
  member: { autoCompactWindowTokens?: number },
): number {
  return (
    member.autoCompactWindowTokens ?? limits.autoCompactWindowTokens ?? DEFAULT_AUTO_COMPACT_WINDOW_TOKENS
  );
}

/** The free disk space (GB) below which no new AI session starts and the owners are warned (PM-243); 0 is off. */
export const MinFreeDiskGb = z.number().int().min(0).max(10_000);
export const DEFAULT_MIN_FREE_DISK_GB = 10;

/** A session's warning limit in tokens, as `limitTokens` counts them (PM-187). */
export const WarnAboveSessionTokens = z.number().int().min(10_000).max(1_000_000_000);

/**
 * The message storm threshold of a card (PM-186): `count` team messages and notes within `minutes`
 * minutes raise one warning to the owners.
 */
export const MessageBurst = z.object({
  count: z.number().int().min(3).max(100),
  minutes: z.number().int().min(1).max(240),
});
export type MessageBurst = z.infer<typeof MessageBurst>;

/** The threshold of a project that does not set one: 10 messages and notes in 15 minutes. */
export const DEFAULT_MESSAGE_BURST: MessageBurst = { count: 10, minutes: 15 };

export const TeamLimits = z.object({
  /**
   * When false, no AI session starts or resumes in this project: automatic hand-overs,
   * message wake-ups, schedules, manual starts and humans writing into a stopped session.
   * Running sessions keep running.
   */
  aiEnabled: z.boolean().default(true),
  /**
   * Optional cap on concurrently working AI sessions across the project. Absent: no cap (decision
   * 23); the members' capacities and `pauseAbovePlanUsagePercent` still limit the work.
   */
  maxConcurrentAi: MaxConcurrentAi.optional(),
  /** Do not start new AI work above this plan usage percentage. */
  pauseAbovePlanUsagePercent: z.number().int().min(10).max(100).default(80),
  /**
   * A session whose usage (`limitTokens`) reaches this many tokens raises one warning to the owners
   * (PM-187); the session keeps running. Absent: no warning.
   */
  warnAboveSessionTokens: WarnAboveSessionTokens.optional(),
  /**
   * Below this much free disk space (GB, where the installation keeps its data) the owners get one
   * warning and no new AI session starts until there is room again; running ones finish their step
   * (PM-243). 0 turns it off.
   */
  minFreeDiskGb: MinFreeDiskGb.default(DEFAULT_MIN_FREE_DISK_GB),
  /**
   * The size in tokens at which Claude Code compacts a member's conversation (PM-212); a member's
   * own value overrides it. Absent: `DEFAULT_AUTO_COMPACT_WINDOW_TOKENS`. It bounds what every step
   * re-reads; Codex members are not affected.
   */
  autoCompactWindowTokens: AutoCompactWindowTokens.optional(),
  /**
   * How many team messages and notes on one card within how long make a message storm that is
   * warned about (PM-186). Absent: `DEFAULT_MESSAGE_BURST`.
   */
  messageBurst: MessageBurst.optional(),
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
    /** Owner-controlled delegation; absent configurations keep delegation disabled. */
    boundary: z
      .object({
        enabled: z.boolean().default(false),
        leadTimeoutSeconds: z.number().int().min(1).max(600).default(120),
      })
      .optional(),
    limits: TeamLimits,
  }),
  pipeline: Pipeline,
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;
/** Input form (defaults not yet applied), e.g. for templates and YAML files. */
export type ProjectConfigInput = z.input<typeof ProjectConfig>;
