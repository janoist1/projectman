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

/** viewer and client can read; developer can work on tasks; admin changes the team; owner everything. */
const ACCESS_RANK: Record<HumanAccess, number> = { viewer: 0, client: 0, developer: 1, admin: 2, owner: 3 };

export function hasAccess(access: HumanAccess, minimum: HumanAccess): boolean {
  return ACCESS_RANK[access] >= ACCESS_RANK[minimum];
}

export const TASK_CREATE_MIN_ACCESS: HumanAccess = 'developer';

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

/** Whether an AI member's commands can reach the network by default. */
export const DEFAULT_OUTBOUND_NETWORK = true;

/**
 * Who answers when the agent CLI asks for a permission (set by an owner, next to the mode):
 * - `human`: a person (the sponsor, else an owner): today's behaviour, and what an absent value means;
 * - `ai`: an AI member holding the boundary authorization duty (needs delegation, see `aiApproverBlocker`);
 * - `none`: nobody: the server refuses the request.
 */
export const Approver = z.enum(['human', 'ai', 'none']);
export type Approver = z.infer<typeof Approver>;

/**
 * The approver a new AI member is hired with: nobody, so the rare question of an Auto member is
 * refused by the system (the owner's answer of 2026-10-01, decision 28). The one place to change it.
 * Existing members keep the absent value, which reads as `human`.
 */
export const DEFAULT_NEW_MEMBER_APPROVER: Approver = 'none';

/**
 * The agent CLI an AI member runs in, on its sponsor's subscription: Claude Code (Claude plan)
 * or OpenAI Codex CLI (ChatGPT plan).
 */
export const AgentProvider = z.enum(['claude', 'codex', 'gemini', 'nanogpt']);
export type AgentProvider = z.infer<typeof AgentProvider>;

/** Provider of members that do not name one. */
export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';

/** Reasoning effort supported by agent members. */
export const AgentEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type AgentEffort = z.infer<typeof AgentEffort>;

export const PROVIDER_EFFORT_OPTIONS: Record<AgentProvider, readonly AgentEffort[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
  gemini: ['low', 'medium', 'high'],
  nanogpt: ['low', 'medium', 'high', 'xhigh'],
};

/** Keep allowed effort, otherwise use the highest; unset means medium except on Claude. */
export function effortForProvider(
  provider: AgentProvider,
  effort: AgentEffort | undefined,
): AgentEffort | undefined {
  const options = PROVIDER_EFFORT_OPTIONS[provider];
  if (!options.length) return undefined;
  if (provider === 'claude') return effort;
  if (!effort) return 'medium';
  return options.includes(effort) ? effort : options[options.length - 1];
}

/**
 * The cheaper model of an AI member's "cheap subagent" (PM-179), a Claude Code alias: the member
 * hands text-heavy, logic-light work (long logs, wide searches, summaries) to a subagent on it.
 */
export const CheapSubagentModel = z.enum(['sonnet', 'haiku']);
export type CheapSubagentModel = z.infer<typeof CheapSubagentModel>;

/** The cheap subagent models each provider supports; none for Codex until it has an equivalent. */
export const PROVIDER_CHEAP_SUBAGENT_MODELS: Record<AgentProvider, readonly CheapSubagentModel[]> = {
  claude: CheapSubagentModel.options,
  codex: [],
  gemini: [],
  nanogpt: [],
};

/**
 * The cheap subagent a member's sessions get: its configured model when the member's provider
 * supports it, otherwise none (the setting is kept but has no effect, e.g. for a Codex member).
 */
export function cheapSubagentOf(member: {
  provider?: AgentProvider;
  cheapSubagent?: CheapSubagentModel;
}): CheapSubagentModel | undefined {
  const model = member.cheapSubagent;
  const provider = member.provider ?? DEFAULT_AGENT_PROVIDER;
  return model && PROVIDER_CHEAP_SUBAGENT_MODELS[provider].includes(model) ? model : undefined;
}

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
