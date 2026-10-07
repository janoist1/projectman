import { createHash } from 'node:crypto';
import { mergeTokenUsage, type ChatItem, type TokenUsage } from '@projectman/shared';
import {
  TEAM_SEND_MESSAGE_TOOL,
  compactInput,
  displayPath,
  oneLine,
  patchSummary,
  toolSummary,
} from '../../tools';
import {
  ToolNames,
  UserTurns,
  selfHandle,
  sentTeamMessage,
  textOf,
  undeliveredTeamMessage,
} from '../../transcript/chat-items';
import { num, rec, str, type Json } from '../../transcript/json';
import type { TranscriptLineParser, TranscriptParseResult } from '../types';
import { rateLimitsOf, type CodexRateLimits } from './plan-usage';

/**
 * Turns Codex rollout lines ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl) into chat
 * items. Every line is `{timestamp, type, payload}` (codex-cli 0.159.1):
 * - `session_meta`: `{id, cwd, ...}`, the conversation id;
 * - `response_item`: what the model saw and said: `message` (role user | assistant |
 *   developer, content `[{type: input_text | output_text, text}]`), `function_call`
 *   (`{name, namespace?, arguments, call_id}`; MCP tools use namespace "mcp__<server>__"),
 *   `custom_tool_call` (`apply_patch` with the patch as `input`), `function_call_output` and
 *   `custom_tool_call_output` (`{call_id, output}`; output is text or content items),
 *   `local_shell_call`, `web_search_call`, `reasoning` (skipped);
 * - `event_msg`: `task_started`, `task_complete` (`error` when the turn failed), `turn_aborted`
 *   (`reason: "interrupted"` for Esc), `token_count` (`rate_limits` of the plan, and in `info`
 *   the token usage: `total_token_usage` and `last_token_usage`, each `{input_tokens,
 *   cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`);
 * - `turn_context` (`{model, ...}` of the turn), `compacted` and the rest carry no chat.
 * Codex also records the context it adds itself (environment, AGENTS.md, instructions) as user
 * messages wrapped in tags; those are skipped. Response items rarely carry ids, so items get
 * ids from a hash of their line, which stays the same whenever the file is read again.
 */

/** Token counts as Codex reports them: `input` includes `cached`. */
interface CodexTokens {
  input: number;
  cached: number;
  output: number;
}

function tokenFields(usage: Json | null): CodexTokens | null {
  if (!usage) return null;
  const field = (name: string) => {
    const n = num(usage[name]);
    return n !== null && n > 0 ? Math.floor(n) : 0;
  };
  return {
    input: field('input_tokens'),
    cached: field('cached_input_tokens'),
    output: field('output_tokens'),
  };
}

export interface CodexParseResult extends TranscriptParseResult {
  /** The newest plan rate limits in these lines. */
  rateLimits: CodexRateLimits | null;
  /** The conversation id, when these lines include the session header. */
  sessionId: string | null;
  usage: TokenUsage[];
}

/** "mcp__team__" + "send_message" -> "mcp__team__send_message" (as Codex names it in hooks). */
export function codexToolName(name: string, namespace?: string | null): string {
  if (!namespace) return name;
  return `${namespace.replace(/_+$/, '')}__${name.replace(/^_+/, '')}`;
}

/** Context Codex adds as user messages: a tagged block, or the AGENTS.md instructions. */
const CONTEXT_FRAGMENT = /^(?:<([a-z_]+)>[\s\S]*<\/\1>|# AGENTS\.md instructions[\s\S]*)$/;

/** Signs of a lost ChatGPT login in an error Codex recorded. */
export const CODEX_AUTH_ERROR =
  /sign in again|log in again|log out and sign in|not logged in|refresh token|401 Unauthorized/i;

function isAuthError(error: Json): boolean {
  const info = error.codex_error_info;
  if (info === 'unauthorized') return true;
  if (rec(info) && 'unauthorized' in rec(info)!) return true;
  return CODEX_AUTH_ERROR.test(str(error.message) ?? '');
}

function isRateLimit(error: Json): boolean {
  const info = error.codex_error_info;
  const structured = rec(info);
  const detail =
    structured &&
    Object.values(structured)
      .map(rec)
      .find((value) => value?.http_status_code !== undefined);
  const status =
    error.http_status ??
    error.http_status_code ??
    error.status ??
    structured?.http_status ??
    structured?.status ??
    detail?.http_status_code;
  if (status !== undefined) return status === 429 || status === '429';
  if (
    info === 'usage_limit_exceeded' ||
    info === 'rate_limit_exceeded' ||
    structured?.usage_limit_exceeded !== undefined ||
    structured?.rate_limit_exceeded !== undefined
  )
    return true;
  return /\b429\b|too many requests/i.test(str(error.message) ?? '');
}

/** The command of a shell tool call: exec_command `cmd`, shell `command` (list or string). */
function shellCommand(args: Json): string | null {
  const cmd = str(args.cmd) ?? str(args.command);
  if (cmd) return cmd;
  if (Array.isArray(args.command) && args.command.every((a) => typeof a === 'string')) {
    const argv = args.command as string[];
    // ["bash", "-lc", "<script>"] -> the script.
    if (argv.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(argv[0]!) && /^-\w*c$/.test(argv[1]!))
      return argv[2]!;
    return argv.join(' ');
  }
  return null;
}

const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'container.exec', 'local_shell']);

/** Outcome of a tool output: exit status and the first line of what it printed. */
export function outputSummary(text: string): { ok: boolean; summary: string } {
  const json = (() => {
    try {
      return rec(JSON.parse(text));
    } catch {
      return null;
    }
  })();
  if (json && typeof json.output === 'string') {
    const exit = num(rec(json.metadata)?.exit_code);
    const first = oneLine(json.output);
    return { ok: exit === null || exit === 0, summary: first || (exit ? `Exit code ${exit}` : 'Done') };
  }
  const exitMatch = /^(?:Exit code: |Process exited with code )(-?\d+)$/m.exec(text);
  const exit = exitMatch ? Number(exitMatch[1]) : null;
  const outputAt = text.search(/^Output:$/m);
  const body = outputAt >= 0 ? text.slice(outputAt + 'Output:'.length) : text;
  const first = oneLine(body);
  const rejected = /rejected|denied|not approved|aborted by user/i.test(oneLine(text, 200));
  const ok = !rejected && (exit === null || exit === 0);
  return {
    ok,
    summary: first || (exit !== null && exit !== 0 ? `Exit code ${exit}` : ok ? 'Done' : 'Failed'),
  };
}

export class CodexTranscriptParser implements TranscriptLineParser {
  private readonly self: string | null;
  private readonly cwd: string | null;
  private readonly turns: UserTurns;
  /** call_id -> tool name, to summarise the matching output. */
  private readonly tools = new ToolNames();
  /** The model of the current turn (`turn_context`), for its token counts. */
  private model: string | null = null;
  /** The conversation's latest running token total. */
  private total: CodexTokens | null = null;
  private readonly detectRateLimit: boolean;

  constructor(
    opts: {
      self?: string | null;
      cwd?: string | null;
      firstUserOrigin?: 'brief' | 'human';
      detectRateLimit?: boolean;
    } = {},
  ) {
    this.detectRateLimit = opts.detectRateLimit ?? false;
    this.self = selfHandle(opts.self);
    this.cwd = opts.cwd ?? null;
    this.turns = new UserTurns(this.self, opts.firstUserOrigin);
  }

  parseLines(lines: Iterable<string>): CodexParseResult {
    const result: CodexParseResult = {
      items: [],
      interruptedAt: null,
      authError: null,
      rateLimits: null,
      sessionId: null,
      usage: [],
    };
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: Json | null;
      try {
        entry = rec(JSON.parse(line));
      } catch {
        continue;
      }
      if (!entry) continue;
      const id = `cx-${createHash('sha1').update(line).digest('hex').slice(0, 20)}`;
      const ts = str(entry.timestamp) ?? new Date().toISOString();
      const payload = rec(entry.payload);
      if (!payload) continue;
      switch (entry.type) {
        case 'session_meta':
          result.sessionId = str(payload.id) ?? result.sessionId;
          break;
        case 'response_item':
          this.responseItem(payload, id, ts, result);
          break;
        case 'event_msg':
          this.event(payload, id, ts, result);
          break;
        case 'compacted':
          result.items.push({ kind: 'system_note', id, ts, text: 'Conversation compacted' });
          break;
        case 'turn_context':
          this.model = str(payload.model) ?? this.model;
          break;
        default:
          break;
      }
    }
    result.usage = mergeTokenUsage(result.usage);
    return result;
  }

  private responseItem(item: Json, id: string, ts: string, out: CodexParseResult): void {
    switch (item.type) {
      case 'message':
        this.message(item, id, ts, out);
        return;
      case 'function_call': {
        const name = codexToolName(str(item.name) ?? 'tool', str(item.namespace));
        const raw = str(item.arguments) ?? '';
        let args: unknown = raw;
        try {
          args = JSON.parse(raw);
        } catch {
          // not JSON: keep the text
        }
        this.toolCall(name, rec(args) ?? { input: raw }, str(item.call_id) ?? id, id, ts, out);
        return;
      }
      case 'custom_tool_call': {
        const name = str(item.name) ?? 'tool';
        const input = str(item.input) ?? '';
        this.toolCall(name, { input }, str(item.call_id) ?? id, id, ts, out);
        return;
      }
      case 'local_shell_call': {
        const action = rec(item.action) ?? {};
        this.toolCall('local_shell', action, str(item.call_id) ?? id, id, ts, out);
        return;
      }
      case 'web_search_call': {
        const query = str(rec(item.action)?.query);
        out.items.push({
          kind: 'tool_call',
          id,
          ts,
          toolUseId: str(item.id) ?? id,
          name: 'WebSearch',
          summary: query ? oneLine(query) : 'WebSearch',
          input: compactInput(item.action ?? null),
        });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        this.toolOutput(item, id, ts, out);
        return;
      default:
        return;
    }
  }

  private message(item: Json, id: string, ts: string, out: CodexParseResult): void {
    const role = str(item.role);
    const text = textOf(item.content).trim();
    if (!text) return;
    if (role === 'assistant') {
      out.items.push({ kind: 'assistant_text', id, ts, text });
      return;
    }
    if (role !== 'user' || CONTEXT_FRAGMENT.test(text)) return;
    out.items.push(this.turns.item(text, id, ts));
  }

  private toolCall(
    name: string,
    args: Json,
    toolUseId: string,
    id: string,
    ts: string,
    out: CodexParseResult,
  ): void {
    this.tools.remember(toolUseId, name);
    if (name === TEAM_SEND_MESSAGE_TOOL) {
      out.items.push(sentTeamMessage(args, id, ts, this.self));
      return;
    }
    if (name === 'write_stdin' && !str(args.chars)) return; // polling a running command
    if (SHELL_TOOLS.has(name)) {
      const command = shellCommand(args) ?? '';
      out.items.push({
        kind: 'tool_call',
        id,
        ts,
        toolUseId,
        name: 'Bash',
        summary: command ? oneLine(command) : 'Bash',
        input: compactInput({ ...args, command }),
      });
      return;
    }
    if (name === 'apply_patch') {
      const patch = str(args.input) ?? str(args.patch) ?? '';
      const file = patchSummary(patch);
      out.items.push({
        kind: 'tool_call',
        id,
        ts,
        toolUseId,
        name,
        summary: file ? oneLine(displayPath(file, this.cwd)) : 'apply_patch',
        input: compactInput({ patch }),
      });
      return;
    }
    out.items.push({
      kind: 'tool_call',
      id,
      ts,
      toolUseId,
      name,
      summary: toolSummary(name, args, this.cwd),
      input: compactInput(args),
    });
  }

  private toolOutput(item: Json, id: string, ts: string, out: CodexParseResult): void {
    const toolUseId = str(item.call_id) ?? id;
    const name = this.tools.get(toolUseId);
    if (name === 'write_stdin') return;
    const text = textOf(item.output);
    const { ok, summary } = outputSummary(text);
    if (name === TEAM_SEND_MESSAGE_TOOL) {
      // Codex does not record whether an MCP call failed; only an explicit error is shown.
      if (/^(?:error|failed)\b/i.test(text.trim())) out.items.push(undeliveredTeamMessage(text, id, ts));
      return;
    }
    out.items.push({ kind: 'tool_result', id, ts, toolUseId, ok, summary });
  }

  private event(payload: Json, id: string, ts: string, out: CodexParseResult): void {
    switch (payload.type) {
      case 'task_started':
        out.rateLimit = null;
        out.turnEnded = false;
        out.turnAt = ts;
        return;
      case 'turn_aborted': {
        out.turnEnded = true;
        out.turnAt = ts;
        if (payload.reason === 'interrupted') {
          out.items.push({ kind: 'system_note', id, ts, text: 'Interrupted by user' });
          out.interruptedAt = ts;
        }
        this.turnError(rec(payload.error), `${id}:error`, ts, out);
        return;
      }
      case 'task_complete':
        out.turnEnded = true;
        out.turnAt = ts;
        this.turnError(rec(payload.error), id, ts, out);
        return;
      case 'token_count': {
        const limits = rateLimitsOf(payload, ts);
        if (limits) out.rateLimits = limits;
        const used = this.tokenCount(rec(payload.info));
        if (used) out.usage.push(used);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The tokens a `token_count` event adds (PM-178). Its `total_token_usage` is the conversation's
   * running total: the difference from the previous one counts, so an event repeated with the same
   * total adds nothing. Without a previous total (the first event, or the first after a resume,
   * which is followed from the end of the file) its `last_token_usage`, the latest response's,
   * counts. Codex counts cached input inside `input_tokens`: here it is only in `cacheRead`;
   * reasoning tokens are part of the output.
   */
  private tokenCount(info: Json | null): TokenUsage | null {
    if (!info) return null;
    const total = tokenFields(rec(info.total_token_usage));
    const last = tokenFields(rec(info.last_token_usage));
    let used: CodexTokens | null = null;
    if (total && this.total) {
      const diff = {
        input: total.input - this.total.input,
        cached: total.cached - this.total.cached,
        output: total.output - this.total.output,
      };
      used = diff.input < 0 || diff.cached < 0 || diff.output < 0 ? last : diff;
    } else used = last ?? total;
    if (total) this.total = total;
    if (!used || used.input + used.output === 0) return null;
    const cached = Math.min(used.cached, used.input);
    return {
      model: this.model ?? 'unknown',
      scope: 'main',
      input: used.input - cached,
      output: used.output,
      cacheRead: cached,
      cacheWrite: 0,
    };
  }

  private turnError(error: Json | null, id: string, ts: string, out: CodexParseResult): void {
    if (!error) return;
    const message = str(error.message)?.trim() || 'The turn failed';
    out.items.push({ kind: 'system_note', id, ts, text: oneLine(message, 300) });
    if (isAuthError(error)) out.authError = oneLine(message, 300);
    if (this.detectRateLimit && isRateLimit(error))
      out.rateLimit = { message: oneLine(message, 300), at: ts };
  }
}

/** Parses a whole rollout text (JSONL). */
export function parseCodexTranscript(
  text: string,
  opts: { self?: string | null; cwd?: string | null; firstUserOrigin?: 'brief' | 'human' } = {},
): ChatItem[] {
  return new CodexTranscriptParser(opts).parseLines(text.split('\n')).items;
}

/** Codex rollout files: rollout-<timestamp>-<thread id>.jsonl (compressed as .jsonl.zst after a week). */
export const CODEX_ROLLOUT_FILE = /(?:^|\/)rollout-[^/]*\.jsonl(?:\.zst)?$/;
