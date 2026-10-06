import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { SessionPolicy } from '../../../contracts';
import type { HookPayload } from '../../hook-payload';
import {
  decideToolCall,
  toolPathForms,
  type NormalizedToolCall,
  type ToolDecision,
} from '../../tool-decision';

const Payload = z.looseObject({
  conversationId: z.uuid(),
  transcriptPath: z.string().optional(),
  workspacePaths: z.array(z.string()).optional(),
  stepIdx: z.number().int().nonnegative().optional(),
  toolCall: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
  error: z.string().optional(),
  fullyIdle: z.boolean().optional(),
});
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export const GEMINI_SCHEDULE_MAX_SECONDS = 600;

const ControlMetadata = {
  toolAction: z.string().optional(),
  toolSummary: z.string().optional(),
};
const ControlNumber = z
  .union([z.number().finite(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().finite());
const CommandStatus = z
  .object({ CommandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), ...ControlMetadata })
  .catchall(z.union([ControlNumber, z.string().regex(/^[A-Za-z]{1,16}$/)]));
const Schedule = z.strictObject({
  DurationSeconds: ControlNumber.pipe(z.number().int().min(1).max(GEMINI_SCHEDULE_MAX_SECONDS)),
  Prompt: z.string().min(1).max(2000),
  ...ControlMetadata,
});
const TaskStatus = z.strictObject({
  Action: z.literal('status'),
  TaskId: z.string().min(1).max(1024),
  ...ControlMetadata,
});

/** Narrow native session controls approved by the owner (PM-376); other calls keep asking. */
export function geminiSessionControl(
  name: string,
  args: Record<string, unknown>,
  ctx: { conversationId: string; root: string | null; cwd: string },
): { decision: 'allow' } | null {
  if (!z.uuid().safeParse(ctx.conversationId).success) return null;
  if (name === 'command_status') return CommandStatus.safeParse(args).success ? { decision: 'allow' } : null;
  if (name === 'schedule') return Schedule.safeParse(args).success ? { decision: 'allow' } : null;
  if (name !== 'manage_task') return null;
  const parsed = TaskStatus.safeParse(args);
  if (!parsed.success) return null;
  const id = parsed.data.TaskId;
  if (id.includes('\0') || id.includes('\\')) return null;
  const segments = (id.startsWith('/') ? id.slice(1) : id).split('/');
  if (
    segments.some((s) => s === '' || s === '.' || s === '..') ||
    !/^task-\d+$/.test(segments.at(-1)!) ||
    !segments.includes(ctx.conversationId)
  )
    return null;
  if (id.startsWith('/') || id.startsWith('~')) {
    if (ctx.root === null) return null;
    const base = path.join(ctx.root, 'antigravity-cli');
    if (!toolPathForms(ctx.cwd, id, homedir()).every((p) => p === base || p.startsWith(`${base}/`)))
      return null;
  } else if (!segments.every((s) => /^[A-Za-z0-9._-]+$/.test(s))) return null;
  return { decision: 'allow' };
}

export function mapGeminiTool(
  name: string,
  args: Record<string, unknown>,
): { name: string; input: unknown; call: NormalizedToolCall } {
  const paths = Object.entries(args)
    .filter(([key, value]) => /path|file|dir/i.test(key) && typeof value === 'string')
    .map(([, value]) => value as string);
  let category: NormalizedToolCall['category'] = 'unknown';
  let mapped = name;
  let input: unknown = args;
  const call: NormalizedToolCall = { category, paths: [], sandboxed: false };
  switch (name) {
    case 'run_command':
      mapped = 'Bash';
      input = { command: args.CommandLine, cwd: args.Cwd };
      category = 'command';
      call.command = str(args.CommandLine);
      call.cwd = str(args.Cwd);
      call.paths = str(args.Cwd) ? [args.Cwd as string] : [];
      break;
    case 'view_file':
      mapped = 'Read';
      input = { file_path: args.AbsolutePath };
      category = 'read';
      call.paths = str(args.AbsolutePath) ? [args.AbsolutePath as string] : [];
      break;
    case 'list_dir':
      mapped = 'LS';
      input = { path: paths[0] };
      category = 'read';
      call.paths = paths;
      break;
    case 'grep_search':
      mapped = 'Grep';
      input = { path: paths[0], pattern: args.Query ?? args.Pattern };
      category = 'read';
      call.paths = paths;
      break;
    case 'write_to_file':
      mapped = 'Write';
      input = { file_path: args.TargetFile, content: args.CodeContent };
      category = 'edit';
      call.paths = str(args.TargetFile) ? [args.TargetFile as string] : [];
      break;
    case 'replace_file_content':
    case 'multi_replace_file_content':
      mapped = 'Edit';
      input = { file_path: paths[0] };
      category = 'edit';
      call.paths = paths;
      break;
    case 'call_mcp_tool':
      if (str(args.ServerName) && str(args.ToolName)) {
        mapped = `mcp__${args.ServerName}__${args.ToolName}`;
        input =
          typeof args.Arguments === 'string'
            ? (() => {
                try {
                  return JSON.parse(args.Arguments);
                } catch {
                  return args.Arguments;
                }
              })()
            : args.Arguments;
        category = args.ServerName === 'team' ? 'team_mcp' : 'mcp';
        call.mcpTool = mapped;
      }
      break;
    case 'read_url_content':
      mapped = 'WebFetch';
      input = { url: args.Url };
      category = 'web';
      break;
    case 'search_web':
      mapped = 'WebSearch';
      category = 'web';
      break;
    default:
      if (name.startsWith('browser_')) category = 'browser';
  }
  if ((category === 'read' || category === 'edit') && call.paths.length === 0) category = 'unknown';
  if (category === 'web' || category === 'browser') {
    const url = str(args.Url) ?? str(args.URL) ?? str(args.url);
    if (url) {
      try {
        call.host = new URL(url).hostname;
      } catch {
        /* Unknown targets ask. */
      }
    }
  }
  call.category = category;
  return { name: mapped, input, call };
}

export function parseGeminiHook(body: unknown, event?: string): HookPayload | null {
  if (!event || !['PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'].includes(event)) return null;
  const parsed = Payload.safeParse(body);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (event.includes('ToolUse') && (!p.toolCall || p.stepIdx === undefined)) return null;
  let hook_event_name = event;
  if (event === 'PostToolUse' && p.error) hook_event_name = 'PostToolUseFailure';
  if (event === 'Stop')
    hook_event_name = p.error ? 'StopFailure' : p.fullyIdle === true ? 'Stop' : 'StopNotIdle';
  const mapped = p.toolCall ? mapGeminiTool(p.toolCall.name, p.toolCall.args) : null;
  return {
    hook_event_name,
    session_id: p.conversationId,
    transcript_path: p.transcriptPath,
    cwd: p.workspacePaths?.[0],
    error: p.error,
    ...(mapped
      ? {
          tool_name: mapped.name,
          tool_input: mapped.input,
          tool_use_id: `${p.conversationId}:${p.stepIdx}`,
          gemini_tool: p.toolCall!.name,
          gemini_args: p.toolCall!.args,
        }
      : {}),
  };
}

export function decideGeminiToolCall(
  policy: SessionPolicy,
  payload: HookPayload,
  root: string | null,
): ToolDecision {
  const control = geminiSessionControl(str(payload.gemini_tool) ?? '', object(payload.gemini_args), {
    conversationId: payload.session_id ?? '',
    root,
    cwd: policy.placement.path,
  });
  if (control) return control;
  const call = mapGeminiTool(str(payload.gemini_tool) ?? '', object(payload.gemini_args)).call;
  if (call.category === 'command' && (!call.cwd || !path.isAbsolute(call.cwd)))
    return { decision: 'deny', reason: 'cwd_outside_workspace' };
  const under = (p: string, r: string) => p === r || p.startsWith(`${r}/`);
  let decision: ToolDecision;
  const id = payload.session_id;
  if (
    root &&
    id &&
    z.uuid().safeParse(id).success &&
    ['read', 'edit'].includes(call.category) &&
    call.paths.length
  ) {
    const brain = path.join(root, 'antigravity-cli', 'brain', id);
    const forms = call.paths.flatMap((p) => toolPathForms(policy.placement.path, p, homedir()));
    const brainForms = toolPathForms(policy.placement.path, brain, homedir());
    const roots = toolPathForms(policy.placement.path, root, homedir());
    if (
      brainForms.every((p) => roots.some((r) => under(p, r))) &&
      forms.every(
        (p) =>
          brainForms.some((r) => under(p, r)) &&
          !p.split(path.sep).some((s) => s.toLowerCase() === '.system_generated'),
      )
    )
      decision = { decision: 'allow' };
    else decision = decideToolCall(policy, call, { shellRulesOutsideSandbox: true });
  } else decision = decideToolCall(policy, call, { shellRulesOutsideSandbox: true });
  if (
    decision.decision === 'allow' &&
    call.category === 'edit' &&
    call.paths
      .flatMap((p) => [p, ...toolPathForms(policy.placement.path, p, homedir())])
      .some((p) => p.split(path.sep).some((s) => s.toLowerCase() === '.agents'))
  )
    return { decision: 'ask' };
  return decision;
}
