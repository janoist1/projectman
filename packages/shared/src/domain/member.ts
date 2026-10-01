import { z } from 'zod';

/**
 * Stable, unique identifier of a team member within a project ("fe-1", "qa", "owner").
 * Shown next to the display name so humans can tell members apart ("Anna · fe-1").
 */
export const MemberHandle = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes, max 32 chars');
export type MemberHandle = z.infer<typeof MemberHandle>;

/** A team mixes humans and AI members; both appear in the same roster. */
export const MemberKind = z.enum(['human', 'ai']);
export type MemberKind = z.infer<typeof MemberKind>;

/** Access level of a human member. */
export const HumanAccess = z.enum(['owner', 'admin', 'developer', 'client', 'viewer']);
export type HumanAccess = z.infer<typeof HumanAccess>;

/** Claude Code permission modes (passed to `claude --permission-mode`). */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * The modes an owner can pick for a member (the CLI's own modes, as in Claude Desktop). Not
 * `bypassPermissions`: an existing one stays readable as a legacy setting but cannot be chosen.
 */
export const SelectablePermissionMode = PermissionMode.exclude(['bypassPermissions']);
export type SelectablePermissionMode = z.infer<typeof SelectablePermissionMode>;

/** The mode every new AI member starts in, whatever its role or provider. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * Who answers when the agent CLI asks for a permission (set by an owner, next to the mode):
 * - `human`: a person (the sponsor, else an owner): today's behaviour, and what an absent value means;
 * - `ai`: an AI member holding the boundary authorization duty (needs delegation, see `aiApproverBlocker`);
 * - `none`: nobody: the server refuses the request.
 */
export const Approver = z.enum(['human', 'ai', 'none']);
export type Approver = z.infer<typeof Approver>;

/**
 * The approver a new AI member is hired with, the one place to change it once the owner decides
 * (open question on PM-162). `undefined` writes nothing, so the member is asked like a person (`human`).
 */
export const DEFAULT_NEW_MEMBER_APPROVER: Approver | undefined = undefined;

/**
 * The agent CLI an AI member runs in, on its sponsor's subscription: Claude Code (Claude plan)
 * or OpenAI Codex CLI (ChatGPT plan).
 */
export const AgentProvider = z.enum(['claude', 'codex']);
export type AgentProvider = z.infer<typeof AgentProvider>;

/** Provider of members that do not name one. */
export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';

/** Reasoning effort supported by agent members. */
export const AgentEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type AgentEffort = z.infer<typeof AgentEffort>;

export const PROVIDER_EFFORT_OPTIONS: Record<AgentProvider, readonly AgentEffort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};

/** Runtime status shown on member avatars. Humans: online/offline/invited/no_account; AI: idle/working/waiting. */
export const MemberStatus = z.enum([
  'idle',
  'working',
  'waiting_for_human',
  'online',
  'offline',
  'invited',
  'no_account',
  'retired',
]);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** GitHub account used to attribute pull requests to a team member. */
export const GithubLogin = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i);
export type GithubLogin = z.infer<typeof GithubLogin>;
