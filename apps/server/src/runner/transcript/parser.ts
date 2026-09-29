import { MemberHandle, TEAM_MESSAGE_PREFIX_RE, userTextOrigin, type ChatItem } from '@projectman/shared';
import { TEAM_SEND_MESSAGE_TOOL, compactInput, oneLine, toolSummary } from '../tools';

/**
 * Turns Claude Code transcript entries (one JSON object per JSONL line) into chat items.
 *
 * Entry shapes this relies on (Claude Code 2.1.x):
 * - `{type:"user", uuid, timestamp, isMeta?, isSidechain?, isCompactSummary?,
 *    message:{role:"user", content: string | Block[]}, toolUseResult?}`
 * - `{type:"assistant", uuid, timestamp, isSidechain?, isApiErrorMessage?,
 *    message:{id, role:"assistant", content: Block[]}}` (usually one block per entry)
 * - `{type:"system", subtype:"compact_boundary", ...}`
 * - Blocks: `{type:"text", text}`, `{type:"thinking"}`, `{type:"tool_use", id, name, input}`,
 *   `{type:"tool_result", tool_use_id, content: string | Block[], is_error?}`, `{type:"image"}`.
 * Everything else (attachments, titles, snapshots, queue operations, ...) is ignored.
 */

export interface TranscriptParserOptions {
  /** Handle of the member that owns the session: sender of outgoing team messages. */
  self?: string | null;
  /** Session working directory, to shorten file paths in summaries. */
  cwd?: string | null;
  /** Only the first actual user turn can be the system kick-off brief. */
  firstUserOrigin?: 'brief' | 'human';
}

export interface ParseResult {
  items: ChatItem[];
  /** Timestamp of the latest "[Request interrupted by user]" entry, if any. */
  interruptedAt: string | null;
}

/** Sender used for outgoing team messages when the session's member is unknown. */
export const UNKNOWN_MEMBER = 'unknown';

/** Tags of messages Claude Code writes as user entries for its own bookkeeping. */
const NOISE_TAGS = new Set([
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'command-message',
  'command-args',
  'system-reminder',
  'task-notification',
  'bash-stdout',
  'bash-stderr',
  'cross-session-message',
  'scheduled-task',
  'user-prompt-submit-hook',
  'new-diagnostics',
  'artifact-content-authored-by-others',
]);

const INTERRUPT_RE = /^\[Request interrupted by user[^\]]*\]$/;
const PASTED_CONTENT_LINE_RE = /^<\/?pasted_content(?:\s[^>]*)?>$/;
const MAX_TOOL_MEMORY = 2000;

type Json = Record<string, unknown>;

function rec(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Text of a message content (string, or the text blocks of a block array). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = rec(block);
      return b && b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/** Removes the `<pasted_content id="…">` wrapper lines newer Claude Code versions add. */
function stripPasteMarkers(text: string): string {
  if (!text.includes('pasted_content')) return text;
  return text
    .split('\n')
    .filter((line) => !PASTED_CONTENT_LINE_RE.test(line.trim()))
    .join('\n');
}

function isHandle(value: unknown): value is string {
  return MemberHandle.safeParse(value).success;
}

function recipients(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return list.filter(isHandle);
}

export class TranscriptParser {
  private readonly self: string | null;
  private readonly cwd: string | null;
  private nextUserOrigin: 'brief' | 'human';
  /** tool_use id -> tool name, to summarise the matching tool_result. */
  private readonly tools = new Map<string, string>();
  private anonymous = 0;

  constructor(opts: TranscriptParserOptions = {}) {
    this.self = opts.self && isHandle(opts.self) ? opts.self : null;
    this.cwd = opts.cwd ?? null;
    this.nextUserOrigin = opts.firstUserOrigin ?? 'brief';
  }

  /** Parses complete JSONL lines; malformed lines are skipped. */
  parseLines(lines: Iterable<string>): ParseResult {
    const items: ChatItem[] = [];
    let interruptedAt: string | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const result = this.parseEntry(entry);
      items.push(...result.items);
      if (result.interruptedAt) interruptedAt = result.interruptedAt;
    }
    return { items, interruptedAt };
  }

  parseEntry(value: unknown): ParseResult {
    const entry = rec(value);
    const none: ParseResult = { items: [], interruptedAt: null };
    if (!entry || entry.isSidechain === true) return none;
    const id = str(entry.uuid) ?? `entry-${++this.anonymous}`;
    const ts = str(entry.timestamp) ?? new Date().toISOString();
    switch (entry.type) {
      case 'user':
        return this.userEntry(entry, id, ts);
      case 'assistant':
        return { items: this.assistantEntry(entry, id, ts), interruptedAt: null };
      case 'system':
        if (entry.subtype === 'compact_boundary') {
          return {
            items: [{ kind: 'system_note', id, ts, text: 'Conversation compacted' }],
            interruptedAt: null,
          };
        }
        return none;
      default:
        return none;
    }
  }

  private userEntry(entry: Json, id: string, ts: string): ParseResult {
    const result: ParseResult = { items: [], interruptedAt: null };
    if (entry.isMeta === true || entry.isCompactSummary === true) return result;
    const message = rec(entry.message);
    if (!message) return result;
    const content = message.content;

    if (typeof content === 'string') {
      this.userText(content, id, ts, result);
      return result;
    }
    if (!Array.isArray(content)) return result;

    const multi = content.length > 1;
    const hasToolResult = content.some((b) => rec(b)?.type === 'tool_result');
    if (!hasToolResult) {
      this.userText(textOf(content), id, ts, result);
      return result;
    }
    content.forEach((block, index) => {
      const b = rec(block);
      if (!b || b.type !== 'tool_result') return;
      const item = this.toolResult(b, multi ? `${id}:${index}` : id, ts, entry.toolUseResult);
      if (item) result.items.push(item);
    });
    return result;
  }

  private userText(raw: string, id: string, ts: string, out: ParseResult): void {
    const text = stripPasteMarkers(raw).trim();
    if (!text) return;

    if (INTERRUPT_RE.test(text)) {
      out.items.push({ kind: 'system_note', id, ts, text: 'Interrupted by user' });
      out.interruptedAt = ts;
      return;
    }

    const tag = /^<([a-zA-Z_-]+)>/.exec(text)?.[1];
    if (tag === 'command-name') {
      const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? '';
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
      if (name) out.items.push({ kind: 'system_note', id, ts, text: oneLine(`${name} ${args}`.trim(), 200) });
      return;
    }
    if (tag === 'bash-input') {
      const command = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1]?.trim() ?? '';
      if (command) out.items.push({ kind: 'system_note', id, ts, text: `! ${oneLine(command, 200)}` });
      return;
    }
    if (tag && NOISE_TAGS.has(tag)) return;

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

  private assistantEntry(entry: Json, id: string, ts: string): ChatItem[] {
    const message = rec(entry.message);
    if (!message) return [];
    const content = message.content;

    if (entry.isApiErrorMessage === true) {
      const text = textOf(content).trim();
      return text ? [{ kind: 'system_note', id, ts, text: oneLine(text, 300) }] : [];
    }
    if (typeof content === 'string') {
      const text = content.trim();
      return text ? [{ kind: 'assistant_text', id, ts, text }] : [];
    }
    if (!Array.isArray(content)) return [];

    const items: ChatItem[] = [];
    const multi = content.length > 1;
    content.forEach((block, index) => {
      const b = rec(block);
      if (!b) return;
      const itemId = multi ? `${id}:${index}` : id;
      if (b.type === 'text' && typeof b.text === 'string') {
        const text = b.text.trim();
        if (text) items.push({ kind: 'assistant_text', id: itemId, ts, text });
        return;
      }
      if (b.type !== 'tool_use') return;
      const toolUseId = str(b.id) ?? itemId;
      const name = str(b.name) ?? 'tool';
      this.remember(toolUseId, name);
      if (name === TEAM_SEND_MESSAGE_TOOL) {
        const input = rec(b.input) ?? {};
        const text = str(input.text) ?? str(input.message) ?? '';
        items.push({
          kind: 'team_message',
          id: itemId,
          ts,
          direction: 'out',
          from: this.self ?? UNKNOWN_MEMBER,
          to: recipients(input.to),
          text,
        });
        return;
      }
      items.push({
        kind: 'tool_call',
        id: itemId,
        ts,
        toolUseId,
        name,
        summary: toolSummary(name, b.input, this.cwd),
        input: compactInput(b.input),
      });
    });
    return items;
  }

  private toolResult(block: Json, id: string, ts: string, toolUseResult: unknown): ChatItem | null {
    const toolUseId = str(block.tool_use_id) ?? id;
    const name = this.tools.get(toolUseId) ?? null;
    const ok = block.is_error !== true;
    const text = textOf(block.content);

    if (name === TEAM_SEND_MESSAGE_TOOL) {
      return ok
        ? null
        : { kind: 'system_note', id, ts, text: `Team message not delivered: ${oneLine(text, 200)}` };
    }
    return {
      kind: 'tool_result',
      id,
      ts,
      toolUseId,
      ok,
      summary: resultSummary(name, ok, text, toolUseResult),
    };
  }

  private remember(toolUseId: string, name: string): void {
    this.tools.set(toolUseId, name);
    if (this.tools.size > MAX_TOOL_MEMORY) {
      const oldest = this.tools.keys().next().value;
      if (oldest !== undefined) this.tools.delete(oldest);
    }
  }
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Short outcome of a tool call, e.g. "3 files", "Created", or the first line of output. */
export function resultSummary(
  name: string | null,
  ok: boolean,
  text: string,
  toolUseResult: unknown,
): string {
  const first = oneLine(text);
  if (!ok) return first || 'Failed';
  const r = rec(toolUseResult);
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      if (r?.interrupted === true) return 'Interrupted';
      const out = oneLine(str(r?.stdout) ?? '') || oneLine(str(r?.stderr) ?? '') || first;
      return out || 'Done';
    }
    case 'Read': {
      const lines = count(rec(r?.file)?.numLines);
      return lines !== null ? `${lines} lines` : 'Read';
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'Edited';
    case 'Write':
      return r?.type === 'create' ? 'Created' : 'Updated';
    case 'Grep':
    case 'Glob': {
      const files = count(r?.numFiles) ?? (Array.isArray(r?.filenames) ? r.filenames.length : null);
      return files !== null ? `${files} files` : first || 'Done';
    }
    default:
      return first || 'Done';
  }
}

/** Parses a whole transcript text (JSONL). */
export function parseTranscript(text: string, opts: TranscriptParserOptions = {}): ChatItem[] {
  return new TranscriptParser(opts).parseLines(text.split('\n')).items;
}
