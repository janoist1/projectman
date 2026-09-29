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
 * The agent CLI an AI member runs in, on its sponsor's subscription: Claude Code (Claude plan)
 * or OpenAI Codex CLI (ChatGPT plan).
 */
export const AgentProvider = z.enum(['claude', 'codex']);
export type AgentProvider = z.infer<typeof AgentProvider>;

/** Provider of members that do not name one. */
export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';

/** Reasoning effort supported by Codex members. */
export const AgentEffort = z.enum(['low', 'medium', 'high', 'xhigh']);
export type AgentEffort = z.infer<typeof AgentEffort>;

/** Runtime status shown on member avatars. Humans: online/offline/invited; AI: idle/working/waiting. */
export const MemberStatus = z.enum([
  'idle',
  'working',
  'waiting_for_human',
  'online',
  'offline',
  'invited',
  'retired',
]);
export type MemberStatus = z.infer<typeof MemberStatus>;
