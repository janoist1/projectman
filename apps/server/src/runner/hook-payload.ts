import { z } from 'zod';

/**
 * Hook payloads as the runner handles them (the JSON body of an HTTP hook, or stdin of a
 * command hook). Every provider validates its own payloads into this shape
 * (`ProviderAdapter.parseHook`). Parsed permissively: only what the runner uses is typed,
 * unknown fields pass through, so newer CLI versions with extra fields keep working.
 */
export const HookPayload = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  /** SessionStart: startup | resume | clear | compact | fork. */
  source: z.string().optional(),
  /** UserPromptSubmit. */
  prompt: z.string().optional(),
  /** Tool events and PermissionRequest. */
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  /** Notification. */
  notification_type: z.string().optional(),
  message: z.string().optional(),
  /** StopFailure. */
  error: z.unknown().optional(),
  /** SessionEnd. */
  reason: z.string().optional(),
  /** PermissionDenied (Claude Code's auto mode): why the call was refused. */
  denial_reason: z.string().optional(),
  /** Present when the hook fires inside a subagent. */
  agent_id: z.string().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

/** The message of a PermissionRequest denial when the human gave no reason. */
export const DENY_DEFAULT = 'A human denied this permission request.';

/** What an "allow for this session" of a permission request covers (see sessionAllowScope). */
export interface SessionAllowScope {
  toolName: string;
  /** The exact Bash command; absent for other tools. */
  command?: string;
}

/**
 * What an "allow for this session" covers when nothing more specific is known: the same Bash
 * command again, or the tool itself for any other tool. Null when there is nothing to remember:
 * no tool, or a Bash call without a command.
 */
export function sessionAllowScope(payload: HookPayload): SessionAllowScope | null {
  const toolName = payload.tool_name;
  if (!toolName) return null;
  if (toolName !== 'Bash') return { toolName };
  const input = payload.tool_input;
  const command = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
  return typeof command === 'string' && command ? { toolName, command } : null;
}
