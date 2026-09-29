import { userTextOrigin } from '@projectman/shared';
import { createHash } from 'node:crypto';
import { MemberHandle, TEAM_MESSAGE_PREFIX_RE, type ChatItem } from '@projectman/shared';
import { TEAM_SEND_MESSAGE_TOOL, compactInput, displayPath, oneLine, toolSummary } from '../../tools';
import { UNKNOWN_MEMBER } from '../../transcript/parser';
import type { TranscriptLineParser, TranscriptParseResult } from '../types';

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
 *   (`reason: "interrupted"` for Esc), `token_count` (`rate_limits` of the plan);
 * - `turn_context`, `compacted` and the rest carry no chat.
 * Codex also records the context it adds itself (environment, AGENTS.md, instructions) as user
 * messages wrapped in tags; those are skipped. Response items rarely carry ids, so items get
 * ids from a hash of their line, which stays the same whenever the file is read again.
 */

export interface CodexRateWindow {
  usedPercent: number;
  windowMinutes: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface CodexRateLimits {
  /** When the record was written (ISO). */
  at: string;
  limitId: string | null;
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
}

export interface CodexParseResult extends TranscriptParseResult {
  /** The newest plan rate limits in these lines. */
  rateLimits: CodexRateLimits | null;
  /** The conversation id, when these lines include the session header. */
  sessionId: string | null;
}

type Json = Record<string, unknown>;

function rec(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isHandle(value: unknown): value is string {
  return MemberHandle.safeParse(value).success;
}

function recipients(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter(isHandle);
}

/** Text of message content or tool output: a string, or the text items of a list. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const i = rec(item);
      return i && typeof i.text === 'string' ? i.text : '';
    })
    .filter((t) => t.length > 0)
    .join('\n\n');
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

/** First file an apply_patch touches: "*** Update File: src/app.ts" -> "src/app.ts". */
export function patchSummary(patch: string): string | null {
  const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch);
  return m ? m[1]!.trim() : null;
}

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

function rateWindow(value: unknown): CodexRateWindow | null {
  const w = rec(value);
  const used = num(w?.used_percent);
  if (!w || used === null) return null;
  return { usedPercent: used, windowMinutes: num(w.window_minutes), resetsAt: num(w.resets_at) };
}

/** The rate limits of a `token_count` event payload, or null. */
export function rateLimitsOf(payload: Json, at: string): CodexRateLimits | null {
  const limits = rec(payload.rate_limits);
  if (!limits) return null;
  const primary = rateWindow(limits.primary);
  const secondary = rateWindow(limits.secondary);
  if (!primary && !secondary) return null;
  return { at, limitId: str(limits.limit_id), primary, secondary };
}

const MAX_TOOL_MEMORY = 2000;

export class CodexTranscriptParser implements TranscriptLineParser {
  private readonly self: string | null;
  private readonly cwd: string | null;
  private nextUserOrigin: 'brief' | 'human';
  /** call_id -> tool name, to summarise the matching output. */
  private readonly tools = new Map<string, string>();

  constructor(opts: { self?: string | null; cwd?: string | null; firstUserOrigin?: 'brief' | 'human' } = {}) {
    this.self = opts.self && isHandle(opts.self) ? opts.self : null;
    this.cwd = opts.cwd ?? null;
    this.nextUserOrigin = opts.firstUserOrigin ?? 'brief';
  }

  parseLines(lines: Iterable<string>): CodexParseResult {
    const result: CodexParseResult = {
      items: [],
      interruptedAt: null,
      authError: null,
      rateLimits: null,
      sessionId: null,
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
        default:
          break;
      }
    }
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
    const origin = userTextOrigin(text, this.nextUserOrigin);
    this.nextUserOrigin = 'human';
    const team = TEAM_MESSAGE_PREFIX_RE.exec(text);
    const sender = team?.[1];
    if (team && isHandle(sender)) {
      out.items.push({
        kind: 'team_message',
        id,
        ts,
        direction: 'in',
        from: sender,
        to: this.self ? [this.self] : [],
        text: text.slice(team[0].length).trim(),
      });
      return;
    }
    out.items.push({ kind: 'user_text', id, ts, text, origin });
  }

  private toolCall(
    name: string,
    args: Json,
    toolUseId: string,
    id: string,
    ts: string,
    out: CodexParseResult,
  ): void {
    this.remember(toolUseId, name);
    if (name === TEAM_SEND_MESSAGE_TOOL) {
      out.items.push({
        kind: 'team_message',
        id,
        ts,
        direction: 'out',
        from: this.self ?? UNKNOWN_MEMBER,
        to: recipients(args.to),
        text: str(args.text) ?? str(args.message) ?? '',
      });
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
    const name = this.tools.get(toolUseId) ?? null;
    if (name === 'write_stdin') return;
    const text = textOf(item.output);
    const { ok, summary } = outputSummary(text);
    if (name === TEAM_SEND_MESSAGE_TOOL) {
      // Codex does not record whether an MCP call failed; only an explicit error is shown.
      if (/^(?:error|failed)\b/i.test(text.trim())) {
        out.items.push({
          kind: 'system_note',
          id,
          ts,
          text: `Team message not delivered: ${oneLine(text, 200)}`,
        });
      }
      return;
    }
    out.items.push({ kind: 'tool_result', id, ts, toolUseId, ok, summary });
  }

  private event(payload: Json, id: string, ts: string, out: CodexParseResult): void {
    switch (payload.type) {
      case 'turn_aborted': {
        if (payload.reason === 'interrupted') {
          out.items.push({ kind: 'system_note', id, ts, text: 'Interrupted by user' });
          out.interruptedAt = ts;
        }
        this.turnError(rec(payload.error), `${id}:error`, ts, out);
        return;
      }
      case 'task_complete':
        this.turnError(rec(payload.error), id, ts, out);
        return;
      case 'token_count': {
        const limits = rateLimitsOf(payload, ts);
        if (limits) out.rateLimits = limits;
        return;
      }
      default:
        return;
    }
  }

  private turnError(error: Json | null, id: string, ts: string, out: CodexParseResult): void {
    if (!error) return;
    const message = str(error.message)?.trim() || 'The turn failed';
    out.items.push({ kind: 'system_note', id, ts, text: oneLine(message, 300) });
    if (isAuthError(error)) out.authError = oneLine(message, 300);
  }

  private remember(toolUseId: string, name: string): void {
    this.tools.set(toolUseId, name);
    if (this.tools.size > MAX_TOOL_MEMORY) {
      const oldest = this.tools.keys().next().value;
      if (oldest !== undefined) this.tools.delete(oldest);
    }
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
