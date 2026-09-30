import { z } from 'zod';
import type { PermissionDecision } from '../../../contracts';
import { DENY_DEFAULT, HookPayload, sessionAllowScope } from '../../hook-payload';

/**
 * Claude Code's PermissionRequest hook: its payload (with the permission updates Claude Code
 * suggests) and the documented decision JSON, which can make Claude Code itself remember an
 * "allow for this session".
 */

/** Claude Code's hook payloads: the common fields, plus the PermissionRequest suggestions. */
export const ClaudeHookPayload = HookPayload.extend({
  /** PermissionRequest: permission updates Claude Code suggests (same shape as updatedPermissions). */
  permission_suggestions: z.array(z.unknown()).optional(),
});

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
 * allowed again (see sessionAllowScope): the same Bash command, or the tool itself for other
 * tools.
 */
export function sessionPermissionUpdates(payload: HookPayload): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [];
  const suggestions = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions : [];
  for (const raw of suggestions) {
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

  const scope = sessionAllowScope(payload);
  if (!scope) return [];
  const rule =
    scope.command === undefined
      ? { toolName: scope.toolName }
      : { toolName: scope.toolName, ruleContent: scope.command };
  return [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }];
}

export function denyOutput(message: string): PermissionHookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } },
  };
}

/** The documented PermissionRequest decision JSON for a broker decision. */
export function permissionOutput(decision: PermissionDecision, payload: HookPayload): PermissionHookOutput {
  if (decision.behavior === 'deny') return denyOutput(decision.message?.trim() || DENY_DEFAULT);
  const allow: { behavior: 'allow'; updatedInput?: unknown; updatedPermissions?: PermissionUpdate[] } = {
    behavior: 'allow',
  };
  // Claude Code only accepts an object here; anything else would void the whole decision.
  const input = decision.updatedInput;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) allow.updatedInput = input;
  if (decision.rememberForSession) {
    const updates = sessionPermissionUpdates(payload);
    if (updates.length > 0) allow.updatedPermissions = updates;
  }
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: allow } };
}
