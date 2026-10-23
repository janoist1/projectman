import { TaskKey } from '@projectman/shared';

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  ExternalCredentialMode,
  ExternalToolContext,
  ExternalToolsHandler,
  IntegratorPrincipal,
  TeamToolsHandler,
  ToolContext,
} from '../contracts';

/**
 * The team tools as the agent sees them (mcp__team__<name>). Names, descriptions and input
 * schemas are the prompt: they tell the model when and how to use each tool. Rules that are
 * not about one tool (the project's language, being concise, recording results on the task)
 * are stated once in the member's system prompt (src/context), which both providers receive;
 * they are not repeated here. Input is validated by the MCP SDK against the zod schema before
 * `run` is called.
 */
export const TEAM_TOOL_NAMES = [
  'get_role_configuration',
  'get_operator_preference',
  'get_operator_knowledge',
  'propose_operator_knowledge',
  'set_operator_preference',
  'operate',
  'execute_operation',
  'get_operation',
  'get_machine_status',
  'get_machine_logs',
  'read_project_doc',
  'write_project_docs',
  'list_system_feedback',
  'record_system_feedback',
  'list_decision_candidates',
  'mark_decision_candidates',
  'search_history',
  'read_history_source',
  'get_history_search_stats',
  'screen_question',
  'combine_questions',
  'dismiss_signal',
  'open_integrator_todo',
  'request_structural_review',
  'triage_loop',
  'start_task',
  'start_member',
  'submit_boundary_request',
  'get_boundary_request',
  'decide_boundary_request',
  'decide_permission_request',
  'decide_fix_limit',
  'finish_queue_item',
  'hand_off',
  'send_message',
  'send_email',
  'set_email_contact',
  'list_email_contacts',
  'list_members',
  'get_task',
  'get_project_state',
  'get_operator_diagnostics',
  'list_tasks',
  'merge_task',
  'prioritize_merge',
  'list_merge_checks',
  'propose_release',
  'publish_release',
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

interface ToolRun<Args> {
  ctx: ToolContext;
  args: Args;
  handler: TeamToolsHandler;
}

/** An image a tool hands to the model, next to its text (PM-516). */
interface ToolImage {
  data: Buffer;
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg' | 'image/gif';
}

/** A tool answer with images; a plain string is a text-only answer. */
interface ToolOutput {
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
  /**
   * How the same tool is served to the integrator's bearer endpoint (PM-760). A tool without this binding is
   * denied there: a new shared tool is never open to an external caller by default.
   */
  readonly external?: ExternalTool;
  /** Runs the tool with validated arguments and returns the text result, or the text with images. */
  run(call: ToolRun<Record<string, unknown>>): Promise<string | ToolOutput>;
}

/** The Streamable HTTP project key argument every project-bound external tool takes (PM-760). */
export const ProjectKeyArg = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}$/)
  .describe('Project key, e.g. "PM": the project this call is about. Every call names its project.');

interface ExternalToolRun<Args> {
  ctx: ExternalToolContext;
  args: Args;
  handler: ExternalToolsHandler;
}

/**
 * An answer that is data: it is returned as text and as the structured content of the tool result. The text
 * is the JSON unless the tool gives a readable one (`text`; PM-714: the full body of an item, line breaks and all).
 */
export interface ExternalStructured {
  structured: Record<string, unknown>;
  text?: string;
}

/** read: a read-only key may call it too; write: only the super and legacy keys. */
type ExternalAccess = 'read' | 'write';

/** The credential modes that are offered, and may call, a tool of each access class. */
const EXTERNAL_MODES: Record<ExternalAccess, readonly ExternalCredentialMode[]> = {
  read: ['super', 'read', 'legacy'],
  write: ['super', 'legacy'],
};

/** The call of a tool that belongs to no project (`list_projects`): the key, not a project context. */
interface ExternalProjectlessRun<Args> {
  principal: IntegratorPrincipal;
  requestId: string;
  args: Args;
  handler: ExternalToolsHandler;
}

interface ExternalToolBase {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly annotations: ToolAnnotations;
  readonly access: ExternalAccess;
  readonly modes: readonly ExternalCredentialMode[];
}

export type ExternalResult = string | ToolOutput | ExternalStructured;

/** One tool of the bearer endpoint: its own schema (with `project_key`), the modes that see it, and its run. */
export interface ExternalTool extends ExternalToolBase {
  readonly projectless: false;
  run(call: ExternalToolRun<Record<string, unknown>>): Promise<ExternalResult>;
}

/** A tool of the bearer endpoint that takes no `project_key`. */
export interface ExternalProjectlessTool extends ExternalToolBase {
  readonly projectless: true;
  run(call: ExternalProjectlessRun<Record<string, unknown>>): Promise<ExternalResult>;
}

export type ExternalRegisteredTool = ExternalTool | ExternalProjectlessTool;

/** What a shared tool definition declares to be served externally; see `defineTool`. */
interface ExternalBinding<Args> {
  access: ExternalAccess;
  /** The description the bearer endpoint shows when the member one speaks of who may call it. */
  description?: string;
  /** Parameters of the member schema the bearer endpoint does not take (session file paths, PM-only signals). */
  omit?: readonly string[];
  /** Overrides the modes of the access class, e.g. a tool only the super mode calls (PM-784). */
  modes?: readonly ExternalCredentialMode[];
  run(call: ExternalToolRun<Args>): Promise<ExternalResult>;
}

type ToolInput<Shape extends z.core.$ZodLooseShape> = z.output<z.ZodObject<Shape, z.core.$strict>>;

function externalSchema(
  shape: z.core.$ZodLooseShape,
  omit: readonly string[],
  refused: Record<string, string> | undefined,
  check: ((args: never, issue: (parameter: string, message: string) => void) => void) | undefined,
): z.ZodObject {
  const kept = Object.fromEntries(Object.entries(shape).filter(([key]) => !omit.includes(key)));
  const schema = z.strictObject(
    { project_key: ProjectKeyArg, ...kept },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => refused?.[key]).find((reason) => reason !== undefined)
          : undefined,
    },
  );
  if (!check) return schema;
  const run = check as (args: unknown, issue: (parameter: string, message: string) => void) => void;
  return schema.superRefine((args, ctx) =>
    run(args, (parameter, message) => ctx.addIssue({ code: 'custom', path: [parameter], message })),
  );
}

interface ExternalToolDefinition {
  name: string;
  title: string;
  description: string;
  access: ExternalAccess;
  /** Overrides the modes of the access class, e.g. a tool only the super mode calls. */
  modes?: readonly ExternalCredentialMode[];
}

function externalBase(def: ExternalToolDefinition, inputSchema: z.ZodObject): ExternalToolBase {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema,
    annotations: {
      title: def.title,
      readOnlyHint: def.access === 'read',
      destructiveHint: false,
      openWorldHint: false,
    },
    access: def.access,
    modes: def.modes ?? EXTERNAL_MODES[def.access],
  };
}

/** An external-only tool (no member counterpart) of a project: the super tools. */
export function defineExternalTool<Shape extends z.core.$ZodLooseShape>(
  def: ExternalToolDefinition & {
    input: Shape;
    run(call: ExternalToolRun<ToolInput<Shape>>): Promise<ExternalResult>;
  },
): ExternalTool {
  return {
    ...externalBase(def, z.strictObject({ project_key: ProjectKeyArg, ...def.input })),
    projectless: false,
    run: async (call) => def.run(call as ExternalToolRun<ToolInput<Shape>>),
  };
}

/** An external-only tool that belongs to no project: `list_projects`. */
export function defineProjectlessTool<Shape extends z.core.$ZodLooseShape>(
  def: ExternalToolDefinition & {
    input: Shape;
    run(call: ExternalProjectlessRun<ToolInput<Shape>>): Promise<ExternalResult>;
  },
): ExternalProjectlessTool {
  return {
    ...externalBase(def, z.strictObject(def.input)),
    projectless: true,
    run: async (call) => def.run(call as ExternalProjectlessRun<ToolInput<Shape>>),
  };
}

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
  /** Serves the tool to the bearer endpoint as well (PM-760); without it the tool is denied there. */
  external?: ExternalBinding<ToolInput<Shape>>;
  /**
   * Instead of `external`: a full external tool (PM-784) for a tool whose external input differs from the
   * member's, e.g. no file path. It must carry the member tool's name.
   */
  externalTool?: ExternalTool;
  run(call: ToolRun<ToolInput<Shape>>): Promise<string | ToolOutput>;
}): TeamTool {
  // Strict: an unknown key (e.g. a misspelled parameter) is an error instead of being ignored.
  const schema = z.strictObject(def.input, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => def.refused?.[key]).find((reason) => reason !== undefined)
        : undefined,
  });
  const { check, external, externalTool } = def;
  if (externalTool && externalTool.name !== def.name)
    throw new Error(`the external tool of ${def.name} is named ${externalTool.name}`);
  return {
    ...(external
      ? {
          external: {
            name: def.name,
            title: def.title,
            description: external.description ?? def.description,
            inputSchema: externalSchema(def.input, external.omit ?? [], def.refused, check),
            annotations: {
              title: def.title,
              readOnlyHint: def.readOnly,
              destructiveHint: def.destructive ?? false,
              openWorldHint: false,
            },
            access: external.access,
            modes: external.modes ?? EXTERNAL_MODES[external.access],
            projectless: false,
            run: async (call: ExternalToolRun<Record<string, unknown>>) =>
              external.run(call as ExternalToolRun<ToolInput<Shape>>),
          } satisfies ExternalTool,
        }
      : externalTool
        ? { external: externalTool }
        : {}),
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
