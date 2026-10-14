import { TaskKey } from '@projectman/shared';

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { TeamToolsHandler, ToolContext } from '../contracts';

/**
 * The team tools as the agent sees them (mcp__team__<name>). Names, descriptions and input
 * schemas are the prompt: they tell the model when and how to use each tool. Rules that are
 * not about one tool (the project's language, being concise, recording results on the task)
 * are stated once in the member's system prompt (src/context), which both providers receive;
 * they are not repeated here. Input is validated by the MCP SDK against the zod schema before
 * `run` is called.
 */
export const TEAM_TOOL_NAMES = [
  'operate',
  'read_project_doc',
  'write_project_docs',
  'list_decision_candidates',
  'mark_decision_candidates',
  'screen_question',
  'start_task',
  'start_member',
  'submit_boundary_request',
  'get_boundary_request',
  'decide_boundary_request',
  'decide_permission_request',
  'decide_fix_limit',
  'hand_off',
  'send_message',
  'list_members',
  'get_task',
  'get_project_state',
  'list_tasks',
  'merge_task',
  'prioritize_merge',
  'propose_release',
  'check_release',
  'update_task',
  'create_task',
  'link_pull_request',
  'ask_human',
  'withdraw_question',
  'save_memory',
  'set_current_work',
  'list_attachments',
  'read_attachment',
  'read_message_attachment',
  'attach_file',
  'take_screenshots',
  'get_screenshot_run',
  'delete_attachment',
  'get_feedback',
  'reply_feedback',
  'create_task_from_feedback',
  'link_feedback',
  'forward_feedback',
  'close_feedback',
] as const;
export type TeamToolName = (typeof TEAM_TOOL_NAMES)[number];

export interface ToolRun<Args> {
  ctx: ToolContext;
  args: Args;
  handler: TeamToolsHandler;
}

/** An image a tool hands to the model, next to its text (PM-516). */
export interface ToolImage {
  data: Buffer;
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg' | 'image/gif';
}

/** A tool answer with images; a plain string is a text-only answer. */
export interface ToolOutput {
  text: string;
  images: ToolImage[];
}

/** The text of a tool answer, with or without images. */
export function toolOutputText(output: string | ToolOutput): string {
  return typeof output === 'string' ? output : output.text;
}

export interface TeamTool {
  readonly name: TeamToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  /** Runs the tool with validated arguments and returns the text result, or the text with images. */
  run(call: ToolRun<Record<string, unknown>>): Promise<string | ToolOutput>;
}

type ToolInput<Shape extends z.core.$ZodLooseShape> = z.output<z.ZodObject<Shape, z.core.$strict>>;

export function defineTool<Shape extends z.core.$ZodLooseShape>(def: {
  name: TeamToolName;
  title: string;
  description: string;
  readOnly: boolean;
  /** The tool removes something that cannot be brought back (default false). */
  destructive?: boolean;
  /** Unknown parameters with a specific refusal instead of a generic schema error. */
  refused?: Record<string, string>;
  input: Shape;
  /**
   * Rules that span several parameters (e.g. a recommendation must name one of the options).
   * `issue` reports a problem with one parameter; the call is refused before `run`, with the
   * message, like any other invalid input.
   */
  check?(args: ToolInput<Shape>, issue: (parameter: string, message: string) => void): void;
  run(call: ToolRun<ToolInput<Shape>>): Promise<string | ToolOutput>;
}): TeamTool {
  // Strict: an unknown key (e.g. a misspelled parameter) is an error instead of being ignored.
  const schema = z.strictObject(def.input, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => def.refused?.[key]).find((reason) => reason !== undefined)
        : undefined,
  });
  const { check } = def;
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: check
      ? schema.superRefine((args, ctx) =>
          check(args, (parameter, message) => ctx.addIssue({ code: 'custom', path: [parameter], message })),
        )
      : schema,
    annotations: {
      title: def.title,
      readOnlyHint: def.readOnly,
      destructiveHint: def.destructive ?? false,
      openWorldHint: false,
    },
    // The SDK has already validated the arguments against inputSchema.
    run: async (call) => def.run(call as ToolRun<ToolInput<Shape>>),
  };
}
/** One module's team tools (PM-592): served by the collector in tools.ts. */
export interface TeamToolGroup {
  /** The module id in apps/server/test/architecture/module-map.ts, e.g. 'core/tasks'. */
  readonly module: string;
  readonly tools: readonly TeamTool[];
}

export const MAX_PATH_CHARS = 4_096;

export const unique = <T>(items: T[]): T[] => [...new Set(items)];

export const taskKeyInput = TaskKey.describe('Task key, e.g. "AR-21".');
