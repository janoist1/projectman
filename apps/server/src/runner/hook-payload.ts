import { z } from 'zod';

/**
 * Claude Code hook payloads (the JSON body of an HTTP hook, or stdin of a command hook).
 * Parsed permissively: only what the runner uses is typed, unknown fields pass through,
 * so newer Claude Code versions with extra fields keep working.
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
  /** PermissionRequest: permission updates Claude Code suggests (same shape as updatedPermissions). */
  permission_suggestions: z.array(z.unknown()).optional(),
  /** Notification. */
  notification_type: z.string().optional(),
  message: z.string().optional(),
  /** StopFailure. */
  error: z.unknown().optional(),
  /** SessionEnd. */
  reason: z.string().optional(),
  /** Present when the hook fires inside a subagent. */
  agent_id: z.string().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

/** One entry of `updatedPermissions` / `permission_suggestions`. */
export type PermissionUpdate =
  | {
      type: 'addRules';
      rules: Array<{ toolName: string; ruleContent?: string }>;
      behavior: 'allow';
      destination: 'session';
    }
  | { type: 'setMode'; mode: string; destination: 'session' };

/** Output of a PermissionRequest hook. */
export interface PermissionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision:
      | { behavior: 'allow'; updatedInput?: unknown; updatedPermissions?: PermissionUpdate[] }
      | { behavior: 'deny'; message?: string };
  };
}

const Rule = z.object({ toolName: z.string().min(1), ruleContent: z.string().optional() });
const AddRulesSuggestion = z.looseObject({
  type: z.literal('addRules'),
  rules: z.array(Rule).min(1),
  behavior: z.string().optional(),
});
const SetModeSuggestion = z.looseObject({ type: z.literal('setMode'), mode: z.string() });

/** Modes a remembered "allow for this session" may switch to (never bypass or auto modes). */
const SAFE_SESSION_MODES = new Set(['acceptEdits']);

/**
 * Permission updates that make Claude Code stop asking for the same kind of call in this
 * session: the allow rules (or the accept-edits mode) Claude Code suggested, always scoped to
 * the session so nothing is written to settings files. Without suggestions, the exact call is
 * allowed again: the same Bash command, or the tool itself for other tools.
 */
export function sessionPermissionUpdates(payload: HookPayload): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [];
  for (const raw of payload.permission_suggestions ?? []) {
    const add = AddRulesSuggestion.safeParse(raw);
    if (add.success && (add.data.behavior ?? 'allow') === 'allow') {
      updates.push({
        type: 'addRules',
        rules: add.data.rules.map((r) =>
          r.ruleContent === undefined
            ? { toolName: r.toolName }
            : { toolName: r.toolName, ruleContent: r.ruleContent },
        ),
        behavior: 'allow',
        destination: 'session',
      });
      continue;
    }
    const mode = SetModeSuggestion.safeParse(raw);
    if (mode.success && SAFE_SESSION_MODES.has(mode.data.mode)) {
      updates.push({ type: 'setMode', mode: mode.data.mode, destination: 'session' });
    }
  }
  if (updates.length > 0) return updates;

  const toolName = payload.tool_name;
  if (!toolName) return [];
  const input = payload.tool_input;
  const command =
    input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string'
      ? ((input as Record<string, unknown>).command as string)
      : null;
  const rule = toolName === 'Bash' && command ? { toolName, ruleContent: command } : { toolName };
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }];
}
