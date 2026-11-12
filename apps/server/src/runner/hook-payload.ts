import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { claudeFileToolPaths } from './tool-decision';
import { applyPatchText, patchPaths } from './tools';

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
  /** PreCompact and PostCompact (Claude Code): "manual" (a typed /compact) or "auto". */
  trigger: z.string().optional(),
  /** PreCompact: the instruction a manual /compact was given. */
  custom_instructions: z.string().optional(),
  /** Present when the hook fires inside a subagent. */
  agent_id: z.string().optional(),
  /** SubagentStop (Claude Code): the subagent's kind and its own transcript (PM-178). */
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

/** The message of a PermissionRequest denial when the human gave no reason. */
export const DENY_DEFAULT = 'A human denied this permission request.';

/** What an "allow for this session" of a permission request covers (see sessionAllowScope). */
interface SessionAllowScope {
  toolName: string;
  /** The exact Bash command; absent for other tools. */
  command?: string;
  /** The folders a path tool call worked in, sorted; absent for tools without a path. */
  directories?: string[];
}

/** File tools whose path names a file; for the other path tools the path is the folder itself. */
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);

/** The folders a path tool call works in, or null for a tool without a path (see sessionAllowScope). */
function toolDirectories(payload: HookPayload, toolName: string): string[] | null {
  const input = payload.tool_input;
  const cwd = payload.cwd ?? '';
  if (toolName === 'apply_patch') {
    // Codex edits with a patch: every file it touches counts, and one that names none is not remembered.
    const patch = applyPatchText(input);
    const files = patch ? patchPaths(patch) : [];
    return [...new Set(files.map((file) => dirname(resolve(cwd || '.', file))))].sort();
  }
  const found = toolName === 'LS' ? lsPaths(input) : claudeFileToolPaths(toolName, input)?.paths;
  if (!found) return null;
  // A call without a path works in the working directory.
  const paths = found.length > 0 ? found : [cwd || '.'];
  const folders = paths.map((path) => {
    const absolute = resolve(cwd || '.', path);
    return FILE_PATH_TOOLS.has(toolName) ? dirname(absolute) : absolute;
  });
  return [...new Set(folders)].sort();
}

function lsPaths(input: unknown): string[] {
  const path = input && typeof input === 'object' ? (input as Record<string, unknown>).path : undefined;
  return typeof path === 'string' && path ? [path] : [];
}

/**
 * What an "allow for this session" covers when nothing more specific is known: the same Bash
 * command again, the same tool in the same folders for a path tool (Read, Edit, Grep, Codex's
 * apply_patch and the like), or the tool itself for any other tool. Null when there is nothing
 * to remember: no tool, a Bash call without a command, or an apply_patch naming no file.
 */
export function sessionAllowScope(payload: HookPayload): SessionAllowScope | null {
  const toolName = payload.tool_name;
  if (!toolName) return null;
  if (toolName !== 'Bash') {
    const directories = toolDirectories(payload, toolName);
    if (directories?.length === 0) return null;
    return directories ? { toolName, directories } : { toolName };
  }
  const input = payload.tool_input;
  const command = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
  return typeof command === 'string' && command ? { toolName, command } : null;
}
